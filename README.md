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
  4π·area ÷ length²) that encloses at least a chosen share of the shape,
  typed as a percentage of it or as an area in sq mi or sq km. Between
  equally round loops, the one enclosing more area wins.
- **Place**: search for a city, county, state, lake or park and use its real
  boundary (from OpenStreetMap via Nominatim) as the area.

**Limits** (every mode, optional): the shortest and longest distance, the
smallest and largest enclosed area, and the least and most climb. In start
point mode each pin's length is its longest distance. If they can't all be
met, they count in this order: the longest distance (how far you can go),
then the most climb, then the shortest distance and the area limits, then
the share of the area to surround, then the least climb, and only then the
goal (most area, or roundest). A loop that misses a limit says which; one
held back from its coverage target by a distance, climb or area limit
says so in a note (that's expected). In the solver each loop gets a rank,
the most important limit it misses (`limitMisses` in `js/solver.js`), and a
lower rank always beats a better score; within a rank, misses shrink the
score steeply so the search heads toward meeting them. Climb limits are
checked against the search's climb estimate (terrain tiles): the sweep
tracks the climb of every path, some sweeps count climb as lost area (to
find flat loops) and, with a climb limit, some try smaller loops.

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

**Roads & hills** (in the panel, for every mode): avoid motorways,
expressways and their ramps (off by default); allow fence hops (straight
links of up to 10 m from a dead end to a road it doesn't connect to, never
across another road, railroad, river or shore, and never from a driveway,
bridge or tunnel; on by default); use railroad tracks (on by default);
prefer smaller roads (on by default): while searching, motorways, trunk
roads and railroad tracks count as 8% longer and primary roads as 3%, so a
road right beside them is taken when it's about as good, but they are still
used where they are clearly better; and a Hills slider from "No cost" to
"Avoid hills avidly": each meter of climb counts as 0 to 10 m of extra
length while searching (3 m by default).
Paths, trails, sidewalks and rail trails are always used, and so are roads
and paths marked private or no entry. A loop that uses fence hops, railroad
tracks, motorways or private roads says so in a warning and marks those
stretches in orange on the map, so they can be checked before running.

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
js/elevation.js       Elevation samples and profile (terrain tiles, Open-Meteo fallback)
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
   A path or drive that loops back across itself is cut at the crossing in
   this map (the loop still follows the real road), since one such spot
   would otherwise stop the block polish for every loop around it.
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
   sequence: in start point mode about a loop's radius from the start, in
   area mode around the area's middle; every third sweep of each search is
   re-centred on its best loop so far, and the other sweeps of all searches
   together take consecutive points of the sequence, so every direction is
   tried), polishing each loop that comes close to the best.
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

**Climb.** Unless the Hills slider is at "No cost", every road first gets
its climb from terrain tiles (`addRoadClimb` in `js/elevation.js`; at most
64 tiles, zoom 13 or coarser), and the search counts each meter of climb as
the slider's 0.5 to 10 m of extra length (3 m by default), so of two loops
that are about as good,
the flatter one wins, while a much bigger or rounder loop still wins over a
hill. With "prefer smaller roads", big roads get their extra length the
same way. In area mode the extra length lowers roundness; in start point
mode (and in area mode with a length limit) it counts as the area one more
meter of loop would enclose, so a loop in the hills still uses its whole
length. The length, area and roundness shown are always the real ones.

In area mode, roads are loaded 20% beyond the shape (`CONFIG.areaMargins`):
its convex hull and its north-south bounding box, both enlarged by 20%, so
the loop can use roads outside its edge, including the corners of a
square of grid streets around a round area. A wider margin often gives a
much rounder loop. If the coverage target still can't be reached, the
search is repeated with 40%.

### Big searches

Up to about 80 sq mi (`CONFIG.chunked.fullDetailMaxSqMiles`, a 10 mi loop)
every road is loaded at once. So are bigger areas with few roads (the
countryside): up to 2,500 tiles holding at most 800,000 road points, which
covers a 50 mi loop in rural Kansas (1,500 tiles, 67,000 points). Beyond
that, `js/pipeline.js` searches in stages:

1. A rough loop on major roads only (motorway to tertiary; tertiary is
   dropped above 5,000 sq mi), from coarser tiles (at most 150). A loop
   expected to be over 2,000 km long (a share of a country) uses
   motorways, trunk and primary roads from zoom 7 tiles instead (the US:
   390 tiles). This stage settles sooner than other searches (it only sets
   the shape).
2. All roads within 3% of the rough loop's size (its length / π, at least
   1 km) to either side are loaded (just the tiles along it), the rough loop is traced onto them, and it is improved stretch by
   stretch (`SweepSearch.refine`): each stretch between two junctions, from
   3 km (or a 400th of the loop) up to a twelfth of the loop long, is replaced by the best path between its
   ends that keeps moving forward along the loop, if that makes the whole
   loop better. A stretch that can't be improved (or rerouted at all, e.g. a
   cloverleaf ramp that passes under its own bridge) stays as it is, so one
   awkward spot can't block the rest of a very long loop. Every few passes
   a sweep around the loop's centre is tried too, and the result is
   polished block by block. The result always uses the real road shapes.
3. The same again in a corridor along the improved loop, so each side can
   move further (up to three passes, until a pass gains less than 0.5%;
   one for loops over 2,000 km). Every stage counts the climb, the coarse
   ones from coarse terrain tiles (an estimate, but enough that the rough
   loop doesn't settle somewhere the later stages couldn't get it out of).

A corridor takes at most about 1,500 tiles (`corridorPlan`). Tile servers
answer about 150 requests a second whatever their size, so the number of
tiles is what a download costs. If full-detail tiles (zoom 14) would need
more, zoom 13 tiles (every road but paths and tracks) or zoom 12 tiles
(also no service roads), which cover 4 and 16 times the area each, are used
instead, and at zoom 12 the corridor is narrowed if needed (to no less
than a quarter of a tile, about 2 km: a rough loop from zoom 7 tiles can
be a kilometer off its roads). Once a stage's search begins to settle, the
tiles along its best loop so far start downloading, so the next corridor
is mostly loaded when it starts. Ends of a road cut at a tile edge are joined up to 15 m
apart at zoom 12 (coarse tiles are simplified separately on each side).

To keep memory low on such searches, road geometry is kept in flat arrays
(not an array or object per point), coarse tiles skip the water layers
(only fence hops need them), the road network is only drawn on the map
when it's small enough (`CONFIG.maxDrawnRoadPoints`; otherwise just its
major roads, or none), a very big graph gets two search workers instead of
three (each holds a copy), and each stage's data is released as soon as
it's done.

Times in Chrome on a 2015 dual-core laptop, from a cold start (nothing
downloaded yet): Kansas at 75% about 45 seconds (it was about 3 minutes,
for a less round loop); the United States at 10% about 50 seconds, with
the tab's memory peaking around 1.4 GB (the live data is under 1 GB; the
rest is garbage the browser hasn't collected yet).

## External services

- Map tiles: Esri World Street Map by default; CyclOSM and OSM France in the layer switcher
- Road data: OpenFreeMap vector tiles (tiles.openfreemap.org); Overpass API
  (overpass-api.de, with fallback mirrors) if they can't be reached
- Elevation: AWS Terrain Tiles (s3.amazonaws.com/elevation-tiles-prod, 10 m
  data in the US, no request limit), read from the tile images in the
  browser; Open-Meteo elevation API (about 90 m) if they can't be loaded
- Place search and boundaries: Nominatim (names first; the boundary is
  downloaded only for the place you pick)

These are free public services with usage policies. A site with heavy traffic
should use its own servers or a paid provider.
