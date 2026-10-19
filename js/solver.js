// ==========================================================================
// Loop solver
//
// Finds a closed loop on the road network that encloses as much territory as
// possible. Two objectives are supported:
//
//   "start"  The loop must start at a start point and be no longer than
//            maxLengthM. Maximizes the enclosed area. If the start isn't on
//            a ring of streets (e.g. a dead-end street), the run goes out to
//            the nearest junction of the loop and back the same way (a
//            "lollipop"), and that stem counts twice toward the length.
//   "area"   No start point. Maximizes the isoperimetric quotient
//            (4π·area / length², 1 for a perfect circle) among loops that
//            cover at least `coverage` of a target shape. Ties go to the
//            loop enclosing more area.
//
// The road graph is first shrunk (prepareGraph): dead-end streets and the
// trees of streets hanging off them can never be part of a ring, so they
// are pruned, and the chains of roads left between junctions are merged
// into single edges. Its faces (the blocks between roads) are listed too
// (buildFaces).
//
// The search is an exact "angular sweep" (sweepLoop): pick a centre point
// and a junction s; among all loops through s that wind once around the
// centre, always moving forward in angle (loops that are star-shaped as
// seen from the centre, which the roundest loops are), find the best one.
// Sorting the junctions by angle turns this into a shortest-path-like
// dynamic program over (junction, length so far), which takes well under
// a second even for tens of thousands of junctions. The best loops are then
// polished block by block (FacePolish), which fixes what a sweep can't
// follow, such as winding streets. Different centres find different loops,
// so the search sweeps many centres, spread evenly with a low-discrepancy
// sequence and with every few sweeps re-centred on the best loop so far.
// Several searches run in parallel (one per Web Worker, see js/solve.js),
// each taking its share of the centres; the search ends once a number of
// sweeps in a row haven't found anything better (SearchTracker). The centre
// sequence is fixed, so the same search gives the same loop every time.
// ==========================================================================

const SOLVER = {
    // Loops are kept per length bucket (budget / lengthBuckets wide) at
    // every junction. Within a bucket the shorter path gets credit for the
    // area its spare length could still enclose (see sweepLoop), so a few
    // dozen buckets are about as good as exact lengths.
    lengthBuckets: 64,
    // Junction-bucket states at most, to bound memory on huge graphs
    // (fewer buckets are used on bigger graphs).
    maxStates: 3e6,
    // Angular bins used to measure coverage around a centre (area mode).
    coverageBins: 2048,
    coverageRows: 600,        // scanlines used by createCoverageMeter
    // Area mode: weights of covered area over any area tried by the sweep.
    // 0 just maximizes area for each length; higher values make the loop
    // follow the target more closely.
    coverageWeights: [0, 0.6, 1.5, 3, 6],
    // Area mode: weight of the "bigger is better" tiebreak between loops of
    // equal roundness. Small, so it only decides near-ties.
    areaTiebreak: 0.005,
    // Block-by-block polish (FacePolish) of sweep results that beat the
    // best sweep so far (area mode: or come within this share of it): at
    // most this many block flips, starting at this temperature (in
    // log-score units).
    polishWithin: 0.03,
    polishMoves: 100000,
    polishHeat: 0.005,
    // How hard the polish pushes toward the coverage target (exponent of
    // the shortfall; scoreLoop uses 6).
    polishShortfall: 40,
    // One in this many polish moves is a reroute (FacePolish.reroute),
    // whose path search gives up after this many steps.
    rerouteEvery: 20,
    reroutePops: 500,
    // Every this many sweeps, a search re-centres on its best loop so far.
    recentreEvery: 3,
    // Start mode: junctions within this distance (beyond the closest one)
    // are also tried as the place the loop is joined from the start.
    stemSlackM: 400,
    // The search ends after convergeSweeps + 4 × workers sweeps in a row
    // that improve the best loop by less than minGain (relative), and at
    // least half as many as it took to find it; see SearchTracker.
    convergeSweeps: 40,
    minGain: 0.001,
    // Improving a rough loop (SweepSearch.refine): rounds are whole passes
    // along the loop, so far fewer are needed.
    refineSweeps: 8,
    // What the search adds to a road's cost on top of its length (the
    // loop's real length and area are still what's shown): this many
    // meters per meter of climb along it with "prefer flatter loops", and
    // with "prefer smaller roads" this share of the length of big roads and
    // railroad tracks. In area
    // mode the cost counts as extra length (so as less roundness); in start
    // mode as lost area, as much as one more meter of loop would enclose,
    // so a loop in the hills isn't made shorter than the limit.
    climbCost: 3,
    bigRoadCost: {
        motorway: 0.08, motorway_link: 0.08, trunk: 0.08, trunk_link: 0.08, railway: 0.08,
        primary: 0.03, primary_link: 0.03
    },
    // "Avoid motorways" in the rough stage of a big search (see
    // searchStaged): motorways and trunk roads count as this much longer.
    avoidedRoadCost: 0.5,
    avoidedRoads: ["motorway", "motorway_link", "trunk", "trunk_link"],
    // Private stretches shorter than this aren't flagged (expandLoop).
    minPrivateM: 50
};

// --------------------------------------------------------------------------
// Graph preparation (main thread)
// --------------------------------------------------------------------------

// Shrinks the road network to the part that can carry a loop and packs it
// into typed arrays that can be sent to workers.
//
// Returns { data, ... } where `data` is the plain graph the search uses:
//   N, x, y                     junctions (local meters)
//   E, eFrom, eTo, eLen, eCross merged edges; eCross is the shoelace sum
//                               along the edge's road geometry
//   adjOff, adjEdge             adjacency lists
//   nStem                       start mode: distance from the start to each
//                               junction along the roads
//   lat0, lng0, kx, ky          the projection
//   startX, startY              start mode: the start node
//   faces                       the planar map and its faces (buildFaces)
//   ePen                        start mode: area lost to each merged edge's
//                               extra cost (see SOLVER.climbCost); also
//                               faces.pPen per piece. In area mode the
//                               extra cost is part of eLen and pLen.
// params.preferSmall: count big roads as a little longer (bigRoadCost).
// params.preferFlat: count the climb along roads as extra length (climbCost).
// params.avoidMotorways: count motorways as much longer (avoidedRoadCost).
// The rest (chains of original edges, stem paths) stays on the main thread
// to turn results back into road geometry (expandLoop).
function prepareGraph(network, params) {
    const ids = [...network.nodes.keys()];
    const index = new Map(ids.map((id, i) => [id, i]));
    const N = ids.length;

    // Local flat projection (meters) around the middle of the network.
    let minLat = Infinity, maxLat = -Infinity, minLng = Infinity, maxLng = -Infinity;
    for (const n of network.nodes.values()) {
        if (n.lat < minLat) minLat = n.lat;
        if (n.lat > maxLat) maxLat = n.lat;
        if (n.lng < minLng) minLng = n.lng;
        if (n.lng > maxLng) maxLng = n.lng;
    }
    const lat0 = (minLat + maxLat) / 2;
    const lng0 = (minLng + maxLng) / 2;
    const ky = DEG * EARTH_RADIUS_M;
    const kx = ky * Math.cos(lat0 * DEG);
    const project = (lat, lng) => ({ x: (lng - lng0) * kx, y: (lat - lat0) * ky });
    const unproject = (x, y) => ({ lat: y / ky + lat0, lng: x / kx + lng0 });

    const ox = new Float64Array(N);
    const oy = new Float64Array(N);
    ids.forEach((id, i) => {
        const n = network.nodes.get(id);
        ox[i] = (n.lng - lng0) * kx;
        oy[i] = (n.lat - lat0) * ky;
    });

    // Original edges (self-loops are dropped: they can't be part of a ring).
    const source = network.edges.filter(edge => edge.from !== edge.to && index.has(edge.from) && index.has(edge.to));
    const E0 = source.length;
    const oFrom = new Int32Array(E0);
    const oTo = new Int32Array(E0);
    const oLen = new Float64Array(E0);
    const oCross = new Float64Array(E0);
    const oExtra = new Float64Array(E0);   // extra cost, in meters
    source.forEach((edge, e) => {
        oFrom[e] = index.get(edge.from);
        oTo[e] = index.get(edge.to);
        oLen[e] = edge.distance;
        oExtra[e] = (params.preferFlat ? SOLVER.climbCost * (edge.climb || 0) : 0) +
            (params.preferSmall ? (SOLVER.bigRoadCost[edge.highway] || 0) * edge.distance : 0) +
            (params.avoidMotorways && SOLVER.avoidedRoads.includes(edge.highway) ? SOLVER.avoidedRoadCost * edge.distance : 0);
        let cross = 0;
        for (let i = 1; i < edge.coords.length; i++) {
            const [aLat, aLng] = edge.coords[i - 1];
            const [bLat, bLng] = edge.coords[i];
            const ax = (aLng - lng0) * kx, ay = (aLat - lat0) * ky;
            const bx = (bLng - lng0) * kx, by = (bLat - lat0) * ky;
            cross += ax * by - bx * ay;
        }
        oCross[e] = cross;
    });
    const { adjOff, adjEdge } = buildAdjacency(N, oFrom, oTo);
    const other = (e, u) => oFrom[e] === u ? oTo[e] : oFrom[e];

    const main = largestComponent({ N, eFrom: oFrom, eTo: oTo, adjOff, adjEdge });
    if (main.size < 3) throw new Error("The road network here is too small to make a loop.");

    // 1. Prune to the 2-core: repeatedly remove nodes with fewer than two
    //    streets. What's left is every junction a ring can pass through.
    const alive = Uint8Array.from(main);
    const deg = new Int32Array(N);
    for (let e = 0; e < E0; e++) {
        if (alive[oFrom[e]]) {
            deg[oFrom[e]]++;
            deg[oTo[e]]++;
        }
    }
    const stack = [];
    for (let i = 0; i < N; i++) if (alive[i] && deg[i] < 2) stack.push(i);
    while (stack.length) {
        const u = stack.pop();
        if (!alive[u]) continue;
        alive[u] = 0;
        for (let k = adjOff[u]; k < adjOff[u + 1]; k++) {
            const v = other(adjEdge[k], u);
            if (alive[v] && --deg[v] < 2) stack.push(v);
        }
    }

    // 2. Merge chains of two-street nodes into single edges between
    //    junctions. A chain that comes back to its own junction (a loop road
    //    hanging off one corner) or a ring with no junction at all is split
    //    at a middle node, so it can still be used.
    const isJunction = new Uint8Array(N);
    for (let i = 0; i < N; i++) if (alive[i] && deg[i] !== 2) isJunction[i] = 1;
    let chains;
    for (let pass = 0; ; pass++) {
        chains = [];
        const usedEdge = new Uint8Array(E0);
        const covered = new Uint8Array(N);
        for (let b = 0; b < N; b++) {
            if (!isJunction[b]) continue;
            covered[b] = 1;
            for (let k = adjOff[b]; k < adjOff[b + 1]; k++) {
                let e = adjEdge[k];
                if (usedEdge[e] || !alive[other(e, b)]) continue;
                const chain = { from: b, to: -1, edges: [], interior: [] };
                let at = b;
                for (;;) {
                    usedEdge[e] = 1;
                    chain.edges.push(e);
                    at = other(e, at);
                    if (isJunction[at]) break;
                    chain.interior.push(at);
                    covered[at] = 1;
                    let next = -1;
                    for (let j = adjOff[at]; j < adjOff[at + 1]; j++) {
                        const f = adjEdge[j];
                        if (f !== e && alive[other(f, at)]) next = f;
                    }
                    e = next;
                }
                chain.to = at;
                chains.push(chain);
            }
        }
        let split = false;
        for (const chain of chains) {
            if (chain.from === chain.to) {
                isJunction[chain.interior[chain.interior.length >> 1]] = 1;
                split = true;
            }
        }
        for (let i = 0; i < N; i++) {
            if (alive[i] && !covered[i]) {
                isJunction[i] = 1;   // a ring with no junction on it
                split = true;
                break;
            }
        }
        if (!split || pass > 6) break;
    }
    chains = chains.filter(c => c.from !== c.to);

    const cid = new Int32Array(N).fill(-1);
    const cOrig = [];
    for (let i = 0; i < N; i++) {
        if (isJunction[i] && alive[i]) {
            cid[i] = cOrig.length;
            cOrig.push(i);
        }
    }
    const M = cOrig.length;
    const E = chains.length;
    if (M < 2 || E < 2) throw new Error("There are no roads here that form a loop.");

    const x = new Float64Array(M);
    const y = new Float64Array(M);
    cOrig.forEach((i, c) => {
        x[c] = ox[i];
        y[c] = oy[i];
    });
    const eFrom = new Int32Array(E);
    const eTo = new Int32Array(E);
    const eLen = new Float64Array(E);
    const eCross = new Float64Array(E);
    const eExtra = new Float64Array(E);
    const chainOff = new Int32Array(E + 1);
    chains.forEach((chain, e) => {
        chainOff[e + 1] = chainOff[e] + chain.edges.length;
    });
    const chainEdge = new Int32Array(chainOff[E]);
    const chainDir = new Int8Array(chainOff[E]);
    chains.forEach((chain, e) => {
        eFrom[e] = cid[chain.from];
        eTo[e] = cid[chain.to];
        let at = chain.from;
        chain.edges.forEach((oe, k) => {
            const dir = oFrom[oe] === at ? 1 : -1;
            chainEdge[chainOff[e] + k] = oe;
            chainDir[chainOff[e] + k] = dir;
            eLen[e] += oLen[oe];
            eExtra[e] += oExtra[oe];
            eCross[e] += dir * oCross[oe];
            at = other(oe, at);
        });
    });
    const adjacency = buildAdjacency(M, eFrom, eTo);

    // 4. The blocks (faces) of the road map, for polishing loops block by
    //    block (FacePolish). Needs each merged edge's full road geometry.
    const lines = chains.map(chain => {
        const pts = [];
        let at = chain.from;
        for (const oe of chain.edges) {
            const coords = source[oe].coords;
            const forward = oFrom[oe] === at;
            for (let k = pts.length ? 1 : 0; k < coords.length; k++) {
                const [lat, lng] = coords[forward ? k : coords.length - 1 - k];
                pts.push((lng - lng0) * kx, (lat - lat0) * ky);
            }
            at = other(oe, at);
        }
        // Exact junction positions at both ends.
        pts[0] = ox[chain.from];
        pts[1] = oy[chain.from];
        pts[pts.length - 2] = ox[chain.to];
        pts[pts.length - 1] = oy[chain.to];
        return pts;
    });
    const targetXY = params.mode === "area" ? params.target.map(p => project(p.lat, p.lng)) : null;
    // Extra cost (SOLVER.climbCost): area mode, as length.
    const realLen = eLen.slice();
    if (params.mode === "area") for (let e = 0; e < E; e++) eLen[e] += eExtra[e];

    const data = {
        N: M, E, x, y, eFrom, eTo, eLen, eCross,
        adjOff: adjacency.adjOff, adjEdge: adjacency.adjEdge,
        nStem: null, ePen: null,
        lat0, lng0, kx, ky,
        faces: buildFaces(M, eFrom, eTo, eLen, lines, targetXY)
    };
    if (params.mode === "start") {
        // Start mode, as area: each meter costs what one more meter of a
        // round loop of the length limit would enclose.
        const perMeter = 0.8 * params.maxLengthM / (2 * Math.PI);
        const { P, pEdge, pLen } = data.faces;
        data.ePen = Float64Array.from(eExtra, extra => perMeter * extra);
        data.faces.pPen = Float64Array.from({ length: P }, (_, p) => realLen[pEdge[p]] > 0 ? data.ePen[pEdge[p]] * pLen[p] / realLen[pEdge[p]] : 0);
    }
    const prepared = {
        data, network, source, oFrom, oTo, chainOff, chainEdge, chainDir, cOrig, project, unproject,
        stats: { nodes: N, junctions: M, edges: E }
    };

    // 3. Start mode: shortest paths from the start (on the full network, so
    //    the start may be on a dead-end street) to every node within half
    //    the length limit.
    if (params.mode === "start") {
        const p = project(params.start.lat, params.start.lng);
        let startOrig = -1, bestD = Infinity;
        for (let i = 0; i < N; i++) {
            if (!main[i]) continue;
            const d = (ox[i] - p.x) ** 2 + (oy[i] - p.y) ** 2;
            if (d < bestD) {
                bestD = d;
                startOrig = i;
            }
        }
        const { dist, prevEdge } = shortestPaths(N, adjOff, adjEdge, oFrom, oTo, oLen, startOrig, params.maxLengthM / 2);
        data.nStem = Float64Array.from(cOrig, i => dist[i]);
        data.startX = ox[startOrig];
        data.startY = oy[startOrig];
        Object.assign(prepared, { startOrig, stemPrev: prevEdge });
    }
    return prepared;
}

