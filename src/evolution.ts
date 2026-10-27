// The Evolution tab's rules: where the followed character is behind, each
// with the numbers that show it. Everything is worked out here on the PC,
// from the official profile, dbaion2's game data and your own recordings;
// nothing leaves the computer and no AI is involved.
import { Fight, FightPlayer, Profile, ProfileItem, ProfileSkill, Saved } from "./api";
import { GameData, cells, findBoard } from "./buildData";
import { SLOT_NAME, itemPower } from "./compare";
import { PET_BY_ID, levelProgress, name } from "./data";
import { castRows } from "./dpsCasts";
import { combatWindows } from "./dpsView";

export type Area = "Equipamento" | "Skills" | "Daevanion" | "Títulos" | "Lutas" | "Pets";
export type Level = "alta" | "media" | "baixa";
/** The panel tab that shows a finding in detail. */
export type Tab = "build" | "group" | "dps" | "titles" | "pets" | "enchant";

export interface Finding {
  id: string; area: Area; level: Level; title: string;
  /** The numbers behind it, in one or two sentences. */
  detail: string;
  items?: string[];
  tab?: Tab;
}

/** A rule that ran and found nothing to do, or couldn't run for lack of data. */
export interface Note { area: Area; text: string }

export interface Analysis { findings: Finding[]; ok: Note[]; missing: Note[] }

export interface Inputs {
  profile: Profile;
  game: GameData | null;
  /** Saved recordings, newest first. */
  fights: Fight[];
  pets: Saved["pets"];
  serverId: number;
}

/** An item this many enchant levels under the median of its group is behind. */
const GEAR_GAP = 3;
/** Weapon and armor are enchanted alike; accessories go by a ladder of their own. */
const ARMOR = ["MainHand", "SubHand", "Helmet", "Shoulder", "Torso", "Pants", "Gloves", "Boots", "Cape"];
/** Arcana card slots in the first season. */
const ARCANA_SLOTS = 4;
/** Stigma slots open at these character levels (as the Build tab counts them). */
const STIGMA_SLOTS = [22, 27, 32, 37];
/** An equipped skill this many levels under the median of the equipped ones is behind. */
const SKILL_GAP = 2;
/** A skill doing at least this share of your damage counts as a main one. */
const MAIN_SKILL_SHARE = 0.08;
/** How many of the latest recordings with you in them the fight rules read. */
const RECENT = 5;
/** Recordings shorter than this (in combat seconds) say little. */
const MIN_FIGHT_S = 30;
/** Time standing still while the group fights: from here it's worth a look, from `IDLE_HIGH` it's a priority. */
const IDLE_SOME = 0.15;
const IDLE_HIGH = 0.25;
/** A skill used less than this share of the times its cooldown allowed. */
const LOW_USE = 0.6;
/** Only cooldowns this long and skills that could be used this often count. */
const MIN_COOLDOWN_S = 5;
const MIN_POSSIBLE = 3;
/** A pet this many souls from its next level is close. */
const PET_CLOSE = 2;

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
/** "da última gravação" / "das últimas 3 gravações". */
const lastFights = (n: number) => (n === 1 ? "da última gravação" : `das últimas ${n} gravações`);
const plus = (n: number) => `+${Math.round(n)}`;
const pct = (x: number) => `${Math.round(x * 100)}%`;
const slotName = (i: ProfileItem) => SLOT_NAME[i.slotPosName] ?? i.slotPosName;
const isArcana = (i: ProfileItem) => i.slotPos >= 41 || i.slotPosName.startsWith("Arcana");
const isStigma = (s: ProfileSkill) => s.category === "Dp" || s.category === "Stigma";
/** Equipped in the preset the site shows (a stigma of another preset comes with level 0). */
const equipped = (s: ProfileSkill) => !!s.equip && !!s.acquired && s.skillLevel > 0;

type Rule = (x: Inputs, out: Analysis) => void;

