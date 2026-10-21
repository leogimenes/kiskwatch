// The game data the Build tab measures a profile against, from dbaion2.ru
// (downloaded and cached by the app): what each level gives, where the other
// skill points come from, and every Daevanion node with its cost.
import { BoardDetail, BoardNode, Profile, ProfileSkill, gameData } from "./api";

export interface PointSource { kind: string; name: string; points: number; list: { name: string; points: number; limit?: number; price?: number }[] }

export interface SkillPoints {
  /** [character level, skill points, stigma points] */
  level: [number, number, number][];
  Light: PointSource[];
  Dark: PointSource[];
}

/** [row-ish, col-ish, kind, grade, label, key, value, cost, needLevel] */
type NodeRow = [number, number, string, string, string, string, number | null, number, number];

export interface Board { id: number; name: string; needLevel: number; pointType: string; nodes: NodeRow[] }

export interface Daevanion {
  points: Record<string, { name: string; max: number }>;
  classes: Record<string, { name: string; boards: Board[] }>;
}

/** A skill as dbaion2 lists it (English text): what each level does and the
 *  specializations its levels unlock. */
export interface Skill {
  id: number; name: string; description: string; classType: string; icon: string; type: "active" | "passive"; isStigma: boolean;
  acquireLevel: number; maxLevel: number; cooldownSec: number; castTimeSec: number;
  levels?: { level: number; description: string; cooldownSec: number; castTimeSec: number }[];
  parts?: { id: number; level: number; desc: string; icon: string }[];
}

export interface GameData { points: SkillPoints; daevanion: Daevanion; skills: Map<number, Skill> }

let loading: Promise<GameData> | null = null;

/** The files, once per run. Without the skills (the largest file) the rest
 *  still shows, just without skill details and node icons. */
export function loadGameData(): Promise<GameData> {
  const skills = () => gameData<Skill[]>("skills").then((l) => new Map(l.map((s) => [s.id, s])), () => new Map<number, Skill>());
  loading ??= Promise.all([gameData<SkillPoints>("skill-points"), gameData<Daevanion>("daevanion"), skills()])
    .then(([points, daevanion, skills]) => ({ points, daevanion, skills }))
    .catch((e) => { loading = null; throw e; });
  return loading;
}

/** Points from the character's level: skill points and stigma points. */
export function levelPoints(data: GameData, level: number): { skill: number; stigma: number } {
  const rows = data.points.level;
  const row = rows.find((r) => r[0] === level) ?? rows[rows.length - 1];
  return { skill: row[1], stigma: row[2] };
}

/** The point sources on the character's side (Elyos: Light, Asmodian: Dark). */
export function sources(data: GameData, p: Profile): PointSource[] {
  return p.info.profile?.raceId === 2 ? data.points.Dark : data.points.Light;
}

/** The board with this id, whichever class it belongs to, and that class's boards. */
export function findBoard(data: GameData, id: number): { board: Board; boards: Board[] } | null {
  for (const c of Object.values(data.daevanion.classes)) {
    const board = c.boards.find((b) => b.id === id);
    if (board) return { board, boards: c.boards };
  }
  return null;
}

/** Every node's cost on a board: what opening all of it takes. */
export const boardCost = (board: Board) => board.nodes.reduce((n, x) => n + x[7], 0);

/** The official CDN's address for a game icon name. */
export const iconUrl = (name: string) => `https://assets.playnccdn.com/static-aion2-gamedata/resources/${name}.png`;

/** One node of a whole board: the game's data, with what the profile says of it. */
export interface Cell {
  row: number; col: number; kind: "start" | "stat" | "skill"; grade: string; name: string; effect: string;
  cost: number; open: boolean; skillId: number | null; icon: string;
}

/** Every node on a board, open or not. With the game's data the whole board
 *  shows even before the character opens it; the profile's own nodes (in
 *  Portuguese) take its place where they match. Without the data, the
 *  profile's nodes are all there is. */
export function cells(board: Board | null, detail: BoardDetail | null, skillList: ProfileSkill[], skills: Map<number, Skill>): Cell[] {
  const nodes = detail?.nodeList ?? [];
  const bySkillName = new Map(skillList.map((s) => [s.name, s]));
  const skillOf = (name: string) => bySkillName.get(name.replace(/^.*? - /, ""));
  if (!board) {
    return nodes.map((n) => {
      const s = n.type === "Skill" ? skillOf(n.name) : undefined;
      return { row: n.row, col: n.col, kind: n.type === "Start" ? "start" : n.type === "Skill" ? "skill" : "stat", grade: n.grade, name: n.name,
        effect: n.effectList.map((e) => e.desc).join(", "), cost: 0, open: !!n.open, skillId: s?.id ?? null, icon: s?.icon ?? "" };
    });
  }
  const flip = orientation(board, nodes);
  const byPlace = new Map(nodes.map((n) => [`${n.row},${n.col}`, n]));
  return board.nodes.map((x) => {
    const [row, col] = flip ? [x[1], x[0]] : [x[0], x[1]];
    const n = byPlace.get(`${row},${col}`);
    const kind = x[2] === "S" ? "start" : x[2] === "K" ? "skill" : "stat";
    const skillId = kind === "skill" ? Number(x[5]) || null : null;
    const known = skillId != null ? skills.get(skillId) : undefined;
    const mine = skillId != null ? skillList.find((s) => s.id === skillId) ?? (n ? skillOf(n.name) : undefined) : undefined;
    const icon = mine?.icon || (known ? iconUrl(known.icon) : "");
    const effect = n?.effectList.map((e) => e.desc).join(", ") || (kind === "stat" ? `${x[4]} +${x[6]}` : kind === "skill" ? `${x[4]} +${x[6] ?? 1}` : "");
    return { row, col, kind, grade: x[3], name: n?.name || mine?.name || x[4], effect, cost: x[7], open: kind === "start" || !!n?.open, skillId, icon };
  });
}

/** Whether the profile places this board's nodes with the data's two
 *  coordinates swapped: whichever way matches more of them. */
function orientation(board: Board, nodes: BoardNode[]): boolean {
  if (!nodes.length) return false;
  const count = (flip: boolean) => {
    const places = new Set(board.nodes.map((n) => (flip ? `${n[1]},${n[0]}` : `${n[0]},${n[1]}`)));
    return nodes.filter((n) => places.has(`${n.row},${n.col}`)).length;
  };
  return count(true) > count(false);
}

/** How many skill levels the open Daevanion nodes add to each skill. */
export function boardLevels(all: Cell[][]): Map<number, number> {
  const out = new Map<number, number>();
  for (const c of all.flat()) if (c.open && c.skillId != null) out.set(c.skillId, (out.get(c.skillId) ?? 0) + 1);
  return out;
}