function buildAdjacency(N, eFrom, eTo) {
    const E = eFrom.length;
    const adjOff = new Int32Array(N + 1);
    for (let e = 0; e < E; e++) {
        adjOff[eFrom[e] + 1]++;
        adjOff[eTo[e] + 1]++;
    }
    for (let i = 0; i < N; i++) adjOff[i + 1] += adjOff[i];
    const fill = adjOff.slice(0, N);
    const adjEdge = new Int32Array(2 * E);
    for (let e = 0; e < E; e++) {
        adjEdge[fill[eFrom[e]]++] = e;
        adjEdge[fill[eTo[e]]++] = e;
    }
    return { adjOff, adjEdge };
}

// Marks the nodes of the largest connected component.
function largestComponent(g) {
    const comp = new Int32Array(g.N).fill(-1);
    const queue = new Int32Array(g.N);
    let best = -1, bestSize = 0, label = 0;

    for (let s = 0; s < g.N; s++) {
        if (comp[s] !== -1) continue;
        let head = 0, tail = 0;
        queue[tail++] = s;
        comp[s] = label;
        while (head < tail) {
            const u = queue[head++];
            for (let k = g.adjOff[u]; k < g.adjOff[u + 1]; k++) {
                const e = g.adjEdge[k];
                const v = g.eFrom[e] === u ? g.eTo[e] : g.eFrom[e];
                if (comp[v] === -1) {
                    comp[v] = label;
                    queue[tail++] = v;
                }
            }
        }
        if (tail > bestSize) {
            bestSize = tail;
            best = label;
        }
        label++;
    }

    const main = new Uint8Array(g.N);
    for (let i = 0; i < g.N; i++) main[i] = comp[i] === best ? 1 : 0;
    main.size = bestSize;
    return main;
}

// The faces (blocks) of the road map. Roads that cross without a junction
// (bridges, tunnels) are first split at the crossing by a "virtual" vertex,
// so the map is planar; a loop may pass straight through a virtual vertex
// but not turn there. The pieces between vertices keep their order along
// their merged edge.
//
// lines[e]: merged edge e's road geometry, [x, y, x, y, …] from eFrom to eTo.
// target: area mode outline (local meters), to precompute how much of the
// target each face covers.
//
// Returns typed arrays (see FacePolish):
//   V, vX, vY             vertices: junctions 0…N−1, then virtual ones
//   P, pFrom, pTo, pLen   pieces
//   pCut, vCut            piece ends made by a split (bit 1: from, 2: to),
//                         and vertices that have such ends
//   pEdge                 merged edge of each piece; pieces of edge e are
//                         ePiece[eOff[e]…eOff[e+1]) in order from eFrom
//   vOff, vPiece          pieces at each vertex
//   F, hFace              faces; half-edge 2p runs along piece p, 2p+1 back,
//                         with face hFace[h] on its left
//   faceOff, faceHalf     half-edges around each face (counter-clockwise)
//   faceArea, faceOk      area; whether it can be part of a loop's inside
//   faceCover             area mode: target area inside each face
function buildFaces(N, eFrom, eTo, eLen, lines, target) {
    const E = lines.length;

    // 1. Crossings between segments of different edges (grid of cells). A
    //    road that crosses itself (a footpath or drive looping back over
    //    itself) would make the map non-planar, so its little loop is cut
    //    off at the crossing first (in the map only: a loop on it still
    //    follows the real road), and the crossings found again.
    let { cuts, vx, vy, tangled } = findCrossings(N, eFrom, eTo, lines);
    if (tangled.size) {
        for (const e of tangled) lines[e] = untangleLine(lines[e]);
        ({ cuts, vx, vy } = findCrossings(N, eFrom, eTo, lines));
    }
    const V = N + vx.length;

    // 2. Pieces. pCut marks piece ends made by a split (bit 1: from, 2: to):
    //    there the loop can only go straight on along the same road.
    const pFrom = [], pTo = [], pLen = [], pCross = [], pEdge = [], pLine = [], pCut = [];
    const eOff = new Int32Array(E + 1);
    for (let e = 0; e < E; e++) {
        eOff[e] = pFrom.length;
        const p = lines[e];
        const list = [];
        for (let k = 0; k < cuts[e].length; k += 2) list.push([cuts[e][k], cuts[e][k + 1]]);
        list.sort((a, b) => a[0] - b[0]);
        let from = eFrom[e], pts = [p[0], p[1]];
        let seg = 0, cutFrom = 0;
        const finish = (to, cutTo) => {
            let len = 0, cross = 0;
            for (let i = 0; i + 3 < pts.length; i += 2) {
                len += Math.hypot(pts[i + 2] - pts[i], pts[i + 3] - pts[i + 1]);
                cross += pts[i] * pts[i + 3] - pts[i + 2] * pts[i + 1];
            }
            pFrom.push(from);
            pTo.push(to);
            pLen.push(len);
            pCross.push(cross);
            pEdge.push(e);
            pLine.push(pts);
            pCut.push(cutFrom | cutTo);
        };
        for (const [pos, v] of list) {
            const i = Math.floor(pos), t = pos - i;
            while (seg < i) {
                seg++;
                pts.push(p[2 * seg], p[2 * seg + 1]);
            }
            const cx = p[2 * i] + t * (p[2 * i + 2] - p[2 * i]), cy = p[2 * i + 1] + t * (p[2 * i + 3] - p[2 * i + 1]);
            pts.push(cx, cy);
            finish(v, 2);
            from = v;
            cutFrom = 1;
            pts = [cx, cy];
        }
        while (seg < p.length / 2 - 1) {
            seg++;
            pts.push(p[2 * seg], p[2 * seg + 1]);
        }
        finish(eTo[e], 0);
        // Piece lengths add up to the edge's (geodesic) length.
        let flat = 0;
        for (let k = eOff[e]; k < pLen.length; k++) flat += pLen[k];
        for (let k = eOff[e]; k < pLen.length; k++) pLen[k] *= flat > 0 ? eLen[e] / flat : 0;
    }
    eOff[E] = pFrom.length;
    const P = pFrom.length;

    // 3. Pieces around each vertex, sorted by the direction they leave in.
    const vOff = new Int32Array(V + 1);
    for (let p = 0; p < P; p++) {
        vOff[pFrom[p] + 1]++;
        vOff[pTo[p] + 1]++;
    }
    for (let v = 0; v < V; v++) vOff[v + 1] += vOff[v];
    const fill = vOff.slice(0, V);
    const vHalf = new Int32Array(2 * P);   // outgoing half-edges per vertex
    const angle = new Float64Array(2 * P);
    for (let p = 0; p < P; p++) {
        // Direction to the first point that isn't the vertex itself.
        const pts = pLine[p], n = pts.length;
        let a = 2, b = n - 4;
        while (a < n - 2 && pts[a] === pts[0] && pts[a + 1] === pts[1]) a += 2;
        while (b > 0 && pts[b] === pts[n - 2] && pts[b + 1] === pts[n - 1]) b -= 2;
        angle[2 * p] = Math.atan2(pts[a + 1] - pts[1], pts[a] - pts[0]);
        angle[2 * p + 1] = Math.atan2(pts[b + 1] - pts[n - 1], pts[b] - pts[n - 2]);
        vHalf[fill[pFrom[p]]++] = 2 * p;
        vHalf[fill[pTo[p]]++] = 2 * p + 1;
    }
    const vPiece = vHalf.map(h => h >> 1);
    const origin = (h) => (h & 1 ? pTo[h >> 1] : pFrom[h >> 1]);

    // 4. A loop never leaves one 2-connected part of the map (where any
    //    two streets lie on a common ring), and in such a part every face
    //    is a simple ring. So faces are traced within each part: a street
    //    hanging off a block by a single road (and everything beyond it)
    //    simply lies inside that block.
    const comp = biconnectedParts(V, P, pFrom, pTo, vOff, vPiece);

    // Around each vertex: by part, then by direction.
    const groupStart = new Int32Array(2 * P), groupSize = new Int32Array(2 * P), pos = new Int32Array(2 * P);
    for (let v = 0; v < V; v++) {
        // Pieces leaving in exactly the same direction (duplicate roads
        // drawn on top of each other) are ordered one way at one end and the
        // other way at the other, so they enclose an empty sliver.
        const tie = (h) => (h & 1 ? -1 : 1) * (h >> 1);
        const list = Array.from(vHalf.subarray(vOff[v], vOff[v + 1]))
            .sort((a, b) => comp[a >> 1] - comp[b >> 1] || angle[a] - angle[b] || tie(a) - tie(b));
        let start = 0;
        list.forEach((h, i) => {
            vHalf[vOff[v] + i] = h;
            if (i > 0 && comp[h >> 1] !== comp[list[i - 1] >> 1]) start = i;
            groupStart[h] = start;
            pos[h] = i;
        });
        for (let i = list.length - 1, end = list.length; i >= 0; i--) {
            const h = list[i];
            groupSize[h] = end - groupStart[h];
            if (pos[h] === groupStart[h]) end = groupStart[h];
        }
    }

    // 5. Trace faces: after arriving at a vertex, leave by the next street
    //    of the same part clockwise from the one arrived on, keeping the
    //    face on the left.
    const hFace = new Int32Array(2 * P).fill(-1);
    const faceOff = [0], faceHalf = [], faceArea = [];
    for (let h0 = 0; h0 < 2 * P; h0++) {
        if (hFace[h0] !== -1) continue;
        const f = faceArea.length;
        let cross = 0, h = h0;
        do {
            hFace[h] = f;
            faceHalf.push(h);
            cross += h & 1 ? -pCross[h >> 1] : pCross[h >> 1];
            const t = h ^ 1;
            const v = origin(t);
            const g0 = groupStart[t], d = groupSize[t];
            h = vHalf[vOff[v] + g0 + (pos[t] - g0 - 1 + d) % d];
        } while (h !== h0);
        faceArea.push(cross / 2);
        faceOff.push(faceHalf.length);
    }
    const F = faceArea.length;

    // A face can be inside a loop if it is a proper block: not the outside
    // (negative area; slivers between duplicate roads have none) and no
    // vertex visited twice.
    const faceOk = new Uint8Array(F);
    const seen = new Int32Array(V).fill(-1);
    for (let f = 0; f < F; f++) {
        if (faceArea[f] < 0) continue;
        let simple = true;
        for (let k = faceOff[f]; k < faceOff[f + 1] && simple; k++) {
            const v = origin(faceHalf[k]);
            if (seen[v] === f) simple = false;
            seen[v] = f;
        }
        faceOk[f] = simple ? 1 : 0;
    }

    const vX = new Float64Array(V), vY = new Float64Array(V);
    for (let p = 0; p < P; p++) {
        const pts = pLine[p];
        vX[pFrom[p]] = pts[0];
        vY[pFrom[p]] = pts[1];
        vX[pTo[p]] = pts[pts.length - 2];
        vY[pTo[p]] = pts[pts.length - 1];
    }

    const vCut = new Uint8Array(V);
    for (let p = 0; p < P; p++) {
        if (pCut[p] & 1) vCut[pFrom[p]] = 1;
        if (pCut[p] & 2) vCut[pTo[p]] = 1;
    }

    const faces = {
        V, vX, vY, vCut, P, pFrom: Int32Array.from(pFrom), pTo: Int32Array.from(pTo), pLen: Float64Array.from(pLen),
        pCut: Uint8Array.from(pCut), pCross: Float64Array.from(pCross),
        pEdge: Int32Array.from(pEdge), eOff, vOff, vPiece,
        F, hFace, faceOff: Int32Array.from(faceOff), faceHalf: Int32Array.from(faceHalf),
        faceArea: Float64Array.from(faceArea), faceOk, faceCover: null
    };
    if (target) faces.faceCover = faceCoverage(faces, pLine, target);
    return faces;
}

// Crossings between the lines of different edges, as cuts per edge
// ([position along the line, vertex], …) and new "virtual" vertices
// (numbered from N) at proper crossings; and the edges that cross
// themselves.
function findCrossings(N, eFrom, eTo, lines) {
    const E = lines.length;
    const CELL = 100;
    const grid = new Map();
    for (let e = 0; e < E; e++) {
        const p = lines[e];
        for (let i = 0; i + 3 < p.length; i += 2) {
            const x0 = Math.floor(Math.min(p[i], p[i + 2]) / CELL), x1 = Math.floor(Math.max(p[i], p[i + 2]) / CELL);
            const y0 = Math.floor(Math.min(p[i + 1], p[i + 3]) / CELL), y1 = Math.floor(Math.max(p[i + 1], p[i + 3]) / CELL);
            for (let cx = x0; cx <= x1; cx++) {
                for (let cy = y0; cy <= y1; cy++) {
                    const key = cx * 65536 + cy;
                    let cell = grid.get(key);
                    if (!cell) grid.set(key, cell = []);
                    cell.push(e, i);
                }
            }
        }
    }
    const cuts = Array.from({ length: E }, () => []);   // [position, vertex]
    const vx = [], vy = [];
    const tangled = new Set();
    const seenCut = new Set();
    for (const [key, cell] of grid) {
        for (let a = 0; a < cell.length; a += 2) {
            const ea = cell[a], ia = cell[a + 1], pa = lines[ea];
            const ax = pa[ia], ay = pa[ia + 1], rx = pa[ia + 2] - ax, ry = pa[ia + 3] - ay;
            for (let b = a + 2; b < cell.length; b += 2) {
                const eb = cell[b];
                if (eb === ea) {
                    // Non-adjacent segments of one line crossing.
                    const ib = cell[b + 1];
                    if (Math.abs(ib - ia) > 2 && !tangled.has(ea) && segmentsCross(pa, ia, ib)) tangled.add(ea);
                    continue;
                }
                const ib = cell[b + 1], pb = lines[eb];
                const bx = pb[ib], by = pb[ib + 1], sx = pb[ib + 2] - bx, sy = pb[ib + 3] - by;
                const den = rx * sy - ry * sx;
                if (den === 0) continue;
                const t = ((bx - ax) * sy - (by - ay) * sx) / den;
                const u = ((bx - ax) * ry - (by - ay) * rx) / den;
                if (t < 0 || t > 1 || u < 0 || u > 1) continue;
                const px = ax + t * rx, py = ay + t * ry;
                // Count each crossing once: in the cell that holds it.
                if (Math.floor(px / CELL) * 65536 + Math.floor(py / CELL) !== key) continue;
                const posA = ia / 2 + t, posB = ib / 2 + u;
                const endA = posA < 1e-6 ? eFrom[ea] : posA > pa.length / 2 - 1 - 1e-6 ? eTo[ea] : -1;
                const endB = posB < 1e-6 ? eFrom[eb] : posB > pb.length / 2 - 1 - 1e-6 ? eTo[eb] : -1;
                if (endA >= 0 && endB >= 0) continue;   // junctions of both
                // Also found from the neighbouring segment if it's at a
                // vertex of the road's geometry.
                const id = `${Math.min(ea, eb)},${Math.max(ea, eb)},${px.toFixed(2)},${py.toFixed(2)}`;
                if (seenCut.has(id)) continue;
                seenCut.add(id);
                if (endA >= 0 || endB >= 0) {
                    // One road runs over a junction of the other (e.g. a
                    // bridge right above a crossroads): split it there.
                    if (endB >= 0) cuts[ea].push(posA, endB);
                    else cuts[eb].push(posB, endA);
                    continue;
                }
                const v = N + vx.length;
                vx.push(px);
                vy.push(py);
                cuts[ea].push(posA, v);
                cuts[eb].push(posB, v);
            }
        }
    }
    return { cuts, vx, vy, tangled };
}

