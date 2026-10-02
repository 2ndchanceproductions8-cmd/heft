import type { Muscle } from '../../types';

/*
 * Stylized anatomical figures for the muscle map (front + back), in a 200 × 450 viewBox per figure.
 *
 * Every shape is authored as a list of points for the LEFT half of the figure (x ≤ 100) and turned into
 * smooth cubic Béziers with a Catmull-Rom spline, then mirrored across x = 100 so the body is perfectly
 * symmetric. A point with a third element `1` is a sharp corner (zero tangent).
 *
 * Draw order (bottom → top): body silhouette, detail shapes (ears, kneecaps), muscle regions in array
 * order, then the head. Regions later in the list overlap earlier ones (deltoids sit over the arm tops).
 */

export const FIGURE_W = 200;
export const FIGURE_H = 450;

type Pt = readonly [number, number] | readonly [number, number, 1];

const K = 1 / 6; // Catmull-Rom → Bézier factor
const f = (n: number) => String(Math.round(n * 100) / 100);

/** Smooth closed path through the points (Catmull-Rom spline). */
export function spline(pts: readonly Pt[]): string {
  const n = pts.length;
  const P = (i: number) => pts[((i % n) + n) % n];
  let d = `M${f(P(0)[0])} ${f(P(0)[1])}`;
  for (let i = 0; i < n; i++) {
    const p0 = P(i - 1);
    const p1 = P(i);
    const p2 = P(i + 1);
    const p3 = P(i + 2);
    const t1x = p1[2] ? 0 : (p2[0] - p0[0]) * K;
    const t1y = p1[2] ? 0 : (p2[1] - p0[1]) * K;
    const t2x = p2[2] ? 0 : (p3[0] - p1[0]) * K;
    const t2y = p2[2] ? 0 : (p3[1] - p1[1]) * K;
    d += `C${f(p1[0] + t1x)} ${f(p1[1] + t1y)} ${f(p2[0] - t2x)} ${f(p2[1] - t2y)} ${f(p2[0])} ${f(p2[1])}`;
  }
  return d + 'Z';
}

/** Rounded block (abdominal "six-pack" segments) with an optional outward lean on the outer edge. */
function block(x0: number, y0: number, x1: number, y1: number, r: number, lean = 0): string {
  return spline([
    [x0 + r + lean, y0],
    [x1 - r, y0],
    [x1, y0 + r],
    [x1, y1 - r],
    [x1 - r, y1],
    [x0 + r, y1],
    [x0, y1 - r],
    [x0 + lean * 0.5, (y0 + y1) / 2],
    [x0 + lean, y0 + r],
  ]);
}

export interface Region {
  muscle: Muscle;
  /** Path for the left half; a mirrored copy is drawn on the right half. */
  d: string;
}

export interface Figure {
  /** Body silhouette (left half, mirrored) — non-muscle tone, no stroke. */
  body: string[];
  /** Non-muscle detail shapes drawn with separators (ears, kneecaps), mirrored. */
  details: string[];
  regions: Region[];
  /** Centered shapes drawn on top (head). */
  top: string[];
}

// ------------------------------------------------------------------ shared silhouette

// prettier-ignore
const SILHOUETTE = spline([
  [100.6, 57.8, 1], [95.4, 56.6], [91.4, 54.4], [88.8, 52, 1], [87.6, 66], [80, 72.5], [68, 77], [56, 80], [48, 86.5], [44.2, 97],
  [42.6, 112], [41.2, 130], [39.8, 150], [38.8, 168], [36.6, 182], [33, 198], [31.4, 216], [32, 234], [33.6, 245],
  // hand
  [30.6, 252], [29, 262], [30, 274], [33.6, 283], [38.6, 287], [43.6, 284], [46.2, 276], [47.2, 264], [46.6, 253],
  [45.8, 246],
  // inner forearm / upper arm
  [46.8, 241], [50.6, 224], [54.6, 204], [57.2, 188], [58.2, 176], [60.2, 160], [62, 140], [63.4, 123, 1],
  // torso side, outer leg
  [65.6, 140], [67.6, 160], [70.6, 184], [69.2, 200], [65.2, 214], [61.6, 232], [59, 252], [58, 272], [59, 296],
  [61.6, 318], [64.4, 336], [64.4, 348], [61.6, 366], [61.4, 386], [64.4, 404], [67.4, 416], [66, 424],
  // foot
  [62.4, 432], [62.8, 439], [70, 442.4], [80, 442.6], [86.6, 439.6], [86.8, 430], [85, 420],
  // inner leg
  [84.6, 412], [88.6, 398], [92, 378], [92.6, 362], [90.6, 348], [90, 338], [91.6, 320], [94.6, 298], [97.6, 276],
  [99.2, 262], [100.6, 255, 1],
]);