/** Pieces enchanted well under the rest of their group; the weapon on its own. */
const gear: Rule = ({ profile }, out) => {
  const list = (profile.equipment.equipment?.equipmentList ?? []).filter((i) => !isArcana(i));
  if (!list.length) { out.missing.push({ area: "Equipamento", text: "O perfil não trouxe o equipamento." }); return; }
  const behind: string[] = [];
  for (const group of [list.filter((i) => ARMOR.includes(i.slotPosName)), list.filter((i) => !ARMOR.includes(i.slotPosName))]) {
    if (group.length < 3) continue;
    const mid = median(group.map(itemPower));
    for (const i of group.filter((i) => itemPower(i) <= mid - GEAR_GAP)) {
      if (i.slotPosName === "MainHand") {
        out.findings.push({ id: "gear-weapon", area: "Equipamento", level: "alta", tab: "enchant",
          title: "A arma está atrás do resto do equipamento",
          detail: `${i.name} está em ${plus(itemPower(i))}, e a mediana da armadura é ${plus(mid)}. A arma costuma ser o primeiro item a encantar.` });
      } else {
        behind.push(`${slotName(i)}: ${i.name} ${plus(itemPower(i))} (o grupo está em ${plus(mid)})`);
      }
    }
  }
  if (behind.length) {
    out.findings.push({ id: "gear-behind", area: "Equipamento", level: "media", tab: "enchant", items: behind,
      title: behind.length === 1 ? "Uma peça está atrás das outras" : `${behind.length} peças estão atrás das outras`,
      detail: `Encantamento (com o "além") ${GEAR_GAP} ou mais níveis abaixo da mediana do grupo: armas e armadura de um lado, acessórios do outro.` });
  }
  if (!behind.length && !out.findings.some((f) => f.id === "gear-weapon")) out.ok.push({ area: "Equipamento", text: "Encantamento parelho entre as peças." });
};

/** Arcana cards: the profile lists them past the gear. */
const arcana: Rule = ({ profile }, out) => {
  const cards = (profile.equipment.equipment?.equipmentList ?? []).filter(isArcana);
  if (!cards.length) { out.missing.push({ area: "Equipamento", text: "O perfil não mostrou Arcanas; não dá para saber se há slot vazio." }); return; }
  if (cards.length < ARCANA_SLOTS) {
    out.findings.push({ id: "arcana-empty", area: "Equipamento", level: "media",
      title: `${ARCANA_SLOTS - cards.length} slot(s) de Arcana sem carta`,
      detail: `O perfil mostra ${cards.length} de ${ARCANA_SLOTS} Arcanas. Cartas vêm das masmorras de Transcendência e da Transmutação.`,
      items: cards.map((c) => c.name) });
  } else {
    out.ok.push({ area: "Equipamento", text: `${cards.length} Arcanas equipadas.` });
  }
};

/** Skills the level already allows but the character hasn't learned. */
const unlearned: Rule = ({ profile }, out) => {
  const level = profile.info.profile?.characterLevel ?? 0;
  const list = (profile.equipment.skill?.skillList ?? []).filter((s) => !isStigma(s) && !s.acquired && s.needLevel <= level);
  if (list.length) {
    out.findings.push({ id: "skills-unlearned", area: "Skills", level: "media", tab: "build",
      title: list.length === 1 ? "Uma skill que você já pode aprender" : `${list.length} skills que você já pode aprender`,
      detail: `O nível ${level} já libera, e o perfil diz que ainda não foram aprendidas.`,
      items: list.map((s) => `${s.name} (nível ${s.needLevel})`) });
  } else if (profile.equipment.skill?.skillList?.length) {
    out.ok.push({ area: "Skills", text: "Todas as skills do seu nível aprendidas." });
  }
};

/** Stigma slots the level opened with nothing in them (in the preset the site shows). */
const stigmaSlots: Rule = ({ profile }, out) => {
  const level = profile.info.profile?.characterLevel ?? 0;
  const slots = STIGMA_SLOTS.filter((l) => level >= l).length;
  const list = profile.equipment.skill?.skillList ?? [];
  if (!slots || !list.length) return;
  const worn = list.filter((s) => isStigma(s) && equipped(s)).length;
  if (worn < slots) {
    out.findings.push({ id: "stigma-empty", area: "Skills", level: "alta", tab: "build",
      title: `${slots - worn} slot(s) de stigma vazio(s)`,
      detail: `O nível ${level} abre ${slots} slots e a preset em uso no site tem ${worn} stigma(s) equipado(s).` });
  } else {
    out.ok.push({ area: "Skills", text: `Os ${slots} slots de stigma ocupados.` });
  }
};

