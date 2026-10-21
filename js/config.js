// ==========================================================================
// App-wide settings. Tweak values here rather than inside the modules.
// ==========================================================================

const CONFIG = {
    // Release number, as in index.html's ?v= (for the worker's scripts).
    release: 15,

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
    // how far beyond the drawn area roads are loaded (1.2 = 20% larger, as a
    // scale factor on the area's convex hull and bounding box), so the loop
    // can use roads outside its edge. If the coverage can't be reached, the
    // search is repeated with the next margin.
    defaultCoveragePercent: 90,
    areaMargins: [1.2, 1.4],
    // (Only if the loop got at least this share of the way to the target:
    // further short, it's the roads in the area that are too few.)
    widenFrom: 0.5,

    // "Hills" slider: meters of extra length a meter of climb counts as
    // while searching (0 to maxClimbCost; see SOLVER.climbCost).
    defaultClimbCost: 3,
    maxClimbCost: 10,

    // Start mode: if no loop fits within reach of a start point, roads up to
    // startWidening times further out are loaded, and so on up to
    // startWideningMaxM (see searchStart).
    startWidening: 2,
    startWideningMaxM: 32000,

    // Default pace for time estimates, in seconds per mile.
    defaultPaceSecPerMile: 540,

    // Big searches. Up to fullDetailMaxSqMiles of road area, every road is
    // loaded at once (a 10 mi loop). So are larger areas with few roads
    // (the countryside): up to maxFullTiles road tiles holding no more than
    // maxFullVertices road points. Other searches go in two stages: a rough
    // loop on major roads only, from coarser tiles (at most maxCoarseTiles
    // of them), then all roads in a corridor along that loop to improve it,
    // and again along the improved loop (up to corridorPasses passes, until
    // a pass improves the loop by less than passMinGain).
    chunked: {
        fullDetailMaxSqMiles: 80,
        maxFullTiles: 2500,
        maxFullVertices: 800000,
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
        // The corridor reaches this share of the rough loop's size (its
        // length / π) to either side, and at least corridorMinM.
        corridorFraction: 0.05,
        corridorMinM: 1000,
        // At most this many tiles per corridor (see corridorPlan): a
        // narrower corridor, or coarser tiles (down to corridorMinZoom), if
        // needed. Keeps a loop around a whole country quick and its road
        // network small enough for the browser.
        maxCorridorTiles: 1500,
        // ...and holding at most this many road points (else half as wide).
        maxCorridorVertices: 1500000,
        corridorMinZoom: 12,
        corridorMinTiles: 0.25,
        // Loops expected to be longer than this (2,000 km) start from
        // motorways, trunk and primary roads of zoom hugeZoom tiles, get at
        // most hugePasses corridor passes, each at least hugeCorridorMinM to
        // either side (zoom 7 roads can be a kilometer off), of tiles down to
        // zoom hugeCorridorMinZoom if need be. (Their climb
        // comes from coarse terrain tiles: an estimate, see addRoadClimb.)
        hugeLoopM: 2000000,
        hugeZoom: 7,
        hugePasses: 1,
        hugeCorridorMinM: 3000,
        hugeCorridorMinZoom: 11,
        hugeRoadTypes: ["motorway", "motorway_link", "trunk", "trunk_link", "primary", "primary_link"],
        corridorPasses: 3,
        // A coverage or area range is this much wider each way for the
        // rough loop (see roughParams).
        roughSlack: 0.06,
        // ...and a huge loop's length limit from a start point this much
        // shorter (zoom 7 roads are much simplified, so the loop is longer
        // on all roads).
        roughLengthSlack: 0.05,
        // ...and a climb limit this much lower (the climb of simplified roads
        // from coarse terrain tiles is an underestimate).
        roughClimbSlack: 0.15,
        // The tiles along a search's best loop start downloading once the
        // search is this settled (0..1, see SearchTracker.fraction): before
        // that the loop still changes a lot, and the downloads are wasted.
        prefetchSettled: 0.5,
        passMinGain: 0.005
    },

    // Road networks with more points than this aren't drawn in full (see
    // drawNetwork): only their major roads, or none.
    maxDrawnRoadPoints: 150000,

    // Ask for confirmation before downloading areas larger than this.
    largeAreaSqMiles: 500,

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

    // Left out with "Avoid motorways" (with roads tagged as expressways).
    motorwayTypes: ["motorway", "motorway_link", "trunk", "trunk_link"],

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
        concurrency: 64,
        cacheMaxVertices: 4000000,
        // Tiles loaded ahead of a search, as soon as its pin, shape or
        // place is set.
        prefetchMaxTiles: 600,
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

    // Elevation profile: terrain tiles (Terrarium-encoded PNGs), read at the
    // most detailed zoom (up to maxTileZoom) that needs at most maxTiles
    // tiles; Open-Meteo if they can't be loaded.
    elevation: {
        tileUrl: "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png",
        maxTileZoom: 14,
        maxTiles: 48,
        cacheTiles: 128,
        // The climb along every road, for the search (see SOLVER.climbCost):
        // read at the most detailed zoom (up to searchMaxZoom) that needs at
        // most searchMaxTiles tiles.
        searchMaxZoom: 13,
        searchMaxTiles: 64,
        url: "https://api.open-meteo.com/v1/elevation",
        batchSize: 100,          // coordinates per request (API limit)
        maxSamples: 1000,
        minSpacingM: 20,
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
        start: "#16a34a",
        flag: "#d97706"
    }
};
