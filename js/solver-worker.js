// Runs one SweepSearch off the main thread. See runSolver() in js/solve.js.
// Posts { type: "round", best, index } after every sweep (`best` is this
// search's best loop when it improved, otherwise null; `index` the sweep's
// number in the shared sequence) until terminated.
importScripts("geometry.js", "solver.js");

const SLICE_MS = 50;

self.onmessage = ({ data }) => {
    let search;
    try {
        search = new SweepSearch(data.graph, data.params, data.worker, data.workers);
    } catch (err) {
        self.postMessage({ type: "error", message: err.message });
        return;
    }
    const steps = search.run();
    const slice = () => {
        try {
            const sliceEnd = Date.now() + SLICE_MS;
            while (Date.now() < sliceEnd) {
                const step = steps.next().value;
                if (!search.leader() && search.rounds >= MAX_EMPTY_SWEEPS) throw new Error(noLoopMessage(data.params));
                self.postMessage({ type: "round", best: step.improved ? search.result() : null, index: step.index });
            }
            setTimeout(slice, 0);
        } catch (err) {
            self.postMessage({ type: "error", message: err.message });
        }
    };
    slice();
};
