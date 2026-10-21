// What is being farmed, from the souls the game reported, and the nearest
// pet to farm after it.
import { SoulSeen } from "./api";
import { Drop, PETS, Pet, soulsToMax } from "./data";

/** A soul within this long means the pet is still being farmed. */
export const FARMING_MS = 30 * 60_000;

export type Progress = (pet: number) => { level: number; points: number };

export function farming(souls: SoulSeen[], now: number): SoulSeen | null {
  const last = souls[souls.length - 1];
  return last && now - last.at_ms <= FARMING_MS ? last : null;
}

/** The last `n` pets with a soul picked up, newest first, one entry each,
 *  with the souls picked up for each in that stretch. */
export function recent(souls: SoulSeen[], n: number, skip: (pet: number) => boolean): { pet: number; at_ms: number; amount: number }[] {
  const out: { pet: number; at_ms: number; amount: number }[] = [];
  for (let i = souls.length - 1; i >= 0; i--) {
    const s = souls[i];
    if (skip(s.pet)) continue;
    const seen = out.find((o) => o.pet === s.pet);
    if (seen) seen.amount += s.amount;
    else if (out.length < n) out.push({ pet: s.pet, at_ms: s.at_ms, amount: s.amount });
  }
  return out;
}

const dist = (a: [number, number], b: [number, number]) => Math.hypot(a[0] - b[0], a[1] - b[1]);

/** The pet with souls missing whose monster spawns nearest the one being
 *  farmed, on the same map. A stand-in until the farm route lands. */
export function nextPet(current: number, progress: Progress): { pet: Pet; drop: Drop } | null {
  const here = PETS.find((p) => p.id === current)?.drops.filter((d) => d.kibelisk) ?? [];
  let best: { pet: Pet; drop: Drop; m: number } | null = null;
  for (const pet of PETS) {
    if (pet.id === current || pet.genus === "special" || pet.unreleased) continue;
    const g = progress(pet.id);
    if (soulsToMax(g.level, g.points) === 0) continue;
    for (const drop of pet.drops) {
      if (!drop.kibelisk) continue;
      for (const from of here) {
        if (from.mapId !== drop.mapId) continue;
        const m = dist(from.kibelisk!.at, drop.kibelisk.at);
        if (!best || m < best.m) best = { pet, drop, m };
      }
    }
  }
  return best && { pet: best.pet, drop: best.drop };
}
