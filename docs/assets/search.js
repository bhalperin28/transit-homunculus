let generatedCities = [];

function haversineKm(a, b) {
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLon = ((b.lon - a.lon) * Math.PI) / 180;
  const lat1 = (a.lat * Math.PI) / 180;
  const lat2 = (b.lat * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Finds an already-generated city near this point, so we can skip regenerating it. */
function findGeneratedNear(lat, lon) {
  return generatedCities.find((c) => haversineKm({ lat, lon }, c) < 3);
}

function loadGeneratedCities() {
  return fetch("./cities.json")
    .then((r) => (r.ok ? r.json() : []))
    .then((cities) => {
      generatedCities = cities;
      const container = document.getElementById("cities");
      if (!cities.length) {
        document.getElementById("empty").style.display = "block";
        return;
      }
      for (const city of cities) {
        const a = document.createElement("a");
        a.className = "city-card";
        a.href = `./${city.slug}/`;
        a.innerHTML = `<div class="name">${city.name}</div>
          <div class="meta">${city.anchorCount} points${city.transitAvailable ? " · transit" : ""}</div>`;
        container.appendChild(a);
      }
    })
    .catch(() => {
      document.getElementById("empty").style.display = "block";
    });
}

/**
 * Best-effort browser geolocation, requested lazily (on first search-box
 * focus, not page load — asking for location before the visitor has shown
 * any intent reads as pushy and gets auto-denied more often). `userLocation`
 * starts null and is read synchronously wherever it's used, so a search
 * fired before it resolves (or after denial/timeout) just runs unbiased —
 * this is only ever used to reorder results, never required.
 */
let userLocation = null;
let locationRequested = false;
function requestUserLocationOnce() {
  if (locationRequested || !navigator.geolocation) return;
  locationRequested = true;
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      userLocation = { lat: pos.coords.latitude, lon: pos.coords.longitude };
      document.getElementById("location-note").style.display = "block";
    },
    () => {},
    { timeout: 6000, maximumAge: 10 * 60 * 1000 }
  );
}

function setupSearch() {
  const input = document.getElementById("city-search");
  const statusEl = document.getElementById("search-status");
  const dropdown = document.getElementById("suggestions");

  let results = [];
  let highlighted = -1;
  let debounceTimer = null;
  let requestSeq = 0;

  input.addEventListener("focus", requestUserLocationOnce, { once: true });

  function closeDropdown() {
    dropdown.classList.remove("open");
    dropdown.innerHTML = "";
    highlighted = -1;
  }

  function renderSuggestions() {
    dropdown.innerHTML = "";
    if (results.length === 0) {
      closeDropdown();
      return;
    }
    results.forEach((r, i) => {
      const el = document.createElement("div");
      el.className = "suggestion" + (i === highlighted ? " highlighted" : "");
      el.setAttribute("role", "option");
      const near = findGeneratedNear(parseFloat(r.lat), parseFloat(r.lon));
      el.innerHTML = `${escapeHtml(r.display_name)}${near ? '<span class="badge">ready</span>' : ""}`;
      el.addEventListener("mousedown", (e) => {
        e.preventDefault();
        selectResult(r);
      });
      dropdown.appendChild(el);
    });
    dropdown.classList.add("open");
  }

  function escapeHtml(s) {
    return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  function selectResult(r) {
    const near = findGeneratedNear(parseFloat(r.lat), parseFloat(r.lon));
    if (near) {
      location.href = `./${near.slug}/`;
      return;
    }
    // Encode the city right into the URL (rather than sessionStorage) so the
    // live-generation page is itself a permalink: shareable, bookmarkable,
    // and reload-safe, not just reachable by clicking through from here.
    const params = new URLSearchParams({
      q: input.value,
      name: r.display_name,
      lat: r.lat,
      lon: r.lon,
      bbox: r.boundingbox.join(","),
    });
    location.href = `./live/index.html?${params.toString()}`;
  }

  input.addEventListener("input", () => {
    const query = input.value.trim();
    clearTimeout(debounceTimer);
    if (query.length < 2) {
      results = [];
      closeDropdown();
      statusEl.textContent = "";
      return;
    }
    statusEl.textContent = "Searching…";
    debounceTimer = setTimeout(async () => {
      const seq = ++requestSeq;
      try {
        const found = await TH.searchCitySuggestions(query, 7, userLocation || undefined);
        if (seq !== requestSeq) return; // stale response
        results = found;
        highlighted = -1;
        statusEl.textContent = found.length ? "" : "No matches — try a different spelling.";
        renderSuggestions();
      } catch (err) {
        if (seq !== requestSeq) return;
        statusEl.textContent = "Search failed: " + err.message;
      }
    }, 350);
  });

  input.addEventListener("keydown", (e) => {
    if (!dropdown.classList.contains("open")) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      highlighted = Math.min(highlighted + 1, results.length - 1);
      renderSuggestions();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      highlighted = Math.max(highlighted - 1, 0);
      renderSuggestions();
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (highlighted >= 0 && results[highlighted]) selectResult(results[highlighted]);
      else if (results[0]) selectResult(results[0]);
    } else if (e.key === "Escape") {
      closeDropdown();
    }
  });

  document.addEventListener("click", (e) => {
    if (!dropdown.contains(e.target) && e.target !== input) closeDropdown();
  });
}

loadGeneratedCities().then(setupSearch);
