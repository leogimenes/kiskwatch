// The enchant math: chances with the bonus per failure (pity), expected cost,
// worst case and how the cost spreads out, from data/enchant.json.
import enchantJson from "../data/enchant.json";

export type Kind = "gear" | "amplify";
export type Grade = keyof typeof enchantJson.grades;

/** One step of a ladder: the chance of the first try, the chance added per failure, and what each try costs. */
export interface Step {
  chance: number;
  pity: number;
  kinah: number;
  stones: number;
}

export const DATA = enchantJson;
export const GRADES = enchantJson.grades as Record<Grade, { label: string; max: number }>;
const KNOWN = enchantJson.gear.known as Record<string, { kinah: number[]; stones: number[] }>;

/** Rounds to 3 significant digits, as the game's cost tables are. */
export function round3(x: number) {
  if (x <= 0) return 0;
  const unit = 10 ** (Math.floor(Math.log10(x)) - 2);
  return Math.round(x / unit) * unit;
}

/** The gear ladder for an item level, and whether its costs come from a published table (true) or the per-level estimate. */
export function gearLadder(itemLevel: number): { steps: Step[]; exact: boolean } {
  const known = KNOWN[String(itemLevel)];
  let exact = true;
  const steps = enchantJson.gear.steps.map((s, i) => {
    if (known && i < known.kinah.length) return { chance: s.chance, pity: s.pity, kinah: known.kinah[i], stones: known.stones[i] };
    exact = false;
    return { chance: s.chance, pity: s.pity, kinah: round3(s.kinah * itemLevel), stones: round3(s.stones * itemLevel) };
  });
  return { steps, exact };
}

export function ladder(kind: Kind, itemLevel: number): { steps: Step[]; exact: boolean } {
  if (kind === "gear") return gearLadder(itemLevel);
  return { steps: enchantJson.amplify.steps.map((s) => ({ ...s })), exact: true };
}

/** The highest amplified level an item level allows, or null when the sources don't say. */
export function amplifyCap(itemLevel: number): number | null {
  let cap: number | null = null;
  for (const [level, max] of enchantJson.amplify.caps) if (itemLevel >= level) cap = max;
  return cap;
}

export const chanceAt = (s: Step, fails: number) => Math.min(1, s.chance + s.pity * fails);

/** Tries until the step succeeds: the average and the most it can take (null without a bonus per failure, when it has no end). */
export function stepTries(s: Step, fails = 0): { mean: number; max: number | null } {
  if (s.chance >= 1) return { mean: 1, max: 1 };
  if (s.pity <= 0) return { mean: 1 / s.chance, max: null };
  let mean = 0, reach = 1, k = 0;
  for (; reach > 0; k++) {
    mean += reach;
    const p = chanceAt(s, fails + k);
    if (p >= 1) break;
    reach *= 1 - p;
  }
  return { mean, max: k + 1 };
}

export interface Plan {
  kind: Kind;
  steps: Step[];
  /** Current level, and the target. */
  from: number;
  to: number;
  /** Failures already made at the current level (they count toward its bonus). */
  fails: number;
}

export interface Totals {
  tries: number;
  kinah: number;
  stones: number;
}

export interface StepCost extends Totals {
  /** The level this step reaches. */
  level: number;
  step: Step;
  chance: number;
  max: number | null;
}

/** Average tries and cost of each step from `from` to `to`, and the sum. */
export function expected(p: Plan): { steps: StepCost[]; total: Totals; worst: Totals | null } {
  const steps: StepCost[] = [];
  for (let i = p.from; i < p.to; i++) {
    const s = p.steps[i], fails = i === p.from ? p.fails : 0;
    const { mean, max } = stepTries(s, fails);
    steps.push({ level: i + 1, step: s, chance: chanceAt(s, fails), max, tries: mean, kinah: mean * s.kinah, stones: mean * s.stones });
  }
  const sum = (key: keyof Totals) => steps.reduce((n, s) => n + s[key], 0);
  const total = { tries: sum("tries"), kinah: sum("kinah"), stones: sum("stones") };
  const worst = steps.some((s) => s.max === null) ? null : {
    tries: steps.reduce((n, s) => n + s.max!, 0),
    kinah: steps.reduce((n, s) => n + s.max! * s.step.kinah, 0),
    stones: steps.reduce((n, s) => n + s.max! * s.step.stones, 0),
  };
  return { steps, total, worst };
}

/** A small seeded generator, so the same inputs always show the same numbers. */
function mulberry32(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** One run from `from` to `to`. */
function run(p: Plan, rand: () => number): Totals {
  const t = { tries: 0, kinah: 0, stones: 0 };
  let level = p.from, fails = p.fails;
  while (level < p.to) {
    const s = p.steps[level];
    t.tries++;
    t.kinah += s.kinah;
    t.stones += s.stones;
    if (rand() < chanceAt(s, fails)) {
      level++;
      fails = 0;
    } else {
      fails++;
    }
  }
  return t;
}

export interface Spread {
  runs: number;
  /** Totals sorted by Kinah, the cost that runs out first. */
  sorted: Totals[];
}

/** Simulates many runs to see how the cost spreads out. */
export function simulate(p: Plan, runs = 20_000): Spread {
  const rand = mulberry32(p.from * 1000 + p.to * 31 + p.fails + 7);
  const sorted = Array.from({ length: runs }, () => run(p, rand)).sort((a, b) => a.kinah - b.kinah);
  return { runs, sorted };
}

/** The run at a share of all runs: 0.1 is a lucky one, 0.5 the typical, 0.9 an unlucky one. */
export const percentile = (s: Spread, q: number) => s.sorted[Math.min(s.sorted.length - 1, Math.floor(q * s.sorted.length))];

/** The share of runs that reach the target without spending more than this (null = no limit). */
export function chanceWithin(s: Spread, kinah: number | null, stones: number | null) {
  const ok = s.sorted.filter((t) => (kinah === null || t.kinah <= kinah) && (stones === null || t.stones <= stones)).length;
  return ok / s.sorted.length;
}
