// ==========================================================================
// Geometry helpers and search regions.
//
// A "region" describes the area the road network is loaded from. Every
// region exposes the same interface, so the loader and network builder never
// need to know which shape they are dealing with:
//
//   type       "circle" | "ellipse" | "rectangle"
//   outline    [{ lat, lng }] polygon around the edge
//   bbox       { minLat, maxLat, minLng, maxLng }
//   areaSqKm   approximate area
//   contains(lat, lng)  -> boolean
//   overpassFilter      -> Overpass QL spatial filter, e.g. "(around:…)"
//
// Points are plain { lat, lng } objects (Leaflet LatLngs work as-is).
// ==========================================================================

const EARTH_RADIUS_M = 6371008.8;
const METERS_PER_MILE = 1609.344;
const SQ_KM_PER_SQ_MILE = 2.589988;
const DEG = Math.PI / 180;

const metersToMiles = (m) => m / METERS_PER_MILE;
const milesToMeters = (mi) => mi * METERS_PER_MILE;
const sqKmToSqMiles = (km2) => km2 / SQ_KM_PER_SQ_MILE;

const CIRCLE_SEGMENTS = 72;

// Great-circle distance in meters.
function haversine(lat1, lng1, lat2, lng2) {
    const dLat = (lat2 - lat1) * DEG;
    const dLng = (lng2 - lng1) * DEG;
    const h = Math.sin(dLat / 2) ** 2 +
        Math.cos(lat1 * DEG) * Math.cos(lat2 * DEG) * Math.sin(dLng / 2) ** 2;
    return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

const midpoint = (a, b) => ({ lat: (a.lat + b.lat) / 2, lng: (a.lng + b.lng) / 2 });

// --------------------------------------------------------------------------
// Circle
// --------------------------------------------------------------------------

function createCircleRegion(center, radiusMeters) {
    const dLat = radiusMeters / (EARTH_RADIUS_M * DEG);
    const dLng = dLat / Math.max(Math.cos(center.lat * DEG), 1e-6);

    const outline = [];
    for (let i = 0; i < CIRCLE_SEGMENTS; i++) {
        const t = (i / CIRCLE_SEGMENTS) * 2 * Math.PI;
        outline.push({ lat: center.lat + dLat * Math.sin(t), lng: center.lng + dLng * Math.cos(t) });
    }

    return {
        type: "circle",
        center,
        radiusMeters,
        outline,
        areaSqKm: Math.PI * (radiusMeters / 1000) ** 2,
        bbox: {
            minLat: Math.max(-90, center.lat - dLat),
            maxLat: Math.min(90, center.lat + dLat),
            minLng: center.lng - dLng,
            maxLng: center.lng + dLng
        },
        contains(lat, lng) {
            // Latitude difference alone is a cheap lower bound on distance.
            if (Math.abs(lat - center.lat) > dLat) return false;
            return haversine(lat, lng, center.lat, center.lng) <= radiusMeters;
        },
        overpassFilter: `(around:${radiusMeters.toFixed(0)},${center.lat.toFixed(6)},${center.lng.toFixed(6)})`
    };
}

// Circle defined by two points on its diameter.
function createCircleFromDiameter([a, b]) {
    return createCircleRegion(midpoint(a, b), haversine(a.lat, a.lng, b.lat, b.lng) / 2);
}

// --------------------------------------------------------------------------
// Ellipse (through three points, centered on their centroid)
// --------------------------------------------------------------------------

const ELLIPSE_SEGMENTS = 72;

function createEllipseRegion(points) {
    // Work in a local flat projection around the centroid (fine at city scale).
    const refLat = (points[0].lat + points[1].lat + points[2].lat) / 3;
    const cosLat = Math.cos(refLat * DEG);
    const toXY = (p) => ({ x: p.lng * DEG * EARTH_RADIUS_M * cosLat, y: p.lat * DEG * EARTH_RADIUS_M });
    const toLatLng = (x, y) => ({ lat: y / DEG / EARTH_RADIUS_M, lng: x / DEG / EARTH_RADIUS_M / cosLat });

    const { cx, cy, a, b, angle } = fitEllipseThroughThreePoints(points.map(toXY));
    const cosA = Math.cos(angle);
    const sinA = Math.sin(angle);

    const outline = [];
    for (let i = 0; i < ELLIPSE_SEGMENTS; i++) {
        const t = (i / ELLIPSE_SEGMENTS) * 2 * Math.PI;
        const lx = a * Math.cos(t);
        const ly = b * Math.sin(t);
        outline.push(toLatLng(cx + lx * cosA - ly * sinA, cy + lx * sinA + ly * cosA));
    }

    const bbox = outline.reduce((box, p) => ({
        minLat: Math.min(box.minLat, p.lat), maxLat: Math.max(box.maxLat, p.lat),
        minLng: Math.min(box.minLng, p.lng), maxLng: Math.max(box.maxLng, p.lng)
    }), { minLat: Infinity, maxLat: -Infinity, minLng: Infinity, maxLng: -Infinity });

    return {
        type: "ellipse",
        outline,
        semiAxesMeters: [Math.max(a, b), Math.min(a, b)],
        areaSqKm: Math.PI * a * b / 1e6,
        bbox,
        contains(lat, lng) {
            if (lat < bbox.minLat || lat > bbox.maxLat || lng < bbox.minLng || lng > bbox.maxLng) return false;
            const p = toXY({ lat, lng });
            const dx = p.x - cx;
            const dy = p.y - cy;
            const u = dx * cosA + dy * sinA;
            const v = -dx * sinA + dy * cosA;
            return (u * u) / (a * a) + (v * v) / (b * b) <= 1;
        },
        overpassFilter: `(poly:"${outline.map(p => `${p.lat.toFixed(6)} ${p.lng.toFixed(6)}`).join(" ")}")`
    };
}

// Fits A·x² + B·xy + C·y² = 1 (centered on the centroid) through three points.
// Falls back to a circle when the points are degenerate (e.g. collinear).
function fitEllipseThroughThreePoints(pxy) {
    const cx = (pxy[0].x + pxy[1].x + pxy[2].x) / 3;
    const cy = (pxy[0].y + pxy[1].y + pxy[2].y) / 3;
    const pts = pxy.map(p => ({ x: p.x - cx, y: p.y - cy }));
    const avgDist = pts.reduce((sum, p) => sum + Math.hypot(p.x, p.y), 0) / pts.length || 1;
    const fallback = { cx, cy, a: avgDist, b: avgDist, angle: 0 };

    const sol = solve3x3(pts.map(p => [p.x * p.x, p.x * p.y, p.y * p.y]), [1, 1, 1]);
    if (!sol) return fallback;

    const [A, B, C] = sol;
    const angle = 0.5 * Math.atan2(B, A - C);
    const cosA = Math.cos(angle);
    const sinA = Math.sin(angle);
    const lambda1 = A * cosA * cosA + B * sinA * cosA + C * sinA * sinA;
    const lambda2 = A * sinA * sinA - B * sinA * cosA + C * cosA * cosA;
    if (lambda1 <= 1e-18 || lambda2 <= 1e-18) return fallback;

    const a = Math.sqrt(1 / lambda1);
    const b = Math.sqrt(1 / lambda2);
    if (Math.max(a, b) / Math.min(a, b) > 50 || Math.max(a, b) > avgDist * 50) return fallback;

    return { cx, cy, a, b, angle };
}

// Cramer's rule; returns null for (near-)singular systems.
function solve3x3(M, rhs) {
    const det3 = m =>
        m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) -
        m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) +
        m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);

    const D = det3(M);
    const scale = Math.max(...M.flat().map(Math.abs), 1e-9);
    if (Math.abs(D) < 1e-9 * scale ** 3) return null;

    const replaceCol = (col) => M.map((row, i) => row.map((v, j) => (j === col ? rhs[i] : v)));
    return [det3(replaceCol(0)) / D, det3(replaceCol(1)) / D, det3(replaceCol(2)) / D];
}

