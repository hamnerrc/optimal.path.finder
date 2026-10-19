// ==========================================================================
// App state and UI
// ==========================================================================

const $ = (id) => document.getElementById(id);

const ui = {
    panel: $("panel"),
    modeTabs: document.querySelectorAll(".segmented [data-mode]"),
    unitButtons: document.querySelectorAll("[data-units]"),
    unitDistanceLabels: document.querySelectorAll(".unit-distance"),

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
    chooseRectangleButton: $("chooseRectangleButton"),
    choosePolygonButton: $("choosePolygonButton"),
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

    placeSection: $("placeSection"),
    placeForm: $("placeForm"),
    placeInput: $("placeInput"),
    placeResults: $("placeResults"),
    placeSaved: $("placeSaved"),
    placeSummaryName: $("placeSummaryName"),
    placeSummaryDetail: $("placeSummaryDetail"),
    clearPlaceButton: $("clearPlaceButton"),

    coverageSection: $("coverageSection"),
    coverageInput: $("coverageInput"),
    coverageOutput: $("coverageOutput"),

    roadOptionsCount: $("roadOptionsCount"),
    noMotorwaysInput: $("noMotorwaysInput"),
    hopsInput: $("hopsInput"),
    railwaysInput: $("railwaysInput"),

    routesSection: $("routesSection"),
    routeList: $("routeList"),
    clearRoutesButton: $("clearRoutesButton"),
    routeDetail: $("routeDetail"),
    statDistance: $("statDistance"),
    statArea: $("statArea"),
    statIq: $("statIq"),
    statCoverageBox: $("statCoverageBox"),
    statCoverage: $("statCoverage"),
    statTime: $("statTime"),
    statClimb: $("statClimb"),
    routeWarning: $("routeWarning"),
    routeNote: $("routeNote"),
    paceInput: $("paceInput"),
    paceFormatSelect: $("paceFormatSelect"),
    reverseButton: $("reverseButton"),
    elevationSummary: $("elevationSummary"),
    elevationChart: $("elevationChart"),
    saveRouteButton: $("saveRouteButton"),
    exportKmlButton: $("exportKmlButton"),
    exportGpxButton: $("exportGpxButton"),

    savedSection: $("savedSection"),
    savedCount: $("savedCount"),
    savedList: $("savedList"),

    networkSection: $("networkSection"),
    statIntersections: $("statIntersections"),
    statSegments: $("statSegments"),
    statRoadLength: $("statRoadLength"),
    showNetworkInput: $("showNetworkInput"),

    searchProgress: $("searchProgress"),
    progressFill: $("progressFill"),
    progressText: $("progressText"),
    routeHint: $("routeHint"),
    getRouteButton: $("getRouteButton"),
    getRouteLabel: $("getRouteLabel"),
    cancelLoadButton: $("cancelLoadButton"),

    coords: $("coords"),
    toasts: $("toasts"),
    confirmDialog: $("confirmDialog"),
    confirmTitle: $("confirmTitle"),
    confirmMessage: $("confirmMessage"),
    saveDialog: $("saveDialog"),
    saveNameInput: $("saveNameInput")
};

const SHAPES = {
    circle: { label: "circle", points: 2, instructions: "Click two points on the map, one on each side of the circle." },
    ellipse: { label: "ellipse", points: 3, instructions: "Click three points on the map that the ellipse's edge should pass through." },
    rectangle: { label: "rectangle", points: 3, instructions: "Click two corners along one side, then a point on the opposite side to set the width." },
    // Freehand: any number of corners (at least minPoints).
    polygon: { label: "freehand shape", points: Infinity, minPoints: 3, instructions: "Click the map to add corners. Click \u201cUse this shape\u201d when done (3 or more)." }
};

const shapeReady = (type, count) => SHAPES[type].points === Infinity ? count >= SHAPES[type].minPoints : count === SHAPES[type].points;

const storedPrefs = loadPrefs();
const prefs = {
    units: storedPrefs.units === "km" ? "km" : "mi",
    defaultDistanceM: storedPrefs.defaultDistanceM > 0 ? storedPrefs.defaultDistanceM : milesToMeters(CONFIG.defaultDistanceMiles),
    coveragePercent: storedPrefs.coveragePercent > 0 ? storedPrefs.coveragePercent : CONFIG.defaultCoveragePercent,
    // Pace is stored as a speed (m/s) and shown in the chosen format.
    paceFormat: PACE_FORMATS[storedPrefs.paceFormat] ? storedPrefs.paceFormat : (storedPrefs.units === "km" ? "min/km" : "min/mi"),
    speedMps: storedPrefs.speedMps > 0 ? storedPrefs.speedMps : METERS_PER_MILE / CONFIG.defaultPaceSecPerMile,
    // Road options (see roadTypesFor in js/pipeline.js). Fence hops and
    // railroad tracks are on by default (loops that use them say so); the
    // choices stored before that default (roadsVersion 2) are not kept.
    roads: {
        noMotorways: storedPrefs.roads?.noMotorways === true,
        hops: storedPrefs.roadsVersion === 2 ? storedPrefs.roads?.hops !== false : true,
        railways: storedPrefs.roadsVersion === 2 ? storedPrefs.roads?.railways !== false : true
    },
    roadsVersion: 2
};
const rememberPrefs = () => savePrefs(prefs);
setUnits(prefs.units);

const state = {
    mode: "distance",          // "distance" | "shape"
    interaction: null,         // null | "pick" | "draw" | "edit"

    starts: [],                // [{ id, latlng, maxDistanceM, marker, circle }]
    activeStartId: null,
    nextStartId: 1,

    shape: null,               // { type, points: LatLng[] }
    shapeLayer: null,
    handles: [],               // draggable point markers while drawing/editing
    draft: null,               // { type, points } while drawing
    editSnapshot: null,        // points before editing, restored on cancel

    place: null,               // { name, kind, outline: [{ lat, lng }] }
    placeLayer: null,

    network: null,             // most recently loaded road network
    networkLayers: new Map(),  // "start:<id>" | "area" -> roads drawn for that search
    loading: null,             // { controller, control } while a search runs

    routes: [],                // found or loaded loops, see showLoop()
    activeRouteId: null,
    nextRouteId: 1,

    saved: loadSavedRoutes()
};

