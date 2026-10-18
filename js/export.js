// ==========================================================================
// Export: KML for Google Earth / Google My Maps, GPX for Garmin, Strava etc.
// ==========================================================================

const escapeXml = (s) => String(s).replace(/[<>&'"]/g, c => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" })[c]);

// The path is written from the chosen start in the chosen direction. The
// enclosed territory is included as a separate, semi-transparent polygon.
function routeToKml(route, name) {
    const path = orderedCoords(route);
    const coordText = path.map(([lat, lng]) => `${lng.toFixed(6)},${lat.toFixed(6)},0`).join(" ");
    const [startLat, startLng] = path[0];
    const description = [
        `Distance: ${formatDistance(route.lengthM)}`,
        `Area enclosed: ${formatArea(route.areaM2)}`,
        `Isoperimetric quotient: ${route.iq.toFixed(3)}`
    ].join("\n");

    return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
<Document>
  <name>${escapeXml(name)}</name>
  <description>${escapeXml(description)}</description>
  <Style id="route"><LineStyle><color>ffeb6325</color><width>4</width></LineStyle></Style>
  <Style id="territory"><LineStyle><width>0</width></LineStyle><PolyStyle><color>40eb6325</color></PolyStyle></Style>
  <Placemark>
    <name>${escapeXml(name)}</name>
    <description>${escapeXml(description)}</description>
    <styleUrl>#route</styleUrl>
    <LineString><tessellate>1</tessellate><coordinates>${coordText}</coordinates></LineString>
  </Placemark>
  <Placemark>
    <name>Territory</name>
    <styleUrl>#territory</styleUrl>
    <Polygon><outerBoundaryIs><LinearRing><coordinates>${coordText}</coordinates></LinearRing></outerBoundaryIs></Polygon>
  </Placemark>
  <Placemark>
    <name>Start</name>
    <Point><coordinates>${startLng.toFixed(6)},${startLat.toFixed(6)},0</coordinates></Point>
  </Placemark>
</Document>
</kml>
`;
}

// A GPX track, from the chosen start in the chosen direction.
function routeToGpx(route, name) {
    const points = orderedCoords(route)
        .map(([lat, lng]) => `      <trkpt lat="${lat.toFixed(6)}" lon="${lng.toFixed(6)}"></trkpt>`)
        .join("\n");
    return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Interval Route Finder" xmlns="http://www.topografix.com/GPX/1/1">
  <metadata><name>${escapeXml(name)}</name></metadata>
  <trk>
    <name>${escapeXml(name)}</name>
    <trkseg>
${points}
    </trkseg>
  </trk>
</gpx>
`;
}

function downloadText(filename, text, type) {
    const url = URL.createObjectURL(new Blob([text], { type }));
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const safeFilename = (name) => name.replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase() || "route";
