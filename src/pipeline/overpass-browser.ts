import { fetchOverpassRaw, type OverpassQueryFn } from "./overpass-fetch.js";

/**
 * Browser Overpass query function: in-memory cache only (scoped to one
 * generation run / worker lifetime), no disk access.
 */
export function createMemoryCachedOverpassQuery(): OverpassQueryFn {
  const cache = new Map<string, ReturnType<typeof fetchOverpassRaw>>();
  return (query, cacheKey) => {
    const existing = cache.get(cacheKey);
    if (existing) return existing;
    const promise = fetchOverpassRaw(query);
    cache.set(cacheKey, promise);
    return promise;
  };
}
