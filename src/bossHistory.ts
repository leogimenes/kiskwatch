// The DPS tab's boss history: every recording against each boss, how long it
// took and how much damage per second, and a recording set against your best
// one against the same boss, skill by skill.
import { Attempt, Comparison, bossHistory, dpsCompare } from "./api";
import { GameData, iconUrl, loadGameData } from "./buildData";
import { bossName, clock, short } from "./dpsView";

export { bossName };

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, unknown> = {}, ...kids: (Node | string)[]): HTMLElementTagNameMap[K] {
  const e = Object.assign(document.createElement(tag), props);
  e.append(...kids);
  return e;
}

const when = (ms: number) => new Date(ms).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });

let game: GameData | null = null;
let skillsReady: Promise<void> | null = null;

function skillLabel(id: number) {
  const s = game?.skills.get(id);
  return el("span", { className: "boss-skill" },
    s?.icon ? el("img", { src: iconUrl(s.icon), alt: "", loading: "lazy" }) : "",
    s?.name ?? `Skill ${id}`);
}

/** +12% / −8%, with the class saying better or worse. */
function delta(now: number, then: number, lowerIsBetter = false) {
  if (!then) return el("span", { className: "hint" }, now ? "novo" : "");
  const d = (now - then) / then;
  const good = lowerIsBetter ? d < 0 : d > 0;
  const text = `${d > 0 ? "+" : d < 0 ? "−" : "±"}${Math.abs(Math.round(d * 100))}%`;
  return el("span", { className: Math.abs(d) < 0.005 ? "hint" : good ? "up" : "down" }, text);
}

/** The bosses with their recordings; `pick` opens or closes one, and the open
 *  one shows `detail` right under its line. */
export async function renderBosses(box: HTMLElement, open: string | null, pick: (fightId: string) => void, detail: (fightId: string) => HTMLElement) {
  const list = await bossHistory();
  if (!list.length) {
    box.replaceChildren(el("p", { className: "hint" }, "Nenhuma gravação contra chefe ainda. As gravações feitas a partir desta versão guardam o chefe em que você mais bateu."));
    return;
  }
  box.replaceChildren(...list.map((h) => {
    const top = Math.max(...h.attempts.map((a) => a.my_dps));
    const line = (a: Attempt) => {
      const bar = el("span", { className: "boss-bar" });
      bar.style.width = `${top ? (100 * a.my_dps) / top : 0}%`;
      const b = el("button", { type: "button", className: `${a.fight_id === h.best_id ? "best" : ""}${a.fight_id === open ? " open" : ""}` },
        el("span", {}, `${a.fight_id === h.best_id ? "★ " : ""}${when(a.started_ms)}`),
        el("span", { className: "dps-num" }, clock(a.kill_ms)),
        el("span", { className: "dps-num" }, `${short(a.my_dps)}/s`),
        el("span", { className: "dps-num hint" }, `grupo ${short(a.group_dps)}/s · ${a.players}`),
        el("span", { className: "boss-open" }, a.fight_id === open ? "Fechar ▴" : "Detalhes ▾"),
        el("span", { className: "boss-track" }, bar));
      b.title = `${a.name}: ${a.fight_id === open ? "clique para fechar" : "clique para ver o detalhamento"}`;
      b.setAttribute("aria-expanded", String(a.fight_id === open));
      b.addEventListener("click", () => pick(a.fight_id));
      return el("li", {}, b, ...(a.fight_id === open ? [detail(a.fight_id)] : []));
    };
    return el("section", { className: "boss-card" },
      el("h3", {}, bossName(h.code)),
      el("p", { className: "hint" },
        `${h.attempts.length} gravação(ões) · tempo médio ${clock(h.avg_kill_ms)} · mais rápida ${clock(h.fastest_kill_ms)} · seu DPS médio ${short(h.avg_my_dps)}/s · grupo ${short(h.avg_group_dps)}/s`),
      el("div", { className: "boss-head hint" }, el("span", {}, "Quando"), el("span", {}, "Tempo no chefe"), el("span", {}, "Seu DPS"), el("span", {}, "Grupo"), el("span", {})),
      el("ol", { className: "boss-attempts" }, ...h.attempts.map(line)));
  }));
}

function comparison(c: Comparison, pick: (fightId: string) => void) {
  const best = el("a", { href: "#", textContent: `${c.best.name} (${when(c.best.started_ms)})` });
  best.addEventListener("click", (e) => { e.preventDefault(); pick(c.best.fight_id); });
  const stat = (label: string, now: string, then: string, d: HTMLElement) =>
    el("div", { className: "boss-stat" }, el("span", { className: "hint" }, label), el("strong", {}, now), el("span", { className: "hint" }, `melhor: ${then}`), d);
  const rows = c.skills.filter((s) => s.damage || s.best_damage).map((s) =>
    el("tr", {},
      el("td", {}, skillLabel(s.skill)),
      el("td", { className: "dps-num" }, `${short(s.dps)}/s`),
      el("td", { className: "dps-num hint" }, `${short(s.best_dps)}/s`),
      el("td", {}, delta(s.dps, s.best_dps)),
      el("td", { className: "dps-num hint" }, `${s.hits} / ${s.best_hits}`)));
  return el("section", { className: "boss-compare" },
    el("h3", {}, `Contra ${bossName(c.code)}`),
    el("p", { className: "hint" }, c.is_best ? "Esta é a sua melhor luta contra este chefe. Comparada com a segunda melhor: " : "Comparada com a sua melhor luta contra este chefe: ", best),
    el("div", { className: "boss-stats" },
      stat("Seu DPS no chefe", `${short(c.now.my_dps)}/s`, `${short(c.best.my_dps)}/s`, delta(c.now.my_dps, c.best.my_dps)),
      stat("Tempo no chefe", clock(c.now.kill_ms), clock(c.best.kill_ms), delta(c.now.kill_ms, c.best.kill_ms, true)),
      stat("DPS do grupo", `${short(c.now.group_dps)}/s`, `${short(c.best.group_dps)}/s`, delta(c.now.group_dps, c.best.group_dps))),
    rows.length ? el("table", { className: "boss-skills" },
      el("thead", {}, el("tr", {}, ...["Skill", "Agora", "Melhor", "", "Golpes"].map((t) => el("th", {}, t)))),
      el("tbody", {}, ...rows)) : el("p", { className: "hint" }, "Sem dano seu no chefe para comparar por skill."));
}

/** A box that fills with the recording against your best one, or stays empty. */
export function compareBox(fightId: string, pick: (fightId: string) => void) {
  const box = el("div");
  skillsReady ??= loadGameData().then((g) => { game = g; }, () => {});
  Promise.all([dpsCompare(fightId), skillsReady]).then(([c]) => { if (c) box.replaceChildren(comparison(c, pick)); });
  return box;
}
