// The game's titles, from dbaion2.ru (downloaded and cached by the app): what
// each one gives worn and owned, and the text that says how to get it.
import { gameData } from "./api";

export type Race = "Light" | "Dark" | "All";
export type Slot = "Attack" | "Defense" | "Etc" | "None";
/** [stat id, value as the file has it] */
export type StatValue = [string, number];

export interface Title {
  id: number; name: string;
  /** Flavor text with how it is got, in English; may hold "\n". */
  desc: string;
  race: Race; cat: string; slot: Slot; grade: string;
  /** Worn in its slot, and owned (the collection bonus). */
  equip: StatValue[]; own: StatValue[];
}

export interface TitleData { cats: { id: string; name: string }[]; list: Title[] }

let loading: Promise<TitleData> | null = null;

/** The file, once per run. */
export function loadTitles(): Promise<TitleData> {
  loading ??= gameData<TitleData>("titles").catch((e) => { loading = null; throw e; });
  return loading;
}

export const CATEGORY: Record<string, string> = {
  Quest: "Missão", Growth: "Progresso", Challenge: "Desafio", Adventure: "Exploração", Dungeon: "Dungeon", Item: "Item",
};
export const CATEGORY_ORDER = ["Quest", "Growth", "Challenge", "Adventure", "Dungeon", "Item"];
export const SLOT: Record<Slot, string> = { Attack: "Ataque", Defense: "Defesa", Etc: "Outros", None: "Sem bônus" };
export const SLOT_ORDER: Slot[] = ["Attack", "Defense", "Etc", "None"];
export const GRADE: Record<string, string> = { Common: "Comum", Rare: "Raro", Legend: "Lendário", Unique: "Único", Epic: "Épico", Special: "Especial" };
export const GRADE_ORDER = ["Common", "Rare", "Legend", "Unique", "Epic", "Special"];

/** Stat names; `pct`: the file has it ×100, shown as a percentage; `cent`:
 *  ×100 too, shown as a plain number (stamina). */
interface StatInfo { name: string; pct?: boolean; cent?: boolean }

