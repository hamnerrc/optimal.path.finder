// ==========================================================================
// Loop solver
//
// Finds a closed loop on the road network that encloses as much territory as
// possible. Two objectives are supported (plus "refine", which improves one
// stretch of an existing loop; see LoopSearch):
//
//   "start"  The loop must start at a start point and be no longer than
//            maxLengthM. Maximizes the enclosed area. The loop itself is a
//            ring anywhere near the start; if it doesn't pass through the
//            start, the run goes out to it and back the same way (a
//            "lollipop"), and that stem counts twice toward the length.
//   "area"   No start point. Maximizes the isoperimetric quotient
//            (4π·area / length², 1 for a perfect circle) among loops that
//            cover at least `coverage` of a target shape. Ties go to the
//            loop enclosing more area.
//
// The road graph is first shrunk (prepareGraph): dead-end streets and the
// trees of streets hanging off them can never be part of a ring, so they
// are pruned, and the chains of roads left between junctions are merged
// into single edges. In a typical town that leaves well under half the
// nodes.
//
// A loop is described by a ring of waypoints. Consecutive waypoints are
// joined with A* shortest paths, where streets already used by the loop are
// made expensive so the loop doesn't run the same street twice. The search
// runs in rounds: each round anneals the waypoints (move, add, remove and
// scale them) from either a fresh random starting shape or the best loop so
// far. Several independent searches run in parallel (one per Web Worker,
// see js/solve.js); the search ends once a number of rounds in a row
// haven't found anything better (SearchTracker).
// ==========================================================================