// --------------------------------------------------------------------------
// Local flat projection (meters) around a reference latitude. Accurate enough
// for shapes up to a few hundred miles across.
// --------------------------------------------------------------------------

function localProjection(refLat, refLng = 0) {
    const ky = DEG * EARTH_RADIUS_M;
    const kx = ky * Math.cos(refLat * DEG);
    return {
        toXY: (p) => ({ x: (p.lng - refLng) * kx, y: (p.lat - refLat) * ky }),
        toLatLng: (x, y) => ({ lat: y / ky + refLat, lng: x / kx + refLng })
    };
}

function boundsOf(points) {
    return points.reduce((box, p) => ({
        minLat: Math.min(box.minLat, p.lat), maxLat: Math.max(box.maxLat, p.lat),
        minLng: Math.min(box.minLng, p.lng), maxLng: Math.max(box.maxLng, p.lng)
    }), { minLat: Infinity, maxLat: -Infinity, minLng: Infinity, maxLng: -Infinity });
}

// --------------------------------------------------------------------------
// Polygon (any simple polygon: freehand shapes, rectangles, place boundaries)
// --------------------------------------------------------------------------

// Overpass "poly" filters get slow with many vertices; larger outlines are
// simplified for the query only (the polygon itself stays exact).
const OVERPASS_POLY_MAX_POINTS = 200;