// ==========================================================================
// Rendering
// ==========================================================================

function render() {
    const { mode, interaction, loading } = state;

    ui.modeTabs.forEach(tab => tab.setAttribute("aria-selected", String(tab.dataset.mode === mode)));
    ui.distanceSection.hidden = mode !== "distance";
    ui.shapeSection.hidden = mode !== "shape";
    ui.placeSection.hidden = mode !== "place";
    ui.coverageSection.hidden = mode === "distance";

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

    // Place mode
    ui.placeSaved.hidden = !state.place;
    if (state.place) {
        ui.placeSummaryName.textContent = state.place.name;
        ui.placeSummaryDetail.textContent = `${state.place.kind} · ${formatArea(createPolygonRegion(state.place.outline).areaSqKm * 1e6)}`;
    }

    // Map cursor
    map.getContainer().classList.toggle("is-picking", interaction === "pick" || interaction === "draw");

    // Footer
    const jobs = searchJobs();
    const ready = jobs.length > 0;
    const pending = jobs.filter(job => !isUpToDate(job)).length;
    const blocked = interaction === "draw" || interaction === "edit";
    ui.getRouteButton.disabled = !ready || !pending || blocked || Boolean(loading);
    ui.getRouteButton.classList.toggle("is-loading", Boolean(loading));
    ui.cancelLoadButton.hidden = !loading;
    ui.searchProgress.hidden = !loading;
    if (!loading) {
        ui.getRouteLabel.textContent = ready && !pending ? "Loops are up to date"
            : pending > 1 ? `Find ${pending} loops` : "Find loop";
    }
    ui.routeHint.textContent = loading ? "" : routeHintText(ready, blocked, pending);
    ui.routeHint.hidden = !ui.routeHint.textContent;
    if (!loading && !blocked) schedulePrefetch(jobs.filter(job => !isUpToDate(job)));

    // Network
    ui.networkSection.hidden = !state.network;
    if (state.network) {
        const { stats } = state.network;
        ui.statIntersections.textContent = formatNumber(stats.intersections);
        ui.statSegments.textContent = formatNumber(stats.segments);
        ui.statRoadLength.textContent = formatDistance(milesToMeters(stats.totalMiles), 0);
    }

    renderRoutes();
    renderSaved();
}

// Road tiles for the searches on screen start downloading as soon as a pin,
// shape or place is set (after a short pause, so dragging a pin doesn't
// download every place it passes), so "Find loop" rarely has to wait.
let prefetchTimer = null;
function schedulePrefetch(jobs) {
    clearTimeout(prefetchTimer);
    if (!jobs.length) return;
    prefetchTimer = setTimeout(() => jobs.forEach(prefetchRoads), 400);
}

function routeHintText(ready, blocked, pending) {
    if (blocked) return "Finish the shape first.";
    if (ready && !pending) {
        return state.mode === "distance"
            ? "Move a pin or change a length to search again."
            : "Change the area or the coverage to search again.";
    }
    if (ready) return "";
    if (state.mode === "distance") return "Add a start point to continue.";
    return state.mode === "shape" ? "Draw an area to continue." : "Choose a place to continue.";
}

function renderDrawProgress() {
    const { type, points } = state.draft;
    const total = SHAPES[type].points;
    ui.shapeDrawTitle.textContent = `Draw ${SHAPES[type].label}`;
    ui.shapeDrawInstructions.textContent = SHAPES[type].instructions;
    ui.shapeDrawProgress.innerHTML = total === Infinity
        ? `<em>${points.length} point${points.length === 1 ? "" : "s"}</em>`
        : Array.from({ length: total }, (_, i) => `<span class="${i < points.length ? "done" : ""}"></span>`).join("") +
          `<em>${points.length} of ${total} points</em>`;
    ui.finalizeShapeButton.disabled = !shapeReady(type, points.length);
}

function renderShapeSummary() {
    const region = createShapeRegion(state.shape);
    const area = formatArea(region.areaSqKm * 1e6);

    if (region.type === "circle") {
        ui.shapeSummaryType.textContent = "Circle";
        ui.shapeSummaryDetail.textContent = `${formatDistance(region.radiusMeters)} radius · ${area}`;
    } else if (region.type === "polygon") {
        ui.shapeSummaryType.textContent = "Freehand shape";
        ui.shapeSummaryDetail.textContent = `${region.outline.length} corners · ${area}`;
    } else {
        const [w, h] = region.type === "rectangle" ? region.sizeMeters : region.semiAxesMeters.map(m => m * 2);
        ui.shapeSummaryType.textContent = region.type === "rectangle" ? "Rectangle" : "Ellipse";
        ui.shapeSummaryDetail.textContent = `${formatNumber(toDistanceUnit(w), 2)} × ${formatDistance(h)} · ${area}`;
    }
}

// ==========================================================================
// Units
// ==========================================================================

function applyUnits(name) {
    prefs.units = name;
    setUnits(name);
    rememberPrefs();

    ui.unitButtons.forEach(b => b.setAttribute("aria-pressed", String(b.dataset.units === name)));
    ui.unitDistanceLabels.forEach(el => { el.textContent = units().distance.label; });
    ui.distanceInput.value = roundForInput(toDistanceUnit(prefs.defaultDistanceM));
    setScaleUnits(name);
    renderPaceInput();
    renderStartList();
    render();
    renderRouteDetail();
}

ui.unitButtons.forEach(b => b.addEventListener("click", () => applyUnits(b.dataset.units)));

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
    toggleLayer(layers.place, mode === "place");
    refreshNetworkLayers();
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

ui.pickButton.addEventListener("click", () => {
    state.interaction = state.interaction === "pick" ? null : "pick";
    render();
});

ui.distanceInput.addEventListener("input", () => {
    const value = parseFloat(ui.distanceInput.value);
    if (value > 0) {
        prefs.defaultDistanceM = fromDistanceUnit(value);
        rememberPrefs();
    }
});

