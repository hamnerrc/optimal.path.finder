// ==========================================================================
// Road loader from vector tiles.
//
// OpenFreeMap serves every OpenStreetMap road on Earth as precomputed vector
// tiles from a CDN (rebuilt weekly). Fetching the tiles that cover a region
// in parallel is many times faster than asking Overpass, which has to run a
// database query for each download. Tiles are kept in memory, so later
// searches nearby reuse them.
//
// Tiles don't carry OSM node IDs, and simplification drops some junction
// points from straight roads, so the junctions are rebuilt geometrically
// ("noding"): roads that share a point, end on another road, or cross it
// are joined there, except where one of them is a bridge or tunnel.
//
// The result has the same shape as an Overpass response ({ elements: ways
// with nodes, points and tags }), so buildRoadNetwork() works unchanged.
// ==========================================================================

const TILE_EXTENT = 4096;   // tile coordinates are rescaled to this

// OpenMapTiles class -> OSM highway type. Classes not listed (ferries,
// piers, construction…) are not roads. Railroad tracks ("railway") are
// only used when asked for (see roadTypesFor in js/pipeline.js).
const TILE_CLASSES = {
    motorway: "motorway", trunk: "trunk", primary: "primary",
    secondary: "secondary", tertiary: "tertiary",
    minor: "residential", service: "service", track: "track", path: "path",
    rail: "railway"
};
const TILE_PATH_TYPES = new Set(["footway", "cycleway", "bridleway", "steps", "pedestrian", "path"]);
// Indoor corridors and station platforms aren't paths you can run along.
const TILE_NOT_PATHS = new Set(["corridor", "platform"]);
// Railroad tracks that run on their own (not trams in the street, subways
// or yard tracks).
const TILE_RAIL_TYPES = new Set(["rail", "narrow_gauge", "preserved"]);

let tileTemplatePromise = null;
// "z/x/y" -> Promise<{ lines: [{ highway, brunnel, oneway, expressway, driveway, restricted, pts }],
//                      barriers: [pts] }>  (see tileContents)
const tileStore = new Map();
let tileStoreVertices = 0;

// The most detailed zoom (at most `top`) at which the bbox needs no more
// than maxTiles tiles. Major roads are in tiles from zoom 8-11 up.
function roadTileZoom(bbox, maxTiles, top = 12) {
    for (let z = top; z > CONFIG.roadTiles.minZoom; z--) {
        if (tileRange(bbox, z).count <= maxTiles) return z;
    }
    return CONFIG.roadTiles.minZoom;
}

// Resolves with an Overpass-like { elements } of the roads in the tiles that
// cover `region` (anything with a bbox, optionally contains() and outline).
// roadTypes filters highway types; zoom defaults to full detail.
// noExpressways also leaves out other roads tagged as expressways; hops adds
// fence hops (see hopLines); connector adds a line ([[lat, lng], …]) as a
// road of type "connector". Fails with err.tooManyRoads once the tiles
// hold more than maxVertices points.
async function fetchRoadsFromTiles(region, signal, { roadTypes = CONFIG.roadTypes, zoom = CONFIG.roadTiles.zoom, noExpressways = false, hops = false, onProgress, maxVertices = Infinity, connector = null } = {}) {
    const template = await tileTemplate(signal);
    const tiles = tilesCovering(region, zoom);
    const types = new Set(roadTypes);

    let done = 0, vertices = 0;
    onProgress?.(0, tiles.length);
    const loaded = new Array(tiles.length);
    await forEachLimited(tiles.map((tile, i) => ({ ...tile, i })), CONFIG.roadTiles.concurrency, async ({ x, y, i }) => {
        loaded[i] = await loadTile(template, zoom, x, y, signal);
        // (A tile shared with a prefetch doesn't stop when the search does.)
        signal?.throwIfAborted();
        vertices += loaded[i].vertices;
        if (vertices > maxVertices) {
            const err = new Error("Too many roads to load at once.");
            err.tooManyRoads = true;
            throw err;
        }
        onProgress?.(++done, tiles.length);
    });
    trimTileStore();
    // In tile order, not the order they arrived in, so that the same search
    // always gets the same network (and finds the same loop).
    const lines = [], barriers = [];
    for (const tile of loaded) {
        for (const line of tile.lines) {
            if (types.has(line.highway) && !(noExpressways && line.expressway)) lines.push(line);
            else if (hops && !line.brunnel) barriers.push(line.pts);
        }
        if (hops) for (const pts of tile.barriers) barriers.push(pts);
    }
    // (A line given as [[lat, lng], …], joined to the roads like one: see
    // corridor connectors in js/pipeline.js.)
    if (connector) {
        const n = 2 ** zoom, pts = [];
        for (const [lat, lng] of connector) pushPoint(pts, Math.round(lngToTileX(lng, n) * TILE_EXTENT), Math.round(latToTileY(lat, n) * TILE_EXTENT));
        if (pts.length >= 4) lines.push({ highway: "connector", brunnel: false, oneway: 0, expressway: false, driveway: false, restricted: false, pts });
    }
    const noded = nodeLines(lines, zoom);
    if (hops) for (const hop of hopLines(noded, barriers, zoom)) noded.push(hop);
    return { elements: linesToWays(noded, zoom) };
}

