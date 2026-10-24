// The DPS tab's skill table: one player's damage by skill, with hits, the
// biggest hit, the average, criticals, how the hits landed (from behind,
// double, perfect, blocked) and the attempts that did nothing. Names and icons come from the
// profile (in Portuguese) where it has the skill, else from dbaion2.
import { DpsTarget, Fight, FightPlayer, Saved, SkillStat, Tally, gameData } from "./api";
import { Skill, iconUrl } from "./buildData";
import { Target, bossOf, secondsFor, short } from "./dpsView";
import { sharedName } from "./sharedNames";
import "./dpsSkills.css";

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, unknown> = {}, ...kids: (Node | string)[]): HTMLElementTagNameMap[K] {
  const e = Object.assign(document.createElement(tag), props);
  e.append(...kids);
  return e;
}

let known: Map<number, Skill> | null = null;
let asked = false;

/** dbaion2's skills, once per run; `redraw` when they arrive. Without them
 *  the profile's names, or the codes, still show. */
function loadSkills(redraw: () => void) {
  if (asked) return;
  asked = true;
  gameData<Skill[]>("skills").then((l) => { known = new Map(l.map((s) => [s.id, s])); redraw(); }, () => {});
}

/** A skill without a name anywhere: basic attacks (xx00xxxx) and theostones by kind. */
function fallback(id: number) {
  if (id >= 10_000_000 && id <= 19_999_999 && Math.floor(id / 10_000) % 100 === 0) return "Ataque básico";
  if (id >= 30_000_000 && id <= 30_999_999) return "Teostone";
  return sharedName("skills", id) ?? `Skill ${id}`;
}

/** A skill's name and icon by its base code. */
export function skillLook(id: number, saved: Saved | null): { name: string; icon: string } {
  const mine = saved?.profile?.equipment.skill?.skillList?.find((s) => s.id === id);
  const k = known?.get(id);
  return { name: mine?.name || k?.name || fallback(id), icon: mine?.icon || (k?.icon ? iconUrl(k.icon) : "") };
}

/** A skill's hits on the chosen target. */
export function tally(s: SkillStat, target: DpsTarget): Tally {
  if (target === "boss") return s.boss;
  if (target === "mob") return s.mob;
  const sum = (k: "back" | "double" | "perfect" | "blocked" | "missed" | "resisted") => (s.boss[k] ?? 0) + (s.mob[k] ?? 0);
  return {
    damage: s.boss.damage + s.mob.damage, hits: s.boss.hits + s.mob.hits, crits: s.boss.crits + s.mob.crits, max_hit: Math.max(s.boss.max_hit, s.mob.max_hit),
    back: sum("back"), double: sum("double"), perfect: sum("perfect"), blocked: sum("blocked"), missed: sum("missed"), resisted: sum("resisted"),
  };
}

const percent = (n: number) => `${Math.round(n * 100)}%`;

/** The attempts that did nothing, over all of them. */
function missCell(t: Tally, dot: boolean) {
  const missed = t.missed ?? 0, resisted = t.resisted ?? 0;
  if (dot) return el("td", { className: "num" }, "—");
  return el("td", { className: "num", title: `${missed} erro(s), ${resisted} resistido(s)` }, percent(t.hits + missed + resisted ? (missed + resisted) / (t.hits + missed + resisted) : 0));
}

/** The table of a player's skills on a target, biggest first. */
export function skillTable(f: Fight, p: FightPlayer, target: Target, saved: Saved | null, redraw: () => void) {
  loadSkills(redraw);
  const secs = secondsFor(f, target);
  // On one boss, the skills it kept for that boss, their hits under `boss`.
  const [skills, on] = typeof target === "number"
    ? [bossOf(f, target)?.players?.find((x) => x.id === p.id)?.skills ?? [], "boss" as const]
    : [p.skills ?? [], target];
  const list = skills.map((s) => ({ s, t: tally(s, on) })).filter((r) => r.t.damage > 0).sort((a, b) => b.t.damage - a.t.damage);
  const head = el("h3", {}, `Skills de ${p.name} `, el("span", { className: "hint" }, "· clique num jogador acima para ver as dele"));
  if (!list.length) return el("section", { className: "dps-skills" }, head, el("p", { className: "hint" }, "Nenhuma skill com dano neste alvo."));
  const sum = list.reduce((n, r) => n + r.t.damage, 0);
  const top = list[0].t.damage;
  const th = (text: string, title = "") => el("th", { title }, text);
  return el("section", { className: "dps-skills" }, head,
    el("table", { className: "list" },
      el("thead", {}, el("tr", {}, th("Skill"), th("Dano"), th("DPS"), th("Golpes", "Golpes que acertaram (ticks, no dano contínuo)"), th("Maior"), th("Média"), th("Crítico", "Golpes críticos sobre o total"),
        th("Costas", "Golpes pelas costas sobre o total"), th("Duplo", "Golpes duplos sobre o total"), th("Perfeito", "Golpes perfeitos sobre o total"),
        th("Bloqueado", "Golpes que o alvo aparou ou bloqueou (parte do dano tirada) sobre o total"), th("Errou", "Tentativas que erraram ou foram resistidas, sobre todas as tentativas"))),
      el("tbody", {}, ...list.map(({ s, t }) => {
        const look = skillLook(s.skill, saved);
        const bar = el("span", { className: "dps-skill-bar" });
        bar.style.width = `${(100 * t.damage) / top}%`;
        return el("tr", { title: `Código ${s.skill}` },
          el("td", {}, el("div", { className: "dps-skill" },
            look.icon ? el("img", { src: look.icon, alt: "", loading: "lazy" }) : el("span", { className: "noicon" }),
            el("span", {}, look.name, s.dot ? el("small", { className: "hint" }, " · contínuo") : ""))),
          el("td", { className: "num" }, `${short(t.damage)} · ${percent(t.damage / sum)}`, bar),
          el("td", { className: "num" }, short(t.damage / secs)),
          el("td", { className: "num" }, t.hits.toLocaleString("pt-BR")),
          el("td", { className: "num" }, short(t.max_hit)),
          el("td", { className: "num" }, short(t.hits ? t.damage / t.hits : 0)),
          el("td", { className: "num" }, s.dot ? "—" : percent(t.hits ? t.crits / t.hits : 0)),
          ...[t.back, t.double, t.perfect, t.blocked].map((n) => el("td", { className: "num" }, s.dot ? "—" : percent(t.hits ? (n ?? 0) / t.hits : 0))),
          missCell(t, s.dot));
      }))));
}
