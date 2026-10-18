// Runs solveLoop() off the main thread. See runSolver() in js/solve.js.
// The search runs in short slices so that a "stop" message can get through;
// stopping still returns the best loop found so far.
importScripts("geometry.js", "solver.js");

const PROGRESS_INTERVAL_MS = 200;
const SLICE_MS = 100;
const control = { stop: false };

self.onmessage = ({ data }) => {
    if (data.type === "stop") {
        control.stop = true;
        return;
    }
    run(data.network, data.params);
};

function run(network, params) {
    let generator;
    try {
        generator = solveLoop(network, params, control);
    } catch (err) {
        self.postMessage({ type: "error", message: err.message });
        return;
    }
    let lastPost = 0, pendingBest = null;

    const slice = () => {
        try {
            const sliceEnd = Date.now() + SLICE_MS;
            let step;
            do {
                step = generator.next();
                if (!step.done && step.value.best) pendingBest = step.value.best;
            } while (!step.done && Date.now() < sliceEnd);

            if (step.done) {
                self.postMessage({ type: "done", result: step.value });
                return;
            }
            const now = Date.now();
            if (now - lastPost >= PROGRESS_INTERVAL_MS) {
                self.postMessage({ type: "progress", fraction: step.value.fraction, best: pendingBest });
                pendingBest = null;
                lastPost = now;
            }
            setTimeout(slice, 0);
        } catch (err) {
            self.postMessage({ type: "error", message: err.message });
        }
    };
    slice();
}
