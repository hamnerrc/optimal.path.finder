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
// with nodes, geometry and tags }), so buildRoadNetwork() works unchanged.
// ==========================================================================

const TILE_EXTENT = 4096;   // tile coordinates are rescaled to this

// OpenMapTiles class -> OSM highway type. Classes not listed (rail,
// ferries, piers, construction…) are not roads.
const TILE_CLASSES = {
    motorway: "motorway", trunk: "trunk", primary: "primary",
    secondary: "secondary", tertiary: "tertiary",
    minor: "residential", service: "service", track: "track", path: "path"
};
const TILE_PATH_TYPES = new Set(["footway", "cycleway", "bridleway", "steps", "pedestrian", "path"]);

let tileTemplatePromise = null;
const tileStore = new Map();   // "z/x/y" -> Promise<[{ highway, brunnel, oneway, pts }]>
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
async function fetchRoadsFromTiles(region, signal, { roadTypes = CONFIG.roadTypes, zoom = CONFIG.roadTiles.zoom, onProgress } = {}) {
    const template = await tileTemplate(signal);
    const tiles = tilesCovering(region, zoom);
    const types = new Set(roadTypes);

    let done = 0;
    onProgress?.(0, tiles.length);
    const lines = [];
    await forEachLimited(tiles, CONFIG.roadTiles.concurrency, async ({ x, y }) => {
        const tileLines = await loadTile(template, zoom, x, y, signal);
        for (const line of tileLines) if (types.has(line.highway)) lines.push(line);
        onProgress?.(++done, tiles.length);
    });
    trimTileStore();
    return { elements: linesToWays(nodeLines(lines), zoom) };
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
    entry = fetch(template.replace("{z}", z).replace("{x}", x).replace("{y}", y), { signal })
        .then(response => {
            if (response.status === 204 || response.status === 404) return new ArrayBuffer(0);
            if (!response.ok) throw new Error(`Road tile download failed (HTTP ${response.status})`);
            return response.arrayBuffer();
        })
        .then(buffer => {
            const lines = tileRoadLines(buffer, z, x, y);
            entry.vertices = lines.reduce((sum, line) => sum + line.pts.length / 2, 0);
            tileStoreVertices += entry.vertices;
            return lines;
        });
    entry.catch(() => tileStore.delete(key));
    tileStore.set(key, entry);
    return entry;
}

function trimTileStore() {
    for (const [key, entry] of tileStore) {
        if (tileStoreVertices <= CONFIG.roadTiles.cacheMaxVertices) break;
        if (!entry.vertices) continue;
        tileStoreVertices -= entry.vertices;
        tileStore.delete(key);
    }
}