// Whether segments i and j (indices into the flat [x, y, …] line p) cross
// at a point inside both.
function segmentsCross(p, i, j) {
    const ax = p[i], ay = p[i + 1], rx = p[i + 2] - ax, ry = p[i + 3] - ay;
    const bx = p[j], by = p[j + 1], sx = p[j + 2] - bx, sy = p[j + 3] - by;
    const den = rx * sy - ry * sx;
    if (den === 0) return false;
    const t = ((bx - ax) * sy - (by - ay) * sx) / den;
    const u = ((bx - ax) * ry - (by - ay) * rx) / den;
    return t > 0 && t < 1 && u > 0 && u < 1;
}

// A line that crosses itself, with each loop it makes cut off at the
// crossing.
function untangleLine(p) {
    let pts = p.slice();
    for (let changed = true; changed;) {
        changed = false;
        search: for (let i = 0; i + 3 < pts.length; i += 2) {
            for (let j = i + 4; j + 3 < pts.length; j += 2) {
                if (!segmentsCross(pts, i, j)) continue;
                const ax = pts[i], ay = pts[i + 1], rx = pts[i + 2] - ax, ry = pts[i + 3] - ay;
                const sx = pts[j + 2] - pts[j], sy = pts[j + 3] - pts[j + 1];
                const t = ((pts[j] - ax) * sy - (pts[j + 1] - ay) * sx) / (rx * sy - ry * sx);
                pts = [...pts.slice(0, i + 2), ax + t * rx, ay + t * ry, ...pts.slice(j + 2)];
                changed = true;
                break search;
            }
        }
    }
    return pts;
}

// Biconnected components of a multigraph (Tarjan, iterative): returns the
// component of each edge. Edges that are bridges get a component of their own.
function biconnectedParts(V, P, eFrom, eTo, vOff, vEdge) {
    const comp = new Int32Array(P).fill(-1);
    const disc = new Int32Array(V).fill(-1);
    const low = new Int32Array(V);
    const next = new Int32Array(V);       // adjacency cursor per vertex
    const parentEdge = new Int32Array(V).fill(-1);
    const edgeStack = [], stack = [];
    const usedEdge = new Uint8Array(P);
    let time = 0, parts = 0;
    for (let root = 0; root < V; root++) {
        if (disc[root] !== -1) continue;
        disc[root] = low[root] = time++;
        next[root] = vOff[root];
        stack.push(root);
        while (stack.length) {
            const u = stack[stack.length - 1];
            if (next[u] < vOff[u + 1]) {
                const e = vEdge[next[u]++];
                if (usedEdge[e]) continue;
                usedEdge[e] = 1;
                const w = eFrom[e] === u ? eTo[e] : eFrom[e];
                edgeStack.push(e);
                if (disc[w] === -1) {
                    disc[w] = low[w] = time++;
                    next[w] = vOff[w];
                    parentEdge[w] = e;
                    stack.push(w);
                } else if (disc[w] < low[u]) {
                    low[u] = disc[w];
                }
            } else {
                stack.pop();
                const pe = parentEdge[u];
                if (pe < 0) continue;
                const p = eFrom[pe] === u ? eTo[pe] : eFrom[pe];
                if (low[u] < low[p]) low[p] = low[u];
                if (low[u] >= disc[p]) {
                    // p separates u's subtree: pop its edges as one part.
                    let e;
                    do {
                        e = edgeStack.pop();
                        comp[e] = parts;
                    } while (e !== pe);
                    parts++;
                }
            }
        }
    }
    return comp;
}

// Target area inside each face, by scanlines shared by all faces (so that
// the faces inside a loop add up to the scanline measure of the loop).
function faceCoverage(faces, pLine, target) {
    const { F, faceOff, faceHalf, faceOk } = faces;
    let minY = Infinity, maxY = -Infinity;
    for (const p of target) {
        minY = Math.min(minY, p.y);
        maxY = Math.max(maxY, p.y);
    }
    const rows = 600;
    const dy = (maxY - minY) / rows;
    const rowY = (r) => minY + (r + 0.5) * dy;
    const crossings = (xs, ys, visit) => {
        const n = xs.length;
        for (let i = 0; i < n; i++) {
            const ax = xs[i], ay = ys[i], bx = xs[(i + 1) % n], by = ys[(i + 1) % n];
            if (ay === by) continue;
            const r0 = Math.max(0, Math.ceil((Math.min(ay, by) - minY) / dy - 0.5));
            const r1 = Math.min(rows - 1, Math.ceil((Math.max(ay, by) - minY) / dy - 0.5) - 1);
            for (let r = r0; r <= r1; r++) visit(r, ax + (rowY(r) - ay) * (bx - ax) / (by - ay));
        }
    };
    const targetRows = Array.from({ length: rows }, () => []);
    crossings(target.map(p => p.x), target.map(p => p.y), (r, x) => targetRows[r].push(x));
    for (const row of targetRows) row.sort((a, b) => a - b);

    const cover = new Float64Array(F);
    const byRow = new Map();
    for (let f = 0; f < F; f++) {
        if (!faceOk[f]) continue;
        const xs = [], ys = [];
        for (let k = faceOff[f]; k < faceOff[f + 1]; k++) {
            const h = faceHalf[k], pts = pLine[h >> 1], n = pts.length / 2;
            for (let i = 0; i < n - 1; i++) {
                const j = h & 1 ? n - 1 - i : i;
                xs.push(pts[2 * j]);
                ys.push(pts[2 * j + 1]);
            }
        }
        byRow.clear();
        crossings(xs, ys, (r, x) => {
            let list = byRow.get(r);
            if (!list) byRow.set(r, list = []);
            list.push(x);
        });
        let covered = 0;
        for (const [r, list] of byRow) {
            const tgt = targetRows[r];
            if (list.length < 2 || tgt.length < 2) continue;
            list.sort((a, b) => a - b);
            let i = 0, j = 0;
            while (i + 1 < list.length && j + 1 < tgt.length) {
                const lo = Math.max(list[i], tgt[j]), hi = Math.min(list[i + 1], tgt[j + 1]);
                if (hi > lo) covered += hi - lo;
                if (list[i + 1] < tgt[j + 1]) i += 2;
                else j += 2;
            }
        }
        cover[f] = covered * dy;
    }
    return cover;
}

// Dijkstra from `src`, stopping at distance `limit`.
function shortestPaths(N, adjOff, adjEdge, eFrom, eTo, eLen, src, limit) {
    const dist = new Float64Array(N).fill(Infinity);
    const prevEdge = new Int32Array(N).fill(-1);
    const heap = new MinHeap(1024);
    dist[src] = 0;
    heap.push(0, src);
    while (heap.size > 0) {
        const d = heap.keys[0];
        const u = heap.pop();
        if (d > dist[u]) continue;
        for (let k = adjOff[u]; k < adjOff[u + 1]; k++) {
            const e = adjEdge[k];
            const v = eFrom[e] === u ? eTo[e] : eFrom[e];
            const c = d + eLen[e];
            if (c < dist[v] && c <= limit) {
                dist[v] = c;
                prevEdge[v] = e;
                heap.push(c, v);
            }
        }
    }
    return { dist, prevEdge };
}

class MinHeap {
    constructor(capacity) {
        this.keys = new Float64Array(capacity);
        this.vals = new Int32Array(capacity);
        this.size = 0;
    }

    push(key, val) {
        if (this.size === this.keys.length) {
            const keys = new Float64Array(this.size * 2);
            const vals = new Int32Array(this.size * 2);
            keys.set(this.keys);
            vals.set(this.vals);
            this.keys = keys;
            this.vals = vals;
        }
        let i = this.size++;
        while (i > 0) {
            const parent = (i - 1) >> 1;
            if (this.keys[parent] <= key) break;
            this.keys[i] = this.keys[parent];
            this.vals[i] = this.vals[parent];
            i = parent;
        }
        this.keys[i] = key;
        this.vals[i] = val;
    }

    pop() {
        const top = this.vals[0];
        const key = this.keys[--this.size];
        const val = this.vals[this.size];
        let i = 0;
        for (;;) {
            let child = 2 * i + 1;
            if (child >= this.size) break;
            if (child + 1 < this.size && this.keys[child + 1] < this.keys[child]) child++;
            if (this.keys[child] >= key) break;
            this.keys[i] = this.keys[child];
            this.vals[i] = this.vals[child];
            i = child;
        }
        this.keys[i] = key;
        this.vals[i] = val;
        return top;
    }
}

// Nearest junction to (px, py), optionally only among junctions where
// allowed(n) is true. Linear scan: called a few times per sweep at most.
function nearestJunction(g, px, py, allowed) {
    let best = -1, bestD = Infinity;
    for (let n = 0; n < g.N; n++) {
        const d = (g.x[n] - px) ** 2 + (g.y[n] - py) ** 2;
        if (d < bestD && (!allowed || allowed(n))) {
            bestD = d;
            best = n;
        }
    }
    return best;
}

// The same for many points: junctions by grid cell, searched outward from
// the point's cell. Returns nearest(px, py).
function junctionFinder(g) {
    const { N, x, y } = g;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let n = 0; n < N; n++) {
        minX = Math.min(minX, x[n]);
        maxX = Math.max(maxX, x[n]);
        minY = Math.min(minY, y[n]);
        maxY = Math.max(maxY, y[n]);
    }
    // About two junctions per cell.
    const cell = Math.max(1, Math.sqrt((maxX - minX) * (maxY - minY) / Math.max(1, N) * 2));
    const W = Math.floor((maxX - minX) / cell) + 1, H = Math.floor((maxY - minY) / cell) + 1;
    const cellOf = (n) => Math.floor((y[n] - minY) / cell) * W + Math.floor((x[n] - minX) / cell);
    const off = new Int32Array(W * H + 1);
    for (let n = 0; n < N; n++) off[cellOf(n) + 1]++;
    for (let c = 0; c < W * H; c++) off[c + 1] += off[c];
    const fill = off.slice(0, W * H), list = new Int32Array(N);
    for (let n = 0; n < N; n++) list[fill[cellOf(n)]++] = n;
    return (px, py) => {
        const cx = Math.min(W - 1, Math.max(0, Math.floor((px - minX) / cell)));
        const cy = Math.min(H - 1, Math.max(0, Math.floor((py - minY) / cell)));
        let best = -1, bestD = Infinity;
        for (let r = 0; r <= Math.max(W, H); r++) {
            // Cells r rings out are at least (r − 1) cells away.
            if (best >= 0 && ((r - 1) * cell) ** 2 > bestD) break;
            for (let gy = cy - r; gy <= cy + r; gy++) {
                if (gy < 0 || gy >= H) continue;
                const edge = gy === cy - r || gy === cy + r;
                for (let gx = cx - r; gx <= cx + r; gx += edge ? 1 : 2 * r) {
                    if (gx < 0 || gx >= W) continue;
                    const c = gy * W + gx;
                    for (let k = off[c]; k < off[c + 1]; k++) {
                        const n = list[k];
                        const d = (x[n] - px) ** 2 + (y[n] - py) ** 2;
                        if (d < bestD) {
                            bestD = d;
                            best = n;
                        }
                    }
                    if (r === 0) break;
                }
            }
        }
        return best;
    };
}

// --------------------------------------------------------------------------
// Coverage: fraction of a target polygon enclosed by the loop.
// Scanline integration with the even-odd rule, so the target can be any
// simple polygon (convex or not) and the loop any closed outline.
// --------------------------------------------------------------------------

function createCoverageMeter(target) {
    const rows = SOLVER.coverageRows;
    let minY = Infinity, maxY = -Infinity;
    for (const p of target) {
        minY = Math.min(minY, p.y);
        maxY = Math.max(maxY, p.y);
    }
    const dy = (maxY - minY) / rows;

    // The target's inside intervals on each scanline: [x0, x1, x2, x3, …].
    const targetRows = Array.from({ length: rows }, () => []);
    eachCrossing(target.map(p => p.x), target.map(p => p.y), minY, dy, rows, (r, x) => targetRows[r].push(x));
    let targetArea = 0;
    for (const row of targetRows) {
        row.sort((a, b) => a - b);
        for (let i = 0; i + 1 < row.length; i += 2) targetArea += (row[i + 1] - row[i]) * dy;
    }

    const buckets = Array.from({ length: rows }, () => []);

    return {
        targetArea,
        measure(xs, ys) {
            for (const b of buckets) b.length = 0;
            eachCrossing(xs, ys, minY, dy, rows, (r, x) => buckets[r].push(x));
            let covered = 0;
            for (let r = 0; r < rows; r++) {
                const loop = buckets[r];
                const tgt = targetRows[r];
                if (loop.length < 2 || tgt.length < 2) continue;
                loop.sort((a, c) => a - c);
                // Overlap of two sorted interval lists.
                let i = 0, j = 0;
                while (i + 1 < loop.length && j + 1 < tgt.length) {
                    const lo = Math.max(loop[i], tgt[j]);
                    const hi = Math.min(loop[i + 1], tgt[j + 1]);
                    if (hi > lo) covered += hi - lo;
                    if (loop[i + 1] < tgt[j + 1]) i += 2;
                    else j += 2;
                }
            }
            return targetArea > 0 ? covered * dy / targetArea : 0;
        }
    };

    function eachCrossing(xs, ys, y0, step, count, visit) {
        const n = xs.length;
        for (let i = 0; i < n; i++) {
            const ax = xs[i], ay = ys[i];
            const bx = xs[(i + 1) % n], by = ys[(i + 1) % n];
            if (ay === by) continue;
            const lo = Math.min(ay, by), hi = Math.max(ay, by);
            const r0 = Math.max(0, Math.ceil((lo - y0) / step - 0.5));
            const r1 = Math.min(count - 1, Math.ceil((hi - y0) / step - 0.5) - 1);
            for (let r = r0; r <= r1; r++) {
                const yy = y0 + (r + 0.5) * step;
                visit(r, ax + (yy - ay) * (bx - ax) / (by - ay));
            }
        }
    }
}

