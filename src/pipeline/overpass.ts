import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";

const OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
];

const CACHE_DIR = path.join(process.cwd(), "data", "cache");

export interface OverpassResponse {
  elements: any[];
}

/**
 * Runs an Overpass QL query, caching responses on disk keyed by query hash
 * so repeated pipeline runs (and iteration on this project) don't hammer
 * the public API.
 */
export async function overpassQuery(query: string, cacheKey: string): Promise<OverpassResponse> {
  await mkdir(CACHE_DIR, { recursive: true });
  const hash = createHash("sha1").update(query).digest("hex").slice(0, 12);
  const cacheFile = path.join(CACHE_DIR, `${cacheKey}-${hash}.json`);

  try {
    const cached = await readFile(cacheFile, "utf-8");
    return JSON.parse(cached);
  } catch {
    // no cache, fall through to fetch
  }

  let lastError: unknown;
  for (const endpoint of OVERPASS_ENDPOINTS) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await fetch(endpoint, {
          method: "POST",
          headers: {
            "Content-Type": "text/plain",
            Accept: "*/*",
            "User-Agent": "transit-homunculus/1.0 (city travel-time cartogram generator)",
          },
          body: query,
        });
        if (res.status === 429 || res.status === 504) {
          await sleep(2000 * (attempt + 1));
          continue;
        }
        if (!res.ok) {
          throw new Error(`Overpass HTTP ${res.status}: ${await res.text().catch(() => "")}`);
        }
        const json = (await res.json()) as OverpassResponse;
        await writeFile(cacheFile, JSON.stringify(json));
        return json;
      } catch (err) {
        lastError = err;
        await sleep(1500 * (attempt + 1));
      }
    }
  }
  throw new Error(`Overpass query failed after retries: ${String(lastError)}`);
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