// Loads the tiles covering a region into the tile store (if there are no
// more than maxTiles), without a signal, so that a search that needs them
// meanwhile can share the downloads. Setting run.cancelled stops it starting
// more.
async function prefetchTiles(region, zoom, { maxTiles = CONFIG.roadTiles.prefetchMaxTiles, run = null } = {}) {
    const template = await tileTemplate();
    const tiles = tilesCovering(region, zoom);
    if (tiles.length > maxTiles) return;
    await forEachLimited(tiles, CONFIG.roadTiles.concurrency, ({ x, y }) => run?.cancelled ? null : loadTile(template, zoom, x, y).catch(() => {}));
    trimTileStore();
}

async function tileTemplate(signal) {
    if (!tileTemplatePromise) {
        tileTemplatePromise = fetch(CONFIG.roadTiles.tileJsonUrl, { signal })
            .then(response => {
                if (!response.ok) throw new Error(`Road tiles unavailable (HTTP ${response.status})`);
                return response.json();
            })
            .then(json => json.tiles[0]);
        tileTemplatePromise.catch(() => { tileTemplatePromise = null; });
    }
    return tileTemplatePromise;
}

function loadTile(template, z, x, y, signal) {
    const key = `${z}/${x}/${y}`;
    let entry = tileStore.get(key);
    if (entry) {
        // Most recently used last.
        tileStore.delete(key);
        tileStore.set(key, entry);
        return entry;
    }
    // (Across the antimeridian, x is past either end of the row: the tile
    // is the same, its roads drawn on this side.)
    const n = 2 ** z;
    entry = fetchTile(template.replace("{z}", z).replace("{x}", ((x % n) + n) % n).replace("{y}", y), signal)
        .then(buffer => {
            const contents = tileContents(buffer, z, x, y);
            contents.vertices = entry.vertices = contents.lines.reduce((sum, line) => sum + line.pts.length / 2, 0) +
                contents.barriers.reduce((sum, pts) => sum + pts.length / 2, 0);
            tileStoreVertices += entry.vertices;
            return contents;
        });
    entry.catch(() => tileStore.delete(key));
    tileStore.set(key, entry);
    return entry;
}

// A tile's data (empty if there are no roads there). A dropped connection
// or a busy server is tried again a few times: one failed tile among
// thousands shouldn't fail a search.
async function fetchTile(url, signal, attempts = 4) {
    for (let i = 1; ; i++) {
        let response;
        try {
            response = await fetch(url, { signal });
        } catch (err) {
            if (err.name === "AbortError" || i >= attempts) throw err;
            await new Promise(resolve => setTimeout(resolve, 500 * i));
            continue;
        }
        if (response.status === 204 || response.status === 404) return new ArrayBuffer(0);
        if (response.ok) return response.arrayBuffer();
        if ((response.status !== 429 && response.status < 500) || i >= attempts) {
            throw new Error(`Road tile download failed (HTTP ${response.status})`);
        }
        await new Promise(resolve => setTimeout(resolve, 1000 * i));
    }
}

function trimTileStore() {
    for (const [key, entry] of tileStore) {
        if (tileStoreVertices <= CONFIG.roadTiles.cacheMaxVertices) break;
        if (!entry.vertices) continue;
        tileStoreVertices -= entry.vertices;
        tileStore.delete(key);
    }
}

// Runs fn over items with at most `limit` running at once, until one fails.
async function forEachLimited(items, limit, fn) {
    let next = 0, failed = false;
    const worker = async () => {
        try {
            while (next < items.length && !failed) await fn(items[next++]);
        } catch (err) {
            failed = true;
            throw err;
        }
    };
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

// --- Tile geometry ----------------------------------------------------------

function tileRange(bbox, z) {
    const n = 2 ** z;
    const x0 = Math.floor(lngToTileX(bbox.minLng, n)), x1 = Math.floor(lngToTileX(bbox.maxLng, n));
    const y0 = Math.floor(latToTileY(bbox.maxLat, n)), y1 = Math.floor(latToTileY(bbox.minLat, n));
    return { x0, x1, y0, y1, count: (x1 - x0 + 1) * (y1 - y0 + 1) };
}

const lngToTileX = (lng, n) => (lng + 180) / 360 * n;
const latToTileY = (lat, n) => {
    const s = Math.sin(Math.max(-85, Math.min(85, lat)) * Math.PI / 180);
    return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n;
};
const tileXToLng = (x, n) => x / n * 360 - 180;
const tileYToLat = (y, n) => Math.atan(Math.sinh(Math.PI * (1 - 2 * y / n))) * 180 / Math.PI;

// Tiles in the region's bbox that overlap the region itself (a thin
// corridor along a diagonal only needs a fraction of its bbox).
function tilesCovering(region, z) {
    const n = 2 ** z;
    if (region.type === "corridor") return tilesAlongCorridor(region, z);
    const { x0, x1, y0, y1 } = tileRange(region.bbox, z);
    if (!region.contains || !region.outline) {
        const all = [];
        for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) all.push({ x, y });
        return all;
    }
    const keep = new Set();
    // Tiles with an outline point (densified to a quarter tile)...
    const step = 360 / n / 4;
    const outline = region.outline;
    for (let i = 0; i < outline.length; i++) {
        const a = outline[i], b = outline[(i + 1) % outline.length];
        const parts = Math.max(1, Math.ceil(Math.max(Math.abs(b.lat - a.lat), Math.abs(b.lng - a.lng)) / step));
        for (let k = 0; k < parts; k++) {
            const lat = a.lat + (b.lat - a.lat) * k / parts, lng = a.lng + (b.lng - a.lng) * k / parts;
            keep.add(`${Math.floor(lngToTileX(lng, n))},${Math.floor(latToTileY(lat, n))}`);
        }
    }
    const tiles = [];
    for (let x = x0; x <= x1; x++) {
        for (let y = y0; y <= y1; y++) {
            // ...or whose centre is inside the region.
            if (keep.has(`${x},${y}`) || region.contains(tileYToLat(y + 0.5, n), tileXToLng(x + 0.5, n))) tiles.push({ x, y });
        }
    }
    return tiles;
}

