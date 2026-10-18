// ==========================================================================
// App state and UI
// ==========================================================================

const $ = (id) => document.getElementById(id);

const ui = {
    panel: $("panel"),
    modeTabs: document.querySelectorAll(".segmented [data-mode]"),

    searchForm: $("searchForm"),
    searchInput: $("searchInput"),
    searchResults: $("searchResults"),
    locateButton: $("locateButton"),

    distanceSection: $("distanceSection"),
    distanceInput: $("distanceInput"),
    pickButton: $("pickButton"),
    pickHint: $("pickHint"),
    startList: $("startList"),

    shapeSection: $("shapeSection"),
    shapeChoose: $("shapeChoose"),
    shapeDraw: $("shapeDraw"),
    shapeEdit: $("shapeEdit"),
    shapeSaved: $("shapeSaved"),
    chooseCircleButton: $("chooseCircleButton"),
    chooseEllipseButton: $("chooseEllipseButton"),
    shapeDrawTitle: $("shapeDrawTitle"),
    shapeDrawInstructions: $("shapeDrawInstructions"),
    shapeDrawProgress: $("shapeDrawProgress"),
    cancelDrawButton: $("cancelDrawButton"),
    finalizeShapeButton: $("finalizeShapeButton"),
    cancelEditButton: $("cancelEditButton"),
    doneEditButton: $("doneEditButton"),
    shapeSummaryType: $("shapeSummaryType"),
    shapeSummaryDetail: $("shapeSummaryDetail"),
    editShapeButton: $("editShapeButton"),
    redrawShapeButton: $("redrawShapeButton"),
    deleteShapeButton: $("deleteShapeButton"),

    results: $("results"),
    statIntersections: $("statIntersections"),
    statSegments: $("statSegments"),
    statMiles: $("statMiles"),
    clearNetworkButton: $("clearNetworkButton"),

    routeHint: $("routeHint"),
    getRouteButton: $("getRouteButton"),
    getRouteLabel: $("getRouteLabel"),
    cancelLoadButton: $("cancelLoadButton"),

    coords: $("coords"),
    toasts: $("toasts"),
    confirmDialog: $("confirmDialog"),
    confirmTitle: $("confirmTitle"),
    confirmMessage: $("confirmMessage")
};

const SHAPES = {
    circle: { label: "circle", points: 2, instructions: "Click two points on the map, one on each side of the circle." },
    ellipse: { label: "ellipse", points: 3, instructions: "Click three points on the map that the ellipse's edge should pass through." }
};

const state = {
    mode: "distance",          // "distance" | "shape"
    interaction: null,         // null | "pick" | "draw" | "edit"

    starts: [],                // [{ id, latlng, maxDistance, marker, circle }]
    activeStartId: null,
    nextStartId: 1,

    shape: null,               // { type, points: LatLng[] }
    shapeLayer: null,
    handles: [],               // draggable point markers while drawing/editing
    draft: null,               // { type, points } while drawing
    editSnapshot: null,        // points before editing, restored on cancel

    network: null,
    loading: null              // AbortController while a download runs
};

const formatNumber = (n, digits = 0) =>
    n.toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits });

// ==========================================================================
// Rendering
// ==========================================================================

function render() {
    const { mode, interaction, loading } = state;

    ui.modeTabs.forEach(tab => tab.setAttribute("aria-selected", String(tab.dataset.mode === mode)));
    ui.distanceSection.hidden = mode !== "distance";
    ui.shapeSection.hidden = mode !== "shape";

    // Distance mode
    ui.pickButton.classList.toggle("is-active", interaction === "pick");
    ui.pickButton.querySelector("span").textContent = interaction === "pick" ? "Click the map… (Esc to cancel)" : "Add start point";
    ui.pickHint.hidden = state.starts.length > 0 && interaction !== "pick";

    // Shape mode
    const step = interaction === "draw" ? "draw" : interaction === "edit" ? "edit" : state.shape ? "saved" : "choose";
    ui.shapeChoose.hidden = step !== "choose";
    ui.shapeDraw.hidden = step !== "draw";
    ui.shapeEdit.hidden = step !== "edit";
    ui.shapeSaved.hidden = step !== "saved";
    if (step === "draw") renderDrawProgress();
    if (step === "saved" || step === "edit") renderShapeSummary();

    // Map cursor
    map.getContainer().classList.toggle("is-picking", interaction === "pick" || interaction === "draw");

    // Footer
    const region = currentRegion();
    const blocked = interaction === "draw" || interaction === "edit";
    ui.getRouteButton.disabled = !region || blocked || Boolean(loading);
    ui.getRouteButton.classList.toggle("is-loading", Boolean(loading));
    ui.cancelLoadButton.hidden = !loading;
    if (!loading) ui.getRouteLabel.textContent = "Get Route";
    ui.routeHint.textContent = loading ? "" : routeHintText(region, blocked);
    ui.routeHint.hidden = !ui.routeHint.textContent;

    // Results
    ui.results.hidden = !state.network;
    if (state.network) {
        const { stats } = state.network;
        ui.statIntersections.textContent = formatNumber(stats.intersections);
        ui.statSegments.textContent = formatNumber(stats.segments);
        ui.statMiles.textContent = formatNumber(stats.totalMiles, 1);
    }
}

