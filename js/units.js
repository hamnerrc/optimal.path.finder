// ==========================================================================
// Units and formatting. Everything is stored in meters internally and only
// converted for display and input.
// ==========================================================================

const UNIT_SYSTEMS = {
    mi: {
        distance: { meters: 1609.344, label: "mi" },
        elevation: { meters: 0.3048, label: "ft" },
        area: { sqMeters: 2589988.11, label: "sq mi" },
        speedLabel: "mph",
        paceLabel: "/mi"
    },
    km: {
        distance: { meters: 1000, label: "km" },
        elevation: { meters: 1, label: "m" },
        area: { sqMeters: 1e6, label: "km²" },
        speedLabel: "km/h",
        paceLabel: "/km"
    }
};

let currentUnits = "mi";

const units = () => UNIT_SYSTEMS[currentUnits];

function setUnits(name) {
    if (UNIT_SYSTEMS[name]) currentUnits = name;
}

const formatNumber = (n, digits = 0) =>
    n.toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits });

// Meters -> number in the current distance unit, and back.
const toDistanceUnit = (m) => m / units().distance.meters;
const fromDistanceUnit = (v) => v * units().distance.meters;

function formatDistance(m, digits = 2) {
    return `${formatNumber(toDistanceUnit(m), digits)} ${units().distance.label}`;
}

function formatArea(m2) {
    const value = m2 / units().area.sqMeters;
    return `${formatNumber(value, value < 10 ? 2 : 1)} ${units().area.label}`;
}

function formatElevation(m) {
    return `${formatNumber(m / units().elevation.meters)} ${units().elevation.label}`;
}

function formatDuration(seconds) {
    const total = Math.round(seconds / 60);
    const h = Math.floor(total / 60);
    const min = total % 60;
    return h ? `${h} h ${String(min).padStart(2, "0")} min` : `${min} min`;
}

// "8:30" -> 510 seconds; plain numbers are read as minutes.
function parsePace(text) {
    const match = String(text).trim().match(/^(\d+)(?::(\d{1,2}))?$/);
    if (match) return Number(match[1]) * 60 + Number(match[2] || 0);
    const minutes = parseFloat(text);
    return minutes > 0 ? minutes * 60 : NaN;
}

function formatPace(seconds) {
    const s = Math.round(seconds);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

// Rounds to a tidy number of display units (used when converting inputs).
const roundForInput = (v) => Math.round(v * 100) / 100;