// Runs fn over items with at most `limit` running at once.
async function forEachLimited(items, limit, fn) {
    let next = 0;
    const worker = async () => {
        while (next < items.length) await fn(items[next++]);
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

// Road lines of one tile in world coordinates at zoom z (TILE_EXTENT units
// per tile), clipped to the tile's own square so neighbouring tiles' buffers
// don't overlap.
function tileRoadLines(buffer, z, tx, ty) {
    const layer = decodeTileLayer(buffer, "transportation");
    const scale = TILE_EXTENT / layer.extent;
    const ox = tx * TILE_EXTENT, oy = ty * TILE_EXTENT;
    const out = [];
    for (const { props, lines } of layer.features) {
        const highway = tileHighway(props);
        if (!highway) continue;
        const brunnel = props.brunnel === "bridge" || props.brunnel === "tunnel";
        const oneway = props.oneway === 1 ? 1 : props.oneway === -1 ? -1 : 0;
        for (const line of lines) {
            for (const pts of clipLine(line, scale, 0, TILE_EXTENT)) {
                for (let i = 0; i < pts.length; i += 2) {
                    pts[i] += ox;
                    pts[i + 1] += oy;
                }
                out.push({ highway, brunnel, oneway, pts });
            }
        }
    }
    return out;
}

function tileHighway(props) {
    const base = TILE_CLASSES[props.class];
    if (!base) return null;
    if (base === "path") return TILE_PATH_TYPES.has(props.subclass) ? props.subclass : "path";
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

// Splits lines wherever they meet another line, so every junction is a
// shared vertex. Rules: a line end (or tile-edge cut) touching another line
// joins it; an inner vertex or a crossing joins only if neither line is a
// bridge or tunnel. Returns new lines with the same properties.
function nodeLines(lines) {
    snapCutEnds(lines);

    // Segment grid: each segment's box (grown by the join distance) is
    // listed in every cell it overlaps.
    const segLine = [], segIndex = [], box = [];
    const grid = new Map();
    lines.forEach((line, li) => {
        const p = line.pts;
        for (let i = 0; i + 3 < p.length; i += 2) {
            const s = segLine.length;
            segLine.push(li);
            segIndex.push(i);
            const minX = Math.min(p[i], p[i + 2]) - SNAP_UNITS, maxX = Math.max(p[i], p[i + 2]) + SNAP_UNITS;
            const minY = Math.min(p[i + 1], p[i + 3]) - SNAP_UNITS, maxY = Math.max(p[i + 1], p[i + 3]) + SNAP_UNITS;
            box.push(minX, minY, maxX, maxY);
            for (let cx = Math.floor(minX / NODE_CELL); cx <= Math.floor(maxX / NODE_CELL); cx++) {
                for (let cy = Math.floor(minY / NODE_CELL); cy <= Math.floor(maxY / NODE_CELL); cy++) {
                    const key = cx * 2 ** 22 + cy;
                    let cell = grid.get(key);
                    if (!cell) grid.set(key, cell = { cx, cy, segs: [] });
                    cell.segs.push(s);
                }
            }
        }
    });

    // Split points per segment: [t, x, y, …].
    const splits = new Map();
    const addSplit = (s, t, x, y) => {
        let list = splits.get(s);
        if (!list) splits.set(s, list = []);
        list.push(t, x, y);
    };
    for (const { cx, cy, segs } of grid.values()) {
        for (let i = 0; i < segs.length; i++) {
            const a = segs[i];
            for (let j = i + 1; j < segs.length; j++) {
                const b = segs[j];
                if (segLine[a] === segLine[b]) continue;
                // Boxes must overlap; handle each pair only in the cell
                // holding the corner of their overlap, not in every shared cell.
                const minX = Math.max(box[4 * a], box[4 * b]), minY = Math.max(box[4 * a + 1], box[4 * b + 1]);
                if (minX > Math.min(box[4 * a + 2], box[4 * b + 2]) || minY > Math.min(box[4 * a + 3], box[4 * b + 3])) continue;
                if (Math.floor(minX / NODE_CELL) !== cx || Math.floor(minY / NODE_CELL) !== cy) continue;
                meetSegments(lines, segLine, segIndex, Math.min(a, b), Math.max(a, b), addSplit);
            }
        }
    }

    // Rebuild lines with their split points.
    const out = [];
    let s = 0;
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
    return out;
}

function pushPoint(pts, x, y) {
    if (pts[pts.length - 2] !== x || pts[pts.length - 1] !== y) pts.push(x, y);
}

// Line ends cut at a tile edge: the same road cut by the neighbouring tile
// ends within a unit or so; give both the same point.
function snapCutEnds(lines) {
    const ends = new Map();
    const snap = (p, i) => {
        const x = p[i], y = p[i + 1];
        const onEdge = x % TILE_EXTENT === 0 || y % TILE_EXTENT === 0;
        if (!onEdge) return;
        const cx = Math.round(x / 2), cy = Math.round(y / 2);
        for (let dx = -1; dx <= 1; dx++) {
            for (let dy = -1; dy <= 1; dy++) {
                const other = ends.get((cx + dx) * 2 ** 26 + cy + dy);
                if (other && Math.abs(other[0] - x) <= SNAP_UNITS && Math.abs(other[1] - y) <= SNAP_UNITS) {
                    p[i] = other[0];
                    p[i + 1] = other[1];
                    return;
                }
            }
        }
        ends.set(cx * 2 ** 26 + cy, [x, y]);
    };
    for (const { pts } of lines) {
        snap(pts, 0);
        snap(pts, pts.length - 2);
    }
}

function meetSegments(lines, segLine, segIndex, a, b, addSplit) {
    const la = lines[segLine[a]], lb = lines[segLine[b]];
    const pa = la.pts, pb = lb.pts, ia = segIndex[a], ib = segIndex[b];
    const ax = pa[ia], ay = pa[ia + 1], bx = pa[ia + 2], by = pa[ia + 3];
    const cx = pb[ib], cy = pb[ib + 1], dx = pb[ib + 2], dy = pb[ib + 3];
    const flat = !la.brunnel && !lb.brunnel;

    // A vertex of one segment on the inside of the other.
    let touched = false;
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
        touched = true;
    };
    const lastA = pa.length - 2, lastB = pb.length - 2;
    touch(ax, ay, ia === 0, la.brunnel, b, cx, cy, dx, dy, lb.brunnel);
    touch(bx, by, ia + 2 === lastA, la.brunnel, b, cx, cy, dx, dy, lb.brunnel);
    touch(cx, cy, ib === 0, lb.brunnel, a, ax, ay, bx, by, la.brunnel);
    touch(dx, dy, ib + 2 === lastB, lb.brunnel, a, ax, ay, bx, by, la.brunnel);
    if (touched || !flat) return;

    // A proper crossing.
    const rx = bx - ax, ry = by - ay, sx = dx - cx, sy = dy - cy;
    const denom = rx * sy - ry * sx;
    if (denom === 0) return;
    const t = ((cx - ax) * sy - (cy - ay) * sx) / denom;
    const u = ((cx - ax) * ry - (cy - ay) * rx) / denom;
    if (t <= 0 || t >= 1 || u <= 0 || u >= 1) return;
    const x = Math.round(ax + t * rx), y = Math.round(ay + t * ry);
    // A crossing within a unit of a vertex is that vertex.
    const near = (px, py) => Math.abs(px - x) <= 1 && Math.abs(py - y) <= 1;
    if (near(ax, ay) || near(bx, by) || near(cx, cy) || near(dx, dy)) return;
    addSplit(a, t, x, y);
    addSplit(b, u, x, y);
}

// Overpass-style ways: node IDs from the (whole-unit) coordinates, so lines
// sharing a point share a node.
function linesToWays(lines, z) {
    const n = 2 ** z * TILE_EXTENT;
    const ways = [];
    lines.forEach((line, k) => {
        const p = line.pts;
        const nodes = [], geometry = [];
        for (let i = 0; i < p.length; i += 2) {
            const x = Math.round(p[i]), y = Math.round(p[i + 1]);
            nodes.push(x * n + y);
            geometry.push({ lat: tileYToLat(y, n), lon: tileXToLng(x, n) });
        }
        const tags = { highway: line.highway };
        if (line.oneway) tags.oneway = line.oneway === 1 ? "yes" : "-1";
        ways.push({ type: "way", id: k + 1, nodes, geometry, tags });
    });
    return ways;
}

if (typeof module !== "undefined") {
    module.exports = { fetchRoadsFromTiles, tileRoadLines, nodeLines, linesToWays, clipLine, tilesCovering, roadTileZoom };
}