function routeHintText(region, blocked) {
    if (blocked) return "Finish the shape first.";
    if (region) return "";
    return state.mode === "distance" ? "Add a start point to continue." : "Draw an area to continue.";
}

function renderDrawProgress() {
    const { type, points } = state.draft;
    const total = SHAPES[type].points;
    ui.shapeDrawTitle.textContent = `Draw ${SHAPES[type].label}`;
    ui.shapeDrawInstructions.textContent = SHAPES[type].instructions;
    ui.shapeDrawProgress.innerHTML =
        Array.from({ length: total }, (_, i) => `<span class="${i < points.length ? "done" : ""}"></span>`).join("") +
        `<em>${points.length} of ${total} points</em>`;
    ui.finalizeShapeButton.disabled = points.length !== total;
}

function renderShapeSummary() {
    const region = createShapeRegion(state.shape);
    const area = `${formatNumber(sqKmToSqMiles(region.areaSqKm), 1)} sq mi`;

    if (region.type === "circle") {
        ui.shapeSummaryType.textContent = "Circle";
        ui.shapeSummaryDetail.textContent = `${formatNumber(metersToMiles(region.radiusMeters), 2)} mi radius · ${area}`;
    } else {
        const [major, minor] = region.semiAxesMeters.map(m => formatNumber(metersToMiles(m * 2), 2));
        ui.shapeSummaryType.textContent = "Ellipse";
        ui.shapeSummaryDetail.textContent = `${major} × ${minor} mi · ${area}`;
    }
}

// ==========================================================================
// Mode switching
// ==========================================================================

function setMode(mode) {
    if (mode === state.mode) return;
    stopInteraction();
    state.mode = mode;

    // Show only the active mode's drawings.
    toggleLayer(layers.starts, mode === "distance");
    toggleLayer(layers.shape, mode === "shape");
    render();
}

function toggleLayer(layer, visible) {
    if (visible) layer.addTo(map);
    else layer.remove();
}

// Leaves picking/drawing/editing, discarding unfinished work.
function stopInteraction() {
    if (state.interaction === "draw") cancelDrawing();
    else if (state.interaction === "edit") cancelEditing();
    state.interaction = null;
}

ui.modeTabs.forEach(tab => tab.addEventListener("click", () => setMode(tab.dataset.mode)));

// ==========================================================================
// Distance mode: start points
// ==========================================================================

ui.distanceInput.value = CONFIG.defaultDistanceMiles;

ui.pickButton.addEventListener("click", () => {
    state.interaction = state.interaction === "pick" ? null : "pick";
    render();
});

function readDistanceInput() {
    const value = parseFloat(ui.distanceInput.value);
    return value > 0 ? value : CONFIG.defaultDistanceMiles;
}

function addStart(latlng) {
    const entry = {
        id: state.nextStartId++,
        latlng,
        maxDistance: readDistanceInput(),
        marker: L.marker(latlng, { draggable: true, keyboard: false }),
        circle: null
    };

    entry.circle = createRegionLayer(startRegion(entry), "muted").addTo(layers.starts);
    entry.marker
        .on("drag", (e) => {
            entry.latlng = e.target.getLatLng();
            updateRegionLayer(entry.circle, startRegion(entry));
        })
        .on("dragend", () => renderStartList())
        .on("click", () => setActiveStart(entry.id))
        .addTo(layers.starts);

    state.starts.push(entry);
    state.activeStartId = entry.id;
    refreshStartMarkers();
    renderStartList();
}

