# transit-homunculus

A time-space cartogram generator **for any city** — redraws a city's streets so that the
distance between two points reflects how long it takes to travel between them, not how far
apart they physically sit.

Inspired by [mattkindy/seattle-map](https://mattkindy.github.io/seattle-map/), which built this
for Seattle specifically, hardcoded to one metro's roads, a paid TomTom traffic subscription,
and King County Metro / Sound Transit's GTFS feeds. This project generalizes the same idea to
run for **any city on Earth** with no city-specific configuration and no paid API keys:

- **Geocoding**: any city name → OpenStreetMap Nominatim.
- **Roads & water**: OpenStreetMap via the Overpass API.
- **Rush-hour congestion**: a modeled slowdown profile by road class (the same "modeled profile"
  fallback the original project used when a live traffic feed isn't available) — motorways and
  arterials see the largest relative slowdown, residential streets the least.
- **Transit**: OpenStreetMap's own public-transport route relations (bus/tram/subway/train/ferry),
  not a GTFS feed. GTFS feed URLs are different per city and per agency, which would defeat "any
  city" — OSM route relations exist worldwide under one schema. Since OSM has no timetables, wait
  time is approximated as half the mode's typical headway.

Live demo cities are in [`docs/`](./docs) — open `docs/index.html` to pick one, or generate your
own (see below).

## How it works

Six pipeline stages, run for a chosen city, produce a static JSON dataset that the viewer
morphs between with a slider:

1. **`geocode.ts`** — resolve the city name to a center point and an analysis radius (from the
   place's own OSM bounding box, capped at 9km so the pipeline stays tractable for large metros).
2. **`hexgrid.ts`** — lay a hexagonally-packed grid of anchor points over that area, then drop
   any that land in water (lakes, bays, rivers) using OSM water polygons.
3. **`network.ts`** — fetch the drivable road network from Overpass and build a routable graph,
   with free-flow and modeled rush-hour edge weights.
4. **`transit.ts`** — fetch OSM public-transport route relations and build a second graph:
   ride edges between consecutive stops, plus walking edges (anchor↔stop and stop↔stop transfers)
   that carry the average-headway wait.
5. **`matrix.ts`** — run Dijkstra from every anchor to every other anchor, per mode, to build an
   anchor × anchor travel-time matrix. A handful of "sample trips" between geographically extreme
   anchors get full route geometry (both the fastest route and, for driving, the shortest-distance
   route) for the trip list in the viewer.
6. **`embed.ts`** — embed each travel-time matrix into 2D with SMACOF stress-majorization MDS,
   starting from the real geographic layout so the result stays a recognizable, minimally-rotated
   deformation rather than an arbitrary embedding. Per-anchor embedding error is kept for the
   "x-ray" view.

The viewer (`docs/assets/viewer.js`, MapLibre GL) interpolates each anchor between its real
position and its time-embedded position as you drag the slider, and reprojects it into lat/lon
for the map.

## Usage

```sh
npm install
npm run pipeline -- --city "Portland, Oregon"
```

Flags:

- `--city` (required) — free-text place name, passed to Nominatim (e.g. `"Ann Arbor, Michigan"`,
  `"Bristol, UK"`).
- `--radius` — analysis radius in meters, overriding the geocoded bounding box.
- `--anchors` — target anchor count (default 160). Runtime scales roughly with
  `anchors × road graph size`, so larger cities or higher anchor counts take longer.

Output goes to `docs/<city-slug>/` (data + a small HTML shell) and `docs/cities.json` is updated
so the landing page picks it up automatically. Open `docs/index.html` in a browser, or
`docs/<city-slug>/index.html` directly.

Transit mode is included automatically when OSM has route relations mapped for the area; if not,
the pipeline says so and the viewer just disables that mode button rather than failing.

## Known simplifications

- **Rush-hour congestion** is a modeled multiplier by road class, not live traffic. Real traffic
  data (e.g. TomTom) could be wired in as an alternative source in `network.ts` if you have an
  API key.
- **Transit wait time** is `headway / 2` per mode, not a real timetable — OSM route relations
  don't carry schedules. This is a stylized approximation, in the same spirit as the modeled
  congestion profile.
- **Anchor count and radius are capped** for pipeline runtime. A very large metro area will need
  a longer `--radius`/`--anchors` run, or a lower target if Overpass queries start timing out.
