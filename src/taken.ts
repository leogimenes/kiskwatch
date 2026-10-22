// The DPS tab's damage taken: what each monster's skill did to a player over
// a recording, with the names A2Tools has for them.
import { DpsTarget, Fight, FightPlayer, Taken } from "./api";
import { short } from "./dpsView";
import namesJson from "../data/npc_names.json";

const NAMES = namesJson as { npcs: Record<string, string>; skills: Record<string, string> };

export const npcName = (code: number) => code ? NAMES.npcs[code] ?? `Monstro ${code}` : "Monstro desconhecido";
export const skillName = (code: number) => NAMES.skills[code] ?? `Skill ${code}`;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, unknown> = {}, ...kids: (Node | string)[]): HTMLElementTagNameMap[K] {
  const e = Object.assign(document.createElement(tag), props);
  e.append(...kids);
  return e;
}

const hurt = (p: FightPlayer) => p.taken.reduce((n, t) => n + t.damage, 0);

/** Whose damage taken to show first: yours, else whoever took the most. */
export function firstVictim(f: Fight): FightPlayer | null {
  const hit = f.players.filter((p) => p.taken.length);
  return hit.find((p) => p.local) ?? hit.sort((a, b) => hurt(b) - hurt(a))[0] ?? null;
}

/** The section: a player to pick (when more than one was hit) and their
 *  table, by the target chips (Boss shows only the bosses' skills). */
export function takenSection(f: Fight, target: DpsTarget, victim: number | null, pick: (id: number) => void) {
  const hit = f.players.filter((p) => p.taken.length);
  const box = el("section", { className: "taken" }, el("h3", {}, "Dano recebido"));
  const p = hit.find((x) => x.id === victim) ?? firstVictim(f);
  if (!p) {
    box.append(el("p", { className: "hint" }, "Nenhum monstro acertou ninguém nesta gravação."));
    return box;
  }
  if (hit.length > 1) {
    const select = el("select", { ariaLabel: "Jogador" }, ...hit.map((x) => el("option", { value: String(x.id), textContent: x.name, selected: x.id === p.id })));
    select.addEventListener("change", () => pick(Number(select.value)));
    box.append(select);
  }
  const list = p.taken.filter((t) => target === "all" || (target === "boss") === t.boss);
  const sum = list.reduce((n, t) => n + t.damage, 0);
  const secs = Math.max(1, (f.ended_ms - f.started_ms) / 1000);
  if (!list.length) {
    box.append(el("p", { className: "hint" }, target === "boss" ? "Nenhum chefe acertou este jogador." : "Nenhum monstro comum acertou este jogador."));
    return box;
  }
  const hits = list.reduce((n, t) => n + t.hits, 0);
  box.append(
    el("p", { className: "hint" }, `${short(sum)} de dano em ${hits} golpe(s) · ${short(sum / secs)}/s`),
    el("table", { className: "taken-table" },
      el("thead", {}, el("tr", {}, ...["Skill", "Monstro", "Dano", "%", "Golpes", "Média", "Maior"].map((h) => el("th", { scope: "col", textContent: h })))),
      el("tbody", {}, ...list.map((t) => row(t, sum, list)))),
  );
  return box;
}

function row(t: Taken, sum: number, list: Taken[]) {
  const share = sum ? t.damage / sum : 0;
  // Many monster skills share a name ("Ataque"): the code tells them apart.
  const same = list.some((o) => o !== t && o.npc === t.npc && skillName(o.skill) === skillName(t.skill));
  const label = same ? `${skillName(t.skill)} (${t.skill})` : skillName(t.skill);
  const bar = el("span", { className: "taken-bar" });
  bar.style.width = `${share * 100}%`;
  const skill = el("td", { className: "taken-skill", title: `Skill ${t.skill}` }, label, bar);
  return el("tr", { className: t.boss ? "boss" : "" },
    skill,
    el("td", { title: t.npc ? `NPC ${t.npc}` : "" }, npcName(t.npc)),
    el("td", { className: "num" }, short(t.damage)),
    el("td", { className: "num" }, `${Math.round(share * 100)}%`),
    el("td", { className: "num" }, String(t.hits)),
    el("td", { className: "num" }, short(t.damage / Math.max(1, t.hits))),
    el("td", { className: "num" }, short(t.max_hit)));
}