function removeStart(id) {
    const entry = state.starts.find(s => s.id === id);
    if (!entry) return;
    layers.starts.removeLayer(entry.marker).removeLayer(entry.circle);
    state.starts = state.starts.filter(s => s.id !== id);
    if (state.activeStartId === id) state.activeStartId = state.starts[0]?.id ?? null;
    refreshStartMarkers();
    renderStartList();
    render();
}

function setActiveStart(id) {
    state.activeStartId = id;
    refreshStartMarkers();
    renderStartList();
}

const activeStart = () => state.starts.find(s => s.id === state.activeStartId) || null;

const startRegion = (entry) => createCircleRegion(entry.latlng, milesToMeters(entry.maxDistance));

function refreshStartMarkers() {
    state.starts.forEach((entry, index) => {
        const active = entry.id === state.activeStartId;
        entry.marker.setIcon(startIcon(index + 1, active)).setZIndexOffset(active ? 1000 : 0);
        entry.circle.setStyle({ opacity: active ? 0.9 : 0.35 });
    });
}

function renderStartList() {
    ui.startList.replaceChildren(...state.starts.map((entry, index) => {
        const row = document.createElement("li");
        row.className = "start-row" + (entry.id === state.activeStartId ? " active" : "");
        row.title = "Use this start point";
        row.innerHTML = `
            <span class="start-badge">${index + 1}</span>
            <span class="start-coords">${entry.latlng.lat.toFixed(4)}, ${entry.latlng.lng.toFixed(4)}</span>
            <span class="input-unit input-unit-small">
                <input type="number" min="0.5" step="0.5" value="${entry.maxDistance}" aria-label="Maximum distance for start ${index + 1}">
                <span>mi</span>
            </span>
            <button type="button" class="icon-button danger" aria-label="Remove start ${index + 1}">
                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" /></svg>
            </button>`;

        row.addEventListener("click", () => setActiveStart(entry.id));

        const input = row.querySelector("input");
        input.addEventListener("click", (e) => e.stopPropagation());
        input.addEventListener("input", () => {
            const value = parseFloat(input.value);
            if (!(value > 0)) return;
            entry.maxDistance = value;
            updateRegionLayer(entry.circle, startRegion(entry));
        });

        row.querySelector("button").addEventListener("click", (e) => {
            e.stopPropagation();
            removeStart(entry.id);
        });
        return row;
    }));
}

// ==========================================================================
// Shape mode: drawing and editing
// ==========================================================================

function startDrawing(type) {
    stopInteraction();
    state.interaction = "draw";
    state.draft = { type, points: [] };
    render();
}

function addDraftPoint(latlng) {
    const { draft } = state;
    if (draft.points.length >= SHAPES[draft.type].points) return;
    draft.points.push(latlng);
    addHandle(draft.points, draft.points.length - 1, true, () => redrawDraft());
    redrawDraft();
    render();
}

function redrawDraft() {
    const { type, points } = state.draft;
    if (points.length === SHAPES[type].points) drawShapeOutline({ type, points }, "pending");
}

function cancelDrawing() {
    clearHandles();
    state.draft = null;
    state.interaction = null;
    drawShapeOutline(state.shape);   // restore the previously saved shape, if any
}

function finalizeShape() {
    const { type, points } = state.draft;
    if (points.length !== SHAPES[type].points) return;
    clearHandles();
    state.shape = { type, points: [...points] };
    state.draft = null;
    state.interaction = null;
    drawShapeOutline(state.shape);
    render();
}

function startEditing() {
    if (!state.shape) return;
    state.interaction = "edit";
    state.editSnapshot = [...state.shape.points];
    state.shape.points.forEach((_, i) => addHandle(state.shape.points, i, false, () => {
        drawShapeOutline(state.shape);
        renderShapeSummary();
    }));
    render();
}

function cancelEditing() {
    state.shape.points = state.editSnapshot;
    finishEditing();
}

