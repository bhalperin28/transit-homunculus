import type { CityArea } from "./types.js";
import { slugify } from "./geo.js";

const NOMINATIM_URL = "https://nominatim.openstreetmap.org/search";
const USER_AGENT = "transit-homunculus/1.0 (city travel-time cartogram generator)";

interface NominatimResult {
  display_name: string;
  lat: string;
  lon: string;
  boundingbox: [string, string, string, string]; // south, north, west, east
  importance: number;
  type: string;
  class: string;
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

  const res = await fetch(url, { headers: { "User-Agent": USER_AGENT, Accept: "*/*" } });
  if (!res.ok) {
    throw new Error(`Nominatim geocoding failed for "${query}": HTTP ${res.status}`);
  }
  const results = (await res.json()) as NominatimResult[];
  if (results.length === 0) {
    throw new Error(`No geocoding result found for "${query}"`);
  }
  const r = results[0];
  const lat = parseFloat(r.lat);
  const lon = parseFloat(r.lon);
  const [south, north, west, east] = r.boundingbox.map(parseFloat);

  const maxRadius = opts.maxRadiusMeters ?? 9000;
  let radiusMeters = opts.radiusMeters ?? boundingBoxRadiusMeters(south, north, west, east, lat);
  radiusMeters = Math.min(Math.max(radiusMeters, 2000), maxRadius);

  return {
    name: r.display_name.split(",").slice(0, 2).join(",").trim() || query,
    slug: slugify(query),
    lat,
    lon,
    radiusMeters,
  };
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
