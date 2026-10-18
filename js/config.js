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

    // Default value of the "Maximum distance" field, in miles.
    defaultDistanceMiles: 5,

    // Ask for confirmation before downloading areas larger than this.
    largeAreaSqMiles: 300,

    // OSM highway types that make up the routable network.
    roadTypes: [
        "motorway", "motorway_link",
        "trunk", "trunk_link",
        "primary", "primary_link",
        "secondary", "secondary_link",
        "tertiary", "tertiary_link",
        "unclassified", "residential", "living_street"
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

    geocoder: {
        url: "https://nominatim.openstreetmap.org/search",
        limit: 5
    },

    colors: {
        accent: "#2563eb",
        pending: "#f59e0b",
        network: "#e11d48"
    }
};
