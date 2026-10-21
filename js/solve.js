// ==========================================================================
// Runs the loop search. The road graph is prepared once on the main thread,
// then several searches run in parallel Web Workers, one per spare CPU core,
// each sweeping its own share of the centres (see SweepSearch), until
// SearchTracker decides the result has settled.
// Workers can't start from file:// pages in some browsers; then a single
// search runs on the main thread in short slices instead.
// ==========================================================================

const MAX_WORKERS = 6;
const workerCount = () => Math.max(1, Math.min(MAX_WORKERS, (navigator.hardwareConcurrency || 2) - 1));

// Resolves with the best loop (see expandLoop). onProgress({ fraction, rounds,
// best }) is called after each round; `best` is the best loop so far when it
// has changed. Aborting `signal` rejects with an AbortError (the caller keeps
// whatever it was shown through onProgress).
async function runSolver(network, params, { signal, onProgress }) {
    const prep = prepareGraph(network, params);
    console.log("[Solver] Graph:", prep.stats);

    let engines = null;
    try {
        engines = startWorkers(prep.data, params);
    } catch {
        // No workers here: search on the main thread.
    }
    if (engines) {
        try {
            return await coordinate(prep, params, engines, { signal, onProgress });
        } catch (err) {
            if (err.name === "AbortError" || !err.workerFailed) throw err;
            console.warn("[Solver] Workers unavailable, searching on the main thread:", err.message);
        }
    }
    return coordinate(prep, params, [inlineEngine(prep.data, params)], { signal, onProgress });
}

// Collects round reports from the engines and stops them once the search
// has settled. Each engine: { start(onMessage), stop() }.
function coordinate(prep, params, engines, { signal, onProgress }) {
    const tracker = new SearchTracker(engines.length, Boolean(params.reference), Boolean(params.rough));
    return new Promise((resolve, reject) => {
        let finished = false;
        let reported = false;
        let failures = 0;
        const finish = () => {
            finished = true;
            engines.forEach(engine => engine.stop());
            signal?.removeEventListener("abort", onAbort);
        };
        const onAbort = () => {
            if (finished) return;
            finish();
            reject(new DOMException("Search cancelled", "AbortError"));
        };
        if (signal?.aborted) return onAbort();
        signal?.addEventListener("abort", onAbort);

        const settle = (improved) => {
            onProgress?.({
                fraction: tracker.fraction,
                rounds: tracker.rounds,
                best: improved ? expandLoop(prep, tracker.best, params, false) : null
            });
            if (tracker.done) {
                finish();
                resolve(expandLoop(prep, tracker.best, params, true));
            }
        };
        engines.forEach((engine, k) => engine.start((message) => {
            if (finished) return;
            if (message.type === "round") {
                reported = true;
                settle(tracker.report(message.best, message.index));
            } else if (message.type === "error") {
                // Every engine fails the same way on a bad graph; report it
                // once. One that just found no loop where it looked stops,
                // and the others go on.
                if (++failures < engines.length && !message.workerFailed) {
                    settle(tracker.drop(k, engines.length));
                    return;
                }
                finish();
                if (tracker.best) {
                    resolve(expandLoop(prep, tracker.best, params, true));
                } else {
                    const err = new Error(message.message);
                    err.workerFailed = Boolean(message.workerFailed) && !reported;
                    err.noLoop = message.message === noLoopMessage(params);
                    reject(err);
                }
            }
        }));
    });
}

// Workers are kept between searches (and started soon after the page
// loads), so a search doesn't wait for them to start and load the solver.
// Each run has its own id; a worker drops a run when told to stop, and its
// messages carry the run id, so late messages from an old run are ignored.
const workerPool = [];
let nextRun = 1;

function poolWorkers(count) {
    while (workerPool.length < count) workerPool.push(new Worker(`js/solver-worker.js?v=${CONFIG.release}`));
    return workerPool.slice(0, count);
}

// Each worker holds its own copy of the graph and its own buffers, so a
// very big graph (a loop around a country) gets fewer of them.
const BIG_GRAPH_PIECES = 200000;

function startWorkers(data, params) {
    const workers = Math.min(workerCount(), data.faces.P > BIG_GRAPH_PIECES ? 2 : MAX_WORKERS);
    const run = nextRun++;
    return poolWorkers(workers).map((worker, k) => ({
        start(onMessage) {
            worker.onmessage = ({ data: message }) => {
                if (message.run === run) onMessage(message);
            };
            worker.onerror = (event) => {
                // The worker script failed to load (e.g. file://): drop it.
                event.preventDefault();
                worker.terminate();
                workerPool.splice(workerPool.indexOf(worker) >>> 0, 1);
                onMessage({ type: "error", message: event.message || "Worker failed", workerFailed: true });
            };
            worker.postMessage({ type: "run", run, graph: data, params, worker: k, workers });
        },
        stop() {
            worker.postMessage({ type: "stop" });
        }
    }));
}

if (typeof window !== "undefined" && typeof Worker !== "undefined") {
    window.addEventListener("load", () => setTimeout(() => {
        try {
            poolWorkers(workerCount());
        } catch {
            // No workers here (see runSolver).
        }
    }, 500));
}

// The same search on the main thread, in slices that leave the page responsive.
function inlineEngine(data, params) {
    let stopped = false;
    let search = null;
    return {
        start(onMessage) {
            try {
                search = new SweepSearch(data, params);
            } catch (err) {
                onMessage({ type: "error", message: err.message });
                return;
            }
            const steps = search.run();
            const slice = () => {
                if (stopped) return;
                try {
                    const sliceEnd = Date.now() + 30;
                    while (Date.now() < sliceEnd && !stopped) {
                        const step = steps.next().value;
                        if (!search.leader() && search.rounds >= MAX_EMPTY_SWEEPS) throw new Error(noLoopMessage(params));
                        onMessage({ type: "round", best: step.improved ? search.result() : null, index: step.index });
                    }
                } catch (err) {
                    onMessage({ type: "error", message: err.message });
                    return;
                }
                setTimeout(slice, 0);
            };
            slice();
        },
        stop() {
            stopped = true;
        }
    };
}
