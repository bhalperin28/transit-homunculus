import { createMemoryCachedOverpassQuery } from "../pipeline/overpass-browser.js";
import { runPipeline } from "../pipeline/orchestrate.js";
import type { CityArea, CityDataset } from "../pipeline/types.js";

/**
 * Web Worker entry point: runs the full generation pipeline off the main
 * thread so the page stays responsive during Overpass fetches and the
 * Dijkstra/MDS computation, which can take tens of seconds for a real city.
 * Bundled standalone (see scripts/build-browser.mjs) since GitHub Pages has
 * no build step of its own.
 */

interface GenerateRequest {
  type: "generate";
  city: CityArea;
  anchorTarget?: number;
}

type WorkerOut =
  | { type: "progress"; stage: string; detail?: string }
  | { type: "done"; dataset: CityDataset }
  | { type: "error"; message: string };

const worker = self as unknown as { onmessage: ((e: MessageEvent) => void) | null; postMessage: (msg: WorkerOut) => void };

worker.onmessage = async (e: MessageEvent<GenerateRequest>) => {
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
