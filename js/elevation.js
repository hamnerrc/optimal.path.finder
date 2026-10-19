// ==========================================================================
// Elevation along a loop.
//
// Heights come from terrain tiles (the free AWS Terrain Tiles: 10 m data in
// the US, 30 m or better in most of the world, served from a CDN without a
// request limit), read from the tile pixels in the browser. If those can't
// be loaded, the Open-Meteo elevation API (~90 m data, limited requests per
// minute) is used instead.
//
// Heights are sampled once, evenly along the loop. The profile for any start
// point and direction is then read from those samples without refetching.
// ==========================================================================

async function fetchLoopElevation(route, signal) {
    const { maxSamples, minSpacingM } = CONFIG.elevation;
    const length = loopLength(route);
    const count = Math.max(16, Math.min(maxSamples, Math.ceil(length / minSpacingM)));
    const offsets = Float64Array.from({ length: count }, (_, i) => (i * length) / count);
    const points = Array.from(offsets, (d) => pointAtOffset(route, d));
    let heights;
    try {
        heights = await terrainHeights(points, signal);
    } catch (err) {
        if (err.name === "AbortError") throw err;
        console.warn("[Elevation] Terrain tiles unavailable, using Open-Meteo:", err);
        heights = await openMeteoHeights(points, signal);
    }
    return { offsets, heights, length };
}

// --- Terrain tiles -----------------------------------------------------------

// "z/x/y" -> Promise<Float32Array of 256×256 heights>, most recently used last.
const terrainTiles = new Map();

// Heights at [lat, lng] points, from the most detailed zoom at which they
// fall in no more than CONFIG.elevation.maxTiles tiles.
async function terrainHeights(points, signal) {
    const { maxTileZoom, maxTiles } = CONFIG.elevation;
    let z = maxTileZoom, keys;
    for (; ; z--) {
        keys = new Set(points.map(([lat, lng]) => {
            const n = 2 ** z;
            return `${z}/${Math.floor(lngToTileX(lng, n))}/${Math.floor(latToTileY(lat, n))}`;
        }));
        if (keys.size <= maxTiles || z === 1) break;
    }
    const tiles = new Map();
    await forEachLimited([...keys], 8, async (key) => {
        tiles.set(key, await terrainTile(key, signal));
    });

    const at = terrainSampler(tiles, z);
    return Float64Array.from(points, ([lat, lng]) => at(lat, lng));
}

// (lat, lng) -> height, bilinear between pixel centres (clamped at a tile's
// edge), from loaded tiles ("z/x/y" -> heights) of zoom z. NaN outside them.
function terrainSampler(tiles, z) {
    const n = 2 ** z;
    const byNumber = new Map();
    for (const [key, data] of tiles) {
        const [, x, y] = key.split("/").map(Number);
        byNumber.set(x * n + y, data);
    }
    return (lat, lng) => {
        const tx = lngToTileX(lng, n), ty = latToTileY(lat, n);
        const data = byNumber.get(Math.floor(tx) * n + Math.floor(ty));
        if (!data) return NaN;
        const px = Math.min(255, Math.max(0, (tx - Math.floor(tx)) * 256 - 0.5));
        const py = Math.min(255, Math.max(0, (ty - Math.floor(ty)) * 256 - 0.5));
        const x0 = Math.floor(px), y0 = Math.floor(py);
        const x1 = Math.min(255, x0 + 1), y1 = Math.min(255, y0 + 1);
        const fx = px - x0, fy = py - y0;
        const at = (x, y) => data[y * 256 + x];
        return (at(x0, y0) * (1 - fx) + at(x1, y0) * fx) * (1 - fy) + (at(x0, y1) * (1 - fx) + at(x1, y1) * fx) * fy;
    };
}