function addStart(latlng) {
    const entry = {
        id: state.nextStartId++,
        latlng,
        maxDistanceM: prefs.defaultDistanceM,
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

// The start's roads disappear from the map, but the download stays cached
// (see fetchRoads), so a new start point nearby loads instantly.
function removeStart(id) {
    const entry = state.starts.find(s => s.id === id);
    if (!entry) return;
    layers.starts.removeLayer(entry.marker).removeLayer(entry.circle);
    removeNetworkLayer(`start:${id}`);
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
    const route = state.routes.find(r => r.startId === id);
    if (route) selectRoute(route.id);
}

const startNumber = (id) => state.starts.findIndex(s => s.id === id) + 1;

// Roads are loaded within half the loop length of the start: no point on a
// loop can be further than that from where it begins.
const startRegion = (entry) => createCircleRegion(entry.latlng, entry.maxDistanceM / 2);

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
        row.title = "Select this start point";
        row.innerHTML = `
            <span class="start-badge">${index + 1}</span>
            <span class="start-coords">${entry.latlng.lat.toFixed(4)}, ${entry.latlng.lng.toFixed(4)}</span>
            <span class="input-unit input-unit-small">
                <input type="number" min="0.5" step="0.5" value="${roundForInput(toDistanceUnit(entry.maxDistanceM))}" aria-label="Maximum loop length for start ${index + 1}">
                <span>${units().distance.label}</span>
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
            entry.maxDistanceM = fromDistanceUnit(value);
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
    if (shapeReady(type, points.length)) drawShapeOutline({ type, points }, "pending");
}

function cancelDrawing() {
    clearHandles();
    state.draft = null;
    state.interaction = null;
    drawShapeOutline(state.shape);   // restore the previously saved shape, if any
}

function finalizeShape() {
    const { type, points } = state.draft;
    if (!shapeReady(type, points.length)) return;
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
ui.chooseRectangleButton.addEventListener("click", () => startDrawing("rectangle"));
ui.choosePolygonButton.addEventListener("click", () => startDrawing("polygon"));
ui.cancelDrawButton.addEventListener("click", () => { cancelDrawing(); render(); });
ui.finalizeShapeButton.addEventListener("click", finalizeShape);
ui.editShapeButton.addEventListener("click", startEditing);
ui.redrawShapeButton.addEventListener("click", () => startDrawing(state.shape.type));
ui.deleteShapeButton.addEventListener("click", deleteShape);
ui.cancelEditButton.addEventListener("click", cancelEditing);
ui.doneEditButton.addEventListener("click", finishEditing);

const ROAD_OPTION_INPUTS = { noMotorways: ui.noMotorwaysInput, hops: ui.hopsInput, railways: ui.railwaysInput };
const showRoadOptionsCount = () => {
    const on = Object.values(prefs.roads).filter(Boolean).length;
    ui.roadOptionsCount.textContent = `${on} on`;
    ui.roadOptionsCount.hidden = on === 0;
};
for (const [name, input] of Object.entries(ROAD_OPTION_INPUTS)) {
    input.checked = prefs.roads[name];
    input.addEventListener("change", () => {
        prefs.roads[name] = input.checked;
        rememberPrefs();
        showRoadOptionsCount();
        render();
    });
}
showRoadOptionsCount();
const roadsKey = () => Object.keys(ROAD_OPTION_INPUTS).filter(name => prefs.roads[name]).join("+");

ui.coverageInput.value = prefs.coveragePercent;
ui.coverageOutput.textContent = `${prefs.coveragePercent}%`;
ui.coverageInput.addEventListener("input", () => {
    const value = parseFloat(ui.coverageInput.value);
    if (value > 0 && value <= 100) {
        prefs.coveragePercent = value;
        ui.coverageOutput.textContent = `${value}%`;
        rememberPrefs();
        render();
    }
});

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
    if (e.key !== "Escape" || ui.confirmDialog.open || ui.saveDialog.open) return;
    if (state.interaction) {
        stopInteraction();
        render();
    }
    ui.searchResults.hidden = true;
    ui.placeResults.hidden = true;
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
// Finding loops
// ==========================================================================

// One job per loop to find: each start point, or the drawn area / place.
function searchJobs() {
    if (state.mode === "distance") {
        return state.starts.map(start => {
            const { lat, lng } = start.latlng;
            return {
                kind: "start",
                start,
                label: `Start ${startNumber(start.id)}`,
                key: `start:${start.id}:${lat.toFixed(6)},${lng.toFixed(6)}:${Math.round(start.maxDistanceM)}:${roadsKey()}`,
                networkKey: `start:${start.id}`,
                region: startRegion(start),
                roads: { ...prefs.roads },
                objective: { mode: "start", start: { lat, lng }, maxLengthM: start.maxDistanceM }
            };
        });
    }

    let target, label;
    if (state.mode === "shape" && state.shape) {
        target = createShapeRegion(state.shape);
        const name = SHAPES[state.shape.type].label;
        label = `${name[0].toUpperCase()}${name.slice(1)} area`;
    } else if (state.mode === "place" && state.place) {
        target = createPolygonRegion(state.place.outline, "place");
        label = state.place.name;
    } else {
        return [];
    }
    const outline = target.outline.map(p => ({ lat: p.lat, lng: p.lng }));
    return [{
        kind: "area",
        label,
        key: `area:${outline.map(p => `${p.lat.toFixed(5)},${p.lng.toFixed(5)}`).join(";")}:${prefs.coveragePercent}:${roadsKey()}`,
        networkKey: "area",
        region: marginRegion(target, CONFIG.areaMargins[0]),
        target,
        roads: { ...prefs.roads },
        objective: { mode: "area", target: outline, coverage: prefs.coveragePercent / 100 }
    }];
}

// A finished loop already exists for exactly this job (same pin, length,
// shape and coverage), so there's nothing to recompute.
const isUpToDate = (job) => state.routes.some(r => r.jobKey === job.key && !r.searching);

async function findLoops() {
    const jobs = searchJobs().filter(job => !isUpToDate(job));
    if (!jobs.length || state.loading) return;

    const sqKm = jobs.reduce((sum, job) => sum + job.region.areaSqKm, 0);
    if (sqKmToSqMiles(sqKm) > CONFIG.largeAreaSqMiles) {
        const ok = await confirmDialog(
            "Large search",
            `This search covers about ${formatArea(sqKm * 1e6)}. Unless the roads there are few (countryside), it runs ` +
            `in stages: first a rough loop on major roads, then the loop is improved using all roads along it. It can take a while. ` +
            `The loop on the map updates as better ones are found. ` +
            `You can stop it at any time and keep (or export) the best loop found so far.`
        );
        if (!ok) return;
    }

    const controller = new AbortController();
    const control = { stop: false };
    state.loading = { controller, control };
    render();

    const found = [];
    let stopped = false;
    for (const [index, job] of jobs.entries()) {
        if (control.stop) break;
        const prefix = jobs.length > 1 ? `${job.label} (${index + 1} of ${jobs.length}): ` : "";
        let route = null;
        const show = (loop) => {
            const isNew = !route;
            route = showLoop(route, loop, job);
            if (isNew) {
                found.push(route);
                if (found.length === 1) {
                    selectRoute(route.id);
                    fitBounds(route.layer.getBounds());
                }
            }
        };

        try {
            const result = await searchLoop(job, {
                signal: controller.signal,
                onStatus: (text, fraction) => showProgress(fraction, `${prefix}${text}${route ? ` Best so far: ${formatDistance(route.lengthM)}, ${formatArea(route.areaM2)}.` : ""}`),
                onLoop: show,
                onNetwork: (network) => {
                    state.network = network;
                    removeNetworkLayer(job.networkKey);
                    const group = L.layerGroup();
                    drawNetwork(network, group);
                    state.networkLayers.set(job.networkKey, group);
                    refreshNetworkLayers();
                    console.log("[Network]", network);
                }
            });
            show(result);
            route.searching = false;
            // A search that ran to the end needn't be repeated.
            if (!control.stop) route.jobKey = job.key;
        } catch (err) {
            if (route) route.searching = false;
            if (err.name === "AbortError") {
                stopped = true;
                break;
            }
            console.error("[Search] Failed:", err);
            toast(`${jobs.length > 1 ? `${job.label}: ` : ""}${err.message || "Couldn't find a loop. Check your connection and try again."}`, "error", 6000);
        }
    }

    state.loading = null;
    render();
    if (!found.length) {
        if (stopped) toast("Search stopped before a loop was found.");
        return;
    }

    const active = activeRoute();
    if (active) {
        renderRouteDetail();
        if (active.elevation === null) loadElevation(active);
    }
    fitBounds(L.latLngBounds(found.flatMap(r => [r.layer.getBounds().getSouthWest(), r.layer.getBounds().getNorthEast()])));
    const infeasible = found.filter(r => !r.feasible).length;
    if (stopped) toast("Search stopped. Kept the best loop found so far.", "info", 5000);
    else if (infeasible) toast(`${infeasible} loop${infeasible > 1 ? "s don't" : " doesn't"} meet every requirement. See the warning under the loop.`, "warning", 6000);
    else toast(found.length > 1 ? `Found ${found.length} loops.` : "Loop found.", "success");
}

// While searching, the bar shows how settled the search is: it fills as
// rounds go by without a better loop, and drops back when one is found.
function showProgress(fraction, text) {
    ui.progressFill.style.width = `${Math.round(fraction * 100)}%`;
    ui.progressText.textContent = text;
    ui.getRouteLabel.textContent = "Searching…";
}

// Stopping keeps every loop found so far, including the one being improved.
function stopSearch() {
    if (!state.loading) return;
    state.loading.control.stop = true;
    state.loading.controller.abort();
}

ui.getRouteButton.addEventListener("click", findLoops);
ui.cancelLoadButton.addEventListener("click", stopSearch);

ui.showNetworkInput.addEventListener("change", () => toggleLayer(layers.network, ui.showNetworkInput.checked));

// Shows the roads of the current mode's searches: each start point's in
// start point mode, the area's in area and place mode.
function refreshNetworkLayers() {
    for (const [key, group] of state.networkLayers) {
        const visible = key.startsWith("start:") ? state.mode === "distance" : state.mode !== "distance";
        if (visible) group.addTo(layers.network);
        else layers.network.removeLayer(group);
    }
}

function removeNetworkLayer(key) {
    const group = state.networkLayers.get(key);
    if (!group) return;
    layers.network.removeLayer(group);
    state.networkLayers.delete(key);
}

// ==========================================================================
// Loops on the map and in the panel
// ==========================================================================

// route: { id, label, mode, startId, jobKey, searching, coords, cum,
//          lengthM, areaM2, iq, coverage, feasible, warning, flags,
//          startOffsetM, reversed, elevation (null | data | "loading" | "error"),
//          layer }
// flags: stretches to check before running (see expandLoop).

// Creates the route for a job on its first loop, then updates it in place as
// the search finds better loops.
function showLoop(route, loop, job) {
    if (!route) {
        // A new loop replaces the previous one for the same start point or area.
        const replaces = state.routes.find(r =>
            (job.kind === "start" && r.startId === job.start.id) || (job.kind === "area" && r.mode === "area" && !r.savedName));
        if (replaces) removeRoute(replaces.id, false);
        route = createRoute({
            label: job.label,
            mode: job.objective.mode,
            startId: job.kind === "start" ? job.start.id : null,
            searching: true,
            coords: loop.coords,
            startOffsetM: 0,
            reversed: false
        });
    } else {
        route.coords = loop.coords;
        route.cum = cumulativeDistances(loop.coords);
        route.layer.setLatLngs(loop.coords);
        route.elevation = null;
    }

    Object.assign(route, {
        lengthM: loop.lengthM,
        areaM2: loop.areaM2,
        iq: loop.iq,
        coverage: loop.coverage ?? null,
        feasible: loop.feasible,
        flags: loop.flags || []
    });
    // Start where the loop passes closest to the pin.
    if (job.kind === "start") route.startOffsetM = nearestOffset(route, job.start.latlng);
    route.warning = routeWarning(route, loop, job);
    route.note = routeNote(loop);

    if (route.id === state.activeRouteId) {
        drawRouteDecor();
        renderRouteDetail();
    }
    renderRoutes();
    return route;
}

function createRoute(fields) {
    const route = { id: state.nextRouteId++, elevation: null, ...fields };
    route.cum = cumulativeDistances(route.coords);
    route.layer = L.polygon(route.coords, routeStyle(false))
        .on("click", () => selectRoute(route.id))
        .addTo(layers.routes);
    state.routes.push(route);
    return route;
}

function routeNote(result) {
    return result.stemM > 30 ? `The loop starts with ${formatDistance(result.stemM)} out to it, and ends with the same stretch back.` : "";
}

// What a loop uses that should be checked before running it (marked in
// orange on the map).
function flagWarning(flags) {
    let hops = 0, railM = 0, privateM = 0;
    for (const { kind, coords } of flags) {
        if (kind === "hop") hops += coords.length - 1;
        else if (kind === "rail") railM += lineLength(coords);
        else privateM += lineLength(coords);
    }
    const notes = [];
    if (hops > 0) notes.push(`It uses ${hops} fence hop${hops > 1 ? "s" : ""} (a gap under 10 m between roads that don't connect): check ${hops > 1 ? "they" : "it"} can be crossed.`);
    if (railM > 0) notes.push(`${formatDistance(railM)} of it runs along railroad tracks: only run there where it's allowed.`);
    if (privateM > 0) notes.push(`${formatDistance(privateM)} of it is on roads or paths marked private or no entry: check you may use them.`);
    return notes.join(" ");
}

const lineLength = (coords) => {
    let m = 0;
    for (let i = 1; i < coords.length; i++) m += haversine(coords[i - 1][0], coords[i - 1][1], coords[i][0], coords[i][1]);
    return m;
};

function routeWarning(route, result, job) {
    const notes = [];
    const flagged = flagWarning(route.flags);
    if (flagged) notes.push(flagged);
    if (result.repeats > 0) notes.push("It runs part of a street twice.");
    if (job.kind === "start" && result.lengthM > job.start.maxDistanceM) {
        notes.push(`It's longer than your ${formatDistance(job.start.maxDistanceM)} limit.`);
    }
    if (job.kind === "start") {
        const [lat, lng] = pointAtOffset(route, route.startOffsetM);
        const gap = haversine(lat, lng, job.start.latlng.lat, job.start.latlng.lng);
        if (gap > 150) notes.push(`The closest it passes to your pin is ${formatDistance(gap)}.`);
    }
    // The search measures coverage on a simplified outline; allow for the
    // small difference from the exact figure.
    if (job.kind === "area" && result.coverage < job.objective.coverage - 0.005) {
        notes.push(`It only encloses ${Math.round(result.coverage * 100)}% of the area (target ${Math.round(job.objective.coverage * 100)}%). ` +
            `Try a lower target.`);
    }
    return notes.join(" ");
}

const activeRoute = () => state.routes.find(r => r.id === state.activeRouteId) || null;

function selectRoute(id) {
    state.activeRouteId = id;
    const startId = state.routes.find(r => r.id === id)?.startId;
    if (startId && state.starts.some(s => s.id === startId)) {
        state.activeStartId = startId;
        refreshStartMarkers();
        renderStartList();
    }
    state.routes.forEach(r => {
        r.layer.setStyle(routeStyle(r.id === id));
        if (r.id === id) r.layer.bringToFront();
    });
    drawRouteDecor();
    render();
    renderRouteDetail();
    const route = activeRoute();
    if (route && route.elevation === null && !route.searching) loadElevation(route);
}

function removeRoute(id, rerender = true) {
    const route = state.routes.find(r => r.id === id);
    if (!route) return;
    layers.routes.removeLayer(route.layer);
    state.routes = state.routes.filter(r => r.id !== id);
    if (state.activeRouteId === id) {
        const next = state.routes[state.routes.length - 1];
        if (rerender && next) return selectRoute(next.id);
        state.activeRouteId = next?.id ?? null;
        drawRouteDecor();
    }
    if (rerender) {
        render();
        renderRouteDetail();
    }
}

ui.clearRoutesButton.addEventListener("click", () => {
    layers.routes.clearLayers();
    state.routes = [];
    state.activeRouteId = null;
    drawRouteDecor();
    render();
});

function renderRoutes() {
    ui.routesSection.hidden = state.routes.length === 0;
    ui.routeList.replaceChildren(...state.routes.map(route => {
        const row = document.createElement("li");
        row.className = "route-row" + (route.id === state.activeRouteId ? " active" : "");
        row.innerHTML = `
            <span class="route-swatch"></span>
            <span class="route-name"></span>
            <span class="route-meta">${route.searching ? "searching… " : ""}${formatDistance(route.lengthM)}</span>
            <button type="button" class="icon-button danger" aria-label="Remove loop">
                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" /></svg>
            </button>`;
        row.querySelector(".route-name").textContent = route.savedName || route.label;
        if (!route.feasible) row.querySelector(".route-meta").classList.add("is-warning");
        row.addEventListener("click", () => selectRoute(route.id));
        row.querySelector("button").addEventListener("click", (e) => {
            e.stopPropagation();
            removeRoute(route.id);
        });
        return row;
    }));
}

function renderRouteDetail() {
    const route = activeRoute();
    ui.routeDetail.hidden = !route;
    if (!route) return;

    ui.statDistance.textContent = formatDistance(route.lengthM);
    ui.statArea.textContent = formatArea(route.areaM2);
    ui.statIq.textContent = route.iq.toFixed(2);
    ui.statCoverageBox.hidden = route.coverage === null;
    if (route.coverage !== null) ui.statCoverage.textContent = `${Math.round(route.coverage * 100)}%`;
    ui.statTime.textContent = formatDuration(estimatedSeconds(route));
    ui.routeWarning.textContent = route.warning || "";
    ui.routeWarning.hidden = !route.warning;
    ui.routeNote.textContent = route.note || "";
    ui.routeNote.hidden = !route.note;
    renderElevation(route);
}

// --------------------------------------------------------------------------
// Start flag, direction arrows and elevation hover marker
// --------------------------------------------------------------------------

let startFlag = null;
let hoverMarker = null;
let arrowsLayer = L.layerGroup().addTo(layers.routeDecor);

function drawRouteDecor() {
    const route = activeRoute();
    arrowsLayer.clearLayers();
    if (!route) {
        if (startFlag) layers.routeDecor.removeLayer(startFlag);
        startFlag = null;
        return;
    }

    for (const { latlng, bearing } of directionMarkers(route, 12)) {
        L.marker(latlng, { icon: arrowIcon(bearing), interactive: false, keyboard: false }).addTo(arrowsLayer);
    }
    // Stretches to check (see flagWarning); a hop is too short to see from
    // afar, so it also gets a dot.
    const flagNames = { hop: "Fence hop", rail: "Railroad tracks", private: "Marked private or no entry" };
    for (const { kind, coords } of route.flags || []) {
        L.polyline(coords, { color: CONFIG.colors.flag, weight: 7, opacity: 0.85, lineCap: "butt" })
            .bindTooltip(flagNames[kind]).addTo(arrowsLayer);
        if (kind === "hop") {
            L.circleMarker(coords[0], { radius: 6, color: CONFIG.colors.flag, weight: 2, fillOpacity: 0.6 })
                .bindTooltip(flagNames[kind]).addTo(arrowsLayer);
        }
    }

    const position = pointAtOffset(route, route.startOffsetM);
    if (!startFlag) {
        startFlag = L.marker(position, { icon: startFlagIcon(), draggable: true, keyboard: false, zIndexOffset: 2000, title: "Start / finish: drag along the loop" })
            .on("drag", onFlagDrag)
            .on("dragend", () => {
                drawRouteDecor();
                renderRouteDetail();
            })
            .addTo(layers.routeDecor);
    } else {
        startFlag.setLatLng(position);
    }
}

// Keeps the flag on the loop while it's dragged.
function onFlagDrag(e) {
    const route = activeRoute();
    if (!route) return;
    route.startOffsetM = nearestOffset(route, e.target.getLatLng());
    e.target.setLatLng(pointAtOffset(route, route.startOffsetM));
}

ui.reverseButton.addEventListener("click", () => {
    const route = activeRoute();
    if (!route) return;
    route.reversed = !route.reversed;
    drawRouteDecor();
    renderRouteDetail();
});

// --------------------------------------------------------------------------
// Pace and time estimate
// --------------------------------------------------------------------------

const estimatedSeconds = (route) => route.lengthM / prefs.speedMps;

// Pace can be typed as min/mi, min/km ("8:30"), mph or km/h; switching the
// format converts the value shown.
function renderPaceInput() {
    ui.paceFormatSelect.value = prefs.paceFormat;
    ui.paceInput.value = formatPaceInput(prefs.speedMps, prefs.paceFormat);
    ui.paceInput.placeholder = PACE_FORMATS[prefs.paceFormat].kind === "pace" ? "8:30" : "15";
}

ui.paceFormatSelect.addEventListener("change", () => {
    prefs.paceFormat = ui.paceFormatSelect.value;
    rememberPrefs();
    renderPaceInput();
});

ui.paceInput.addEventListener("input", () => {
    const speed = parsePaceInput(ui.paceInput.value, prefs.paceFormat);
    if (!(speed > 0)) return;
    prefs.speedMps = speed;
    rememberPrefs();
    const route = activeRoute();
    if (route) ui.statTime.textContent = formatDuration(estimatedSeconds(route));
});

// --------------------------------------------------------------------------
// Elevation profile
// --------------------------------------------------------------------------

async function loadElevation(route) {
    route.elevation = "loading";
    renderElevation(route);
    try {
        route.elevation = await fetchLoopElevation(route);
    } catch (err) {
        console.error("[Elevation]", err);
        route.elevation = "error";
    }
    if (route.id === state.activeRouteId) renderElevation(route);
}

function renderElevation(route) {
    const { elevation } = route;
    const chart = ui.elevationChart;
    hideHoverMarker();

    if (route.searching) {
        ui.elevationSummary.textContent = "";
        ui.statClimb.textContent = "…";
        chart.innerHTML = `<p class="chart-message">Elevation loads when the search finishes.</p>`;
        return;
    }
    if (elevation === "loading" || elevation === null) {
        ui.elevationSummary.textContent = "";
        ui.statClimb.textContent = "…";
        chart.innerHTML = `<p class="chart-message">Loading elevation…</p>`;
        return;
    }
    if (elevation === "error") {
        ui.elevationSummary.textContent = "";
        ui.statClimb.textContent = "–";
        chart.innerHTML = `<p class="chart-message">Couldn't load elevation. <button type="button" class="link-button">Retry</button></p>`;
        chart.querySelector("button").addEventListener("click", () => loadElevation(route));
        return;
    }

    const profile = elevationProfile(route);
    ui.statClimb.textContent = formatElevation(profile.gain);
    ui.elevationSummary.textContent = `↑ ${formatElevation(profile.gain)}  ↓ ${formatElevation(profile.loss)}`;

    const width = chart.clientWidth || 320;
    const height = 120;
    const pad = { top: 8, right: 8, bottom: 20, left: 56 };
    const innerW = width - pad.left - pad.right;
    const innerH = height - pad.top - pad.bottom;
    const span = Math.max(profile.max - profile.min, 10);
    const lo = profile.min - span * 0.1;
    const hi = profile.max + span * 0.1;
    const length = loopLength(route);
    const sx = (d) => pad.left + (d / length) * innerW;
    const sy = (h) => pad.top + (1 - (h - lo) / (hi - lo)) * innerH;

    const line = profile.points.map((p, i) => `${i ? "L" : "M"}${sx(p.distance).toFixed(1)},${sy(p.height).toFixed(1)}`).join("");
    const area = `${line}L${sx(length).toFixed(1)},${pad.top + innerH}L${pad.left},${pad.top + innerH}Z`;
    const ticks = [0, 0.5, 1].map(f => ({ x: sx(f * length), label: formatNumber(toDistanceUnit(f * length), f ? 1 : 0) }));

    chart.innerHTML = `
        <svg viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="Elevation profile">
            <line class="grid" x1="${pad.left}" x2="${width - pad.right}" y1="${sy(profile.max)}" y2="${sy(profile.max)}" />
            <line class="grid" x1="${pad.left}" x2="${width - pad.right}" y1="${sy(profile.min)}" y2="${sy(profile.min)}" />
            <text class="axis" x="${pad.left - 6}" y="${sy(profile.max) + 4}" text-anchor="end">${formatElevation(profile.max)}</text>
            <text class="axis" x="${pad.left - 6}" y="${sy(profile.min) + 4}" text-anchor="end">${formatElevation(profile.min)}</text>
            ${ticks.map((t, i) => `<text class="axis" x="${t.x}" y="${height - 4}" text-anchor="${["start", "middle", "end"][i]}">${t.label}${i === 2 ? ` ${units().distance.label}` : ""}</text>`).join("")}
            <path class="fill" d="${area}" />
            <path class="line" d="${line}" />
            <line class="cursor" x1="0" x2="0" y1="${pad.top}" y2="${pad.top + innerH}" visibility="hidden" />
            <text class="cursor-label" x="0" y="${pad.top + 10}" visibility="hidden"></text>
            <rect class="hit" x="${pad.left}" y="${pad.top}" width="${innerW}" height="${innerH}" />
        </svg>`;

    // Hover: show the point on the chart and on the map.
    const svg = chart.querySelector("svg");
    const cursor = svg.querySelector(".cursor");
    const label = svg.querySelector(".cursor-label");
    const hit = svg.querySelector(".hit");
    const move = (clientX) => {
        const box = svg.getBoundingClientRect();
        const x = Math.max(pad.left, Math.min(pad.left + innerW, (clientX - box.left) * (width / box.width)));
        const travelled = ((x - pad.left) / innerW) * length;
        const h = heightAtOffset(route.elevation, offsetFromStart(route, travelled));
        cursor.setAttribute("x1", x);
        cursor.setAttribute("x2", x);
        cursor.setAttribute("visibility", "visible");
        label.textContent = `${formatDistance(travelled, 2)} · ${formatElevation(h)}`;
        label.setAttribute("x", x > width / 2 ? x - 6 : x + 6);
        label.setAttribute("text-anchor", x > width / 2 ? "end" : "start");
        label.setAttribute("visibility", "visible");
        showHoverMarker(pointAtOffset(route, offsetFromStart(route, travelled)));
    };
    const leave = () => {
        cursor.setAttribute("visibility", "hidden");
        label.setAttribute("visibility", "hidden");
        hideHoverMarker();
    };
    hit.addEventListener("pointermove", (e) => move(e.clientX));
    hit.addEventListener("pointerdown", (e) => move(e.clientX));
    hit.addEventListener("pointerleave", leave);
}

function showHoverMarker(latlng) {
    if (!hoverMarker) hoverMarker = L.marker(latlng, { icon: hoverIcon(), interactive: false, keyboard: false, zIndexOffset: 3000 }).addTo(layers.routeDecor);
    else hoverMarker.setLatLng(latlng);
}

function hideHoverMarker() {
    if (hoverMarker) layers.routeDecor.removeLayer(hoverMarker);
    hoverMarker = null;
}

// --------------------------------------------------------------------------
// Export and saving
// --------------------------------------------------------------------------

const routeTitle = (route) => route.savedName || `${route.label} loop, ${formatDistance(route.lengthM, 1)}`;

ui.exportKmlButton.addEventListener("click", () => {
    const route = activeRoute();
    if (!route) return;
    const name = routeTitle(route);
    downloadText(`${safeFilename(name)}.kml`, routeToKml(route, name), "application/vnd.google-earth.kml+xml");
});

ui.exportGpxButton.addEventListener("click", () => {
    const route = activeRoute();
    if (!route) return;
    const name = routeTitle(route);
    downloadText(`${safeFilename(name)}.gpx`, routeToGpx(route, name), "application/gpx+xml");
});

ui.saveRouteButton.addEventListener("click", async () => {
    const route = activeRoute();
    if (!route) return;
    ui.saveNameInput.value = routeTitle(route);
    ui.saveDialog.returnValue = "";
    ui.saveDialog.showModal();
    ui.saveNameInput.select();
    const ok = await new Promise(resolve =>
        ui.saveDialog.addEventListener("close", () => resolve(ui.saveDialog.returnValue === "ok"), { once: true }));
    const name = ui.saveNameInput.value.trim();
    if (!ok || !name) return;

    const record = serializeRoute(route, name);
    const list = [record, ...state.saved];
    if (!storeSavedRoutes(list)) {
        toast("Couldn't save: browser storage is full or disabled.", "error");
        return;
    }
    state.saved = list;
    route.savedName = name;
    ui.savedSection.open = true;
    render();
    toast("Loop saved in this browser.", "success");
});

function renderSaved() {
    ui.savedSection.hidden = state.saved.length === 0;
    ui.savedCount.textContent = state.saved.length;
    ui.savedList.replaceChildren(...state.saved.map(record => {
        const row = document.createElement("li");
        row.className = "saved-row";
        const date = new Date(record.savedAt).toLocaleDateString(undefined, { month: "short", day: "numeric" });
        row.innerHTML = `
            <button type="button" class="saved-open" title="Show on map">
                <span class="saved-name"></span>
                <span class="saved-meta">${formatDistance(record.lengthM)} · ${formatArea(record.areaM2)} · ${date}</span>
            </button>
            <button type="button" class="icon-button danger" aria-label="Delete saved loop">
                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 7h14M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" /></svg>
            </button>`;
        row.querySelector(".saved-name").textContent = record.name;
        row.querySelector(".saved-open").addEventListener("click", () => openSaved(record));
        row.querySelector(".icon-button").addEventListener("click", () => deleteSaved(record.id));
        return row;
    }));
}

function openSaved(record) {
    let route = state.routes.find(r => r.savedId === record.id);
    if (!route) {
        route = createRoute({
            label: record.name,
            savedName: record.name,
            savedId: record.id,
            mode: record.mode,
            startId: null,
            coords: record.coords,
            lengthM: record.lengthM,
            areaM2: record.areaM2,
            iq: record.iq,
            coverage: record.coverage,
            feasible: true,
            warning: flagWarning(record.flags || []),
            flags: record.flags || [],
            startOffsetM: record.startOffsetM || 0,
            reversed: Boolean(record.reversed)
        });
        if (record.elevation) route.elevation = { heights: Float64Array.from(record.elevation.heights), length: record.elevation.length };
    }
    selectRoute(route.id);
    fitBounds(route.layer.getBounds());
}

async function deleteSaved(id) {
    const record = state.saved.find(r => r.id === id);
    if (!record) return;
    const ok = await confirmDialog("Delete saved loop?", `"${record.name}" will be removed from this browser.`);
    if (!ok) return;
    state.saved = state.saved.filter(r => r.id !== id);
    storeSavedRoutes(state.saved);
    render();
}

// ==========================================================================
// Place mode: capture a real place (city, county, state, lake, park…)
// ==========================================================================

// Boundary outlines are simplified to this many corners: plenty for a loop
// that follows roads, and keeps the coverage check fast.
const PLACE_MAX_POINTS = 400;

let placeController = null;

// Searching asks only for names (fast, even when the results include whole
// states or lakes); the boundary is downloaded for the one place picked, and
// simplified on the server to about the detail its size needs.
ui.placeForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const query = ui.placeInput.value.trim();
    if (!query) {
        ui.placeInput.focus();
        return;
    }

    placeController?.abort();
    placeController = new AbortController();
    showPlaceMessage("Searching…");
    try {
        const url = `${CONFIG.geocoder.url}?format=jsonv2&limit=10&q=${encodeURIComponent(query)}`;
        const response = await fetch(url, { signal: placeController.signal, headers: { "Accept-Language": navigator.language } });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        // Points (nodes) have no boundary.
        showPlaceResults((await response.json()).filter(p => p.osm_type === "relation" || p.osm_type === "way"));
    } catch (err) {
        if (err.name !== "AbortError") {
            ui.placeResults.hidden = true;
            toast("Place search failed. Please try again.", "error");
        }
    }
});

