const STAGE_LABELS = {
  grid: "Laying out sample points",
  roads: "Fetching road network",
  driving: "Computing driving travel times",
  transit: "Fetching transit routes",
  "transit-matrix": "Computing transit travel times",
  done: "Done",
};

function logStage(stage, detail) {
  const log = document.getElementById("progress-log");
  const label = STAGE_LABELS[stage] || stage;
  const line = document.createElement("div");
  line.className = "progress-line";
  line.textContent = detail && detail !== label ? `${label} — ${detail}` : label;
  log.appendChild(line);
  log.scrollTop = log.scrollHeight;
}

async function runLive() {
  const raw = sessionStorage.getItem("th:pendingCity");
  if (!raw) {
    document.getElementById("city-name").textContent = "No city selected";
    document.getElementById("progress-log").innerHTML =
      '<div class="progress-line">Go back and search for a city to generate.</div>';
    return;
  }
  sessionStorage.removeItem("th:pendingCity");
  const { result, query } = JSON.parse(raw);
  const city = TH.nominatimResultToCityArea(result, query);

  document.getElementById("city-name").textContent = city.name;
  document.title = `${city.name} — Travel-Time Map`;

  try {
    const dataset = await TH.generateCityDataset(city, {
      anchorTarget: 130,
      workerUrl: "../assets/vendor/generate-worker.js",
      onProgress: (stage, detail) => logStage(stage, detail),
    });

    document.getElementById("progress-section").style.display = "none";
    document.getElementById("mode-section").style.display = "";
    document.getElementById("slider-section").style.display = "";
    document.getElementById("xray-section").style.display = "";
    document.getElementById("trips-section").style.display = "";
    document.getElementById("generated-at-wrap").style.display = "";

    renderCityDataset(dataset);
  } catch (err) {
    console.error(err);
    logStage("error", "Failed: " + err.message);
  }
}

runLive();
