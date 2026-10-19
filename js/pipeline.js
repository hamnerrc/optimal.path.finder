// ==========================================================================
// Search pipeline: load roads, build the network, run the solver.
//
// Roads come from precomputed vector tiles (js/roadtiles.js), with Overpass
// as the fallback if the tile server can't be reached. Small searches load
// every road at once. Big ones (see CONFIG.chunked) go in two stages:
//   1. A rough loop on major roads only, from coarser tiles.
//   2. All roads in a corridor along the rough loop, and a search around
//      the rough loop's centre that improves it with them.
//
// Area searches load roads a little beyond the area (CONFIG.areaMargins);
// if the coverage target can't be met with those, the margin is widened and
// the search repeated.
//
// There's no time limit: every search runs until it stops finding better
// loops (see SearchTracker in js/solver.js). The best loop so far is
// reported through onLoop() as the search goes, so it can be shown,
// exported or kept if the search is stopped.
// ==========================================================================

// job:
//   objective  { mode: "start", start: {lat,lng}, maxLengthM }
//            | { mode: "area", target: [{lat,lng}], coverage }
//   region     full-detail road region
//   target     area mode: the area's region (for wider margins)
//   roads      road options: { noMotorways, hops, railways } (see roadTypesFor)
// options: { signal, onStatus(text, fraction), onLoop(loop, final), onNetwork(network) }
// Resolves with the final loop: { coords, lengthM, areaM2, iq, coverage, feasible, score, chunked }.
async function searchLoop(job, options) {
    if (job.objective.mode !== "area" || !job.target) return searchRegion(job, options);

    let best = null;
    const margins = CONFIG.areaMargins;
    for (let i = 0; i < margins.length; i++) {
        const region = i === 0 ? job.region : marginRegion(job.target, margins[i]);
        const result = await searchRegion({ ...job, region }, options);
        if (!best || isBetterResult(result, best)) best = result;
        if (best.feasible || i === margins.length - 1) break;
        const reached = Math.floor((best.coverage ?? 0) * 100);
        options.onLoop(best, false);
        options.onStatus(`Roads near the area only reach ${reached}% coverage. ` +
            `Widening the search to ${Math.round((margins[i + 1] - 1) * 100)}% around it…`, 0);
    }
    return best;
}

async function searchRegion(job, options) {
    const small = sqKmToSqMiles(job.region.areaSqKm) <= CONFIG.chunked.fullDetailMaxSqMiles;
    if (small || fewTiles(job.region)) {
        try {
            return await searchFullDetail(job, options, small ? Infinity : CONFIG.chunked.maxFullVertices);
        } catch (err) {
            // Too many roads for one download: fall back to stages.
            if (!isTooBig(err) && !err.tooManyRoads) throw err;
            options.onStatus("Too many roads for one download. Switching to a staged search…", 0);
        }
    }
    return searchStaged(job, options);
}

// Whether all roads in a region come in few enough tiles to load at once
// (if they don't hold too many roads, see CONFIG.chunked).
function fewTiles(region) {
    const max = CONFIG.chunked.maxFullTiles;
    return tileRange(region.bbox, CONFIG.roadTiles.zoom).count <= 4 * max &&
        tilesCovering(region, CONFIG.roadTiles.zoom).length <= max;
}