// prettier-ignore
const HEAD = spline([
  [100, 8.5], [111.5, 11.5], [118.4, 22], [118.6, 35], [115.4, 46], [108.6, 54], [100, 57.4], [91.4, 54],
  [84.6, 46], [81.4, 35], [81.6, 22], [88.5, 11.5],
]);

// prettier-ignore
const EAR = spline([[82.2, 25.8, 1], [79.6, 27.4], [78.4, 32.6], [79.2, 38.6], [82.2, 42.2, 1], [81.6, 35], [81.7, 29.6]]);

// prettier-ignore
const KNEECAP = spline([
  [77.6, 334], [83.4, 337], [85.2, 344], [82.6, 351], [77.2, 352.6], [72.4, 349], [71.4, 342], [73.4, 336],
]);

// ------------------------------------------------------------------ arms (shared outline)

// prettier-ignore
const UPPER_ARM_FRONT = spline([
  [49.6, 123.5], [55.4, 124.5], [59.6, 132], [60.4, 146], [58.4, 160], [54.6, 171.5], [49.2, 175.6], [43.8, 172],
  [41.4, 160], [41.8, 144], [44.6, 130],
]);

// prettier-ignore
const FOREARM_OUTER = spline([
  [41.6, 180.6, 1], [47.6, 179.2], [46.4, 196], [42.6, 214], [39.8, 231], [38.6, 241.2, 1], [35, 232], [33.4, 214],
  [34.6, 196], [37.6, 186],
]);

// prettier-ignore
const FOREARM_INNER = spline([
  [50, 179.6, 1], [55.8, 183.6], [55.2, 198], [51.4, 216], [47.2, 233], [44.6, 241.6, 1], [41.2, 241.4, 1],
  [42.8, 228], [45.8, 212], [48.6, 196],
]);

// prettier-ignore
const TRICEPS = spline([
  [49.4, 123.6], [55.4, 125], [59.6, 132], [60.8, 146], [59, 160], [55, 171.6], [49.2, 176.4], [43.6, 172],
  [41, 158], [41.4, 142], [44.2, 130],
]);

// ------------------------------------------------------------------ FRONT

// prettier-ignore
const NECK_FRONT = spline([
  [100.6, 57.8, 1], [95.4, 56.6], [91.4, 54.4], [89.2, 52.2, 1], [88.8, 60], [88.6, 67], [90.6, 75], [95.4, 78.6],
  [100.6, 79.6, 1],
]);

// prettier-ignore
const TRAPS_FRONT = spline([[88.4, 59, 1], [86.6, 66.5], [79.6, 72], [69, 76.6, 1], [79, 78.4], [89.6, 77.6, 1]]);

// prettier-ignore
const DELT_FRONT = spline([
  [69.6, 79, 1], [58.6, 80.6], [49.4, 86.6], [45.2, 97], [44.8, 110], [47.4, 121.6], [53, 130.4, 1], [57, 120.6],
  [61, 108], [65.8, 94.6], [72.4, 84.4, 1],
]);

// prettier-ignore
const PEC = spline([
  [99.6, 84, 1], [88.6, 80.6], [77.4, 81.4], [73.4, 84.6, 1], [67.6, 95], [63, 107], [61.4, 116, 1], [66.6, 123.4],
  [75.4, 128.4], [86.4, 129.8], [95, 128.2], [99.6, 125.6, 1],
]);

// prettier-ignore
const SERRATUS = spline([[63.8, 123.6, 1], [70.4, 127.4], [66.2, 134]]);

// prettier-ignore
const OBLIQUE = spline([
  [66.2, 130.4, 1], [75, 132.2], [84.4, 134.8, 1], [84.6, 160], [84.8, 190], [85.6, 211], [86.4, 223.6, 1],
  [79.4, 219.4], [73.2, 212.4], [69.8, 203], [70.2, 186], [68.4, 166], [66.4, 148],
]);

const ABS = [
  block(87, 133, 98.8, 150, 3.2, 0.8),
  block(86.6, 153.4, 98.8, 170.6, 3.2, 0.4),
  block(86.8, 174, 98.8, 191.4, 3.2, 0),
  // prettier-ignore
  spline([[87.4, 195, 1], [98.8, 195, 1], [98.8, 245, 1], [94.4, 239], [90.6, 229], [88.4, 213]]),
];