/** You in a recording, if you fought in it. */
const me = (f: Fight) => f.players.find((p) => p.local);
/** The latest recordings you fought in that are long enough to say something. */
const recent = (fights: Fight[]) => fights.filter((f) => me(f) && fightSeconds(f) >= MIN_FIGHT_S).slice(0, RECENT);
const fightSeconds = (f: Fight) => combatWindows(f).reduce((n, [a, b]) => n + b - a, 0);
const skillDamage = (p: FightPlayer) => p.skills.reduce((n, s) => n + s.boss.damage + s.mob.damage, 0);

/** Equipped skills well under the others; first the ones doing most of your damage. */
const lowSkills: Rule = ({ profile, fights }, out) => {
  const list = (profile.equipment.skill?.skillList ?? []).filter((s) => s.category === "Active" && equipped(s));
  if (list.length < 3) return;
  const mid = median(list.map((s) => s.skillLevel));
  const low = list.filter((s) => s.skillLevel <= mid - SKILL_GAP);
  if (!low.length) { out.ok.push({ area: "Skills", text: "Nível parelho entre as skills ativas equipadas." }); return; }
  // Each skill's share of your damage over the recent recordings.
  const damage = new Map<number, number>();
  let total = 0;
  for (const f of recent(fights)) {
    const p = me(f)!;
    total += skillDamage(p);
    for (const s of p.skills) damage.set(s.skill, (damage.get(s.skill) ?? 0) + s.boss.damage + s.mob.damage);
  }
  const share = (s: ProfileSkill) => (total ? (damage.get(s.id) ?? 0) / total : 0);
  const main = low.filter((s) => share(s) >= MAIN_SKILL_SHARE).sort((a, b) => share(b) - share(a));
  const rest = low.filter((s) => !main.includes(s));
  if (main.length) {
    out.findings.push({ id: "skills-main-low", area: "Skills", level: "alta", tab: "build",
      title: "Skill que bate forte está com nível baixo",
      detail: `As ativas equipadas estão no nível ${Math.round(mid)} (mediana). Estas fazem boa parte do seu dano nas últimas gravações e estão atrás.`,
      items: main.map((s) => `${s.name}: nível ${s.skillLevel}, ${pct(share(s))} do seu dano`) });
  }
  if (rest.length) {
    out.findings.push({ id: "skills-low", area: "Skills", level: "baixa", tab: "build",
      title: rest.length === 1 ? "Uma skill equipada atrás das outras" : `${rest.length} skills equipadas atrás das outras`,
      detail: `${SKILL_GAP} ou mais níveis abaixo da mediana das ativas equipadas (nível ${Math.round(mid)}).`,
      items: rest.map((s) => `${s.name}: nível ${s.skillLevel}`) });
  }
};

/** Equipped skills one level from a specialization. */
const specs: Rule = ({ profile, game }, out) => {
  if (!game) return;
  const near = (profile.equipment.skill?.skillList ?? []).filter(equipped).flatMap((s) => {
    const next = (game.skills.get(s.id)?.parts ?? []).map((x) => x.level).filter((l) => l > s.skillLevel).sort((a, b) => a - b)[0];
    return next === s.skillLevel + 1 ? [`${s.name}: nível ${s.skillLevel}, especialização no ${next}`] : [];
  });
  if (near.length) {
    out.findings.push({ id: "skills-spec", area: "Skills", level: "media", tab: "build", items: near,
      title: near.length === 1 ? "Uma skill a 1 nível de especialização" : `${near.length} skills a 1 nível de especialização`,
      detail: "Mais um nível nestas libera uma especialização nova (veja o que ela faz clicando na skill, na aba Build)." });
  }
};

