import { searchCitySuggestions, nominatimResultToCityArea, type NominatimResult } from "../pipeline/geocode.js";
import type { CityArea, CityDataset } from "../pipeline/types.js";

export { searchCitySuggestions, nominatimResultToCityArea };
export type { NominatimResult, CityArea, CityDataset };

export interface GenerateOptions {
  anchorTarget?: number;
  onProgress?: (stage: string, detail?: string) => void;
  /** Path to the bundled worker script, relative to the page loading this library. */
  workerUrl?: string;
}

/**
 * Runs the full generation pipeline for a city in a Web Worker and resolves
 * with the finished dataset, forwarding progress events along the way.
 */
export function generateCityDataset(city: CityArea, options: GenerateOptions = {}): Promise<CityDataset> {
  const workerUrl = options.workerUrl ?? "./generate-worker.js";
  return new Promise((resolve, reject) => {
    const worker = new Worker(workerUrl);
    worker.onmessage = (e: MessageEvent) => {
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
