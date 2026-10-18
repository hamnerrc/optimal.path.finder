// ==========================================================================
// Elevation along a loop (Open-Meteo elevation API, ~90 m terrain data).
//
// Heights are sampled once, evenly along the loop. The profile for any start
// point and direction is then read from those samples without refetching.
// ==========================================================================

async function fetchLoopElevation(route, signal) {
    const { url, batchSize, maxSamples, minSpacingM } = CONFIG.elevation;
    const length = loopLength(route);
    const count = Math.max(16, Math.min(maxSamples, Math.ceil(length / minSpacingM)));
    const offsets = Float64Array.from({ length: count }, (_, i) => (i * length) / count);
    const points = Array.from(offsets, (d) => pointAtOffset(route, d));
    const heights = new Float64Array(count);

    for (let i = 0; i < count; i += batchSize) {
        const batch = points.slice(i, i + batchSize);
        const query = `latitude=${batch.map(p => p[0].toFixed(5)).join(",")}` +
            `&longitude=${batch.map(p => p[1].toFixed(5)).join(",")}`;
        const data = await fetchWithRetry(`${url}?${query}`, signal);
        if (!Array.isArray(data.elevation)) throw new Error("Unexpected elevation response");
        data.elevation.forEach((h, k) => { heights[i + k] = h; });
    }
    return { offsets, heights, length };
}

// The free API rate-limits bursts (HTTP 429); wait and try again a few times.
async function fetchWithRetry(url, signal, attempts = 3) {
    for (let i = 1; ; i++) {
        const response = await fetch(url, { signal });
        if (response.ok) return response.json();
        if (response.status !== 429 || i >= attempts) throw new Error(`Elevation service returned HTTP ${response.status}`);
        await new Promise(resolve => setTimeout(resolve, 1500 * i));
    }
}

// Height at a distance along the loop, interpolated between samples.
function heightAtOffset(elevation, offset) {
    const { heights, length } = elevation;
    const n = heights.length;
    const pos = ((((offset % length) + length) % length) / length) * n;
    const i = Math.floor(pos) % n;
    const f = pos - Math.floor(pos);
    return heights[i] * (1 - f) + heights[(i + 1) % n] * f;
}

// Profile as run from the route's chosen start and direction.
// Returns { points: [{ distance, height }], gain, loss, min, max }.
function elevationProfile(route) {
    const elevation = route.elevation;
    const n = elevation.heights.length;
    const length = loopLength(route);
    const points = [];
    for (let i = 0; i <= n; i++) {
        const distance = (i / n) * length;
        points.push({ distance, height: heightAtOffset(elevation, offsetFromStart(route, distance)) });
    }

    // Climb totals, ignoring wiggles smaller than the threshold (data noise).
    const threshold = CONFIG.elevation.climbThresholdM;
    let gain = 0, loss = 0, anchor = points[0].height;
    for (const { height } of points) {
        if (height - anchor >= threshold) {
            gain += height - anchor;
            anchor = height;
        } else if (anchor - height >= threshold) {
            loss += anchor - height;
            anchor = height;
        }
    }

    const heights = points.map(p => p.height);
    return { points, gain, loss, min: Math.min(...heights), max: Math.max(...heights) };
}
