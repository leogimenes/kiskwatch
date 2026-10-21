// The game data Kiskwatch ships (data/*.json, imported from A2Tools-Plugins),
// and the words to show for its keys.
import textJson from "../data/text.json";
import petsJson from "../data/pets.json";
import serversJson from "../data/servers.json";
import genusJson from "../data/genus.json";

export type Texts = { pt?: string; en?: string };

export interface Kibelisk {
  at: [number, number];
  m: number;
  name: string;
  teleport: number;
  to: [number, number];
}

export interface Drop {
  npcId: number;
  npc: string;
  level: number;
  chance: string;
  region: string;
  map: string;
  mapId: number;
  zones: string[];
  spawns: number;
  kibelisk: Kibelisk | null;
}

export interface Pet {
  id: number;
  name: Texts;
  genus: string | null;
  unreleased: boolean;
  drops: Drop[];
  chests: { name: string; chance: string; from: string[] }[];
}

export interface Server {
  id: number;
  name: string;
  region: number;
  side: "elyos" | "asmodian";
}

const TEXT = textJson as Record<string, Texts>;

export const PETS = petsJson as Pet[];
export const SERVERS = serversJson as Server[];
export const GENUS = genusJson as Record<string, Texts>;

export const REGIONS: Record<number, string> = {
  1: "América do Norte (Leste)",
  2: "América do Norte (Oeste)",
  3: "Europa",
  4: "América do Sul",
  5: "Ásia",
};

/** The words for a key in Portuguese, else English, else the key. */
export const t = (key: string): string => TEXT[key]?.pt ?? TEXT[key]?.en ?? key;
export const name = (texts: Texts): string => texts.pt ?? texts.en ?? "";

/** Souls each level takes: 0 to 1, 1 to 2, 2 to 3. */
export const SOULS_PER_LEVEL = [5, 25, 75];
export const soulsToMax = (level: number, points: number): number =>
  Math.max(0, SOULS_PER_LEVEL.slice(Math.min(level, 3)).reduce((a, b) => a + b, 0) - points);

/** A pet type's letter, so it reads without color too. */
export const GENUS_MARK: Record<string, string> = { cogni: "I", fera: "F", natura: "N", varian: "V", special: "E" };

/** The current level's souls: how many it takes and how many are in. */
export function levelProgress(level: number, points: number): { need: number; have: number } | null {
  if (level >= SOULS_PER_LEVEL.length) return null;
  const need = SOULS_PER_LEVEL[level];
  return { need, have: Math.min(points, need) };
}

export const PET_BY_ID = new Map(PETS.map((p) => [p.id, p]));

/** The page that shows a monster's spawns on the game's map art (Aion 2 Timers). */
export function mapLink(d: Drop): string {
  const q = new URLSearchParams({ map: String(d.mapId), pet: String(d.npcId), lang: "pt" });
  const en = TEXT[d.npc]?.en;
  if (en) q.set("petName", en);
  if (d.kibelisk) {
    q.set("x", String(Math.round(d.kibelisk.at[0])));
    q.set("y", String(Math.round(d.kibelisk.at[1])));
  }
  return `https://www.aion2timers.com/map/?${q}`;
}
