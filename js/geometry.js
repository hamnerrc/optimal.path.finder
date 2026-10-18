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
// Rectangle (north-up, from two opposite corners)
// --------------------------------------------------------------------------

function createRectangleRegion([a, b]) {
    const bbox = {
        minLat: Math.min(a.lat, b.lat), maxLat: Math.max(a.lat, b.lat),
        minLng: Math.min(a.lng, b.lng), maxLng: Math.max(a.lng, b.lng)
    };
    const midLat = (bbox.minLat + bbox.maxLat) / 2;
    const widthM = haversine(midLat, bbox.minLng, midLat, bbox.maxLng);
    const heightM = haversine(bbox.minLat, a.lng, bbox.maxLat, a.lng);

    return {
        type: "rectangle",
        outline: [
            { lat: bbox.minLat, lng: bbox.minLng }, { lat: bbox.minLat, lng: bbox.maxLng },
            { lat: bbox.maxLat, lng: bbox.maxLng }, { lat: bbox.maxLat, lng: bbox.minLng }
        ],
        sizeMeters: [widthM, heightM],
        areaSqKm: widthM * heightM / 1e6,
        bbox,
        contains: (lat, lng) => lat >= bbox.minLat && lat <= bbox.maxLat && lng >= bbox.minLng && lng <= bbox.maxLng,
        overpassFilter: `(${bbox.minLat.toFixed(6)},${bbox.minLng.toFixed(6)},${bbox.maxLat.toFixed(6)},${bbox.maxLng.toFixed(6)})`
    };
}

// --------------------------------------------------------------------------

function createShapeRegion(shape) {
    if (shape.type === "circle") return createCircleFromDiameter(shape.points);
    if (shape.type === "rectangle") return createRectangleRegion(shape.points);
    return createEllipseRegion(shape.points);
}

// The same shape grown (factor > 1) or shrunk around its center. Every shape
// type is defined by points placed symmetrically around its center, so
// scaling the points scales the shape.
function scaleShape(shape, factor) {
    const n = shape.points.length;
    const c = {
        lat: shape.points.reduce((s, p) => s + p.lat, 0) / n,
        lng: shape.points.reduce((s, p) => s + p.lng, 0) / n
    };
    return {
        type: shape.type,
        points: shape.points.map(p => ({ lat: c.lat + (p.lat - c.lat) * factor, lng: c.lng + (p.lng - c.lng) * factor }))
    };
}

if (typeof module !== "undefined") {
    module.exports = {
        haversine, metersToMiles, milesToMeters, sqKmToSqMiles,
        createCircleRegion, createCircleFromDiameter, createEllipseRegion, createRectangleRegion,
        createShapeRegion, scaleShape
    };
}
