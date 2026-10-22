// The panel: timers with their alarms, the pet collection and its map, settings.
import {
  ALARM_LEADS, Accessibility, Hotkeys, Pace, Saved, Settings, SoulSeen, TimerRow, captureStatus, countdown, getPaces, getSaved, getSouls, getTimers,
  hotkeysStatus, onOpenSettings, onStateChanged, openUrl, pauseHotkeys, setAlarm, setClickThrough, setHotkeys, setPet, setSettings, updateCheck,
} from "./api";
import { Drop, GENUS, GENUS_MARK, PETS, Pet, REGIONS, SERVERS, SOULS_PER_LEVEL, mapLink, name, soulsToMax, t } from "./data";
import { farming, paceText } from "./farm";
import { Stop, leg, plan, totals } from "./route";
import { renderBuild } from "./build";
import { renderDps } from "./dpsPanel";
import { renderGroup } from "./group";
import { renderChecklist } from "./checklist";
import "./enchant";
import "./update";
import "./share";
import { applyLook, chime } from "./look";

const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T;
function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, unknown> = {}, ...kids: (Node | string)[]): HTMLElementTagNameMap[K] {
  const { dataset, ...rest } = props as { dataset?: Record<string, string> };
  const e = Object.assign(document.createElement(tag), rest);
  if (dataset) Object.assign(e.dataset, dataset);
  e.append(...kids);
  return e;
}

let saved: Saved | null = null;
let timers: TimerRow[] = [];
let souls: SoulSeen[] = [];
let paces: Pace[] = [];

/** Save a change to the settings. */
function update(change: (s: Settings) => void) {
  if (!saved) return;
  const next = structuredClone(saved.settings);
  change(next);
  saved.settings = next;
  return setSettings(next);
}

// Links open in the browser, not in the panel.
document.addEventListener("click", (e) => {
  const a = (e.target as HTMLElement).closest("a[href^='http']") as HTMLAnchorElement | null;
  if (!a) return;
  e.preventDefault();
  openUrl(a.href);
});

// ---- Tabs ----
document.querySelectorAll<HTMLButtonElement>(".tabs button").forEach((b) =>
  b.addEventListener("click", () => {
    document.querySelectorAll(".tabs button, .tab").forEach((x) => x.classList.remove("active"));
    b.classList.add("active");
    $(`#tab-${b.dataset.tab}`).classList.add("active");
  }),
);

// An overlay's gear: the settings tab, on that overlay's options, lit up for a moment.
onOpenSettings((overlay) => {
  $<HTMLButtonElement>('.tabs button[data-tab="config"]').click();
  const group = document.querySelector<HTMLElement>(`#cfg-${overlay}`);
  if (!group) return;
  group.scrollIntoView({ block: "center" });
  group.classList.remove("lit");
  void group.offsetWidth;
  group.classList.add("lit");
});

// ---- Server ----
const regionSel = $<HTMLSelectElement>("#region");
const serverSel = $<HTMLSelectElement>("#server");
for (const [id, label] of Object.entries(REGIONS)) regionSel.append(el("option", { value: id, textContent: label }));

function fillServers(region: number, selected: number) {
  serverSel.replaceChildren(
    ...SERVERS.filter((s) => s.region === region)
      .sort((a, b) => a.side.localeCompare(b.side) || a.name.localeCompare(b.name))
      .map((s) => el("option", { value: String(s.id), textContent: `${s.name} (${s.side === "elyos" ? "Elyos" : "Asmodian"})`, selected: s.id === selected })),
  );
}
regionSel.addEventListener("change", () => {
  fillServers(Number(regionSel.value), 0);
  serverSel.dispatchEvent(new Event("change"));
});
serverSel.addEventListener("change", () => update((s) => { s.server_id = Number(serverSel.value); }));

// ---- Timers ----
const timerSearch = $<HTMLInputElement>("#timer-search");
const timerKind = $<HTMLSelectElement>("#timer-kind");
timerSearch.addEventListener("input", () => renderTimers());
timerKind.addEventListener("input", () => renderTimers());

function whereText(row: TimerRow) {
  return row.where.map(t).join(", ") || "—";
}

function timerName(row: TimerRow) {
  const names = [row.name, ...row.also].map(t).join(" / ");
  return row.level ? `${names} (nv. ${row.level})` : names;
}

function startText(row: TimerRow, now: number) {
  if (row.kind === "field-boss") {
    if (row.up) return "vivo agora";
    if (row.start_ms == null) return "abra o mapa no jogo";
    if (row.start_ms <= now) return "já deve ter voltado";
  }
  if (row.start_ms == null) return "—";
  if (row.start_ms <= now && row.end_ms && row.end_ms > now) return `acontecendo (${countdown(row.end_ms - now)})`;
  return countdown(row.start_ms - now);
}

/** Lowercase without accents, so "fogo" finds "Fôgo". */
const fold = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

function shownTimers() {
  const q = fold(timerSearch.value.trim());
  const kind = timerKind.value;
  return timers
    .filter((r) => r.kind !== "reset")
    .filter((r) => !kind || (kind === "alarm" ? r.leads.length > 0 : r.kind === kind))
    .filter((r) => !q || fold(`${timerName(r)} ${whereText(r)}`).includes(q));
}

