import type { Anchor, LatLon, Mode, ModeResult, RoadGraph, SampleTrip } from "./types.js";
import { dijkstra, lengthWeight, modeWeight, nearestNode, reconstructPath } from "./graph.js";
import { anchorNodeId } from "./transit.js";
import { embedSMACOF, secondsToTargetMeters } from "./embed.js";
import { haversineMeters } from "./geo.js";

interface TripDef {
  id: string;
  label: string;
  fromIdx: number;
  toIdx: number;
}

/** Picks geographically extreme anchor pairs so sample trips reveal the city's overall shape. */
export function pickSampleTripAnchors(anchors: Anchor[]): TripDef[] {
  const extreme = (score: (a: Anchor) => number) =>
    anchors.reduce((best, a, i) => (score(a) > score(anchors[best]) ? i : best), 0);

  const north = extreme((a) => a.y);
  const south = extreme((a) => -a.y);
  const east = extreme((a) => a.x);
  const west = extreme((a) => -a.x);
  const northeast = extreme((a) => a.x + a.y);
  const southwest = extreme((a) => -(a.x + a.y));
  const northwest = extreme((a) => -a.x + a.y);
  const southeast = extreme((a) => a.x - a.y);

  const defs: TripDef[] = [
    { id: "ns", label: "North ↔ South", fromIdx: north, toIdx: south },
    { id: "ew", label: "East ↔ West", fromIdx: east, toIdx: west },
    { id: "diag1", label: "Northeast ↔ Southwest", fromIdx: northeast, toIdx: southwest },
    { id: "diag2", label: "Northwest ↔ Southeast", fromIdx: northwest, toIdx: southeast },
  ];

  // De-dupe in case a small city collapses some extremes onto the same anchor.
  const seen = new Set<string>();
  const unique = defs.filter((d) => {
    if (d.fromIdx === d.toIdx) return false;
    const key = [d.fromIdx, d.toIdx].sort().join("-");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return unique.slice(0, 5);
}

function snapAnchorsToRoadGraph(graph: RoadGraph, anchors: Anchor[]): number[] {
  return anchors.map((a) => nearestNode(graph, a) ?? -1);
}

export function computeDrivingMode(
  mode: "freeflow" | "rushhour",
  graph: RoadGraph,
  anchors: Anchor[],
  tripDefs: TripDef[]
): ModeResult {
  const anchorNodeIds = snapAnchorsToRoadGraph(graph, anchors);
  const n = anchors.length;
  const matrix: number[][] = Array.from({ length: n }, () => new Array(n).fill(-1));
  const timeWeight = modeWeight[mode];

  const dijkstraByAnchor = new Map<number, ReturnType<typeof dijkstra>>();

  for (let i = 0; i < n; i++) {
    const sourceNode = anchorNodeIds[i];
    matrix[i][i] = 0;
    if (sourceNode < 0) continue;
    const targets = new Set(anchorNodeIds.filter((id) => id >= 0));
    const result = dijkstra(graph, sourceNode, timeWeight, targets);
    dijkstraByAnchor.set(i, result);
    for (let j = 0; j < n; j++) {
      if (i === j || anchorNodeIds[j] < 0) continue;
      const d = result.dist.get(anchorNodeIds[j]);
      matrix[i][j] = d !== undefined ? d : -1;
    }
  }

  const sampleTrips: SampleTrip[] = [];
  for (const def of tripDefs) {
    const fromNode = anchorNodeIds[def.fromIdx];
    const toNode = anchorNodeIds[def.toIdx];
    if (fromNode < 0 || toNode < 0) continue;

    const fastestResult = dijkstraByAnchor.get(def.fromIdx)!;
    const fastestSeconds = fastestResult.dist.get(toNode);
    if (fastestSeconds === undefined) continue;
    const fastestPath = reconstructPath(graph, fastestResult, toNode);

    const shortestResult = dijkstra(graph, fromNode, lengthWeight, new Set([toNode]));
    const shortestMeters = shortestResult.dist.get(toNode) ?? 0;
    const shortestPath = reconstructPath(graph, shortestResult, toNode);
    // Approximate the shortest-distance route's travel time using this mode's speeds.
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
      mode,
    });
  }

  const geoXY = anchors.map((a) => ({ x: a.x, y: a.y }));
  const targetMeters = secondsToTargetMeters(matrix, geoXY);
  const { positions, stress } = embedSMACOF(geoXY, targetMeters);

  return { mode, matrix, embedding: positions, stress, sampleTrips };
}

export function computeTransitMode(
  graph: RoadGraph,
  anchors: Anchor[],
  tripDefs: TripDef[]
): ModeResult {
  const n = anchors.length;
  const matrix: number[][] = Array.from({ length: n }, () => new Array(n).fill(-1));
  const dijkstraByAnchor = new Map<number, ReturnType<typeof dijkstra>>();
  const targets = new Set(anchors.map((a) => anchorNodeId(a.id)));

  for (let i = 0; i < n; i++) {
    matrix[i][i] = 0;
    const sourceNode = anchorNodeId(anchors[i].id);
    const result = dijkstra(graph, sourceNode, modeWeight.transit, targets);
    dijkstraByAnchor.set(i, result);
    for (let j = 0; j < n; j++) {
      if (i === j) continue;
      const d = result.dist.get(anchorNodeId(anchors[j].id));
      matrix[i][j] = d !== undefined ? d : -1;
    }
  }

  const sampleTrips: SampleTrip[] = [];
  for (const def of tripDefs) {
    const result = dijkstraByAnchor.get(def.fromIdx)!;
    const toNode = anchorNodeId(anchors[def.toIdx].id);
    const seconds = result.dist.get(toNode);
    if (seconds === undefined) continue;
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
      mode: "transit",
    });
  }

  const geoXY = anchors.map((a) => ({ x: a.x, y: a.y }));
  const targetMeters = secondsToTargetMeters(matrix, geoXY);
  const { positions, stress } = embedSMACOF(geoXY, targetMeters);

  return { mode: "transit", matrix, embedding: positions, stress, sampleTrips };
}

function estimatePathSeconds(
  graph: RoadGraph,
  result: ReturnType<typeof dijkstra>,
  target: number,
  timeWeight: (e: any) => number
): number {
  let total = 0;
  let cur = target;
  const seen = new Set<number>();
  while (result.prevEdge.has(cur) && !seen.has(cur)) {
    seen.add(cur);
    const edgeIdx = result.prevEdge.get(cur)!;
    total += timeWeight(graph.edges[edgeIdx]);
    cur = result.prev.get(cur)!;
  }
  return total;
}
