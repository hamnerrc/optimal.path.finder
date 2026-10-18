// ==========================================================================
// Map setup and map-layer drawing helpers
// ==========================================================================

const map = L.map("map", {
    worldCopyJump: true,
    preferCanvas: true,      // canvas draws thousands of road segments far faster than SVG
    zoomControl: false
}).setView(CONFIG.map.initialCenter, CONFIG.map.initialZoom);

L.control.zoom({ position: "bottomright" }).addTo(map);
L.control.scale({ position: "bottomright", imperial: true, metric: false }).addTo(map);

const basemaps = Object.fromEntries(CONFIG.map.basemaps.map(({ name, url, ...options }) =>
    [name, L.tileLayer(url, options)]
));
Object.values(basemaps)[0].addTo(map);
L.control.layers(basemaps, null, { position: "bottomright" }).addTo(map);

const layers = {
    starts: L.layerGroup().addTo(map),
    shape: L.layerGroup().addTo(map),
    network: L.layerGroup().addTo(map)
};

// --------------------------------------------------------------------------
// Icons
// --------------------------------------------------------------------------

const startIcon = (label, active) => L.divIcon({
    className: "",
    html: `<div class="start-pin${active ? " active" : ""}"><span>${label}</span></div>`,
    iconSize: [30, 38],
    iconAnchor: [15, 36]
});

const handleIcon = (pending) => L.divIcon({
    className: "",
    html: `<div class="shape-handle${pending ? " pending" : ""}"></div>`,
    iconSize: [18, 18],
    iconAnchor: [9, 9]
});

// --------------------------------------------------------------------------
// Region outlines
// --------------------------------------------------------------------------

const regionStyle = (variant) => ({
    color: variant === "pending" ? CONFIG.colors.pending : CONFIG.colors.accent,
    weight: 2,
    fillColor: variant === "pending" ? CONFIG.colors.pending : CONFIG.colors.accent,
    fillOpacity: variant === "muted" ? 0.02 : 0.06,
    dashArray: variant === "muted" ? "6 6" : null,
    interactive: false
});

function createRegionLayer(region, variant) {
    return region.type === "circle"
        ? L.circle([region.center.lat, region.center.lng], { radius: region.radiusMeters, ...regionStyle(variant) })
        : L.polygon(region.outline.map(p => [p.lat, p.lng]), regionStyle(variant));
}

// Updates a layer made by createRegionLayer in place (cheap while dragging).
function updateRegionLayer(layer, region) {
    if (region.type === "circle" && layer instanceof L.Circle) {
        layer.setLatLng([region.center.lat, region.center.lng]).setRadius(region.radiusMeters);
        return layer;
    }
    if (region.type === "ellipse" && layer instanceof L.Polygon) {
        layer.setLatLngs(region.outline.map(p => [p.lat, p.lng]));
        return layer;
    }
    return null;
}

// --------------------------------------------------------------------------
// Road network
// --------------------------------------------------------------------------

// Two multi-polylines (major / minor roads) instead of one layer per segment.
function drawNetwork(network) {
    layers.network.clearLayers();
    const major = new Set(CONFIG.majorRoadTypes);
    const majorLines = [];
    const minorLines = [];

    for (const edge of network.edges) {
        (major.has(edge.highway) ? majorLines : minorLines).push(edge.coords);
    }

    const style = { color: CONFIG.colors.network, interactive: false, smoothFactor: 1.5 };
    if (minorLines.length) L.polyline(minorLines, { ...style, weight: 2.5, opacity: 0.75 }).addTo(layers.network);
    if (majorLines.length) L.polyline(majorLines, { ...style, weight: 4, opacity: 0.9 }).addTo(layers.network);

    createRegionLayer(network.region, "muted").addTo(layers.network);
}

// Fits the region into the part of the map not covered by the side panel.
function fitRegion(region) {
    const { minLat, maxLat, minLng, maxLng } = region.bbox;
    const panel = document.getElementById("panel");
    const sideBySide = window.innerWidth > 720;
    const offset = sideBySide ? panel.offsetWidth + 24 : 0;
    const bottom = sideBySide ? 0 : panel.offsetHeight;

    map.fitBounds([[minLat, minLng], [maxLat, maxLng]], {
        paddingTopLeft: [offset + 40, 40],
        paddingBottomRight: [40, bottom + 40]
    });
}