function showPlaceMessage(text) {
    ui.placeResults.innerHTML = `<li class="empty"></li>`;
    ui.placeResults.firstChild.textContent = text;
    ui.placeResults.hidden = false;
}

async function choosePlace(place) {
    placeController?.abort();
    placeController = new AbortController();
    showPlaceMessage(`Loading the boundary of ${place.name || place.display_name.split(",")[0]}…`);
    try {
        const [south, north, west, east] = place.boundingbox.map(Number);
        const tolerance = Math.hypot(north - south, east - west) / 2000;
        const id = `${place.osm_type[0].toUpperCase()}${place.osm_id}`;
        const url = `${CONFIG.geocoder.lookupUrl}?format=jsonv2&polygon_geojson=1&polygon_threshold=${tolerance.toPrecision(2)}&osm_ids=${id}`;
        const response = await fetch(url, { signal: placeController.signal, headers: { "Accept-Language": navigator.language } });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const [detail] = await response.json();
        ui.placeResults.hidden = true;
        if (!/Polygon/.test(detail?.geojson?.type || "")) {
            toast("That place has no boundary. Try another result.", "warning");
            return;
        }
        setPlace({ ...place, geojson: detail.geojson });
    } catch (err) {
        if (err.name !== "AbortError") {
            ui.placeResults.hidden = true;
            toast("Couldn't load that boundary. Please try again.", "error");
        }
    }
}

