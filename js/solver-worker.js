// Runs one LoopSearch off the main thread. See runSolver() in js/solve.js.
// Posts { type: "round", best } after every search round (`best` is this
// search's best loop when it improved, otherwise null) until terminated.
importScripts("geometry.js", "solver.js");

const SLICE_MS = 50;
let search = null;

self.onmessage = ({ data }) => {
    try {
        search = new LoopSearch(data.graph, data.params, data.seed);
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
                if (step?.roundDone) {
                    if (!search.leader() && search.rounds >= 3) throw new Error(noLoopMessage(data.params));
                    self.postMessage({ type: "round", best: step.improved ? search.result() : null });
                }
            }
            setTimeout(slice, 0);
        } catch (err) {
            self.postMessage({ type: "error", message: err.message });
        }
    };
    slice();
};
