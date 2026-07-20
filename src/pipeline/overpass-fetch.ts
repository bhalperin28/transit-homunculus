const OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
];

export interface OverpassResponse {
  elements: any[];
}

/** A function that runs an Overpass QL query, with caching left to the implementation. */
export type OverpassQueryFn = (query: string, cacheKey: string) => Promise<OverpassResponse>;

const isBrowser = typeof window !== "undefined";

/**
 * Runs an Overpass QL query against the public API with retries across
 * mirrors, no caching. Isomorphic (Node + browser) — browsers forbid
 * overriding the User-Agent header, so it's only sent under Node.
 */
export async function fetchOverpassRaw(query: string): Promise<OverpassResponse> {
  let lastError: unknown;
  for (const endpoint of OVERPASS_ENDPOINTS) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await fetch(endpoint, {
          method: "POST",
          headers: {
            "Content-Type": "text/plain",
            Accept: "*/*",
            ...(isBrowser ? {} : { "User-Agent": "transit-homunculus/1.0 (city travel-time cartogram generator)" }),
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
        return (await res.json()) as OverpassResponse;
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