const SOLVER = {
    edgeReuseFactor: 8,       // cost multiplier for a street already on the loop
    nodeReusePenaltyM: 400,   // extra cost for crossing the loop at an intersection
    // A* heuristic weight. Above 1 the router explores far fewer nodes and
    // finds paths at most this factor longer than the shortest (in practice
    // within a few percent); the annealing evens that out.
    heuristicWeight: 1.15,
    coverageRows: 160,        // scanlines used to measure coverage
    maxWaypoints: 40,
    // Area mode: weight of the "bigger is better" tiebreak between loops of
    // equal roundness. Small, so it only decides near-ties.
    areaTiebreak: 0.005,
    // Annealing steps per search round.
    roundSteps: 400,
    // Passes of the end-of-round hill climb (see LoopSearch.climb).
    climbPasses: 3,
    // Each search keeps a pool of this many good loops. Once it's full, this
    // share of rounds starts from a fresh random shape (replacing the
    // pool's worst loop if it does better); the rest continue one of the
    // pool's loops.
    poolSize: 4,
    freshShare: 0.3,
    // Random starting shapes tried for a fresh round; the best one is used.
    freshTries: 6,
    // The search ends after convergeRounds + 4 × workers rounds in a row
    // that improve the best loop by less than minGain (relative); see
    // SearchTracker.
    convergeRounds: 12,
    minGain: 0.002
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
//   ptOff, ptX, ptY             in-between points of each edge (for coverage)
//   eStem                       start mode: distance from the start to the
//                               closest point of each edge
//   lat0, lng0, kx, ky          the projection
//   startX, startY              start mode: the start node
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
    source.forEach((edge, e) => {
        oFrom[e] = index.get(edge.from);
        oTo[e] = index.get(edge.to);
        oLen[e] = edge.distance;
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
    const chainOff = new Int32Array(E + 1);
    const ptOff = new Int32Array(E + 1);
    chains.forEach((chain, e) => {
        chainOff[e + 1] = chainOff[e] + chain.edges.length;
        ptOff[e + 1] = ptOff[e] + chain.interior.length;
    });
    const chainEdge = new Int32Array(chainOff[E]);
    const chainDir = new Int8Array(chainOff[E]);
    const ptX = new Float64Array(ptOff[E]);
    const ptY = new Float64Array(ptOff[E]);
    chains.forEach((chain, e) => {
        eFrom[e] = cid[chain.from];
        eTo[e] = cid[chain.to];
        let at = chain.from;
        chain.edges.forEach((oe, k) => {
            const dir = oFrom[oe] === at ? 1 : -1;
            chainEdge[chainOff[e] + k] = oe;
            chainDir[chainOff[e] + k] = dir;
            eLen[e] += oLen[oe];
            eCross[e] += dir * oCross[oe];
            at = other(oe, at);
        });
        chain.interior.forEach((i, k) => {
            ptX[ptOff[e] + k] = ox[i];
            ptY[ptOff[e] + k] = oy[i];
        });
    });
    const adjacency = buildAdjacency(M, eFrom, eTo);

    const data = {
        N: M, E, x, y, eFrom, eTo, eLen, eCross,
        adjOff: adjacency.adjOff, adjEdge: adjacency.adjEdge,
        ptOff, ptX, ptY, eStem: null,
        lat0, lng0, kx, ky
    };
    const prepared = {
        data, network, source, oFrom, oTo, chainOff, chainEdge, chainDir, project, unproject,
        stats: { nodes: N, junctions: M, edges: E }
    };

    // 3. Start mode: shortest paths from the start (on the full network, so
    //    the start may be on a dead-end street) to every node within half
    //    the length limit. Each merged edge remembers its closest node.
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
        const eStem = new Float64Array(E).fill(Infinity);
        const eStemNode = new Int32Array(E).fill(-1);
        chains.forEach((chain, e) => {
            for (const i of [chain.from, ...chain.interior, chain.to]) {
                if (dist[i] < eStem[e]) {
                    eStem[e] = dist[i];
                    eStemNode[e] = i;
                }
            }
        });
        data.eStem = eStem;
        data.startX = ox[startOrig];
        data.startY = oy[startOrig];
        Object.assign(prepared, { startOrig, stemPrev: prevEdge, eStemNode });
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

// Spatial index of the junctions, for snapping waypoints: a k-d tree laid
// out in one array (each range's middle element splits it, alternating x
// and y). Nearest-node queries take about log2(N) steps, even for points far
// from any road.
function buildKdTree(g) {
    const order = new Int32Array(g.N);
    for (let i = 0; i < g.N; i++) order[i] = i;
    const build = (lo, hi, axis) => {
        if (hi - lo < 2) return;
        const c = axis ? g.y : g.x;
        order.subarray(lo, hi).sort((a, b) => c[a] - c[b]);
        const mid = (lo + hi) >> 1;
        build(lo, mid, 1 - axis);
        build(mid + 1, hi, 1 - axis);
    };
    build(0, g.N, 0);
    return order;
}

// Nearest junction to (px, py).
function snapToNode(g, px, py) {
    const { x, y, kd } = g;
    let best = -1, bestD = Infinity;
    const search = (lo, hi, axis) => {
        if (lo >= hi) return;
        const mid = (lo + hi) >> 1;
        const n = kd[mid];
        const d = (x[n] - px) ** 2 + (y[n] - py) ** 2;
        if (d < bestD) {
            bestD = d;
            best = n;
        }
        const diff = axis ? py - y[n] : px - x[n];
        if (diff < 0) {
            search(lo, mid, 1 - axis);
            if (diff * diff < bestD) search(mid + 1, hi, 1 - axis);
        } else {
            search(mid + 1, hi, 1 - axis);
            if (diff * diff < bestD) search(lo, mid, 1 - axis);
        }
    };
    search(0, g.N, 0);
    return best;
}

// --------------------------------------------------------------------------
// A* routing with penalties for reusing the loop's own streets
// --------------------------------------------------------------------------

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

class Router {
    constructor(g) {
        this.g = g;
        this.cost = new Float64Array(g.N);
        this.prevEdge = new Int32Array(g.N);
        this.seen = new Uint32Array(g.N);
        this.closed = new Uint32Array(g.N);
        this.stamp = 0;
        this.usedEdge = new Uint32Array(g.E);
        this.usedNode = new Uint32Array(g.N);
        this.loopStamp = 0;
        this.heap = new MinHeap(1024);
    }

    beginLoop() {
        this.loopStamp++;
    }

    markUsed(edges) {
        const { g, loopStamp } = this;
        for (const e of edges) {
            this.usedEdge[e] = loopStamp;
            this.usedNode[g.eFrom[e]] = loopStamp;
            this.usedNode[g.eTo[e]] = loopStamp;
        }
    }

    // Returns the edge indexes of the cheapest path from src to dst, or null.
    route(src, dst) {
        const { g, cost, prevEdge, seen, closed, heap, usedEdge, usedNode, loopStamp } = this;
        const stamp = ++this.stamp;
        const tx = g.x[dst], ty = g.y[dst];
        const reuse = SOLVER.edgeReuseFactor;
        const nodePenalty = SOLVER.nodeReusePenaltyM;
        const greed = SOLVER.heuristicWeight;

        heap.size = 0;
        cost[src] = 0;
        seen[src] = stamp;
        prevEdge[src] = -1;
        heap.push(Math.hypot(g.x[src] - tx, g.y[src] - ty), src);

        while (heap.size > 0) {
            const u = heap.pop();
            if (closed[u] === stamp) continue;
            closed[u] = stamp;
            if (u === dst) break;

            const cu = cost[u];
            for (let k = g.adjOff[u]; k < g.adjOff[u + 1]; k++) {
                const e = g.adjEdge[k];
                const v = g.eFrom[e] === u ? g.eTo[e] : g.eFrom[e];
                if (closed[v] === stamp) continue;
                let c = cu + g.eLen[e] * (usedEdge[e] === loopStamp ? reuse : 1);
                if (usedNode[v] === loopStamp && v !== dst) c += nodePenalty;
                if (seen[v] !== stamp || c < cost[v]) {
                    seen[v] = stamp;
                    cost[v] = c;
                    prevEdge[v] = e;
                    heap.push(c + greed * Math.hypot(g.x[v] - tx, g.y[v] - ty), v);
                }
            }
        }

        if (closed[dst] !== stamp) return null;
        const path = [];
        for (let v = dst; v !== src;) {
            const e = prevEdge[v];
            path.push(e);
            v = g.eFrom[e] === v ? g.eTo[e] : g.eFrom[e];
        }
        return path.reverse();
    }
}

// --------------------------------------------------------------------------
// Paths through waypoints
// --------------------------------------------------------------------------

// Routes through the waypoint nodes in order; when `closed`, back to the
// first one as well. `reuse` (optional) maps "a,b" to a leg routed earlier
// between waypoints a and b; those legs are kept and only the missing ones
// are routed, which makes moving a single waypoint cheap.
// Returns { edges, dirs, nodes, endNode, length, cross, area, repeats, legs } or null.
function buildPath(g, router, waypoints, closed, reuse) {
    router.beginLoop();
    router.usedNode[waypoints[0]] = router.loopStamp;

    const k = waypoints.length;
    const legCount = closed ? k : k - 1;
    const keys = [];
    for (let j = 0; j < legCount; j++) keys.push(`${waypoints[j]},${waypoints[(j + 1) % k]}`);
    const legs = new Array(legCount);
    if (reuse) {
        keys.forEach((key, j) => {
            const leg = reuse.get(key);
            if (leg) {
                legs[j] = leg;
                router.markUsed(leg);
            }
        });
    }
    for (let j = 0; j < legCount; j++) {
        if (legs[j]) continue;
        const from = waypoints[j], to = waypoints[(j + 1) % k];
        const leg = from === to ? [] : router.route(from, to);
        if (!leg) return null;
        legs[j] = leg;
        router.markUsed(leg);
    }

    // Concatenate, dropping out-and-back spurs (an edge followed by itself).
    const edges = [];
    const dirs = [];
    let at = waypoints[0];
    for (const leg of legs) {
        for (const e of leg) {
            const forward = g.eFrom[e] === at;
            const dir = forward ? 1 : -1;
            const last = edges.length - 1;
            if (last >= 0 && edges[last] === e && dirs[last] === -dir) {
                edges.pop();
                dirs.pop();
            } else {
                edges.push(e);
                dirs.push(dir);
            }
            at = forward ? g.eTo[e] : g.eFrom[e];
        }
    }
    // A closed ring can also have a spur where it wraps around.
    let first = 0;
    if (closed) {
        while (edges.length - first > 2 && edges[first] === edges[edges.length - 1] && dirs[first] === -dirs[edges.length - 1]) {
            first++;
            edges.pop();
            dirs.pop();
        }
    }
    if (closed && edges.length - first < 2) return null;
    const firstNode = first === 0 ? waypoints[0] : dirs[first] === 1 ? g.eFrom[edges[first]] : g.eTo[edges[first]];

    const path = measurePath(g, edges.slice(first), dirs.slice(first), firstNode);
    path.legs = new Map(keys.map((key, j) => [key, legs[j]]));
    return path;
}

function measurePath(g, edges, dirs, firstNode) {
    let length = 0;
    let cross = 0;
    const nodes = new Array(edges.length);
    const nodeVisits = new Map();
    const edgeSet = new Set();
    let repeats = 0;
    let endNode = firstNode;

    for (let i = 0; i < edges.length; i++) {
        const e = edges[i];
        length += g.eLen[e];
        cross += dirs[i] * g.eCross[e];
        const n = dirs[i] === 1 ? g.eFrom[e] : g.eTo[e];
        endNode = dirs[i] === 1 ? g.eTo[e] : g.eFrom[e];
        nodes[i] = n;
        if (edgeSet.has(e)) repeats++;
        else edgeSet.add(e);
        const visits = (nodeVisits.get(n) || 0) + 1;
        nodeVisits.set(n, visits);
        if (visits > 1) repeats++;
    }
    return { edges, dirs, nodes, endNode, length, cross, area: Math.abs(cross) / 2, repeats };
}

// Outline of a path for the coverage check: every junction and in-between
// point, in order.
function pathOutline(g, path, xs, ys) {
    for (let i = 0; i < path.edges.length; i++) {
        const e = path.edges[i];
        const n = path.nodes[i];
        xs.push(g.x[n]);
        ys.push(g.y[n]);
        const a = g.ptOff[e], b = g.ptOff[e + 1];
        if (path.dirs[i] === 1) {
            for (let k = a; k < b; k++) {
                xs.push(g.ptX[k]);
                ys.push(g.ptY[k]);
            }
        } else {
            for (let k = b - 1; k >= a; k--) {
                xs.push(g.ptX[k]);
                ys.push(g.ptY[k]);
            }
        }
    }
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
// ruling the loop out, so the search can move through them.
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

// Measures a loop given as [[lat, lng], …] (closed or not) for an objective.
// Used to compare loops built from pieces of different road networks.
function measureCoordsLoop(coords, objective, targetOutline) {
    const lat0 = coords[0][0], lng0 = coords[0][1];
    const ky = DEG * EARTH_RADIUS_M;
    const kx = ky * Math.cos(lat0 * DEG);
    const xs = coords.map(c => (c[1] - lng0) * kx);
    const ys = coords.map(c => (c[0] - lat0) * ky);
    let cross = 0, length = 0;
    for (let i = 0; i < coords.length; i++) {
        const j = (i + 1) % coords.length;
        cross += xs[i] * ys[j] - xs[j] * ys[i];
        if (j > 0) length += haversine(coords[i][0], coords[i][1], coords[j][0], coords[j][1]);
    }
    const metrics = { length, area: Math.abs(cross) / 2, repeats: 0 };
    if (objective.mode === "area") {
        const meter = createCoverageMeter(targetOutline.map(p => ({ x: (p.lng - lng0) * kx, y: (p.lat - lat0) * ky })));
        metrics.coverage = meter.measure(xs, ys);
        objective = { ...objective, targetArea: meter.targetArea };
    }
    metrics.iq = 4 * Math.PI * metrics.area / length ** 2;
    return { ...metrics, ...scoreLoop(metrics, objective) };
}

// --------------------------------------------------------------------------
// Search (runs in a worker, or on the main thread as a fallback)
// --------------------------------------------------------------------------

// params:
//   mode            "start" | "area" | "refine"
//   start           { lat, lng }                 (start)
//   maxLengthM      number                       (start; also refine of a start loop)
//   target          [{ lat, lng }] outline       (area; also refine of an area loop)
//   coverage        0..1                         (area; also refine of an area loop)
//   objective       "start" | "area"             (refine: which score to use)
//   segment         [[lat, lng], …]              (refine: the stretch to improve, A → B)
//   fixed           [[lat, lng], …]              (refine: the rest of the loop, B → A)
// data: prepareGraph(…).data. seed: any number; each parallel search gets its own.
//
// run() is an endless generator: it yields after every annealing step, and
// { roundDone: true, improved } at the end of each round. leader() is the
// best loop so far.
class LoopSearch {
    constructor(data, params, seed) {
        const g = this.g = { ...data };
        g.kd = buildKdTree(g);
        g.project = (lat, lng) => ({ x: (lng - g.lng0) * g.kx, y: (lat - g.lat0) * g.ky });
        this.router = new Router(g);
        this.params = params;
        this.random = mulberry32(seed);
        this.isRefine = params.mode === "refine";
        const mode = this.isRefine ? params.objective : params.mode;
        this.isStart = mode === "start";
        this.objective = { mode, maxLengthM: params.maxLengthM, coverage: params.coverage };
        this.startNode = -1;
        this.endNode = -1;
        this.cache = new Map();
        this.evaluations = 0;
        this.rounds = 0;
        this.best = null;      // best feasible candidate
        this.bestAny = null;   // best candidate overall (fallback)
        this.pool = [];        // loops that rounds continue from
        this.direction = this.random() * 2 * Math.PI;   // start mode: next fresh circle's heading

        if (!this.isStart) {
            this.targetXY = params.target.map(p => g.project(p.lat, p.lng));
            this.coverageMeter = createCoverageMeter(this.targetXY);
            this.objective.targetArea = this.coverageMeter.targetArea;
        }

        if (this.isRefine) {
            // The fixed rest of the loop adds a constant length and shoelace
            // term; the path's ends are joined to it with straight lines.
            const segXY = params.segment.map(([lat, lng]) => g.project(lat, lng));
            const fixedXY = params.fixed.map(([lat, lng]) => g.project(lat, lng));
            const a = segXY[0], b = segXY[segXY.length - 1];
            this.startNode = snapToNode(g, a.x, a.y);
            this.endNode = snapToNode(g, b.x, b.y);
            let cross = 0, length = 0;
            for (let i = 1; i < fixedXY.length; i++) {
                const p = fixedXY[i - 1], q = fixedXY[i];
                cross += p.x * q.y - q.x * p.y;
                length += Math.hypot(q.x - p.x, q.y - p.y);
            }
            // Few enough points for a quick coverage check each step.
            const outline = simplifyLine(params.fixed.map(([lat, lng]) => ({ lat, lng })), 400).map(p => g.project(p.lat, p.lng));
            this.fixed = { first: fixedXY[0], last: fixedXY[fixedXY.length - 1], cross, length, outline };
            this.origin = centroid(segXY);
            this.segXY = segXY;
            this.scale = Math.max(polylineLength(segXY) / 6, 200);
        } else if (this.isStart) {
            this.origin = { x: g.startX, y: g.startY };
            this.scale = params.maxLengthM / (2 * Math.PI);
        } else {
            this.origin = centroid(this.targetXY);
            this.scale = Math.sqrt(this.coverageMeter.targetArea / Math.PI);
            this.hull = convexHull(this.targetXY);
        }
    }

    leader() {
        return this.best || this.bestAny;
    }

    // Whole-loop metrics and score for a candidate path.
    evaluate(path) {
        if (!path) return { score: -Infinity, feasible: false };
        const { g, fixed } = this;
        const metrics = { length: path.length, area: path.area, repeats: path.repeats, stem: 0 };
        let xs = null, ys = null;
        if (this.isRefine) {
            const end = { x: g.x[path.endNode], y: g.y[path.endNode] };
            const begin = { x: g.x[this.startNode], y: g.y[this.startNode] };
            const cross = path.cross + fixed.cross +
                (end.x * fixed.first.y - fixed.first.x * end.y) +
                (fixed.last.x * begin.y - begin.x * fixed.last.y);
            metrics.length = path.length + fixed.length;
            metrics.area = Math.abs(cross) / 2;
            if (!this.isStart) {
                xs = [];
                ys = [];
                pathOutline(g, path, xs, ys);
                xs.push(end.x, ...fixed.outline.map(p => p.x));
                ys.push(end.y, ...fixed.outline.map(p => p.y));
            }
        } else if (this.isStart) {
            // The run goes out from the start to the ring's closest point and
            // back the same way.
            let stem = Infinity, stemEdge = -1;
            for (const e of path.edges) {
                if (g.eStem[e] < stem) {
                    stem = g.eStem[e];
                    stemEdge = e;
                }
            }
            if (stemEdge === -1) return { score: -Infinity, feasible: false };
            metrics.stem = stem;
            metrics.length += 2 * stem;
            path.stemEdge = stemEdge;
        } else {
            xs = [];
            ys = [];
            pathOutline(g, path, xs, ys);
        }
        if (xs) metrics.coverage = this.coverageMeter.measure(xs, ys);
        metrics.iq = 4 * Math.PI * metrics.area / metrics.length ** 2;
        path.metrics = metrics;
        return scoreLoop(metrics, this.objective);
    }

    // Waypoints are kept as continuous positions and snapped on evaluation.
    tryWaypoints(points, base) {
        const { g, startNode, endNode } = this;
        const nodes = [];
        if (this.isRefine) nodes.push(startNode);
        for (const p of points) {
            const n = snapToNode(g, p.x, p.y);
            if (nodes[nodes.length - 1] !== n && n !== startNode && n !== endNode) nodes.push(n);
        }
        if (this.isRefine) {
            if (nodes[nodes.length - 1] !== endNode) nodes.push(endNode);
        } else {
            while (nodes.length > 2 && nodes[nodes.length - 1] === nodes[0]) nodes.pop();
        }
        const key = nodes.join(",");
        let entry = this.cache.get(key);
        if (!entry) {
            this.evaluations++;
            const path = nodes.length >= 2 ? buildPath(g, this.router, nodes, !this.isRefine, base?.loop?.legs) : null;
            entry = { loop: path, ...this.evaluate(path) };
            if (this.cache.size > 5000) this.cache.clear();
            this.cache.set(key, entry);
        }
        return { points, ...entry };
    }

    consider(cand) {
        if (!cand.loop) return;
        if (!this.bestAny || cand.score > this.bestAny.score) this.bestAny = cand;
        if (cand.feasible && (!this.best || cand.score > this.best.score)) this.best = cand;
    }

    *run() {
        for (;;) {
            const before = this.leader();
            yield* this.round();
            this.rounds++;
            yield { roundDone: true, improved: this.leader() !== before };
        }
    }

    // The best of a few random starting shapes (start mode: just one, as
    // they are spread out by direction).
    *freshCandidate() {
        let best = null;
        const tries = this.isStart ? 1 : SOLVER.freshTries;
        for (let i = 0; i < tries; i++) {
            const cand = yield* this.randomShape();
            if (cand?.loop && (!best || cand.score > best.score)) best = cand;
            if (this.isRefine && this.rounds === 0) break;
        }
        return best;
    }

    // A starting shape, with some randomness so every round differs.
    *randomShape() {
        const { origin, scale, random } = this;
        if (this.isRefine) {
            // The current stretch itself, as waypoints along it.
            const count = Math.round(Math.min(30, Math.max(3, polylineLength(this.segXY) / 800)));
            const jitter = this.rounds === 0 ? 0 : scale * 0.15;
            const points = resampleLine(this.segXY, count + 2).slice(1, -1)
                .map(p => ({ x: p.x + this.gauss() * jitter, y: p.y + this.gauss() * jitter }));
            const cand = this.tryWaypoints(points);
            this.consider(cand);
            return cand;
        }
        if (this.isStart) {
            // A circle through the start, resized until the loop fits the
            // length limit. Successive circles head off in directions spread
            // evenly around the start (golden-angle steps), so no direction
            // is left out.
            const theta = this.direction;
            this.direction += GOLDEN_ANGLE;
            const count = 6 + Math.floor(random() * 5);
            let radius = scale * (0.7 + random() * 0.3);
            let cand = null;
            for (let attempt = 0; attempt < 4; attempt++) {
                cand = this.tryWaypoints(circleWaypoints(origin, theta, radius, count));
                this.consider(cand);
                if (!cand.loop) break;
                radius *= Math.min(1.5, Math.max(0.5, (0.97 * this.params.maxLengthM) / cand.loop.metrics.length));
                yield null;
            }
            return cand;
        }
        // The outline itself, its convex hull (better for jagged outlines
        // such as city limits) or a circle of about the same area, at a
        // random size and with the waypoints at random offsets.
        const count = Math.round(Math.min(40, Math.max(10, polygonPerimeter(this.hull) / 600)));
        const kind = random();
        let ring, f;
        if (kind < 0.4) {
            ring = this.targetXY;
            f = Math.sqrt(this.params.coverage) + random() * 0.1;
        } else if (kind < 0.75) {
            ring = this.hull;
            f = 0.85 + random() * 0.2;
        } else {
            ring = Array.from({ length: 64 }, (_, i) => ({
                x: origin.x + scale * Math.cos((2 * Math.PI * i) / 64),
                y: origin.y + scale * Math.sin((2 * Math.PI * i) / 64)
            }));
            f = 0.95 + random() * 0.3;
        }
        const shift = Math.floor(random() * ring.length);
        const points = resample(ring.slice(shift).concat(ring.slice(0, shift)), count).map(p => ({
            x: origin.x + (p.x - origin.x) * f,
            y: origin.y + (p.y - origin.y) * f
        }));
        const cand = this.tryWaypoints(points);
        this.consider(cand);
        return cand;
    }

    // One round of simulated annealing over the waypoint positions, either
    // from a fresh shape (hot) or from one of the pool's loops (cooler,
    // smaller moves). The pool keeps a few good loops from different
    // starts, so a promising new one gets several rounds to mature instead
    // of having to beat the best loop straight away.
    *round() {
        const { g, origin, scale, random, isRefine, pool } = this;
        const fresh = pool.length < SOLVER.poolSize || random() < SOLVER.freshShare;
        const slot = fresh ? -1 : Math.floor(random() * pool.length);
        let current = fresh ? yield* this.freshCandidate() : pool[slot];
        if (!current?.loop) current = this.leader();
        if (!current?.loop) return;

        const heat = fresh ? 1 : 0.35;
        const steps = SOLVER.roundSteps;
        const minPoints = isRefine ? 0 : 3;
        let roundBest = current;
        let sinceImprovement = 0;
        for (let step = 0; step < steps; step++) {
            const t = step / steps;
            const temperature = 0.08 * heat * (1 - t) ** 2 + 0.002;
            const sigma = scale * (0.3 * heat * (1 - t) + 0.03);
            const points = current.points.map(p => ({ x: p.x, y: p.y }));
            const roll = random();

            if (points.length > 0 && (roll < 0.6 || points.length < 4)) {
                const i = Math.floor(random() * points.length);
                points[i] = { x: points[i].x + this.gauss() * sigma, y: points[i].y + this.gauss() * sigma };
            } else if (roll < 0.75 && !isRefine) {
                const f = 1 + this.gauss() * 0.06 * (heat * (1 - t) + 0.2);
                for (const p of points) {
                    p.x = origin.x + (p.x - origin.x) * f;
                    p.y = origin.y + (p.y - origin.y) * f;
                }
            } else if (roll < 0.88 && points.length < SOLVER.maxWaypoints) {
                // Insert a point between two neighbours, pushed outward (or,
                // when refining, to a random side).
                let a, b;
                const i = Math.floor(random() * (points.length + (isRefine ? 1 : 0))) - (isRefine ? 1 : 0);
                if (isRefine) {
                    a = i >= 0 ? points[i] : { x: g.x[this.startNode], y: g.y[this.startNode] };
                    b = i + 1 < points.length ? points[i + 1] : { x: g.x[this.endNode], y: g.y[this.endNode] };
                } else {
                    a = points[i];
                    b = points[(i + 1) % points.length];
                }
                const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
                let ox = mid.x - origin.x, oy = mid.y - origin.y;
                if (isRefine) {
                    const side = random() < 0.5 ? 1 : -1;
                    ox = -(b.y - a.y) * side;
                    oy = (b.x - a.x) * side;
                }
                const len = Math.hypot(ox, oy) || 1;
                const push = Math.abs(this.gauss()) * sigma * 0.5;
                points.splice(i + 1, 0, { x: mid.x + (ox / len) * push, y: mid.y + (oy / len) * push });
            } else if (points.length > minPoints) {
                points.splice(Math.floor(random() * points.length), 1);
            } else {
                continue;
            }

            const cand = this.tryWaypoints(points, current);
            this.consider(cand);
            const ref = Math.max(Math.abs(current.score), 1e-9);
            if (cand.score >= current.score || random() < Math.exp((cand.score - current.score) / (temperature * ref))) {
                current = cand;
            }
            if (cand.loop && cand.score > roundBest.score) {
                roundBest = cand;
                sinceImprovement = 0;
            } else if (++sinceImprovement > 120) {
                current = roundBest;
                sinceImprovement = 0;
            }
            yield null;
        }

        // Polish: drop any waypoint whose removal improves the loop. This
        // clears out-and-back spikes (e.g. up one side of a divided road and
        // back down the other) that random moves only remove occasionally.
        let final = roundBest;
        for (let pass = 0, changed = true; changed && pass < 3; pass++) {
            changed = false;
            for (let i = 0; i < final.points.length && final.points.length > minPoints; i++) {
                const cand = this.tryWaypoints(final.points.filter((_, k) => k !== i), final);
                if (cand.loop && cand.score > final.score && (cand.feasible || !final.feasible)) {
                    final = cand;
                    this.consider(cand);
                    changed = true;
                    i--;
                }
            }
            yield null;
        }
        final = yield* this.climb(final);

        if (slot >= 0) {
            if (isBetterResult(final, pool[slot])) pool[slot] = final;
        } else if (pool.length < SOLVER.poolSize) {
            pool.push(final);
        } else {
            let worst = 0;
            for (let i = 1; i < pool.length; i++) if (isBetterResult(pool[worst], pool[i])) worst = i;
            if (isBetterResult(final, pool[worst])) pool[worst] = final;
        }
    }

    // Hill climb on the road graph: move each waypoint to each neighbouring
    // junction (one or two streets away) and keep any move that improves the
    // loop, until none does.
    *climb(cand) {
        const { g } = this;
        for (let pass = 0, changed = true; changed && pass < SOLVER.climbPasses; pass++) {
            changed = false;
            for (let i = 0; i < cand.points.length; i++) {
                const p = cand.points[i];
                const n = snapToNode(g, p.x, p.y);
                const near = new Set();
                for (let k = g.adjOff[n]; k < g.adjOff[n + 1]; k++) {
                    const e = g.adjEdge[k];
                    const m = g.eFrom[e] === n ? g.eTo[e] : g.eFrom[e];
                    near.add(m);
                    for (let j = g.adjOff[m]; j < g.adjOff[m + 1]; j++) {
                        const f = g.adjEdge[j];
                        near.add(g.eFrom[f] === m ? g.eTo[f] : g.eFrom[f]);
                    }
                }
                near.delete(n);
                for (const m of near) {
                    const points = cand.points.slice();
                    points[i] = { x: g.x[m], y: g.y[m] };
                    const next = this.tryWaypoints(points, cand);
                    if (next.loop && isBetterResult(next, cand)) {
                        this.consider(next);
                        cand = next;
                        changed = true;
                        break;
                    }
                }
                yield null;
            }
        }
        return cand;
    }

    gauss() {
        return Math.sqrt(-2 * Math.log(this.random() + 1e-12)) * Math.cos(2 * Math.PI * this.random());
    }

    // The leader as plain data (for postMessage): merged edges, directions,
    // waypoints and measurements. See expandLoop() for the road geometry.
    result() {
        const cand = this.leader();
        if (!cand) return null;
        const { loop } = cand;
        return {
            edges: loop.edges,
            dirs: loop.dirs,
            stemEdge: loop.stemEdge ?? -1,
            points: cand.points.map(p => ({ x: p.x, y: p.y })),
            metrics: loop.metrics,
            score: cand.score,
            feasible: cand.feasible
        };
    }
}

// Decides when a search is done: after enough rounds in a row (from all
// parallel searches together) that brought no real improvement, and at
// least half as many as it took to find the best loop. A search that is
// still finding better loops late keeps going.
class SearchTracker {
    constructor(workers) {
        this.minStale = SOLVER.convergeRounds + 4 * workers;
        this.needed = this.minStale;
        this.stale = 0;
        this.rounds = 0;
        this.best = null;
    }

    // Reports a finished round and the reporting search's best loop (or
    // null if it didn't change). Returns true if that is the new overall best.
    report(result) {
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

const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

const noLoopMessage = (params) => params.mode === "refine" ? "Couldn't route this stretch."
    : params.mode === "start" ? "Couldn't form a loop here. Try a larger distance or a different start point."
    : "Couldn't form a loop here. Try a larger area.";

const isBetterResult = (a, b) => !b || (a.feasible && !b.feasible) || (a.feasible === b.feasible && a.score > b.score);

// --------------------------------------------------------------------------
// Results (main thread)
// --------------------------------------------------------------------------

// Turns a search result into road geometry and measurements. For a start
// loop with a stem, the coordinates run start → ring → start.
// For a refine search, `coords` is the new stretch only (A → B).
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
    if (params.mode === "start" && res.stemEdge >= 0) {
        const anchor = prep.eStemNode[res.stemEdge];
        const at = Math.max(0, steps.findIndex(s => tail(s) === anchor));
        const ring = steps.slice(at).concat(steps.slice(0, at));
        // Stem: from the anchor back to the start along the shortest path.
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

    const coords = [];
    for (const [e, dir] of ordered) {
        const geometry = prep.source[e].coords;
        const line = dir === 1 ? geometry : [...geometry].reverse();
        for (let k = coords.length ? 1 : 0; k < line.length; k++) coords.push(line[k]);
    }

    const m = res.metrics;
    const result = {
        mode: params.mode,
        coords,                       // loops: closed, first point === last point
        lengthM: m.length,
        areaM2: m.area,
        iq: 4 * Math.PI * m.area / m.length ** 2,
        repeats: m.repeats,
        stemM,
        score: res.score,
        feasible: res.feasible
    };

    if (params.mode === "area") {
        // Coverage on the full road geometry for the final answer.
        const targetXY = params.target.map(p => prep.project(p.lat, p.lng));
        const xy = exact ? coords.map(([lat, lng]) => prep.project(lat, lng)) : null;
        result.coverage = xy ? createCoverageMeter(targetXY).measure(xy.map(p => p.x), xy.map(p => p.y)) : m.coverage;
    } else if (m.coverage !== undefined) {
        result.coverage = m.coverage;
    }
    if (params.mode === "start") {
        result.start = prep.unproject(prep.data.startX, prep.data.startY);
    }
    return result;
}

// --------------------------------------------------------------------------
// Small helpers
// --------------------------------------------------------------------------

// Waypoints on a circle of the given radius that passes through `origin`,
// with its center in direction theta, starting at the origin.
function circleWaypoints(origin, theta, radius, count) {
    const cx = origin.x + radius * Math.cos(theta);
    const cy = origin.y + radius * Math.sin(theta);
    const phi0 = theta + Math.PI;
    const points = [];
    for (let j = 0; j < count; j++) {
        const phi = phi0 + (2 * Math.PI * j) / count;
        points.push({ x: cx + radius * Math.cos(phi), y: cy + radius * Math.sin(phi) });
    }
    return points;
}

function centroid(points) {
    let area = 0, cx = 0, cy = 0;
    for (let i = 0; i < points.length; i++) {
        const a = points[i], b = points[(i + 1) % points.length];
        const c = a.x * b.y - b.x * a.y;
        area += c;
        cx += (a.x + b.x) * c;
        cy += (a.y + b.y) * c;
    }
    if (Math.abs(area) < 1e-9) {
        return { x: points.reduce((s, p) => s + p.x, 0) / points.length, y: points.reduce((s, p) => s + p.y, 0) / points.length };
    }
    return { x: cx / (3 * area), y: cy / (3 * area) };
}

function polygonPerimeter(points) {
    return polylineLength(points) + Math.hypot(points[0].x - points[points.length - 1].x, points[0].y - points[points.length - 1].y);
}

function polylineLength(points) {
    let total = 0;
    for (let i = 1; i < points.length; i++) total += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
    return total;
}

// `count` points evenly spaced along a closed polygon.
function resample(points, count) {
    return resampleAlong([...points, points[0]], count, false);
}

// `count` points evenly spaced along an open line, including both ends.
function resampleLine(points, count) {
    return resampleAlong(points, count, true);
}

function resampleAlong(points, count, includeEnd) {
    const cum = [0];
    for (let i = 1; i < points.length; i++) {
        cum.push(cum[i - 1] + Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y));
    }
    const total = cum[cum.length - 1];
    const step = total / (includeEnd ? Math.max(1, count - 1) : count);
    const out = [];
    let i = 0;
    for (let k = 0; k < count; k++) {
        const want = Math.min(total, k * step);
        while (i < points.length - 2 && cum[i + 1] < want) i++;
        const span = cum[i + 1] - cum[i];
        const f = span > 0 ? (want - cum[i]) / span : 0;
        out.push({ x: points[i].x + (points[i + 1].x - points[i].x) * f, y: points[i].y + (points[i + 1].y - points[i].y) * f });
    }
    return out;
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

if (typeof module !== "undefined") {
    module.exports = { prepareGraph, LoopSearch, SearchTracker, expandLoop, createCoverageMeter, measureCoordsLoop, scoreLoop };
}
