// ==========================================================================
// Search pipeline: download roads, build the network, run the solver.
//
// Small searches load every road at once. Big ones (see CONFIG.chunked) go
// in two stages:
//   1. A rough loop on major roads only, downloaded as a grid of tiles.
//   2. One pass around that loop, a stretch at a time: all roads in a
//      corridor around the stretch are loaded, and the stretch is re-routed
//      to improve the whole loop's score (the rest of the loop stays fixed).
//      A change is only kept if the loop gets better.
//
// There's no time limit: every search runs until it stops finding better
// loops (see SearchTracker in js/solver.js). The best loop so far is
// reported through onLoop() as the search goes, so it can be shown,
// exported or kept if the search is stopped.
// ==========================================================================

// job:
//   objective  { mode: "start", start: {lat,lng}, maxLengthM }
//            | { mode: "area", target: [{lat,lng}], coverage }
//   region     full-detail download region
// options: { signal, onStatus(text, fraction), onLoop(loop, final), onNetwork(network) }
// Resolves with the final loop: { coords, lengthM, areaM2, iq, coverage, feasible, repeats, chunked }.
async function searchLoop(job, options) {
    const sqMiles = sqKmToSqMiles(job.region.areaSqKm);
    if (sqMiles <= CONFIG.chunked.fullDetailMaxSqMiles) {
        try {
            return await searchFullDetail(job, options);
        } catch (err) {
            // Too many roads for one request after all: fall back to stages.
            if (!isTooBig(err)) throw err;
            options.onStatus("Too many roads for one download. Switching to a staged search…", 0);
        }
    }
    return searchChunked(job, options);
}

async function searchFullDetail(job, { signal, onStatus, onLoop, onNetwork }) {
    onStatus("Downloading roads…", 0);
    const osm = await fetchRoads(job.region, signal);
    onStatus("Building road network…", 0);
    await nextFrame();
    const network = buildRoadNetwork(osm, job.region);
    if (network.edges.length === 0) throw new Error("No roads found here.");
    onNetwork(network);

    onStatus("Searching…", 0);
    await nextFrame();
    const result = await runSolver(network, solverParams(job.objective), {
        signal,
        onProgress: ({ fraction, rounds, best }) => {
            if (best) onLoop(best, false);
            onStatus(searchingText(rounds), fraction);
        }
    });
    return { ...result, chunked: false };
}