function finishEditing() {
    clearHandles();
    state.editSnapshot = null;
    state.interaction = null;
    drawShapeOutline(state.shape);
    render();
}

function deleteShape() {
    stopInteraction();
    state.shape = null;
    drawShapeOutline(null);
    render();
}

// Draggable marker bound to points[index].
function addHandle(points, index, pending, onMove) {
    const handle = L.marker(points[index], { icon: handleIcon(pending), draggable: true, keyboard: false })
        .on("drag", (e) => {
            points[index] = e.target.getLatLng();
            onMove();
        })
        .addTo(layers.shape);
    state.handles.push(handle);
}

function clearHandles() {
    state.handles.forEach(h => layers.shape.removeLayer(h));
    state.handles = [];
}

// Draws (or updates in place) the shape outline; pass null to remove it.
function drawShapeOutline(shape, variant) {
    if (!shape) {
        if (state.shapeLayer) layers.shape.removeLayer(state.shapeLayer);
        state.shapeLayer = null;
        return;
    }

    const region = createShapeRegion(shape);
    const sameVariant = state.shapeLayer && state.shapeLayer.variant === variant;
    if (sameVariant && updateRegionLayer(state.shapeLayer, region)) return;

    if (state.shapeLayer) layers.shape.removeLayer(state.shapeLayer);
    state.shapeLayer = createRegionLayer(region, variant).addTo(layers.shape);
    state.shapeLayer.variant = variant;
}

ui.chooseCircleButton.addEventListener("click", () => startDrawing("circle"));
ui.chooseEllipseButton.addEventListener("click", () => startDrawing("ellipse"));
ui.cancelDrawButton.addEventListener("click", () => { cancelDrawing(); render(); });
ui.finalizeShapeButton.addEventListener("click", finalizeShape);
ui.editShapeButton.addEventListener("click", startEditing);
ui.redrawShapeButton.addEventListener("click", () => startDrawing(state.shape.type));
ui.deleteShapeButton.addEventListener("click", deleteShape);
ui.cancelEditButton.addEventListener("click", cancelEditing);
ui.doneEditButton.addEventListener("click", finishEditing);

// ==========================================================================
// Map interaction
// ==========================================================================

map.on("click", (e) => {
    if (state.interaction === "draw") {
        addDraftPoint(e.latlng);
    } else if (state.interaction === "pick") {
        state.interaction = null;
        addStart(e.latlng);
        render();
    }
});

document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || ui.confirmDialog.open) return;
    if (state.interaction) {
        stopInteraction();
        render();
    }
    ui.searchResults.hidden = true;
});

// Cursor position readout, throttled to one DOM write per frame.
let pendingCoords = null;
map.on("mousemove", (e) => {
    if (!pendingCoords) requestAnimationFrame(updateCoords);
    pendingCoords = e.latlng;
});
map.on("zoomend", () => {
    if (!pendingCoords) requestAnimationFrame(updateCoords);
    pendingCoords = pendingCoords || map.getCenter();
});
function updateCoords() {
    const { lat, lng } = pendingCoords;
    ui.coords.textContent = `${lat.toFixed(5)}, ${lng.toFixed(5)}  ·  z${map.getZoom()}`;
    pendingCoords = null;
}
pendingCoords = map.getCenter();
updateCoords();

// ==========================================================================
// Loading the road network
// ==========================================================================

function currentRegion() {
    if (state.mode === "distance") {
        const start = activeStart();
        return start ? startRegion(start) : null;
    }
    return state.shape ? createShapeRegion(state.shape) : null;
}

async function loadNetwork() {
    const region = currentRegion();
    if (!region || state.loading) return;

    const sqMiles = sqKmToSqMiles(region.areaSqKm);
    if (sqMiles > CONFIG.largeAreaSqMiles) {
        const ok = await confirmDialog(
            "Large area",
            `This area covers about ${formatNumber(sqMiles)} sq mi. Downloading its roads may take a while ` +
            `and could slow your browser down. Continue anyway?`
        );
        if (!ok) return;
    }

    const controller = new AbortController();
    state.loading = controller;
    render();

    try {
        ui.getRouteLabel.textContent = "Downloading roads…";
        const osm = await fetchRoads(region, controller.signal);

        ui.getRouteLabel.textContent = "Building network…";
        await nextFrame();
        const network = buildRoadNetwork(osm, region);

        if (network.edges.length === 0) {
            toast("No roads found in this area.", "warning");
            return;
        }

        state.network = network;
        drawNetwork(network);
        fitRegion(region);
        toast(`Loaded ${formatNumber(network.stats.intersections)} intersections.`, "success");
        console.log("[Network]", network);
    } catch (err) {
        if (err.name === "AbortError") {
            toast("Download cancelled.");
        } else {
            console.error("[Network] Failed to load roads:", err);
            toast(err instanceof OverpassError ? err.message : "Couldn't load the road network. Check your connection and try again.", "error");
        }
    } finally {
        state.loading = null;
        render();
    }
}