// prettier-ignore
const TFL = spline([
  [65.6, 214, 1], [69.2, 214.6, 1], [70, 226], [67.8, 238], [63.8, 248.4], [60.2, 253, 1], [59.8, 246], [61.4, 232],
  [63.4, 222],
]);

// prettier-ignore
const ADDUCTOR_FRONT = spline([
  [75.8, 224, 1], [86.4, 235.2], [94.6, 245.4], [98.9, 251.6, 1], [99.4, 262], [97.8, 276], [95.6, 290], [92.8, 301, 1],
  [89.4, 293], [85.6, 278], [81.4, 260], [77.6, 241],
]);

// prettier-ignore
const RECTUS_FEMORIS = spline([
  [70.8, 222, 1], [73.6, 232], [77, 248], [80.8, 266], [84.4, 284], [85.6, 298], [83.6, 316], [79, 331.4, 1],
  [74.8, 328], [72.8, 314], [73.8, 290], [72.8, 262], [70.2, 238],
]);

// prettier-ignore
const VASTUS_LATERALIS = spline([
  [60.2, 254, 1], [65, 247.4], [69.2, 237, 1], [72.4, 262], [73.4, 290], [72.4, 314], [69.8, 331.4, 1], [65, 330],
  [61.8, 318], [59.4, 296], [58.6, 272],
]);

// prettier-ignore
const VASTUS_MEDIALIS = spline([
  [87.8, 289.4, 1], [92.2, 297.6], [93.8, 306], [92.2, 320], [90.4, 334, 1], [84.8, 334.8], [81, 331.6], [84, 318],
  [86.2, 302],
]);

// prettier-ignore
const CALF_OUTER_FRONT = spline([
  [64.4, 350.4, 1], [68.6, 353.6], [68.2, 372], [67.4, 392], [67.8, 408, 1], [64.6, 402], [61.9, 386], [61.9, 368],
]);

// prettier-ignore
const TIBIALIS = spline([
  [70.6, 353.6, 1], [75.8, 357.6], [76.4, 374], [75, 394], [71.8, 412, 1], [69.6, 404], [69.6, 386], [70.6, 368],
]);

// prettier-ignore
const CALF_INNER_FRONT = spline([
  [82.6, 351, 1], [89.6, 354], [92.2, 366], [91.8, 380], [88.8, 394], [85.2, 402, 1], [82.4, 390], [81.2, 374],
  [81.4, 360],
]);

export const FRONT: Figure = {
  body: [SILHOUETTE],
  details: [KNEECAP, EAR],
  regions: [
    { muscle: 'neck', d: NECK_FRONT },
    { muscle: 'traps', d: TRAPS_FRONT },
    { muscle: 'biceps', d: UPPER_ARM_FRONT },
    { muscle: 'forearms', d: FOREARM_OUTER },
    { muscle: 'forearms', d: FOREARM_INNER },
    { muscle: 'abdominals', d: OBLIQUE },
    { muscle: 'abdominals', d: SERRATUS },
    ...ABS.map((d) => ({ muscle: 'abdominals' as const, d })),
    { muscle: 'chest', d: PEC },
    { muscle: 'shoulders', d: DELT_FRONT },
    { muscle: 'abductors', d: TFL },
    { muscle: 'adductors', d: ADDUCTOR_FRONT },
    { muscle: 'quadriceps', d: RECTUS_FEMORIS },
    { muscle: 'quadriceps', d: VASTUS_LATERALIS },
    { muscle: 'quadriceps', d: VASTUS_MEDIALIS },
    { muscle: 'calves', d: CALF_OUTER_FRONT },
    { muscle: 'calves', d: TIBIALIS },
    { muscle: 'calves', d: CALF_INNER_FRONT },
  ],
  top: [HEAD],
};

// ------------------------------------------------------------------ BACK

// prettier-ignore
const TRAPS_BACK = spline([
  [100.6, 57.8, 1], [95.4, 56.6], [91.4, 54.4], [89, 52.4, 1], [88.2, 61], [85.4, 68.4], [78.4, 73.4], [68.4, 77.6, 1],
  [76.8, 84.6], [84.2, 96.6], [90, 112], [95.2, 129], [100.6, 147, 1],
]);

