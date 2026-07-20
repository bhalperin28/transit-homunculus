import type { CityArea, GraphEdge, GraphNode, RoadGraph } from "./types.js";
import { bboxAround, haversineMeters } from "./geo.js";
import { overpassQuery } from "./overpass.js";

const DRIVABLE_HIGHWAYS = [
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
  "living_street",
];

/** Free-flow speed defaults in km/h, used when a way has no maxspeed tag. */
const DEFAULT_FREEFLOW_KMH: Record<string, number> = {
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
  tertiary_link: 30,
};

/**
 * Modeled rush-hour slowdown multiplier applied to free-flow travel time,
 * by road class. Higher-capacity roads see the largest relative slowdown
 * during peak congestion, matching the pattern the original project found
 * using TomTom's live flow data. This is the fallback used when no
 * TOMTOM_API_KEY is configured (see README) — it lets the pipeline run for
 * any city without a paid data subscription.
 */
const RUSH_HOUR_MULTIPLIER: Record<string, number> = {
  motorway: 2.0,
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
  tertiary_link: 1.2,
};

function parseMaxspeedKmh(tag: string | undefined, highway: string): number {
  const fallback = DEFAULT_FREEFLOW_KMH[highway] ?? 40;
  if (!tag) return fallback;
  const mph = tag.match(/(\d+)\s*mph/i);
  if (mph) return parseInt(mph[1], 10) * 1.60934;
  const kmh = tag.match(/(\d+)\s*(km\/h)?/i);
  if (kmh && kmh[1]) return parseInt(kmh[1], 10);
  return fallback;
}

export async function fetchRoadGraph(city: CityArea): Promise<RoadGraph> {
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

  const data = await overpassQuery(query, `roads-${city.slug}`);

  const nodes = new Map<number, GraphNode>();
  const ways: { nodeIds: number[]; highway: string; maxspeed?: string; oneway?: string }[] = [];

  for (const el of data.elements) {
    if (el.type === "node") {
      nodes.set(el.id, { id: el.id, lat: el.lat, lon: el.lon });
    } else if (el.type === "way" && el.tags?.highway) {
      ways.push({
        nodeIds: el.nodes,
        highway: el.tags.highway,
        maxspeed: el.tags.maxspeed,
        oneway: el.tags.oneway,
      });
    }
  }

  const edges: GraphEdge[] = [];
  const adjacency = new Map<number, number[]>();

  const addEdge = (from: number, to: number, length: number, highway: string, kmh: number) => {
    const freeflowSeconds = length / ((kmh * 1000) / 3600);
    const multiplier = RUSH_HOUR_MULTIPLIER[highway] ?? 1.15;
    const idx = edges.length;
    edges.push({
      from,
      to,
      length,
      freeflowSeconds,
      rushhourSeconds: freeflowSeconds * multiplier,
      highway,
      kind: "road",
    });
    if (!adjacency.has(from)) adjacency.set(from, []);
    adjacency.get(from)!.push(idx);
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

  // Drop nodes that ended up with no edges (isolated OSM nodes outside the drivable set).
  const usedNodeIds = new Set<number>();
  for (const e of edges) {
    usedNodeIds.add(e.from);
    usedNodeIds.add(e.to);
  }
  for (const id of nodes.keys()) {
    if (!usedNodeIds.has(id)) nodes.delete(id);
  }

  return { nodes, edges, adjacency };
}
