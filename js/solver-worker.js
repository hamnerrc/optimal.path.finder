// Runs solveLoop() off the main thread. See runSolver() in js/solve.js.
importScripts("geometry.js", "solver.js");

const PROGRESS_INTERVAL_MS = 200;

self.onmessage = ({ data }) => {
    try {
        const generator = solveLoop(data.network, data.params);
        let step, lastPost = 0, pendingBest = null;
        while (!(step = generator.next()).done) {
            if (step.value.best) pendingBest = step.value.best;
            const now = Date.now();
            if (now - lastPost >= PROGRESS_INTERVAL_MS) {
                self.postMessage({ type: "progress", fraction: step.value.fraction, best: pendingBest });
                pendingBest = null;
                lastPost = now;
            }
        }
        self.postMessage({ type: "done", result: step.value });
    } catch (err) {
        self.postMessage({ type: "error", message: err.message });
    }
};