// The target as seen from a centre: for each of `bins` equal angular
// sectors (starting at angle theta0), the stretches of the sector's middle
// ray that are inside the target. covered(bin, r) is then the target area
// in that sector within distance r of the centre.
function polarTarget(target, cx, cy, theta0, bins) {
    const step = 2 * Math.PI / bins;
    const hits = Array.from({ length: bins }, () => []);
    const n = target.length;
    for (let i = 0; i < n; i++) {
        const a = target[i], b = target[(i + 1) % n];
        let ta = Math.atan2(a.y - cy, a.x - cx) - theta0;
        let tb = Math.atan2(b.y - cy, b.x - cx) - theta0;
        ta = ((ta % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
        tb = ((tb % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
        let lo = Math.min(ta, tb), hi = Math.max(ta, tb);
        const wraps = hi - lo > Math.PI;
        const ranges = wraps ? [[hi, 2 * Math.PI], [0, lo]] : [[lo, hi]];
        for (const [r0, r1] of ranges) {
            for (let k = Math.ceil(r0 / step - 0.5); k + 0.5 < r1 / step; k++) {
                const phi = (k + 0.5) * step + theta0;
                const dx = Math.cos(phi), dy = Math.sin(phi);
                const ex = b.x - a.x, ey = b.y - a.y;
                const den = dx * ey - dy * ex;
                if (den === 0) continue;
                const t = ((a.x - cx) * ey - (a.y - cy) * ex) / den;
                if (t > 0) hits[(k + bins) % bins].push(t);
            }
        }
    }
    const off = new Int32Array(bins + 1);
    hits.forEach((h, k) => {
        h.sort((p, q) => p - q);
        // An odd number of crossings: the centre itself is inside.
        if (h.length % 2 === 1) h.unshift(0);
        off[k + 1] = off[k] + h.length;
    });
    const radii = new Float64Array(off[bins]);
    hits.forEach((h, k) => {
        for (let i = 0; i < h.length; i++) radii[off[k] + i] = h[i];
    });
    const half = step / 2;
    return {
        step,
        bins,
        covered(k, r) {
            let sum = 0;
            for (let i = off[k]; i < off[k + 1]; i += 2) {
                const r0 = radii[i];
                if (r <= r0) break;
                const r1 = Math.min(r, radii[i + 1]);
                sum += r1 * r1 - r0 * r0;
            }
            return sum * half;
        }
    };
}

// --------------------------------------------------------------------------
// Scoring
// --------------------------------------------------------------------------

// objective:
//   mode        "start" | "area"
//   maxLengthM  (start)  the loop may not be longer
//   coverage    (area)   0..1 share of the target the loop must enclose
//   targetArea  (area)   m², for the tiebreak
// metrics: { length, area, repeats, coverage? }
//
// Start mode: score = area. Area mode: score = isoperimetric quotient, with
// a small bonus for enclosing more area, so that of two equally round loops
// the bigger one wins. Unmet requirements shrink the score steeply instead of
// ruling the loop out, so the best loop so far can be shown even if none
// meets them.
function scoreLoop(metrics, objective) {
    const repeatFactor = 0.8 ** metrics.repeats;
    if (objective.mode === "start") {
        const over = metrics.length / objective.maxLengthM;
        return {
            score: metrics.area * (over > 1 ? over ** -10 : 1) * repeatFactor,
            feasible: over <= 1 && metrics.repeats === 0
        };
    }
    const iq = 4 * Math.PI * metrics.area / metrics.length ** 2;
    const short = metrics.coverage / objective.coverage;
    const sizeBonus = SOLVER.areaTiebreak * Math.min(metrics.area / objective.targetArea, 2);
    return {
        score: (iq + sizeBonus) * (short < 1 ? short ** 6 : 1) * repeatFactor,
        feasible: short >= 1 && metrics.repeats === 0
    };
}

// --------------------------------------------------------------------------
// Angular sweep
// --------------------------------------------------------------------------

// The best loop through junction s that winds once counter-clockwise around
// the centre (cx, cy), with every street moving forward in angle as seen
// from the centre, and at most `budget` long.
//
// Junctions are sorted by angle (s first); a path can then only go from a
// junction to a later one, so the paths from s form a DAG and can be
// extended in sorted order. Each junction keeps, per length bucket, the
// path from s with the highest weight
//     area + mu × covered area − lambda × length
// (area is the area swept from the centre; lambda credits shorter paths
// with the area their spare length could enclose). Every path that gets
// back to s is a loop; it is measured with close(area, covered, length) →
// { score, feasible }, and the best one is returned:
//   { edges, dirs, area, covered, length, score, feasible } or null.
//
// opts: { K, mu, lambda, target (polarTarget, area mode), close,
//         order, period (go forward along a reference loop instead),
//         end, endAng, theta0 (with order: the best path from s to end
//         instead of a loop; close() gets its totals) }
// scratch: reusable buffers (one object per search).
function sweepLoop(g, s, cx, cy, budget, opts, scratch) {
    // The planar map of buildFaces: a road crossing another without a
    // junction meets it at a vertex the loop can pass only once, straight
    // on, so loops never cross themselves.
    const { V, vX: x, vY: y, vOff, vPiece, vCut, pFrom, pTo, pLen, pCross, pEdge, pCut, pPen } = g.faces;
    const TWO_PI = 2 * Math.PI;
    const theta0 = opts.theta0 ?? Math.atan2(y[s] - cy, x[s] - cx);
    const end = opts.end ?? -1;
    if (!scratch.ang || scratch.ang.length < V) {
        const slots = vOff[V];
        Object.assign(scratch, {
            ang: new Float64Array(V), rank: new Int32Array(V).fill(-1), sel: new Int32Array(V), selCount: 0,
            fOff: new Int32Array(V + 1), dS: new Float32Array(V + 1),
            fTo: new Int32Array(slots), fLen: new Float32Array(slots), fArea: new Float32Array(slots),
            fCov: new Float32Array(slots), fHalf: new Int32Array(slots), fGroup: new Int8Array(slots)
        });
    }
    const { ang, rank, fOff, dS, fTo, fLen, fArea, fCov, fHalf, fGroup } = scratch;
    const order = opts.order;

    // Vertices that can be on a loop through s of this length, by angle
    // (a path to `end`: the vertices between s and end; opts.candidates, if
    // given, lists all that might be, s first).
    for (let i = 0; i < scratch.selCount; i++) rank[scratch.sel[i]] = -1;
    const half = end >= 0 ? budget : budget / 2;
    const candidates = opts.candidates;
    const count = candidates ? candidates.length : V;
    const sel = [];
    for (let c = 0; c < count; c++) {
        const v = candidates ? candidates[c] : c;
        const dx = x[v] - x[s], dy = y[v] - y[s];
        if (v !== s && dx * dx + dy * dy > half * half) continue;
        // The angle around the centre, or (opts.order) the position along a
        // reference loop.
        let a = order ? (order[v] - order[s]) / opts.period * TWO_PI : Math.atan2(y[v] - cy, x[v] - cx) - theta0;
        a %= TWO_PI;
        if (a < 0) a += TWO_PI;
        if (end >= 0 && v !== s && (v === end || a >= opts.endAng)) continue;
        ang[v] = v === s ? 0 : a;
        sel.push(v);
    }
    sortByKey(sel, ang, V);
    const M = sel.length;
    for (let i = 0; i < M; i++) {
        rank[sel[i]] = i;
        scratch.sel[i] = sel[i];
    }
    scratch.selCount = M;

    // Piece end at vertex v made by a split: the loop must go straight on.
    const cutEnd = (piece, v) => (pFrom[piece] === v ? pCut[piece] & 1 : pCut[piece] & 2) !== 0;
    // Arriving at a split vertex, the way on depends on the way in: paths
    // that arrive along different roads are kept apart (group 0: an ordinary
    // street, 1 and 2: the two roads split there).
    const groupAt = (piece, v) => {
        if (!cutEnd(piece, v)) return 0;
        for (let j = vOff[v]; j < vOff[v + 1]; j++) {
            if (cutEnd(vPiece[j], v)) return pEdge[vPiece[j]] === pEdge[piece] ? 1 : 2;
        }
        return 1;
    };

    // Forward pieces in rank order, with their length, swept area and
    // covered area. Rank M stands for "back at s".
    const { target, mu = 0 } = opts;
    let n = 0;
    for (let i = 0; i < M; i++) {
        fOff[i] = n;
        const v = sel[i];
        const home = end >= 0 ? end : s;
        dS[i] = Math.hypot(x[v] - x[home], y[v] - y[home]);
        for (let j = vOff[v]; j < vOff[v + 1]; j++) {
            const p = vPiece[j];
            const forward = pFrom[p] === v;
            const w = forward ? pTo[p] : pFrom[p];
            let r = rank[w];
            if (w === end) {
                r = M;
            } else if (r < 0) {
                continue;
            } else if (w === s) {
                if (end >= 0 || i === 0 || ang[v] < Math.PI) continue;
                r = M;
            } else if (r <= i || ang[w] - ang[v] >= Math.PI) {
                continue;
            }
            fTo[n] = r;
            fLen[n] = pLen[p];
            // Shoelace sum relative to the centre.
            // (Start mode: less the area lost to the piece's extra cost.)
            fArea[n] = ((forward ? pCross[p] : -pCross[p]) - (cx * (y[w] - y[v]) - cy * (x[w] - x[v]))) / 2 - (pPen ? pPen[p] : 0);
            fCov[n] = target ? fanCover(target, x[v] - cx, y[v] - cy, x[w] - cx, y[w] - cy, theta0) : 0;
            fHalf[n] = 2 * p + (forward ? 0 : 1);
            fGroup[n] = vCut[w] && r < M ? groupAt(p, w) : -1;
            n++;
        }
    }
    fOff[M] = n;
    dS[M] = 0;

    // States: per vertex rank and length bucket, [area, covered, length].
    // A split vertex has a row of buckets per group (see groupAt), others one.
    const rowStart = scratch.rowStart && scratch.rowStart.length > M ? scratch.rowStart : (scratch.rowStart = new Int32Array(V + 1));
    let rows = 0;
    for (let i = 0; i < M; i++) {
        rowStart[i] = rows;
        rows += vCut[sel[i]] && i > 0 ? 3 : 1;
    }
    rowStart[M] = rows;
    const K = Math.max(8, Math.min(opts.K, Math.floor(SOLVER.maxStates / Math.max(1, rows))));
    const size = rows * K;
    if (!scratch.st || scratch.st.length < 3 * size) {
        scratch.st = new Float32Array(3 * size);
        scratch.pState = new Int32Array(size);
        scratch.pSlot = new Int32Array(size);
    }
    const { st, pState, pSlot } = scratch;
    for (let i = 0; i < 3 * size; i += 3) st[i] = -Infinity;
    st[0] = st[1] = st[2] = 0;
    const q = budget / K;
    const lambda = opts.lambda;

    let best = null, bestState = -1, bestSlot = -1;
    for (let i = 0; i < M; i++) {
        const e0 = fOff[i], e1 = fOff[i + 1];
        if (e0 === e1) continue;
        const v = scratch.sel[i];
        const split = vCut[v] !== 0;
        // (Pruning by shorter paths is off at split vertices, so their rows
        // don't need to be told apart here.)
        let top = -Infinity;
        for (let state = rowStart[i] * K; state < rowStart[i + 1] * K; state++) {
            const at = 3 * state;
            const a0 = st[at];
            if (a0 === -Infinity) continue;
            const c0 = st[at + 1];
            // Skip if a shorter path here is at least as good (not where
            // the way on depends on the way in).
            const w0 = a0 + mu * c0;
            if (w0 <= top && !split) continue;
            top = Math.max(top, w0);
            const l0 = st[at + 2];
            const pIn = split && i > 0 ? fHalf[pSlot[state]] >> 1 : -1;
            for (let j = e0; j < e1; j++) {
                if (split) {
                    const pOut = fHalf[j] >> 1;
                    const ok = pIn < 0 ? !cutEnd(pOut, v)
                        : cutEnd(pIn, v) ? cutEnd(pOut, v) && pEdge[pOut] === pEdge[pIn] : !cutEnd(pOut, v);
                    if (!ok) continue;
                }
                const l1 = l0 + fLen[j];
                const r = fTo[j];
                if (l1 + dS[r] > budget) continue;
                const a1 = a0 + fArea[j];
                const c1 = c0 + fCov[j];
                if (r === M) {
                    const result = opts.close(a1, c1, l1);
                    if (!best || isBetterResult(result, best)) {
                        best = { area: a1, covered: c1, length: l1, score: result.score, feasible: result.feasible };
                        bestState = state;
                        bestSlot = j;
                    }
                    continue;
                }
                let kk = (l1 / q) | 0;
                if (kk >= K) kk = K - 1;
                const idx = (rowStart[r] + (fGroup[j] > 0 ? fGroup[j] : 0)) * K + kk;
                const old = st[3 * idx];
                if (old === -Infinity || a1 + mu * c1 - lambda * l1 > old + mu * st[3 * idx + 1] - lambda * st[3 * idx + 2]) {
                    st[3 * idx] = a1;
                    st[3 * idx + 1] = c1;
                    st[3 * idx + 2] = l1;
                    pState[idx] = state;
                    pSlot[idx] = j;
                }
            }
        }
    }
    if (!best) return null;

    // Back to merged edges: runs of pieces of the same edge.
    const halves = [];
    for (let slot = bestSlot, state = bestState; ; slot = pSlot[state], state = pState[state]) {
        halves.push(fHalf[slot]);
        if (state === 0) break;
    }
    halves.reverse();
    const edges = [], dirs = [];
    for (const h of halves) {
        const e = pEdge[h >> 1];
        if (edges[edges.length - 1] !== e) {
            edges.push(e);
            dirs.push(h & 1 ? -1 : 1);
        }
    }
    return { ...best, edges, dirs };
}

// Sorts vertex ids (below maxId) by key[id] (keys in [0, 2π)). Packs each key and id into
// one number so a native numeric sort can do it, which is several times
// faster than sorting with a comparator.
function sortByKey(ids, key, maxId) {
    const n = ids.length;
    if (maxId > 2 ** 21) {
        ids.sort((a, b) => key[a] - key[b]);
        return;
    }
    const packed = new Float64Array(n);
    const scale = 2 ** 31 / (2 * Math.PI);
    for (let i = 0; i < n; i++) packed[i] = Math.floor(key[ids[i]] * scale) * 2 ** 21 + ids[i];
    packed.sort();
    for (let i = 0; i < n; i++) ids[i] = packed[i] % 2 ** 21;
}

// Target area inside the fan from the centre to the straight street from
// (ax, ay) to (bx, by) (relative to the centre): the sum over the angular
// bins whose middle ray passes through the street of the target area up to
// where the ray meets it. Negative for a street running clockwise, so that
// over any loop the fans add up to the target area it encloses.
function fanCover(target, ax, ay, bx, by, theta0) {
    const step = target.step, bins = target.bins;
    const TWO_PI = 2 * Math.PI;
    let from = (Math.atan2(ay, ax) - theta0) % TWO_PI;
    if (from < 0) from += TWO_PI;
    const turn = Math.atan2(ax * by - ay * bx, ax * bx + ay * by);   // a → b, counter-clockwise
    const sign = turn < 0 ? -1 : 1;
    const lo = turn < 0 ? from + turn : from, hi = lo + Math.abs(turn);
    const ex = bx - ax, ey = by - ay;
    let sum = 0;
    for (let k = Math.ceil(lo / step - 0.5); (k + 0.5) * step < hi; k++) {
        const phi = (k + 0.5) * step + theta0;
        const dx = Math.cos(phi), dy = Math.sin(phi);
        const den = dx * ey - dy * ex;
        if (den === 0) continue;
        const r = (ax * ey - ay * ex) / den;
        if (r > 0) sum += target.covered(((k % bins) + bins) % bins, r);
    }
    return sign * sum;
}

// --------------------------------------------------------------------------
// Block-by-block polish
// --------------------------------------------------------------------------

// Improves a loop by adding blocks (faces, see buildFaces) to its inside or
// removing them, one at a time, by simulated annealing. The inside always
// stays one piece without holes or pinch points, so its boundary is always
// a single loop that never touches itself, and each change in length, area
// and coverage follows exactly from the block's own streets. This makes the
// changes the sweep can't make (loops that aren't star-shaped, e.g. along
// winding suburban streets, or that need to reach further to cover enough)
// cheap to try: about a microsecond each.
//
// logScore(area, length, covered, stem) is the log of the loop's score, and
// feasible(…) whether it meets the requirements (same arguments).
class FacePolish {
    constructor(g, logScore, feasible) {
        const fc = this.fc = g.faces;
        this.g = g;
        this.logScore = logScore;
        this.feasible = feasible;
        this.inR = new Uint8Array(fc.F);
        this.onB = new Int32Array(fc.P).fill(-1);   // index in bList, or -1
        this.bList = new Int32Array(fc.P);
        this.bCount = 0;
        this.vB = new Uint8Array(fc.V);              // boundary pieces per vertex
        this.out = new Int32Array(fc.V).fill(-1);
        // Start mode: distance from the start to each vertex where the run
        // can join the loop (not virtual vertices, nor junctions a road
        // passes over); null in area mode.
        this.nStem = null;
        if (g.nStem) {
            this.nStem = new Float64Array(fc.V).fill(Infinity);
            for (let v = 0; v < g.N; v++) if (!fc.vCut[v]) this.nStem[v] = g.nStem[v];
        }
        // Reroute moves: path search state.
        this.dist = new Float64Array(fc.V);
        this.prevPiece = new Int32Array(fc.V);
        this.seen = new Uint32Array(fc.V);
        this.onPath = new Uint32Array(fc.P);
        this.mark = new Uint32Array(fc.F);
        this.stamp = 0;
        this.heap = new MinHeap(256);
    }

    // Sets the inside to the faces inside a counter-clockwise loop of merged
    // edges. False if the loop doesn't enclose a proper set of blocks.
    load(edges, dirs) {
        const { fc } = this;
        const onLoop = new Uint8Array(fc.P);
        const stack = [];
        edges.forEach((e, i) => {
            for (let p = fc.eOff[e]; p < fc.eOff[e + 1]; p++) {
                onLoop[p] = 1;
                stack.push(fc.hFace[dirs[i] === 1 ? 2 * p : 2 * p + 1]);
            }
        });
        const inside = new Uint8Array(fc.F);
        while (stack.length) {
            const f = stack.pop();
            if (inside[f]) continue;
            // Reached the outside: not a proper loop.
            if (fc.faceArea[f] < 0) return false;
            inside[f] = 1;
            for (let k = fc.faceOff[f]; k < fc.faceOff[f + 1]; k++) {
                const h = fc.faceHalf[k];
                if (!onLoop[h >> 1]) stack.push(fc.hFace[h ^ 1]);
            }
        }
        this.setInside(inside);
        let pieces = 0;
        for (const e of edges) pieces += fc.eOff[e + 1] - fc.eOff[e];
        return this.bCount === pieces;
    }

    setInside(inside) {
        const { fc, g } = this;
        this.inR.set(inside);
        this.onB.fill(-1);
        this.out.fill(-1);
        this.vB.fill(0);
        this.bCount = 0;
        this.area = this.length = this.covered = 0;
        this.faces = 0;
        for (let f = 0; f < fc.F; f++) {
            if (!inside[f]) continue;
            this.faces++;
            this.area += fc.faceArea[f];
            if (fc.faceCover) this.covered += fc.faceCover[f];
        }
        for (let p = 0; p < fc.P; p++) {
            if (this.inR[fc.hFace[2 * p]] !== this.inR[fc.hFace[2 * p + 1]]) this.addBoundary(p);
        }
        this.stem = this.nStem ? this.scanStem(-1) : 0;
    }

    addBoundary(p) {
        const { fc } = this;
        this.onB[p] = this.bCount;
        this.bList[this.bCount++] = p;
        this.length += fc.pLen[p];
        if (fc.pPen) this.area -= fc.pPen[p];
        this.vB[fc.pFrom[p]]++;
        this.vB[fc.pTo[p]]++;
        this.setOut(p);
    }

    removeBoundary(p) {
        const { fc, out } = this;
        const i = this.onB[p], last = this.bList[--this.bCount];
        this.bList[i] = last;
        this.onB[last] = i;
        this.onB[p] = -1;
        this.length -= fc.pLen[p];
        if (fc.pPen) this.area += fc.pPen[p];
        this.vB[fc.pFrom[p]]--;
        this.vB[fc.pTo[p]]--;
        if (out[fc.pFrom[p]] === 2 * p) out[fc.pFrom[p]] = -1;
        if (out[fc.pTo[p]] === 2 * p + 1) out[fc.pTo[p]] = -1;
    }

    // out[v]: the boundary half-edge leaving v (inside on its left).
    setOut(p) {
        const { fc } = this;
        if (this.inR[fc.hFace[2 * p]]) this.out[fc.pFrom[p]] = 2 * p;
        else this.out[fc.pTo[p]] = 2 * p + 1;
    }

    // Closest junction of the loop to the start (start mode), ignoring the
    // boundary pieces of face `skip` (about to leave the boundary).
    scanStem(skip) {
        const { fc, nStem } = this;
        let stem = Infinity;
        for (let i = 0; i < this.bCount; i++) {
            const p = this.bList[i];
            if (fc.hFace[2 * p] === skip || fc.hFace[2 * p + 1] === skip) continue;
            stem = Math.min(stem, nStem[fc.pFrom[p]], nStem[fc.pTo[p]]);
        }
        return stem;
    }

    // Whether face f can be flipped (in ↔ out) keeping the inside one simple
    // piece. Sets this.nextLength, this.nextStem and this.dPen (start mode:
    // the change in area lost to extra costs, see addBoundary).
    check(f) {
        const { fc, inR, vB, nStem } = this;
        if (!fc.faceOk[f]) return false;
        const fin = inR[f];
        if (fin && this.faces <= 1) return false;
        const a = fc.faceOff[f], b = fc.faceOff[f + 1];
        // A street of f is a "contact" if it is on the boundary now (it
        // leaves the boundary when f flips; the others join it). Contacts
        // must form one unbroken run.
        let contacts = 0, runs = 0, dLength = 0, dPen = 0;
        let prev = inR[fc.hFace[fc.faceHalf[b - 1] ^ 1]] !== fin;
        let stem = this.stem, stemLeaves = false;
        for (let k = a; k < b; k++) {
            const h = fc.faceHalf[k];
            const p = h >> 1;
            const contact = inR[fc.hFace[h ^ 1]] !== fin;
            const v = h & 1 ? fc.pTo[p] : fc.pFrom[p];   // vertex between the previous street and this one
            if (contact) {
                contacts++;
                if (!prev) runs++;
                dLength -= fc.pLen[p];
                if (fc.pPen) dPen += fc.pPen[p];
            } else {
                dLength += fc.pLen[p];
                if (fc.pPen) dPen -= fc.pPen[p];
                // A vertex that joins the boundary must not be on it already
                // (the loop would touch itself).
                if (!prev && vB[v]) return false;
            }
            if (fc.vCut[v] && !this.validAfter(v, f)) return false;
            if (nStem) {
                if (prev && contact) {
                    if (nStem[v] === this.stem) stemLeaves = true;
                } else if (nStem[v] < stem) {
                    stem = nStem[v];
                }
            }
            prev = contact;
        }
        if (contacts === 0 || contacts === b - a || runs !== 1) return false;
        if (stemLeaves && stem === this.stem) {
            stem = this.scanStem(f);
            for (let k = a; k < b; k++) {
                const h = fc.faceHalf[k];
                const v = h & 1 ? fc.pTo[h >> 1] : fc.pFrom[h >> 1];
                if (inR[fc.hFace[h ^ 1]] === fin && nStem[v] < stem) stem = nStem[v];
            }
        }
        this.nextLength = this.length + dLength;
        this.nextStem = stem;
        this.dPen = dPen;
        return true;
    }

    // At a vertex with split ends (see buildFaces), after flipping face f
    // the loop must miss it, go straight through on the split road, or
    // turn there between roads that really meet.
    validAfter(v, f) {
        const { fc, inR } = this;
        let count = 0, first = -1;
        for (let k = fc.vOff[v]; k < fc.vOff[v + 1]; k++) {
            const p = fc.vPiece[k];
            const left = fc.hFace[2 * p], right = fc.hFace[2 * p + 1];
            if ((inR[left] ^ (left === f ? 1 : 0)) !== (inR[right] ^ (right === f ? 1 : 0))) {
                if (count++ && !this.canPass(first, p, v)) return false;
                first = p;
            }
        }
        return count === 0 || count === 2;
    }

    // Whether the loop can go from piece p to piece q at vertex v.
    canPass(p, q, v) {
        const cutP = this.cutEnd(p, v), cutQ = this.cutEnd(q, v);
        return cutP ? cutQ && this.fc.pEdge[p] === this.fc.pEdge[q] : !cutQ;
    }

    cutEnd(p, v) {
        const { fc } = this;
        return fc.pFrom[p] === v ? (fc.pCut[p] & 1) !== 0 : (fc.pCut[p] & 2) !== 0;
    }

    flip(f) {
        const { fc, inR } = this;
        const sign = inR[f] ? -1 : 1;
        inR[f] ^= 1;
        this.faces += sign;
        this.area += sign * fc.faceArea[f];
        if (fc.faceCover) this.covered += sign * fc.faceCover[f];
        for (let k = fc.faceOff[f]; k < fc.faceOff[f + 1]; k++) {
            const p = fc.faceHalf[k] >> 1;
            const boundary = inR[fc.hFace[2 * p]] !== inR[fc.hFace[2 * p + 1]];
            if (boundary && this.onB[p] < 0) this.addBoundary(p);
            else if (!boundary && this.onB[p] >= 0) this.removeBoundary(p);
        }
    }

    // Anneals from the loaded inside for `moves` flips, cooling from T0 to
    // T1 (in log-score units). Returns the best loop seen as
    // { edges, dirs, join, area, length, covered, stem, feasible } or null
    // if none was better than the start.
    anneal(moves, T0, T1, random) {
        const { fc, inR } = this;
        let current = this.logScore(this.area, this.length, this.covered, this.stem);
        let bestFeasible = this.feasible(this.area, this.length, this.covered, this.stem);
        let best = current;
        const start = { log: current, feasible: bestFeasible };
        let bestInside = null, atBest = true;
        const cool = Math.log(T1 / T0) / moves;
        for (let m = 0; m < moves; m++) {
            if (m % SOLVER.rerouteEvery === 0) {
                // Reroute a stretch of the loop (see reroute). Counts as
                // many single moves as it flips blocks, roughly.
                const T = T0 * Math.exp(cool * m);
                const move = this.reroute(random);
                if (!move) continue;
                const next = this.logScore(this.area + move.dArea, this.length + move.dLength, this.covered + move.dCovered, move.stem);
                if (next < current && random() >= Math.exp((next - current) / T)) continue;
                const feasible = this.feasible(this.area + move.dArea, this.length + move.dLength, this.covered + move.dCovered, move.stem);
                const better = (feasible && !bestFeasible) || (feasible === bestFeasible && next > best);
                if (atBest && !better) bestInside = inR.slice();
                for (const f of move.faces) this.flip(f);
                // Flipping blocks one by one can pass through states where
                // out[] is overwritten; set it again around them.
                for (const f of move.faces) {
                    for (let k = fc.faceOff[f]; k < fc.faceOff[f + 1]; k++) {
                        const p = fc.faceHalf[k] >> 1;
                        if (this.onB[p] >= 0) this.setOut(p);
                    }
                }
                this.stem = move.stem;
                current = next;
                atBest = better;
                if (better) {
                    best = next;
                    bestFeasible = feasible;
                }
                continue;
            }
            const p = this.bList[Math.floor(random() * this.bCount)];
            const left = fc.hFace[2 * p], right = fc.hFace[2 * p + 1];
            const inner = inR[left] ? left : right;
            const f = random() < 0.5 ? inner : (inner === left ? right : left);
            if (!this.check(f)) continue;
            const sign = inR[f] ? -1 : 1;
            const area = this.area + sign * fc.faceArea[f] + this.dPen;
            const covered = fc.faceCover ? this.covered + sign * fc.faceCover[f] : 0;
            const next = this.logScore(area, this.nextLength, covered, this.nextStem);
            if (next < current && random() >= Math.exp((next - current) / (T0 * Math.exp(cool * m)))) continue;
            const feasible = this.feasible(area, this.nextLength, covered, this.nextStem);
            const better = (feasible && !bestFeasible) || (feasible === bestFeasible && next > best);
            if (atBest && !better) bestInside = inR.slice();
            this.flip(f);
            this.stem = this.nextStem;
            current = next;
            atBest = better;
            if (better) {
                best = next;
                bestFeasible = feasible;
            }
        }
        if (!atBest) {
            if (!bestInside) return null;
            this.setInside(bestInside);
        }
        if (best <= start.log && bestFeasible === start.feasible) return null;
        return this.loop();
    }

    // A bigger move: replace the stretch of the loop between two of its
    // vertices a and b (a few streets apart) by the shortest path between
    // them just outside the loop (growing it) or just inside (shrinking it),
    // flipping all the blocks in between. Straightens out jagged stretches
    // that single-block moves are slow to fix. Returns { faces, dArea,
    // dLength, dCovered, stem } or null if there is no such path.
    reroute(random) {
        const { fc, inR, out, vB } = this;
        const stamp = ++this.stamp;
        const p0 = this.bList[Math.floor(random() * this.bCount)];
        const h0 = inR[fc.hFace[2 * p0]] ? 2 * p0 : 2 * p0 + 1;
        const a = h0 & 1 ? fc.pTo[p0] : fc.pFrom[p0];
        // a and b: vertices where the loop doesn't just run through on a
        // split road.
        if (this.cutEnd(p0, a)) return null;
        const k = 2 + Math.floor(random() * Math.min(30, this.bCount / 3));
        const stretch = [];
        let v = a, lengthS = 0, pen = 0;
        for (let i = 0; ; i++) {
            const h = out[v];
            stretch.push(h);
            lengthS += fc.pLen[h >> 1];
            if (fc.pPen) pen += fc.pPen[h >> 1];
            v = h & 1 ? fc.pFrom[h >> 1] : fc.pTo[h >> 1];
            if (v === a || stretch.length >= this.bCount - 2) return null;
            if (i + 1 >= k && !this.cutEnd(h >> 1, v)) break;
        }
        const b = v;
        for (const h of stretch) this.onPath[h >> 1] = stamp;

        // Shortest path a → b using only streets with the same side (both
        // outside, or both inside) and no other vertex of the loop.
        const grow = random() < 0.5;
        const { dist, prevPiece, seen, heap } = this;
        const bx = fc.vX[b], by = fc.vY[b];
        heap.size = 0;
        dist[a] = 0;
        seen[a] = stamp;
        prevPiece[a] = -1;
        heap.push(Math.hypot(fc.vX[a] - bx, fc.vY[a] - by), a);
        const limit = 3 * lengthS;
        let found = false, pops = 0;
        while (heap.size > 0 && pops++ < SOLVER.reroutePops) {
            const u = heap.pop();
            if (u === b) {
                found = true;
                break;
            }
            const du = dist[u];
            if (du > limit) break;
            const via = prevPiece[u];
            for (let j = fc.vOff[u]; j < fc.vOff[u + 1]; j++) {
                const p = fc.vPiece[j];
                if (p === via) continue;
                const inL = inR[fc.hFace[2 * p]], inRt = inR[fc.hFace[2 * p + 1]];
                if (inL !== inRt || (inL === 1) !== !grow) continue;
                if (fc.vCut[u] && (via >= 0 ? !this.canPass(via, p, u) : this.cutEnd(p, u))) continue;
                const w = fc.pFrom[p] === u ? fc.pTo[p] : fc.pFrom[p];
                if (w !== b && vB[w]) continue;
                if (w === b && this.cutEnd(p, b)) continue;
                const dw = du + fc.pLen[p];
                if (seen[w] === stamp && dw >= dist[w]) continue;
                seen[w] = stamp;
                dist[w] = dw;
                prevPiece[w] = p;
                heap.push(dw + Math.hypot(fc.vX[w] - bx, fc.vY[w] - by), w);
            }
        }
        if (!found) return null;
        const pathVertices = [];
        for (let w = b; w !== a;) {
            const p = prevPiece[w];
            this.onPath[p] = stamp;
            if (fc.pPen) pen -= fc.pPen[p];
            w = fc.pFrom[p] === w ? fc.pTo[p] : fc.pFrom[p];
            if (w !== a) pathVertices.push(w);
        }

        // The blocks between the stretch and the path: on the stretch's
        // right (growing) or left (shrinking), up to the path.
        const faces = [];
        const stack = [];
        for (const h of stretch) stack.push(fc.hFace[grow ? h ^ 1 : h]);
        let dArea = 0, dCovered = 0;
        while (stack.length) {
            const f = stack.pop();
            if (this.mark[f] === stamp) continue;
            this.mark[f] = stamp;
            if (fc.faceArea[f] < 0 || inR[f] !== (grow ? 0 : 1)) return null;
            faces.push(f);
            dArea += fc.faceArea[f];
            if (fc.faceCover) dCovered += fc.faceCover[f];
            if (!grow && faces.length >= this.faces) return null;
            for (let i = fc.faceOff[f]; i < fc.faceOff[f + 1]; i++) {
                const p = fc.faceHalf[i] >> 1;
                if (this.onPath[p] !== stamp) stack.push(fc.hFace[fc.faceHalf[i] ^ 1]);
            }
        }
        if (faces.length === 0) return null;
        const sign = grow ? 1 : -1;

        let stem = 0;
        if (this.nStem) {
            // The stretch's inner vertices leave the loop; the path's join it.
            const nStem = this.nStem;
            stem = this.stem;
            for (let i = 1; i < stretch.length; i++) {
                const h = stretch[i];
                if (nStem[h & 1 ? fc.pTo[h >> 1] : fc.pFrom[h >> 1]] === this.stem) stem = Infinity;
            }
            if (stem === Infinity) {
                const leaving = new Set(stretch.slice(1).map(h => h & 1 ? fc.pTo[h >> 1] : fc.pFrom[h >> 1]));
                for (let i = 0; i < this.bCount; i++) {
                    const p = this.bList[i];
                    for (const w of [fc.pFrom[p], fc.pTo[p]]) if (!leaving.has(w) && nStem[w] < stem) stem = nStem[w];
                }
            }
            for (const w of pathVertices) if (nStem[w] < stem) stem = nStem[w];
        }
        return { faces, dArea: sign * dArea + pen, dCovered: sign * dCovered, dLength: dist[b] - lengthS, stem };
    }

    // The boundary as a loop of merged edges, starting at the junction
    // closest to the start (start mode) or any junction.
    loop() {
        const { fc, g, inR, nStem, out } = this;
        let first = -1;
        for (let i = 0; i < this.bCount; i++) {
            const p = this.bList[i];
            const h = inR[fc.hFace[2 * p]] ? 2 * p : 2 * p + 1;   // inside on the left
            const v = h & 1 ? fc.pTo[p] : fc.pFrom[p];
            if (v < g.N && !this.cutEnd(p, v) && (first < 0 || (nStem && nStem[v] < nStem[first]))) first = v;
        }
        const edges = [], dirs = [];
        let v = first;
        do {
            const h = out[v];
            const p = h >> 1;
            const e = fc.pEdge[p];
            if (edges[edges.length - 1] !== e) {
                edges.push(e);
                dirs.push(h & 1 ? -1 : 1);
            }
            v = h & 1 ? fc.pFrom[p] : fc.pTo[p];
        } while (v !== first && edges.length <= this.bCount);
        return {
            edges, dirs, join: first,
            area: this.area, length: this.length, covered: this.covered, stem: this.stem,
            feasible: this.feasible(this.area, this.length, this.covered, this.stem)
        };
    }
}

// --------------------------------------------------------------------------
// Search (runs in a worker, or on the main thread as a fallback)
// --------------------------------------------------------------------------

// params:
//   mode            "start" | "area"
//   start           { lat, lng }                 (start)
//   maxLengthM      number                       (start)
//   target          [{ lat, lng }] outline       (area)
//   coverage        0..1                         (area)
//   center, anchor  { lat, lng }                 (optional: improve a rough
//   reference       [{ lat, lng }]               loop found earlier: sweep
//                   around its centre, through the junction nearest
//                   `anchor`, and every other sweep in order along the
//                   rough loop itself)
// data: prepareGraph(…).data. worker, workers: this search takes centres
// worker, worker + workers, worker + 2·workers, … of the shared sequence.
//
// run() is an endless generator that yields { roundDone: true, improved,
// index } after every sweep. leader() is the best loop so far.
class SweepSearch {
    constructor(data, params, worker = 0, workers = 1) {
        const g = this.g = data;
        this.params = params;
        this.worker = worker;
        this.workers = workers;
        this.isStart = params.mode === "start";
        this.objective = { mode: params.mode, maxLengthM: params.maxLengthM, coverage: params.coverage };
        this.scratch = {};
        this.random = mulberry32(1 + worker);
        this.rounds = 0;
        this.evaluations = 0;
        this.best = null;
        const project = (p) => ({ x: (p.lng - g.lng0) * g.kx, y: (p.lat - g.lat0) * g.ky });
        this.fixedCenter = params.center ? project(params.center) : null;
        this.reference = params.reference ? params.reference.map(project) : null;
        this.along = this.reference ? positionsAlong(g.faces, this.reference) : null;

        if (this.isStart) {
            // Junctions the loop can be joined at: the closest one to the
            // start along the roads, and others not much further. (Not
            // junctions with a road passing right over them.)
            const nStem = g.nStem, vCut = g.faces.vCut;
            let closest = Infinity;
            for (let n = 0; n < g.N; n++) if (!vCut[n]) closest = Math.min(closest, nStem[n]);
            if (closest === Infinity) throw new Error(noLoopMessage(params));
            this.joins = [...Array(g.N).keys()]
                .filter(n => !vCut[n] && nStem[n] <= closest + SOLVER.stemSlackM)
                .sort((a, b) => nStem[a] - nStem[b])
                .slice(0, 4);
            this.origin = { x: g.startX, y: g.startY };
            this.radius = params.maxLengthM / (2 * Math.PI);
        } else {
            this.targetXY = params.target.map(project);
            const meter = createCoverageMeter(this.targetXY);
            this.targetArea = this.objective.targetArea = meter.targetArea;
            this.origin = polygonCentroidXY(this.targetXY);
            this.radius = Math.sqrt(this.targetArea / Math.PI);
            const hull = convexHull(this.targetXY);
            let perimeter = 0;
            hull.forEach((p, i) => { perimeter += Math.hypot(hull[(i + 1) % hull.length].x - p.x, hull[(i + 1) % hull.length].y - p.y); });
            // Loops longer than this can't be rounder than ones that are
            // shorter and still cover enough.
            this.budget = Math.max(1.5 * perimeter, 2.5 * Math.PI * this.radius);
            this.anchor = params.anchor ? project(params.anchor) : null;
        }
    }

    leader() {
        return this.best;
    }

    *run() {
        for (;;) {
            const before = this.best;
            const index = this.worker + this.workers * this.rounds;
            this.sweep(index);
            this.rounds++;
            yield { roundDone: true, improved: this.best !== before, index };
        }
    }

    // Sweep number i of the shared sequence.
    sweep(i) {
        const { g, isStart } = this;
        if (this.reference && this.rounds === 0) {
            // Improving a rough loop (every search, on its first sweep): start
            // from the rough loop itself, traced on these roads and polished.
            const traced = traceLoop(g, this.reference);
            // (If it can't be polished, e.g. as it crosses itself on a
            // bridge, it is still a loop on the real roads.)
            const loop = traced && (this.polishLoop(traced, true) || this.measureLoop(traced));
            if (loop) {
                const cand = this.candidate(loop, loop.join, loop.stem, this.fixedCenter);
                cand.centroid = loopCentroid(g, cand.edges, cand.dirs);
                this.best = cand;
            }
        }
        // Improving a rough loop: after the first sweep, mostly reroute the
        // best loop stretch by stretch.
        if (this.reference && this.best && i % 4 !== 0) {
            this.refine(i);
            return;
        }

        // Every few sweeps a search re-centres on its best loop so far. The
        // other sweeps of all searches together take consecutive points of
        // the evenly spread sequence: skipping every few points instead
        // would leave whole directions out.
        const every = SOLVER.recentreEvery;
        const recentreSlot = this.rounds % every === every - 1;
        const recentre = this.best && recentreSlot;
        const fresh = this.worker + this.workers * (this.rounds - Math.floor(this.rounds / every));
        const [u, v, w] = r3(recentreSlot ? 1e6 + i : fresh);
        let center;
        if (this.fixedCenter) {
            // Improving a rough loop: its own centre first, then nearby.
            const spread = i === 0 ? 0 : 0.15 * this.radius * Math.sqrt(u);
            center = { x: this.fixedCenter.x + spread * Math.cos(2 * Math.PI * v), y: this.fixedCenter.y + spread * Math.sin(2 * Math.PI * v) };
        } else if (recentre) {
            const c = this.best.centroid;
            const spread = 0.1 * this.radius * Math.sqrt(u);
            center = { x: c.x + spread * Math.cos(2 * Math.PI * v), y: c.y + spread * Math.sin(2 * Math.PI * v) };
        } else if (isStart) {
            // Where a loop through the start is centred: about a loop's
            // radius away (a circle's or a square's, with the start
            // anywhere on it), now and then anywhere nearer.
            const r = this.radius * (i % 5 === 4 ? Math.sqrt(0.04 + 1.1 * u) : 0.6 + 0.6 * u);
            center = { x: this.origin.x + r * Math.cos(2 * Math.PI * v), y: this.origin.y + r * Math.sin(2 * Math.PI * v) };
        } else {
            const r = 0.35 * this.radius * Math.sqrt(u);
            center = { x: this.origin.x + r * Math.cos(2 * Math.PI * v), y: this.origin.y + r * Math.sin(2 * Math.PI * v) };
        }

        let s, budget, stem = 0, mu = 0, target = null;
        if (isStart) {
            // Mostly the closest join; now and then another one.
            const k = this.joins.length > 1 && i % 4 === 3 ? 1 + Math.floor(w * (this.joins.length - 1)) : 0;
            s = this.joins[k];
            stem = g.nStem[s];
            budget = this.params.maxLengthM - 2 * stem;
            if (budget <= 0) return;
        } else {
            // A junction on the target's outline (or the rough loop's), in a
            // direction that turns by the golden angle each sweep.
            const phi = 2 * Math.PI * w;
            // (On the outline shrunk to the coverage, or as far out as a
            // little beyond it.)
            const k = Math.sqrt(this.params.coverage);
            const scale = k + (1.05 - k) * ((i * 0.6180339887) % 1);
            const at = this.anchor && (this.fixedCenter || i % 2 === 0) ? this.anchor : outlinePoint(this.targetXY, center, phi, scale);
            s = nearestJunction(g, at.x, at.y, n => !g.faces.vCut[n]);
            budget = this.budget;
            const weights = SOLVER.coverageWeights;
            mu = weights[(i + (i / weights.length | 0)) % weights.length];
            target = polarTarget(this.targetXY, center.x, center.y, Math.atan2(g.y[s] - center.y, g.x[s] - center.x), SOLVER.coverageBins);
        }

        const objective = this.objective;
        const close = isStart
            ? (area, covered, length) => scoreLoop({ length: length + 2 * stem, area, repeats: 0 }, objective)
            : (area, covered, length) => scoreLoop({ length, area, coverage: covered / this.targetArea, repeats: 0 }, objective);
        // Marginal area per meter of length for a round loop of this size.
        const lambda = 0.8 * (isStart ? budget : 2 * Math.PI * this.radius) / (2 * Math.PI) * (1 + mu);
        // Improving a rough loop: the first sweep goes in order along it
        // rather than around the centre, so it can follow its every wiggle.
        const along = this.along && i === 1 ? this.along : null;
        const swept = sweepLoop(g, s, center.x, center.y, budget,
            { K: SOLVER.lengthBuckets, mu, lambda, target, close, order: along?.order, period: along?.period }, this.scratch);
        this.evaluations++;
        if (!swept) return;
        let cand = this.candidate(swept, s, stem, center);

        // Polish loops that come close to the best sweep so far, block by
        // block.
        const best = this.best;
        const top = this.bestSwept;
        if (!top || isBetterResult(cand, top)) this.bestSwept = cand;
        const within = isStart ? 0 : SOLVER.polishWithin;
        if (!top || (cand.feasible || !top.feasible) && cand.score >= top.score * (1 - within)) {
            const polished = this.polishLoop(swept);
            if (polished) {
                const next = this.candidate(polished, isStart ? polished.join : s, polished.stem, center);
                if (isBetterResult(next, cand)) cand = next;
            }
        }
        if (!best || isBetterResult(cand, best)) {
            cand.centroid = loopCentroid(g, cand.edges, cand.dirs);
            this.best = cand;
        }
    }

    // One pass of rerouting the best loop, stretch by stretch: each stretch
    // between two junctions (a "window", a few km to a few dozen km long)
    // is replaced by the best path between its ends that keeps moving
    // forward along the loop (sweepLoop with an end), if that makes the
    // whole loop better. A stretch that can't be improved (or rerouted at
    // all, e.g. a cloverleaf ramp under its own bridge) stays as it is, so
    // one awkward spot can't block the rest of a very long loop.
    refine(i) {
        const { g, isStart, objective } = this;
        const F = g.faces;
        const c = this.fixedCenter || this.best.centroid;
        const [u, v, w] = r3(i);
        const target = isStart ? null : (this.refineTarget ||= polarTarget(this.targetXY, c.x, c.y, 0, SOLVER.coverageBins));
        let loop = this.best;
        // (Kept while the best loop stays the same.)
        if (this.alongBest !== loop) {
            this.alongBest = loop;
            const along = positionsAlong(F, loopPoints(g, loop.edges, loop.dirs), 0);
            // Vertices by position along the loop, so a window's sweep only
            // looks at the vertices in its stretch.
            const byOrder = Int32Array.from({ length: F.V }, (_, k) => k);
            sortByKey(byOrder, Float64Array.from(along.order, o => o / along.period * 2 * Math.PI * (1 - 1e-12)), F.V);
            this.alongLoop = { along, byOrder, sortedPos: Float64Array.from(byOrder, k => along.order[k]) };
        }
        const { along, byOrder, sortedPos } = this.alongLoop;
        const weights = SOLVER.coverageWeights;
        const mu = isStart ? 0 : weights[Math.floor(w * weights.length)];
        const stem = loop.metrics.stem || 0;

        // The loop as pieces: start vertex, piece, direction, and the index
        // of its merged edge in loop.edges.
        const unpack = (lp) => {
            const verts = [], pcs = [], dirs = [], edgeAt = [];
            lp.edges.forEach((e, k) => {
                if (lp.dirs[k] === 1) for (let p = F.eOff[e]; p < F.eOff[e + 1]; p++) { verts.push(F.pFrom[p]); pcs.push(p); dirs.push(1); edgeAt.push(k); }
                else for (let p = F.eOff[e + 1] - 1; p >= F.eOff[e]; p--) { verts.push(F.pTo[p]); pcs.push(p); dirs.push(-1); edgeAt.push(k); }
            });
            const n = pcs.length;
            const cumL = new Float64Array(n + 1), cumA = new Float64Array(n + 1), cumC = new Float64Array(n + 1);
            for (let k = 0; k < n; k++) {
                const a = verts[k], b = verts[(k + 1) % n], p = pcs[k];
                const ax = F.vX[a] - c.x, ay = F.vY[a] - c.y, bx = F.vX[b] - c.x, by = F.vY[b] - c.y;
                cumL[k + 1] = cumL[k] + F.pLen[p];
                cumA[k + 1] = cumA[k] + ((dirs[k] === 1 ? F.pCross[p] : -F.pCross[p]) - (c.x * (F.vY[b] - F.vY[a]) - c.y * (F.vX[b] - F.vX[a]))) / 2 - (F.pPen ? F.pPen[p] : 0);
                cumC[k + 1] = cumC[k] + (target ? fanCover(target, ax, ay, bx, by, 0) : 0);
            }
            return { verts, edgeAt, n, cumL, cumA, cumC };
        };
        let L = unpack(loop);
        const total = () => L.cumL[L.n];
        const firstAfter = (o) => {
            let lo = 0, hi = F.V;
            while (lo < hi) {
                const mid = (lo + hi) >> 1;
                if (sortedPos[mid] <= o) lo = mid + 1;
                else hi = mid;
            }
            return lo;
        };
        const between = (sV, eV) => {
            const a = firstAfter(along.order[sV]), b = firstAfter(along.order[eV]);
            const out = [sV];
            if (a <= b) for (let k = a; k < b; k++) out.push(byOrder[k]);
            else {
                for (let k = a; k < F.V; k++) out.push(byOrder[k]);
                for (let k = 0; k < b; k++) out.push(byOrder[k]);
            }
            return out;
        };
        // Window length: from 3 km up to 25 km or a twelfth of the loop
        // (spread evenly on a log scale), at most a third of the loop.
        const W = Math.min(3000 * Math.max(25 / 3, total() / 36000) ** u, total() / 3);
        const isEnd = (vtx) => vtx < g.N && !F.vCut[vtx] && !(isStart && vtx === loop.s);
        const sum = (arr, a, b) => b >= a ? arr[b] - arr[a] : arr[L.n] - arr[a] + arr[b];

        let pos = v * W;
        const stop = pos + total();
        while (pos < stop) {
            // Window ends: the first junctions at or after pos and pos + W.
            const n = L.n;
            const find = (from) => {
                const at = ((from % total()) + total()) % total();
                let k = 0;
                while (k < n && L.cumL[k] < at) k++;
                for (let t = 0; t < n; t++) if (isEnd(L.verts[(k + t) % n])) return (k + t) % n;
                return -1;
            };
            const a = find(pos);
            if (a < 0) break;
            const b = find(L.cumL[a] + W);
            if (b < 0 || b === a) break;
            const winLen = sum(L.cumL, a, b);
            pos += Math.max(W / 2, 1);
            // The join to the start must stay on the loop (start mode).
            if (isStart && (b - a + n) % n > (L.verts.indexOf(loop.s) - a + n) % n) continue;

            const restL = total() - winLen, restA = L.cumA[n] - sum(L.cumA, a, b), restC = L.cumC[n] - sum(L.cumC, a, b);
            const sV = L.verts[a], eV = L.verts[b];
            const startAng = along.order[sV];
            const endAng = ((along.order[eV] - startAng) / along.period * 2 * Math.PI + 2 * Math.PI) % (2 * Math.PI);
            // Paths up to 3× the stretch, but no longer than the length left
            // (unless the loop is already too long: then as long as the
            // stretch, so that shorter ways round can win).
            const room = isStart ? objective.maxLengthM - 2 * stem - restL : this.budget - restL;
            const budget = Math.min(Math.max(room, winLen), 3 * winLen + 2000);
            if (!(budget > 0) || !(endAng > 0)) continue;
            const area = L.cumA[n], length = total();
            const lambda = (isStart ? 0.8 * length / (2 * Math.PI) : 2 * area / length) * (0.6 + 0.8 * w);
            const close = isStart
                ? (pa, pc, pl) => scoreLoop({ length: pl + restL + 2 * stem, area: pa + restA, repeats: 0 }, objective)
                : (pa, pc, pl) => scoreLoop({ length: pl + restL, area: pa + restA, coverage: (pc + restC) / this.targetArea, repeats: 0 }, objective);
            const path = sweepLoop(g, sV, c.x, c.y, budget,
                { K: 24, mu, lambda: lambda * (1 + mu), target, close, order: along.order, period: along.period, end: eV, endAng, theta0: 0, candidates: between(sV, eV) }, this.scratch);
            this.evaluations++;
            if (!path) continue;
            const cand = this.candidate({
                edges: [], dirs: [], length: path.length + restL, area: path.area + restA, covered: path.covered + restC
            }, loop.s, stem, c);
            if (!isBetterResult(cand, loop) || cand.score <= loop.score * (1 + 1e-9)) continue;
            // Splice: the path, then the loop from b on round to a.
            const ea = L.edgeAt[a], eb = L.edgeAt[b];
            const edges = path.edges.slice(), dirs = path.dirs.slice();
            for (let k = eb; k !== ea; k = (k + 1) % loop.edges.length) {
                edges.push(loop.edges[k]);
                dirs.push(loop.dirs[k]);
            }
            cand.edges = edges;
            cand.dirs = dirs;
            if (isStart) cand.s = loop.s;
            loop = cand;
            L = unpack(loop);
        }
        if (loop === this.best) return;
        // Polish the result block by block (if it doesn't cross itself).
        const polished = this.polishLoop({ edges: loop.edges, dirs: loop.dirs });
        if (polished) {
            const next = this.candidate(polished, isStart ? polished.join : loop.s, polished.stem, c);
            if (isBetterResult(next, loop)) loop = next;
        }
        loop.centroid = loopCentroid(g, loop.edges, loop.dirs);
        if (isBetterResult(loop, this.best)) this.best = loop;
    }

    candidate(loop, s, stem, center) {
        const metrics = { length: loop.length + 2 * stem, area: loop.area, repeats: 0, stem };
        if (!this.isStart) metrics.coverage = loop.covered / this.targetArea;
        metrics.iq = 4 * Math.PI * metrics.area / metrics.length ** 2;
        const { score, feasible } = scoreLoop(metrics, this.objective);
        return { edges: loop.edges, dirs: loop.dirs, metrics, score, feasible, s, center };
    }

    // Length, area and coverage of a loop of merged edges (coverage from
    // its junctions only), and where it is joined from the start.
    measureLoop({ edges, dirs }) {
        const { g } = this;
        let length = 0, cross = 0, join = -1;
        const xs = [], ys = [];
        edges.forEach((e, i) => {
            length += g.eLen[e];
            cross += dirs[i] * g.eCross[e] - (g.ePen ? 2 * g.ePen[e] : 0);
            const v = dirs[i] === 1 ? g.eFrom[e] : g.eTo[e];
            xs.push(g.x[v]);
            ys.push(g.y[v]);
            if (join < 0 || (g.nStem && g.nStem[v] < g.nStem[join])) join = v;
        });
        const covered = this.isStart ? 0 : createCoverageMeter(this.targetXY).measure(xs, ys) * this.targetArea;
        return { edges, dirs, join, length, area: cross / 2, covered, stem: g.nStem ? g.nStem[join] : 0 };
    }

    // The loop polished block by block, or null if that didn't improve it
    // (with keep: the loop as loaded).
    polishLoop(loop, keep = false) {
        if (!this.polish) {
            const { isStart, objective, targetArea } = this;
            const maxLength = objective.maxLengthM, need = objective.coverage * targetArea;
            const logScore = isStart
                ? (area, length, covered, stem) => {
                    if (!(area > 0)) return -Infinity;
                    const over = (length + 2 * stem) / maxLength;
                    return Math.log(area) - (over > 1 ? 10 * Math.log(over) : 0);
                }
                : (area, length, covered) => {
                    if (!(area > 0) || !(covered > 0)) return -Infinity;
                    const iq = 4 * Math.PI * area / (length * length);
                    const short = covered / need;
                    const reward = SOLVER.polishLinear ? SOLVER.polishLinear * Math.min(short, 1.01) : (short < 1 ? SOLVER.polishShortfall * Math.log(short) : 0);
                    return Math.log(iq + SOLVER.areaTiebreak * Math.min(area / targetArea, 2)) + reward;
                };
            const feasible = isStart
                ? (area, length, covered, stem) => length + 2 * stem <= maxLength
                : (area, length, covered) => covered >= need;
            this.polish = new FacePolish(this.g, logScore, feasible);
        }
        if (!this.polish.load(loop.edges, loop.dirs)) return null;
        const moves = Math.max(SOLVER.polishMoves / 4, Math.min(SOLVER.polishMoves, 200 * this.polish.bCount));
        return this.polish.anneal(moves, SOLVER.polishHeat, SOLVER.polishHeat / 100, this.random) || (keep ? this.polish.loop() : null);
    }

    // The leader as plain data (for postMessage). See expandLoop() for the
    // road geometry.
    result() {
        const b = this.best;
        if (!b) return null;
        const { g } = this;
        const toLatLng = (p) => ({ lat: p.y / g.ky + g.lat0, lng: p.x / g.kx + g.lng0 });
        return {
            edges: b.edges,
            dirs: b.dirs,
            join: b.s,
            center: toLatLng(b.center),
            anchor: toLatLng({ x: g.x[b.s], y: g.y[b.s] }),
            metrics: b.metrics,
            score: b.score,
            feasible: b.feasible
        };
    }
}

// Small seeded random number generator, so runs are repeatable.
function mulberry32(seed) {
    return () => {
        seed |= 0;
        seed = (seed + 0x6d2b79f5) | 0;
        let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

// A loop of merged edges that follows a ring of points (counter-clockwise):
// shortest paths between the junctions nearest to points every few hundred
// meters along it, with any detours that come back to the same junction cut
// out. Null if the roads don't connect.
function traceLoop(g, ring) {
    const { N, x, y, eFrom, eTo, eLen, adjOff, adjEdge } = g;
    const spacing = 300;
    const nearest = junctionFinder(g);
    const stops = [];
    for (let i = 0; i < ring.length; i++) {
        const a = ring[i], b = ring[(i + 1) % ring.length];
        const parts = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / spacing));
        for (let k = 0; k < parts; k++) {
            const n = nearest(a.x + (b.x - a.x) * k / parts, a.y + (b.y - a.y) * k / parts);
            if (stops[stops.length - 1] !== n) stops.push(n);
        }
    }
    if (stops.length > 1 && stops[0] === stops[stops.length - 1]) stops.pop();
    if (stops.length < 3) return null;

    const dist = new Float64Array(N).fill(Infinity);
    const prev = new Int32Array(N);
    const heap = new MinHeap(256);
    const touched = [];
    const route = (from, to) => {
        for (const v of touched) dist[v] = Infinity;
        touched.length = 0;
        heap.size = 0;
        dist[from] = 0;
        touched.push(from);
        heap.push(Math.hypot(x[from] - x[to], y[from] - y[to]), from);
        while (heap.size > 0) {
            const u = heap.pop();
            if (u === to) break;
            for (let k = adjOff[u]; k < adjOff[u + 1]; k++) {
                const e = adjEdge[k];
                const v = eFrom[e] === u ? eTo[e] : eFrom[e];
                const d = dist[u] + eLen[e];
                if (d < dist[v]) {
                    if (dist[v] === Infinity) touched.push(v);
                    dist[v] = d;
                    prev[v] = e;
                    heap.push(d + Math.hypot(x[v] - x[to], y[v] - y[to]), v);
                }
            }
        }
        if (dist[to] === Infinity) return null;
        const path = [];
        for (let v = to; v !== from;) {
            const e = prev[v];
            path.push(e);
            v = eFrom[e] === v ? eTo[e] : eFrom[e];
        }
        return path.reverse();
    };

    // Walk the stops, keeping a stack of (junction, edge in); coming back to
    // a junction already on the stack cuts out everything since (a detour
    // out and back). Near the end, coming back to a junction from the first
    // half closes the ring there instead, and the start of the stack before
    // it is dropped.
    let nodes = [stops[0]], edges = [];
    const onStack = new Map([[stops[0], 0]]);
    walk: for (let i = 0; i < stops.length; i++) {
        const to = stops[(i + 1) % stops.length];
        const path = route(nodes[nodes.length - 1], to);
        if (!path) return null;
        for (const e of path) {
            const u = nodes[nodes.length - 1];
            const v = eFrom[e] === u ? eTo[e] : eFrom[e];
            if (onStack.has(v)) {
                const j = onStack.get(v);
                if ((j === 0 && i === stops.length - 1) || (i >= 0.9 * stops.length && j < nodes.length / 2)) {
                    edges.push(e);
                    nodes = nodes.slice(j);
                    edges = edges.slice(j);
                    break walk;
                }
                while (nodes.length - 1 > j) {
                    onStack.delete(nodes.pop());
                    edges.pop();
                }
                continue;
            }
            onStack.set(v, nodes.length);
            nodes.push(v);
            edges.push(e);
        }
    }
    if (edges.length < 3 || nodes.length !== edges.length) return null;
    const dirs = edges.map((e, i) => eFrom[e] === nodes[i] ? 1 : -1);
    // Counter-clockwise.
    let cross = 0;
    edges.forEach((e, i) => { cross += dirs[i] * g.eCross[e]; });
    if (cross < 0) {
        edges.reverse();
        dirs.reverse();
        for (let i = 0; i < dirs.length; i++) dirs[i] = -dirs[i];
    }
    return { edges, dirs };
}

// Each vertex's position along a reference loop (a ring of points): the
// distance along it to the nearest point, measured on a copy smoothed
// `smooth` times so that positions change gradually around its corners.
function positionsAlong(faces, ring, smooth = 3) {
    // Points closer together than 1/4000 of the way round add nothing.
    let around = 0;
    for (let i = 0; i < ring.length; i++) around += Math.hypot(ring[(i + 1) % ring.length].x - ring[i].x, ring[(i + 1) % ring.length].y - ring[i].y);
    let pts = [ring[0]];
    for (const p of ring) {
        const q = pts[pts.length - 1];
        if (Math.hypot(p.x - q.x, p.y - q.y) >= around / 4000) pts.push(p);
    }
    for (let pass = 0; pass < smooth; pass++) {
        // Chaikin corner cutting.
        const next = [];
        for (let i = 0; i < pts.length; i++) {
            const a = pts[i], b = pts[(i + 1) % pts.length];
            next.push({ x: 0.75 * a.x + 0.25 * b.x, y: 0.75 * a.y + 0.25 * b.y }, { x: 0.25 * a.x + 0.75 * b.x, y: 0.25 * a.y + 0.75 * b.y });
        }
        pts = next;
    }
    const n = pts.length;
    const cum = new Float64Array(n + 1);
    for (let i = 0; i < n; i++) cum[i + 1] = cum[i] + Math.hypot(pts[(i + 1) % n].x - pts[i].x, pts[(i + 1) % n].y - pts[i].y);
    // Segments by grid cell (each listed in every cell its box overlaps).
    const { V, vX, vY } = faces;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    const extend = (x, y) => {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
    };
    for (const p of pts) extend(p.x, p.y);
    for (let v = 0; v < V; v++) extend(vX[v], vY[v]);
    const CELL = Math.max(200, cum[n] / 1000, Math.sqrt((maxX - minX) * (maxY - minY) / 4e6));
    const W = Math.floor((maxX - minX) / CELL) + 1, H = Math.floor((maxY - minY) / CELL) + 1;
    const cellX = (x) => Math.floor((x - minX) / CELL), cellY = (y) => Math.floor((y - minY) / CELL);
    const eachCell = (i, fn) => {
        const a = pts[i], b = pts[(i + 1) % n];
        for (let cy = cellY(Math.min(a.y, b.y)); cy <= cellY(Math.max(a.y, b.y)); cy++) {
            for (let cx = cellX(Math.min(a.x, b.x)); cx <= cellX(Math.max(a.x, b.x)); cx++) fn(cy * W + cx);
        }
    };
    const segOff = new Int32Array(W * H + 1);
    for (let i = 0; i < n; i++) eachCell(i, c => segOff[c + 1]++);
    for (let c = 0; c < W * H; c++) segOff[c + 1] += segOff[c];
    const segList = new Int32Array(segOff[W * H]), fill = segOff.slice(0, W * H);
    for (let i = 0; i < n; i++) eachCell(i, c => { segList[fill[c]++] = i; });

    let projT = 0;
    const segDist2 = (i, px, py) => {
        const a = pts[i], b = pts[(i + 1) % n];
        const ex = b.x - a.x, ey = b.y - a.y, len2 = ex * ex + ey * ey;
        projT = len2 > 0 ? Math.max(0, Math.min(1, ((px - a.x) * ex + (py - a.y) * ey) / len2)) : 0;
        return (a.x + projT * ex - px) ** 2 + (a.y + projT * ey - py) ** 2;
    };
    // Calls fn(segment) for the segments in cells up to `reach` from cell
    // (cx, cy) (some more than once); false if there were none.
    const near = (cx, cy, reach, fn) => {
        const rings = Math.ceil(reach / CELL) + 1;
        let any = false;
        for (let gy = Math.max(0, cy - rings); gy <= Math.min(H - 1, cy + rings); gy++) {
            for (let gx = Math.max(0, cx - rings); gx <= Math.min(W - 1, cx + rings); gx++) {
                const c = gy * W + gx;
                for (let k = segOff[c]; k < segOff[c + 1]; k++) {
                    any = true;
                    fn(segList[k]);
                }
            }
        }
        return any;
    };
    // Per grid cell, the segments that can be nearest to some point in it:
    // within d + 2h of its centre, where d is the distance from the centre
    // to the nearest segment and h half the cell's diagonal.
    const candOff = new Int32Array(W * H).fill(-1), candLen = new Int32Array(W * H);
    let cand = new Int32Array(1024), candCount = 0;
    const stamp = new Int32Array(n).fill(-1);
    const candidates = (cx, cy) => {
        const c = cy * W + cx;
        if (candOff[c] >= 0) return c;
        const mx = minX + (cx + 0.5) * CELL, my = minY + (cy + 0.5) * CELL;
        let d = Infinity;
        for (let reach = CELL; ; reach *= 2) {
            const any = near(cx, cy, reach, i => { d = Math.min(d, segDist2(i, mx, my)); });
            if ((any && reach * reach >= d) || reach > 2 * (W + H) * CELL) break;
        }
        const limit = Math.sqrt(d) + CELL * Math.SQRT2;
        candOff[c] = candCount;
        near(cx, cy, limit, i => {
            if (stamp[i] === c || segDist2(i, mx, my) > limit * limit) return;
            stamp[i] = c;
            if (candCount === cand.length) {
                const grown = new Int32Array(2 * cand.length);
                grown.set(cand);
                cand = grown;
            }
            cand[candCount++] = i;
        });
        candLen[c] = candCount - candOff[c];
        return c;
    };
    const order = new Float64Array(V);
    for (let v = 0; v < V; v++) {
        const px = vX[v], py = vY[v];
        const c = candidates(cellX(px), cellY(py));
        let best = Infinity, at = 0;
        for (let k = candOff[c]; k < candOff[c] + candLen[c]; k++) {
            const i = cand[k];
            const d = segDist2(i, px, py);
            if (d < best) {
                best = d;
                at = cum[i] + projT * (cum[i + 1] - cum[i]);
            }
        }
        order[v] = at;
    }
    return { order, period: cum[n] };
}

// Point i of an evenly spread 3D sequence in [0, 1)³ (Roberts' R3).
function r3(i) {
    const phi = 1.2207440846057596;
    return [(0.5 + i / phi) % 1, (0.5 + i / phi ** 2) % 1, (0.5 + i / phi ** 3) % 1];
}

// Where a ray from `from` at angle phi last leaves the outline, pulled
// toward `from` by `scale`.
function outlinePoint(outline, from, phi, scale) {
    const dx = Math.cos(phi), dy = Math.sin(phi);
    let far = 0;
    for (let i = 0; i < outline.length; i++) {
        const a = outline[i], b = outline[(i + 1) % outline.length];
        const ex = b.x - a.x, ey = b.y - a.y;
        const den = dx * ey - dy * ex;
        if (den === 0) continue;
        const t = ((a.x - from.x) * ey - (a.y - from.y) * ex) / den;
        const u = ((a.x - from.x) * dy - (a.y - from.y) * dx) / den;
        if (t > far && u >= 0 && u <= 1) far = t;
    }
    return { x: from.x + dx * far * scale, y: from.y + dy * far * scale };
}

// The vertices of a loop of merged edges in order, with every split along
// its roads (so the points follow the roads closely).
function loopPoints(g, edges, dirs) {
    const { vX, vY, pFrom, pTo, eOff } = g.faces;
    const pts = [];
    edges.forEach((e, i) => {
        if (dirs[i] === 1) for (let p = eOff[e]; p < eOff[e + 1]; p++) pts.push({ x: vX[pFrom[p]], y: vY[pFrom[p]] });
        else for (let p = eOff[e + 1] - 1; p >= eOff[e]; p--) pts.push({ x: vX[pTo[p]], y: vY[pTo[p]] });
    });
    return pts;
}

function loopCentroid(g, edges, dirs) {
    return polygonCentroidXY(edges.map((e, i) => {
        const n = dirs[i] === 1 ? g.eFrom[e] : g.eTo[e];
        return { x: g.x[n], y: g.y[n] };
    }));
}

// Decides when a search is done: after enough sweeps in a row (from all
// parallel searches together) that brought no real improvement, and at
// least half as many as it took to find the best loop. A search that is
// still finding better loops late keeps going. Sweeps are counted in
// sequence order, whichever search finishes first, so the same search
// always ends at the same sweep with the same loop.
class SearchTracker {
    constructor(workers, refining = false) {
        this.minStale = refining ? SOLVER.refineSweeps + 2 * workers : SOLVER.convergeSweeps + 4 * workers;
        this.needed = this.minStale;
        this.stale = 0;
        this.rounds = 0;
        this.best = null;
        this.pending = new Map();   // sweep index → result, not yet counted
    }

    // Reports sweep number `index` (in sequence order; any order of
    // arrival) and the reporting search's best loop then (or null if it
    // didn't change). Returns true if the overall best changed.
    report(result, index = this.rounds) {
        this.pending.set(index, result);
        return this.flush();
    }

    // Search `worker` of `workers` has stopped (it found no loop at all):
    // its sweeps count as finding nothing, so the others aren't held up.
    drop(worker, workers) {
        (this.dropped ||= new Set()).add(worker);
        this.workers = workers;
        return this.flush();
    }

    flush() {
        let changed = false;
        for (;;) {
            if (this.done) break;
            if (this.pending.has(this.rounds)) {
                const next = this.pending.get(this.rounds);
                this.pending.delete(this.rounds);
                changed = this.count(next) || changed;
            } else if (this.dropped?.has(this.rounds % this.workers)) {
                changed = this.count(null) || changed;
            } else {
                break;
            }
        }
        return changed;
    }

    count(result) {
        this.rounds++;
        const best = this.best;
        if (!result || !isBetterResult(result, best)) {
            this.stale++;
            return false;
        }
        const significant = !best || (result.feasible && !best.feasible) ||
            result.score > best.score + SOLVER.minGain * Math.abs(best.score);
        if (significant) {
            this.stale = 0;
            this.needed = Math.max(this.minStale, Math.ceil(this.rounds / 2));
        } else {
            this.stale++;
        }
        this.best = result;
        return true;
    }

    get done() {
        return this.best !== null && this.stale >= this.needed;
    }

    // Rises toward 1 as the search settles; drops back after an improvement.
    get fraction() {
        return Math.min(1, this.stale / this.needed);
    }
}

// A search that has found no loop at all after this many sweeps gives up.
const MAX_EMPTY_SWEEPS = 12;

const noLoopMessage = (params) => params.mode === "start"
    ? "Couldn't form a loop here. Try a larger distance or a different start point."
    : "Couldn't form a loop here. Try a larger area.";

const isBetterResult = (a, b) => !b || (a.feasible && !b.feasible) || (a.feasible === b.feasible && a.score > b.score);

// --------------------------------------------------------------------------
// Results (main thread)
// --------------------------------------------------------------------------

const polylineLength = (coords) => {
    let m = 0;
    for (let i = 1; i < coords.length; i++) m += haversine(coords[i - 1][0], coords[i - 1][1], coords[i][0], coords[i][1]);
    return m;
};

// Turns a search result into road geometry and measurements. For a start
// loop with a stem, the coordinates run start → loop → start.
function expandLoop(prep, res, params, exact) {
    const { oFrom, oTo, chainOff, chainEdge, chainDir } = prep;
    const steps = [];   // [originalEdge, dir]
    res.edges.forEach((e, i) => {
        const a = chainOff[e], b = chainOff[e + 1];
        if (res.dirs[i] === 1) for (let k = a; k < b; k++) steps.push([chainEdge[k], chainDir[k]]);
        else for (let k = b - 1; k >= a; k--) steps.push([chainEdge[k], -chainDir[k]]);
    });
    const tail = ([e, dir]) => dir === 1 ? oFrom[e] : oTo[e];

    let stemM = 0;
    let ordered = steps;
    if (params.mode === "start") {
        // The loop already begins at its join; add the stem from the start.
        const anchor = prep.cOrig[res.join];
        const at = Math.max(0, steps.findIndex(s => tail(s) === anchor));
        const ring = steps.slice(at).concat(steps.slice(0, at));
        const back = [];
        for (let v = anchor; v !== prep.startOrig;) {
            const e = prep.stemPrev[v];
            if (e < 0) break;
            back.push([e, oFrom[e] === v ? 1 : -1]);
            v = oFrom[e] === v ? oTo[e] : oFrom[e];
        }
        const out = back.slice().reverse().map(([e, dir]) => [e, -dir]);
        ordered = out.concat(ring, back);
        stemM = res.metrics.stem;
    }

    // Stretches to check before running: fence hops, railroad tracks,
    // motorways (usually closed to people on foot or bike) and roads marked
    // private (each a run of road geometry).
    const coords = [], flags = [];
    let hops = 0, railM = 0, motorwayM = 0, privateM = 0;
    for (const [e, dir] of ordered) {
        const edge = prep.source[e];
        const kind = edge.highway === "hop" ? "hop" : edge.highway === "railway" ? "rail"
            : edge.highway === "motorway" || edge.highway === "motorway_link" ? "motorway" : edge.restricted ? "private" : null;
        if (kind === "hop") hops++;
        else if (kind === "rail") railM += edge.distance;
        else if (kind === "motorway") motorwayM += edge.distance;
        else if (kind === "private") privateM += edge.distance;
        const line = dir === 1 ? edge.coords : [...edge.coords].reverse();
        if (kind) {
            const last = flags[flags.length - 1];
            if (last && last.kind === kind && last.end === coords.length - 1) last.coords.push(...line.slice(1));
            else flags.push({ kind, coords: line.slice() });
        }
        for (let k = coords.length ? 1 : 0; k < line.length; k++) coords.push(line[k]);
        if (kind) flags[flags.length - 1].end = coords.length - 1;
    }
    flags.forEach(flag => delete flag.end);
    // Short private stretches (a loop clipping the edge of a property
    // where roads meet) aren't worth a warning.
    const kept = flags.filter(flag => flag.kind !== "private" || polylineLength(flag.coords) >= SOLVER.minPrivateM);
    privateM = kept.reduce((sum, flag) => sum + (flag.kind === "private" ? polylineLength(flag.coords) : 0), 0);

    // The real length and area (the search's include extra costs, see
    // SOLVER.climbCost).
    let lengthM = 0, cross = 0;
    for (const [e] of ordered) lengthM += prep.source[e].distance;
    let prev = prep.project(coords[0][0], coords[0][1]);
    for (let i = 1; i < coords.length; i++) {
        const p = prep.project(coords[i][0], coords[i][1]);
        cross += prev.x * p.y - p.x * prev.y;
        prev = p;
    }
    const areaM2 = Math.abs(cross) / 2;

    const m = res.metrics;
    const result = {
        mode: params.mode,
        coords,                       // closed: first point === last point
        lengthM,
        areaM2,
        iq: 4 * Math.PI * areaM2 / lengthM ** 2,
        repeats: m.repeats,
        stemM,
        hops,                         // fence hops used
        railM,                        // length along railroad tracks
        motorwayM,                    // length on motorways
        privateM,                     // length on roads marked private
        flags: kept,                  // [{ kind: "hop" | "rail" | "motorway" | "private", coords }]
        score: res.score,
        feasible: res.feasible,
        center: res.center,
        anchor: res.anchor
    };

    if (params.mode === "area") {
        // Coverage on the full road geometry for the final answer.
        const targetXY = params.target.map(p => prep.project(p.lat, p.lng));
        const xy = exact ? coords.map(([lat, lng]) => prep.project(lat, lng)) : null;
        result.coverage = xy ? createCoverageMeter(targetXY).measure(xy.map(p => p.x), xy.map(p => p.y)) : m.coverage;
    }
    if (params.mode === "start") {
        result.start = prep.unproject(prep.data.startX, prep.data.startY);
    }
    return result;
}

if (typeof module !== "undefined") {
    module.exports = { prepareGraph, SweepSearch, SearchTracker, expandLoop, createCoverageMeter, scoreLoop, sweepLoop };
}
