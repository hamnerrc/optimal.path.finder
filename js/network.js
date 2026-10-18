// ==========================================================================
// Road network builder
//
// Turns an Overpass response into a routing graph clipped to a region.
// Roads are joined at shared OSM node IDs, and chains of in-between points
// are collapsed into single edges, so the graph only contains intersections
// and dead ends. Each edge keeps its full geometry for drawing routes.
//
//   nodes      Map<osmNodeId, { id, lat, lng }>
//   edges      [{ id, from, to, distance, coords: [[lat, lng], …],
//                 wayId, highway, name, oneway }]
//   stats      { intersections, segments, totalMiles, ways }
//
// Points are numbered as they're first seen, so the work per point uses
// typed arrays rather than maps keyed by node ID.
// ==========================================================================

function buildRoadNetwork(osmData, region) {
    const index = new Map();    // OSM node ID -> point number
    const ids = [], lats = [], lngs = [];
    const runs = [];            // contiguous in-region stretches of each way: { way, pts: [point number, …] }

    // 1. Clip ways to the region, splitting them where they leave it.
    for (const way of osmData.elements || []) {
        if (way.type !== "way" || !way.nodes || !way.geometry) continue;

        let run = null;
        for (let i = 0; i < way.nodes.length; i++) {
            const g = way.geometry[i];
            if (!g || !region.contains(g.lat, g.lon)) {
                if (run && run.pts.length > 1) runs.push(run);
                run = null;
                continue;
            }

            const id = way.nodes[i];
            let k = index.get(id);
            if (k === undefined) {
                k = ids.length;
                index.set(id, k);
                ids.push(id);
                lats.push(g.lat);
                lngs.push(g.lon);
            }
            if (!run) run = { way, pts: [] };
            if (run.pts[run.pts.length - 1] !== k) run.pts.push(k);
        }
        if (run && run.pts.length > 1) runs.push(run);
    }
    const N = ids.length;

    // 2. Node degree, counting each neighbour once: every (point, neighbour)
    //    pair packed into one number, sorted, duplicates skipped.
    let pairCount = 0;
    for (const { pts } of runs) pairCount += 2 * (pts.length - 1);
    const pairs = new Float64Array(pairCount);
    let np = 0;
    for (const { pts } of runs) {
        for (let i = 1; i < pts.length; i++) {
            pairs[np++] = pts[i - 1] * N + pts[i];
            pairs[np++] = pts[i] * N + pts[i - 1];
        }
    }
    pairs.sort();
    const degree = new Int32Array(N);
    for (let i = 0; i < np; i++) {
        if (i === 0 || pairs[i] !== pairs[i - 1]) degree[Math.floor(pairs[i] / N)]++;
    }

    // 3. Keep intersections, dead ends and run endpoints; collapse the rest.
    const kept = new Uint8Array(N);
    for (const { pts } of runs) {
        kept[pts[0]] = 1;
        kept[pts[pts.length - 1]] = 1;
        for (const k of pts) if (degree[k] !== 2) kept[k] = 1;
    }
    const nodes = new Map();
    for (let k = 0; k < N; k++) {
        if (kept[k]) nodes.set(ids[k], { id: ids[k], lat: lats[k], lng: lngs[k] });
    }

    const edges = [];
    let totalMeters = 0;

    for (const { way, pts } of runs) {
        const tags = way.tags || {};
        let start = pts[0];
        let prev = start;
        let coords = [[lats[start], lngs[start]]];
        let distance = 0;

        for (let i = 1; i < pts.length; i++) {
            const k = pts[i];
            distance += haversine(lats[prev], lngs[prev], lats[k], lngs[k]);
            coords.push([lats[k], lngs[k]]);
            prev = k;

            if (kept[k]) {
                edges.push({
                    id: edges.length,
                    from: ids[start],
                    to: ids[k],
                    distance,
                    coords,
                    wayId: way.id,
                    highway: tags.highway || (tags.railway ? "railway" : undefined),
                    name: tags.name || null,
                    oneway: parseOneway(tags)
                });
                totalMeters += distance;
                start = k;
                coords = [[lats[k], lngs[k]]];
                distance = 0;
            }
        }
    }

    return {
        nodes,
        edges,
        region,
        stats: {
            intersections: nodes.size,
            segments: edges.length,
            totalMiles: metersToMiles(totalMeters),
            ways: new Set(runs.map(r => r.way.id)).size
        }
    };
}

// 1 = one-way in drawing direction, -1 = reversed, 0 = two-way.
function parseOneway(tags) {
    const v = tags.oneway;
    if (v === "yes" || v === "true" || v === "1") return 1;
    if (v === "-1" || v === "reverse") return -1;
    if (tags.highway === "motorway" || tags.junction === "roundabout") return v === "no" ? 0 : 1;
    return 0;
}

if (typeof module !== "undefined") {
    module.exports = { buildRoadNetwork, parseOneway };
}