// Resets are for the whole game, not something to catch: a line of their own.
function renderResets(now: number) {
  $("#resets").replaceChildren(
    ...timers.filter((r) => r.kind === "reset").map((r) =>
      el("span", { className: "reset" }, `${t(r.name)} em `, el("strong", { className: "countdown", dataset: { id: r.id } }, startText(r, now))),
    ),
  );
}

const leadText = (lead: number) => (lead === 60 ? "1h" : `${lead} min`);

/** The timer whose alarm menu is open, kept open across re-renders. */
let alarmOpen: string | null = null;

// One bell per timer; the lead times are in a menu under it.
function alarmButton(row: TimerRow) {
  const on = row.leads.length > 0;
  const leads = [...row.leads].sort((a, b) => b - a);
  const bell = el("button", {
    className: on ? "bell on" : "bell",
    ariaHasPopup: "true",
    ariaExpanded: String(alarmOpen === row.id),
    ariaLabel: on ? `Avisos: ${leads.map(leadText).join(", ")} antes` : "Sem aviso. Abrir opções de aviso",
  }, el("span", { ariaHidden: "true", textContent: on ? "🔔" : "🔕" }), on ? ` ${leads.map(leadText).join(", ")}` : "");
  const wrap = el("div", { className: "alarm" }, bell);
  bell.addEventListener("click", (e) => {
    e.stopPropagation();
    alarmOpen = alarmOpen === row.id ? null : row.id;
    renderTimers();
  });
  if (alarmOpen === row.id) {
    const menu = el("div", { className: "alarm-menu", role: "menu" });
    menu.addEventListener("click", (e) => e.stopPropagation());
    for (const lead of ALARM_LEADS) {
      const box = el("input", { type: "checkbox", checked: row.leads.includes(lead) });
      box.addEventListener("change", () => setAlarm(row.id, box.checked ? [...row.leads, lead] : row.leads.filter((l) => l !== lead)));
      menu.append(el("label", { role: "menuitemcheckbox" }, box, ` ${leadText(lead)} antes`));
    }
    const off = el("button", { textContent: "Desligar", disabled: !on });
    off.addEventListener("click", () => { alarmOpen = null; setAlarm(row.id, []); });
    menu.append(off);
    wrap.append(menu);
  }
  return wrap;
}
document.addEventListener("click", () => { if (alarmOpen) { alarmOpen = null; renderTimers(); } });
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && alarmOpen) { alarmOpen = null; renderTimers(); } });

function renderTimers() {
  const now = Date.now();
  renderResets(now);
  const rows = shownTimers();
  const total = timers.filter((r) => r.kind !== "reset").length;
  $("#timer-count").textContent = rows.length === total ? "" : `${rows.length} de ${total}`;
  $("#timers").replaceChildren(
    ...rows.map((row) => {
      return el("tr", { className: row.kind },
        el("td", {}, timerName(row)),
        el("td", {}, whereText(row)),
        el("td", { className: "countdown", dataset: { id: row.id } }, startText(row, now)),
        el("td", {}, alarmButton(row)),
      );
    }),
  );
  if (!rows.length) $("#timers").append(el("tr", {}, el("td", { colSpan: 4, className: "hint" }, "Nada com esse nome.")));
}

function tickCountdowns() {
  const now = Date.now();
  document.querySelectorAll<HTMLElement>(".countdown").forEach((cell) => {
    const row = timers.find((r) => r.id === cell.dataset.id);
    if (row) cell.textContent = startText(row, now);
  });
}

// ---- Pets ----
const petFilters = {
  search: $<HTMLInputElement>("#pet-search"),
  genus: $<HTMLSelectElement>("#pet-genus"),
  region: $<HTMLSelectElement>("#pet-region"),
  level: $<HTMLSelectElement>("#pet-level"),
  min: $<HTMLInputElement>("#pet-min"),
  sort: $<HTMLSelectElement>("#pet-sort"),
  chests: $<HTMLInputElement>("#pet-chests"),
};
for (const [id, texts] of Object.entries(GENUS)) if (id !== "special") petFilters.genus.append(el("option", { value: id, textContent: name(texts) }));
for (const r of [...new Set(PETS.flatMap((p) => p.drops.map((d) => d.region)))].sort()) petFilters.region.append(el("option", { value: r, textContent: r }));
Object.values(petFilters).forEach((f) => f.addEventListener("input", () => renderPets()));

function progress(pet: number) {
  const server = saved?.settings.server_id ?? 0;
  return saved?.pets[String(server)]?.pets[String(pet)] ?? { level: 0, points: 0 };
}

interface PetRow {
  pet: Pet;
  level: number;
  points: number;
  missing: number;
  drops: Drop[];
}

