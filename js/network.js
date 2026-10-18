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
//   adjacency  Map<osmNodeId, edgeIndex[]>   (edges are undirected)
//   stats      { intersections, segments, totalMiles, ways }
// ==========================================================================

function buildRoadNetwork(osmData, region) {
    const points = new Map();   // every in-region OSM node: id -> { lat, lng }
    const runs = [];            // contiguous in-region stretches of each way
    const degree = new Map();   // number of distinct neighbours per node

    // 1. Clip ways to the region, splitting them where they leave it.
    for (const way of osmData.elements || []) {
        if (way.type !== "way" || !way.nodes || !way.geometry) continue;

        let run = null;
        for (let i = 0; i < way.nodes.length; i++) {
            const g = way.geometry[i];
            if (!g || !region.contains(g.lat, g.lon)) {
                if (run && run.ids.length > 1) runs.push(run);
                run = null;
                continue;
            }

            const id = way.nodes[i];
            if (!points.has(id)) points.set(id, { lat: g.lat, lng: g.lon });
            if (!run) run = { way, ids: [] };
            if (run.ids[run.ids.length - 1] !== id) run.ids.push(id);
        }
        if (run && run.ids.length > 1) runs.push(run);
    }

    // 2. Node degree, counting each neighbour once.
    const neighbours = new Map();
    const link = (a, b) => {
        if (!neighbours.has(a)) neighbours.set(a, new Set());
        neighbours.get(a).add(b);
    };
    for (const { ids } of runs) {
        for (let i = 1; i < ids.length; i++) {
            link(ids[i - 1], ids[i]);
            link(ids[i], ids[i - 1]);
        }
    }
    for (const [id, set] of neighbours) degree.set(id, set.size);

    // 3. Keep intersections, dead ends and run endpoints; collapse the rest.
    const nodes = new Map();
    const keep = (id) => {
        if (!nodes.has(id)) nodes.set(id, { id, ...points.get(id) });
    };
    for (const { ids } of runs) {
        keep(ids[0]);
        keep(ids[ids.length - 1]);
        for (const id of ids) if (degree.get(id) !== 2) keep(id);
    }

    const edges = [];
    let totalMeters = 0;

    for (const { way, ids } of runs) {
        const tags = way.tags || {};
        let start = ids[0];
        let prev = points.get(start);
        let coords = [[prev.lat, prev.lng]];
        let distance = 0;

        for (let i = 1; i < ids.length; i++) {
            const id = ids[i];
            const p = points.get(id);
            distance += haversine(prev.lat, prev.lng, p.lat, p.lng);
            coords.push([p.lat, p.lng]);
            prev = p;

            if (nodes.has(id)) {
                edges.push({
                    id: edges.length,
                    from: start,
                    to: id,
                    distance,
                    coords,
                    wayId: way.id,
                    highway: tags.highway,
                    name: tags.name || null,
                    oneway: parseOneway(tags)
                });
                totalMeters += distance;
                start = id;
                coords = [[p.lat, p.lng]];
                distance = 0;
            }
        }
    }

    const adjacency = new Map();
    const attach = (nodeId, edgeIndex) => {
        if (!adjacency.has(nodeId)) adjacency.set(nodeId, []);
        adjacency.get(nodeId).push(edgeIndex);
    };
    edges.forEach((edge, index) => {
        attach(edge.from, index);
        if (edge.to !== edge.from) attach(edge.to, index);
    });

    return {
        nodes,
        edges,
        adjacency,
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