// Tiles within a corridor's radius of its line (its bbox can be thousands
// of times larger, e.g. for a loop around a state).
function tilesAlongCorridor(region, z) {
    const n = 2 ** z;
    const { points, radiusMeters } = region;
    const keep = new Map();
    const add = (lat, lng) => {
        // The radius in tile units here (tiles shrink toward the poles).
        const tileM = 40075016.7 * Math.cos(lat * Math.PI / 180) / n;
        const r = radiusMeters / tileM;
        const tx = lngToTileX(lng, n), ty = latToTileY(lat, n);
        for (let x = Math.floor(tx - r); x <= Math.floor(tx + r); x++) {
            for (let y = Math.floor(ty - r); y <= Math.floor(ty + r); y++) {
                // Distance from the point to the tile's square.
                const dx = Math.max(x - tx, 0, tx - x - 1), dy = Math.max(y - ty, 0, ty - y - 1);
                if (dx * dx + dy * dy <= r * r) keep.set(`${x},${y}`, { x, y });
            }
        }
    };
    // Points every quarter tile along the line.
    const step = 360 / n / 4;
    for (let i = 0; i < points.length; i++) {
        const a = points[i], b = points[Math.min(i + 1, points.length - 1)];
        const parts = Math.max(1, Math.ceil(Math.max(Math.abs(b.lat - a.lat), Math.abs(b.lng - a.lng)) / step));
        for (let k = 0; k < parts; k++) add(a.lat + (b.lat - a.lat) * k / parts, a.lng + (b.lng - a.lng) * k / parts);
    }
    return [...keep.values()];
}

// Road lines of one tile in world coordinates at zoom z (TILE_EXTENT units
// per tile), clipped to the tile's own square so neighbouring tiles' buffers
// don't overlap, and what a fence hop may not cross (see hopLines): other
// tracks (trams, subways above ground…), rivers, streams and the shores of
// lakes and the sea. (Fence hops are only made from full-detail tiles, so
// coarser ones skip what they may not cross.)
function tileContents(buffer, z, tx, ty) {
    const hops = z === CONFIG.roadTiles.zoom;
    const layers = decodeTileLayers(buffer, hops ? ["transportation", "waterway", "water"] : ["transportation"], hops ? ["water"] : []);
    const ox = tx * TILE_EXTENT, oy = ty * TILE_EXTENT;
    const clipped = (layer, line) => clipLine(line, TILE_EXTENT / layer.extent, 0, TILE_EXTENT).map(pts => {
        for (let i = 0; i < pts.length; i += 2) {
            pts[i] += ox;
            pts[i + 1] += oy;
        }
        return pts;
    });
    const lines = [], barriers = [];
    const roads = layers.transportation;
    for (const { props, lines: geometry } of roads.features) {
        const highway = tileHighway(props);
        const tunnel = props.brunnel === "tunnel";
        if (!highway) {
            if (hops && (props.class === "rail" || props.class === "transit") && !tunnel) {
                for (const line of geometry) barriers.push(...clipped(roads, line));
            }
            continue;
        }
        const brunnel = props.brunnel === "bridge" || tunnel;
        const oneway = props.oneway === 1 ? 1 : props.oneway === -1 ? -1 : 0;
        const expressway = props.expressway === 1;
        const driveway = props.service === "driveway";
        const restricted = isRestricted(props.access, props.foot);
        for (const line of geometry) {
            for (const pts of clipped(roads, line)) lines.push({ highway, brunnel, oneway, expressway, driveway, restricted, pts });
        }
    }
    for (const name of hops ? ["waterway", "water"] : []) {
        const layer = layers[name];
        for (const { props, lines: geometry } of layer.features) {
            if (props.brunnel === "tunnel") continue;
            for (const line of geometry) barriers.push(...clipped(layer, line));
        }
    }
    return { lines, barriers };
}

// Marked private or no entry on foot (OpenMapTiles' access "no" stands
// for access=no or private). These are used like any other road, but
// flagged on the loop. (Not motorways: no one expects to walk those.)
function isRestricted(access, foot) {
    if (foot === "yes" || foot === "designated" || foot === "permissive") return false;
    return access === "no" || access === "private" || foot === "no" || foot === "private";
}

function tileHighway(props) {
    const base = TILE_CLASSES[props.class];
    if (!base) return null;
    if (base === "railway") {
        return TILE_RAIL_TYPES.has(props.subclass) && props.brunnel !== "tunnel" &&
            props.service !== "yard" && props.service !== "crossover" ? "railway" : null;
    }
    if (base === "path") {
        if (TILE_NOT_PATHS.has(props.subclass)) return null;
        return TILE_PATH_TYPES.has(props.subclass) ? props.subclass : "path";
    }
    if (base === "residential") {
        return ["unclassified", "living_street", "road", "residential"].includes(props.subclass) ? props.subclass : "residential";
    }
    if (props.ramp === 1 && ["motorway", "trunk", "primary", "secondary", "tertiary"].includes(base)) return base + "_link";
    return base;
}