function filteredPets(): PetRow[] {
  const q = fold(petFilters.search.value.trim());
  const region = petFilters.region.value;
  const rows = PETS.filter((p) => p.genus !== "special" && !p.unreleased)
    .map((pet) => {
      const { level, points } = progress(pet.id);
      const drops = pet.drops.filter((d) => !region || d.region === region);
      return { pet, level, points, missing: soulsToMax(level, points), drops };
    })
    .filter((r) => !petFilters.genus.value || r.pet.genus === petFilters.genus.value)
    .filter((r) => petFilters.level.value === "" || r.level === Number(petFilters.level.value))
    .filter((r) => r.missing >= Number(petFilters.min.value || 0))
    .filter((r) => petFilters.chests.checked || r.pet.drops.length > 0)
    .filter((r) => !region || r.drops.length > 0)
    .filter((r) => !q || fold(name(r.pet.name)).includes(q) || fold(r.pet.name.en ?? "").includes(q)
      || r.pet.drops.some((d) => fold(t(d.npc)).includes(q)));
  const by = petFilters.sort.value;
  rows.sort((a, b) =>
    by === "missing-asc" ? a.missing - b.missing
      : by === "level" ? a.level - b.level
      : by === "name" ? name(a.pet.name).localeCompare(name(b.pet.name))
      : b.missing - a.missing);
  return rows;
}

function dropText(d: Drop) {
  const zone = d.zones.map(t).join(", ");
  const tp = d.kibelisk ? ` · Kibelisk #${d.kibelisk.teleport} ${t(d.kibelisk.name)} (${d.kibelisk.m} m)` : "";
  return `${t(d.npc)} (nv. ${d.level}, ${d.chance}) · ${t(d.map)}${zone ? ` · ${zone}` : ""} · ${d.spawns} spawns${tp}`;
}

const genusBadge = (genus: string | null) =>
  el("span", { className: `genus ${genus ?? ""}`, title: genus ? name(GENUS[genus] ?? {}) : "" }, genus ? GENUS_MARK[genus] ?? "" : "");

function pinned(pet: number) {
  return saved?.settings.pinned_pets.includes(pet) ?? false;
}

function togglePin(pet: number) {
  update((s) => {
    s.pinned_pets = s.pinned_pets.includes(pet) ? s.pinned_pets.filter((p) => p !== pet) : [...s.pinned_pets, pet];
  });
}

let selectedPet: number | null = null;

/** The pace column: souls an hour and the time to level 3, from the last run. */
function paceCell(p: Pace | undefined): string {
  if (!p) return "—";
  return `${paceText(p).replace(" · ", "\n")}\núltimo farm ${new Date(p.last_ms).toLocaleString([], { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}`;
}

function renderPets() {
  const rows = filteredPets();
  const all = PETS.filter((p) => p.genus !== "special" && !p.unreleased);
  const missingTotal = all.reduce((sum, p) => { const g = progress(p.id); return sum + soulsToMax(g.level, g.points); }, 0);
  // As the game counts them: every pet you have, Special ones included (they
  // come at their highest level and take no souls).
  const owned = PETS.filter((p) => !p.unreleased && progress(p.id).level >= 1);
  const maxed = owned.filter((p) => p.genus === "special" || progress(p.id).level >= 3).length;
  const now = farming(souls, Date.now());
  const farm = now && PETS.find((p) => p.id === now.pet);
  $("#pet-summary").textContent = `Coleção ${owned.length} · ${maxed} no nível máximo · ${missingTotal} almas faltando no total · ${rows.length} pets na lista`
    + (farm ? ` · farmando ${name(farm.name)}` : "");
  const paceOf = (pet: number) => paces.find((x) => x.pet === pet);

  $("#pets").replaceChildren(
    ...rows.map((r) => {
      const level = el("select", { ariaLabel: "Nível" });
      for (let l = 0; l <= 3; l++) level.append(el("option", { value: String(l), textContent: String(l), selected: l === r.level }));
      const points = el("input", { type: "number", min: "0", value: String(r.points), className: "points", ariaLabel: "Almas no nível" });
      const save = () => setPet(r.pet.id, Number(level.value), Number(points.value) || 0);
      level.addEventListener("change", save);
      points.addEventListener("change", save);
      const on = pinned(r.pet.id);
      const pin = el("button", { className: on ? "pin on" : "pin", textContent: on ? "★" : "☆", ariaPressed: String(on), ariaLabel: `Fixar ${name(r.pet.name)} no overlay` });
      pin.addEventListener("click", () => togglePin(r.pet.id));
      const best = [...r.drops].sort((a, b) => b.spawns - a.spawns);
      const where = best.length ? best.slice(0, 2).map(dropText).join("\n") : r.pet.chests.length ? "Só em baús de alma" : "—";
      const title = el("button", { className: "pet-name", title: "Mostrar no mapa" }, genusBadge(r.pet.genus), el("strong", {}, name(r.pet.name)));
      title.addEventListener("click", () => selectPet(r.pet.id, true));
      return el("tr", { className: r.pet.id === selectedPet ? "selected" : "", dataset: { pet: String(r.pet.id) } },
        el("td", {}, pin),
        el("td", {}, title, el("br"), el("small", {}, r.pet.genus ? name(GENUS[r.pet.genus] ?? {}) : "")),
        el("td", {}, level),
        el("td", {}, points),
        el("td", { className: "missing" }, String(r.missing)),
        el("td", { className: "pace" }, paceCell(paceOf(r.pet.id))),
        el("td", { className: "where" }, where),
      );
    }),
  );
  renderMap(rows);
  renderRoute();
}