export const STATS: Record<string, StatInfo> = {
  FixingDamage: { name: "Ataque adicional" },
  Accuracy: { name: "Precisão adicional" },
  Critical: { name: "Crítico" },
  CriticalAddDamage: { name: "Ataque crítico" },
  CriticalResist: { name: "Resistência a crítico" },
  CriticalDamageDefense: { name: "Defesa contra dano crítico" },
  AmplifyCriticalDamage: { name: "Aumento de dano crítico", pct: true },
  DecreaseCriticalDamage: { name: "Tolerância a dano crítico", pct: true },
  AmplifyAllDamage: { name: "Aumento de dano", pct: true },
  DecreaseDamage: { name: "Tolerância a dano", pct: true },
  Defense: { name: "Defesa adicional" },
  DefensePierce: { name: "Penetração" },
  Evasion: { name: "Evasão adicional" },
  Block: { name: "Bloqueio" },
  BlockPierce: { name: "Penetração de bloqueio" },
  BackAttackDamage: { name: "Ataque pelas costas" },
  BackAttackDefense: { name: "Defesa pelas costas" },
  BackAttackCritical: { name: "Crítico pelas costas" },
  BackAttackCriticalResist: { name: "Resistência a crítico pelas costas" },
  AmplifyBackAttack: { name: "Aumento de dano pelas costas", pct: true },
  DecreaseBackAttack: { name: "Tolerância a dano pelas costas", pct: true },
  FrontAttackDamage: { name: "Ataque frontal" },
  FrontAttackDefense: { name: "Defesa frontal" },
  FrontAttackCritical: { name: "Crítico frontal" },
  AdditionalHitRate: { name: "Chance de golpe múltiplo", pct: true },
  AdditionalHitResistRate: { name: "Resistência a golpe múltiplo", pct: true },
  BossNpcAmplifyDamage: { name: "Aumento de dano em chefes", pct: true },
  BossNpcDecreaseDamage: { name: "Tolerância a dano de chefes", pct: true },
  PvEAccuracy: { name: "Precisão PvE" },
  PvEAddDamage: { name: "Ataque PvE" },
  PvEAmplifyDamage: { name: "Aumento de dano PvE", pct: true },
  PvEDamageDefense: { name: "Defesa PvE" },
  PvEDecreaseDamage: { name: "Tolerância a dano PvE", pct: true },
  PvEEvasion: { name: "Evasão PvE" },
  PvPAccuracy: { name: "Precisão PvP" },
  PvPAddDamage: { name: "Ataque PvP" },
  PvPAmplifyDamage: { name: "Aumento de dano PvP", pct: true },
  PvPCritical: { name: "Crítico PvP" },
  PvPCriticalResist: { name: "Resistência a crítico PvP" },
  PvPDamageDefense: { name: "Defesa PvP" },
  PvPEvasion: { name: "Evasão PvP" },
  SealStoneAddDamage: { name: "Dano de fragmento de poder" },
  CombatSpeed: { name: "Velocidade de combate", pct: true },
  CoolTimeDecrease: { name: "Redução de recarga", pct: true },
  MoveSpeed: { name: "Velocidade de movimento", pct: true },
  FlySpeed: { name: "Velocidade de voo", pct: true },
  MPUseDecrease: { name: "Redução de custo de MP", pct: true },
  HPMax: { name: "HP" },
  MaxHPRatio: { name: "Aumento de HP", pct: true },
  MPMax: { name: "MP" },
  MaxMPRatio: { name: "Aumento de MP", pct: true },
  SPMax: { name: "Vigor", cent: true },
  HPRegen: { name: "Regeneração natural de HP" },
  MPRegen: { name: "Regeneração natural de MP" },
  SPRegen: { name: "Regeneração natural de vigor", cent: true },
  BattleHPRegen: { name: "Regeneração de HP em combate" },
  BattleMPRegen: { name: "Regeneração de MP em combate" },
  BattleSPRegen: { name: "Regeneração de vigor em combate", cent: true },
  RestHPRegen: { name: "Regeneração de HP fora de combate" },
  RestMPRegen: { name: "Regeneração de MP fora de combate" },
  RestSPRegen: { name: "Regeneração de vigor fora de combate", cent: true },
  Restoration: { name: "Regeneração" },
  HpPotionRegen: { name: "Recuperação de poção de HP" },
  HpPotionRate: { name: "Aumento da recuperação de poção de HP", pct: true },
  HardHitResist: { name: "Resistência a golpe pesado", pct: true },
  IronWall: { name: "Muralha de ferro", pct: true },
  IgnoreIronWall: { name: "Penetração de muralha de ferro", pct: true },
  Perfect: { name: "Golpe perfeito", pct: true },
  PerfectResist: { name: "Resistência a golpe perfeito", pct: true },
};

/** "PvEAmplifyDamage" → "PvE Amplify Damage", for a stat the table lacks. */
export const statName = (id: string) => STATS[id]?.name ?? id.replace(/([a-z])([A-Z])/g, "$1 $2");

/** A value as the game shows it: the file's number, scaled. */
export function statValue(id: string, v: number): number {
  const s = STATS[id];
  return s?.pct || s?.cent ? v / 100 : v;
}

/** "Ataque adicional +5", "Aumento de dano PvE +2,3%". */
export function statText([id, v]: StatValue): string {
  const n = statValue(id, v).toLocaleString("pt-BR", { maximumFractionDigits: 2 });
  return `${statName(id)} +${n}${STATS[id]?.pct ? "%" : ""}`;
}

/** The value of a stat in a list, 0 when it isn't there. */
export const valueIn = (list: StatValue[], id: string) => list.reduce((n, [s, v]) => (s === id ? n + statValue(s, v) : n), 0);

/** Each stat's sum over the titles (as the file has it), by name. */
export function sumStats(titles: Title[], pick: (t: Title) => StatValue[]): [string, number][] {
  const sum = new Map<string, number>();
  for (const t of titles) for (const [id, v] of pick(t)) sum.set(id, (sum.get(id) ?? 0) + v);
  return [...sum].sort((a, b) => statName(a[0]).localeCompare(statName(b[0]), "pt-BR"));
}