// Clips a flat [x, y, …] line (scaled by `scale`) to the square [lo, hi]²,
// returning the inside pieces. Points made by clipping are rounded to whole
// units, so both tiles on either side of an edge produce (nearly) the same one.
function clipLine(line, scale, lo, hi) {
    const pieces = [];
    let piece = null;
    const inside = (x, y) => x >= lo && x <= hi && y >= lo && y <= hi;
    for (let i = 2; i < line.length; i += 2) {
        const ax = line[i - 2] * scale, ay = line[i - 1] * scale;
        const bx = line[i] * scale, by = line[i + 1] * scale;
        // Liang–Barsky
        let t0 = 0, t1 = 1;
        const dx = bx - ax, dy = by - ay;
        const p = [-dx, dx, -dy, dy], q = [ax - lo, hi - ax, ay - lo, hi - ay];
        let visible = true;
        for (let k = 0; k < 4 && visible; k++) {
            if (p[k] === 0) {
                if (q[k] < 0) visible = false;
            } else {
                const r = q[k] / p[k];
                if (p[k] < 0) { if (r > t1) visible = false; else if (r > t0) t0 = r; }
                else if (r < t0) visible = false; else if (r < t1) t1 = r;
            }
        }
        if (!visible || t1 - t0 <= 0 && !(t0 === 0 && inside(ax, ay))) {
            if (piece) { pieces.push(piece); piece = null; }
            continue;
        }
        const sx = t0 > 0 ? Math.round(ax + t0 * dx) : ax, sy = t0 > 0 ? Math.round(ay + t0 * dy) : ay;
        const ex = t1 < 1 ? Math.round(ax + t1 * dx) : bx, ey = t1 < 1 ? Math.round(ay + t1 * dy) : by;
        if (!piece || t0 > 0) {
            if (piece) pieces.push(piece);
            piece = [sx, sy];
        }
        if (ex !== piece[piece.length - 2] || ey !== piece[piece.length - 1]) piece.push(ex, ey);
        if (t1 < 1) { pieces.push(piece); piece = null; }
    }
    if (piece) pieces.push(piece);
    return pieces.filter(pts => pts.length >= 4);
}

// --- Noding -------------------------------------------------------------

const SNAP_UNITS = 1.5;   // join distance, in tile units (~0.7 m at zoom 14)
const NODE_CELL = 64;
// Line ends this close are the same point. A road is often split into
// several features (at a bridge, or where its tags change), and their ends
// can be a few units apart instead of equal.
const END_SNAP_M = 2.5;
// Ends cut at a tile edge, by another such end on the same edge, this much
// further apart per zoom level below 14: coarser tiles are simplified more,
// and each tile on its own (zoom 12: tens of meters). And at least
// EDGE_SNAP_UNITS apart (1.5 pixels of a 256-pixel tile, about what each
// tile's simplification moves a line): a road that runs along a tile edge,
// in and out of both tiles, is cut into pieces whose ends are that far
// apart (zoom 12: up to 50 m or so).
const EDGE_SNAP_M = 7.5;
const EDGE_SNAP_UNITS = 24;
const EDGE_SNAP_MAX_M = 1000;

