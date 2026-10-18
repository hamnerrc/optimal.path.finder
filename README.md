# Interval Route Finder

A static web app that finds running or cycling loops on real roads that enclose
as much territory as possible, for apps like INTVL that rank people by the area
their loops surround.

Three ways to plan:

- **Start point**: place one or more start points, each with a maximum loop
  length. Each start gets its own loop: the one with the largest enclosed
  area that passes through the start and stays within the length.
- **Area**: draw a circle, ellipse, rectangle (any angle) or freehand shape.
  The app finds the roundest loop (highest isoperimetric quotient,
  4π·area ÷ length²) that encloses at least a chosen percentage of the shape.
  Between equally round loops, the one enclosing more area wins.
- **Place**: search for a city, county, state, lake or park and use its real
  boundary (from OpenStreetMap via Nominatim) as the area.

For each loop the panel shows distance, enclosed area, roundness, coverage,
an estimated time from your pace (min/mi, min/km, mph or km/h), and an
elevation profile. The best loop so far is drawn live while the search runs;
Stop keeps it, and it can be exported at any time. Drag the green
flag to choose where on the loop you start, or reverse the direction; the
profile follows. Loops can be saved in the browser and exported as KML (Google
Earth, Google My Maps) or GPX (Garmin, Strava). Pressing "Find loops" again
only recomputes start points whose pin, length or search time changed.

## Running

No build step is needed. Serve the folder:

```sh
python3 -m http.server 8000   # then visit http://localhost:8000
```

Opening `index.html` straight from disk also works. The solver then runs on
the main thread instead of a Web Worker, because browsers don't start workers
from `file://` pages.

## Layout

```
index.html            Page markup
css/style.css         All styles (light/dark themes, mobile bottom sheet)
js/config.js          Settings: road types, servers, defaults, search times, colors
js/geometry.js        Distance math and regions (circle, ellipse, rectangle, polygon, corridor)
js/units.js           mi/km conversion and number formatting
js/storage.js         Preferences and saved loops in localStorage
js/overpass.js        Downloads roads from the Overpass API (with cache + fallback)
js/network.js         Turns OSM ways into a routing graph
js/solver.js          The loop search (see below)
js/solver-worker.js   Runs the solver in a Web Worker
js/solve.js           Starts the worker, or falls back to the main thread
js/pipeline.js        Download → network → solver; staged search for big areas
js/loop.js            Distances along a loop, start point, direction
js/elevation.js       Elevation samples and profile (Open-Meteo)
js/export.js          KML and GPX export
js/map.js             Leaflet map, icons, drawing of shapes, roads and loops
js/app.js             App state, panel UI, map interaction, search, toasts
```

The scripts are plain (non-module) files loaded in order.

## How the loop search works

`solveLoop()` in `js/solver.js`:

1. Compacts the road network into typed arrays and keeps the largest
   connected piece. Waypoints snap only to intersections, never dead ends.
2. Describes a loop as a ring of waypoints joined by A* shortest paths.
   Streets the loop already uses are made expensive, so it avoids running a
   street twice.
3. Starts from circles through the start point (8 directions, resized to fit
   the length limit), or from the area's outline, its convex hull and circles.
4. Improves the waypoints by simulated annealing (move, add, remove, scale)
   until the time limit. Legs between unchanged waypoints are reused, so most
   steps only route one or two legs.

Area is computed exactly from the road geometry (shoelace formula). Coverage
of the drawn shape is measured with scanlines.

In area mode, roads are loaded for the shape enlarged by 20%
(`CONFIG.areaMargin`), so the loop can use roads just outside its edge.

### Big searches

Up to about 80 sq mi of download area (`CONFIG.chunked.fullDetailMaxSqMiles`)
every road is loaded at once. In a dense city that is roughly a 10 mi loop:
about 200k intersections and a 70 MB download. Beyond that, `js/pipeline.js`
searches in two stages:

1. A rough loop on major roads only (motorway to tertiary; tertiary is
   dropped above 5,000 sq mi), downloaded as a grid of tiles.
2. One pass around the rough loop, about 10 mi at a time: all roads within
   half a mile of that stretch are loaded, and the stretch is re-routed (with
   the rest of the loop fixed) to improve the whole loop's score. Changes are
   kept only if the loop gets better.

The search also switches to this mode if a full download turns out to be too
big for Overpass.

## External services

- Map tiles: Esri World Street Map by default; CyclOSM and OSM France in the layer switcher
- Road data: Overpass API (overpass-api.de, with fallback mirrors)
- Elevation: Open-Meteo elevation API (about 90 m resolution)
- Place search and boundaries: Nominatim

These are free public services with usage policies. A site with heavy traffic
should use its own servers or a paid provider.