// ---- Map ----
// A schematic map in the game's world units: where each monster spawns (`at`)
// and the nearest Kibelisk (`to`). The map art is on Aion 2 Timers, linked
// from the selected point.
const mapSel = $<HTMLSelectElement>("#map-select");
const zoneSel = $<HTMLSelectElement>("#map-zone");
const mapNames = $<HTMLInputElement>("#map-names");
const mapKibs = $<HTMLInputElement>("#map-kibs");
const svg = $("#map") as unknown as SVGSVGElement;
const NS = "http://www.w3.org/2000/svg";
const SIZE = 1000;
const MAX_SOULS = SOULS_PER_LEVEL.reduce((a, b) => a + b, 0);

interface Spot { r: PetRow; d: Drop; }
let spots: Spot[] = [];
/** The visible part, in map units (0..SIZE). */
let view = { x: 0, y: 0, w: SIZE };
let fit = (_p: [number, number]): [number, number] => [0, 0];

mapSel.addEventListener("change", () => { zoneSel.value = ""; renderPets(); resetView(); });
zoneSel.addEventListener("change", () => { renderPets(); resetView(); });
mapNames.addEventListener("change", () => drawMap());
mapKibs.addEventListener("change", () => drawMap());
$("#map-fit").addEventListener("click", () => resetView());
$("#map-in").addEventListener("click", () => zoom(0.7, view.x + view.w / 2, view.y + view.w / 2));
$("#map-out").addEventListener("click", () => zoom(1 / 0.7, view.x + view.w / 2, view.y + view.w / 2));
$("#map-wide").addEventListener("click", (e) => {
  const wide = $(".pets-layout").classList.toggle("wide");
  const b = e.currentTarget as HTMLElement;
  b.ariaPressed = String(wide);
  b.textContent = wide ? "Reduzir" : "Ampliar";
  drawMap();
});

function resetView() {
  view = { x: 0, y: 0, w: SIZE };
  drawMap();
}

function zoom(by: number, cx: number, cy: number) {
  const w = Math.min(SIZE, Math.max(SIZE / 40, view.w * by));
  view = { x: cx - (cx - view.x) * (w / view.w), y: cy - (cy - view.y) * (w / view.w), w };
  drawMap();
}

/** The svg's square drawing area on screen. */
function svgBox() {
  const box = svg.getBoundingClientRect();
  const side = Math.min(box.width, box.height);
  return { left: box.left + (box.width - side) / 2, top: box.top + (box.height - side) / 2, side };
}

/** A point on the svg, in map units. */
function svgPoint(e: MouseEvent): [number, number] {
  const b = svgBox();
  return [view.x + ((e.clientX - b.left) / b.side) * view.w, view.y + ((e.clientY - b.top) / b.side) * view.w];
}

svg.addEventListener("wheel", (e) => {
  e.preventDefault();
  const [x, y] = svgPoint(e);
  zoom(e.deltaY < 0 ? 0.8 : 1.25, x, y);
}, { passive: false });

let drag: { x: number; y: number; vx: number; vy: number; moved: boolean } | null = null;
svg.addEventListener("pointerdown", (e) => {
  drag = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y, moved: false };
});
window.addEventListener("pointermove", (e) => {
  if (!drag) return;
  const k = view.w / svgBox().side;
  const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
  if (Math.abs(dx) + Math.abs(dy) > 4) drag.moved = true;
  if (!drag.moved) return;
  view = { ...view, x: drag.vx - dx * k, y: drag.vy - dy * k };
  drawMap();
});
// After the click a drag ends with, so the click can tell it was a drag.
window.addEventListener("pointerup", () => setTimeout(() => (drag = null)));

function renderMap(rows: PetRow[]) {
  const drops = rows.filter((r) => r.missing > 0).flatMap((r) => r.drops.filter((d) => d.kibelisk).map((d) => ({ r, d })));
  const maps = [...new Map(drops.map(({ d }) => [d.mapId, d])).values()];
  const keep = mapSel.value;
  mapSel.replaceChildren(...maps.map((d) => el("option", { value: String(d.mapId), textContent: `${d.region} · ${t(d.map)}`, selected: String(d.mapId) === keep })));
  const mapId = Number(mapSel.value);
  const onMap = drops.filter(({ d }) => d.mapId === mapId);
  const zones = [...new Set(onMap.map(({ d }) => d.zones[0]).filter(Boolean))].sort((a, b) => t(a).localeCompare(t(b)));
  const keepZone = zoneSel.value;
  zoneSel.replaceChildren(el("option", { value: "", textContent: "Todas as zonas" }),
    ...zones.map((z) => el("option", { value: z, textContent: t(z), selected: z === keepZone })));
  spots = onMap.filter(({ d }) => !zoneSel.value || d.zones[0] === zoneSel.value);

  // Fit what is shown, spawns and Kibelisks, into the box, north up.
  const pts = spots.flatMap(({ d }) => [d.kibelisk!.to, d.kibelisk!.at]);
  if (pts.length) {
    const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
    const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
    const span = Math.max(x1 - x0, y1 - y0, 1);
    const pad = 0.06 * SIZE, inner = SIZE - 2 * pad;
    const ox = pad + (inner - ((x1 - x0) / span) * inner) / 2, oy = pad + (inner - ((y1 - y0) / span) * inner) / 2;
    fit = (p) => [ox + ((p[0] - x0) / span) * inner, SIZE - (oy + ((p[1] - y0) / span) * inner)];
  }
  drawMap();
}

