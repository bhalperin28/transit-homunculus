import type { CityArea } from "./types.js";
import { slugify, bboxAround } from "./geo.js";

const NOMINATIM_URL = "https://nominatim.openstreetmap.org/search";
const USER_AGENT = "transit-homunculus/1.0 (city travel-time cartogram generator)";
const isBrowser = typeof window !== "undefined";

export interface NominatimResult {
  display_name: string;
  lat: string;
  lon: string;
  boundingbox: [string, string, string, string]; // south, north, west, east
  importance: number;
  type: string;
  class: string;
  addresstype?: string;
}

function nominatimHeaders(): HeadersInit {
  // Browsers forbid overriding User-Agent; the default browser UA + Referer
  // satisfies Nominatim's usage policy for normal client-side use.
  return isBrowser ? { Accept: "application/json" } : { "User-Agent": USER_AGENT, Accept: "application/json" };
}

export interface SearchBias {
  lat: number;
  lon: number;
  /** Soft-bias box half-width, in km. Results outside it still show — this only reorders. */
  radiusKm?: number;
}

/**
 * Worldwide place search for autocomplete: returns raw Nominatim results
 * (cities, towns, postal codes, ...) for a free-text query. Isomorphic —
 * called directly from the browser for the search-box dropdown, and could
 * be used server-side too.
 *
 * `bias` nudges results toward a location (e.g. the visitor's) using
 * Nominatim's viewbox — this is a *soft* preference (`bounded=0`), so
 * "Portland" typed from New England ranks Portland, Maine first while
 * "Tokyo" still finds Tokyo regardless of where the visitor is.
 */
export async function searchCitySuggestions(
  query: string,
  limit = 6,
  bias?: SearchBias
): Promise<NominatimResult[]> {
  if (query.trim().length < 2) return [];
  const url = new URL(NOMINATIM_URL);
  url.searchParams.set("q", query);
  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("limit", String(limit));
  url.searchParams.set("addressdetails", "0");
  if (bias) {
    const box = bboxAround({ lat: bias.lat, lon: bias.lon }, (bias.radiusKm ?? 400) * 1000);
    url.searchParams.set("viewbox", `${box.west},${box.north},${box.east},${box.south}`);
    url.searchParams.set("bounded", "0");
  }

  const res = await fetch(url, { headers: nominatimHeaders() });
  if (!res.ok) return [];
  return (await res.json()) as NominatimResult[];
}

export function nominatimResultToCityArea(
  r: NominatimResult,
  /** The text used to look this result up — the slug is derived from this
   * (not the resolved display name) so re-running the same query, or the
   * same autocomplete pick, always lands on the same city directory. */
  slugSource: string,
  opts: { radiusMeters?: number; maxRadiusMeters?: number } = {}
): CityArea {
  const lat = parseFloat(r.lat);
  const lon = parseFloat(r.lon);
  const [south, north, west, east] = r.boundingbox.map(parseFloat);

  const maxRadius = opts.maxRadiusMeters ?? 9000;
  let radiusMeters = opts.radiusMeters ?? boundingBoxRadiusMeters(south, north, west, east, lat);
  radiusMeters = Math.min(Math.max(radiusMeters, 2000), maxRadius);

  const name = r.display_name.split(",").slice(0, 2).join(",").trim() || r.display_name;
  return { name, slug: slugify(slugSource), lat, lon, radiusMeters };
}

/**
 * Geocode a free-text city name via Nominatim and derive a bounded analysis
 * radius from the place's own bounding box, capped so the pipeline stays
 * tractable for large metros.
 */
export async function geocodeCity(
  query: string,
  opts: { radiusMeters?: number; maxRadiusMeters?: number } = {}
): Promise<CityArea> {
  const url = new URL(NOMINATIM_URL);
  url.searchParams.set("q", query);
  url.searchParams.set("format", "json");
  url.searchParams.set("limit", "1");
  url.searchParams.set("addressdetails", "0");

  const res = await fetch(url, { headers: nominatimHeaders() });
  if (!res.ok) {
    throw new Error(`Nominatim geocoding failed for "${query}": HTTP ${res.status}`);
  }
  const results = (await res.json()) as NominatimResult[];
  if (results.length === 0) {
    throw new Error(`No geocoding result found for "${query}"`);
  }
  return nominatimResultToCityArea(results[0], query, opts);
}

function boundingBoxRadiusMeters(
  south: number,
  north: number,
  west: number,
  east: number,
  lat: number
): number {
  const EARTH_RADIUS_M = 6371000;
  const latSpanM = ((north - south) * Math.PI * EARTH_RADIUS_M) / 180;
  const lonSpanM =
    ((east - west) * Math.PI * EARTH_RADIUS_M * Math.cos((lat * Math.PI) / 180)) / 180;
  return Math.max(latSpanM, lonSpanM) / 2;
}