/** Closed Daevanion nodes of the skills you have equipped, on the boards your level opens. */
const daevanion: Rule = ({ profile, game }, out) => {
  const listed = profile.info.daevanion?.boardList ?? [];
  if (!listed.length || !Object.keys(profile.boards).length) { out.missing.push({ area: "Daevanion", text: "O perfil não trouxe os tabuleiros Daevanion." }); return; }
  if (!game) { out.missing.push({ area: "Daevanion", text: "Sem os dados da dbaion2, não dá para ver os nós fechados." }); return; }
  const known = findBoard(game, listed[0].id);
  if (!known) return;
  const level = profile.info.profile?.characterLevel ?? 0;
  const skills = profile.equipment.skill?.skillList ?? [];
  const mine = new Set(skills.filter(equipped).map((s) => s.id));
  const closed: { text: string; cost: number }[] = [];
  for (const board of known.boards.filter((b) => b.needLevel <= level)) {
    const name = listed.find((b) => b.id === board.id)?.name ?? board.name;
    for (const c of cells(board, profile.boards[String(board.id)] ?? null, skills, game.skills)) {
      if (c.kind === "skill" && !c.open && c.skillId != null && mine.has(c.skillId)) closed.push({ text: `${c.name} (${name}, ${c.cost} cristal(is))`, cost: c.cost });
    }
  }
  if (closed.length) {
    closed.sort((a, b) => a.cost - b.cost);
    out.findings.push({ id: "daevanion-skills", area: "Daevanion", level: "alta", tab: "build",
      title: `${closed.length} nó(s) de skill equipada ainda fechado(s)`,
      detail: "Nós que sobem o nível das skills que você usa costumam vir antes dos de atributo. Os mais baratos primeiro; o caminho até eles também custa.",
      items: closed.map((c) => c.text) });
  } else {
    out.ok.push({ area: "Daevanion", text: "Nós das skills equipadas abertos nos tabuleiros do seu nível." });
  }
};

/** Titles count toward combat power by how many you have. */
const titles: Rule = ({ profile }, out) => {
  const t = profile.info.title;
  if (t?.ownedCount == null || !t.totalCount) { out.missing.push({ area: "Títulos", text: "O perfil não trouxe a contagem de títulos." }); return; }
  if (t.ownedCount >= t.totalCount) { out.ok.push({ area: "Títulos", text: "Todos os títulos." }); return; }
  const SLOT: Record<string, string> = { Attack: "Ataque", Defense: "Defesa", Etc: "Outros" };
  out.findings.push({ id: "titles", area: "Títulos", level: "baixa", tab: "titles",
    title: `${t.totalCount - t.ownedCount} títulos por conseguir`,
    detail: `O perfil conta ${t.ownedCount} de ${t.totalCount}. Na aba Títulos, filtre pelos não adquiridos para ver como conseguir cada um.`,
    items: (t.titleList ?? []).map((s) => `${SLOT[s.equipCategory] ?? s.equipCategory}: ${s.ownedCount} de ${s.totalCount}`) });
};

/** Your own idle time while the group fought. */
function idleShare(f: Fight): number {
  const p = me(f)!;
  const w = combatWindows(f);
  const fighting = w.reduce((n, [a, b]) => n + b - a, 0);
  let idle = 0;
  for (const [x, y] of p.idle) for (const [a, b] of w) idle += Math.max(0, Math.min(b, y / 1000) - Math.max(a, x / 1000));
  return fighting ? idle / fighting : 0;
}

/** Standing still while the group fights. */
const idle: Rule = ({ fights }, out) => {
  const list = recent(fights).filter((f) => me(f)!.timeline.length && f.players.length > 1);
  if (!list.length) { out.missing.push({ area: "Lutas", text: "Grave lutas em grupo na aba DPS para medir o tempo parado." }); return; }
  const shares = list.map(idleShare);
  const avg = shares.reduce((a, b) => a + b, 0) / shares.length;
  if (avg >= IDLE_SOME) {
    out.findings.push({ id: "fights-idle", area: "Lutas", level: avg >= IDLE_HIGH ? "alta" : "media", tab: "dps",
      title: `Parado ${pct(avg)} do tempo de luta`,
      detail: `Média ${lastFights(list.length)} em grupo: trechos de 3 s ou mais sem golpe nem cura sua enquanto o grupo lutava. Menos tempo parado é dano a mais sem trocar nada no equipamento.`,
      items: list.map((f, i) => `${f.name}: ${pct(shares[i])}`) });
  } else {
    out.ok.push({ area: "Lutas", text: `Pouco tempo parado nas lutas em grupo (${pct(avg)}).` });
  }
};