// Splits lines wherever they meet another line, so every junction is a
// shared vertex. Rules: a line end (or tile-edge cut) touching another line
// joins it; an inner vertex or a crossing joins only if neither line is a
// bridge or tunnel. Returns new lines with the same properties.
function nodeLines(lines, z = CONFIG.roadTiles.zoom, pass = 1) {
    if (pass === 1) snapEnds(lines, z);

    // Segment grid: each segment's box (grown by the join distance) is
    // listed in every cell it overlaps. The (cell, segment) pairs are packed
    // into numbers and sorted, which groups them by cell without a Map.
    let S = 0, minX0 = Infinity, minY0 = Infinity, maxX0 = -Infinity, maxY0 = -Infinity;
    for (const { pts } of lines) {
        S += Math.max(0, pts.length / 2 - 1);
        for (let i = 0; i < pts.length; i += 2) {
            if (pts[i] < minX0) minX0 = pts[i];
            if (pts[i] > maxX0) maxX0 = pts[i];
            if (pts[i + 1] < minY0) minY0 = pts[i + 1];
            if (pts[i + 1] > maxY0) maxY0 = pts[i + 1];
        }
    }
    const segLine = new Int32Array(S), segIndex = new Int32Array(S), box = new Float64Array(4 * S);
    // Cells NODE_CELL wide, or wider if the cell numbers wouldn't fit.
    let cellSize = NODE_CELL;
    const segBits = 2 ** Math.max(1, Math.ceil(Math.log2(S + 1)));
    const cellsAcross = () => Math.floor((maxY0 - minY0 + 2 * SNAP_UNITS) / cellSize) + 2;
    while (((maxX0 - minX0 + 2 * SNAP_UNITS) / cellSize + 2) * cellsAcross() * segBits > 2 ** 52) cellSize *= 2;
    const H = cellsAcross();
    const cellOf = (v, lo) => Math.floor((v - lo + SNAP_UNITS) / cellSize);
    let pairs = new Float64Array(Math.max(16, Math.ceil(S * 1.5)));
    let np = 0;
    let s = 0;
    lines.forEach((line, li) => {
        const p = line.pts;
        for (let i = 0; i + 3 < p.length; i += 2, s++) {
            segLine[s] = li;
            segIndex[s] = i;
            const minX = Math.min(p[i], p[i + 2]) - SNAP_UNITS, maxX = Math.max(p[i], p[i + 2]) + SNAP_UNITS;
            const minY = Math.min(p[i + 1], p[i + 3]) - SNAP_UNITS, maxY = Math.max(p[i + 1], p[i + 3]) + SNAP_UNITS;
            box[4 * s] = minX;
            box[4 * s + 1] = minY;
            box[4 * s + 2] = maxX;
            box[4 * s + 3] = maxY;
            for (let cx = cellOf(minX, minX0); cx <= cellOf(maxX, minX0); cx++) {
                for (let cy = cellOf(minY, minY0); cy <= cellOf(maxY, minY0); cy++) {
                    if (np === pairs.length) {
                        const grown = new Float64Array(2 * np);
                        grown.set(pairs);
                        pairs = grown;
                    }
                    pairs[np++] = (cx * H + cy) * segBits + s;
                }
            }
        }
    });
    pairs = pairs.subarray(0, np).sort();

    // Split points per segment: [t, x, y, …].
    const splits = new Map();
    const addSplit = (seg, t, x, y) => {
        let list = splits.get(seg);
        if (!list) splits.set(seg, list = []);
        list.push(t, x, y);
    };
    const segs = [];
    for (let k = 0; k < np;) {
        const cell = Math.floor(pairs[k] / segBits);
        segs.length = 0;
        for (; k < np && Math.floor(pairs[k] / segBits) === cell; k++) segs.push(pairs[k] - cell * segBits);
        const cx = Math.floor(cell / H), cy = cell - cx * H;
        for (let i = 0; i < segs.length; i++) {
            const a = segs[i];
            for (let j = i + 1; j < segs.length; j++) {
                const b = segs[j];
                // (Segments of one line only where they cross: coarse tiles
                // merge many roads into one line, which can cross itself.)
                const same = segLine[a] === segLine[b];
                if (same && Math.abs(segIndex[a] - segIndex[b]) <= 2) continue;
                // Boxes must overlap; handle each pair only in the cell
                // holding the corner of their overlap, not in every shared cell.
                const minX = Math.max(box[4 * a], box[4 * b]), minY = Math.max(box[4 * a + 1], box[4 * b + 1]);
                if (minX > Math.min(box[4 * a + 2], box[4 * b + 2]) || minY > Math.min(box[4 * a + 3], box[4 * b + 3])) continue;
                if (cellOf(minX, minX0) !== cx || cellOf(minY, minY0) !== cy) continue;
                meetSegments(lines, segLine, segIndex, Math.min(a, b), Math.max(a, b), addSplit, same);
            }
        }
    }

    // Rebuild lines with their split points.
    const out = [];
    s = 0;
    lines.forEach((line) => {
        const p = line.pts;
        const pts = [p[0], p[1]];
        for (let i = 0; i + 3 < p.length; i += 2, s++) {
            const list = splits.get(s);
            if (list) {
                const order = [];
                for (let k = 0; k < list.length; k += 3) order.push(k);
                order.sort((u, v) => list[u] - list[v]);
                for (const k of order) pushPoint(pts, list[k + 1], list[k + 2]);
            }
            pushPoint(pts, p[i + 2], p[i + 3]);
        }
        if (pts.length >= 4) out.push({ ...line, pts });
    });
    // (Split points are rounded to whole units, which moves a line a
    // little: in coarse tiles, where a unit is tens of meters and roads
    // are drawn close together, that makes new crossings. A second pass
    // joins those.)
    if (z < CONFIG.roadTiles.zoom && pass < 2) return nodeLines(out, z, pass + 1);
    return out;
}

function pushPoint(pts, x, y) {
    if (pts[pts.length - 2] !== x || pts[pts.length - 1] !== y) pts.push(x, y);
}

// Line ends within END_SNAP_M of another end get the same point (in
// `lines`, which is changed in place). This also
// joins a road cut at a tile edge: each tile is simplified on its own, so the
// two cut ends can be a few units apart.
function snapEnds(lines, z) {
    const n = 2 ** z * TILE_EXTENT;
    const midY = lines.length ? lines[0].pts[1] : n / 2;
    const unitM = 40075016.7 * Math.cos(tileYToLat(midY, n) * Math.PI / 180) / n;
    const reach = Math.max(SNAP_UNITS, END_SNAP_M / unitM);
    if (z < CONFIG.roadTiles.zoom) {
        pairEdgeEnds(lines, Math.max(reach, EDGE_SNAP_M * 2 ** (CONFIG.roadTiles.zoom - z - 1) / unitM,
            Math.min(EDGE_SNAP_UNITS, EDGE_SNAP_MAX_M / unitM)));
    }
    const cell = Math.max(2, Math.ceil(reach));
    // Ends kept so far, chained per cell.
    const E = 2 * lines.length;
    const endX = new Float64Array(E), endY = new Float64Array(E), next = new Int32Array(E);
    const head = new Map();
    let count = 0;
    // Returns the point to use for an end: an earlier end close by, or
    // this one (then kept).
    const snap = (x, y) => {
        const cx = Math.floor(x / cell), cy = Math.floor(y / cell);
        let best = -1, bestD = Infinity;
        for (let dx = -1; dx <= 1; dx++) {
            for (let dy = -1; dy <= 1; dy++) {
                for (let k = head.get((cx + dx) * 2 ** 26 + cy + dy) ?? -1; k >= 0; k = next[k]) {
                    const d = Math.max(Math.abs(endX[k] - x), Math.abs(endY[k] - y));
                    if (d <= reach && d < bestD) {
                        bestD = d;
                        best = k;
                    }
                }
            }
        }
        if (best >= 0) return best;
        const key = cx * 2 ** 26 + cy;
        next[count] = head.get(key) ?? -1;
        head.set(key, count);
        endX[count] = x;
        endY[count] = y;
        return count++;
    };
    // Lines whose ends move are replaced by copies: the originals are
    // shared with the tile store.
    lines.forEach((line, li) => {
        const p = line.pts, last = p.length - 2;
        const a = snap(p[0], p[1]), b = snap(p[last], p[last + 1]);
        if (endX[a] === p[0] && endY[a] === p[1] && endX[b] === p[last] && endY[b] === p[last + 1]) return;
        const pts = p.slice();
        pts[0] = endX[a];
        pts[1] = endY[a];
        pts[last] = endX[b];
        pts[last + 1] = endY[b];
        lines[li] = { ...line, pts };
    });
}

