// ==========================================================================
// Road network builder
//
// Turns an Overpass response into a routing graph clipped to a region.
// Roads are joined at shared OSM node IDs, and chains of in-between points
// are collapsed into single edges, so the graph only contains intersections
// and dead ends. Each edge keeps its full geometry for drawing routes.
//
//   nodes      Map<osmNodeId, { id, lat, lng }>
//   edges      [{ id, from, to, distance, pts: [lat, lng, lat, lng, …],
//                 wayId, highway, name, oneway, restricted, level }]
//              (see edgeCoords)
//              (restricted: marked private or no entry on foot; level: a
//              bridge or tunnel)
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
        // (Ways from tiles carry their points as lats and lons arrays,
        // Overpass ways as geometry objects.)
        if (way.type !== "way" || !way.nodes || !(way.geometry || way.lats)) continue;

        let run = null;
        for (let i = 0; i < way.nodes.length; i++) {
            const g = way.geometry?.[i];
            const lat = g ? g.lat : way.lats?.[i], lon = g ? g.lon : way.lons?.[i];
            if (lat === undefined || !region.contains(lat, lon)) {
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
                lats.push(lat);
                lngs.push(lon);
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
        const restricted = tags.highway !== "motorway" && tags.highway !== "motorway_link" &&
            isRestricted(tags.access, tags.foot);
        const level = (tags.bridge !== undefined && tags.bridge !== "no") || (tags.tunnel !== undefined && tags.tunnel !== "no");
        let start = 0;
        let distance = 0;

        for (let i = 1; i < pts.length; i++) {
            const k = pts[i];
            distance += haversine(lats[pts[i - 1]], lngs[pts[i - 1]], lats[k], lngs[k]);

            if (kept[k]) {
                // (One flat array: far less memory than a small array per
                // point, or a typed array per edge.)
                const coords = [];
                for (let j = start; j <= i; j++) coords.push(lats[pts[j]], lngs[pts[j]]);
                edges.push({
                    id: edges.length,
                    from: ids[pts[start]],
                    to: ids[k],
                    distance,
                    pts: coords,
                    wayId: way.id,
                    highway: tags.highway || (tags.railway ? "railway" : undefined),
                    name: tags.name || null,
                    oneway: parseOneway(tags),
                    restricted,
                    level
                });
                totalMeters += distance;
                start = i;
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

// An edge's points as [[lat, lng], …].
function edgeCoords(edge) {
    const out = [];
    for (let i = 0; i < edge.pts.length; i += 2) out.push([edge.pts[i], edge.pts[i + 1]]);
    return out;
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
    module.exports = { buildRoadNetwork, parseOneway, edgeCoords };
}