function showPlaceResults(places) {
    if (places.length === 0) {
        ui.placeResults.innerHTML = `<li class="empty">No places with a boundary found. Try adding the state or country.</li>`;
        ui.placeResults.hidden = false;
        return;
    }
    ui.placeResults.replaceChildren(...places.map(place => {
        const item = document.createElement("li");
        const button = document.createElement("button");
        button.type = "button";
        button.innerHTML = `<span class="result-kind"></span><span class="result-name"></span>`;
        button.querySelector(".result-kind").textContent = placeKind(place);
        button.querySelector(".result-name").textContent = place.display_name;
        button.addEventListener("click", () => choosePlace(place));
        item.appendChild(button);
        return item;
    }));
    ui.placeResults.hidden = false;
}

function placeKind(place) {
    const kind = (place.addresstype || place.type || "area").replace(/_/g, " ");
    return kind[0].toUpperCase() + kind.slice(1);
}

function setPlace(place) {
    const outline = largestRing(place.geojson);
    if (outline.length < 3) {
        toast("That place has no usable boundary.", "warning");
        return;
    }
    state.place = {
        name: place.name || place.display_name.split(",")[0],
        kind: placeKind(place),
        outline: outline.length > PLACE_MAX_POINTS ? simplifyRing(outline, PLACE_MAX_POINTS) : outline
    };
    ui.placeInput.value = "";
    drawPlace();
    fitBounds(state.placeLayer.getBounds());
    render();
}

