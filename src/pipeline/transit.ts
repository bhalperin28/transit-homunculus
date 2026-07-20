import type { Anchor, CityArea, GraphEdge, GraphNode, RoadGraph } from "./types.js";
import { bboxAround, haversineMeters, makeProjection } from "./geo.js";
import type { OverpassQueryFn } from "./overpass-fetch.js";

/**
 * Builds a transit-mode routing graph directly from OpenStreetMap's public
 * transport route relations (bus/tram/subway/train/ferry), rather than a
 * city-specific GTFS feed. GTFS feed URLs differ per agency and city, which
 * would defeat the point of "any city" — OSM PT relations exist worldwide
 * under one consistent schema, so this is the piece that makes transit mode
 * generalize without per-city configuration.
 *
 * Since OSM doesn't carry timetables, wait time is approximated as half the
 * typical headway for the mode (a documented simplification, in the same
 * spirit as the modeled traffic profile used for the rush-hour driving
 * mode). Anchors connect to nearby stops — and stops to nearby stops, for
 * transfers — via walking edges.
 */

const ROUTE_TYPES = ["bus", "trolleybus", "share_taxi", "tram", "light_rail", "subway", "train", "monorail", "ferry"];

const AVG_SPEED_KMH: Record<string, number> = {
  bus: 20,
  trolleybus: 18,
  share_taxi: 22,
  tram: 24,
  light_rail: 32,
  subway: 38,
  train: 55,
  monorail: 30,
  ferry: 28,
};

/** Typical headway in seconds, used to model average wait as headway / 2. */
const TYPICAL_HEADWAY_S: Record<string, number> = {
  bus: 12 * 60,
  trolleybus: 12 * 60,
  share_taxi: 10 * 60,
  tram: 9 * 60,
  light_rail: 8 * 60,
  subway: 6 * 60,
  train: 20 * 60,
  monorail: 8 * 60,
  ferry: 30 * 60,
};

const WALK_SPEED_KMH = 4.8;
const WALK_DETOUR_FACTOR = 1.25; // streets aren't straight lines
const ANCHOR_TO_STOP_WALK_RADIUS_M = 900;
const TRANSFER_WALK_RADIUS_M = 350;

interface Stop {
  id: number; // original OSM node id
  lat: number;
  lon: number;
  bestMode: string;
}

export async function buildTransitGraph(
  city: CityArea,
  anchors: Anchor[],
  queryFn: OverpassQueryFn
): Promise<{ graph: RoadGraph; transitAvailable: boolean }> {
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

  const nodeCoords = new Map<number, { lat: number; lon: number }>();
  const relations: { members: any[]; routeType: string }[] = [];

  for (const el of data.elements) {
    if (el.type === "node") {
      nodeCoords.set(el.id, { lat: el.lat, lon: el.lon });
    } else if (el.type === "relation" && el.tags?.route) {
      relations.push({ members: el.members ?? [], routeType: el.tags.route });
    }
  }

  const stops = new Map<number, Stop>();
  const nodes = new Map<number, GraphNode>();
  const edges: GraphEdge[] = [];
  const adjacency = new Map<number, number[]>();

  const addEdge = (from: number, to: number, seconds: number, length: number, kind: "transit" | "walk") => {
    const idx = edges.length;
    edges.push({ from, to, length, freeflowSeconds: seconds, rushhourSeconds: seconds, highway: kind, kind });
    if (!adjacency.has(from)) adjacency.set(from, []);
    adjacency.get(from)!.push(idx);
  };

  const ensureStopNode = (id: number, routeType: string) => {
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
      (m: any) => m.type === "node" && (m.role === "stop" || m.role === "platform" || m.role === "stop_entry_only" || m.role === "stop_exit_only")
    );
    // De-duplicate consecutive repeats while preserving relation order.
    const orderedIds: number[] = [];
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
      const rideSeconds = dist / ((speedKmh * 1000) / 3600) + 15; // + dwell
      // Real-world lines almost always run both directions even when OSM
      // only mapped one relation for this direction; model both ways.
      addEdge(orderedIds[i], orderedIds[i + 1], rideSeconds, dist, "transit");
      addEdge(orderedIds[i + 1], orderedIds[i], rideSeconds, dist, "transit");
    }
  }

  if (stops.size === 0) {
    return { graph: emptyGraphWithAnchors(anchors), transitAvailable: false };
  }

  // Anchor nodes live in a negative id space so they can't collide with OSM ids.
  for (const anchor of anchors) {
    nodes.set(anchorNodeId(anchor.id), { id: anchorNodeId(anchor.id), lat: anchor.lat, lon: anchor.lon });
  }

  const stopList = [...stops.values()];
  const walkSeconds = (meters: number) => (meters / ((WALK_SPEED_KMH * 1000) / 3600)) * WALK_DETOUR_FACTOR;

  // Anchor <-> nearby stops (boarding pays the average wait for that stop's best-served mode).
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

  // Stop <-> nearby stop transfers. A naive all-pairs scan here is O(stops²)
  // — fine for a small town's handful of stops, but a dense city's transit
  // network can have thousands of stops, where that becomes tens of millions
  // of iterations and risks taking so long (or allocating so much) that a
  // memory- and CPU-constrained mobile browser tab gives up. A uniform grid
  // keyed at the transfer radius bounds the search to each stop's own cell
  // plus its 8 neighbors — any pair within the radius is guaranteed to fall
  // in one of those, so this produces the identical set of edges, just
  // without checking every non-nearby pair to rule it out.
  const projection = makeProjection({ lat: city.lat, lon: city.lon });
  const stopXY = stopList.map((s) => projection.toXY(s));
  const cellOf = (i: number) => [Math.floor(stopXY[i].x / TRANSFER_WALK_RADIUS_M), Math.floor(stopXY[i].y / TRANSFER_WALK_RADIUS_M)];
  const grid = new Map<string, number[]>();
  for (let i = 0; i < stopList.length; i++) {
    const [cx, cy] = cellOf(i);
    const key = `${cx},${cy}`;
    if (!grid.has(key)) grid.set(key, []);
    grid.get(key)!.push(i);
  }
  for (let i = 0; i < stopList.length; i++) {
    const [cx, cy] = cellOf(i);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (const j of grid.get(`${cx + dx},${cy + dy}`) ?? []) {
          if (j <= i) continue; // each unordered pair considered once
          const d = haversineMeters(stopList[i], stopList[j]);
          if (d > TRANSFER_WALK_RADIUS_M) continue;
          const walkS = walkSeconds(d);
          addEdge(stopList[i].id, stopList[j].id, walkS + TYPICAL_HEADWAY_S[stopList[j].bestMode] / 2, d, "walk");
          addEdge(stopList[j].id, stopList[i].id, walkS + TYPICAL_HEADWAY_S[stopList[i].bestMode] / 2, d, "walk");
        }
      }
    }
  }

  // Direct anchor-to-anchor walking fallback keeps the graph connected even
  // where transit doesn't reach, for anchors close enough to walk between.
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

export function anchorNodeId(anchorId: number): number {
  return -1 - anchorId;
}

function emptyGraphWithAnchors(anchors: Anchor[]): RoadGraph {
  const nodes = new Map<number, GraphNode>();
  for (const anchor of anchors) {
    nodes.set(anchorNodeId(anchor.id), { id: anchorNodeId(anchor.id), lat: anchor.lat, lon: anchor.lon });
  }
  return { nodes, edges: [], adjacency: new Map() };
}