async function searchFullDetail(job, { signal, onStatus, onLoop, onNetwork }, maxVertices = Infinity) {
    const osm = await loadRoads(job.region, job.roads, signal, (done, total) =>
        onStatus(total > 1 ? `Loading roads (${done} of ${total} tiles)…` : "Loading roads…", 0), maxVertices);
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

async function searchStaged(job, { signal, onStatus, onLoop, onNetwork }) {
    const { objective } = job;
    const settings = CONFIG.chunked;

    // Stage 1: rough loop on major roads ------------------------------------
    const coarseRegion = objective.mode === "start"
        ? createCircleRegion(objective.start, objective.maxLengthM * settings.startRadiusFraction)
        : job.region;
    const osm = await loadMajorRoads(coarseRegion, job.roads, signal, (done, total) =>
        onStatus(`Large area: loading major roads (${done} of ${total})…`, 0));
    onStatus("Building major road network…", 0);
    await nextFrame();
    const coarse = buildRoadNetwork(osm, coarseRegion);
    if (coarse.edges.length === 0) throw new Error("No major roads found here.");
    onNetwork(coarse);

    const rough = { ...await runSolver(coarse, solverParams(objective), {
        signal,
        onProgress: ({ fraction, rounds, best }) => {
            if (best) onLoop({ ...best, chunked: true }, false);
            onStatus(`Finding a rough loop on major roads (round ${rounds})…`, 0.4 * fraction);
        }
    }), chunked: true };
    onLoop(rough, false);

    // Stage 2: all roads along the rough loop -------------------------------
    try {
        let line = rough.coords.map(([lat, lng]) => ({ lat, lng }));
        if (objective.mode === "start") line = [objective.start, ...line];
        const radius = Math.max(settings.corridorMinM, settings.corridorFraction * rough.lengthM / Math.PI);
        const corridor = createCorridorRegion(simplifyLine(line, 400), radius);
        const local = buildRoadNetwork(await loadRoads(corridor, job.roads, signal, (done, total) =>
            onStatus(`Loading all roads along the rough loop (${done} of ${total} tiles)…`, 0.4)), corridor);
        if (local.edges.length === 0) return rough;
        onNetwork(local);
        await nextFrame();
        const reference = simplifyLine(loopPart(rough), 400);
        const fine = await runSolver(local, { ...solverParams(objective), center: rough.center, anchor: rough.anchor, reference }, {
            signal,
            onProgress: ({ fraction, rounds, best }) => {
                if (best) onLoop({ ...best, chunked: true }, false);
                onStatus(`Improving the loop with all roads (round ${rounds})…`, 0.4 + 0.6 * fraction);
            }
        });
        // The rough loop's major roads come from simplified tiles, so its
        // length and area are only approximate: the loop on all roads (with
        // the real road shapes) wins.
        return { ...fine, chunked: true };
    } catch (err) {
        // A failed second stage (e.g. a busy server) shouldn't lose the loop.
        if (err.name === "AbortError") throw err;
        console.warn("[Search] Loop not improved with all roads:", err);
        return rough;
    }
}

// Downloads (into the tile store) the tiles a search for `job` will start
// with: all roads, or for a big search the major roads of its first stage.
// Failures are ignored; the search itself will try again.
function prefetchRoads(job) {
    const settings = CONFIG.chunked;
    if (sqKmToSqMiles(job.region.areaSqKm) <= settings.fullDetailMaxSqMiles || fewTiles(job.region)) {
        prefetchTiles(job.region, CONFIG.roadTiles.zoom).catch(() => {});
        return;
    }
    const region = job.objective.mode === "start"
        ? createCircleRegion(job.objective.start, job.objective.maxLengthM * settings.startRadiusFraction)
        : job.region;
    prefetchTiles(region, roadTileZoom(region.bbox, settings.maxCoarseTiles)).catch(() => {});
}

// All roads in a region: vector tiles, or Overpass if the tile server
// can't be reached (without fence hops there). onProgress(done, total)
// counts tiles. Fails with err.tooManyRoads if the tiles hold more than
// maxVertices road points.
async function loadRoads(region, roads, signal, onProgress, maxVertices = Infinity) {
    const roadTypes = roadTypesFor(roads);
    try {
        return await fetchRoadsFromTiles(region, signal, { roadTypes, noExpressways: Boolean(roads?.noMotorways), hops: Boolean(roads?.hops), onProgress, maxVertices });
    } catch (err) {
        if (err.name === "AbortError" || err.tooManyRoads) throw err;
        console.warn("[Roads] Tiles unavailable, using Overpass:", err);
        onProgress(0, 1);
        return fetchRoads(region, signal, roadTypes);
    }
}

// Major roads only, from tiles coarse enough to cover the region quickly.
async function loadMajorRoads(region, roads, signal, onProgress) {
    const settings = CONFIG.chunked;
    const sqMiles = sqKmToSqMiles(region.areaSqKm);
    const dropTertiary = sqMiles > settings.tertiaryMaxSqMiles;
    const roadTypes = roadTypesFor(roads, settings.coarseRoadTypes).filter(t => t !== "railway" && (!dropTertiary || !t.startsWith("tertiary")));
    try {
        const zoom = roadTileZoom(region.bbox, settings.maxCoarseTiles);
        return await fetchRoadsFromTiles(region, signal, { roadTypes, zoom, noExpressways: Boolean(roads?.noMotorways), onProgress });
    } catch (err) {
        if (err.name === "AbortError") throw err;
        console.warn("[Roads] Tiles unavailable, using Overpass:", err);
        const tileDegrees = dropTertiary ? settings.largeTileDegrees : settings.tileDegrees;
        return fetchRoadsTiled(region.bbox, tileDegrees, roadTypes, signal, onProgress);
    }
}

// Road types for a search's road options:
//   noMotorways  leave out motorways, trunk roads (expressways) and their ramps
//   railways     add railroad tracks
// (hops, fence hops, is handled by the tile loader.)
function roadTypesFor(roads, types = CONFIG.roadTypes) {
    let out = types;
    if (roads?.noMotorways) out = out.filter(t => !CONFIG.motorwayTypes.includes(t));
    if (roads?.railways) out = [...out, "railway"];
    return out;
}

// The loop itself, without the stretch out from the start and back.
function loopPart(loop) {
    const points = loop.coords.map(([lat, lng]) => ({ lat, lng }));
    if (!loop.stemM) return points.slice(0, -1);
    let along = 0;
    const kept = [];
    points.forEach((p, i) => {
        if (i > 0) along += haversine(points[i - 1].lat, points[i - 1].lng, p.lat, p.lng);
        if (along >= loop.stemM && along <= loop.lengthM - loop.stemM) kept.push(p);
    });
    return kept.length >= 3 ? kept : points.slice(0, -1);
}

// Solver params for an objective.
function solverParams(objective) {
    return objective.mode === "start"
        ? { mode: "start", start: objective.start, maxLengthM: objective.maxLengthM }
        : { mode: "area", target: objective.target, coverage: objective.coverage };
}

const searchingText = (rounds) => `Searching, round ${rounds}. Finishes by itself once better loops stop turning up.`;

// Yields so the browser can paint before heavy work.
const nextFrame = () => new Promise(resolve => requestAnimationFrame(() => setTimeout(resolve, 0)));
