// The DPS tab's skill table: one player's damage by skill, with hits, the
// biggest hit, the average and criticals. Names and icons come from the
// profile (in Portuguese) where it has the skill, else from dbaion2.
import { DpsTarget, Fight, FightPlayer, Saved, SkillStat, Tally, gameData } from "./api";
import { Skill, iconUrl } from "./buildData";
import { secondsFor, short } from "./dpsView";
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
  return `Skill ${id}`;
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
  return { damage: s.boss.damage + s.mob.damage, hits: s.boss.hits + s.mob.hits, crits: s.boss.crits + s.mob.crits, max_hit: Math.max(s.boss.max_hit, s.mob.max_hit) };
}

const percent = (n: number) => `${Math.round(n * 100)}%`;

/** The table of a player's skills on a target, biggest first. */
export function skillTable(f: Fight, p: FightPlayer, target: DpsTarget, saved: Saved | null, redraw: () => void) {
  loadSkills(redraw);
  const secs = secondsFor(f, target);
  const list = (p.skills ?? []).map((s) => ({ s, t: tally(s, target) })).filter((r) => r.t.damage > 0).sort((a, b) => b.t.damage - a.t.damage);
  const head = el("h3", {}, `Skills de ${p.name} `, el("span", { className: "hint" }, "· clique num jogador acima para ver as dele"));
  if (!list.length) return el("section", { className: "dps-skills" }, head, el("p", { className: "hint" }, "Nenhuma skill com dano neste alvo."));
  const sum = list.reduce((n, r) => n + r.t.damage, 0);
  const top = list[0].t.damage;
  const th = (text: string, title = "") => el("th", { title }, text);
  return el("section", { className: "dps-skills" }, head,
    el("table", { className: "list" },
      el("thead", {}, el("tr", {}, th("Skill"), th("Dano"), th("DPS"), th("Golpes", "Golpes que acertaram (ticks, no dano contínuo)"), th("Maior"), th("Média"), th("Crítico", "Golpes críticos sobre o total"))),
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
          el("td", { className: "num" }, s.dot ? "—" : percent(t.hits ? t.crits / t.hits : 0)));
      }))));
}
