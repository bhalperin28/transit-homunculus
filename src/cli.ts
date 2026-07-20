import { geocodeCity } from "./pipeline/geocode.js";
import { generateHexGrid, removeWaterAnchors } from "./pipeline/hexgrid.js";
import { fetchRoadGraph } from "./pipeline/network.js";
import { largestComponent, restrictToComponent } from "./pipeline/graph.js";
import { buildTransitGraph } from "./pipeline/transit.js";
import { computeDrivingMode, computeTransitMode, pickSampleTripAnchors } from "./pipeline/matrix.js";
import { writeCitySite, updateLandingPage } from "./pipeline/viewer.js";
import type { CityDataset, ModeResult } from "./pipeline/types.js";

function parseArgs(argv: string[]) {
  const args: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) {
      const key = argv[i].slice(2);
      const value = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : "true";
      args[key] = value;
    }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cityQuery = args.city;
  if (!cityQuery) {
    console.error('Usage: npm run pipeline -- --city "City, Region" [--radius meters] [--anchors count]');
    process.exit(1);
  }
  const anchorTarget = args.anchors ? parseInt(args.anchors, 10) : 160;
  const radiusOverride = args.radius ? parseInt(args.radius, 10) : undefined;

  console.log(`[1/6] Geocoding "${cityQuery}"...`);
  const city = await geocodeCity(cityQuery, { radiusMeters: radiusOverride });
  console.log(`      -> ${city.name} (${city.lat.toFixed(4)}, ${city.lon.toFixed(4)}), radius ${(city.radiusMeters / 1000).toFixed(1)}km`);

  console.log(`[2/6] Building anchor grid (target ${anchorTarget} points)...`);
  let anchors = generateHexGrid(city, anchorTarget);
  anchors = await removeWaterAnchors(city, anchors);
  anchors = anchors.map((a, i) => ({ ...a, id: i }));
  console.log(`      -> ${anchors.length} anchors after removing water`);

  console.log(`[3/6] Fetching road network from Overpass...`);
  let roadGraph = await fetchRoadGraph(city);
  const mainComponent = largestComponent(roadGraph);
  roadGraph = restrictToComponent(roadGraph, mainComponent);
  console.log(`      -> ${roadGraph.nodes.size} nodes, ${roadGraph.edges.length} edges (largest connected component)`);

  const tripDefs = pickSampleTripAnchors(anchors);

  console.log(`[4/6] Computing free-flow and rush-hour travel-time matrices + MDS embedding...`);
  const modes: ModeResult[] = [];
  modes.push(computeDrivingMode("freeflow", roadGraph, anchors, tripDefs));
  modes.push(computeDrivingMode("rushhour", roadGraph, anchors, tripDefs));

  console.log(`[5/6] Fetching transit routes from Overpass and computing transit matrix...`);
  const { graph: transitGraph, transitAvailable } = await buildTransitGraph(city, anchors);
  if (transitAvailable) {
    modes.push(computeTransitMode(transitGraph, anchors, tripDefs));
    console.log(`      -> transit data found, ${transitGraph.edges.length} edges`);
  } else {
    console.log(`      -> no OSM public-transport routes found for this area; skipping transit mode`);
  }

  console.log(`[6/6] Writing viewer site...`);
  const dataset: CityDataset = {
    city,
    generatedAt: new Date().toISOString(),
    anchors,
    modes,
    meta: {
      anchorCount: anchors.length,
      edgeCount: roadGraph.edges.length,
      transitAvailable,
    },
  };
  const cityDir = await writeCitySite(dataset);
  await updateLandingPage({
    name: city.name,
    slug: city.slug,
    anchorCount: anchors.length,
    transitAvailable,
    generatedAt: dataset.generatedAt,
  });

  console.log(`\nDone. Open docs/${city.slug}/index.html (or docs/index.html for the city picker).`);
  console.log(`Output: ${cityDir}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
