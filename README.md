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

**[Open the live site](https://bhalperin28.github.io/transit-homunculus/)** and search any city,
town, or postal code worldwide — it's geocoded and generated live, entirely in your browser, no
server involved. A few cities are also pre-generated and load instantly; search finds those first.

## How the site works

GitHub Pages is static — there's no backend to run a pipeline on. So the *entire* pipeline
(geocode → roads → transit → routing → MDS embedding) runs client-side in a Web Worker:

1. Typing in the search box calls Nominatim's search API directly from the browser
   (`docs/assets/search.js` + `TH.searchCitySuggestions`, both CORS-enabled, no key needed) for
   autocomplete suggestions.
2. Picking a suggestion navigates to `docs/live/index.html?name=...&lat=...&lon=...&bbox=...` —
   the city is encoded right into the URL, so that URL is itself a permalink for this city:
   shareable, bookmarkable, and reload-safe, rather than depending on state left behind by the
   click that got you there. That page spins up a Web Worker
   (`docs/assets/vendor/generate-worker.js`) running the same pipeline code as the CLI, fetching
   roads/transit/water from Overpass and computing the travel-time matrices and MDS embedding off
   the main thread so the page stays responsive. A progress panel shows each stage as it runs —
   this can take anywhere from ~10 seconds (a small town) to a couple of minutes (a large metro).
3. The result renders with the same `renderCityDataset()` viewer code used by the pre-generated
   static pages.

Nothing computed this way is saved anywhere — visiting a live permalink regenerates that city
fresh every time (a browser-side in-memory cache avoids redundant Overpass calls within one run,
nothing more). The two pre-generated demo cities in `docs/` were built with the Node CLI (below)
and committed as permanent, instant-loading pages; anything else you search for is generated on
the spot. If a search result is already one of the committed pages, the search box detects that
(by proximity, not name-matching) and jumps straight to that page's own permalink instead of
regenerating it.

### Pipeline stages

Both the in-browser worker and the Node CLI run the same six stages
(`src/pipeline/orchestrate.ts`), producing a JSON dataset that the viewer morphs between with a
slider:

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
for the map. `renderCityDataset()` is the shared entry point both the static per-city pages and
the live-generation page render through.

Overpass fetching is the one piece that differs by environment (`OverpassQueryFn`, injected into
`hexgrid.ts`/`network.ts`/`transit.ts`): `src/pipeline/overpass.ts` disk-caches to `data/cache/`
under Node, `src/pipeline/overpass-browser.ts` uses an in-memory cache in the browser. Everything
else is the same code running in both places.

## Generating a permanent page with the CLI

Prefer more control — a larger anchor count, a custom radius, or a page that loads instantly
without regenerating? The same pipeline also runs as a Node CLI that writes a permanent static
page into `docs/`:

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
so the landing page picks it up automatically (including for the live search's proximity match).

Transit mode is included automatically when OSM has route relations mapped for the area; if not,
the pipeline says so and the viewer just disables that mode button rather than failing.

### Rebuilding the browser bundles

If you change anything under `src/pipeline/` or `src/browser/`, rebuild the bundles GitHub Pages
actually serves (esbuild, committed to `docs/assets/vendor/` since Pages has no build step):

```sh
npm run build:browser
```

This produces `generate-worker.js` (the Web Worker running the pipeline) and `generate-lib.js`
(the main-thread `window.TH` API: `searchCitySuggestions`, `nominatimResultToCityArea`,
`generateCityDataset`) — both dependency-free bundles with no Node built-ins.

## Known simplifications

- **Rush-hour congestion** is a modeled multiplier by road class, not live traffic. Real traffic
  data (e.g. TomTom) could be wired in as an alternative source in `network.ts` if you have an
  API key.
- **Transit wait time** is `headway / 2` per mode, not a real timetable — OSM route relations
  don't carry schedules. This is a stylized approximation, in the same spirit as the modeled
  congestion profile.
- **Anchor count and radius are capped** for pipeline runtime. A very large metro area will need
  a longer `--radius`/`--anchors` run, or a lower target if Overpass queries start timing out.
- **The live in-browser flow uses a fixed, lighter anchor target** (130, vs. the CLI's default
  160) to keep in-browser generation time reasonable on an average connection. Use the CLI for a
  denser, permanent page.
- **Live generations aren't persisted.** Searching for a city that isn't already a committed page
  regenerates it from scratch every time (nothing is written back to the repo from the browser —
  there's no server to write to). Committing it permanently requires running the CLI.
