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
    coverageInput: $("coverageInput"),

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
    activityButtons: document.querySelectorAll("[data-activity]"),
    paceInput: $("paceInput"),
    paceUnit: $("paceUnit"),
    reverseButton: $("reverseButton"),
    elevationSummary: $("elevationSummary"),
    elevationChart: $("elevationChart"),
    saveRouteButton: $("saveRouteButton"),
    exportKmlButton: $("exportKmlButton"),

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
    effortSelect: $("effortSelect"),
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
    rectangle: { label: "rectangle", points: 2, instructions: "Click two opposite corners of the rectangle." }
};

const storedPrefs = loadPrefs();
const prefs = {
    units: storedPrefs.units === "km" ? "km" : "mi",
    defaultDistanceM: storedPrefs.defaultDistanceM > 0 ? storedPrefs.defaultDistanceM : milesToMeters(CONFIG.defaultDistanceMiles),
    coveragePercent: storedPrefs.coveragePercent > 0 ? storedPrefs.coveragePercent : CONFIG.defaultCoveragePercent,
    effort: CONFIG.searchEffort[storedPrefs.effort] ? storedPrefs.effort : CONFIG.defaultEffort,
    activity: storedPrefs.activity === "bike" ? "bike" : "run",
    runPaceSecPerM: storedPrefs.runPaceSecPerM > 0 ? storedPrefs.runPaceSecPerM : CONFIG.defaultRunPaceSecPerMile / METERS_PER_MILE,
    bikeSpeedMps: storedPrefs.bikeSpeedMps > 0 ? storedPrefs.bikeSpeedMps : milesToMeters(CONFIG.defaultBikeSpeedMph) / 3600
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

    network: null,             // most recently loaded road network
    loading: null,             // AbortController while a search runs

    routes: [],                // found or loaded loops, see addRoute()
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
    const ready = searchJobs().length > 0;
    const blocked = interaction === "draw" || interaction === "edit";
    ui.getRouteButton.disabled = !ready || blocked || Boolean(loading);
    ui.getRouteButton.classList.toggle("is-loading", Boolean(loading));
    ui.cancelLoadButton.hidden = !loading;
    ui.searchProgress.hidden = !loading;
    if (!loading) {
        const count = state.mode === "distance" ? state.starts.length : 1;
        ui.getRouteLabel.textContent = count > 1 ? `Find ${count} loops` : "Find loop";
    }
    ui.routeHint.textContent = loading ? "" : routeHintText(ready, blocked);
    ui.routeHint.hidden = !ui.routeHint.textContent;

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

function routeHintText(ready, blocked) {
    if (blocked) return "Finish the shape first.";
    if (ready) return "";
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
    const area = formatArea(region.areaSqKm * 1e6);

    if (region.type === "circle") {
        ui.shapeSummaryType.textContent = "Circle";
        ui.shapeSummaryDetail.textContent = `${formatDistance(region.radiusMeters)} radius · ${area}`;
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
ui.chooseRectangleButton.addEventListener("click", () => startDrawing("rectangle"));
ui.cancelDrawButton.addEventListener("click", () => { cancelDrawing(); render(); });
ui.finalizeShapeButton.addEventListener("click", finalizeShape);
ui.editShapeButton.addEventListener("click", startEditing);
ui.redrawShapeButton.addEventListener("click", () => startDrawing(state.shape.type));
ui.deleteShapeButton.addEventListener("click", deleteShape);
ui.cancelEditButton.addEventListener("click", cancelEditing);
ui.doneEditButton.addEventListener("click", finishEditing);

ui.coverageInput.value = prefs.coveragePercent;
ui.coverageInput.addEventListener("input", () => {
    const value = parseFloat(ui.coverageInput.value);
    if (value > 0 && value <= 100) {
        prefs.coveragePercent = value;
        rememberPrefs();
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

// One job per loop to find: each start point, or the drawn area.
function searchJobs() {
    if (state.mode === "distance") {
        return state.starts.map(start => ({
            kind: "start",
            start,
            region: startRegion(start),
            label: `Start ${startNumber(start.id)}`
        }));
    }
    if (!state.shape) return [];
    return [{
        kind: "area",
        shape: state.shape,
        region: createShapeRegion(scaleShape(state.shape, CONFIG.areaMargin)),
        target: createShapeRegion(state.shape),
        label: `${SHAPES[state.shape.type].label[0].toUpperCase()}${SHAPES[state.shape.type].label.slice(1)} area`
    }];
}

let previewLayer = null;

async function findLoops() {
    const jobs = searchJobs();
    if (!jobs.length || state.loading) return;

    const sqKm = jobs.reduce((sum, job) => sum + job.region.areaSqKm, 0);
    if (sqKmToSqMiles(sqKm) > CONFIG.largeAreaSqMiles) {
        const ok = await confirmDialog(
            "Large area",
            `The roads to load cover about ${formatArea(sqKm * 1e6)}. Downloading them may take a while ` +
            `and could slow your browser down. Continue anyway?`
        );
        if (!ok) return;
    }

    const controller = new AbortController();
    state.loading = controller;
    layers.network.clearLayers();
    render();

    const found = [];
    try {
        for (const [index, job] of jobs.entries()) {
            const prefix = jobs.length > 1 ? `${job.label} (${index + 1} of ${jobs.length}): ` : "";
            showProgress(0, `${prefix}Downloading roads…`);
            const osm = await fetchRoads(job.region, controller.signal);

            showProgress(0, `${prefix}Building road network…`);
            await nextFrame();
            const network = buildRoadNetwork(osm, job.region);
            if (network.edges.length === 0) {
                toast(`${job.label}: no roads found here.`, "warning");
                continue;
            }
            state.network = network;
            drawNetwork(network);
            console.log("[Network]", network);

            const params = job.kind === "start"
                ? { mode: "start", start: { lat: job.start.latlng.lat, lng: job.start.latlng.lng }, maxLengthM: job.start.maxDistanceM }
                : { mode: "area", target: job.target.outline.map(p => ({ lat: p.lat, lng: p.lng })), coverage: prefs.coveragePercent / 100 };
            params.timeBudgetMs = CONFIG.searchEffort[prefs.effort].ms;

            let bestText = "";
            const result = await runSolver(network, params, {
                signal: controller.signal,
                onProgress: ({ fraction, best }) => {
                    if (best) {
                        drawPreview(best);
                        bestText = ` Best so far: ${formatDistance(best.lengthM)}, ${formatArea(best.areaM2)}.`;
                    }
                    showProgress(fraction, `${prefix}Searching…${bestText}`);
                }
            });
            drawPreview(null);
            found.push(addRoute(result, job));
        }
    } catch (err) {
        if (err.name === "AbortError") {
            toast("Search cancelled.");
        } else {
            console.error("[Search] Failed:", err);
            toast(err instanceof OverpassError ? err.message : err.message || "Couldn't find a loop. Check your connection and try again.", "error");
        }
    } finally {
        drawPreview(null);
        state.loading = null;
        render();
    }

    if (found.length) {
        selectRoute(found[0].id);
        fitBounds(L.latLngBounds(found.flatMap(r => [r.layer.getBounds().getSouthWest(), r.layer.getBounds().getNorthEast()])));
        const infeasible = found.filter(r => !r.feasible).length;
        if (infeasible) toast(`${infeasible} loop${infeasible > 1 ? "s don't" : " doesn't"} meet every requirement. See the warning under the loop.`, "warning", 6000);
        else toast(found.length > 1 ? `Found ${found.length} loops.` : "Loop found.", "success");
    }
}

function showProgress(fraction, text) {
    ui.progressFill.style.width = `${Math.round(fraction * 100)}%`;
    ui.progressText.textContent = text;
    ui.getRouteLabel.textContent = fraction > 0 ? "Searching…" : "Loading…";
}

function drawPreview(result) {
    if (previewLayer) layers.routes.removeLayer(previewLayer);
    previewLayer = result ? L.polyline(result.coords, previewStyle).addTo(layers.routes) : null;
}

// Yields so the browser can paint the loading state before heavy work.
const nextFrame = () => new Promise(resolve => requestAnimationFrame(() => setTimeout(resolve, 0)));

ui.getRouteButton.addEventListener("click", findLoops);
ui.cancelLoadButton.addEventListener("click", () => state.loading?.abort());

ui.showNetworkInput.addEventListener("change", () => toggleLayer(layers.network, ui.showNetworkInput.checked));

for (const [key, { label, ms }] of Object.entries(CONFIG.searchEffort)) {
    ui.effortSelect.add(new Option(`${label} (${ms / 1000} s per loop)`, key, false, key === prefs.effort));
}
ui.effortSelect.addEventListener("change", () => {
    prefs.effort = ui.effortSelect.value;
    rememberPrefs();
});

// ==========================================================================
// Loops on the map and in the panel
// ==========================================================================

// route: { id, label, mode, startId, coords, cum, lengthM, areaM2, iq,
//          coverage, feasible, warning, startOffsetM, reversed,
//          elevation (null | data | "loading" | "error"), layer }
function addRoute(result, job) {
    // A new loop replaces the previous one for the same start point or area.
    const replaces = state.routes.find(r =>
        (job.kind === "start" && r.startId === job.start.id) || (job.kind === "area" && r.mode === "area" && !r.savedName));
    if (replaces) removeRoute(replaces.id, false);

    const route = createRoute({
        label: job.label,
        mode: result.mode,
        startId: job.kind === "start" ? job.start.id : null,
        coords: result.coords,
        lengthM: result.lengthM,
        areaM2: result.areaM2,
        iq: result.iq,
        coverage: result.coverage ?? null,
        feasible: result.feasible,
        startOffsetM: 0,
        reversed: false
    });
    // Start where the loop passes closest to the pin.
    if (job.kind === "start") route.startOffsetM = nearestOffset(route, job.start.latlng);
    route.warning = routeWarning(route, result, job);
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

function routeWarning(route, result, job) {
    const notes = [];
    if (result.repeats > 0) notes.push("It runs part of a street twice.");
    if (job.kind === "start" && result.lengthM > job.start.maxDistanceM) {
        notes.push(`It's longer than your ${formatDistance(job.start.maxDistanceM)} limit.`);
    }
    if (job.kind === "start") {
        const [lat, lng] = pointAtOffset(route, route.startOffsetM);
        const gap = haversine(lat, lng, job.start.latlng.lat, job.start.latlng.lng);
        if (gap > 150) notes.push(`The closest it passes to your pin is ${formatDistance(gap)}.`);
    }
    if (job.kind === "area" && result.coverage < prefs.coveragePercent / 100) {
        notes.push(`It only encloses ${Math.round(result.coverage * 100)}% of the area (target ${prefs.coveragePercent}%). ` +
            `Try a lower target or a longer search.`);
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
    if (route && route.elevation === null) loadElevation(route);
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
            <span class="route-meta">${formatDistance(route.lengthM)}</span>
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

function estimatedSeconds(route) {
    return prefs.activity === "run" ? route.lengthM * prefs.runPaceSecPerM : route.lengthM / prefs.bikeSpeedMps;
}

function renderPaceInput() {
    ui.activityButtons.forEach(b => b.setAttribute("aria-pressed", String(b.dataset.activity === prefs.activity)));
    if (prefs.activity === "run") {
        ui.paceInput.value = formatPace(prefs.runPaceSecPerM * units().distance.meters);
        ui.paceUnit.textContent = units().paceLabel;
        ui.paceInput.setAttribute("aria-label", "Running pace in minutes:seconds");
    } else {
        ui.paceInput.value = roundForInput(prefs.bikeSpeedMps * 3600 / units().distance.meters);
        ui.paceUnit.textContent = units().speedLabel;
        ui.paceInput.setAttribute("aria-label", "Cycling speed");
    }
}

ui.activityButtons.forEach(b => b.addEventListener("click", () => {
    prefs.activity = b.dataset.activity;
    rememberPrefs();
    renderPaceInput();
    renderRouteDetail();
}));

ui.paceInput.addEventListener("input", () => {
    if (prefs.activity === "run") {
        const seconds = parsePace(ui.paceInput.value);
        if (!(seconds > 0)) return;
        prefs.runPaceSecPerM = seconds / units().distance.meters;
    } else {
        const speed = parseFloat(ui.paceInput.value);
        if (!(speed > 0)) return;
        prefs.bikeSpeedMps = speed * units().distance.meters / 3600;
    }
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
            warning: "",
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
