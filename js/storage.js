// ==========================================================================
// Browser storage: preferences and saved routes (localStorage, this browser
// only). Every access is guarded, since storage can be disabled or full.
// ==========================================================================

const STORAGE_KEYS = {
    prefs: "intvl-route.prefs",
    routes: "intvl-route.saved-routes"
};

function readStored(key, fallback) {
    try {
        const raw = localStorage.getItem(key);
        return raw ? JSON.parse(raw) : fallback;
    } catch {
        return fallback;
    }
}

function writeStored(key, value) {
    try {
        localStorage.setItem(key, JSON.stringify(value));
        return true;
    } catch {
        return false;
    }
}

const loadPrefs = () => readStored(STORAGE_KEYS.prefs, {});
const savePrefs = (prefs) => writeStored(STORAGE_KEYS.prefs, prefs);

const loadSavedRoutes = () => readStored(STORAGE_KEYS.routes, []);
const storeSavedRoutes = (routes) => writeStored(STORAGE_KEYS.routes, routes);

// The parts of a route worth keeping. Coordinates are rounded to ~10 cm.
function serializeRoute(route, name) {
    return {
        id: `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
        name,
        savedAt: new Date().toISOString(),
        mode: route.mode,
        coords: route.coords.map(([lat, lng]) => [Math.round(lat * 1e6) / 1e6, Math.round(lng * 1e6) / 1e6]),
        lengthM: route.lengthM,
        areaM2: route.areaM2,
        iq: route.iq,
        coverage: route.coverage ?? null,
        startOffsetM: route.startOffsetM,
        reversed: route.reversed,
        // Kept so reopening the loop doesn't need the elevation service.
        elevation: typeof route.elevation === "object" && route.elevation
            ? { heights: Array.from(route.elevation.heights, h => Math.round(h * 10) / 10), length: route.elevation.length }
            : null
    };
}
