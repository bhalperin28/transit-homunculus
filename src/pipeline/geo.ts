import type { LatLon } from "./types.js";

const EARTH_RADIUS_M = 6371000;

/** Local equirectangular projection centered on `origin`, in meters. Good enough for city-scale extents. */
export function makeProjection(origin: LatLon) {
  const lat0 = (origin.lat * Math.PI) / 180;
  const cosLat0 = Math.cos(lat0);

  return {
    toXY(p: LatLon): { x: number; y: number } {
      const dLat = ((p.lat - origin.lat) * Math.PI) / 180;
      const dLon = ((p.lon - origin.lon) * Math.PI) / 180;
      return {
        x: dLon * cosLat0 * EARTH_RADIUS_M,
        y: dLat * EARTH_RADIUS_M,
      };
    },
    toLatLon(xy: { x: number; y: number }): LatLon {
      const dLat = xy.y / EARTH_RADIUS_M;
      const dLon = xy.x / (EARTH_RADIUS_M * cosLat0);
      return {
        lat: origin.lat + (dLat * 180) / Math.PI,
        lon: origin.lon + (dLon * 180) / Math.PI,
      };
    },
  };
}

export function haversineMeters(a: LatLon, b: LatLon): number {
  const lat1 = (a.lat * Math.PI) / 180;
  const lat2 = (b.lat * Math.PI) / 180;
  const dLat = lat2 - lat1;
  const dLon = ((b.lon - a.lon) * Math.PI) / 180;
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function bboxAround(center: LatLon, radiusMeters: number) {
  const latDelta = (radiusMeters / EARTH_RADIUS_M) * (180 / Math.PI);
  const lonDelta =
    (radiusMeters / (EARTH_RADIUS_M * Math.cos((center.lat * Math.PI) / 180))) * (180 / Math.PI);
  return {
    south: center.lat - latDelta,
    north: center.lat + latDelta,
    west: center.lon - lonDelta,
    east: center.lon + lonDelta,
  };
}

/** Ray-casting point-in-polygon for a simple lat/lon polygon ring. */
export function pointInPolygon(point: LatLon, ring: LatLon[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i].lon,
      yi = ring[i].lat;
    const xj = ring[j].lon,
      yj = ring[j].lat;
    const intersect =
      yi > point.lat !== yj > point.lat &&
      point.lon < ((xj - xi) * (point.lat - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

const DIACRITICS_RE = new RegExp("[\\u0300-\\u036f]", "g");

export function slugify(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFKD")
    .replace(DIACRITICS_RE, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}
