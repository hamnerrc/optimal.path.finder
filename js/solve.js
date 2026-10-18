// ==========================================================================
// Runs the loop solver in a Web Worker so the page stays responsive. Workers
// can't start from file:// pages in some browsers; then the solver runs on
// the main thread in short slices instead.
// ==========================================================================

// Resolves with the solver result. onProgress({ fraction, best }) is called
// periodically; `best` is the best loop so far when it has changed.
function runSolver(network, params, { signal, onProgress }) {
    // Only plain data can be sent to a worker (the region has functions).
    const graph = { nodes: network.nodes, edges: network.edges };
    let worker = null;
    try {
        worker = new Worker("js/solver-worker.js");
    } catch {
        return runSolverInline(graph, params, { signal, onProgress });
    }

    return new Promise((resolve, reject) => {
        const finish = () => {
            worker.terminate();
            signal?.removeEventListener("abort", onAbort);
        };
        const onAbort = () => {
            finish();
            reject(new DOMException("Search cancelled", "AbortError"));
        };
        signal?.addEventListener("abort", onAbort);

        worker.onmessage = ({ data }) => {
            if (data.type === "progress") {
                onProgress?.(data);
            } else if (data.type === "done") {
                finish();
                resolve(data.result);
            } else {
                finish();
                reject(new Error(data.message));
            }
        };
        worker.onerror = (event) => {
            // The worker script failed to load (e.g. file://): fall back.
            event.preventDefault();
            finish();
            runSolverInline(graph, params, { signal, onProgress }).then(resolve, reject);
        };
        worker.postMessage({ network: graph, params });
    });
}

async function runSolverInline(graph, params, { signal, onProgress }) {
    const generator = solveLoop(graph, params);
    const sliceMs = 40;
    for (;;) {
        if (signal?.aborted) throw new DOMException("Search cancelled", "AbortError");
        const sliceEnd = Date.now() + sliceMs;
        let step, best = null;
        do {
            step = generator.next();
            if (!step.done && step.value.best) best = step.value.best;
        } while (!step.done && Date.now() < sliceEnd);

        if (step.done) return step.value;
        onProgress?.({ fraction: step.value.fraction, best });
        await new Promise(resolve => setTimeout(resolve, 0));
    }
}
