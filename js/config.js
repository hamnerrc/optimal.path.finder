// ==========================================================================
// App-wide settings. Tweak values here rather than inside the modules.
// ==========================================================================

const CONFIG = {
    map: {
        initialCenter: [20, 0],
        initialZoom: 2,
        // Map styles offered in the layer switcher; the first is the default.
        // Not used: tile.openstreetmap.org (blocks many apps under its usage
        // policy) and CARTO basemaps (now require an API key).
        basemaps: [
            {
                name: "Streets",
                url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}",
                attribution: "Tiles &copy; Esri &mdash; Source: Esri, HERE, Garmin, USGS, NGA, and the GIS User Community",
                maxZoom: 19
            },
            {
                name: "Paths & trails (CyclOSM)",
                url: "https://{s}.tile-cyclosm.openstreetmap.fr/cyclosm/{z}/{x}/{y}.png",
                subdomains: "abc",
                attribution: '<a href="https://www.cyclosm.org">CyclOSM</a> | &copy; ' +
                    '<a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
                maxZoom: 20
            },
            {
                name: "OpenStreetMap France",
                url: "https://{s}.tile.openstreetmap.fr/osmfr/{z}/{x}/{y}.png",
                subdomains: "abc",
                attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors, tiles by OSM France',
                maxZoom: 20
            }
        ]
    },

    // Default value of the "Max loop length" field, in miles.
    defaultDistanceMiles: 5,

    // Area mode: default share of the drawn area the loop must enclose, and
    // how far beyond the drawn area roads are loaded (1.3 = 30% larger), so
    // the loop can use roads just outside its edge.
    defaultCoveragePercent: 90,
    areaMargin: 1.3,

    // How long the solver searches for each loop.
    searchEffort: {
        quick: { label: "Quick", ms: 3000 },
        normal: { label: "Normal", ms: 8000 },
        thorough: { label: "Thorough", ms: 25000 }
    },
    defaultEffort: "normal",

    // Default pace for time estimates: seconds per mile (run), mph (bike).
    defaultRunPaceSecPerMile: 540,
    defaultBikeSpeedMph: 15,

    // Ask for confirmation before downloading areas larger than this.
    largeAreaSqMiles: 300,

    // OSM highway types that make up the routable network. Deliberately broad:
    // unsuitable roads are easier to weed out by hand once a route exists.
    roadTypes: [
        "motorway", "motorway_link",
        "trunk", "trunk_link",
        "primary", "primary_link",
        "secondary", "secondary_link",
        "tertiary", "tertiary_link",
        "unclassified", "residential", "living_street", "road",
        "service", "pedestrian", "track",
        "footway", "path", "cycleway", "bridleway", "steps"
    ],

    // Drawn thicker on the map.
    majorRoadTypes: ["motorway", "trunk", "primary", "secondary"],

    overpass: {
        // Tried in order; the next one is used if a server is busy or down.
        endpoints: [
            "https://overpass-api.de/api/interpreter",
            "https://overpass.private.coffee/api/interpreter"
        ],
        timeoutSeconds: 90,
        cacheSize: 6
    },

    elevation: {
        url: "https://api.open-meteo.com/v1/elevation",
        batchSize: 100,          // coordinates per request (API limit)
        maxSamples: 300,
        minSpacingM: 25,
        climbThresholdM: 2       // ignore up/down wiggles smaller than this
    },

    geocoder: {
        url: "https://nominatim.openstreetmap.org/search",
        limit: 5
    },

    colors: {
        accent: "#2563eb",
        pending: "#f59e0b",
        network: "#64748b",
        route: "#e11d48",
        routeMuted: "#7c3aed",
        start: "#16a34a"
    }
};