async function searchChunked(job, { signal, onStatus, onLoop, onNetwork }) {
    const { objective } = job;
    const settings = CONFIG.chunked;

    // Stage 1: rough loop on major roads ------------------------------------
    const coarseRegion = objective.mode === "start"
        ? createCircleRegion(objective.start, objective.maxLengthM * settings.startRadiusFraction)
        : job.region;
    const sqMiles = sqKmToSqMiles(coarseRegion.areaSqKm);
    const dropTertiary = sqMiles > settings.tertiaryMaxSqMiles;
    const roadTypes = settings.coarseRoadTypes.filter(t => !dropTertiary || !t.startsWith("tertiary"));
    const tileDegrees = dropTertiary ? settings.largeTileDegrees : settings.tileDegrees;

    const osm = await fetchRoadsTiled(coarseRegion.bbox, tileDegrees, roadTypes, signal, (done, total) =>
        onStatus(`Large area: downloading major roads (tile ${Math.min(done + 1, total)} of ${total})…`, done / total * 0.1));
    onStatus("Building major road network…", 0.1);
    await nextFrame();
    const network = buildRoadNetwork(osm, coarseRegion);
    if (network.edges.length === 0) throw new Error("No major roads found here.");
    onNetwork(network);

    let loop = await runSolver(network, solverParams(objective), {
        signal,
        onProgress: ({ fraction, rounds, best }) => {
            if (best) onLoop({ ...best, chunked: true }, false);
            onStatus(`Finding a rough loop on major roads (round ${rounds})…`, 0.1 + fraction * 0.25);
        }
    });
    loop = { ...loop, chunked: true };
    onLoop(loop, false);

    // Stage 2: refine stretch by stretch with all roads ---------------------
    const targetOutline = objective.mode === "area" ? objective.target : null;
    let coords = loop.coords.slice(0, -1);   // open ring; the loop closes back to coords[0]
    if (objective.mode === "start") coords = rotateToNearest(coords, objective.start);
    let current = measureCoordsLoop(closeRing(coords), scoringObjective(objective), targetOutline);

    const stretches = Math.max(1, Math.ceil(current.length / settings.segmentLengthM));
    const stretchLength = current.length / stretches;

    let passStart = null;   // where the pass began; the last stretch ends there
    for (let i = 0; i < stretches; i++) {
        const label = `Improving stretch ${i + 1} of ${stretches} with all roads…`;
        const base = 0.35 + 0.65 * (i / stretches);
        // The first stretchLength meters of the ring.
        let cut = indexAtDistance(coords, stretchLength);
        if (i === stretches - 1 && passStart) {
            const index = coords.indexOf(passStart);
            if (index > 0) cut = index;
        }
        const segment = coords.slice(0, cut + 1);
        const fixed = coords.slice(cut).concat([coords[0]]);
        if (segment.length < 2) continue;

        try {
            onStatus(`${label} (downloading)`, base);
            const corridor = createCorridorRegion(
                simplifyLine(segment.map(([lat, lng]) => ({ lat, lng })), 60), settings.corridorRadiusM);
            const local = buildRoadNetwork(await fetchRoads(corridor, signal), corridor);
            if (local.edges.length > 0) {
                const result = await runSolver(local, {
                    ...solverParams(objective),
                    mode: "refine",
                    objective: objective.mode,
                    segment,
                    fixed
                }, {
                    signal,
                    onProgress: ({ fraction }) => onStatus(label, base + 0.65 * fraction / stretches)
                });
                const candidate = result.coords.concat(fixed.slice(1, -1));
                const measured = measureCoordsLoop(closeRing(candidate), scoringObjective(objective), targetOutline);
                if (measured.score > current.score) {
                    coords = candidate;
                    current = measured;
                    onLoop(loopFromCoords(coords, current), false);
                }
            }
        } catch (err) {
            // One stretch failing (e.g. a busy server) shouldn't lose the loop.
            if (err.name === "AbortError") throw err;
            console.warn(`[Search] Stretch ${i + 1} not refined:`, err);
        }

        // Rotate so the next stretch starts where this one ended.
        if (i === 0) passStart = coords[0];
        const nextStart = coords.length - (fixed.length - 2) - 1;
        coords = coords.slice(nextStart).concat(coords.slice(0, nextStart));
    }

    if (objective.mode === "start") coords = rotateToNearest(coords, objective.start);
    return loopFromCoords(coords, current);
}

// Solver params for an objective (everything except mode-specific extras).
function solverParams(objective) {
    return objective.mode === "start"
        ? { mode: "start", start: objective.start, maxLengthM: objective.maxLengthM }
        : { mode: "area", target: objective.target, coverage: objective.coverage };
}

const scoringObjective = (objective) => ({ mode: objective.mode, maxLengthM: objective.maxLengthM, coverage: objective.coverage });

const closeRing = (coords) => coords.concat([coords[0]]);

function loopFromCoords(coords, metrics) {
    return {
        coords: closeRing(coords),
        lengthM: metrics.length,
        areaM2: metrics.area,
        iq: metrics.iq,
        coverage: metrics.coverage,
        feasible: metrics.feasible,
        repeats: 0,
        chunked: true
    };
}

// Index of the first point at least `distance` meters along the line.
function indexAtDistance(coords, distance) {
    let total = 0;
    for (let i = 1; i < coords.length; i++) {
        total += haversine(coords[i - 1][0], coords[i - 1][1], coords[i][0], coords[i][1]);
        if (total >= distance) return i;
    }
    return coords.length - 1;
}

// The open ring rotated to begin at the point closest to `latlng`.
function rotateToNearest(coords, latlng) {
    let best = 0, bestD = Infinity;
    coords.forEach(([lat, lng], i) => {
        const d = haversine(lat, lng, latlng.lat, latlng.lng);
        if (d < bestD) {
            bestD = d;
            best = i;
        }
    });
    return coords.slice(best).concat(coords.slice(0, best));
}

const searchingText = (rounds) => `Searching, round ${rounds}. Finishes by itself once better loops stop turning up.`;

// Yields so the browser can paint before heavy work.
const nextFrame = () => new Promise(resolve => requestAnimationFrame(() => setTimeout(resolve, 0)));
