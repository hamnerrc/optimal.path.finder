// Runs one SweepSearch at a time off the main thread. See runSolver() in
// js/solve.js. On { type: "run", run, … } it posts { type: "round", run,
// best, index } after every sweep (`best` is this search's best loop when it
// improved, otherwise null; `index` the sweep's number in the shared
// sequence) until told { type: "stop" } or given another run.
// (With the page's release number, see index.html.)
importScripts(...["geometry.js", "solver.js"].map(f => f + self.location.search));

const SLICE_MS = 50;
let current = 0;

self.onmessage = ({ data }) => {
    if (data.type === "stop") {
        current = 0;
        return;
    }
    const run = current = data.run;
    let search;
    try {
        search = new SweepSearch(data.graph, data.params, data.worker, data.workers);
    } catch (err) {
        self.postMessage({ type: "error", run, message: err.message });
        return;
    }
    const steps = search.run();
    const slice = () => {
        if (current !== run) return;
        try {
            const sliceEnd = Date.now() + SLICE_MS;
            while (Date.now() < sliceEnd) {
                const step = steps.next().value;
                if (!search.leader() && search.rounds >= MAX_EMPTY_SWEEPS) throw new Error(noLoopMessage(data.params));
                self.postMessage({ type: "round", run, best: step.improved ? search.result() : null, index: step.index });
            }
            setTimeout(slice, 0);
        } catch (err) {
            self.postMessage({ type: "error", run, message: err.message });
        }
    };
    slice();
};