function add(parent: Element, tag: string, attrs: Record<string, string | number>, text?: string) {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  if (text) e.textContent = text;
  parent.append(e);
  return e;
}

function drawMap() {
  svg.setAttribute("viewBox", `${view.x} ${view.y} ${view.w} ${view.w}`);
  svg.replaceChildren();
  if (!spots.length) {
    add(svg, "text", { x: view.x + view.w / 2, y: view.y + view.w / 2, class: "empty", "font-size": view.w / 28, "text-anchor": "middle" }, "Nenhum pet da lista neste mapa");
    renderMapInfo();
    return;
  }
  // Sizes are in screen pixels, whatever the zoom and the panel's width.
  const k = view.w / (svgBox().side || 500);
  // Stroke widths and dashes are in map units too, so they scale with k:
  // in CSS pixels they would grow with the zoom and cover the dots.
  const links = add(svg, "g", { class: "links", "stroke-width": 1.5 * k, "stroke-dasharray": `${4 * k} ${3 * k}` });
  const kibs = add(svg, "g", {});
  // Names under the dots, so a name never hides one.
  const labels = add(svg, "g", { class: "labels", "font-size": 12 * k, "stroke-width": 3 * k });
  const path = add(svg, "g", { class: "route-path", "stroke-width": 3 * k });
  const dots = add(svg, "g", {});
  const steps = add(svg, "g", { class: "steps", "font-size": 13 * k, "stroke-width": 3 * k });
  const onMap = routeStops().filter((s) => s.drop.mapId === Number(mapSel.value));
  onMap.forEach((s, i) => {
    const [x, y] = fit(s.drop.kibelisk!.at);
    if (i > 0) {
      const l = leg(onMap[i - 1].drop, s.drop);
      const [fx, fy] = fit(l.teleport ? s.drop.kibelisk!.to : onMap[i - 1].drop.kibelisk!.at);
      add(path, "line", { x1: fx, y1: fy, x2: x, y2: y, class: l.teleport ? "jump" : "" });
    }
    add(steps, "text", { x: x - 10 * k, y: y - 9 * k, "text-anchor": "end" }, String(i + 1));
  });
  // Names only once zoomed in enough to read them, unless there are few.
  const names = view.w <= SIZE * 0.45 || spots.length <= 30;
  const seen = new Set<number>();
  for (const { d } of spots) {
    const kib = d.kibelisk!;
    if (!mapKibs.checked || seen.has(kib.teleport)) continue;
    seen.add(kib.teleport);
    const [x, y] = fit(kib.to);
    const s = 4 * k;
    const rect = add(kibs, "rect", { x: x - s, y: y - s, width: 2 * s, height: 2 * s, class: "kib" });
    add(rect, "title", {}, `Kibelisk #${kib.teleport} ${t(kib.name)}`);
    if (names) add(labels, "text", { x: x + s + 3 * k, y: y + 4 * k, class: "kib-label" }, `#${kib.teleport}`);
  }
  for (const { r, d } of spots) {
    const [x, y] = fit(d.kibelisk!.at);
    const chosen = r.pet.id === selectedPet;
    if (mapKibs.checked) {
      const [kx, ky] = fit(d.kibelisk!.to);
      add(links, "line", { x1: kx, y1: ky, x2: x, y2: y, class: chosen ? "chosen" : "" });
    }
    const g = add(dots, "g", { class: `spot ${r.pet.genus ?? ""}${chosen ? " chosen" : ""}`, tabindex: 0, role: "button", "aria-label": `${name(r.pet.name)}: faltam ${r.missing}` });
    // Area grows with the souls missing: from 4 px (almost done) to 16 px (all 105).
    const rad = (4 + 12 * Math.sqrt(r.missing / MAX_SOULS)) * k;
    add(g, "circle", { cx: x, cy: y, r: rad, "stroke-width": (chosen ? 3 : 1.5) * k });
    add(g, "text", { x, y: y + 3.5 * k, class: "mark", "font-size": 10 * k, "text-anchor": "middle" }, GENUS_MARK[r.pet.genus ?? ""] ?? "");
    add(g, "title", {}, `${name(r.pet.name)}: faltam ${r.missing}\n${dropText(d)}`);
    const pick = () => { if (!drag?.moved) selectPet(r.pet.id, false, d); };
    g.addEventListener("click", pick);
    g.addEventListener("keydown", (e) => { if ((e as KeyboardEvent).key === "Enter") pick(); });
    if ((names && mapNames.checked) || chosen) add(labels, "text", { x: x + rad + 3 * k, y: y + 4 * k, class: chosen ? "chosen" : "" }, name(r.pet.name));
  }
  renderMapInfo();
}

