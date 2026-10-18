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
only recomputes start points whose pin or length changed. Road tiles are
kept in memory, so removing a start point only hides its roads, and a new
start point nearby loads instantly. Tiles start downloading as soon as a
pin, shape or place is set, before "Find loop" is pressed. The same search
gives the same loop every time.

**Roads to use** (in the panel, for every mode): avoid motorways,
expressways and their ramps; allow fence hops (straight links of up to 10 m
from a dead end to a road it doesn't connect to, never across another road,
railroad, river or shore, and never from a driveway, bridge or tunnel); and
use railroad tracks. Paths, trails, sidewalks and rail trails are always
used. The loop's panel says how many fence hops it uses and how far it runs
along railroad tracks.

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
js/vectortiles.js     Decodes Mapbox vector tiles (road and water layers)
js/roadtiles.js       Loads roads from OpenFreeMap vector tiles, rebuilds junctions, fence hops
js/overpass.js        Downloads roads from the Overpass API (fallback if tiles fail)
js/network.js         Turns OSM ways into a routing graph
js/solver.js          Graph pruning, the angular sweep and block polish (see below)
js/solver-worker.js   Runs one search in a Web Worker
js/solve.js           Runs parallel searches in workers until they settle
js/pipeline.js        Roads → network → solver; staged search for big areas
js/loop.js            Distances along a loop, start point, direction
js/elevation.js       Elevation samples and profile (Open-Meteo)
js/export.js          KML and GPX export
js/map.js             Leaflet map, icons, drawing of shapes, roads and loops
js/app.js             App state, panel UI, map interaction, search, toasts
```

The scripts are plain (non-module) files loaded in order.

## Where the roads come from

`js/roadtiles.js` loads roads from OpenFreeMap's vector tiles: every
OpenStreetMap road on Earth, precomputed and rebuilt weekly, served from a
CDN. The tiles covering a search are fetched in parallel (zoom 14 holds every
road, coarser zooms only major roads) and kept in memory for later searches.
A 10 mi loop needs about 70 tiles (2 MB); that is several times faster than
asking Overpass, which runs a database query for each download.

Tiles don't carry OSM node IDs, and simplification drops some junction points
from straight roads, so junctions are rebuilt geometrically: roads that share
a point, end on another road or cross it are joined there, unless one of them
is a bridge or tunnel. Line ends within 2.5 m of each other are joined: a
road is often split into several features (at a bridge, or where its tags
change), and pieces cut at tile edges come from separately simplified
tiles, so their ends can be a metre or two apart. In Lawrence, KS the result
matches Overpass to within about 3% of road length and junction count.
Tiles are assembled in a fixed order, so the same search always gets the
same network.

If the tile server can't be reached, the Overpass API is used instead.

## How the loop search works

`js/solver.js`:

1. `prepareGraph()` (main thread) keeps the largest connected piece of the
   road network and prunes it to the part a ring can use: dead-end streets,
   and whole trees of streets hanging off them, are removed repeatedly
   until every node has at least two streets. Chains of roads between
   junctions are merged into single edges. In start point mode it also finds
   the shortest path from the start to every junction within half the length
   limit, for the out-and-back stem. `buildFaces()` then makes the map planar
   (a road crossing another without a junction, e.g. on a bridge, gets a
   "virtual" vertex there that a loop can only pass straight through) and
   lists its faces, the blocks between roads, within each 2-connected part.
2. **Angular sweep** (`sweepLoop`). Pick a centre and a junction s. Among
   all loops through s that wind once around the centre, always moving
   forward in angle (star-shaped loops, which the roundest loops are), the
   best one can be found exactly: sorted by angle, the junctions form a
   DAG, and a dynamic program over (junction, length so far) keeps the best
   path for each length bucket (shorter paths get credit for the area their
   spare length could add). The area of a loop is a sum over its streets
   (shoelace formula relative to the centre), and so is its coverage of a
   target area (measured in angular bins). A sweep over 20,000 junctions
   takes about 25 ms. In area mode the sweep maximizes area plus a weight
   times covered area and scores the best loop of every length.
3. **Block polish** (`FacePolish`). A loop is the boundary of a set of
   blocks. Simulated annealing adds or removes one block at a time (the
   change in length, area and coverage follows exactly from the block's own
   streets, about a microsecond per move), and now and then reroutes a
   stretch of the loop along the shortest path just inside or outside it,
   flipping every block in between. The inside always stays one piece
   without holes or pinch points, so the loop never touches itself. This
   handles what a sweep can't: winding streets, and reaching the coverage
   target in area mode.
4. `SweepSearch` sweeps many centres (an evenly spread low-discrepancy
   sequence around the start or the area, every third sweep re-centred on
   the best loop so far), polishing each loop that comes close to the best.
   `js/solve.js` runs one search per spare CPU core in Web Workers (started
   when the page loads and kept between searches), each taking its share of
   the sequence. `SearchTracker` stops them once enough sweeps in a row
   (40 + 4 per worker, and at least half as many as it took to find the
   best loop) have found nothing more than 0.1% better. Sweeps are counted
   in sequence order, so the same search always gives the same loop.

At a virtual vertex (a road crossing another without a junction) the way
on depends on the way in, so the sweep keeps separate states for paths
arriving along each of the two roads.

Area is computed exactly from the road geometry (shoelace formula). Coverage
of the drawn shape is measured with scanlines.

In area mode, roads are loaded for the shape's convex hull enlarged by 5%
(`CONFIG.areaMargins`), so the loop can use roads just outside its edge. If
that can't reach the coverage target, the search is repeated with 20% and
then 40%.

### Big searches

Up to about 80 sq mi (`CONFIG.chunked.fullDetailMaxSqMiles`, a 10 mi loop)
every road is loaded at once. Beyond that, `js/pipeline.js` searches in two
stages:

1. A rough loop on major roads only (motorway to tertiary; tertiary is
   dropped above 5,000 sq mi), from coarser tiles (at most 150).
2. All roads within 1 km of the rough loop are loaded (just the tiles along
   it), the rough loop is traced onto them, and it is improved stretch by
   stretch (`SweepSearch.refine`): each stretch between two junctions, a
   few km to a few dozen km long, is replaced by the best path between its
   ends that keeps moving forward along the loop, if that makes the whole
   loop better. A stretch that can't be improved (or rerouted at all, e.g. a
   cloverleaf ramp that passes under its own bridge) stays as it is, so one
   awkward spot can't block the rest of a very long loop. Every few passes
   a sweep around the loop's centre is tried too, and the result is
   polished block by block. The result always uses the real road shapes.

From a cold start in the browser (2015 dual-core laptop): a 30 mi loop in
Chicago and a 100 mi loop around Denver take a few seconds plus the
download; Kansas at 75% coverage (a 1,140 mi loop, about 2,000 tiles) about
30 s, most of it downloading.

## External services

- Map tiles: Esri World Street Map by default; CyclOSM and OSM France in the layer switcher
- Road data: OpenFreeMap vector tiles (tiles.openfreemap.org); Overpass API
  (overpass-api.de, with fallback mirrors) if they can't be reached
- Elevation: Open-Meteo elevation API (about 90 m resolution)
- Place search and boundaries: Nominatim (names first; the boundary is
  downloaded only for the place you pick)

These are free public services with usage policies. A site with heavy traffic
should use its own servers or a paid provider.