function terrainTile(key, signal) {
    let entry = terrainTiles.get(key);
    if (entry) {
        terrainTiles.delete(key);
        terrainTiles.set(key, entry);
        return entry;
    }
    const [z, x, y] = key.split("/");
    const url = CONFIG.elevation.tileUrl.replace("{z}", z).replace("{x}", x).replace("{y}", y);
    entry = fetch(url, { signal })
        .then(response => {
            if (!response.ok) throw new Error(`Terrain tile download failed (HTTP ${response.status})`);
            return response.blob();
        })
        .then(terrainPixels)
        .then(rgba => {
            // Terrarium encoding: (red × 256 + green + blue / 256) − 32768 m.
            const heights = new Float32Array(256 * 256);
            for (let i = 0; i < heights.length; i++) {
                heights[i] = rgba[4 * i] * 256 + rgba[4 * i + 1] + rgba[4 * i + 2] / 256 - 32768;
            }
            return heights;
        });
    entry.catch(() => terrainTiles.delete(key));
    terrainTiles.set(key, entry);
    for (const old of terrainTiles.keys()) {
        if (terrainTiles.size <= CONFIG.elevation.cacheTiles) break;
        terrainTiles.delete(old);
    }
    return entry;
}

// A tile image's RGBA pixels.
async function terrainPixels(blob) {
    const bitmap = await createImageBitmap(blob);
    const canvas = typeof OffscreenCanvas !== "undefined"
        ? new OffscreenCanvas(256, 256)
        : Object.assign(document.createElement("canvas"), { width: 256, height: 256 });
    const context = canvas.getContext("2d", { willReadFrequently: true });
    context.drawImage(bitmap, 0, 0, 256, 256);
    return context.getImageData(0, 0, 256, 256).data;
}

// --- Climb along roads (for the search) ----------------------------------------

// Sets edge.climb on every road of a network: what it adds to the climb of
// a loop that runs along it, either way (half its ups and downs together:
// round a loop, the total up equals the total down). Bridges and tunnels
// only count the difference between their ends, not the ground under them.
// Heights come from terrain tiles at the most detailed zoom (up to
// searchMaxZoom) at which the network's junctions fall in no more than
// searchMaxTiles tiles. Resolves with false, leaving the network as it
// was, if the tiles can't be loaded.
async function addRoadClimb(network, signal) {
    const { searchMaxZoom, searchMaxTiles } = CONFIG.elevation;
    const nodes = [...network.nodes.values()];
    if (!nodes.length) return false;
    const tilesAt = (z, each) => {
        const n = 2 ** z, numbers = new Set();
        each((lat, lng) => numbers.add(Math.floor(lngToTileX(lng, n)) * n + Math.floor(latToTileY(lat, n))));
        return [...numbers].map(k => `${z}/${Math.floor(k / n)}/${k % n}`);
    };
    let z = searchMaxZoom;
    while (z > 1 && tilesAt(z, fn => nodes.forEach(p => fn(p.lat, p.lng))).length > searchMaxTiles) z--;
    // Every tile a road passes through (roads can leave the junctions' tiles).
    const keys = tilesAt(z, fn => {
        for (const edge of network.edges) for (const [lat, lng] of edge.coords) fn(lat, lng);
    });
    const tiles = new Map();
    try {
        await forEachLimited(keys, 8, async (key) => {
            tiles.set(key, await terrainTile(key, signal));
        });
    } catch (err) {
        if (err.name === "AbortError") throw err;
        console.warn("[Elevation] No climb for the search, terrain tiles unavailable:", err);
        return false;
    }
    const height = terrainSampler(tiles, z);
    // Samples about a pixel apart (at least minSpacingM).
    const lat0 = nodes[0].lat;
    const spacing = Math.max(CONFIG.elevation.minSpacingM, EARTH_RADIUS_M * 2 * Math.PI * Math.cos(lat0 * DEG) / (256 * 2 ** z));
    const threshold = CONFIG.elevation.climbThresholdM;
    for (const edge of network.edges) {
        const c = edge.coords;
        if (edge.level) {
            edge.climb = Math.abs(height(c[c.length - 1][0], c[c.length - 1][1]) - height(c[0][0], c[0][1])) / 2 || 0;
            continue;
        }
        // Ups and downs, ignoring wiggles under climbThresholdM (data noise).
        let total = 0, anchor = height(c[0][0], c[0][1]), h = anchor;
        for (let i = 1; i < c.length; i++) {
            const [aLat, aLng] = c[i - 1], [bLat, bLng] = c[i];
            const steps = Math.ceil(haversine(aLat, aLng, bLat, bLng) / spacing);
            for (let k = 1; k <= steps; k++) {
                h = height(aLat + (bLat - aLat) * k / steps, aLng + (bLng - aLng) * k / steps);
                if (Math.abs(h - anchor) >= threshold) {
                    total += Math.abs(h - anchor);
                    anchor = h;
                }
            }
        }
        edge.climb = (total + Math.abs(h - anchor)) / 2 || 0;
    }
    return true;
}

