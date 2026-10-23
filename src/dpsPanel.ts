// The panel's DPS tab: the recording under way, and every saved one, to look
// at by target and kind of bar, rename or delete; or the recordings by boss,
// each one opening right under its boss with the Boss filter on.
import { DpsBars, DpsTarget, Fight, Saved, dpsClear, dpsDelete, dpsLive, dpsRename, dpsSaveImage, dpsStart, dpsStop, onDpsChanged, onGearChanged, revealItemInDir } from "./api";
import { effectsSection } from "./dpsEffects";
import { fightImage } from "./dpsImage";
import { BARS, TARGETS, bossMs, clock, combatSeconds, loadGear, rowLine, rows, short } from "./dpsView";
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
/** The recording open under its boss in the boss view, and its own filter. */
let bossOpen: string | null = null;
let bossTarget: DpsTarget = "boss";
/** What the last copy or save said, for the recording it was about. */
let exported: { id: string; text: string; path?: string } | null = null;

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
  const clear = el("button", { type: "button", textContent: "Limpar", title: "Zera a gravação em andamento (sem salvar) e limpa o overlay" });
  clear.addEventListener("click", async () => { await dpsClear(); await poll(); });
  box.replaceChildren(
    live ? el("strong", { className: "rec" }, `● Gravando: ${live.name} · ${clock(Date.now() - live.started_ms)}`)
      : el("span", { className: "hint" }, auto ? "A gravação começa sozinha no seu primeiro golpe e termina depois de 30 s sem dano." : "A gravação começa e termina pelo botão (aqui ou no overlay)."),
    button, clear);
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

/** A recording's detail in `box`: in the Gravações list, or under its boss
 *  in the boss view, where it starts on the Boss filter. */
function renderDetail(box = $("#dps-detail"), id = picked, underBoss = false) {
  const f = saved?.fights.find((x) => x.id === id);
  if (!f || !saved) {
    box.replaceChildren();
    return;
  }
  const again = () => renderDetail(box, id, underBoss);
  const t = underBoss ? bossTarget : target ?? saved.settings.dps.target, b = bars ?? saved.settings.dps.bars;
  const name = el("input", { value: f.name, maxLength: 50, ariaLabel: "Nome da gravação", className: "dps-rename" });
  name.addEventListener("change", () => { if (name.value.trim()) dpsRename(f.id, name.value); });
  const del = el("button", { type: "button", textContent: "Apagar" });
  del.addEventListener("click", () => { if (confirm(`Apagar "${f.name}"?`)) dpsDelete(f.id); });
  const said = (text: string, path?: string) => { exported = { id: f.id, text, path }; again(); };
  const copy = el("button", { type: "button", textContent: "Copiar imagem", title: "Copia a gravação como imagem, do jeito que está filtrada, para colar no Discord" });
  copy.addEventListener("click", async () => {
    try {
      // The promise goes straight in so the copy still counts as the click's.
      await navigator.clipboard.write([new ClipboardItem({ "image/png": fightImage(f, t, b) })]);
      said("Imagem copiada. Cole no Discord com Ctrl+V.");
    } catch {
      try {
        said("Não deu para copiar; a imagem foi salva em", await dpsSaveImage(f.name, await fightImage(f, t, b)));
      } catch (e) {
        said(`Não deu para copiar nem salvar a imagem: ${e}`);
      }
    }
  });
  const save = el("button", { type: "button", textContent: "Salvar PNG", title: "Salva a imagem em Imagens\\Kiskwatch" });
  save.addEventListener("click", async () => {
    try {
      said("Imagem salva em", await dpsSaveImage(f.name, await fightImage(f, t, b)));
    } catch (e) {
      said(`Não deu para salvar a imagem: ${e}`);
    }
  });
  const note = exported?.id === f.id ? exported : null;
  const reveal = el("button", { type: "button", className: "link", textContent: note?.path ?? "" });
  reveal.addEventListener("click", () => { if (note?.path) revealItemInDir(note.path); });
  const list = rows(f, t, b);
  const boss = t === "boss" ? bossMs(f) : null;
  loadGear(list).then((changed) => { if (changed) again(); });
  const top = list.reduce((n, r) => Math.max(n, r.total), 0);
  const shown = f.players.find((p) => p.id === who) ?? f.players.find((p) => p.local) ?? f.players[0];
  const line = (r: (typeof list)[number]) => {
    const li = rowLine(r, b, top);
    li.classList.add("pick");
    li.classList.toggle("picked", r.player === shown);
    li.addEventListener("click", () => { who = r.player.id; again(); });
    return li;
  };
  const elsewhere = el("button", { type: "button", textContent: "Abrir em Gravações", title: "Abre esta gravação na lista de gravações, com o filtro Boss" });
  elsewhere.addEventListener("click", () => openFight(f.id));
  box.replaceChildren(
    el("div", { className: "dps-title" }, name, copy, save, del, ...(underBoss ? [elsewhere] : [])),
    ...(note ? [el("p", { className: "hint dps-exported", role: "status" }, note.text, ...(note.path ? [" ", reveal] : []))] : []),
    el("p", { className: "hint" }, `${when(f.started_ms)} · ${clock(f.ended_ms - f.started_ms)} · ${f.players.length} jogador(es)`,
      boss ? el("span", { title: "No filtro Boss, o dano por segundo conta do primeiro ao último golpe de qualquer jogador no chefe, como em Por chefe" }, ` · ${clock(boss)} no chefe (base do /s)`)
        : el("span", { title: "O dano por segundo conta só o tempo em combate: fora os trechos de 3 s ou mais em que ninguém do grupo agiu (caminhadas e esperas entre os pulls)" }, ` · ${clock(combatSeconds(f) * 1000)} em combate (base do /s)`)),
    el("div", { className: "dps-filters" },
      chips(TARGETS, t, (v) => { if (underBoss) bossTarget = v; else target = v; again(); }),
      chips(BARS, b, (v) => { bars = v; again(); })),
    list.length ? el("ol", { className: "dps-rows" }, ...list.map(line))
      : el("p", { className: "hint" }, "Nada para este alvo."),
    shown && b !== "heal" ? skillTable(f, shown, t, saved, again) : "",
    shown ? castsSection(f, shown, saved.profile, again) : "",
    timeline(f, f.players),
    takenSection(f, t, victim, (v) => { victim = v; again(); }),
    effectsSection(f, again),
    compareBox(f.id, underBoss ? openUnderBoss : openFight),
  );
}

/** Open a recording in the Gravações list, on the Boss filter, so its
 *  numbers are the ones the history shows. */
function openFight(id: string) {
  picked = id;
  who = null;
  victim = null;
  target = "boss";
  view = "fights";
  render();
  $("#dps-detail").scrollIntoView({ block: "start" });
}

/** Opens a recording under its boss, or closes it when it was open. */
function openUnderBoss(id: string) {
  bossOpen = bossOpen === id ? null : id;
  bossTarget = "boss";
  who = null;
  victim = null;
  render();
}

function bossDetail(id: string) {
  const box = el("div", { className: "boss-detail" });
  renderDetail(box, id, true);
  return box;
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
    renderBosses($("#boss-history"), bossOpen, openUnderBoss, bossDetail);
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
onGearChanged(() => { if (view === "fights") renderDetail(); });
setInterval(() => { if (live) poll(); }, 1000);