// Joins the ends of roads cut at tile edges (coarser tiles): on each edge,
// an end with one on the other side of it up to `reach` along it, closest
// pairs first, and the same kind of road before another (a road and a
// railroad side by side are cut a few units apart: joined the wrong way
// round, the road would be broken). Both ends of a pair are moved to the
// same point, which snapEnds then joins.
function pairEdgeEnds(lines, reach) {
    const edges = new Map();   // edge -> [{ li, i, along, side, kind }]
    lines.forEach((line, li) => {
        const p = line.pts, last = p.length - 2;
        for (const [i, j] of [[0, 2], [last, last - 2]]) {
            const x = p[i], y = p[i + 1];
            let key, along, side;
            if (x % TILE_EXTENT === 0 && p[j] !== x) [key, along, side] = [`x${x}`, y, Math.sign(p[j] - x)];
            else if (y % TILE_EXTENT === 0 && p[j + 1] !== y) [key, along, side] = [`y${y}`, x, Math.sign(p[j + 1] - y)];
            else continue;
            if (!edges.has(key)) edges.set(key, []);
            edges.get(key).push({ li, i, along, side, kind: line.highway, pair: null });
        }
    });
    const copied = new Set();
    for (const [key, ends] of edges) {
        ends.sort((a, b) => a.along - b.along);
        const pairs = [];
        for (let a = 0; a < ends.length; a++) {
            for (let b = a + 1; b < ends.length && ends[b].along - ends[a].along <= reach; b++) {
                if (ends[a].side === ends[b].side) continue;
                const d = ends[b].along - ends[a].along;
                pairs.push([ends[a].kind === ends[b].kind ? d : 4 * d + reach, a, b]);
            }
        }
        pairs.sort((p, q) => p[0] - q[0]);
        for (const [, a, b] of pairs) {
            const A = ends[a], B = ends[b];
            if (A.pair || B.pair) continue;
            A.pair = B.pair = true;
            if (A.along === B.along) continue;
            const at = Math.round((A.along + B.along) / 2);
            for (const { li, i } of [A, B]) {
                if (!copied.has(li)) {
                    copied.add(li);
                    lines[li] = { ...lines[li], pts: lines[li].pts.slice() };
                }
                lines[li].pts[key[0] === "x" ? i + 1 : i] = at;
            }
        }
    }
}

function meetSegments(lines, segLine, segIndex, a, b, addSplit, sameLine = false) {
    const la = lines[segLine[a]], lb = lines[segLine[b]];
    const pa = la.pts, pb = lb.pts, ia = segIndex[a], ib = segIndex[b];
    const ax = pa[ia], ay = pa[ia + 1], bx = pa[ia + 2], by = pa[ia + 3];
    const cx = pb[ib], cy = pb[ib + 1], dx = pb[ib + 2], dy = pb[ib + 3];
    const flat = !la.brunnel && !lb.brunnel;

    // A proper crossing (first: a vertex of one segment near the other
    // doesn't mean they don't also cross).
    const rx = bx - ax, ry = by - ay, sx = dx - cx, sy = dy - cy;
    const denom = rx * sy - ry * sx;
    if (flat && denom !== 0) {
        const t = ((cx - ax) * sy - (cy - ay) * sx) / denom;
        const u = ((cx - ax) * ry - (cy - ay) * rx) / denom;
        if (t > 0 && t < 1 && u > 0 && u < 1) {
            const x = Math.round(ax + t * rx), y = Math.round(ay + t * ry);
            // A crossing within a unit of a vertex is at that vertex: the
            // other road is split there (unless it has that vertex too).
            const near = (px, py) => Math.abs(px - x) <= 1 && Math.abs(py - y) <= 1;
            const atA = near(ax, ay) ? [ax, ay] : near(bx, by) ? [bx, by] : null;
            const atB = near(cx, cy) ? [cx, cy] : near(dx, dy) ? [dx, dy] : null;
            if (atA && atB && atA[0] === atB[0] && atA[1] === atB[1]) return;
            if (atA) addSplit(b, u, atA[0], atA[1]);
            else if (atB) addSplit(a, t, atB[0], atB[1]);
            else {
                addSplit(a, t, x, y);
                addSplit(b, u, x, y);
            }
            return;
        }
    }
    if (sameLine) return;

    // A vertex of one segment on the inside of the other.
    const touch = (px, py, isLineEnd, ownBrunnel, s, sx, sy, ex, ey, otherBrunnel) => {
        if (!flat && !(isLineEnd && !otherBrunnel)) return;
        if (ownBrunnel && !isLineEnd) return;
        const vx = ex - sx, vy = ey - sy, len2 = vx * vx + vy * vy;
        if (len2 === 0) return;
        const t = ((px - sx) * vx + (py - sy) * vy) / len2;
        if (t <= 0 || t >= 1) return;
        const qx = sx + t * vx - px, qy = sy + t * vy - py;
        if (qx * qx + qy * qy > SNAP_UNITS * SNAP_UNITS) return;
        // Too close to the segment's own ends: those are already vertices.
        const along = Math.sqrt(len2);
        if (t * along < SNAP_UNITS || (1 - t) * along < SNAP_UNITS) return;
        addSplit(s, t, px, py);
    };
    const lastA = pa.length - 2, lastB = pb.length - 2;
    touch(ax, ay, ia === 0, la.brunnel, b, cx, cy, dx, dy, lb.brunnel);
    touch(bx, by, ia + 2 === lastA, la.brunnel, b, cx, cy, dx, dy, lb.brunnel);
    touch(cx, cy, ib === 0, lb.brunnel, a, ax, ay, bx, by, la.brunnel);
    touch(dx, dy, ib + 2 === lastB, lb.brunnel, a, ax, ay, bx, by, la.brunnel);
}

