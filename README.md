# Interval Route Finder

A static web app for planning routes on real roads. Choose a start point and a
maximum distance, or draw an area (a circle or an ellipse). The app then
downloads the road network inside that area from OpenStreetMap and builds a
routing graph from it.

## Running

No build step is needed. Open `index.html` in a browser, or serve the folder:

```sh
python3 -m http.server 8000   # then visit http://localhost:8000
```

## Layout

```
index.html        Page markup
css/style.css     All styles (light/dark themes, mobile bottom sheet)
js/config.js      Settings: road types, servers, defaults, colors
js/geometry.js    Distance math and search regions (circle, ellipse)
js/overpass.js    Downloads roads from the Overpass API (with cache + fallback)
js/network.js     Turns OSM ways into a routing graph
js/map.js         Leaflet map, icons, drawing of shapes and the network
js/app.js         App state, panel UI, map interaction, search, toasts
```

The scripts are plain (non-module) files loaded in order, so the site also
works when opened straight from disk.

## Routing graph

`buildRoadNetwork()` returns:

- `nodes`: `Map` of OSM node id → `{ id, lat, lng }`. Only intersections and
  dead ends are kept.
- `edges`: `[{ from, to, distance (m), coords, highway, name, oneway, wayId }]`.
  Edges are undirected, and `coords` holds the full road geometry.
- `adjacency`: `Map` of node id → indexes into `edges`.
- `stats`: counts and total road miles.

After a load, the most recent network is available as `state.network`, and it
is also logged to the console.

## External services

- Map tiles: Esri World Street Map by default; CyclOSM and OSM France in the layer switcher (`js/config.js`)
- Road data: Overpass API (overpass-api.de, with a fallback mirror)
- Place search: Nominatim

These are free public services with usage policies. A site with heavy traffic
should use its own servers or a paid provider.
