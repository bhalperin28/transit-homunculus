import type { GraphEdge, GraphNode, LatLon, Mode, RoadGraph } from "./types.js";
import { haversineMeters } from "./geo.js";

type MinHeapItem = { node: number; dist: number };

/** Small binary min-heap; good enough for city-scale graphs (tens of thousands of nodes). */
class MinHeap {
  private items: MinHeapItem[] = [];

  push(item: MinHeapItem) {
    this.items.push(item);
    let i = this.items.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.items[parent].dist <= this.items[i].dist) break;
      [this.items[parent], this.items[i]] = [this.items[i], this.items[parent]];
      i = parent;
    }
  }

  pop(): MinHeapItem | undefined {
    if (this.items.length === 0) return undefined;
    const top = this.items[0];
    const last = this.items.pop()!;
    if (this.items.length > 0) {
      this.items[0] = last;
      let i = 0;
      const n = this.items.length;
      for (;;) {
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
}

export interface DijkstraResult {
  dist: Map<number, number>;
  prev: Map<number, number>;
  prevEdge: Map<number, number>;
}

export type EdgeWeightFn = (edge: GraphEdge) => number;

export const modeWeight: Record<Mode, EdgeWeightFn> = {
  freeflow: (e) => e.freeflowSeconds,
  rushhour: (e) => e.rushhourSeconds,
  transit: (e) => e.freeflowSeconds,
};

export const lengthWeight: EdgeWeightFn = (e) => e.length;

export function dijkstra(
  graph: RoadGraph,
  source: number,
  weightFn: EdgeWeightFn,
  targets?: Set<number>
): DijkstraResult {
  const dist = new Map<number, number>();
  const prev = new Map<number, number>();
  const prevEdge = new Map<number, number>();
  const heap = new MinHeap();

  dist.set(source, 0);
  heap.push({ node: source, dist: 0 });
  let remaining = targets ? new Set(targets) : undefined;
  if (remaining?.has(source)) remaining.delete(source);

  while (heap.size > 0) {
    const { node, dist: d } = heap.pop()!;
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

export function reconstructPath(
  graph: RoadGraph,
  result: DijkstraResult,
  target: number
): LatLon[] {
  const path: LatLon[] = [];
  let cur: number | undefined = target;
  const seen = new Set<number>();
  while (cur !== undefined && !seen.has(cur)) {
    seen.add(cur);
    const n = graph.nodes.get(cur);
    if (n) path.unshift({ lat: n.lat, lon: n.lon });
    cur = result.prev.get(cur);
  }
  return path;
}

export function nearestNode(graph: RoadGraph, point: LatLon): number | undefined {
  let best: number | undefined;
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

/** Returns the node ids in the largest weakly-connected component of the graph. */
export function largestComponent(graph: RoadGraph): Set<number> {
  const undirected = new Map<number, Set<number>>();
  for (const e of graph.edges) {
    if (!undirected.has(e.from)) undirected.set(e.from, new Set());
    if (!undirected.has(e.to)) undirected.set(e.to, new Set());
    undirected.get(e.from)!.add(e.to);
    undirected.get(e.to)!.add(e.from);
  }

  const visited = new Set<number>();
  let best = new Set<number>();

  for (const start of undirected.keys()) {
    if (visited.has(start)) continue;
    const component = new Set<number>();
    const stack = [start];
    visited.add(start);
    while (stack.length > 0) {
      const cur = stack.pop()!;
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

/** Drops nodes/edges outside `keepIds`, so routing can't wander onto disconnected fragments. */
export function restrictToComponent(graph: RoadGraph, keepIds: Set<number>): RoadGraph {
  const nodes = new Map<number, GraphNode>();
  for (const [id, node] of graph.nodes) {
    if (keepIds.has(id)) nodes.set(id, node);
  }
  const edges: GraphEdge[] = [];
  const adjacency = new Map<number, number[]>();
  for (const e of graph.edges) {
    if (!keepIds.has(e.from) || !keepIds.has(e.to)) continue;
    const idx = edges.length;
    edges.push(e);
    if (!adjacency.has(e.from)) adjacency.set(e.from, []);
    adjacency.get(e.from)!.push(idx);
  }
  return { nodes, edges, adjacency };
}
