"use strict";
var TH = (() => {
  var __defProp = Object.defineProperty;
  var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __hasOwnProp = Object.prototype.hasOwnProperty;
  var __export = (target, all) => {
    for (var name in all)
      __defProp(target, name, { get: all[name], enumerable: true });
  };
  var __copyProps = (to, from, except, desc) => {
    if (from && typeof from === "object" || typeof from === "function") {
      for (let key of __getOwnPropNames(from))
        if (!__hasOwnProp.call(to, key) && key !== except)
          __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
    }
    return to;
  };
  var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

  // src/browser/lib.ts
  var lib_exports = {};
  __export(lib_exports, {
    generateCityDataset: () => generateCityDataset,
    nominatimResultToCityArea: () => nominatimResultToCityArea,
    searchCitySuggestions: () => searchCitySuggestions
  });

  // src/pipeline/geo.ts
  var EARTH_RADIUS_M = 6371e3;
  function bboxAround(center, radiusMeters) {
    const latDelta = radiusMeters / EARTH_RADIUS_M * (180 / Math.PI);
    const lonDelta = radiusMeters / (EARTH_RADIUS_M * Math.cos(center.lat * Math.PI / 180)) * (180 / Math.PI);
    return {
      south: center.lat - latDelta,
      north: center.lat + latDelta,
      west: center.lon - lonDelta,
      east: center.lon + lonDelta
    };
  }
  var DIACRITICS_RE = new RegExp("[\\u0300-\\u036f]", "g");
  function slugify(name) {
    return name.toLowerCase().normalize("NFKD").replace(DIACRITICS_RE, "").replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
  }

  // src/pipeline/geocode.ts
  var NOMINATIM_URL = "https://nominatim.openstreetmap.org/search";
  var USER_AGENT = "transit-homunculus/1.0 (city travel-time cartogram generator)";
  var isBrowser = typeof window !== "undefined";
  function nominatimHeaders() {
    return isBrowser ? { Accept: "application/json" } : { "User-Agent": USER_AGENT, Accept: "application/json" };
  }
  async function searchCitySuggestions(query, limit = 6, bias) {
    if (query.trim().length < 2) return [];
    const url = new URL(NOMINATIM_URL);
    url.searchParams.set("q", query);
    url.searchParams.set("format", "jsonv2");
    url.searchParams.set("limit", String(limit));
    url.searchParams.set("addressdetails", "0");
    if (bias) {
      const box = bboxAround({ lat: bias.lat, lon: bias.lon }, (bias.radiusKm ?? 400) * 1e3);
      url.searchParams.set("viewbox", `${box.west},${box.north},${box.east},${box.south}`);
      url.searchParams.set("bounded", "0");
    }
    const res = await fetch(url, { headers: nominatimHeaders() });
    if (!res.ok) return [];
    return await res.json();
  }
  function nominatimResultToCityArea(r, slugSource, opts = {}) {
    const lat = parseFloat(r.lat);
    const lon = parseFloat(r.lon);
    const [south, north, west, east] = r.boundingbox.map(parseFloat);
    const maxRadius = opts.maxRadiusMeters ?? 9e3;
    let radiusMeters = opts.radiusMeters ?? boundingBoxRadiusMeters(south, north, west, east, lat);
    radiusMeters = Math.min(Math.max(radiusMeters, 2e3), maxRadius);
    const name = r.display_name.split(",").slice(0, 2).join(",").trim() || r.display_name;
    return { name, slug: slugify(slugSource), lat, lon, radiusMeters };
  }
  function boundingBoxRadiusMeters(south, north, west, east, lat) {
    const EARTH_RADIUS_M2 = 6371e3;
    const latSpanM = (north - south) * Math.PI * EARTH_RADIUS_M2 / 180;
    const lonSpanM = (east - west) * Math.PI * EARTH_RADIUS_M2 * Math.cos(lat * Math.PI / 180) / 180;
    return Math.max(latSpanM, lonSpanM) / 2;
  }

  // src/browser/lib.ts
  function generateCityDataset(city, options = {}) {
    const workerUrl = options.workerUrl ?? "./generate-worker.js";
    return new Promise((resolve, reject) => {
      const worker = new Worker(workerUrl);
      worker.onmessage = (e) => {
        const msg = e.data;
        if (msg.type === "progress") {
          options.onProgress?.(msg.stage, msg.detail);
        } else if (msg.type === "done") {
          worker.terminate();
          resolve(msg.dataset);
        } else if (msg.type === "error") {
          worker.terminate();
          reject(new Error(msg.message));
        }
      };
      worker.onerror = (e) => {
        worker.terminate();
        reject(new Error(e.message || "Worker failed"));
      };
      worker.postMessage({ type: "generate", city, anchorTarget: options.anchorTarget });
    });
  }
  return __toCommonJS(lib_exports);
})();
