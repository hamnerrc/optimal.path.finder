// ==========================================================================
// Overpass API road loader, used when the road tiles (js/roadtiles.js)
// can't be reached. Downloads OSM ways inside a region. Recent downloads
// are kept in memory and reused for any later search that lies inside one
// of them (e.g. a new start point near a removed one), and a fallback
// server is tried if the primary one is busy or down.
// ==========================================================================

const roadStore = [];   // [{ query, region, typesKey, data }], oldest first

// "railway" in roadTypes stands for railroad tracks (see js/roadtiles.js).
function buildRoadQuery(region, roadTypes) {
    const highways = roadTypes.filter(t => t !== "railway");
    const rail = roadTypes.includes("railway")
        ? `way["railway"~"^(rail|narrow_gauge|preserved)$"]["tunnel"!="yes"]["service"!~"^(yard|crossover)$"]${region.overpassFilter};` : "";
    return `[out:json][timeout:${CONFIG.overpass.timeoutSeconds}];` +
        `(way["highway"~"^(${highways.join("|")})$"]${region.overpassFilter};${rail});` +
        `out geom qt;`;
}

// Any object with region.overpassFilter works (e.g. a bounding-box tile);
// regions with an outline and contains() can also be served from a larger
// earlier download. The network builder clips to the region, so extra roads
// don't matter. roadTypes defaults to every routable type; firstServer picks
// the server tried first (to spread parallel requests).
async function fetchRoads(region, signal, roadTypes = CONFIG.roadTypes, firstServer = 0) {
    const query = buildRoadQuery(region, roadTypes);
    const typesKey = roadTypes.join("|");
    const stored = roadStore.find(entry => entry.query === query ||
        entry.typesKey === typesKey && region.outline && entry.region.contains && regionInside(region, entry.region));
    if (stored) return stored.data;

    let lastError = null;
    const servers = CONFIG.overpass.endpoints;
    for (let k = 0; k < servers.length; k++) {
        const endpoint = servers[(firstServer + k) % servers.length];
        try {
            const response = await fetch(endpoint, {
                method: "POST",
                headers: { "Content-Type": "application/x-www-form-urlencoded" },
                body: `data=${encodeURIComponent(query)}`,
                signal
            });

            if (!response.ok) {
                lastError = new OverpassError(response.status);
                // Busy or failing server: try the next one. Anything else won't improve.
                if (response.status === 429 || response.status >= 500) continue;
                throw lastError;
            }

            const data = await response.json();
            // Overpass reports timeouts and memory limits inside a 200 reply.
            if (/runtime error/i.test(data.remark || "")) throw new OverpassError("too-big");
            rememberResponse(query, region, typesKey, data);
            return data;
        } catch (err) {
            if (err.name === "AbortError" || err instanceof OverpassError && !isRetryable(err)) throw err;
            lastError = err;
        }
    }
    throw lastError || new Error("No Overpass endpoint available");
}

function rememberResponse(query, region, typesKey, data) {
    roadStore.push({ query, region, typesKey, data });
    // Keep a bounded number of downloads, and drop the oldest ones once
    // they add up to a lot of roads.
    let ways = roadStore.reduce((sum, entry) => sum + entry.data.elements.length, 0);
    while (roadStore.length > 1 && (roadStore.length > CONFIG.overpass.cacheSize || ways > CONFIG.overpass.cacheMaxWays)) {
        ways -= roadStore.shift().data.elements.length;
    }
}

// True if every point of the inner region's outline is inside the outer
// region, and (for circles) the whole inner circle is.
function regionInside(inner, outer) {
    if (inner.type === "circle" && outer.type === "circle") {
        return haversine(inner.center.lat, inner.center.lng, outer.center.lat, outer.center.lng) + inner.radiusMeters <= outer.radiusMeters;
    }
    return inner.outline.every(p => outer.contains(p.lat, p.lng));
}

class OverpassError extends Error {
    constructor(status) {
        super(OverpassError.describe(status));
        this.name = "OverpassError";
        this.status = status;
    }

    static describe(status) {
        if (status === "too-big") return "This area has too many roads to download at once.";
        if (status === 429) return "The map data server is busy. Please wait a minute and try again.";
        if (status === 504) return "The map data server timed out. Try a smaller area.";
        if (status === 400) return "The map data request was rejected.";
        return `The map data server returned an error (HTTP ${status}).`;
    }
}

const isRetryable = (err) => err.status === 429 || err.status >= 500;

// Errors that mean "the request was too large", as opposed to "the server is
// unavailable". A smaller, chunked request may still succeed.
const isTooBig = (err) => err instanceof OverpassError && (err.status === "too-big" || err.status === 504);

// Downloads a large region as a grid of bounding-box tiles (one request each,
// a few at a time, spread over the servers) and merges the results.
// onTile(done, total) reports progress.
async function fetchRoadsTiled(bbox, tileDegrees, roadTypes, signal, onTile) {
    const rows = Math.max(1, Math.ceil((bbox.maxLat - bbox.minLat) / tileDegrees));
    const cols = Math.max(1, Math.ceil((bbox.maxLng - bbox.minLng) / tileDegrees));
    const dLat = (bbox.maxLat - bbox.minLat) / rows;
    const dLng = (bbox.maxLng - bbox.minLng) / cols;
    const tiles = [];
    for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
            const s = bbox.minLat + r * dLat, w = bbox.minLng + c * dLng;
            tiles.push({ index: tiles.length, overpassFilter: `(${s.toFixed(5)},${w.toFixed(5)},${(s + dLat).toFixed(5)},${(w + dLng).toFixed(5)})` });
        }
    }
    const ways = new Map();
    let done = 0;
    onTile?.(0, tiles.length);
    await forEachLimited(tiles, 2 * CONFIG.overpass.endpoints.length, async (tile) => {
        const data = await fetchRoads(tile, signal, roadTypes, tile.index);
        for (const el of data.elements || []) if (el.type === "way") ways.set(el.id, el);
        onTile?.(++done, tiles.length);
    });
    return { elements: [...ways.values()] };
}
