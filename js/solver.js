// ==========================================================================
// Loop solver
//
// Finds a closed loop on the road network that encloses as much territory as
// possible. Two objectives are supported (plus "refine", which improves one
// stretch of an existing loop; see solveLoop):
//
//   "start"  The loop must pass through a start point and be no longer than
//            maxLengthM. Maximizes the enclosed area.
//   "area"   No start point. Maximizes the isoperimetric quotient
//            (4π·area / length², 1 for a perfect circle) among loops that
//            cover at least `coverage` of a target shape. Ties go to the
//            loop enclosing more area.
//
// Method: a loop is described by a ring of waypoints. Consecutive waypoints
// are joined with A* shortest paths, where streets already used by the loop
// are made expensive so the loop doesn't run the same street twice. The
// waypoints are then improved by simulated annealing (move, add, remove and
// scale waypoints), starting from circles or from the target shape's outline.
//
// solveLoop() is a generator so that the caller can run it in a Web Worker or
// in time slices on the main thread. It yields { fraction, best? } and
// returns the final result (see buildResult).
// ==========================================================================

const SOLVER = {
    edgeReuseFactor: 8,       // cost multiplier for a street already on the loop
    nodeReusePenaltyM: 400,   // extra cost for crossing the loop at an intersection
    gridCellM: 250,           // spatial index cell size for snapping
    coverageRows: 160,        // scanlines used to measure coverage
    maxWaypoints: 40,
    // Area mode: weight of the "bigger is better" tiebreak between loops of
    // equal roundness. Small, so it only decides near-ties.
    areaTiebreak: 0.005
};

// --------------------------------------------------------------------------
// Compact graph
// --------------------------------------------------------------------------

function compileGraph(network) {
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

    const x = new Float64Array(N);
    const y = new Float64Array(N);
    ids.forEach((id, i) => {
        const n = network.nodes.get(id);
        x[i] = (n.lng - lng0) * kx;
        y[i] = (n.lat - lat0) * ky;
    });

    // Edges (self-loops are dropped: they can't be part of a simple loop).
    const source = [];
    for (const edge of network.edges) {
        if (edge.from !== edge.to && index.has(edge.from) && index.has(edge.to)) source.push(edge);
    }
    const E = source.length;
    const eFrom = new Int32Array(E);
    const eTo = new Int32Array(E);
    const eLen = new Float64Array(E);
    const eCross = new Float64Array(E);   // shoelace sum along the edge's geometry
    const degree = new Int32Array(N);

    source.forEach((edge, e) => {
        eFrom[e] = index.get(edge.from);
        eTo[e] = index.get(edge.to);
        eLen[e] = edge.distance;
        let cross = 0;
        for (let i = 1; i < edge.coords.length; i++) {
            const [aLat, aLng] = edge.coords[i - 1];
            const [bLat, bLng] = edge.coords[i];
            const ax = (aLng - lng0) * kx, ay = (aLat - lat0) * ky;
            const bx = (bLng - lng0) * kx, by = (bLat - lat0) * ky;
            cross += ax * by - bx * ay;
        }
        eCross[e] = cross;
        degree[eFrom[e]]++;
        degree[eTo[e]]++;
    });

    // Compressed adjacency lists.
    const adjOff = new Int32Array(N + 1);
    for (let i = 0; i < N; i++) adjOff[i + 1] = adjOff[i] + degree[i];
    const fill = adjOff.slice(0, N);
    const adjEdge = new Int32Array(2 * E);
    for (let e = 0; e < E; e++) {
        adjEdge[fill[eFrom[e]]++] = e;
        adjEdge[fill[eTo[e]]++] = e;
    }

    const g = { N, E, x, y, ids, eFrom, eTo, eLen, eCross, adjOff, adjEdge, source, project, unproject };
    g.main = largestComponent(g);
    g.grid = buildGrid(g);
    return g;
}

// Marks the nodes of the largest connected component; waypoints are only
// snapped to these so every pair of waypoints is reachable.
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