// Yields so the browser can paint the loading state before heavy work.
const nextFrame = () => new Promise(resolve => requestAnimationFrame(() => setTimeout(resolve, 0)));

ui.getRouteButton.addEventListener("click", loadNetwork);
ui.cancelLoadButton.addEventListener("click", () => state.loading?.abort());
ui.clearNetworkButton.addEventListener("click", () => {
    state.network = null;
    layers.network.clearLayers();
    render();
});

// ==========================================================================
// Place search (Nominatim) and geolocation
// ==========================================================================

let searchController = null;

ui.searchForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const query = ui.searchInput.value.trim();
    if (!query) return;

    searchController?.abort();
    searchController = new AbortController();

    try {
        const url = `${CONFIG.geocoder.url}?format=jsonv2&limit=${CONFIG.geocoder.limit}&q=${encodeURIComponent(query)}`;
        const response = await fetch(url, { signal: searchController.signal, headers: { "Accept-Language": navigator.language } });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        showSearchResults(await response.json());
    } catch (err) {
        if (err.name !== "AbortError") toast("Place search failed. Please try again.", "error");
    }
});

function showSearchResults(results) {
    if (results.length === 0) {
        ui.searchResults.innerHTML = `<li class="empty">No places found.</li>`;
        ui.searchResults.hidden = false;
        return;
    }

    ui.searchResults.replaceChildren(...results.map(place => {
        const item = document.createElement("li");
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = place.display_name;
        button.addEventListener("click", () => {
            const [south, north, west, east] = place.boundingbox.map(Number);
            map.flyToBounds([[south, west], [north, east]], { maxZoom: 15, duration: 0.8 });
            ui.searchResults.hidden = true;
            ui.searchInput.value = place.display_name.split(",")[0];
        });
        item.appendChild(button);
        return item;
    }));
    ui.searchResults.hidden = false;
}

document.addEventListener("click", (e) => {
    if (!ui.searchForm.contains(e.target)) ui.searchResults.hidden = true;
});

ui.locateButton.addEventListener("click", () => {
    if (!navigator.geolocation) return toast("Location isn't available in this browser.", "error");
    ui.locateButton.classList.add("is-busy");
    navigator.geolocation.getCurrentPosition(
        (pos) => {
            ui.locateButton.classList.remove("is-busy");
            map.flyTo([pos.coords.latitude, pos.coords.longitude], 14, { duration: 0.8 });
        },
        () => {
            ui.locateButton.classList.remove("is-busy");
            toast("Couldn't get your location.", "error");
        },
        { enableHighAccuracy: false, timeout: 10000 }
    );
});

// ==========================================================================
// Toasts and dialogs
// ==========================================================================

function toast(message, type = "info", duration = 4000) {
    const el = document.createElement("div");
    el.className = `toast toast-${type}`;
    el.textContent = message;
    ui.toasts.appendChild(el);
    setTimeout(() => {
        el.classList.add("leaving");
        setTimeout(() => el.remove(), 250);
    }, duration);
}

function confirmDialog(title, message) {
    ui.confirmTitle.textContent = title;
    ui.confirmMessage.textContent = message;
    ui.confirmDialog.returnValue = "";
    ui.confirmDialog.showModal();
    return new Promise(resolve => {
        ui.confirmDialog.addEventListener("close", () => resolve(ui.confirmDialog.returnValue === "ok"), { once: true });
    });
}

// Keep map clicks/scrolls from leaking through the panel.
L.DomEvent.disableClickPropagation(ui.panel);
L.DomEvent.disableScrollPropagation(ui.panel);

render();
