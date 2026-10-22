// The panel's DPS tab: the recording under way, and every saved one, to look
// at by target and kind of bar, rename or delete; or the recordings by boss.
import { DpsBars, DpsTarget, Fight, Saved, dpsDelete, dpsLive, dpsRename, dpsStart, dpsStop, onDpsChanged } from "./api";
import { effectsSection } from "./dpsEffects";
import { BARS, TARGETS, clock, rowLine, rows, short } from "./dpsView";
import { timeline } from "./dpsTimeline";
import { skillTable } from "./dpsSkills";
import { castsSection } from "./dpsCasts";
import { takenSection } from "./taken";
import { compareBox, renderBosses } from "./bossHistory";

const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T;
function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, unknown> = {}, ...kids: (Node | string)[]): HTMLElementTagNameMap[K] {
  const e = Object.assign(document.createElement(tag), props);
  e.append(...kids);
  return e;
}

let saved: Saved | null = null;
let live: Fight | null = null;
let picked: string | null = null;
let target: DpsTarget | null = null;
let bars: DpsBars | null = null;
/** The player whose skills show: you, or the top one, until another is clicked. */
let who: number | null = null;
/** Whose damage taken is shown, by player id. */
let victim: number | null = null;
let view: "fights" | "bosses" = "fights";

const when = (ms: number) => new Date(ms).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
const damageOf = (f: Fight) => f.players.reduce((n, p) => n + p.boss_damage + p.mob_damage, 0);

function chips<T extends string>(options: [T, string][], current: T, pick: (v: T) => void) {
  return el("div", { className: "chip-group", role: "group" }, ...options.map(([value, label]) => {
    const b = el("button", { type: "button", textContent: label });
    b.setAttribute("aria-pressed", String(value === current));
    b.addEventListener("click", () => pick(value));
    return b;
  }));
}

function renderLive() {
  const box = $("#dps-live");
  const auto = saved?.settings.dps.start === "hit";
  const button = el("button", { type: "button", textContent: live ? "Parar a gravação" : "Gravar agora", className: live ? "rec" : "" });
  button.addEventListener("click", async () => { if (live) await dpsStop(); else await dpsStart(); await poll(); });
  box.replaceChildren(
    live ? el("strong", { className: "rec" }, `● Gravando: ${live.name} · ${clock(Date.now() - live.started_ms)}`)
      : el("span", { className: "hint" }, auto ? "A gravação começa sozinha no seu primeiro golpe e termina depois de 30 s sem dano." : "A gravação começa e termina pelo botão (aqui ou no overlay)."),
    button);
}

function renderList() {
  const fights = saved?.fights ?? [];
  if (!picked || !fights.some((f) => f.id === picked)) picked = fights[0]?.id ?? null;
  $("#dps-list").replaceChildren(...(fights.length ? fights.map((f) => {
    const b = el("button", { type: "button", className: f.id === picked ? "active" : "" },
      el("strong", {}, f.name),
      el("span", { className: "hint" }, `${when(f.started_ms)} · ${clock(f.ended_ms - f.started_ms)} · ${short(damageOf(f))} de dano`));
    b.addEventListener("click", () => { picked = f.id; who = null; victim = null; render(); });
    return el("li", {}, b);
  }) : [el("li", { className: "hint" }, "Nenhuma gravação ainda. Ligue o overlay de DPS em Configurações.")]));
}

function renderDetail() {
  const box = $("#dps-detail");
  const f = saved?.fights.find((x) => x.id === picked);
  if (!f || !saved) {
    box.replaceChildren();
    return;
  }
  const t = target ?? saved.settings.dps.target, b = bars ?? saved.settings.dps.bars;
  const name = el("input", { value: f.name, maxLength: 50, ariaLabel: "Nome da gravação", className: "dps-rename" });
  name.addEventListener("change", () => { if (name.value.trim()) dpsRename(f.id, name.value); });
  const del = el("button", { type: "button", textContent: "Apagar" });
  del.addEventListener("click", () => { if (confirm(`Apagar "${f.name}"?`)) dpsDelete(f.id); });
  const list = rows(f, t, b);
  const top = list.reduce((n, r) => Math.max(n, r.total), 0);
  const shown = f.players.find((p) => p.id === who) ?? f.players.find((p) => p.local) ?? f.players[0];
  const line = (r: (typeof list)[number]) => {
    const li = rowLine(r, b, top);
    li.classList.add("pick");
    li.classList.toggle("picked", r.player === shown);
    li.addEventListener("click", () => { who = r.player.id; render(); });
    return li;
  };
  box.replaceChildren(
    el("div", { className: "dps-title" }, name, del),
    el("p", { className: "hint" }, `${when(f.started_ms)} · ${clock(f.ended_ms - f.started_ms)} · ${f.players.length} jogador(es)`),
    el("div", { className: "dps-filters" },
      chips(TARGETS, t, (v) => { target = v; render(); }),
      chips(BARS, b, (v) => { bars = v; render(); })),
    list.length ? el("ol", { className: "dps-rows" }, ...list.map(line))
      : el("p", { className: "hint" }, "Nada para este alvo."),
    shown && b !== "heal" ? skillTable(f, shown, t, saved, renderDetail) : "",
    shown ? castsSection(f, shown, saved.profile, renderDetail) : "",
    timeline(f, f.players),
    takenSection(f, t, victim, (id) => { victim = id; render(); }),
    effectsSection(f, renderDetail),
    compareBox(f.id, openFight),
  );
}

function openFight(id: string) {
  picked = id;
  who = null;
  victim = null;
  view = "fights";
  render();
}

function renderView() {
  $("#dps-view").replaceChildren(chips([["fights", "Gravações"], ["bosses", "Por chefe"]], view, (v) => { view = v; render(); }));
  $("#dps-fights").hidden = view !== "fights";
  $("#boss-history").hidden = view !== "bosses";
}

function render() {
  renderLive();
  renderView();
  if (view === "bosses") {
    renderBosses($("#boss-history"), openFight);
    return;
  }
  renderList();
  renderDetail();
}

async function poll() {
  live = await dpsLive();
  renderLive();
}

export function renderDps(s: Saved) {
  saved = s;
  render();
  poll();
}

onDpsChanged(poll);
setInterval(() => { if (live) poll(); }, 1000);