let selectedDrop: Drop | null = null;

/** Point a pet out on the map and in the list. */
function selectPet(pet: number, fromList: boolean, drop?: Drop) {
  selectedPet = pet;
  const p = PETS.find((x) => x.id === pet)!;
  const region = petFilters.region.value;
  selectedDrop = drop ?? [...p.drops].filter((d) => d.kibelisk && (!region || d.region === region)).sort((a, b) => b.spawns - a.spawns)[0] ?? null;
  if (fromList && selectedDrop) {
    if (mapSel.value !== String(selectedDrop.mapId) || (zoneSel.value && zoneSel.value !== selectedDrop.zones[0])) {
      zoneSel.value = "";
      mapSel.value = String(selectedDrop.mapId);
    }
    renderPets();
    // Zoom in on it.
    const [x, y] = fit(selectedDrop.kibelisk!.at);
    const w = Math.min(view.w, SIZE / 3);
    view = { x: x - w / 2, y: y - w / 2, w };
    drawMap();
  } else {
    renderPets();
    document.querySelector(`#pets tr[data-pet="${pet}"]`)?.scrollIntoView({ block: "nearest" });
  }
}

function renderMapInfo() {
  const box = $("#map-info");
  const p = selectedPet != null ? PETS.find((x) => x.id === selectedPet) : null;
  if (!p) { box.replaceChildren(); return; }
  const g = progress(p.id);
  const d = selectedDrop;
  box.replaceChildren(
    el("div", { className: "info-head" }, genusBadge(p.genus), el("strong", {}, name(p.name)), ` · nível ${g.level} · faltam ${soulsToMax(g.level, g.points)}`),
    ...(d ? [el("div", {}, dropText(d)), el("a", { href: mapLink(d) }, "Ver os spawns no mapa do jogo (Aion 2 Timers) ↗")]
      : [el("div", { className: "hint" }, "Sem spawn com posição conhecida.")]),
  );
}

// ---- Route ----
/** The saved route, with each stop's pet and monster looked up. */
function routeStops(): Stop[] {
  return (saved?.settings.route ?? []).flatMap((r) => {
    const pet = PETS.find((p) => p.id === r.pet);
    const drop = pet?.drops.find((d) => d.npcId === r.npc && d.kibelisk);
    const g = progress(r.pet);
    // Done pets leave the route.
    return pet && drop && soulsToMax(g.level, g.points) > 0 ? [{ pet, drop }] : [];
  });
}

$("#route-go").addEventListener("click", () => {
  const options = [...new Map(spots.map(({ r }) => [r.pet.id, r.pet])).values()].map((pet) => ({
    pet, drops: spots.filter((s) => s.r.pet.id === pet.id).map((s) => s.d),
  }));
  // Start where the pet being farmed is, when it is on this map.
  const cur = farming(souls, Date.now());
  const here = cur && options.find((o) => o.pet.id === cur.pet);
  const start = here ? { pet: here.pet, drop: [...here.drops].sort((a, b) => b.spawns - a.spawns)[0] } : undefined;
  const route = plan(options, start);
  update((s) => { s.route = route.map((r) => ({ pet: r.pet.id, npc: r.drop.npcId })); });
  renderRoute();
  drawMap();
});
$("#route-clear").addEventListener("click", () => { update((s) => { s.route = []; }); renderRoute(); drawMap(); });

function renderRoute() {
  const stops = routeStops();
  const sum = $("#route-sum");
  const list = $("#route");
  if (!stops.length) {
    list.replaceChildren();
    sum.textContent = "Calcula a ordem com menos caminhada para farmar os pets da lista neste mapa (e zona), usando os Kibelisks quando compensa. O overlay de pets mostra o próximo da rota.";
    return;
  }
  const { walk, jumps } = totals(stops);
  sum.textContent = `${stops.length} pets · ${walk >= 1000 ? `${(walk / 1000).toFixed(1)} km` : `${walk} m`} a pé · ${jumps} teleporte(s). Pets que chegam ao nível 3 saem da rota.`;
  list.replaceChildren(...stops.map((s, i) => {
    const g = progress(s.pet.id);
    const k = s.drop.kibelisk!;
    let how = `Kibelisk #${k.teleport}, ${k.m} m`;
    if (i > 0) {
      const l = leg(stops[i - 1].drop, s.drop);
      how = l.teleport ? `teleporte ao Kibelisk #${k.teleport} + ${k.m} m` : `andar ${Math.round(l.m)} m`;
    }
    const item = el("li", { className: s.pet.id === selectedPet ? "selected" : "" },
      el("div", { className: "info-head" }, genusBadge(s.pet.genus), el("strong", {}, name(s.pet.name)), ` · faltam ${soulsToMax(g.level, g.points)}`),
      el("div", { className: "hint" }, `${t(s.drop.npc)} · ${s.drop.zones.map(t)[0] ?? t(s.drop.map)} · ${how}`));
    item.addEventListener("click", () => selectPet(s.pet.id, true));
    return item;
  }));
}

