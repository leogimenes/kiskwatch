// What goes under the pets map's points: the zones, drawn from where the
// monsters spawn, and the player's own print of the game's map, aligned by
// three Kibelisks. The map art is the game's, so the app never ships it: a
// print stays on the player's PC.

export type Pt = [number, number];

// ---- Zones ----

export interface ZoneShape {
  zone: string;
  /** Path data of the zone's area, in map units. */
  fill: string;
  /** Path data of the zone's edges: its outside and where it meets another zone. */
  edge: string;
  /** Where its name goes. */
  label: Pt;
}

/**
 * Each spawn claims the ground nearer to it than to any other spawn, up to
 * `reach` away, and a zone is the ground its spawns claim. The data has one
 * point per monster, so this is a sketch of the zones, not their real shape.
 */
export function zoneShapes(points: { zone: string; p: Pt }[], reach: number): ZoneShape[] {
  // The same spot can come twice, from two monsters.
  const seen = new Set<string>();
  const pts = points.filter(({ p }) => { const k = `${Math.round(p[0])},${Math.round(p[1])}`; return !seen.has(k) && !!seen.add(k); });
  const byZone = new Map<string, { fill: string[]; edge: string[]; xs: number[]; ys: number[] }>();
  pts.forEach(({ zone, p }, i) => {
    // A circle, clipped by the line halfway to every other spawn. Each edge
    // remembers what cut it: -1 for the circle, or the other spawn.
    let poly: { v: Pt; by: number }[] = [];
    for (let a = 0; a < 40; a++) {
      const ang = (a / 40) * 2 * Math.PI;
      poly.push({ v: [p[0] + reach * Math.cos(ang), p[1] + reach * Math.sin(ang)], by: -1 });
    }
    pts.forEach(({ p: q }, j) => {
      if (j === i || Math.hypot(q[0] - p[0], q[1] - p[1]) > 2 * reach) return;
      poly = clip(poly, p, q, j);
    });
    if (poly.length < 3) return;
    const z = byZone.get(zone) ?? { fill: [], edge: [], xs: [], ys: [] };
    byZone.set(zone, z);
    z.fill.push(`M${poly.map(({ v }) => `${r(v[0])},${r(v[1])}`).join("L")}Z`);
    poly.forEach(({ v, by }, k) => {
      if (by >= 0 && pts[by].zone === zone) return;
      const w = poly[(k + 1) % poly.length].v;
      z.edge.push(`M${r(v[0])},${r(v[1])}L${r(w[0])},${r(w[1])}`);
    });
    z.xs.push(p[0]);
    z.ys.push(p[1]);
  });
  return [...byZone].map(([zone, z]) => ({
    zone,
    fill: z.fill.join(""),
    edge: z.edge.join(""),
    label: [z.xs.reduce((a, b) => a + b, 0) / z.xs.length, z.ys.reduce((a, b) => a + b, 0) / z.ys.length],
  }));
}

const r = (n: number) => Math.round(n * 10) / 10;

/** Keep the part of a convex polygon nearer to `p` than to `q`. */
function clip(poly: { v: Pt; by: number }[], p: Pt, q: Pt, j: number) {
  const n: Pt = [q[0] - p[0], q[1] - p[1]];
  const c = (n[0] * (p[0] + q[0]) + n[1] * (p[1] + q[1])) / 2;
  const side = (v: Pt) => n[0] * v[0] + n[1] * v[1] - c;
  const out: { v: Pt; by: number }[] = [];
  poly.forEach((a, k) => {
    const b = poly[(k + 1) % poly.length];
    const sa = side(a.v), sb = side(b.v);
    if (sa <= 0) out.push(a);
    if ((sa <= 0) !== (sb <= 0)) {
      const t = sa / (sa - sb);
      const v: Pt = [a.v[0] + t * (b.v[0] - a.v[0]), a.v[1] + t * (b.v[1] - a.v[1])];
      // Leaving: the new edge runs along the cut. Entering: the rest of a's edge.
      out.push({ v, by: sa <= 0 ? j : a.by });
    }
  });
  return out;
}

/** A spread of colors, one per zone, that neighbors rarely share. */
export const zoneColor = (i: number) => `hsl(${Math.round((i * 137.5) % 360)} 55% 62%)`;

