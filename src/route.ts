// The farm route: an order to visit pets' monsters in that takes the least
// travel, walking or taking a Kibelisk. Each pet can be farmed on any of
// its monsters, so the route also picks which one.
import { Drop, Pet } from "./data";

/** What a Kibelisk jump costs, as meters walked: the cast and the loading. */
export const TELEPORT_M = 150;

export interface Option { pet: Pet; drops: Drop[]; }
export interface Stop { pet: Pet; drop: Drop; }
export interface Leg { m: number; teleport: boolean; }

/** Game units are centimeters. */
const meters = (a: [number, number], b: [number, number]) => Math.hypot(a[0] - b[0], a[1] - b[1]) / 100;

/** From one spawn to another: on foot, or by the Kibelisk nearest the next. */
export function leg(from: Drop, to: Drop): Leg {
  const walk = meters(from.kibelisk!.at, to.kibelisk!.at);
  const jump = TELEPORT_M + to.kibelisk!.m;
  return walk <= jump ? { m: walk, teleport: false } : { m: jump, teleport: true };
}

const cost = (stops: Stop[]) => stops.reduce((sum, s, i) => (i ? sum + leg(stops[i - 1].drop, s.drop).m : 0), 0);

/** Nearest neighbor from a first stop. */
function greedy(options: Option[], first: Stop): Stop[] {
  const out = [first];
  const left = options.filter((o) => o.pet.id !== first.pet.id);
  while (left.length) {
    const here = out[out.length - 1].drop;
    let best = { i: 0, drop: left[0].drops[0], m: Infinity };
    left.forEach((o, i) => o.drops.forEach((drop) => {
      const m = leg(here, drop).m;
      if (m < best.m) best = { i, drop, m };
    }));
    out.push({ pet: left[best.i].pet, drop: best.drop });
    left.splice(best.i, 1);
  }
  return out;
}

/** Better orders by reversing stretches (2-opt) and better monsters per pet,
 *  until neither helps. Stops before `from` stay as they are. */
function improve(route: Stop[], options: Option[], from: number): Stop[] {
  let best = route, bestCost = cost(route);
  for (let pass = 0, better = true; better && pass < 30; pass++) {
    better = false;
    for (let i = from; i < best.length - 1; i++) {
      for (let j = i + 1; j < best.length; j++) {
        const next = [...best.slice(0, i), ...best.slice(i, j + 1).reverse(), ...best.slice(j + 1)];
        const c = cost(next);
        if (c < bestCost - 0.5) { best = next; bestCost = c; better = true; }
      }
    }
    for (let i = from; i < best.length; i++) {
      const drops = options.find((o) => o.pet.id === best[i].pet.id)?.drops ?? [];
      for (const drop of drops) {
        if (drop === best[i].drop) continue;
        const next = best.map((s, k) => (k === i ? { pet: s.pet, drop } : s));
        const c = cost(next);
        if (c < bestCost - 0.5) { best = next; bestCost = c; better = true; }
      }
    }
  }
  return best;
}

/** The route through every option, starting wherever makes it shortest, or at
 *  `start` when given (the pet being farmed). */
export function plan(options: Option[], start?: Stop): Stop[] {
  const usable = options.map((o) => ({ pet: o.pet, drops: o.drops.filter((d) => d.kibelisk) })).filter((o) => o.drops.length);
  if (!usable.length) return [];
  const firsts = start ? [start] : usable.flatMap((o) => o.drops.map((drop) => ({ pet: o.pet, drop })));
  // Every first stop for small lists; a spread of them for big ones.
  const step = Math.max(1, Math.ceil(firsts.length / 40));
  let best: Stop[] = [], bestCost = Infinity;
  for (let i = 0; i < firsts.length; i += step) {
    const r = greedy(usable, firsts[i]);
    const c = cost(r);
    if (c < bestCost) { best = r; bestCost = c; }
  }
  return improve(best, usable, start ? 1 : 0);
}

/** Totals for the route: meters on foot and Kibelisk jumps. */
export function totals(stops: Stop[]) {
  let walk = 0, jumps = 0;
  for (let i = 1; i < stops.length; i++) {
    const l = leg(stops[i - 1].drop, stops[i].drop);
    if (l.teleport) { jumps++; walk += stops[i].drop.kibelisk!.m; } else walk += l.m;
  }
  return { walk: Math.round(walk), jumps };
}
