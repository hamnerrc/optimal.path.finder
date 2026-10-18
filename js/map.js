// ==========================================================================
// Map setup and map-layer drawing helpers
// ==========================================================================

const map = L.map("map", {
    worldCopyJump: true,
    preferCanvas: true,      // canvas draws thousands of road segments far faster than SVG
    zoomControl: false
}).setView(CONFIG.map.initialCenter, CONFIG.map.initialZoom);

L.control.zoom({ position: "bottomright" }).addTo(map);

let scaleControl = null;
function setScaleUnits(name) {
    scaleControl?.remove();
    scaleControl = L.control.scale({ position: "bottomright", imperial: name === "mi", metric: name === "km" }).addTo(map);
}

const basemaps = Object.fromEntries(CONFIG.map.basemaps.map(({ name, url, ...options }) =>
    [name, L.tileLayer(url, options)]
));
Object.values(basemaps)[0].addTo(map);
L.control.layers(basemaps, null, { position: "bottomright" }).addTo(map);
map.attributionControl.addAttribution(CONFIG.roadTiles.attribution);

const layers = {
    network: L.layerGroup().addTo(map),
    starts: L.layerGroup().addTo(map),
    shape: L.layerGroup().addTo(map),
    place: L.layerGroup().addTo(map),
    routes: L.layerGroup().addTo(map),
    routeDecor: L.layerGroup().addTo(map)
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

// Start/finish flag; dragged along the loop to choose where the run starts.
const startFlagIcon = () => L.divIcon({
    className: "",
    html: `<div class="start-flag"><svg viewBox="0 0 24 24"><path d="M6 21V4h11l-2 4 2 4H6" /></svg></div>`,
    iconSize: [30, 30],
    iconAnchor: [15, 15]
});

const arrowIcon = (degrees) => L.divIcon({
    className: "",
    html: `<div class="direction-arrow" style="transform: rotate(${degrees.toFixed(0)}deg)"><svg viewBox="0 0 16 16"><path d="M4 11l4-6 4 6" /></svg></div>`,
    iconSize: [16, 16],
    iconAnchor: [8, 8]
});

const hoverIcon = () => L.divIcon({ className: "", html: `<div class="hover-dot"></div>`, iconSize: [14, 14], iconAnchor: [7, 7] });

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
    if (region.type !== "circle" && layer instanceof L.Polygon) {
        layer.setLatLngs(region.outline.map(p => [p.lat, p.lng]));
        return layer;
    }
    return null;
}

// --------------------------------------------------------------------------
// Road network
// --------------------------------------------------------------------------

// Two multi-polylines (major / minor roads) instead of one layer per segment,
// added to `group`.
function drawNetwork(network, group) {
    const major = new Set(CONFIG.majorRoadTypes);
    const majorLines = [];
    const minorLines = [];

    for (const edge of network.edges) {
        (major.has(edge.highway) ? majorLines : minorLines).push(edge.coords);
    }

    const style = { color: CONFIG.colors.network, interactive: false, smoothFactor: 1.5 };
    if (minorLines.length) L.polyline(minorLines, { ...style, weight: 1.5, opacity: 0.45 }).addTo(group);
    if (majorLines.length) L.polyline(majorLines, { ...style, weight: 3, opacity: 0.6 }).addTo(group);

    // (A corridor along a rough loop has no outline to draw.)
    if (network.region.type === "circle" || network.region.outline) createRegionLayer(network.region, "muted").addTo(group);
}

// --------------------------------------------------------------------------
// Loops
// --------------------------------------------------------------------------

const routeStyle = (active) => ({
    color: active ? CONFIG.colors.route : CONFIG.colors.routeMuted,
    weight: active ? 5 : 4,
    opacity: active ? 0.95 : 0.75,
    dashArray: active ? null : "10 6",
    fillColor: active ? CONFIG.colors.route : CONFIG.colors.routeMuted,
    fillOpacity: active ? 0.1 : 0.05,
    lineJoin: "round"
});

// Fits the region into the part of the map not covered by the side panel.
function fitRegion(region) {
    const { minLat, maxLat, minLng, maxLng } = region.bbox;
    fitBounds([[minLat, minLng], [maxLat, maxLng]]);
}

function fitBounds(bounds) {
    const panel = document.getElementById("panel");
    const sideBySide = window.innerWidth > 720;
    const offset = sideBySide ? panel.offsetWidth + 24 : 0;
    const bottom = sideBySide ? 0 : panel.offsetHeight;

    map.fitBounds(bounds, {
        paddingTopLeft: [offset + 40, 40],
        paddingBottomRight: [40, bottom + 40]
    });
}
