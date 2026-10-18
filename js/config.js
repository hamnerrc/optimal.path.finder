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
    // how far beyond the drawn area roads are loaded (1.05 = 5% larger, as a
    // scale factor on the area's convex hull), so the loop can use roads
    // just outside its edge. If the coverage can't be reached, the search
    // is repeated with the next margin.
    defaultCoveragePercent: 90,
    areaMargins: [1.05, 1.2, 1.4],

    // Default pace for time estimates, in seconds per mile.
    defaultPaceSecPerMile: 540,

    // Big searches. Up to fullDetailMaxSqMiles of road area, every road is
    // loaded at once (a 10 mi loop). Larger searches go in two stages: a
    // rough loop on major roads only, from coarser tiles (at most
    // maxCoarseTiles of them), then all roads in a corridor along that loop
    // to improve it.
    chunked: {
        fullDetailMaxSqMiles: 80,
        maxCoarseTiles: 150,
        coarseRoadTypes: [
            "motorway", "motorway_link", "trunk", "trunk_link",
            "primary", "primary_link", "secondary", "secondary_link",
            "tertiary", "tertiary_link"
        ],
        // Above this area tertiary roads are dropped from the rough stage.
        tertiaryMaxSqMiles: 5000,
        // Overpass fallback: download tile sizes, in degrees.
        tileDegrees: 0.5,
        largeTileDegrees: 1,
        // Start mode: no point on a loop of length L is further than L/2 from
        // the start, but the roundest loops stay within about L/π. The rough
        // stage loads roads within this fraction of L.
        startRadiusFraction: 0.4,
        corridorRadiusM: 1000
    },

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

    // Road vector tiles (OpenFreeMap: every OpenStreetMap road worldwide,
    // rebuilt weekly). Zoom 14 tiles hold every road; minZoom is the
    // coarsest used for major roads. Loaded tiles are kept in memory, up
    // to about cacheMaxVertices road points.
    roadTiles: {
        tileJsonUrl: "https://tiles.openfreemap.org/planet",
        zoom: 14,
        minZoom: 8,
        concurrency: 16,
        cacheMaxVertices: 4000000,
        attribution: 'Roads <a href="https://openfreemap.org">OpenFreeMap</a> &copy; <a href="https://www.openmaptiles.org/">OpenMapTiles</a> ' +
            '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
    },

    overpass: {
        // Tried in order; the next one is used if a server is busy or down.
        endpoints: [
            "https://overpass-api.de/api/interpreter",
            "https://overpass.private.coffee/api/interpreter",
            "https://maps.mail.ru/osm/tools/overpass/api/interpreter"
        ],
        timeoutSeconds: 90,
        // Downloads kept in memory for reuse (also limited by their total
        // number of ways; a 10 mi loop in central Chicago is ~115k).
        cacheSize: 8,
        cacheMaxWays: 400000
    },

    elevation: {
        url: "https://api.open-meteo.com/v1/elevation",
        batchSize: 100,          // coordinates per request (API limit)
        maxSamples: 200,
        minSpacingM: 40,
        climbThresholdM: 2       // ignore up/down wiggles smaller than this
    },

    geocoder: {
        url: "https://nominatim.openstreetmap.org/search",
        lookupUrl: "https://nominatim.openstreetmap.org/lookup",
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
