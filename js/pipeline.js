// ==========================================================================
// Search pipeline: load roads, build the network, run the solver.
//
// Roads come from precomputed vector tiles (js/roadtiles.js), with Overpass
// as the fallback if the tile server can't be reached. Small searches load
// every road at once. Big ones (see CONFIG.chunked) go in two stages:
//   1. A rough loop on major roads only, from coarser tiles.
//   2. All roads in a corridor along the rough loop, and a search around
//      the rough loop's centre that improves it with them; then again in
//      a corridor along the improved loop, while that still helps.
//
// With "prefer flatter loops", every road gets its climb from terrain tiles
// first (addRoadClimb), which the search counts as extra length (see
// SOLVER.climbCost).
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
//   objective  { mode: "start", start: {lat,lng}, maxLengthM, …limits }
//            | { mode: "area", target: [{lat,lng}], coverage, maxCoverage?, maxLengthM?, …limits }
//              limits (all optional): minLengthM, minAreaM2, maxAreaM2,
//              minClimbM, maxClimbM (see limitMisses in js/solver.js)
//   region     full-detail road region
//   target     area mode: the area's region (for wider margins)
//   roads      road options: { noMotorways, hops, railways, preferSmall, preferFlat,
//              climbCost } (see roadTypesFor and solverParams)
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
        // (Wider margins can't help a loop held back by its length limit.)
        const limited = job.objective.maxLengthM && best.lengthM >= 0.9 * job.objective.maxLengthM;
        if (best.feasible || limited || i === margins.length - 1) break;
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
    await loadClimb(network, job, signal, onStatus, 0);

    onStatus("Searching…", 0);
    await nextFrame();
    const result = await runSolver(network, solverParams(job), {
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
    // With "avoid motorways" the rough loop may still use motorways and
    // trunk roads, counted as much longer (without them, major roads can be
    // too few to make a loop: most of Kansas's US highways are trunk roads).
    // It only sets the shape: the loop on all roads leaves them out.
    const coarseRegion = objective.mode === "start"
        ? createCircleRegion(objective.start, objective.maxLengthM * settings.startRadiusFraction)
        : job.region;
    const avoidMotorways = Boolean(job.roads?.noMotorways);
    const expected = expectedLoopLength(objective);
    let osm = await loadMajorRoads(coarseRegion, { ...job.roads, noMotorways: false }, expected, signal, (done, total) =>
        onStatus(`Large area: loading major roads (${done} of ${total})…`, 0));
    onStatus("Building major road network…", 0);
    await nextFrame();
    let coarse = buildRoadNetwork(osm, coarseRegion);
    osm = null;   // (no longer needed: memory is tight on big searches)
    if (coarse.edges.length === 0) throw new Error("No major roads found here.");
    onNetwork(coarse);
    // (The climb too, from coarse terrain tiles here: only an estimate, but
    // enough that the rough loop doesn't settle in the hills, where the
    // stages after it couldn't get it out.)
    const huge = expected > settings.hugeLoopM;
    await loadClimb(coarse, job, signal, onStatus, 0);

    // While the search runs, the tiles along its best loop so far start
    // downloading (the browser has little else to do meanwhile).
    const prefetch = corridorPrefetcher(objective);
    let roughRounds = 0;
    const roughStart = Date.now();
    const rough = { ...await runSolver(coarse, { ...roughParams(solverParams(job)), avoidMotorways, rough: true }, {
        signal,
        onProgress: ({ fraction, rounds, best }) => {
            if (best) onLoop({ ...best, chunked: true }, false);
            prefetch.offer(best, fraction);
            roughRounds = rounds;
            onStatus(`Finding a rough loop on major roads (round ${rounds})…`, 0.4 * fraction);
        }
    }), chunked: true };
    coarse = null;
    console.log(`[Search] Rough loop: ${roughRounds} rounds, ${Date.now() - roughStart} ms`);
    // (Its rank was for the widened range, see roughParams: what it misses
    // is known only on all roads.)
    if (rough.rank !== undefined) rough.rank = 6;
    onLoop(rough, false);

    // Stage 2: all roads along the rough loop, then along the improved one --
    // Each pass can move each side of the loop by up to the corridor's
    // width; the next pass starts from where the last one got to.
    let best = rough;
    // (A huge loop that still misses a limit gets the usual passes.)
    const passes = huge ? settings.hugePasses : settings.corridorPasses;
    for (let pass = 1; pass <= passes || (rankOf(best) > 0 && pass <= settings.corridorPasses); pass++) {
        const share = (fraction) => 0.4 + 0.6 * (pass - 1 + fraction) / passes;
        let fine;
        try {
            prefetch.stop();
            const { points, zoom, radius, corridor } = corridorAlong(best, objective);
            console.log(`[Search] Pass ${pass}: corridor ${Math.round(radius)} m, zoom ${zoom}`);
            const what = pass === 1 ? "the rough loop" : "the improved loop";
            const kind = zoom === CONFIG.roadTiles.zoom ? "all roads" : "local roads";
            const local = buildRoadNetwork(await loadRoads(corridor, job.roads, signal, (done, total) =>
                onStatus(`Loading ${kind} along ${what} (${done} of ${total} tiles)…`, share(0)), Infinity, zoom), corridor);
            if (local.edges.length === 0) break;
            onNetwork(local);
            await loadClimb(local, job, signal, onStatus, share(0));
            await nextFrame();
            const reference = simplifyLine(loopPart(best), points);
            fine = { ...await runSolver(local, { ...solverParams(job), center: best.center, anchor: best.anchor, reference }, {
                signal,
                onProgress: ({ fraction, rounds, best: loop }) => {
                    if (loop && (pass === 1 || isBetterResult(loop, best))) onLoop({ ...loop, chunked: true }, false);
                    if (pass < passes) prefetch.offer(loop, fraction);
                    onStatus(pass === 1 ? `Improving the loop with all roads (round ${rounds})…`
                        : `Improving the loop further, pass ${pass} (round ${rounds})…`, share(fraction));
                }
            }), chunked: true };
        } catch (err) {
            prefetch.stop();
            // A failed pass (e.g. a busy server) shouldn't lose the loop.
            if (err.name === "AbortError") throw err;
            console.warn("[Search] Loop not improved with all roads:", err);
            break;
        }
        // The rough loop's major roads come from simplified tiles, so its
        // length and area are only approximate: the first loop on all roads
        // (with the real road shapes) wins, unless it's far worse (the
        // rough loop couldn't be followed). After that, a pass that barely
        // helped is the last.
        const gain = pass === 1 || rankOf(fine) < rankOf(best) ? Infinity : (fine.score - best.score) / Math.abs(best.score);
        console.log(`[Search] Pass ${pass}: score ${fine.score.toFixed(4)} (was ${best.score.toFixed(4)})`);
        const close = pass === 1 && rankOf(fine) <= rankOf(best) && fine.score > 0.9 * best.score;
        if (close || isBetterResult(fine, best)) best = fine;
        else if (pass === 1) break;
        if (gain < settings.passMinGain) break;
        if (pass < passes) onLoop(best, false);
    }
    prefetch.stop();
    return best;
}

// The corridor of all roads along a loop for the next pass (see
// corridorPlan): { points (of the line it follows), zoom, radius, corridor }.
function corridorAlong(loop, objective) {
    let line = loopPart(loop);
    if (objective.mode === "start") line = [objective.start, ...line];
    // (At least a point per km: on a loop around a state, 400 points would
    // stray kilometers from its roads.)
    const points = Math.max(400, Math.ceil(loop.lengthM / 1000));
    line = simplifyLine(line, points);
    const { zoom, radius } = corridorPlan(line, loop.lengthM);
    return { points, zoom, radius, corridor: createCorridorRegion(line, radius) };
}

// Downloads the tiles along a search's best loop so far, so most of the next
// corridor is loaded by the time the search ends: offer(loop, fraction)
// after every round (loop: the best loop if it changed, else null; fraction:
// how settled the search is). Once the search has begun to settle (before
// that the loop still moves a lot), a second after the best loop last
// changed. stop() stops starting downloads (the next pass loads what's
// still missing itself).
function corridorPrefetcher(objective) {
    let timer = null, run = null, latest = null, offered = null;
    const stop = () => {
        clearTimeout(timer);
        if (run) run.cancelled = true;
        run = null;
    };
    return {
        offer(loop, fraction) {
            if (loop) latest = loop;
            if (!latest || latest === offered || fraction < CONFIG.chunked.prefetchSettled) return;
            offered = latest;
            clearTimeout(timer);
            timer = setTimeout(() => {
                stop();
                const { zoom, corridor } = corridorAlong(offered, objective);
                run = { cancelled: false };
                prefetchTiles(corridor, zoom, { maxTiles: 2 * CONFIG.chunked.maxCorridorTiles, run }).catch(() => {});
            }, 1000);
        },
        stop
    };
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
    const zoom = expectedLoopLength(job.objective) > settings.hugeLoopM ? settings.hugeZoom : roadTileZoom(region.bbox, settings.maxCoarseTiles);
    prefetchTiles(region, zoom).catch(() => {});
}

// All roads in a region: vector tiles, or Overpass if the tile server
// can't be reached (without fence hops there). onProgress(done, total)
// counts tiles. Fails with err.tooManyRoads if the tiles hold more than
// maxVertices road points.
async function loadRoads(region, roads, signal, onProgress, maxVertices = Infinity, zoom = CONFIG.roadTiles.zoom) {
    const roadTypes = roadTypesFor(roads);
    try {
        // (Fence hops need the paths and dead ends only full-detail tiles have.)
        const hops = Boolean(roads?.hops) && zoom === CONFIG.roadTiles.zoom;
        return await fetchRoadsFromTiles(region, signal, { roadTypes, zoom, noExpressways: Boolean(roads?.noMotorways), hops, onProgress, maxVertices });
    } catch (err) {
        if (err.name === "AbortError" || err.tooManyRoads) throw err;
        console.warn("[Roads] Tiles unavailable, using Overpass:", err);
        onProgress(0, 1);
        return fetchRoads(region, signal, roadTypes);
    }
}

// Major roads only, from tiles coarse enough to cover the region quickly.
// For a loop hundreds of miles long (expectedLength), motorways, trunk and
// primary roads from zoom 7 tiles are plenty, and far fewer.
async function loadMajorRoads(region, roads, expectedLength, signal, onProgress) {
    const settings = CONFIG.chunked;
    const sqMiles = sqKmToSqMiles(region.areaSqKm);
    const huge = expectedLength > settings.hugeLoopM;
    const dropTertiary = sqMiles > settings.tertiaryMaxSqMiles;
    const roadTypes = roadTypesFor(roads, huge ? settings.hugeRoadTypes : settings.coarseRoadTypes).filter(t => t !== "railway" &&
        (!dropTertiary || !t.startsWith("tertiary")));
    try {
        const zoom = huge ? settings.hugeZoom : roadTileZoom(region.bbox, settings.maxCoarseTiles);
        return await fetchRoadsFromTiles(region, signal, { roadTypes, zoom, noExpressways: Boolean(roads?.noMotorways), onProgress });
    } catch (err) {
        if (err.name === "AbortError") throw err;
        console.warn("[Roads] Tiles unavailable, using Overpass:", err);
        const tileDegrees = dropTertiary ? settings.largeTileDegrees : settings.tileDegrees;
        return fetchRoadsTiled(region.bbox, tileDegrees, roadTypes, signal, onProgress);
    }
}

// About how long the loop will be: the length limit, or the perimeter of a
// circle covering the target share of the area.
function expectedLoopLength(objective) {
    if (objective.mode === "start") return objective.maxLengthM;
    const circle = 2 * Math.sqrt(Math.PI * objective.coverage * createPolygonRegion(objective.target).areaSqKm * 1e6);
    return Math.min(circle, objective.maxLengthM || Infinity);
}

// Tile zoom and width of the corridor along a loop of length `lengthM`
// (through `line`): all roads (zoom 14 tiles) within corridorFraction of
// the loop's size to either side, if that takes no more than
// maxCorridorTiles tiles. Otherwise the local roads of coarser tiles (zoom
// 13: no paths or tracks; 12: no service roads either), which cover four
// times the area each, narrowing the corridor at the coarsest if needed.
// Keeps a loop around a whole country quick and its road network small
// enough for the browser.
function corridorPlan(line, lengthM) {
    const settings = CONFIG.chunked;
    const wanted = Math.max(settings.corridorMinM, settings.corridorFraction * lengthM / Math.PI);
    // About how many tiles a corridor takes (counting them exactly is slow
    // for a wide corridor of small tiles).
    let lineM = 0;
    for (let i = 1; i < line.length; i++) lineM += haversine(line[i - 1].lat, line[i - 1].lng, line[i].lat, line[i].lng);
    const tileM = (zoom) => 40075016.7 * Math.cos(line[0].lat * DEG) / 2 ** zoom;
    const count = (zoom, radius) => lineM * (2 * radius + tileM(zoom)) / tileM(zoom) ** 2;
    for (let zoom = CONFIG.roadTiles.zoom; zoom > settings.corridorMinZoom; zoom--) {
        if (count(zoom, wanted) <= settings.maxCorridorTiles) return { zoom, radius: wanted };
    }
    // (Not narrower than corridorMinTiles tiles: a rough loop from coarse
    // tiles can be a kilometer or more off its roads.)
    const zoom = settings.corridorMinZoom;
    const narrowest = Math.max(settings.corridorMinM, tileM(zoom) * settings.corridorMinTiles);
    let radius = wanted;
    while (radius > narrowest && count(zoom, radius) > settings.maxCorridorTiles) radius = Math.max(narrowest, radius * 0.85);
    return { zoom, radius };
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

// The rough stage's params: a narrow range of coverage or area widened by
// CONFIG.chunked.roughSlack each way, with a mild pull toward the middle of
// the real range (aimCoverage). Its big blocks of major roads can rarely
// land in a range that narrow, and its job is the shape; but the roads
// along it can only move it a little (a corridor a few km wide), so it
// should end up close.
function roughParams(params) {
    const slack = CONFIG.chunked.roughSlack;
    const out = { ...params };
    if (params.maxCoverage) {
        out.coverage = params.coverage * (1 - slack);
        out.maxCoverage = params.maxCoverage * (1 + slack);
        out.aimCoverage = (params.coverage + params.maxCoverage) / 2;
    }
    if (params.minAreaM2) out.minAreaM2 = params.minAreaM2 * (1 - slack);
    if (params.maxAreaM2) out.maxAreaM2 = params.maxAreaM2 * (1 + slack);
    return out;
}

// Solver params for a job (with its limits, see limitMisses).
function solverParams({ objective, roads }) {
    const prefer = { preferSmall: Boolean(roads?.preferSmall), preferFlat: Boolean(roads?.preferFlat), climbCost: roads?.climbCost };
    const { maxLengthM, minLengthM, minAreaM2, maxAreaM2, minClimbM, maxClimbM } = objective;
    const limits = { maxLengthM, minLengthM, minAreaM2, maxAreaM2, minClimbM, maxClimbM };
    return objective.mode === "start"
        ? { mode: "start", start: objective.start, ...limits, ...prefer }
        : { mode: "area", target: objective.target, coverage: objective.coverage, maxCoverage: objective.maxCoverage, ...limits, ...prefer };
}

// The climb along every road (for the Hills slider and climb limits), from
// terrain tiles. Without them, the search goes on without it.
async function loadClimb(network, job, signal, onStatus, fraction) {
    if (!job.roads?.preferFlat && !hasClimbLimits(job.objective)) return;
    onStatus("Reading the climb along the roads…", fraction);
    const t0 = Date.now();
    await addRoadClimb(network, signal);
    console.log(`[Elevation] Climb along ${network.edges.length} roads in ${Date.now() - t0} ms`);
}

const searchingText = (rounds) => `Searching, round ${rounds}. Finishes by itself once better loops stop turning up.`;

// Yields so the browser can paint before heavy work.
const nextFrame = () => new Promise(resolve => requestAnimationFrame(() => setTimeout(resolve, 0)));