// ---- Capture ----
const capDot = $<HTMLButtonElement>("#capture");
const capPop = $("#capture-pop");
let shownError: string | null = null;

function openCapture(open: boolean) {
  capPop.hidden = !open;
  capDot.ariaExpanded = String(open);
}
capDot.addEventListener("click", () => openCapture(capPop.hidden));
document.addEventListener("keydown", (e) => { if (e.key === "Escape") openCapture(false); });
document.addEventListener("click", (e) => {
  if (!capPop.hidden && !(e.target as HTMLElement).closest(".capture-wrap")) openCapture(false);
});

async function renderCapture() {
  const st = await captureStatus();
  const [cls, title, detail] = st.error
    ? ["off", "Captura desligada", st.error]
    : st.locked
      ? ["on", "Lendo o jogo", st.last_event_ms ? `Último dado do jogo: ${new Date(st.last_event_ms).toLocaleTimeString()}` : "Conectado ao jogo."]
      : st.running
        ? ["wait", "Procurando o jogo…", "Entre no jogo (ou troque de mapa) para o Kiskwatch achar a conexão."]
        : ["wait", "Captura iniciando…", ""];
  capDot.className = `capture-dot ${cls}`;
  capDot.ariaLabel = `Estado da captura: ${title}`;
  capDot.title = title;
  const kids: (Node | string)[] = [el("strong", {}, title), el("p", {}, detail)];
  if (st.error) kids.push(el("p", { className: "hint" }, "Confira se o ", el("a", { href: "https://npcap.com/#download" }, "Npcap"),
    " está instalado (com \"WinPcap API-compatible Mode\") e abra o Kiskwatch como administrador."));
  // The last souls read, to check a kill against.
  const last = souls.slice(-5).reverse();
  if (last.length) {
    kids.push(el("p", { className: "hint" }, "Últimas almas lidas:"), el("ul", { className: "hint soul-log" }, ...last.map((x) => {
      const p = PETS.find((y) => y.id === x.pet);
      return el("li", {}, `${new Date(x.at_ms).toLocaleTimeString()} · ${p ? name(p.name) : `pet ${x.pet}`} +${x.amount}`);
    })));
  }
  if (st.devices.length) kids.push(el("p", { className: "hint" }, `Placas de rede: ${st.devices.join(", ")}`));
  capPop.replaceChildren(...kids);
  // A new error opens the popup by itself, once.
  if (st.error && st.error !== shownError) openCapture(true);
  shownError = st.error;
}

// ---- Config ----
const check = (id: string) => $<HTMLInputElement>(id);
const clickThrough = check("#click-through");
clickThrough.addEventListener("change", () => setClickThrough(clickThrough.checked));
check("#timer-overlay").addEventListener("change", (e) => update((s) => { s.timer_overlay = (e.target as HTMLInputElement).checked; }));
check("#pet-overlay").addEventListener("change", (e) => update((s) => { s.pet_overlay = (e.target as HTMLInputElement).checked; }));
check("#dps-overlay").addEventListener("change", (e) => update((s) => { s.dps.overlay = (e.target as HTMLInputElement).checked; }));
$<HTMLSelectElement>("#dps-start").addEventListener("change", (e) => update((s) => { s.dps.start = (e.target as HTMLSelectElement).value as "hit" | "button"; }));
check("#overlays-with-game").addEventListener("change", (e) => update((s) => { s.overlays_with_game = (e.target as HTMLInputElement).checked; }));
check("#overlays-with-focus").addEventListener("change", (e) => update((s) => { s.overlays_with_focus = (e.target as HTMLInputElement).checked; }));
// A new channel looks for updates on it right away.
$<HTMLSelectElement>("#update-channel").addEventListener("change", async (e) => {
  await update((s) => { s.update_channel = (e.target as HTMLSelectElement).value as "stable" | "canary"; });
  await updateCheck();
});

const A11Y: [string, keyof Accessibility, "check" | "number"][] = [
  ["#a-font", "font_scale", "number"],
  ["#a-opacity", "overlay_opacity", "number"],
  ["#a-contrast", "high_contrast", "check"],
  ["#a-colorblind", "colorblind", "check"],
  ["#a-motion", "reduce_motion", "check"],
  ["#a-sound", "sound", "check"],
  ["#a-volume", "volume", "number"],
  ["#a-alert", "alert_seconds", "number"],
];
for (const [id, key, kind] of A11Y) {
  const input = $<HTMLInputElement>(id);
  // The text size applies on release: applied while dragging, it would move
  // the slider out from under the mouse.
  const live = kind === "number" && key !== "font_scale";
  input.addEventListener(live ? "input" : "change", () =>
    update((s) => { (s.a11y as unknown as Record<string, unknown>)[key] = kind === "check" ? input.checked : Number(input.value); }));
}
$("#a-font").addEventListener("input", (e) => { $("output[for='a-font']").textContent = `${(e.target as HTMLInputElement).value}%`; });
$("#a-test").addEventListener("click", () => saved && chime(saved.settings.a11y));

