import type { CityArea, CityDataset, ModeResult } from "./types.js";
import { generateHexGrid, removeWaterAnchors } from "./hexgrid.js";
import { fetchRoadGraph } from "./network.js";
import { largestComponent, restrictToComponent } from "./graph.js";
import { buildTransitGraph } from "./transit.js";
import { computeDrivingMode, computeTransitMode, pickSampleTripAnchors } from "./matrix.js";
import type { OverpassQueryFn } from "./overpass-fetch.js";

export interface PipelineOptions {
  anchorTarget?: number;
}

export type ProgressCallback = (stage: string, detail?: string) => void;

/**
 * Runs the full generation pipeline (grid -> roads -> transit -> matrices ->
 * MDS embedding) for a resolved city area, entirely in memory. Isomorphic:
 * used by both the Node CLI (with a disk-cached Overpass query function) and
 * the browser worker (with an in-memory-cached one).
 */
export async function runPipeline(
  city: CityArea,
  queryFn: OverpassQueryFn,
  options: PipelineOptions = {},
  onProgress: ProgressCallback = () => {}
): Promise<CityDataset> {
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
  const modes: ModeResult[] = [];
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
    generatedAt: new Date().toISOString(),
    anchors,
    modes,
    meta: {
      anchorCount: anchors.length,
      edgeCount: roadGraph.edges.length,
      transitAvailable,
    },
  };
}