// Outer ring of a GeoJSON Polygon, or of a MultiPolygon's largest part.
function largestRing(geojson) {
    const rings = geojson.type === "Polygon" ? [geojson.coordinates[0]] : geojson.coordinates.map(poly => poly[0]);
    let best = [], bestArea = -1;
    for (const ring of rings) {
        const points = ring.map(([lng, lat]) => ({ lat, lng }));
        if (points.length > 1 && points[0].lat === points[points.length - 1].lat && points[0].lng === points[points.length - 1].lng) points.pop();
        if (points.length < 3) continue;
        const area = createPolygonRegion(points).areaSqKm;
        if (area > bestArea) {
            bestArea = area;
            best = points;
        }
    }
    return best;
}

function drawPlace() {
    layers.place.clearLayers();
    state.placeLayer = state.place
        ? createRegionLayer(createPolygonRegion(state.place.outline, "place")).addTo(layers.place)
        : null;
}

ui.clearPlaceButton.addEventListener("click", () => {
    state.place = null;
    drawPlace();
    render();
});

document.addEventListener("click", (e) => {
    // A result that was clicked is already replaced by the loading message.
    if (e.target.isConnected && !ui.placeForm.contains(e.target)) ui.placeResults.hidden = true;
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

applyUnits(prefs.units);
