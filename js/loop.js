// ==========================================================================
// Helpers for a found loop: distances along it, choosing where it starts,
// and its direction.
//
// A route keeps the loop as the solver returned it (`coords`, closed, first
// point === last point) plus two user choices:
//   startOffsetM  where along `coords` the run starts
//   reversed      run it in the opposite direction
// ==========================================================================

function cumulativeDistances(coords) {
    const cum = new Float64Array(coords.length);
    for (let i = 1; i < coords.length; i++) {
        const [aLat, aLng] = coords[i - 1];
        const [bLat, bLng] = coords[i];
        cum[i] = cum[i - 1] + haversine(aLat, aLng, bLat, bLng);
    }
    return cum;
}

const loopLength = (route) => route.cum[route.cum.length - 1];

const wrapOffset = (route, offset) => {
    const length = loopLength(route);
    return ((offset % length) + length) % length;
};

// Index i such that cum[i] <= offset < cum[i + 1].
function segmentAt(cum, offset) {
    let lo = 0, hi = cum.length - 2;
    while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (cum[mid] <= offset) lo = mid;
        else hi = mid - 1;
    }
    return lo;
}

// [lat, lng] at a distance along the loop (from the loop's own first point).
function pointAtOffset(route, offset) {
    const { coords, cum } = route;
    const d = wrapOffset(route, offset);
    const i = segmentAt(cum, d);
    const span = cum[i + 1] - cum[i];
    const f = span > 0 ? (d - cum[i]) / span : 0;
    return [
        coords[i][0] + (coords[i + 1][0] - coords[i][0]) * f,
        coords[i][1] + (coords[i + 1][1] - coords[i][1]) * f
    ];
}

// Distance along the loop of the point closest to `latlng`.
function nearestOffset(route, latlng) {
    const { coords, cum } = route;
    const cosLat = Math.cos(latlng.lat * DEG);
    const px = latlng.lng * cosLat, py = latlng.lat;
    let best = 0, bestD = Infinity;

    for (let i = 0; i + 1 < coords.length; i++) {
        const ax = coords[i][1] * cosLat, ay = coords[i][0];
        const bx = coords[i + 1][1] * cosLat, by = coords[i + 1][0];
        const dx = bx - ax, dy = by - ay;
        const len2 = dx * dx + dy * dy;
        const t = len2 > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2)) : 0;
        const d = (ax + t * dx - px) ** 2 + (ay + t * dy - py) ** 2;
        if (d < bestD) {
            bestD = d;
            best = cum[i] + t * (cum[i + 1] - cum[i]);
        }
    }
    return best;
}

// Distance along the loop for a distance travelled from the chosen start.
const offsetFromStart = (route, travelled) =>
    wrapOffset(route, route.startOffsetM + (route.reversed ? -travelled : travelled));

// The loop as the user will run it: from the chosen start, in the chosen
// direction, ending back at the start.
function orderedCoords(route) {
    const { coords, cum } = route;
    const start = wrapOffset(route, route.startOffsetM);
    const i = segmentAt(cum, start);
    const startPoint = pointAtOffset(route, start);

    // Points after the start, then wrap around (skipping the duplicate closing point).
    const out = [startPoint];
    for (let k = i + 1; k < coords.length; k++) out.push(coords[k]);
    for (let k = 1; k <= i; k++) out.push(coords[k]);
    out.push(startPoint);
    return route.reversed ? out.reverse() : out;
}

// Compass bearing in degrees from a to b.
function bearing([lat1, lng1], [lat2, lng2]) {
    const y = Math.sin((lng2 - lng1) * DEG) * Math.cos(lat2 * DEG);
    const x = Math.cos(lat1 * DEG) * Math.sin(lat2 * DEG) -
        Math.sin(lat1 * DEG) * Math.cos(lat2 * DEG) * Math.cos((lng2 - lng1) * DEG);
    return (Math.atan2(y, x) / DEG + 360) % 360;
}

// Direction-of-travel markers: [{ latlng, bearing }] spaced along the loop.
function directionMarkers(route, count) {
    const length = loopLength(route);
    const out = [];
    for (let k = 1; k < count; k++) {
        const travelled = (k / count) * length;
        const here = pointAtOffset(route, offsetFromStart(route, travelled));
        const ahead = pointAtOffset(route, offsetFromStart(route, travelled + Math.min(20, length / 100)));
        out.push({ latlng: here, bearing: bearing(here, ahead) });
    }
    return out;
}
