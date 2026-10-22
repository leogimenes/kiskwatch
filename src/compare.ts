// Two builds side by side: what each one has, row by row, for the Group tab.
// Everything here reads the official profile only (no game data needed).
import { BoardNode, Profile, ProfileItem, ProfileSkill } from "./api";

/** A row of a comparison: the same thing on each side, if it has it. */
export interface Pair<T> {
  key: string;
  label: string;
  mine?: T;
  theirs?: T;
}

/** The keys of both lists, theirs first (they're the one being looked at),
 *  then whatever only you have. */
function pairs<T>(mine: T[], theirs: T[], key: (x: T) => string, label: (x: T) => string): Pair<T>[] {
  const a = new Map(mine.map((x) => [key(x), x]));
  const b = new Map(theirs.map((x) => [key(x), x]));
  const keys = [...b.keys(), ...[...a.keys()].filter((k) => !b.has(k))];
  return keys.map((k) => ({ key: k, label: label((b.get(k) ?? a.get(k))!), mine: a.get(k), theirs: b.get(k) }));
}

export const sameClass = (a: Profile | null, b: Profile) => !!a && !!a.info.profile && a.info.profile.className === b.info.profile?.className;

const statsOf = (p: Profile | null) => p?.info.stat?.statList ?? [];

/** Attributes by type: value on each side. */
export function stats(mine: Profile | null, theirs: Profile): Pair<number>[] {
  return pairs(statsOf(mine), statsOf(theirs), (s) => s.type, (s) => s.name).map((r) => ({
    ...r,
    mine: statsOf(mine).find((s) => s.type === r.key)?.value,
    theirs: statsOf(theirs).find((s) => s.type === r.key)?.value,
  }));
}

/** The item level, from the attributes. */
export const itemLevel = (p: Profile | null) => statsOf(p).find((s) => s.type === "ItemLevel")?.value;

const gearOf = (p: Profile | null) => p?.equipment.equipment?.equipmentList ?? [];

/** Equipment by slot, in the game's slot order. */
export function gear(mine: Profile | null, theirs: Profile): Pair<ProfileItem>[] {
  return pairs(gearOf(mine), gearOf(theirs), (i) => String(i.slotPos), (i) => i.slotPosName)
    .sort((x, y) => Number(x.key) - Number(y.key));
}

/** An item's strength in one number: enchant, then exceed on top. */
export const itemPower = (i?: ProfileItem) => (i ? i.enchantLevel + (i.exceedLevel ?? 0) : 0);

const skillsOf = (p: Profile | null) => p?.equipment.skill?.skillList ?? [];
export const skillLevel = (s?: ProfileSkill) => (s?.acquired ? s.skillLevel : 0);

/** Skills by id, with the category they're in. Only means something
 *  between two characters of the same class. */
export function skills(mine: Profile | null, theirs: Profile): (Pair<ProfileSkill> & { category: string; gap: number })[] {
  return pairs(skillsOf(mine), skillsOf(theirs), (s) => String(s.id), (s) => s.name).map((r) => ({
    ...r,
    category: (r.theirs ?? r.mine)!.category,
    gap: skillLevel(r.theirs) - skillLevel(r.mine),
  }));
}

/** A skill row worth showing by default: a different level or slot. */
export const differs = (r: { mine?: ProfileSkill; theirs?: ProfileSkill; gap: number }) => r.gap !== 0 || !!r.mine?.equip !== !!r.theirs?.equip;

const boardsOf = (p: Profile | null) => p?.info.daevanion?.boardList ?? [];

export interface BoardPair {
  id: number;
  name: string;
  icon: string;
  total: number;
  mine: number;
  theirs: number;
  /** Nodes open on their board and closed on yours (same class only, with both boards read). */
  ahead: BoardNode[];
  /** And the other way around. */
  behind: BoardNode[];
}

const openNodes = (p: Profile | null, board: number) =>
  new Map((p?.boards[String(board)]?.nodeList ?? []).filter((n) => n.open && n.type !== "Start").map((n) => [n.nodeId, n]));

export function boards(mine: Profile | null, theirs: Profile): BoardPair[] {
  const same = sameClass(mine, theirs);
  return pairs(boardsOf(mine), boardsOf(theirs), (b) => String(b.id), (b) => b.name).map((r) => {
    const id = Number(r.key);
    const b = (r.theirs ?? r.mine)!;
    const read = same && !!mine?.boards[r.key]?.nodeList && !!theirs.boards[r.key]?.nodeList;
    const a = read ? openNodes(mine, id) : new Map<number, BoardNode>();
    const t = read ? openNodes(theirs, id) : new Map<number, BoardNode>();
    return {
      id,
      name: r.label,
      icon: b.icon,
      total: b.totalNodeCount,
      mine: r.mine?.openNodeCount ?? 0,
      theirs: r.theirs?.openNodeCount ?? 0,
      ahead: [...t.values()].filter((n) => !a.has(n.nodeId)),
      behind: [...a.values()].filter((n) => !t.has(n.nodeId)),
    };
  });
}

/** Nodes by what they give: "Ataque +5" ×3. */
export function grouped(nodes: BoardNode[]): { text: string; count: number }[] {
  const by = new Map<string, number>();
  for (const n of nodes) {
    const text = n.effectList?.map((e) => e.desc).join(", ") || n.name;
    by.set(text, (by.get(text) ?? 0) + 1);
  }
  return [...by].map(([text, count]) => ({ text, count })).sort((a, b) => b.count - a.count || a.text.localeCompare(b.text));
}

/** "+12" / "−3" / "=" for theirs against yours. */
export function delta(mine: number | undefined, theirs: number | undefined): { text: string; sign: -1 | 0 | 1 } {
  const d = (theirs ?? 0) - (mine ?? 0);
  if (!d) return { text: "=", sign: 0 };
  return { text: `${d > 0 ? "+" : "−"}${Math.abs(d).toLocaleString("pt-BR")}`, sign: d > 0 ? 1 : -1 };
}