function createPolygonRegion(points, type = "polygon") {
    const bbox = boundsOf(points);
    const { toXY } = localProjection((bbox.minLat + bbox.maxLat) / 2, (bbox.minLng + bbox.maxLng) / 2);
    const xy = points.map(toXY);
    let twiceArea = 0;
    for (let i = 0; i < xy.length; i++) {
        const a = xy[i], b = xy[(i + 1) % xy.length];
        twiceArea += a.x * b.y - b.x * a.y;
    }
    const lats = points.map(p => p.lat);
    const lngs = points.map(p => p.lng);
    const queryPoints = points.length > OVERPASS_POLY_MAX_POINTS
        ? simplifyRing(points, OVERPASS_POLY_MAX_POINTS) : points;

    return {
        type,
        outline: points,
        areaSqKm: Math.abs(twiceArea) / 2 / 1e6,
        bbox,
        contains(lat, lng) {
            if (lat < bbox.minLat || lat > bbox.maxLat || lng < bbox.minLng || lng > bbox.maxLng) return false;
            let inside = false;
            for (let i = 0, j = lats.length - 1; i < lats.length; j = i++) {
                if ((lats[i] > lat) !== (lats[j] > lat) &&
                    lng < lngs[i] + (lat - lats[i]) * (lngs[j] - lngs[i]) / (lats[j] - lats[i])) inside = !inside;
            }
            return inside;
        },
        overpassFilter: `(poly:"${queryPoints.map(p => `${p.lat.toFixed(5)} ${p.lng.toFixed(5)}`).join(" ")}")`
    };
}

// Rectangle from three clicks: two corners along one side, then any point
// on the opposite side (sets the width). Works at any rotation.
function createRectangleRegion([a, b, c]) {
    const { toXY, toLatLng } = localProjection(a.lat, a.lng);
    const pa = toXY(a), pb = toXY(b), pc = toXY(c);
    const dx = pb.x - pa.x, dy = pb.y - pa.y;
    const length = Math.hypot(dx, dy) || 1;
    const nx = -dy / length, ny = dx / length;
    const width = (pc.x - pa.x) * nx + (pc.y - pa.y) * ny;
    const corners = [
        pa, pb,
        { x: pb.x + nx * width, y: pb.y + ny * width },
        { x: pa.x + nx * width, y: pa.y + ny * width }
    ].map(p => toLatLng(p.x, p.y));

    const region = createPolygonRegion(corners, "rectangle");
    region.sizeMeters = [length, Math.abs(width)];
    return region;
}

// Corridor: everything within radiusMeters of a polyline. Used to load all
// roads along a rough loop when refining a very long one.
function createCorridorRegion(points, radiusMeters) {
    const bbox0 = boundsOf(points);
    const { toXY } = localProjection((bbox0.minLat + bbox0.maxLat) / 2, (bbox0.minLng + bbox0.maxLng) / 2);
    const xy = points.map(toXY);
    const dLat = radiusMeters / (EARTH_RADIUS_M * DEG);
    const dLng = dLat / Math.max(Math.cos(((bbox0.minLat + bbox0.maxLat) / 2) * DEG), 1e-6);
    const bbox = { minLat: bbox0.minLat - dLat, maxLat: bbox0.maxLat + dLat, minLng: bbox0.minLng - dLng, maxLng: bbox0.maxLng + dLng };
    const r2 = radiusMeters * radiusMeters;
    let length = 0;
    for (let i = 1; i < xy.length; i++) length += Math.hypot(xy[i].x - xy[i - 1].x, xy[i].y - xy[i - 1].y);

    return {
        type: "corridor",
        points,
        radiusMeters,
        areaSqKm: (2 * radiusMeters * length + Math.PI * r2) / 1e6,
        bbox,
        contains(lat, lng) {
            if (lat < bbox.minLat || lat > bbox.maxLat || lng < bbox.minLng || lng > bbox.maxLng) return false;
            const p = toXY({ lat, lng });
            for (let i = 1; i < xy.length; i++) {
                if (distanceToSegmentSq(p, xy[i - 1], xy[i]) <= r2) return true;
            }
            return xy.length === 1 && (p.x - xy[0].x) ** 2 + (p.y - xy[0].y) ** 2 <= r2;
        },
        // Overpass accepts a polyline for "around".
        overpassFilter: `(around:${radiusMeters.toFixed(0)},${points.map(p => `${p.lat.toFixed(5)},${p.lng.toFixed(5)}`).join(",")})`
    };
}

