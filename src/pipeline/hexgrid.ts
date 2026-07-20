import type { Anchor, CityArea, LatLon } from "./types.js";
import { makeProjection, pointInPolygon, bboxAround } from "./geo.js";
import { overpassQuery } from "./overpass.js";

/**
 * Generates a hexagonally-packed set of anchor points covering a circular
 * area around the city center, sized to land close to `targetCount` points.
 */
export function generateHexGrid(city: CityArea, targetCount = 160): Anchor[] {
  const projection = makeProjection({ lat: city.lat, lon: city.lon });
  const area = Math.PI * city.radiusMeters ** 2;
  const spacing = Math.sqrt(((Math.sqrt(3) / 2) * area) / targetCount);
  const rowHeight = spacing * (Math.sqrt(3) / 2);

  const anchors: Anchor[] = [];
  let id = 0;
  const rows = Math.ceil(city.radiusMeters / rowHeight) + 1;

  for (let row = -rows; row <= rows; row++) {
    const y = row * rowHeight;
    const xOffset = row % 2 === 0 ? 0 : spacing / 2;
    const maxX = Math.sqrt(Math.max(0, city.radiusMeters ** 2 - y * y));
    const startCol = Math.ceil((-maxX - xOffset) / spacing);
    const endCol = Math.floor((maxX - xOffset) / spacing);
    for (let col = startCol; col <= endCol; col++) {
      const x = col * spacing + xOffset;
      if (x * x + y * y > city.radiusMeters ** 2) continue;
      const latLon = projection.toLatLon({ x, y });
      anchors.push({ id: id++, lat: latLon.lat, lon: latLon.lon, x, y });
    }
  }

  return anchors;
}

/** Fetches water polygons (lakes, bays, rivers) and drops anchors that fall inside them. */
export async function removeWaterAnchors(city: CityArea, anchors: Anchor[]): Promise<Anchor[]> {
  const bbox = bboxAround({ lat: city.lat, lon: city.lon }, city.radiusMeters * 1.05);
  const query = `
    [out:json][timeout:90];
    (
      way["natural"="water"](${bbox.south},${bbox.west},${bbox.north},${bbox.east});
      way["waterway"="riverbank"](${bbox.south},${bbox.west},${bbox.north},${bbox.east});
      relation["natural"="water"](${bbox.south},${bbox.west},${bbox.north},${bbox.east});
    );
    out body;
    >;
    out skel qt;
  `;

  let data;
  try {
    data = await overpassQuery(query, `water-${city.slug}`);
  } catch {
    // If the water query fails, keep all anchors rather than aborting the pipeline.
    return anchors;
  }

  const nodeCoords = new Map<number, LatLon>();
  const ways = new Map<number, number[]>();
  for (const el of data.elements) {
    if (el.type === "node") nodeCoords.set(el.id, { lat: el.lat, lon: el.lon });
    else if (el.type === "way") ways.set(el.id, el.nodes);
  }

  const polygons: LatLon[][] = [];
  for (const nodeIds of ways.values()) {
    const ring = nodeIds.map((id: number) => nodeCoords.get(id)).filter(Boolean) as LatLon[];
    if (ring.length >= 3) polygons.push(ring);
  }

  if (polygons.length === 0) return anchors;

  return anchors.filter((a) => !polygons.some((ring) => pointInPolygon(a, ring)));
}
