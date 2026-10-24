// The report of the codes Kiskwatch couldn't name, from the saved recordings
// (see share.ts): only codes and what helps tell them apart.
import { Fight, Saved } from "./api";
import { Skill } from "./buildData";
import namesJson from "../data/npc_names.json";
import bossNamesJson from "../data/boss_names.json";
import abnormalsJson from "../data/abnormals.json";
import { sharedName } from "./sharedNames";

const NAMES = namesJson as { npcs: Record<string, string>; skills: Record<string, string> };
const BOSSES = bossNamesJson as Record<string, string>;
const ABNORMALS = abnormalsJson as Record<string, string[]>;

/** A monster without a name, with what helps find it. */
interface NpcCode { code: number; boss: boolean; fights: number; max_group_damage: number; skills: number[] }
interface NpcSkillCode { code: number; npc: number; hits: number; avg: number; max: number }
interface PlayerSkillCode { code: number; class: string | null; hits: number }
interface EffectCode { code: number; skill: number | null }

export interface Report {
  npcs: NpcCode[]; npc_skills: NpcSkillCode[]; skills: PlayerSkillCode[]; effects: EffectCode[];
  /** What the player wrote, if anything. */
  note: string;
}

/** Basic attacks and theostones have no name anywhere, and need none. */
const unnamedOnPurpose = (id: number) =>
  (id >= 10_000_000 && id <= 19_999_999 && Math.floor(id / 10_000) % 100 === 0) || (id >= 30_000_000 && id <= 30_999_999);

const npcKnown = (code: number) => !code || !!NAMES.npcs[code] || !!BOSSES[code] || !!sharedName("npcs", code);

/** The unnamed codes in the saved recordings, less those already sent, and
 *  their keys ("npc:123"). Player skills count only once dbaion2's list is in. */
export function collect(fights: Fight[], saved: Saved, sent: Set<string>, known: Map<number, Skill> | null): { report: Report; keys: string[] } {
  const npcs = new Map<number, NpcCode>();
  const npcSkills = new Map<number, NpcSkillCode & { damage: number }>();
  const skills = new Map<number, PlayerSkillCode>();
  const effects = new Map<number, EffectCode>();
  const mine = new Set((saved.profile?.equipment.skill?.skillList ?? []).map((s) => s.id));
  const npc = (code: number, boss: boolean) => {
    let n = npcs.get(code);
    if (!n) npcs.set(code, n = { code, boss, fights: 0, max_group_damage: 0, skills: [] });
    n.boss ||= boss;
    return n;
  };
  for (const f of fights) {
    const inFight = new Set<number>();
    for (const b of f.bosses ?? []) {
      if (npcKnown(b.code) || sent.has(`npc:${b.code}`)) continue;
      const n = npc(b.code, true);
      n.max_group_damage = Math.max(n.max_group_damage, b.damage);
      inFight.add(b.code);
    }
    for (const p of f.players) {
      for (const t of p.taken) {
        if (!npcKnown(t.npc) && !sent.has(`npc:${t.npc}`)) {
          const n = npc(t.npc, t.boss);
          if (!n.skills.includes(t.skill)) n.skills.push(t.skill);
          inFight.add(t.npc);
        }
        if (!NAMES.skills[t.skill] && !sharedName("npc_skills", t.skill) && !sent.has(`npc_skill:${t.skill}`)) {
          const s = npcSkills.get(t.skill) ?? { code: t.skill, npc: t.npc, hits: 0, avg: 0, max: 0, damage: 0 };
          s.hits += t.hits;
          s.damage += t.damage;
          s.max = Math.max(s.max, t.max_hit);
          s.npc ||= t.npc;
          npcSkills.set(t.skill, s);
        }
      }
      if (known) {
        for (const s of p.skills ?? []) {
          if (mine.has(s.skill) || known.has(s.skill) || sharedName("skills", s.skill) || unnamedOnPurpose(s.skill) || sent.has(`skill:${s.skill}`)) continue;
          const k = skills.get(s.skill) ?? { code: s.skill, class: p.class, hits: 0 };
          k.hits += s.boss.hits + s.mob.hits;
          k.class ??= p.class;
          skills.set(s.skill, k);
        }
      }
    }
    for (const u of f.effects?.list ?? []) {
      if (ABNORMALS[u.abnormal]?.[0] || sharedName("effects", u.abnormal) || sent.has(`effect:${u.abnormal}`) || effects.has(u.abnormal)) continue;
      effects.set(u.abnormal, { code: u.abnormal, skill: u.skill });
    }
    for (const code of inFight) npcs.get(code)!.fights++;
  }
  const report: Report = {
    npcs: [...npcs.values()].sort((a, b) => b.fights - a.fights),
    npc_skills: [...npcSkills.values()].map(({ damage, ...s }) => ({ ...s, avg: s.hits ? Math.round(damage / s.hits) : 0 })).sort((a, b) => b.hits - a.hits),
    skills: [...skills.values()].sort((a, b) => b.hits - a.hits),
    effects: [...effects.values()],
    note: "",
  };
  const keys = [
    ...report.npcs.map((n) => `npc:${n.code}`), ...report.npc_skills.map((s) => `npc_skill:${s.code}`),
    ...report.skills.map((s) => `skill:${s.code}`), ...report.effects.map((e) => `effect:${e.code}`),
  ];
  return { report, keys };
}

/** "3 monstros, 2 skills de monstro e 1 efeito". */
export function summary(r: Report): string {
  const parts = [
    [r.npcs.length, "monstro", "monstros"], [r.npc_skills.length, "skill de monstro", "skills de monstro"],
    [r.skills.length, "skill de jogador", "skills de jogador"], [r.effects.length, "efeito", "efeitos"],
  ].filter(([n]) => n).map(([n, one, many]) => `${n} ${n === 1 ? one : many}`);
  return parts.length > 1 ? `${parts.slice(0, -1).join(", ")} e ${parts.at(-1)}` : parts[0] ?? "nada";
}