// --- Fence hops ---------------------------------------------------------

// Longest fence hop, in meters.
const HOP_M = 10;
// Roads a hop can't start or end on: you can't get on or off these on foot.
const NO_HOP_TYPES = new Set(["motorway", "motorway_link", "trunk", "trunk_link", "railway", "steps"]);

// Fence hops: short straight links from a dead end to the nearest road that
// it doesn't connect to, at most HOP_M away (e.g. a cul-de-sac that ends
// just short of a path or another street). To stay on the safe side, a hop
// only starts at a real dead end (not one made by cutting the map into
// tiles), never starts or ends on a motorway, expressway ramp, railroad,
// steps, driveway, bridge or tunnel, and never crosses another road, railroad, river,
// stream or shore. Splits the roads hopped to (in place) and returns the
// hops as lines of type "hop".
function hopLines(lines, barriers, z) {
    if (!lines.length) return [];
    const n = 2 ** z * TILE_EXTENT;
    const unitM = 40075016.7 * Math.cos(tileYToLat(lines[0].pts[1], n) * Math.PI / 180) / n;
    const reach = HOP_M / unitM;
    const key = (x, y) => x * n + y;
    // (Not driveways either: a hop from one to the next crosses yards.)
    const usable = (line) => !line.brunnel && !line.driveway && !NO_HOP_TYPES.has(line.highway);

    // Streets at each line end (a line end counts once, an inner point
    // twice); only the ends are counted, as only they can start a hop.
    const degree = new Map();
    for (const { pts } of lines) {
        for (const i of [0, pts.length - 2]) {
            const k = key(pts[i], pts[i + 1]);
            degree.set(k, (degree.get(k) || 0) + 1);
        }
    }
    for (const { pts } of lines) {
        for (let i = 2; i < pts.length - 2; i += 2) {
            const k = key(pts[i], pts[i + 1]);
            const d = degree.get(k);
            if (d !== undefined) degree.set(k, d + 2);
        }
    }
    // Where hops can start: real dead ends (not ends made by the tile edge,
    // where the road may go on).
    const ends = [];
    lines.forEach((line, li) => {
        if (!usable(line)) return;
        const p = line.pts;
        for (const i of [0, p.length - 2]) {
            const x = p[i], y = p[i + 1];
            if (degree.get(key(x, y)) === 1 && x % TILE_EXTENT !== 0 && y % TILE_EXTENT !== 0) ends.push(li, i);
        }
    });

    // Segment grid: roads (index ≥ 0 into lines) and barriers (−1 − index),
    // in the cells around dead ends only.
    const cell = Math.max(16, Math.ceil(2 * reach));
    const cellKey = (cx, cy) => cx * 2 ** 24 + cy;
    const grid = new Map();
    for (let k = 0; k < ends.length; k += 2) {
        const p = lines[ends[k]].pts, i = ends[k + 1];
        const cx = Math.floor(p[i] / cell), cy = Math.floor(p[i + 1] / cell);
        for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) grid.set(cellKey(cx + dx, cy + dy), null);
    }
    const addSegments = (pts, id) => {
        for (let i = 0; i + 3 < pts.length; i += 2) {
            const x0 = Math.floor(Math.min(pts[i], pts[i + 2]) / cell), x1 = Math.floor(Math.max(pts[i], pts[i + 2]) / cell);
            const y0 = Math.floor(Math.min(pts[i + 1], pts[i + 3]) / cell), y1 = Math.floor(Math.max(pts[i + 1], pts[i + 3]) / cell);
            for (let cx = x0; cx <= x1; cx++) {
                for (let cy = y0; cy <= y1; cy++) {
                    const k = cellKey(cx, cy);
                    const list = grid.get(k);
                    if (list === undefined) continue;
                    if (list === null) grid.set(k, [id, i]);
                    else list.push(id, i);
                }
            }
        }
    };
    if (ends.length) {
        lines.forEach((line, li) => addSegments(line.pts, line.brunnel ? null : li));
        barriers.forEach((pts, bi) => addSegments(pts, -1 - bi));
    }
    const segmentsNear = (x, y, fn) => {
        const cx = Math.floor(x / cell), cy = Math.floor(y / cell);
        for (let dx = -1; dx <= 1; dx++) {
            for (let dy = -1; dy <= 1; dy++) {
                const list = grid.get((cx + dx) * 2 ** 24 + cy + dy);
                if (list) for (let k = 0; k < list.length; k += 2) fn(list[k], list[k + 1]);
            }
        }
    };
    const ptsOf = (id) => id === null ? null : id >= 0 ? lines[id].pts : barriers[-1 - id];

    const hops = [], splits = new Map(), seen = new Set();
    for (let end = 0; end < ends.length; end += 2) {
        const li = ends[end], i = ends[end + 1];
        const p = lines[li].pts;
        const x = p[i], y = p[i + 1];

        // The nearest point on another usable road.
        let best = null;
        segmentsNear(x, y, (id, si) => {
            if (id === null || id < 0 || id === li || !usable(lines[id])) return;
            const q = lines[id].pts;
            const ax = q[si], ay = q[si + 1], ex = q[si + 2] - ax, ey = q[si + 3] - ay;
            const len2 = ex * ex + ey * ey;
            const t = len2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * ex + (y - ay) * ey) / len2)) : 0;
            const px = Math.round(ax + t * ex), py = Math.round(ay + t * ey);
            const d = Math.hypot(px - x, py - y);
            if (d <= reach && d > SNAP_UNITS && (!best || d < best.d)) best = { d, id, si, t, px, py };
        });
        if (!best) continue;
        const pairKey = `${Math.min(key(x, y), key(best.px, best.py))},${Math.max(key(x, y), key(best.px, best.py))}`;
        if (seen.has(pairKey)) continue;

        // Nothing in the way: no other road, track or water crossed.
        let blocked = false;
        const hx = best.px - x, hy = best.py - y;
        segmentsNear(x, y, (id, si) => {
            if (blocked || id === null) return;
            const q = ptsOf(id);
            const ax = q[si], ay = q[si + 1], bx = q[si + 2], by = q[si + 3];
            // The hop's own ends touch its two roads (but it mustn't
            // cross back over the rest of the road it starts from).
            if ((id === li && si === (i === 0 ? 0 : p.length - 4)) || (id === best.id && si === best.si)) return;
            const sx = bx - ax, sy = by - ay;
            const den = hx * sy - hy * sx;
            if (den === 0) return;
            const t = ((ax - x) * sy - (ay - y) * sx) / den;
            const u = ((ax - x) * hy - (ay - y) * hx) / den;
            if (t > 0 && t < 1 && u >= 0 && u <= 1) blocked = true;
        });
        if (blocked) continue;
        seen.add(pairKey);

        // Split the road hopped to at the hop's end (unless that's
        // already one of its points).
        const q = lines[best.id].pts;
        const atVertex = (best.px === q[best.si] && best.py === q[best.si + 1]) || (best.px === q[best.si + 2] && best.py === q[best.si + 3]);
        if (!atVertex) {
            let list = splits.get(best.id);
            if (!list) splits.set(best.id, list = []);
            list.push(best.si, best.t, best.px, best.py);
        }
        hops.push({ highway: "hop", brunnel: false, oneway: 0, expressway: false, driveway: false, restricted: false, pts: [x, y, best.px, best.py] });
    }

    for (const [li, list] of splits) {
        const p = lines[li].pts;
        const order = [];
        for (let k = 0; k < list.length; k += 4) order.push(k);
        order.sort((a, b) => list[a] - list[b] || list[a + 1] - list[b + 1]);
        const pts = [p[0], p[1]];
        let at = 0;
        for (let i = 0; i + 3 < p.length; i += 2) {
            while (at < order.length && list[order[at]] === i) {
                pushPoint(pts, list[order[at] + 2], list[order[at] + 3]);
                at++;
            }
            pushPoint(pts, p[i + 2], p[i + 3]);
        }
        lines[li].pts = pts;
    }
    return hops;
}

