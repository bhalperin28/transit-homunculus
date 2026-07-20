const EARTH_RADIUS_M = 6371000;

function makeProjection(origin) {
  const lat0 = (origin.lat * Math.PI) / 180;
  const cosLat0 = Math.cos(lat0);
  return {
    toLatLon(xy) {
      const dLat = xy.y / EARTH_RADIUS_M;
      const dLon = xy.x / (EARTH_RADIUS_M * cosLat0);
      return {
        lat: origin.lat + (dLat * 180) / Math.PI,
        lon: origin.lon + (dLon * 180) / Math.PI,
      };
    },
  };
}

const MODE_LABELS = {
  freeflow: "Free-flow driving",
  rushhour: "Rush-hour driving",
  transit: "Transit",
};

function formatDuration(seconds) {
  if (seconds < 0 || !isFinite(seconds)) return "—";
  const mins = Math.round(seconds / 60);
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `${h}h ${m}m`;
}

async function main() {
  const dataUrl = new URLSearchParams(location.search).get("data") || "./data.json";
  const res = await fetch(dataUrl);
  const dataset = await res.json();

  const projection = makeProjection({ lat: dataset.city.lat, lon: dataset.city.lon });
  const anchors = dataset.anchors;
  const modesByName = Object.fromEntries(dataset.modes.map((m) => [m.mode, m]));
  const availableModes = dataset.modes.map((m) => m.mode);

  const state = {
    mode: availableModes.includes("freeflow") ? "freeflow" : availableModes[0],
    t: 0,
    xray: false,
    selectedTrip: null,
  };

  document.getElementById("city-name").textContent = dataset.city.name;
  document.getElementById("anchor-count").textContent = dataset.meta.anchorCount;
  document.getElementById("generated-at").textContent = new Date(
    dataset.generatedAt
  ).toLocaleDateString();

  const map = new maplibregl.Map({
    container: "map",
    style: {
      version: 8,
      sources: {
        basemap: {
          type: "raster",
          tiles: [
            "https://a.basemaps.cartocdn.com/light_all/{z}/{x}/{y}@2x.png",
            "https://b.basemaps.cartocdn.com/light_all/{z}/{x}/{y}@2x.png",
            "https://c.basemaps.cartocdn.com/light_all/{z}/{x}/{y}@2x.png",
          ],
          tileSize: 256,
          attribution:
            '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors © <a href="https://carto.com/attributions">CARTO</a>',
        },
      },
      layers: [{ id: "basemap", type: "raster", source: "basemap" }],
    },
    center: [dataset.city.lon, dataset.city.lat],
    zoom: 11,
  });
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "bottom-right");

  map.on("style.load", () => {
    map.addSource("anchors", { type: "geojson", data: emptyFC() });
    map.addLayer({
      id: "anchors-layer",
      type: "circle",
      source: "anchors",
      paint: {
        "circle-radius": ["get", "r"],
        "circle-color": "#c8532a",
        "circle-opacity": 0.75,
        "circle-stroke-width": 1,
        "circle-stroke-color": "#7a2e12",
      },
    });

    map.addSource("route-shortest", { type: "geojson", data: emptyFC() });
    map.addSource("route-fastest", { type: "geojson", data: emptyFC() });
    map.addLayer({
      id: "route-shortest-layer",
      type: "line",
      source: "route-shortest",
      paint: { "line-color": "#2a6f97", "line-width": 3, "line-dasharray": [2, 1.5] },
    });
    map.addLayer({
      id: "route-fastest-layer",
      type: "line",
      source: "route-fastest",
      paint: { "line-color": "#2a6f97", "line-width": 3 },
    });

    render();
  });

  function currentModeResult() {
    return modesByName[state.mode];
  }

  function render() {
    const modeResult = currentModeResult();
    updateAnchors(modeResult);
    updateTripList(modeResult);
    updateRoutes(modeResult);
    updateModeButtons();
  }

  function updateAnchors(modeResult) {
    const features = anchors.map((a, i) => {
      const geo = { x: a.x, y: a.y };
      const emb = modeResult.embedding[i];
      const x = geo.x + state.t * (emb.x - geo.x);
      const y = geo.y + state.t * (emb.y - geo.y);
      const latLon = projection.toLatLon({ x, y });
      const stress = modeResult.stress[i] || 0;
      const r = state.xray ? 3 + Math.min(stress * 40, 16) : 3.5;
      return {
        type: "Feature",
        geometry: { type: "Point", coordinates: [latLon.lon, latLon.lat] },
        properties: { r },
      };
    });
    map.getSource("anchors")?.setData({ type: "FeatureCollection", features });
  }

  function updateModeButtons() {
    document.querySelectorAll(".mode-buttons button").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.mode === state.mode);
    });
  }

  function updateTripList(modeResult) {
    const list = document.getElementById("trip-list");
    list.innerHTML = "";
    modeResult.sampleTrips.forEach((trip) => {
      const li = document.createElement("li");
      li.className = trip.id === state.selectedTrip ? "active" : "";
      const fromName = `#${trip.fromAnchor}`;
      const toName = `#${trip.toAnchor}`;
      li.innerHTML = `<div class="trip-label">${trip.label}</div>
        <div class="trip-times">fastest ${formatDuration(trip.fastestSeconds)} · shortest ${formatDuration(
        trip.shortestSeconds
      )}</div>`;
      li.addEventListener("click", () => {
        state.selectedTrip = state.selectedTrip === trip.id ? null : trip.id;
        render();
      });
      list.appendChild(li);
    });
  }

  function updateRoutes(modeResult) {
    const trip = modeResult.sampleTrips.find((t) => t.id === state.selectedTrip);
    if (!trip) {
      map.getSource("route-fastest")?.setData(emptyFC());
      map.getSource("route-shortest")?.setData(emptyFC());
      return;
    }
    map.getSource("route-fastest")?.setData(lineFC(trip.fastest));
    const showDashed = trip.mode !== "transit";
    map.getSource("route-shortest")?.setData(showDashed ? lineFC(trip.shortest) : emptyFC());
  }

  function lineFC(points) {
    return {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          geometry: { type: "LineString", coordinates: points.map((p) => [p.lon, p.lat]) },
          properties: {},
        },
      ],
    };
  }

  function emptyFC() {
    return { type: "FeatureCollection", features: [] };
  }

  // --- controls ---
  const modeButtonsEl = document.getElementById("mode-buttons");
  Object.keys(MODE_LABELS).forEach((mode) => {
    const btn = document.createElement("button");
    btn.textContent = MODE_LABELS[mode];
    btn.dataset.mode = mode;
    const available = availableModes.includes(mode);
    btn.disabled = !available;
    if (!available) btn.title = "No transit data found for this city";
    btn.addEventListener("click", () => {
      if (!available) return;
      state.mode = mode;
      state.selectedTrip = null;
      render();
    });
    modeButtonsEl.appendChild(btn);
  });

  const slider = document.getElementById("slider");
  slider.addEventListener("input", (e) => {
    state.t = parseFloat(e.target.value);
    document.getElementById("slider-value").textContent = `${Math.round(state.t * 100)}%`;
    render();
  });

  const xrayToggle = document.getElementById("xray-toggle");
  xrayToggle.addEventListener("change", (e) => {
    state.xray = e.target.checked;
    render();
  });
}

main().catch((err) => {
  console.error(err);
  const panel = document.querySelector(".panel");
  if (panel) {
    const errEl = document.createElement("p");
    errEl.style.color = "#b3261e";
    errEl.textContent = "Couldn't load this city's data: " + err.message;
    panel.appendChild(errEl);
  }
});