// Spatial index of the snapping candidates: intersections (3+ streets) in the
// main component. Dead ends make poor waypoints, since reaching one means
// running the same street back out.
function buildGrid(g) {
    const cells = new Map();
    const size = SOLVER.gridCellM;
    const key = (cx, cy) => cx * 1048576 + cy;
    for (let i = 0; i < g.N; i++) {
        if (!g.main[i] || g.adjOff[i + 1] - g.adjOff[i] < 3) continue;
        const k = key(Math.floor(g.x[i] / size), Math.floor(g.y[i] / size));
        if (!cells.has(k)) cells.set(k, []);
        cells.get(k).push(i);
    }
    return { cells, size, key };
}

// Nearest intersection of the main component to (px, py).
function snapToNode(g, px, py) {
    const { cells, size, key } = g.grid;
    const cx = Math.floor(px / size);
    const cy = Math.floor(py / size);
    let best = -1, bestD = Infinity;

    for (let r = 0; r < 400; r++) {
        // Once a node is found, one more ring is enough to be sure it's nearest.
        if (best !== -1 && (r - 1) * size > Math.sqrt(bestD)) break;
        for (let i = cx - r; i <= cx + r; i++) {
            for (let j = cy - r; j <= cy + r; j++) {
                if (Math.max(Math.abs(i - cx), Math.abs(j - cy)) !== r) continue;
                const list = cells.get(key(i, j));
                if (!list) continue;
                for (const n of list) {
                    const d = (g.x[n] - px) ** 2 + (g.y[n] - py) ** 2;
                    if (d < bestD) {
                        bestD = d;
                        best = n;
                    }
                }
            }
        }
    }
    if (best === -1) {
        for (let n = 0; n < g.N; n++) {
            if (!g.main[n] || g.adjOff[n + 1] - g.adjOff[n] < 3) continue;
            const d = (g.x[n] - px) ** 2 + (g.y[n] - py) ** 2;
            if (d < bestD) {
                bestD = d;
                best = n;
            }
        }
    }
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
                    heap.push(c + Math.hypot(g.x[v] - tx, g.y[v] - ty), v);
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
    if (closed && edges.length < 2) return null;

    const path = measurePath(g, edges, dirs, waypoints[0]);
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
// Search
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
//   timeBudgetMs    number
//   seed            number (optional)
// control: { stop: boolean } (optional). Setting stop ends the search early;
// the best loop so far is still returned.
function* solveLoop(network, params, control = {}) {
    const startTime = Date.now();
    const g = compileGraph(network);
    if (g.main.size < 3) throw new Error("The road network here is too small to make a loop.");

    const router = new Router(g);
    const random = mulberry32(params.seed ?? 12345);
    const gauss = () => Math.sqrt(-2 * Math.log(random() + 1e-12)) * Math.cos(2 * Math.PI * random());
    const isRefine = params.mode === "refine";
    const objectiveMode = isRefine ? params.objective : params.mode;
    const isStart = objectiveMode === "start";
    const closed = !isRefine;

    // Problem-specific setup ---------------------------------------------
    let startNode = -1, endNode = -1, origin, scale, coverageMeter = null, targetXY = null;
    const objective = { mode: objectiveMode, maxLengthM: params.maxLengthM, coverage: params.coverage };

    if (!isStart) {
        targetXY = params.target.map(p => g.project(p.lat, p.lng));
        coverageMeter = createCoverageMeter(targetXY);
        objective.targetArea = coverageMeter.targetArea;
    }

    // Refine mode: the fixed rest of the loop adds a constant length and
    // shoelace term; the path's ends are joined to it with straight lines.
    let fixed = null;
    if (isRefine) {
        const segXY = params.segment.map(([lat, lng]) => g.project(lat, lng));
        const fixedXY = params.fixed.map(([lat, lng]) => g.project(lat, lng));
        const a = segXY[0], b = segXY[segXY.length - 1];
        startNode = snapToNode(g, a.x, a.y);
        endNode = snapToNode(g, b.x, b.y);
        let cross = 0, length = 0;
        for (let i = 1; i < fixedXY.length; i++) {
            const p = fixedXY[i - 1], q = fixedXY[i];
            cross += p.x * q.y - q.x * p.y;
            length += Math.hypot(q.x - p.x, q.y - p.y);
        }
        // Few enough points for a quick coverage check each step.
        const outline = simplifyLine(params.fixed.map(([lat, lng]) => ({ lat, lng })), 400).map(p => g.project(p.lat, p.lng));
        fixed = { xy: fixedXY, first: fixedXY[0], last: fixedXY[fixedXY.length - 1], cross, length, outline };
        origin = centroid(segXY);
        let segLength = 0;
        for (let i = 1; i < segXY.length; i++) segLength += Math.hypot(segXY[i].x - segXY[i - 1].x, segXY[i].y - segXY[i - 1].y);
        scale = Math.max(segLength / 6, 200);
    } else if (isStart) {
        const p = g.project(params.start.lat, params.start.lng);
        startNode = snapToNode(g, p.x, p.y);
        origin = { x: g.x[startNode], y: g.y[startNode] };
        scale = params.maxLengthM / (2 * Math.PI);
    } else {
        origin = centroid(targetXY);
        scale = Math.sqrt(coverageMeter.targetArea / Math.PI);
    }

    // Whole-loop metrics for a candidate path.
    const evaluate = (path) => {
        if (!path) return { score: -Infinity, feasible: false };
        const metrics = { length: path.length, area: path.area, repeats: path.repeats };
        let xs = null, ys = null;
        if (isRefine) {
            const end = { x: g.x[path.endNode], y: g.y[path.endNode] };
            const begin = { x: g.x[startNode], y: g.y[startNode] };
            const cross = path.cross + fixed.cross +
                (end.x * fixed.first.y - fixed.first.x * end.y) +
                (fixed.last.x * begin.y - begin.x * fixed.last.y);
            metrics.length = path.length + fixed.length;
            metrics.area = Math.abs(cross) / 2;
            if (!isStart) {
                xs = path.nodes.map(n => g.x[n]).concat([end.x], fixed.outline.map(p => p.x));
                ys = path.nodes.map(n => g.y[n]).concat([end.y], fixed.outline.map(p => p.y));
            }
        } else if (!isStart) {
            xs = path.nodes.map(n => g.x[n]);
            ys = path.nodes.map(n => g.y[n]);
        }
        if (!isStart) metrics.coverage = coverageMeter.measure(xs, ys);
        metrics.iq = 4 * Math.PI * metrics.area / metrics.length ** 2;
        path.metrics = metrics;
        return scoreLoop(metrics, objective);
    };

    // Waypoint sets are kept as continuous positions and snapped on evaluation.
    const cache = new Map();
    let evaluations = 0;
    const tryWaypoints = (points, base) => {
        const nodes = [];
        if (startNode >= 0) nodes.push(startNode);
        for (const p of points) {
            const n = snapToNode(g, p.x, p.y);
            if (nodes[nodes.length - 1] !== n && n !== startNode && n !== endNode) nodes.push(n);
        }
        if (isRefine) {
            if (nodes[nodes.length - 1] !== endNode) nodes.push(endNode);
        } else if (nodes.length > 2 && nodes[nodes.length - 1] === nodes[0]) {
            nodes.pop();
        }
        const key = nodes.join(",");
        let entry = cache.get(key);
        if (!entry) {
            evaluations++;
            const minNodes = isRefine ? 2 : isStart ? 2 : 3;
            const path = nodes.length >= minNodes ? buildPath(g, router, nodes, closed, base?.loop?.legs) : null;
            entry = { loop: path, ...evaluate(path) };
            if (cache.size > 5000) cache.clear();
            cache.set(key, entry);
        }
        return { points, ...entry };
    };

    let best = null;           // best feasible candidate
    let bestAny = null;        // best candidate overall (fallback)
    const consider = (cand) => {
        let improved = false;
        if (!bestAny || cand.score > bestAny.score) bestAny = cand;
        if (cand.feasible && (!best || cand.score > best.score)) {
            best = cand;
            improved = true;
        }
        return improved;
    };
    const fraction = () => Math.min(1, (Date.now() - startTime) / params.timeBudgetMs);
    const progress = (improved) => ({
        fraction: fraction(),
        evaluations,
        best: improved && !isRefine ? buildResult(g, best, params, startNode, targetXY, false) : null
    });

    // Initial candidates ---------------------------------------------------
    const seeds = [];
    if (isRefine) {
        // The current stretch itself, as waypoints along it.
        const segXY = params.segment.map(([lat, lng]) => g.project(lat, lng));
        let length = 0;
        for (let i = 1; i < segXY.length; i++) length += Math.hypot(segXY[i].x - segXY[i - 1].x, segXY[i].y - segXY[i - 1].y);
        const count = Math.round(Math.min(30, Math.max(3, length / 800)));
        const points = resampleLine(segXY, count + 2).slice(1, -1);
        const cand = tryWaypoints(points);
        consider(cand);
        seeds.push(cand);
    } else if (isStart) {
        const directions = 8;
        for (let d = 0; d < directions && !control.stop; d++) {
            const theta = (2 * Math.PI * d) / directions;
            let radius = scale * 0.8;
            let cand = null;
            // Resize the circle until the routed loop fits the length limit.
            for (let attempt = 0; attempt < 4; attempt++) {
                cand = tryWaypoints(circleWaypoints(origin, theta, radius, 8));
                consider(cand);
                if (!cand.loop) break;
                radius *= Math.min(1.5, Math.max(0.5, (0.97 * params.maxLengthM) / cand.loop.length));
                yield progress(false);
            }
            if (cand) seeds.push(cand);
        }
    } else {
        // The outline itself at a few scales, its convex hull (better for
        // jagged outlines such as city limits) and circles of about the same
        // area around its center.
        const hull = convexHull(targetXY);
        const count = Math.round(Math.min(40, Math.max(10, polygonPerimeter(hull) / 600)));
        const radius = Math.sqrt(coverageMeter.targetArea / Math.PI);
        const circle = Array.from({ length: count }, (_, i) => ({
            x: origin.x + radius * Math.cos((2 * Math.PI * i) / count),
            y: origin.y + radius * Math.sin((2 * Math.PI * i) / count)
        }));
        const shapes = [
            ...[Math.sqrt(params.coverage) + 0.02, 1.0, 1.06].map(f => [resample(targetXY, count), f]),
            ...[0.9, 1.0].map(f => [resample(hull, count), f]),
            ...[0.95, 1.1, 1.25].map(f => [circle, f])
        ];
        for (const [points, f] of shapes) {
            if (control.stop) break;
            const cand = tryWaypoints(points.map(p => ({
                x: origin.x + (p.x - origin.x) * f,
                y: origin.y + (p.y - origin.y) * f
            })));
            consider(cand);
            seeds.push(cand);
            yield progress(false);
        }
    }
    if (best) yield progress(true);

    seeds.sort((a, b) => b.score - a.score);
    let current = best || seeds[0];
    if (!current || !current.loop) {
        throw new Error(isRefine ? "Couldn't route this stretch." :
            "Couldn't form a loop here. Try a larger distance or a different start point.");
    }

    // Simulated annealing over waypoint positions -------------------------
    let sinceImprovement = 0;
    while (Date.now() - startTime < params.timeBudgetMs && !control.stop) {
        const t = fraction();
        const temperature = 0.08 * (1 - t) ** 2 + 0.002;
        const sigma = scale * (0.3 * (1 - t) + 0.03);
        const points = current.points.map(p => ({ ...p }));
        const roll = random();
        const minPoints = isRefine ? 0 : isStart ? 2 : 3;

        if (points.length > 0 && (roll < 0.6 || points.length < 4)) {
            const i = Math.floor(random() * points.length);
            points[i] = { x: points[i].x + gauss() * sigma, y: points[i].y + gauss() * sigma };
        } else if (roll < 0.75 && !isRefine) {
            const f = 1 + gauss() * 0.06 * (1 - t + 0.2);
            for (const p of points) {
                p.x = origin.x + (p.x - origin.x) * f;
                p.y = origin.y + (p.y - origin.y) * f;
            }
        } else if (roll < 0.88 && points.length < SOLVER.maxWaypoints) {
            // Insert a point between two neighbours, pushed outward (or, when
            // refining, to a random side).
            const i = Math.floor(random() * (points.length + 1)) - 1;
            const a = i >= 0 ? points[i] : { x: g.x[startNode], y: g.y[startNode] };
            const b = i + 1 < points.length ? points[i + 1]
                : isRefine ? { x: g.x[endNode], y: g.y[endNode] }
                : isStart ? origin : points[0];
            const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
            let ox = mid.x - origin.x, oy = mid.y - origin.y;
            if (isRefine) {
                const side = random() < 0.5 ? 1 : -1;
                ox = -(b.y - a.y) * side;
                oy = (b.x - a.x) * side;
            }
            const len = Math.hypot(ox, oy) || 1;
            const push = Math.abs(gauss()) * sigma * 0.5;
            points.splice(i + 1, 0, { x: mid.x + (ox / len) * push, y: mid.y + (oy / len) * push });
        } else if (points.length > minPoints) {
            points.splice(Math.floor(random() * points.length), 1);
        } else {
            continue;
        }

        const cand = tryWaypoints(points, current);
        const improved = consider(cand);
        const ref = Math.max(Math.abs(current.score), 1e-9);
        if (cand.score >= current.score || random() < Math.exp((cand.score - current.score) / (temperature * ref))) {
            current = cand;
        }

        sinceImprovement = improved ? 0 : sinceImprovement + 1;
        if (sinceImprovement > 150 && (best || bestAny)) {
            current = best || bestAny;
            sinceImprovement = 0;
        }
        yield progress(improved);
    }

    // Polish: drop any waypoint whose removal improves the loop. This clears
    // out-and-back spikes (e.g. up one side of a divided road and back down
    // the other) that random moves only remove occasionally.
    let final = best || bestAny;
    const minPoints = isRefine ? 0 : isStart ? 2 : 3;
    for (let pass = 0, changed = true; changed && pass < 3 && final?.loop && !control.stop; pass++) {
        changed = false;
        for (let i = 0; i < final.points.length && final.points.length > minPoints; i++) {
            const cand = tryWaypoints(final.points.filter((_, k) => k !== i), final);
            if (cand.loop && cand.score > final.score && (cand.feasible || !final.feasible)) {
                final = cand;
                consider(cand);
                changed = true;
                i--;
            }
        }
        yield progress(false);
    }

    if (!final || !final.loop) throw new Error("Couldn't find a loop here.");
    return buildResult(g, final, params, startNode, targetXY, true);
}

// Converts a candidate to plain data: coordinates and measurements. For a
// refine search, `coords` is the new stretch only (A → B).
function buildResult(g, cand, params, startNode, targetXY, exact) {
    const { loop } = cand;
    const coords = [];
    for (let i = 0; i < loop.edges.length; i++) {
        const geometry = g.source[loop.edges[i]].coords;
        const ordered = loop.dirs[i] === 1 ? geometry : [...geometry].reverse();
        for (let k = coords.length ? 1 : 0; k < ordered.length; k++) coords.push(ordered[k]);
    }
    if (coords.length === 0) {
        const n = startNode;
        const p = g.unproject(g.x[n], g.y[n]);
        coords.push([p.lat, p.lng]);
    }

    const m = loop.metrics;
    const result = {
        mode: params.mode,
        coords,                       // loops: closed, first point === last point
        lengthM: m.length,
        areaM2: m.area,
        iq: 4 * Math.PI * m.area / m.length ** 2,
        repeats: loop.repeats,
        score: cand.score,
        feasible: cand.feasible,
        waypoints: cand.points.map(p => g.unproject(p.x, p.y))
    };

    if (targetXY && params.mode !== "refine") {
        // Recompute coverage on the full road geometry for the final answer.
        const xy = exact ? coords.map(([lat, lng]) => g.project(lat, lng)) : loop.nodes.map(n => ({ x: g.x[n], y: g.y[n] }));
        result.coverage = createCoverageMeter(targetXY).measure(xy.map(p => p.x), xy.map(p => p.y));
    } else if (m.coverage !== undefined) {
        result.coverage = m.coverage;
    }
    if (startNode >= 0 && params.mode === "start") result.start = g.unproject(g.x[startNode], g.y[startNode]);
    return result;
}

// --------------------------------------------------------------------------
// Small helpers
// --------------------------------------------------------------------------

// Waypoints on a circle of the given radius that passes through `origin`,
// with its center in direction theta. The origin itself is excluded.
function circleWaypoints(origin, theta, radius, count) {
    const cx = origin.x + radius * Math.cos(theta);
    const cy = origin.y + radius * Math.sin(theta);
    const phi0 = theta + Math.PI;
    const points = [];
    for (let j = 1; j < count; j++) {
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
    let total = 0;
    for (let i = 0; i < points.length; i++) {
        const a = points[i], b = points[(i + 1) % points.length];
        total += Math.hypot(b.x - a.x, b.y - a.y);
    }
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
    module.exports = { solveLoop, compileGraph, createCoverageMeter, measureCoordsLoop, scoreLoop };
}
