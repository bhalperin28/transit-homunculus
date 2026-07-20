import { geocodeCity } from "./pipeline/geocode.js";
import { diskCachedOverpassQuery } from "./pipeline/overpass.js";
import { runPipeline } from "./pipeline/orchestrate.js";
import { writeCitySite, updateLandingPage } from "./pipeline/viewer.js";

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

  console.log(`Geocoding "${cityQuery}"...`);
  const city = await geocodeCity(cityQuery, { radiusMeters: radiusOverride });
  console.log(`  -> ${city.name} (${city.lat.toFixed(4)}, ${city.lon.toFixed(4)}), radius ${(city.radiusMeters / 1000).toFixed(1)}km`);

  const dataset = await runPipeline(
    city,
    diskCachedOverpassQuery,
    { anchorTarget },
    (stage, detail) => console.log(`[${stage}] ${detail ?? ""}`)
  );

  console.log(
    `  -> ${dataset.meta.anchorCount} anchors, ${dataset.meta.edgeCount} road edges, transit ${
      dataset.meta.transitAvailable ? "available" : "not found"
    }`
  );

  const cityDir = await writeCitySite(dataset);
  await updateLandingPage({
    name: city.name,
    slug: city.slug,
    lat: city.lat,
    lon: city.lon,
    anchorCount: dataset.meta.anchorCount,
    transitAvailable: dataset.meta.transitAvailable,
    generatedAt: dataset.generatedAt,
  });

  console.log(`\nDone. Open docs/${city.slug}/index.html (or docs/index.html for the city picker).`);
  console.log(`Output: ${cityDir}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