/** Skills with a real cooldown used well under what it allowed, in your latest recording. */
const cooldowns: Rule = ({ fights, game, profile }, out) => {
  const f = recent(fights)[0];
  if (!f || !me(f)!.casts?.length) { out.missing.push({ area: "Lutas", text: "Grave uma luta na aba DPS para medir o uso das recargas." }); return; }
  if (!game) { out.missing.push({ area: "Lutas", text: "Sem os dados da dbaion2, não dá para saber as recargas." }); return; }
  const rows = castRows(me(f)!, combatWindows(f), game, profile)
    .filter((r) => r.possible != null && r.possible >= MIN_POSSIBLE && (r.cooldown ?? 0) >= MIN_COOLDOWN_S && r.uses / r.possible < LOW_USE);
  if (rows.length) {
    out.findings.push({ id: "fights-cooldowns", area: "Lutas", level: "media", tab: "dps",
      title: rows.length === 1 ? "Uma recarga pouco usada" : `${rows.length} recargas pouco usadas`,
      detail: `Na gravação "${f.name}", estas skills foram usadas menos de ${pct(LOW_USE)} das vezes que a recarga permitia durante o combate.`,
      items: rows.slice(0, 5).map((r) => `${r.name}: ${r.uses} de ${r.possible} usos`) });
  } else {
    out.ok.push({ area: "Lutas", text: `Recargas bem aproveitadas em "${f.name}".` });
  }
};

/** Deaths in your latest recordings. */
const deaths: Rule = ({ fights }, out) => {
  const list = recent(fights).filter((f) => me(f)!.deaths != null);
  if (!list.length) return;
  const n = list.reduce((a, f) => a + (me(f)!.deaths ?? 0), 0);
  if (n) {
    out.findings.push({ id: "fights-deaths", area: "Lutas", level: "media", tab: "dps",
      title: n === 1 ? "Uma morte nas últimas lutas" : `${n} mortes nas últimas lutas`,
      detail: `Somando as mortes ${lastFights(list.length)}. A seção "Dano recebido" da aba DPS mostra quais golpes mais tiraram vida.`,
      items: list.filter((f) => me(f)!.deaths).map((f) => `${f.name}: ${me(f)!.deaths}`) });
  } else {
    out.ok.push({ area: "Lutas", text: `Nenhuma morte ${list.length === 1 ? "na última gravação" : `nas últimas ${list.length} gravações`}.` });
  }
};

/** Pets a soul or two from their next level, on the server picked. */
const pets: Rule = ({ pets, serverId }, out) => {
  const mine = pets[String(serverId)]?.pets ?? {};
  if (!Object.keys(mine).length) { out.missing.push({ area: "Pets", text: "Entre no jogo com o Kiskwatch aberto para ler os pets." }); return; }
  const close = Object.entries(mine).flatMap(([id, p]) => {
    const step = levelProgress(p.level, p.points);
    const left = step ? step.need - step.have : Infinity;
    const pet = PET_BY_ID.get(Number(id));
    return pet && left > 0 && left <= PET_CLOSE ? [{ text: `${name(pet.name)}: falta(m) ${left} alma(s) para o nível ${p.level + 1}`, left }] : [];
  }).sort((a, b) => a.left - b.left);
  if (close.length) {
    out.findings.push({ id: "pets-close", area: "Pets", level: "baixa", tab: "pets",
      title: close.length === 1 ? "Um pet perto de subir de nível" : `${close.length} pets perto de subir de nível`,
      detail: `A ${PET_CLOSE} alma(s) ou menos do próximo nível. A aba Pets mostra onde cada um aparece.`,
      items: close.map((c) => c.text) });
  }
};

const RULES: Rule[] = [gear, arcana, stigmaSlots, unlearned, lowSkills, specs, daevanion, titles, idle, cooldowns, deaths, pets];
const ORDER: Level[] = ["alta", "media", "baixa"];

export function analyze(x: Inputs): Analysis {
  const out: Analysis = { findings: [], ok: [], missing: [] };
  for (const rule of RULES) rule(x, out);
  out.findings.sort((a, b) => ORDER.indexOf(a.level) - ORDER.indexOf(b.level));
  return out;
}