// Overpass-style ways: node IDs from the (whole-unit) coordinates, so lines
// sharing a point share a node. Their points are lats and lons arrays
// rather than Overpass's geometry objects (much less memory).
function linesToWays(lines, z) {
    const n = 2 ** z * TILE_EXTENT;
    const ways = [];
    lines.forEach((line, k) => {
        const p = line.pts;
        const nodes = [], lats = [], lons = [];
        for (let i = 0; i < p.length; i += 2) {
            const x = Math.round(p[i]), y = Math.round(p[i + 1]);
            nodes.push(x * n + y);
            lats.push(tileYToLat(y, n));
            lons.push(tileXToLng(x, n));
        }
        const tags = { highway: line.highway };
        if (line.oneway) tags.oneway = line.oneway === 1 ? "yes" : "-1";
        if (line.restricted && !line.highway.startsWith("motorway")) tags.access = "no";
        // (A bridge or a tunnel: the elevation under it doesn't count.)
        if (line.brunnel) tags.bridge = "yes";
        ways.push({ type: "way", id: k + 1, nodes, lats, lons, tags });
    });
    return ways;
}

if (typeof module !== "undefined") {
    module.exports = { fetchRoadsFromTiles, tileContents, hopLines, nodeLines, linesToWays, clipLine, tilesCovering, roadTileZoom };
}
