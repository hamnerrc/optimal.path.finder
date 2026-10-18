// ==========================================================================
// Overpass API road loader
// Downloads OSM ways inside a region. Recent responses are cached in memory,
// and a fallback server is tried if the primary one is busy or down.
// ==========================================================================

const overpassCache = new Map();

function buildRoadQuery(region, roadTypes) {
    return `[out:json][timeout:${CONFIG.overpass.timeoutSeconds}];` +
        `way["highway"~"^(${roadTypes.join("|")})$"]${region.overpassFilter};` +
        `out geom qt;`;
}

// Only region.overpassFilter is used, so any object with one works (e.g. a
// bounding-box tile). roadTypes defaults to every routable type.
async function fetchRoads(region, signal, roadTypes = CONFIG.roadTypes) {
    const query = buildRoadQuery(region, roadTypes);
    if (overpassCache.has(query)) return overpassCache.get(query);

    let lastError = null;
    for (const endpoint of CONFIG.overpass.endpoints) {
        try {
            const response = await fetch(endpoint, {
                method: "POST",
                headers: { "Content-Type": "application/x-www-form-urlencoded" },
                body: `data=${encodeURIComponent(query)}`,
                signal
            });

            if (!response.ok) {
                lastError = new OverpassError(response.status);
                // Busy or failing server: try the next one. Anything else won't improve.
                if (response.status === 429 || response.status >= 500) continue;
                throw lastError;
            }

            const data = await response.json();
            // Overpass reports timeouts and memory limits inside a 200 reply.
            if (/runtime error/i.test(data.remark || "")) throw new OverpassError("too-big");
            rememberResponse(query, data);
            return data;
        } catch (err) {
            if (err.name === "AbortError" || err instanceof OverpassError && !isRetryable(err)) throw err;
            lastError = err;
        }
    }
    throw lastError || new Error("No Overpass endpoint available");
}

function rememberResponse(query, data) {
    overpassCache.set(query, data);
    if (overpassCache.size > CONFIG.overpass.cacheSize) {
        overpassCache.delete(overpassCache.keys().next().value);
    }
}

class OverpassError extends Error {
    constructor(status) {
        super(OverpassError.describe(status));
        this.name = "OverpassError";
        this.status = status;
    }

    static describe(status) {
        if (status === "too-big") return "This area has too many roads to download at once.";
        if (status === 429) return "The map data server is busy. Please wait a minute and try again.";
        if (status === 504) return "The map data server timed out. Try a smaller area.";
        if (status === 400) return "The map data request was rejected.";
        return `The map data server returned an error (HTTP ${status}).`;
    }
}

const isRetryable = (err) => err.status === 429 || err.status >= 500;

// Errors that mean "the request was too large", as opposed to "the server is
// unavailable". A smaller, chunked request may still succeed.
const isTooBig = (err) => err instanceof OverpassError && (err.status === "too-big" || err.status === 504);

// Downloads a large region as a grid of bounding-box tiles (one request each)
// and merges the results. onTile(done, total) reports progress.
async function fetchRoadsTiled(bbox, tileDegrees, roadTypes, signal, onTile) {
    const rows = Math.max(1, Math.ceil((bbox.maxLat - bbox.minLat) / tileDegrees));
    const cols = Math.max(1, Math.ceil((bbox.maxLng - bbox.minLng) / tileDegrees));
    const dLat = (bbox.maxLat - bbox.minLat) / rows;
    const dLng = (bbox.maxLng - bbox.minLng) / cols;
    const ways = new Map();
    let done = 0;
    for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
            onTile?.(done, rows * cols);
            const s = bbox.minLat + r * dLat, w = bbox.minLng + c * dLng;
            const tile = { overpassFilter: `(${s.toFixed(5)},${w.toFixed(5)},${(s + dLat).toFixed(5)},${(w + dLng).toFixed(5)})` };
            const data = await fetchRoads(tile, signal, roadTypes);
            for (const el of data.elements || []) if (el.type === "way") ways.set(el.id, el);
            done++;
        }
    }
    onTile?.(done, rows * cols);
    return { elements: [...ways.values()] };
}
