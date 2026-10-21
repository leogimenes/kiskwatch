// The game data the Build tab measures a profile against, from dbaion2.ru
// (downloaded and cached by the app): what each level gives, where the other
// skill points come from, and every Daevanion node with its cost.
import { BoardNode, Profile, gameData } from "./api";

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

export interface GameData { points: SkillPoints; daevanion: Daevanion }

let loading: Promise<GameData> | null = null;

/** Both files, once per run. */
export function loadGameData(): Promise<GameData> {
  loading ??= Promise.all([gameData<SkillPoints>("skill-points"), gameData<Daevanion>("daevanion")])
    .then(([points, daevanion]) => ({ points, daevanion }))
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

/** The crystals the open nodes cost. The profile places nodes by row and
 *  column; the data's two coordinates are tried both ways round, keeping the
 *  one that matches more nodes. */
export function spent(board: Board, nodes: BoardNode[]): { crystals: number; matched: number } {
  const open = nodes.filter((n) => n.open);
  let best = { crystals: 0, matched: -1 };
  for (const flip of [false, true]) {
    const cost = new Map(board.nodes.map((n) => [flip ? `${n[1]},${n[0]}` : `${n[0]},${n[1]}`, n[7]]));
    let crystals = 0, matched = 0;
    for (const n of open) {
      const c = cost.get(`${n.row},${n.col}`);
      if (c != null) { crystals += c; matched++; }
    }
    if (matched > best.matched) best = { crystals, matched };
  }
  return best;
}

/** Every node's cost on a board: what opening all of it takes. */
export const boardCost = (board: Board) => board.nodes.reduce((n, x) => n + x[7], 0);
