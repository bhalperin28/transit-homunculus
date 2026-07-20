import { mkdir, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import type { CityDataset } from "./types.js";

const DOCS_DIR = path.join(process.cwd(), "docs");

function renderCityHtml(city: CityDataset["city"]): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<link rel="icon" href="data:," />
<title>${escapeHtml(city.name)} — Travel-Time Map</title>
<link rel="stylesheet" href="../assets/vendor/maplibre-gl.css" />
<link rel="stylesheet" href="../assets/viewer.css" />
</head>
<body>
<div id="map"></div>
<div class="panel">
  <div class="panel-top">
    <a class="home-link" href="../index.html">&larr; All cities</a>
    <button type="button" id="panel-toggle" class="panel-toggle" aria-expanded="true" aria-label="Collapse panel">
      <span class="panel-toggle-icon">&#9662;</span>
    </button>
  </div>
  <h1 id="city-name">${escapeHtml(city.name)}</h1>
  <div class="panel-body">
    <p class="subtitle">A time-space cartogram: streets redrawn so that distance reflects travel time, not physical geography. <span id="anchor-count"></span> sample points, generated <span id="generated-at"></span>.</p>

    <div class="section">
      <p class="section-label">Mode</p>
      <div class="mode-buttons" id="mode-buttons"></div>
    </div>

    <div class="section">
      <p class="section-label">Geography ↔ Travel time</p>
      <div class="slider-row">
        <input type="range" id="slider" min="0" max="1" step="0.01" value="0" />
        <span id="slider-value">0%</span>
      </div>
      <div class="slider-labels"><span>Real geography</span><span>Pure travel time</span></div>
    </div>

    <div class="section">
      <label class="xray-toggle">
        <input type="checkbox" id="xray-toggle" />
        X-ray: show embedding distortion (dot size = error)
      </label>
    </div>

    <div class="section">
      <p class="section-label">Sample trips</p>
      <ul class="trip-list" id="trip-list"></ul>
      <p class="legend">
        <span class="swatch"></span>fastest route &nbsp;
        <span class="swatch dashed"></span>shortest route
      </p>
    </div>

    <p class="footer-note">
      Roads, transit routes, and water from OpenStreetMap. Rush-hour congestion is a modeled
      profile (no live traffic feed). Transit uses OSM public-transport route relations with
      an average-headway wait model, not a live timetable. Basemap © CARTO.
      Inspired by <a href="https://mattkindy.github.io/seattle-map/" target="_blank" rel="noopener">mattkindy/seattle-map</a>.
    </p>
  </div>
</div>
<script src="../assets/vendor/maplibre-gl.js"></script>
<script src="../assets/viewer.js"></script>
</body>
</html>
`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}

export async function writeCitySite(dataset: CityDataset): Promise<string> {
  const cityDir = path.join(DOCS_DIR, dataset.city.slug);
  await mkdir(cityDir, { recursive: true });
  await writeFile(path.join(cityDir, "data.json"), JSON.stringify(dataset));
  await writeFile(path.join(cityDir, "index.html"), renderCityHtml(dataset.city));
  return cityDir;
}

export interface CityIndexEntry {
  name: string;
  slug: string;
  lat: number;
  lon: number;
  anchorCount: number;
  transitAvailable: boolean;
  generatedAt: string;
}

export async function updateLandingPage(entry: CityIndexEntry): Promise<void> {
  const manifestPath = path.join(DOCS_DIR, "cities.json");
  let manifest: CityIndexEntry[] = [];
  try {
    manifest = JSON.parse(await readFile(manifestPath, "utf-8"));
  } catch {
    manifest = [];
  }
  manifest = manifest.filter((c) => c.slug !== entry.slug);
  manifest.push(entry);
  manifest.sort((a, b) => a.name.localeCompare(b.name));
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
}
