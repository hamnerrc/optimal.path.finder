// ==========================================================================
// Runs the loop search. The road graph is prepared once on the main thread,
// then several independent searches (each with its own random seed, so they
// explore different loops) run in parallel Web Workers, one per spare CPU
// core, until SearchTracker decides the result has settled.
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
    const seedBase = (Date.now() % 1e6) * 16;

    let engines = null;
    try {
        engines = startWorkers(prep.data, params, seedBase);
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
    return coordinate(prep, params, [inlineEngine(prep.data, params, seedBase)], { signal, onProgress });
}

// Collects round reports from the engines and stops them once the search
// has settled. Each engine: { start(onMessage), stop() }.
function coordinate(prep, params, engines, { signal, onProgress }) {
    const tracker = new SearchTracker(engines.length);
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

        engines.forEach(engine => engine.start((message) => {
            if (finished) return;
            if (message.type === "round") {
                reported = true;
                const improved = tracker.report(message.best);
                onProgress?.({
                    fraction: tracker.fraction,
                    rounds: tracker.rounds,
                    best: improved && params.mode !== "refine" ? expandLoop(prep, tracker.best, params, false) : null
                });
                if (tracker.done) {
                    finish();
                    resolve(expandLoop(prep, tracker.best, params, true));
                }
            } else if (message.type === "error") {
                // Every engine fails the same way on a bad graph; report it once.
                if (++failures < engines.length && !message.workerFailed) return;
                finish();
                if (tracker.best) {
                    resolve(expandLoop(prep, tracker.best, params, true));
                } else {
                    const err = new Error(message.message);
                    err.workerFailed = Boolean(message.workerFailed) && !reported;
                    reject(err);
                }
            }
        }));
    });
}

function startWorkers(data, params, seedBase) {
    return Array.from({ length: workerCount() }, (_, k) => {
        const worker = new Worker("js/solver-worker.js");
        return {
            start(onMessage) {
                worker.onmessage = ({ data: message }) => onMessage(message);
                worker.onerror = (event) => {
                    // The worker script failed to load (e.g. file://).
                    event.preventDefault();
                    onMessage({ type: "error", message: event.message || "Worker failed", workerFailed: true });
                };
                worker.postMessage({ type: "run", graph: data, params, seed: seedBase + k });
            },
            stop() {
                worker.terminate();
            }
        };
    });
}

// The same search on the main thread, in slices that leave the page responsive.
function inlineEngine(data, params, seed) {
    let stopped = false;
    let search = null;
    return {
        start(onMessage) {
            try {
                search = new LoopSearch(data, params, seed);
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
                        if (step?.roundDone) {
                            if (!search.leader() && search.rounds >= 3) throw new Error(noLoopMessage(params));
                            onMessage({ type: "round", best: step.improved ? search.result() : null });
                        }
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
