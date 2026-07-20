import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { fetchOverpassRaw, type OverpassQueryFn, type OverpassResponse } from "./overpass-fetch.js";

const CACHE_DIR = path.join(process.cwd(), "data", "cache");

export type { OverpassResponse, OverpassQueryFn };

/**
 * Node-only Overpass query function, caching responses on disk keyed by
 * query hash so repeated pipeline runs (and iteration on this project)
 * don't hammer the public API. Used by the CLI.
 */
export const diskCachedOverpassQuery: OverpassQueryFn = async (query, cacheKey) => {
  await mkdir(CACHE_DIR, { recursive: true });
  const hash = createHash("sha1").update(query).digest("hex").slice(0, 12);
  const cacheFile = path.join(CACHE_DIR, `${cacheKey}-${hash}.json`);

  try {
    const cached = await readFile(cacheFile, "utf-8");
    return JSON.parse(cached);
  } catch {
    // no cache, fall through to fetch
  }

  const json = await fetchOverpassRaw(query);
  await writeFile(cacheFile, JSON.stringify(json));
  return json;
};
