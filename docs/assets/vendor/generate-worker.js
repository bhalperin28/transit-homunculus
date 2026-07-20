"use strict";
(() => {
  var __defProp = Object.defineProperty;
  var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
  var __publicField = (obj, key, value) => __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);

  // src/pipeline/overpass-fetch.ts
  var OVERPASS_ENDPOINTS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter"
  ];
  var isBrowser = typeof window !== "undefined";
  async function fetchOverpassRaw(query) {
    let lastError;
    for (const endpoint of OVERPASS_ENDPOINTS) {
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const res = await fetch(endpoint, {
            method: "POST",
            headers: {
              "Content-Type": "text/plain",
              Accept: "*/*",
              ...isBrowser ? {} : { "User-Agent": "transit-homunculus/1.0 (city travel-time cartogram generator)" }
            },
            body: query
          });
          if (res.status === 429 || res.status === 504) {
            await sleep(2e3 * (attempt + 1));
            continue;
          }
          if (!res.ok) {
            throw new Error(`Overpass HTTP ${res.status}: ${await res.text().catch(() => "")}`);
          }
          return await res.json();
        } catch (err) {
          lastError = err;
          await sleep(1500 * (attempt + 1));
        }
      }
    }
    throw new Error(`Overpass query failed after retries: ${String(lastError)}`);
  }
  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // src/pipeline/overpass-browser.ts
  function createMemoryCachedOverpassQuery() {
    const cache = /* @__PURE__ */ new Map();
    return (query, cacheKey) => {
      const existing = cache.get(cacheKey);
      if (existing) return existing;
      const promise = fetchOverpassRaw(query);
      cache.set(cacheKey, promise);
      return promise;
    };
  }

  // src/pipeline/geo.ts
  var EARTH_RADIUS_M = 6371e3;
  function makeProjection(origin) {
    const lat0 = origin.lat * Math.PI / 180;
    const cosLat0 = Math.cos(lat0);
    return {
      toXY(p) {
        const dLat = (p.lat - origin.lat) * Math.PI / 180;
        const dLon = (p.lon - origin.lon) * Math.PI / 180;
        return {
          x: dLon * cosLat0 * EARTH_RADIUS_M,
          y: dLat * EARTH_RADIUS_M
        };
      },
      toLatLon(xy) {
        const dLat = xy.y / EARTH_RADIUS_M;
        const dLon = xy.x / (EARTH_RADIUS_M * cosLat0);
        return {
          lat: origin.lat + dLat * 180 / Math.PI,
          lon: origin.lon + dLon * 180 / Math.PI
        };
      }
    };
  }
  function haversineMeters(a, b) {
    const lat1 = a.lat * Math.PI / 180;
    const lat2 = b.lat * Math.PI / 180;
    const dLat = lat2 - lat1;
    const dLon = (b.lon - a.lon) * Math.PI / 180;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
    return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
  }
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
  function pointInPolygon(point, ring) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const xi = ring[i].lon, yi = ring[i].lat;
      const xj = ring[j].lon, yj = ring[j].lat;
      const intersect = yi > point.lat !== yj > point.lat && point.lon < (xj - xi) * (point.lat - yi) / (yj - yi) + xi;
      if (intersect) inside = !inside;
    }
    return inside;
  }
  var DIACRITICS_RE = new RegExp("[\\u0300-\\u036f]", "g");

  // src/pipeline/hexgrid.ts
  function generateHexGrid(city, targetCount = 160) {
    const projection = makeProjection({ lat: city.lat, lon: city.lon });
    const area = Math.PI * city.radiusMeters ** 2;
    const spacing = Math.sqrt(Math.sqrt(3) / 2 * area / targetCount);
    const rowHeight = spacing * (Math.sqrt(3) / 2);
    const anchors = [];
    let id = 0;
    const rows = Math.ceil(city.radiusMeters / rowHeight) + 1;
    for (let row = -rows; row <= rows; row++) {
      const y = row * rowHeight;
      const xOffset = row % 2 === 0 ? 0 : spacing / 2;
      const maxX = Math.sqrt(Math.max(0, city.radiusMeters ** 2 - y * y));
      const startCol = Math.ceil((-maxX - xOffset) / spacing);
      const endCol = Math.floor((maxX - xOffset) / spacing);
      for (let col = startCol; col <= endCol; col++) {
        const x = col * spacing + xOffset;
        if (x * x + y * y > city.radiusMeters ** 2) continue;
        const latLon = projection.toLatLon({ x, y });
        anchors.push({ id: id++, lat: latLon.lat, lon: latLon.lon, x, y });
      }
    }
    return anchors;
  }
  async function removeWaterAnchors(city, anchors, queryFn) {
    const bbox = bboxAround({ lat: city.lat, lon: city.lon }, city.radiusMeters * 1.05);
    const query = `
    [out:json][timeout:90];
    (
      way["natural"="water"](${bbox.south},${bbox.west},${bbox.north},${bbox.east});
      way["waterway"="riverbank"](${bbox.south},${bbox.west},${bbox.north},${bbox.east});
      relation["natural"="water"](${bbox.south},${bbox.west},${bbox.north},${bbox.east});
    );
    out body;
    >;
    out skel qt;
  `;
    let data;
    try {
      data = await queryFn(query, `water-${city.slug}`);
    } catch {
      return anchors;
    }
    const nodeCoords = /* @__PURE__ */ new Map();
    const ways = /* @__PURE__ */ new Map();
    for (const el of data.elements) {
      if (el.type === "node") nodeCoords.set(el.id, { lat: el.lat, lon: el.lon });
      else if (el.type === "way") ways.set(el.id, el.nodes);
    }
    const polygons = [];
    for (const nodeIds of ways.values()) {
      const ring = nodeIds.map((id) => nodeCoords.get(id)).filter(Boolean);
      if (ring.length >= 3) polygons.push(ring);
    }
    if (polygons.length === 0) return anchors;
    return anchors.filter((a) => !polygons.some((ring) => pointInPolygon(a, ring)));
  }

  // src/pipeline/network.ts
  var DRIVABLE_HIGHWAYS = [
    "motorway",
    "trunk",
    "primary",
    "secondary",
    "tertiary",
    "unclassified",
    "residential",
    "motorway_link",
    "trunk_link",
    "primary_link",
    "secondary_link",
    "tertiary_link",
    "living_street"
  ];
  var DEFAULT_FREEFLOW_KMH = {
    motorway: 105,
    trunk: 90,
    primary: 70,
    secondary: 55,
    tertiary: 45,
    unclassified: 40,
    residential: 40,
    living_street: 15,
    motorway_link: 55,
    trunk_link: 50,
    primary_link: 40,
    secondary_link: 35,
    tertiary_link: 30
  };
  var RUSH_HOUR_MULTIPLIER = {
    motorway: 2,
    trunk: 1.85,
    primary: 1.55,
    secondary: 1.4,
    tertiary: 1.25,
    unclassified: 1.15,
    residential: 1.1,
    living_street: 1.05,
    motorway_link: 1.9,
    trunk_link: 1.75,
    primary_link: 1.5,
    secondary_link: 1.35,
    tertiary_link: 1.2
  };
  function parseMaxspeedKmh(tag, highway) {
    const fallback = DEFAULT_FREEFLOW_KMH[highway] ?? 40;
    if (!tag) return fallback;
    const mph = tag.match(/(\d+)\s*mph/i);
    if (mph) return parseInt(mph[1], 10) * 1.60934;
    const kmh = tag.match(/(\d+)\s*(km\/h)?/i);
    if (kmh && kmh[1]) return parseInt(kmh[1], 10);
    return fallback;
  }
  async function fetchRoadGraph(city, queryFn) {
    const bbox = bboxAround({ lat: city.lat, lon: city.lon }, city.radiusMeters);
    const highwayFilter = DRIVABLE_HIGHWAYS.join("|");
    const query = `
    [out:json][timeout:120];
    (
      way["highway"~"^(${highwayFilter})$"]["area"!~"yes"]["access"!~"^(private|no)$"]
        (${bbox.south},${bbox.west},${bbox.north},${bbox.east});
    );
    out body;
    >;
    out skel qt;
  `;
    const data = await queryFn(query, `roads-${city.slug}`);
    const nodes = /* @__PURE__ */ new Map();
    const ways = [];
    for (const el of data.elements) {
      if (el.type === "node") {
        nodes.set(el.id, { id: el.id, lat: el.lat, lon: el.lon });
      } else if (el.type === "way" && el.tags?.highway) {
        ways.push({
          nodeIds: el.nodes,
          highway: el.tags.highway,
          maxspeed: el.tags.maxspeed,
          oneway: el.tags.oneway
        });
      }
    }
    const edges = [];
    const adjacency = /* @__PURE__ */ new Map();
    const addEdge = (from, to, length, highway, kmh) => {
      const freeflowSeconds = length / (kmh * 1e3 / 3600);
      const multiplier = RUSH_HOUR_MULTIPLIER[highway] ?? 1.15;
      const idx = edges.length;
      edges.push({
        from,
        to,
        length,
        freeflowSeconds,
        rushhourSeconds: freeflowSeconds * multiplier,
        highway,
        kind: "road"
      });
      if (!adjacency.has(from)) adjacency.set(from, []);
      adjacency.get(from).push(idx);
    };
    for (const way of ways) {
      const kmh = parseMaxspeedKmh(way.maxspeed, way.highway);
      const forward = way.oneway !== "-1";
      const backward = way.oneway !== "yes" && way.oneway !== "true" && way.oneway !== "1";
      for (let i = 0; i < way.nodeIds.length - 1; i++) {
        const a = nodes.get(way.nodeIds[i]);
        const b = nodes.get(way.nodeIds[i + 1]);
        if (!a || !b) continue;
        const length = haversineMeters(a, b);
        if (length === 0) continue;
        if (forward) addEdge(a.id, b.id, length, way.highway, kmh);
        if (backward) addEdge(b.id, a.id, length, way.highway, kmh);
      }
    }
    const usedNodeIds = /* @__PURE__ */ new Set();
    for (const e of edges) {
      usedNodeIds.add(e.from);
      usedNodeIds.add(e.to);
    }
    for (const id of nodes.keys()) {
      if (!usedNodeIds.has(id)) nodes.delete(id);
    }
    return { nodes, edges, adjacency };
  }

  // src/pipeline/graph.ts
  var MinHeap = class {
    constructor() {
      __publicField(this, "items", []);
    }
    push(item) {
      this.items.push(item);
      let i = this.items.length - 1;
      while (i > 0) {
        const parent = i - 1 >> 1;
        if (this.items[parent].dist <= this.items[i].dist) break;
        [this.items[parent], this.items[i]] = [this.items[i], this.items[parent]];
        i = parent;
      }
    }
    pop() {
      if (this.items.length === 0) return void 0;
      const top = this.items[0];
      const last = this.items.pop();
      if (this.items.length > 0) {
        this.items[0] = last;
        let i = 0;
        const n = this.items.length;
        for (; ; ) {
          const l = 2 * i + 1;
          const r = 2 * i + 2;
          let smallest = i;
          if (l < n && this.items[l].dist < this.items[smallest].dist) smallest = l;
          if (r < n && this.items[r].dist < this.items[smallest].dist) smallest = r;
          if (smallest === i) break;
          [this.items[smallest], this.items[i]] = [this.items[i], this.items[smallest]];
          i = smallest;
        }
      }
      return top;
    }
    get size() {
      return this.items.length;
    }
  };
  var modeWeight = {
    freeflow: (e) => e.freeflowSeconds,
    rushhour: (e) => e.rushhourSeconds,
    transit: (e) => e.freeflowSeconds
  };
  var lengthWeight = (e) => e.length;
  function dijkstra(graph, source, weightFn, targets) {
    const dist = /* @__PURE__ */ new Map();
    const prev = /* @__PURE__ */ new Map();
    const prevEdge = /* @__PURE__ */ new Map();
    const heap = new MinHeap();
    dist.set(source, 0);
    heap.push({ node: source, dist: 0 });
    let remaining = targets ? new Set(targets) : void 0;
    if (remaining?.has(source)) remaining.delete(source);
    while (heap.size > 0) {
      const { node, dist: d } = heap.pop();
      if (d > (dist.get(node) ?? Infinity)) continue;
      if (remaining && remaining.size === 0) break;
      const edgeIdxs = graph.adjacency.get(node);
      if (!edgeIdxs) continue;
      for (const idx of edgeIdxs) {
        const edge = graph.edges[idx];
        const weight = weightFn(edge);
        const nd = d + weight;
        if (nd < (dist.get(edge.to) ?? Infinity)) {
          dist.set(edge.to, nd);
          prev.set(edge.to, node);
          prevEdge.set(edge.to, idx);
          heap.push({ node: edge.to, dist: nd });
          remaining?.delete(edge.to);
        }
      }
    }
    return { dist, prev, prevEdge };
  }
  function reconstructPath(graph, result, target) {
    const path = [];
    let cur = target;
    const seen = /* @__PURE__ */ new Set();
    while (cur !== void 0 && !seen.has(cur)) {
      seen.add(cur);
      const n = graph.nodes.get(cur);
      if (n) path.unshift({ lat: n.lat, lon: n.lon });
      cur = result.prev.get(cur);
    }
    return path;
  }
  function nearestNode(graph, point) {
    let best;
    let bestDist = Infinity;
    for (const node of graph.nodes.values()) {
      const d = haversineMeters(point, node);
      if (d < bestDist) {
        bestDist = d;
        best = node.id;
      }
    }
    return best;
  }
  function largestComponent(graph) {
    const undirected = /* @__PURE__ */ new Map();
    for (const e of graph.edges) {
      if (!undirected.has(e.from)) undirected.set(e.from, /* @__PURE__ */ new Set());
      if (!undirected.has(e.to)) undirected.set(e.to, /* @__PURE__ */ new Set());
      undirected.get(e.from).add(e.to);
      undirected.get(e.to).add(e.from);
    }
    const visited = /* @__PURE__ */ new Set();
    let best = /* @__PURE__ */ new Set();
    for (const start of undirected.keys()) {
      if (visited.has(start)) continue;
      const component = /* @__PURE__ */ new Set();
      const stack = [start];
      visited.add(start);
      while (stack.length > 0) {
        const cur = stack.pop();
        component.add(cur);
        for (const nb of undirected.get(cur) ?? []) {
          if (!visited.has(nb)) {
            visited.add(nb);
            stack.push(nb);
          }
        }
      }
      if (component.size > best.size) best = component;
    }
    return best;
  }
  function restrictToComponent(graph, keepIds) {
    const nodes = /* @__PURE__ */ new Map();
    for (const [id, node] of graph.nodes) {
      if (keepIds.has(id)) nodes.set(id, node);
    }
    const edges = [];
    const adjacency = /* @__PURE__ */ new Map();
    for (const e of graph.edges) {
      if (!keepIds.has(e.from) || !keepIds.has(e.to)) continue;
      const idx = edges.length;
      edges.push(e);
      if (!adjacency.has(e.from)) adjacency.set(e.from, []);
      adjacency.get(e.from).push(idx);
    }
    return { nodes, edges, adjacency };
  }

  // src/pipeline/transit.ts
  var ROUTE_TYPES = ["bus", "trolleybus", "share_taxi", "tram", "light_rail", "subway", "train", "monorail", "ferry"];
  var AVG_SPEED_KMH = {
    bus: 20,
    trolleybus: 18,
    share_taxi: 22,
    tram: 24,
    light_rail: 32,
    subway: 38,
    train: 55,
    monorail: 30,
    ferry: 28
  };
  var TYPICAL_HEADWAY_S = {
    bus: 12 * 60,
    trolleybus: 12 * 60,
    share_taxi: 10 * 60,
    tram: 9 * 60,
    light_rail: 8 * 60,
    subway: 6 * 60,
    train: 20 * 60,
    monorail: 8 * 60,
    ferry: 30 * 60
  };
  var WALK_SPEED_KMH = 4.8;
  var WALK_DETOUR_FACTOR = 1.25;
  var ANCHOR_TO_STOP_WALK_RADIUS_M = 900;
  var TRANSFER_WALK_RADIUS_M = 350;
  async function buildTransitGraph(city, anchors, queryFn) {
    const bbox = bboxAround({ lat: city.lat, lon: city.lon }, city.radiusMeters * 1.1);
    const routeFilter = ROUTE_TYPES.join("|");
    const query = `
    [out:json][timeout:120];
    (
      relation["type"="route"]["route"~"^(${routeFilter})$"]
        (${bbox.south},${bbox.west},${bbox.north},${bbox.east});
    );
    out body;
    >;
    out skel qt;
  `;
    let data;
    try {
      data = await queryFn(query, `transit-${city.slug}`);
    } catch {
      return { graph: emptyGraphWithAnchors(anchors), transitAvailable: false };
    }
    const nodeCoords = /* @__PURE__ */ new Map();
    const relations = [];
    for (const el of data.elements) {
      if (el.type === "node") {
        nodeCoords.set(el.id, { lat: el.lat, lon: el.lon });
      } else if (el.type === "relation" && el.tags?.route) {
        relations.push({ members: el.members ?? [], routeType: el.tags.route });
      }
    }
    const stops = /* @__PURE__ */ new Map();
    const nodes = /* @__PURE__ */ new Map();
    const edges = [];
    const adjacency = /* @__PURE__ */ new Map();
    const addEdge = (from, to, seconds, length, kind) => {
      const idx = edges.length;
      edges.push({ from, to, length, freeflowSeconds: seconds, rushhourSeconds: seconds, highway: kind, kind });
      if (!adjacency.has(from)) adjacency.set(from, []);
      adjacency.get(from).push(idx);
    };
    const ensureStopNode = (id, routeType) => {
      const coord = nodeCoords.get(id);
      if (!coord) return;
      if (!nodes.has(id)) nodes.set(id, { id, lat: coord.lat, lon: coord.lon });
      const existing = stops.get(id);
      if (!existing) {
        stops.set(id, { id, lat: coord.lat, lon: coord.lon, bestMode: routeType });
      } else if (TYPICAL_HEADWAY_S[routeType] < TYPICAL_HEADWAY_S[existing.bestMode]) {
        existing.bestMode = routeType;
      }
    };
    for (const rel of relations) {
      const speedKmh = AVG_SPEED_KMH[rel.routeType] ?? 20;
      const stopMembers = rel.members.filter(
        (m) => m.type === "node" && (m.role === "stop" || m.role === "platform" || m.role === "stop_entry_only" || m.role === "stop_exit_only")
      );
      const orderedIds = [];
      for (const m of stopMembers) {
        if (orderedIds[orderedIds.length - 1] !== m.ref) orderedIds.push(m.ref);
      }
      if (orderedIds.length < 2) continue;
      for (const id of orderedIds) ensureStopNode(id, rel.routeType);
      for (let i = 0; i < orderedIds.length - 1; i++) {
        const a = nodeCoords.get(orderedIds[i]);
        const b = nodeCoords.get(orderedIds[i + 1]);
        if (!a || !b) continue;
        const dist = haversineMeters(a, b);
        if (dist === 0) continue;
        const rideSeconds = dist / (speedKmh * 1e3 / 3600) + 15;
        addEdge(orderedIds[i], orderedIds[i + 1], rideSeconds, dist, "transit");
        addEdge(orderedIds[i + 1], orderedIds[i], rideSeconds, dist, "transit");
      }
    }
    if (stops.size === 0) {
      return { graph: emptyGraphWithAnchors(anchors), transitAvailable: false };
    }
    for (const anchor of anchors) {
      nodes.set(anchorNodeId(anchor.id), { id: anchorNodeId(anchor.id), lat: anchor.lat, lon: anchor.lon });
    }
    const stopList = [...stops.values()];
    const walkSeconds = (meters) => meters / (WALK_SPEED_KMH * 1e3 / 3600) * WALK_DETOUR_FACTOR;
    for (const anchor of anchors) {
      const aId = anchorNodeId(anchor.id);
      for (const stop of stopList) {
        const d = haversineMeters(anchor, stop);
        if (d > ANCHOR_TO_STOP_WALK_RADIUS_M) continue;
        const walkS = walkSeconds(d);
        const wait = TYPICAL_HEADWAY_S[stop.bestMode] / 2;
        addEdge(aId, stop.id, walkS + wait, d, "walk");
        addEdge(stop.id, aId, walkS, d, "walk");
      }
    }
    const projection = makeProjection({ lat: city.lat, lon: city.lon });
    const stopXY = stopList.map((s) => projection.toXY(s));
    const cellOf = (i) => [Math.floor(stopXY[i].x / TRANSFER_WALK_RADIUS_M), Math.floor(stopXY[i].y / TRANSFER_WALK_RADIUS_M)];
    const grid = /* @__PURE__ */ new Map();
    for (let i = 0; i < stopList.length; i++) {
      const [cx, cy] = cellOf(i);
      const key = `${cx},${cy}`;
      if (!grid.has(key)) grid.set(key, []);
      grid.get(key).push(i);
    }
    for (let i = 0; i < stopList.length; i++) {
      const [cx, cy] = cellOf(i);
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          for (const j of grid.get(`${cx + dx},${cy + dy}`) ?? []) {
            if (j <= i) continue;
            const d = haversineMeters(stopList[i], stopList[j]);
            if (d > TRANSFER_WALK_RADIUS_M) continue;
            const walkS = walkSeconds(d);
            addEdge(stopList[i].id, stopList[j].id, walkS + TYPICAL_HEADWAY_S[stopList[j].bestMode] / 2, d, "walk");
            addEdge(stopList[j].id, stopList[i].id, walkS + TYPICAL_HEADWAY_S[stopList[i].bestMode] / 2, d, "walk");
          }
        }
      }
    }
    for (let i = 0; i < anchors.length; i++) {
      for (let j = i + 1; j < anchors.length; j++) {
        const d = haversineMeters(anchors[i], anchors[j]);
        if (d > ANCHOR_TO_STOP_WALK_RADIUS_M) continue;
        const walkS = walkSeconds(d);
        addEdge(anchorNodeId(anchors[i].id), anchorNodeId(anchors[j].id), walkS, d, "walk");
        addEdge(anchorNodeId(anchors[j].id), anchorNodeId(anchors[i].id), walkS, d, "walk");
      }
    }
    return { graph: { nodes, edges, adjacency }, transitAvailable: true };
  }
  function anchorNodeId(anchorId) {
    return -1 - anchorId;
  }
  function emptyGraphWithAnchors(anchors) {
    const nodes = /* @__PURE__ */ new Map();
    for (const anchor of anchors) {
      nodes.set(anchorNodeId(anchor.id), { id: anchorNodeId(anchor.id), lat: anchor.lat, lon: anchor.lon });
    }
    return { nodes, edges: [], adjacency: /* @__PURE__ */ new Map() };
  }

  // src/pipeline/embed.ts
  function embedSMACOF(initial, targetMeters, iterations = 300) {
    const n = initial.length;
    let pos = initial.map((p) => ({ ...p }));
    const weight = (i, j) => targetMeters[i][j] >= 0 ? 1 : 0;
    for (let iter = 0; iter < iterations; iter++) {
      const next = new Array(n);
      for (let i = 0; i < n; i++) {
        let sx = 0;
        let sy = 0;
        let wCount = 0;
        for (let j = 0; j < n; j++) {
          if (j === i) continue;
          const w = weight(i, j);
          if (w === 0) continue;
          wCount++;
          const dx = pos[i].x - pos[j].x;
          const dy = pos[i].y - pos[j].y;
          const d = Math.max(Math.sqrt(dx * dx + dy * dy), 1e-6);
          const target = targetMeters[i][j];
          const r = target / d;
          sx += pos[j].x + r * dx;
          sy += pos[j].y + r * dy;
        }
        next[i] = wCount > 0 ? { x: sx / n, y: sy / n } : pos[i];
      }
      pos = next;
    }
    const stress = new Array(n).fill(0);
    for (let i = 0; i < n; i++) {
      let s = 0;
      let count = 0;
      for (let j = 0; j < n; j++) {
        if (j === i || weight(i, j) === 0) continue;
        const dx = pos[i].x - pos[j].x;
        const dy = pos[i].y - pos[j].y;
        const d = Math.sqrt(dx * dx + dy * dy);
        const target = targetMeters[i][j];
        s += Math.abs(d - target) / target;
        count++;
      }
      stress[i] = count > 0 ? s / count : 0;
    }
    return { positions: pos, stress };
  }
  function secondsToTargetMeters(seconds, geoXY) {
    const n = seconds.length;
    let totalGeo = 0;
    let totalSeconds = 0;
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        if (seconds[i][j] < 0) continue;
        const dx = geoXY[i].x - geoXY[j].x;
        const dy = geoXY[i].y - geoXY[j].y;
        totalGeo += Math.sqrt(dx * dx + dy * dy);
        totalSeconds += seconds[i][j];
      }
    }
    const referenceSpeedMps = totalSeconds > 0 ? totalGeo / totalSeconds : 11;
    const target = seconds.map(
      (row) => row.map((s) => s < 0 ? -1 : s * referenceSpeedMps)
    );
    return target;
  }

  // src/pipeline/matrix.ts
  function pickSampleTripAnchors(anchors) {
    const extreme = (score) => anchors.reduce((best, a, i) => score(a) > score(anchors[best]) ? i : best, 0);
    const north = extreme((a) => a.y);
    const south = extreme((a) => -a.y);
    const east = extreme((a) => a.x);
    const west = extreme((a) => -a.x);
    const northeast = extreme((a) => a.x + a.y);
    const southwest = extreme((a) => -(a.x + a.y));
    const northwest = extreme((a) => -a.x + a.y);
    const southeast = extreme((a) => a.x - a.y);
    const defs = [
      { id: "ns", label: "North \u2194 South", fromIdx: north, toIdx: south },
      { id: "ew", label: "East \u2194 West", fromIdx: east, toIdx: west },
      { id: "diag1", label: "Northeast \u2194 Southwest", fromIdx: northeast, toIdx: southwest },
      { id: "diag2", label: "Northwest \u2194 Southeast", fromIdx: northwest, toIdx: southeast }
    ];
    const seen = /* @__PURE__ */ new Set();
    const unique = defs.filter((d) => {
      if (d.fromIdx === d.toIdx) return false;
      const key = [d.fromIdx, d.toIdx].sort().join("-");
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    return unique.slice(0, 5);
  }
  function snapAnchorsToRoadGraph(graph, anchors) {
    return anchors.map((a) => nearestNode(graph, a) ?? -1);
  }
  function computeDrivingMode(mode, graph, anchors, tripDefs) {
    const anchorNodeIds = snapAnchorsToRoadGraph(graph, anchors);
    const n = anchors.length;
    const matrix = Array.from({ length: n }, () => new Array(n).fill(-1));
    const timeWeight = modeWeight[mode];
    const neededFromIdxs = new Set(tripDefs.map((d) => d.fromIdx));
    const dijkstraByAnchor = /* @__PURE__ */ new Map();
    for (let i = 0; i < n; i++) {
      const sourceNode = anchorNodeIds[i];
      matrix[i][i] = 0;
      if (sourceNode < 0) continue;
      const targets = new Set(anchorNodeIds.filter((id) => id >= 0));
      const result = dijkstra(graph, sourceNode, timeWeight, targets);
      if (neededFromIdxs.has(i)) dijkstraByAnchor.set(i, result);
      for (let j = 0; j < n; j++) {
        if (i === j || anchorNodeIds[j] < 0) continue;
        const d = result.dist.get(anchorNodeIds[j]);
        matrix[i][j] = d !== void 0 ? d : -1;
      }
    }
    const sampleTrips = [];
    for (const def of tripDefs) {
      const fromNode = anchorNodeIds[def.fromIdx];
      const toNode = anchorNodeIds[def.toIdx];
      if (fromNode < 0 || toNode < 0) continue;
      const fastestResult = dijkstraByAnchor.get(def.fromIdx);
      const fastestSeconds = fastestResult.dist.get(toNode);
      if (fastestSeconds === void 0) continue;
      const fastestPath = reconstructPath(graph, fastestResult, toNode);
      const shortestResult = dijkstra(graph, fromNode, lengthWeight, /* @__PURE__ */ new Set([toNode]));
      const shortestMeters = shortestResult.dist.get(toNode) ?? 0;
      const shortestPath = reconstructPath(graph, shortestResult, toNode);
      const shortestSeconds = estimatePathSeconds(graph, shortestResult, toNode, timeWeight);
      sampleTrips.push({
        id: def.id,
        label: def.label,
        fromAnchor: def.fromIdx,
        toAnchor: def.toIdx,
        fastest: fastestPath,
        fastestSeconds,
        shortest: shortestPath,
        shortestSeconds,
        mode
      });
    }
    const geoXY = anchors.map((a) => ({ x: a.x, y: a.y }));
    const targetMeters = secondsToTargetMeters(matrix, geoXY);
    const { positions, stress } = embedSMACOF(geoXY, targetMeters);
    return { mode, matrix, embedding: positions, stress, sampleTrips };
  }
  function computeTransitMode(graph, anchors, tripDefs) {
    const n = anchors.length;
    const matrix = Array.from({ length: n }, () => new Array(n).fill(-1));
    const neededFromIdxs = new Set(tripDefs.map((d) => d.fromIdx));
    const dijkstraByAnchor = /* @__PURE__ */ new Map();
    const targets = new Set(anchors.map((a) => anchorNodeId(a.id)));
    for (let i = 0; i < n; i++) {
      matrix[i][i] = 0;
      const sourceNode = anchorNodeId(anchors[i].id);
      const result = dijkstra(graph, sourceNode, modeWeight.transit, targets);
      if (neededFromIdxs.has(i)) dijkstraByAnchor.set(i, result);
      for (let j = 0; j < n; j++) {
        if (i === j) continue;
        const d = result.dist.get(anchorNodeId(anchors[j].id));
        matrix[i][j] = d !== void 0 ? d : -1;
      }
    }
    const sampleTrips = [];
    for (const def of tripDefs) {
      const result = dijkstraByAnchor.get(def.fromIdx);
      const toNode = anchorNodeId(anchors[def.toIdx].id);
      const seconds = result.dist.get(toNode);
      if (seconds === void 0) continue;
      const path = reconstructPath(graph, result, toNode);
      sampleTrips.push({
        id: def.id,
        label: def.label,
        fromAnchor: def.fromIdx,
        toAnchor: def.toIdx,
        fastest: path,
        fastestSeconds: seconds,
        shortest: path,
        shortestSeconds: seconds,
        mode: "transit"
      });
    }
    const geoXY = anchors.map((a) => ({ x: a.x, y: a.y }));
    const targetMeters = secondsToTargetMeters(matrix, geoXY);
    const { positions, stress } = embedSMACOF(geoXY, targetMeters);
    return { mode: "transit", matrix, embedding: positions, stress, sampleTrips };
  }
  function estimatePathSeconds(graph, result, target, timeWeight) {
    let total = 0;
    let cur = target;
    const seen = /* @__PURE__ */ new Set();
    while (result.prevEdge.has(cur) && !seen.has(cur)) {
      seen.add(cur);
      const edgeIdx = result.prevEdge.get(cur);
      total += timeWeight(graph.edges[edgeIdx]);
      cur = result.prev.get(cur);
    }
    return total;
  }

  // src/pipeline/orchestrate.ts
  async function runPipeline(city, queryFn, options = {}, onProgress = () => {
  }) {
    const anchorTarget = options.anchorTarget ?? 160;
    onProgress("grid", "Laying out anchor points and removing water...");
    let anchors = generateHexGrid(city, anchorTarget);
    anchors = await removeWaterAnchors(city, anchors, queryFn);
    anchors = anchors.map((a, i) => ({ ...a, id: i }));
    onProgress("roads", "Fetching road network from OpenStreetMap...");
    let roadGraph = await fetchRoadGraph(city, queryFn);
    const mainComponent = largestComponent(roadGraph);
    roadGraph = restrictToComponent(roadGraph, mainComponent);
    const tripDefs = pickSampleTripAnchors(anchors);
    onProgress("driving", "Computing free-flow and rush-hour travel times...");
    const modes = [];
    modes.push(computeDrivingMode("freeflow", roadGraph, anchors, tripDefs));
    modes.push(computeDrivingMode("rushhour", roadGraph, anchors, tripDefs));
    onProgress("transit", "Fetching transit routes from OpenStreetMap...");
    const { graph: transitGraph, transitAvailable } = await buildTransitGraph(city, anchors, queryFn);
    if (transitAvailable) {
      onProgress("transit-matrix", "Computing transit travel times...");
      modes.push(computeTransitMode(transitGraph, anchors, tripDefs));
    }
    onProgress("done", "Done.");
    return {
      city,
      generatedAt: (/* @__PURE__ */ new Date()).toISOString(),
      anchors,
      modes,
      meta: {
        anchorCount: anchors.length,
        edgeCount: roadGraph.edges.length,
        transitAvailable
      }
    };
  }

  // src/browser/worker.ts
  var worker = self;
  worker.onmessage = async (e) => {
    const { city, anchorTarget } = e.data;
    try {
      const queryFn = createMemoryCachedOverpassQuery();
      const dataset = await runPipeline(city, queryFn, { anchorTarget }, (stage, detail) => {
        worker.postMessage({ type: "progress", stage, detail });
      });
      worker.postMessage({ type: "done", dataset });
    } catch (err) {
      worker.postMessage({ type: "error", message: err instanceof Error ? err.message : String(err) });
    }
  };
})();