function distanceToSegmentSq(p, a, b) {
    const dx = b.x - a.x, dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    const t = len2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2)) : 0;
    return (a.x + t * dx - p.x) ** 2 + (a.y + t * dy - p.y) ** 2;
}

// Douglas–Peucker on lat/lng (scaled for latitude), down to about maxPoints.
function simplifyLine(points, maxPoints) {
    if (points.length <= maxPoints) return points;
    const k = Math.cos(points[0].lat * DEG);
    const xy = points.map(p => ({ x: p.lng * k, y: p.lat }));
    const keepWith = (tolerance) => {
        const keep = new Uint8Array(points.length);
        keep[0] = keep[points.length - 1] = 1;
        const stack = [[0, points.length - 1]];
        const tol2 = tolerance * tolerance;
        while (stack.length) {
            const [lo, hi] = stack.pop();
            let worst = -1, worstD = tol2;
            for (let i = lo + 1; i < hi; i++) {
                const d = distanceToSegmentSq(xy[i], xy[lo], xy[hi]);
                if (d > worstD) {
                    worstD = d;
                    worst = i;
                }
            }
            if (worst >= 0) {
                keep[worst] = 1;
                stack.push([lo, worst], [worst, hi]);
            }
        }
        return points.filter((_, i) => keep[i]);
    };
    // Grow the tolerance until the result is small enough.
    const box = boundsOf(points);
    let tolerance = Math.max(box.maxLat - box.minLat, (box.maxLng - box.minLng) * k) / 2000;
    let out = keepWith(tolerance);
    while (out.length > maxPoints) {
        tolerance *= 1.6;
        out = keepWith(tolerance);
    }
    return out;
}

// Closed ring version: simplified as a line that returns to its start.
const simplifyRing = (points, maxPoints) => simplifyLine([...points, points[0]], maxPoints + 1).slice(0, -1);

// --------------------------------------------------------------------------

function createShapeRegion(shape) {
    if (shape.type === "circle") return createCircleFromDiameter(shape.points);
    if (shape.type === "ellipse") return createEllipseRegion(shape.points);
    if (shape.type === "rectangle") return createRectangleRegion(shape.points);
    return createPolygonRegion(shape.points, shape.type);
}

// The region roads are loaded from for an area search: the shape grown by
// `factor` around its center, so the loop can use roads just outside it.
function marginRegion(region, factor) {
    if (region.type === "circle") return createCircleRegion(region.center, region.radiusMeters * factor);
    const bbox = region.bbox;
    const { toXY, toLatLng } = localProjection((bbox.minLat + bbox.maxLat) / 2, (bbox.minLng + bbox.maxLng) / 2);
    const xy = region.outline.map(toXY);
    const c = polygonCentroidXY(xy);
    return createPolygonRegion(xy.map(p => toLatLng(c.x + (p.x - c.x) * factor, c.y + (p.y - c.y) * factor)));
}

function polygonCentroidXY(points) {
    let area = 0, cx = 0, cy = 0;
    for (let i = 0; i < points.length; i++) {
        const a = points[i], b = points[(i + 1) % points.length];
        const c = a.x * b.y - b.x * a.y;
        area += c;
        cx += (a.x + b.x) * c;
        cy += (a.y + b.y) * c;
    }
    if (Math.abs(area) < 1e-9) {
        return { x: points.reduce((s, p) => s + p.x, 0) / points.length, y: points.reduce((s, p) => s + p.y, 0) / points.length };
    }
    return { x: cx / (3 * area), y: cy / (3 * area) };
}

if (typeof module !== "undefined") {
    module.exports = {
        haversine, metersToMiles, milesToMeters, sqKmToSqMiles, localProjection, boundsOf,
        createCircleRegion, createCircleFromDiameter, createEllipseRegion, createRectangleRegion,
        createPolygonRegion, createCorridorRegion, simplifyLine, simplifyRing,
        createShapeRegion, marginRegion, polygonCentroidXY
    };
}
