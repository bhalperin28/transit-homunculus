/**
 * Metric MDS via SMACOF (stress majorization): repositions points in 2D so
 * that Euclidean distance between them matches a target "time-distance"
 * derived from travel time, starting from the real geographic layout so the
 * result stays a recognizable, minimally-rotated deformation of the city
 * rather than an arbitrary embedding.
 */
export interface EmbedResult {
  positions: { x: number; y: number }[];
  stress: number[];
}

export function embedSMACOF(
  initial: { x: number; y: number }[],
  targetMeters: number[][], // -1 = unreachable / excluded
  iterations = 300
): EmbedResult {
  const n = initial.length;
  let pos = initial.map((p) => ({ ...p }));

  const weight = (i: number, j: number) => (targetMeters[i][j] >= 0 ? 1 : 0);

  for (let iter = 0; iter < iterations; iter++) {
    const next: { x: number; y: number }[] = new Array(n);
    for (let i = 0; i < n; i++) {
      let sx = 0;
      let sy = 0;
      let wCount = 0;
      for (let j = 0; j < n; j++) {
        if (j === i) continue;
        const w = weight(i, j);
        if (w === 0) continue;
        wCount++;
        const dx = pos[i].x - pos[j].x;
        const dy = pos[i].y - pos[j].y;
        const d = Math.max(Math.sqrt(dx * dx + dy * dy), 1e-6);
        const target = targetMeters[i][j];
        const r = target / d;
        sx += pos[j].x + r * dx;
        sy += pos[j].y + r * dy;
      }
      // Anchors with no reachable neighbors keep their prior position instead
      // of collapsing toward the origin.
      next[i] = wCount > 0 ? { x: sx / n, y: sy / n } : pos[i];
    }
    pos = next;
  }

  const stress = new Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    let s = 0;
    let count = 0;
    for (let j = 0; j < n; j++) {
      if (j === i || weight(i, j) === 0) continue;
      const dx = pos[i].x - pos[j].x;
      const dy = pos[i].y - pos[j].y;
      const d = Math.sqrt(dx * dx + dy * dy);
      const target = targetMeters[i][j];
      s += Math.abs(d - target) / target;
      count++;
    }
    stress[i] = count > 0 ? s / count : 0;
  }

  return { positions: pos, stress };
}

/** Converts a travel-time matrix (seconds) into a target distance matrix (meters) at a reference speed. */
export function secondsToTargetMeters(
  seconds: number[][],
  geoXY: { x: number; y: number }[]
): number[][] {
  const n = seconds.length;
  let totalGeo = 0;
  let totalSeconds = 0;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (seconds[i][j] < 0) continue;
      const dx = geoXY[i].x - geoXY[j].x;
      const dy = geoXY[i].y - geoXY[j].y;
      totalGeo += Math.sqrt(dx * dx + dy * dy);
      totalSeconds += seconds[i][j];
    }
  }
  const referenceSpeedMps = totalSeconds > 0 ? totalGeo / totalSeconds : 11; // ~40 km/h fallback

  const target: number[][] = seconds.map((row) =>
    row.map((s) => (s < 0 ? -1 : s * referenceSpeedMps))
  );
  return target;
}