// prettier-ignore
const DELT_BACK = spline([
  [68.6, 79, 1], [58.6, 80.6], [49.4, 86.6], [45.2, 97], [44.8, 110], [47.4, 121.6], [53, 130.4, 1], [57.2, 119],
  [62, 105], [67.6, 93.6], [74.4, 86.6, 1],
]);

// prettier-ignore
const UPPER_BACK = spline([
  [75.6, 88.6, 1], [82.4, 98], [87.8, 111], [91.6, 123], [92.6, 132.4, 1], [84, 134.4], [74, 132], [64.6, 126.4, 1],
  [62.6, 116], [66.2, 103], [70.4, 94],
]);

// prettier-ignore
const LATS = spline([
  [62.8, 129, 1], [74, 134.6], [85.6, 137.4], [94.8, 136.4, 1], [94.2, 150], [91.8, 166], [88, 184], [82.4, 197],
  [74.6, 207.6, 1], [71.6, 196], [69.2, 177], [66.4, 157], [63.6, 141],
]);

// prettier-ignore
const LOWER_BACK = spline([
  [99, 151, 1], [99, 230, 1], [92.4, 231], [87.8, 223], [87.4, 206], [89.4, 187], [92.6, 169], [95.8, 157],
]);

// prettier-ignore
const GLUTE_MED = spline([
  [69.8, 203.4, 1], [78, 207.4], [86.8, 213.2, 1], [76, 217.8], [67, 225.4], [62, 234.4, 1], [63.2, 222], [66.8, 211],
]);

// prettier-ignore
const GLUTES = spline([
  [99.4, 219.6, 1], [99.4, 263, 1], [92, 268.4], [80, 270.4], [70, 266.4], [63.2, 256.4], [61, 243], [63.6, 233],
  [70.4, 224.6], [79.6, 219.6], [89, 217.4],
]);

// prettier-ignore
const HAM_OUTER = spline([
  [60, 262, 1], [66, 268.8], [72.8, 272.6], [78.8, 274.4, 1], [79.4, 298], [78.4, 318], [75.6, 334.4, 1], [69.4, 331],
  [64.2, 318], [60, 298], [58.8, 280],
]);

// prettier-ignore
const HAM_INNER = spline([
  [81.2, 274.6, 1], [87, 274], [91.8, 272.4, 1], [91.6, 290], [90.4, 310], [88.6, 334.6, 1], [83.4, 331],
  [80.8, 316], [80.2, 296],
]);

// prettier-ignore
const ADDUCTOR_BACK = spline([[93.8, 270.6, 1], [98.6, 265.4, 1], [97.6, 278], [95.4, 294], [92.4, 312, 1], [93, 292]]);

// prettier-ignore
const GASTRO_OUTER = spline([
  [64, 352.6], [70.2, 350], [76.6, 352, 1], [77.6, 368], [76.6, 386], [73, 399, 1], [66.6, 392], [62.6, 378],
  [62.4, 362],
]);

// prettier-ignore
const GASTRO_INNER = spline([
  [79.6, 352, 1], [86, 350], [90.8, 356], [92.6, 370], [91, 388], [85.4, 404, 1], [80.8, 392], [79.4, 372],
]);

export const BACK: Figure = {
  body: [SILHOUETTE],
  details: [EAR],
  regions: [
    { muscle: 'triceps', d: TRICEPS },
    { muscle: 'forearms', d: FOREARM_OUTER },
    { muscle: 'forearms', d: FOREARM_INNER },
    { muscle: 'lats', d: LATS },
    { muscle: 'upper_back', d: UPPER_BACK },
    { muscle: 'lower_back', d: LOWER_BACK },
    { muscle: 'traps', d: TRAPS_BACK },
    { muscle: 'shoulders', d: DELT_BACK },
    { muscle: 'abductors', d: GLUTE_MED },
    { muscle: 'glutes', d: GLUTES },
    { muscle: 'hamstrings', d: HAM_OUTER },
    { muscle: 'hamstrings', d: HAM_INNER },
    { muscle: 'adductors', d: ADDUCTOR_BACK },
    { muscle: 'calves', d: GASTRO_OUTER },
    { muscle: 'calves', d: GASTRO_INNER },
  ],
  top: [HEAD],
};

/** Muscles that have a drawn region (cardio / full_body / other are not drawn). */
export const DRAWN_MUSCLES: ReadonlySet<Muscle> = new Set([...FRONT.regions, ...BACK.regions].map((r) => r.muscle));