// ---- Shortcuts ----
const hotkeyButtons = [...document.querySelectorAll<HTMLButtonElement>(".hotkey")];
const hotkeyError = $("#hk-error");
let listening: HTMLButtonElement | null = null;

/** A key press as a shortcut ("Ctrl+Alt+D"), or null for a modifier alone. */
function comboOf(e: KeyboardEvent): string | null {
  const code = e.code;
  let key: string | null = null;
  if (/^Key[A-Z]$/.test(code)) key = code.slice(3);
  else if (/^Digit\d$/.test(code)) key = code.slice(5);
  else if (/^(F\d{1,2}|Numpad\d)$/.test(code)) key = code;
  else if (["Insert", "Home", "End", "PageUp", "PageDown", "Pause", "ScrollLock"].includes(code)) key = code;
  if (!key) return null;
  const mods = [e.ctrlKey && "Ctrl", e.altKey && "Alt", e.shiftKey && "Shift"].filter(Boolean);
  return [...mods, key].join("+");
}

function hotkeyText(combo: string) {
  return combo ? combo.split("+").join(" + ") : "desligado";
}

function renderHotkeys(keys: Hotkeys) {
  for (const b of hotkeyButtons) {
    if (b === listening) continue;
    const combo = keys[b.dataset.hotkey as keyof Hotkeys];
    b.textContent = hotkeyText(combo);
    b.classList.toggle("off", !combo);
  }
}

function showHotkeyError(text: string | null) {
  hotkeyError.hidden = !text;
  hotkeyError.textContent = text ?? "";
}

function stopListening() {
  if (!listening) return;
  listening.classList.remove("listening");
  listening = null;
  pauseHotkeys(false).catch(() => {});
  if (saved) renderHotkeys(saved.settings.hotkeys);
}

async function pickHotkey(b: HTMLButtonElement, combo: string) {
  if (!saved) return;
  const keys = { ...saved.settings.hotkeys, [b.dataset.hotkey as keyof Hotkeys]: combo };
  listening = null;
  b.classList.remove("listening");
  try {
    await setHotkeys(keys);
    saved.settings.hotkeys = keys;
    showHotkeyError(null);
  } catch (e) {
    showHotkeyError(String(e));
  }
  renderHotkeys(saved.settings.hotkeys);
}

for (const b of hotkeyButtons) {
  b.addEventListener("click", () => {
    if (listening === b) return;
    stopListening();
    listening = b;
    b.classList.add("listening");
    b.textContent = "aperte o atalho…";
    // So pressing the current shortcut here records it instead of running it.
    pauseHotkeys(true).catch(() => {});
  });
  b.addEventListener("keydown", (e) => {
    if (listening !== b) return;
    e.preventDefault();
    if (e.key === "Escape") return stopListening();
    if (e.key === "Backspace" || e.key === "Delete") return void pickHotkey(b, "");
    const combo = comboOf(e);
    if (combo) pickHotkey(b, combo);
  });
  b.addEventListener("blur", () => { if (listening === b) stopListening(); });
}

function renderConfig(s: Settings) {
  clickThrough.checked = s.click_through;
  check("#timer-overlay").checked = s.timer_overlay;
  check("#pet-overlay").checked = s.pet_overlay;
  check("#overlays-with-game").checked = s.overlays_with_game;
  check("#overlays-with-focus").checked = s.overlays_with_focus;
  check("#dps-overlay").checked = s.dps.overlay;
  $<HTMLSelectElement>("#dps-start").value = s.dps.start;
  renderHotkeys(s.hotkeys);
  for (const [id, key, kind] of A11Y) {
    const input = $<HTMLInputElement>(id);
    const v = s.a11y[key];
    if (kind === "check") input.checked = Boolean(v);
    else input.value = String(v);
  }
  $("output[for='a-font']").textContent = `${s.a11y.font_scale}%`;
  $("output[for='a-opacity']").textContent = `${s.a11y.overlay_opacity}%`;
  $("output[for='a-volume']").textContent = `${s.a11y.volume}%`;
  applyLook(s.a11y);
}

// ---- Refresh ----
async function refresh() {
  [saved, timers, souls, paces] = await Promise.all([getSaved(), getTimers(), getSouls(), getPaces()]);
  const server = SERVERS.find((s) => s.id === saved!.settings.server_id);
  regionSel.value = String(server?.region ?? 4);
  fillServers(Number(regionSel.value), saved.settings.server_id);
  renderConfig(saved.settings);
  if (!listening) showHotkeyError(await hotkeysStatus());
  renderTimers();
  renderPets();
  renderBuild(saved);
  renderDps(saved);
  renderGroup(saved);
  renderChecklist();
  renderCapture();
}

onStateChanged(refresh);
refresh();
setInterval(tickCountdowns, 1000);
setInterval(renderCapture, 5000);
// Scheduled events roll over to their next showing.
setInterval(async () => { timers = await getTimers(); renderTimers(); }, 30_000);
