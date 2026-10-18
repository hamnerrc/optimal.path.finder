# Interval Route Finder

A static web app that finds running or cycling loops on real roads that enclose
as much territory as possible, for apps like INTVL that rank people by the area
their loops surround.

Three ways to plan:

- **Start point**: place one or more start points, each with a maximum loop
  length. Each start gets its own loop: the one with the largest enclosed
  area that stays within the length. If the best loop doesn't pass through
  the start, the run goes out to it and back the same way, and that stretch
  counts twice toward the length.
- **Area**: draw a circle, ellipse, rectangle (any angle) or freehand shape.
  The app finds the roundest loop (highest isoperimetric quotient,
  4π·area ÷ length²) that encloses at least a chosen percentage of the shape.
  Between equally round loops, the one enclosing more area wins.
- **Place**: search for a city, county, state, lake or park and use its real
  boundary (from OpenStreetMap via Nominatim) as the area.

For each loop the panel shows distance, enclosed area, roundness, coverage,
an estimated time from your pace (min/mi, min/km, mph or km/h), and an
elevation profile. There is no time limit: the search runs until it stops
finding better loops. The best loop so far is drawn live while the search
runs; Stop keeps it, and it can be exported at any time. Drag the green
flag to choose where on the loop you start, or reverse the direction; the
profile follows. Loops can be saved in the browser and exported as KML (Google
Earth, Google My Maps) or GPX (Garmin, Strava). Pressing "Find loops" again
only recomputes start points whose pin or length changed. Removing a start
point hides its roads, but the download is kept in memory, so a new start
point inside the same area doesn't download anything.

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
js/config.js          Settings: road types, servers, defaults, colors
js/geometry.js        Distance math and regions (circle, ellipse, rectangle, polygon, corridor)
js/units.js           mi/km conversion and number formatting
js/storage.js         Preferences and saved loops in localStorage
js/overpass.js        Downloads roads from the Overpass API (with cache + fallback)
js/network.js         Turns OSM ways into a routing graph
js/solver.js          Graph pruning and the loop search (see below)
js/solver-worker.js   Runs one search in a Web Worker
js/solve.js           Runs parallel searches in workers until they settle
js/pipeline.js        Download → network → solver; staged search for big areas
js/loop.js            Distances along a loop, start point, direction
js/elevation.js       Elevation samples and profile (Open-Meteo)
js/export.js          KML and GPX export
js/map.js             Leaflet map, icons, drawing of shapes, roads and loops
js/app.js             App state, panel UI, map interaction, search, toasts
```

The scripts are plain (non-module) files loaded in order.

## How the loop search works

`js/solver.js`:

1. `prepareGraph()` (main thread) keeps the largest connected piece of the
   road network and prunes it to the part a ring can use: dead-end streets,
   and whole trees of streets hanging off them, are removed repeatedly
   until every node has at least two streets. Chains of roads between
   junctions are then merged into single edges. In Lawrence, KS this leaves
   about 60% of the nodes. In start point mode it also finds the shortest
   path from the start to every road within half the length limit, for the
   out-and-back stem.
2. A loop is a ring of waypoints joined by A* paths (with a slightly greedy
   heuristic, which explores far fewer nodes). Streets the loop already uses
   are made expensive, so it avoids running a street twice.
3. The search runs in rounds. Each round anneals the waypoints (move, add,
   remove, scale) for a few hundred steps, either from the best of several
   random starting shapes (circles through the start, or the area's
   outline, convex hull or a circle) or from its best loop so far. Legs
   between unchanged waypoints are reused, so most steps only route one or
   two legs.
4. `js/solve.js` runs one independent search per spare CPU core in Web
   Workers. `SearchTracker` stops them all once enough rounds in a row
   (at least 12 + 4 per worker, and at least half as many as it took to
   find the best loop) have found nothing more than 0.2% better.

Area is computed exactly from the road geometry (shoelace formula). Coverage
of the drawn shape is measured with scanlines.

In area mode, roads are loaded for the shape's convex hull enlarged by 5%
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
- Place search and boundaries: Nominatim (names first; the boundary is
  downloaded only for the place you pick)

These are free public services with usage policies. A site with heavy traffic
should use its own servers or a paid provider.