// --- Open-Meteo (fallback) ---------------------------------------------------

async function openMeteoHeights(points, signal) {
    const { url, batchSize } = CONFIG.elevation;
    // Fewer points: the service limits requests per minute.
    const step = Math.max(1, Math.ceil(points.length / 200));
    const sampled = points.filter((_, i) => i % step === 0);
    const coarse = new Float64Array(sampled.length);
    for (let i = 0; i < sampled.length; i += batchSize) {
        const batch = sampled.slice(i, i + batchSize);
        const query = `latitude=${batch.map(p => p[0].toFixed(5)).join(",")}` +
            `&longitude=${batch.map(p => p[1].toFixed(5)).join(",")}`;
        const data = await fetchWithRetry(`${url}?${query}`, signal);
        if (!Array.isArray(data.elevation)) throw new Error("Unexpected elevation response");
        data.elevation.forEach((h, k) => { coarse[i + k] = h; });
    }
    // Back to one height per point, between the samples (round the loop).
    return Float64Array.from(points, (_, i) => {
        const pos = i / step, k = Math.floor(pos), f = pos - k;
        return coarse[k % coarse.length] * (1 - f) + coarse[(k + 1) % coarse.length] * f;
    });
}

// The free API rate-limits bursts (HTTP 429); wait and try again a few times.
async function fetchWithRetry(url, signal, attempts = 3) {
    for (let i = 1; ; i++) {
        const response = await fetch(url, { signal });
        if (response.ok) return response.json();
        if (response.status !== 429 || i >= attempts) throw new Error(`Elevation service returned HTTP ${response.status}`);
        await new Promise(resolve => setTimeout(resolve, 1500 * i));
    }
}

// --- Profile -------------------------------------------------------------------

// Height at a distance along the loop, interpolated between samples.
function heightAtOffset(elevation, offset) {
    const { heights, length } = elevation;
    const n = heights.length;
    const pos = ((((offset % length) + length) % length) / length) * n;
    const i = Math.floor(pos) % n;
    const f = pos - Math.floor(pos);
    return heights[i] * (1 - f) + heights[(i + 1) % n] * f;
}

// Profile as run from the route's chosen start and direction.
// Returns { points: [{ distance, height }], gain, loss, min, max }.
function elevationProfile(route) {
    const elevation = route.elevation;
    const n = elevation.heights.length;
    const length = loopLength(route);
    const points = [];
    for (let i = 0; i <= n; i++) {
        const distance = (i / n) * length;
        points.push({ distance, height: heightAtOffset(elevation, offsetFromStart(route, distance)) });
    }

    // Climb totals, ignoring wiggles smaller than the threshold (data noise).
    const threshold = CONFIG.elevation.climbThresholdM;
    let gain = 0, loss = 0, anchor = points[0].height;
    for (const { height } of points) {
        if (height - anchor >= threshold) {
            gain += height - anchor;
            anchor = height;
        } else if (anchor - height >= threshold) {
            loss += anchor - height;
            anchor = height;
        }
    }

    let min = Infinity, max = -Infinity;
    for (const { height } of points) {
        min = Math.min(min, height);
        max = Math.max(max, height);
    }
    return { points, gain, loss, min, max };
}
