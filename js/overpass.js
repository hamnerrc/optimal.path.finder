// ==========================================================================
// Overpass API road loader
// Downloads OSM ways inside a region. Recent responses are cached in memory,
// and a fallback server is tried if the primary one is busy or down.
// ==========================================================================

const overpassCache = new Map();

function buildRoadQuery(region) {
    const types = CONFIG.roadTypes.join("|");
    return `[out:json][timeout:${CONFIG.overpass.timeoutSeconds}];` +
        `way["highway"~"^(${types})$"]${region.overpassFilter};` +
        `out geom qt;`;
}

async function fetchRoads(region, signal) {
    const query = buildRoadQuery(region);
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
        if (status === 429) return "The map data server is busy. Please wait a minute and try again.";
        if (status === 504) return "The map data server timed out. Try a smaller area.";
        if (status === 400) return "The map data request was rejected.";
        return `The map data server returned an error (HTTP ${status}).`;
    }
}

const isRetryable = (err) => err.status === 429 || err.status >= 500;