// ---- Affine maps ----

/** `[a, b, c, d, e, f]`: x' = a·x + c·y + e, y' = b·x + d·y + f, as in SVG. */
export type Affine = [number, number, number, number, number, number];

export const apply = (m: Affine, p: Pt): Pt => [m[0] * p[0] + m[2] * p[1] + m[4], m[1] * p[0] + m[3] * p[1] + m[5]];

export function invert(m: Affine): Affine | null {
  const det = m[0] * m[3] - m[1] * m[2];
  if (Math.abs(det) < 1e-12) return null;
  const [a, b, c, d] = [m[3] / det, -m[1] / det, -m[2] / det, m[0] / det];
  return [a, b, c, d, -(a * m[4] + c * m[5]), -(b * m[4] + d * m[5])];
}

/** The map that takes three points to three others, or null if they are in a line. */
export function solveAffine(from: Pt[], to: Pt[]): Affine | null {
  const [[x1, y1], [x2, y2], [x3, y3]] = from;
  const det = x1 * (y2 - y3) - y1 * (x2 - x3) + (x2 * y3 - x3 * y2);
  // Points almost in a line make a wild stretch.
  const span = Math.max(Math.hypot(x2 - x1, y2 - y1), Math.hypot(x3 - x1, y3 - y1), Math.hypot(x3 - x2, y3 - y2));
  if (!span || Math.abs(det) < 0.05 * span * span) return null;
  // Solve [x y 1]·k = u for each output coordinate (Cramer).
  const solve = (u: number[]) => {
    const [u1, u2, u3] = u;
    return [
      (u1 * (y2 - y3) - y1 * (u2 - u3) + (u2 * y3 - u3 * y2)) / det,
      (x1 * (u2 - u3) - u1 * (x2 - x3) + (x2 * u3 - x3 * u2)) / det,
      (x1 * (y2 * u3 - y3 * u2) - y1 * (x2 * u3 - x3 * u2) + u1 * (x2 * y3 - x3 * y2)) / det,
    ];
  };
  const [a, c, e] = solve(to.map((p) => p[0]));
  const [b, d, f] = solve(to.map((p) => p[1]));
  return [a, b, c, d, e, f];
}

// ---- The player's print ----

export interface Print {
  image: Blob;
  w: number;
  h: number;
  /** From the image's pixels to the game's world units, once aligned. */
  toWorld: Affine | null;
  /** How opaque, 0.1..1. */
  opacity: number;
}

const DB = "kiskwatch-map";
const STORE = "prints";

function db(): Promise<IDBDatabase> {
  return new Promise((ok, fail) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => ok(req.result);
    req.onerror = () => fail(req.error);
  });
}

async function run<T>(mode: IDBTransactionMode, op: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const d = await db();
  return new Promise((ok, fail) => {
    const req = op(d.transaction(STORE, mode).objectStore(STORE));
    req.onsuccess = () => ok(req.result);
    req.onerror = () => fail(req.error);
  }).finally(() => d.close()) as Promise<T>;
}

/** The print saved for a map, if any. */
export const getPrint = (mapId: number) => run<Print | undefined>("readonly", (s) => s.get(mapId)).catch(() => undefined);
export const putPrint = (mapId: number, p: Print) => run("readwrite", (s) => s.put(p, mapId));
export const deletePrint = (mapId: number) => run("readwrite", (s) => s.delete(mapId));

/** Read an image file, made smaller if it is huge so it keeps well. */
export async function readPrint(file: File): Promise<Pick<Print, "image" | "w" | "h">> {
  const bmp = await createImageBitmap(file);
  const k = Math.min(1, 3000 / Math.max(bmp.width, bmp.height));
  if (k === 1 && file.size < 8e6) return { image: file, w: bmp.width, h: bmp.height };
  const c = document.createElement("canvas");
  c.width = Math.round(bmp.width * k);
  c.height = Math.round(bmp.height * k);
  c.getContext("2d")!.drawImage(bmp, 0, 0, c.width, c.height);
  const image = await new Promise<Blob>((ok, fail) => c.toBlob((b) => (b ? ok(b) : fail(new Error("imagem"))), "image/jpeg", 0.9));
  return { image, w: c.width, h: c.height };
}
