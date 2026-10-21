// The panel: timers with their alarms, the pet collection and its map, settings.
import {
  ALARM_LEADS, Accessibility, Saved, Settings, SoulSeen, TimerRow, captureStatus, countdown, getSaved, getSouls, getTimers,
  onStateChanged, openUrl, setAlarm, setClickThrough, setPet, setSettings,
} from "./api";
import { Drop, GENUS, GENUS_MARK, PETS, Pet, REGIONS, SERVERS, mapLink, name, soulsToMax, t } from "./data";
import { farming } from "./farm";
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

function renderTimers() {
  const now = Date.now();
  renderResets(now);
  const rows = shownTimers();
  const total = timers.filter((r) => r.kind !== "reset").length;
  $("#timer-count").textContent = rows.length === total ? "" : `${rows.length} de ${total}`;
  $("#timers").replaceChildren(
    ...rows.map((row) => {
      const leads = el("div", { className: "leads" });
      for (const lead of ALARM_LEADS) {
        const on = row.leads.includes(lead);
        const label = lead === 60 ? "1h" : `${lead}m`;
        const chip = el("button", { className: on ? "chip on" : "chip", textContent: label, ariaPressed: String(on), ariaLabel: `Aviso ${label} antes` });
        chip.addEventListener("click", () => {
          const next = on ? row.leads.filter((l) => l !== lead) : [...row.leads, lead];
          setAlarm(row.id, next);
        });
        leads.append(chip);
      }
      return el("tr", { className: row.kind },
        el("td", {}, timerName(row)),
        el("td", {}, whereText(row)),
        el("td", { className: "countdown", dataset: { id: row.id } }, startText(row, now)),
        el("td", {}, leads),
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
        el("td", { className: "where" }, where),
      );
    }),
  );
  renderMap(rows);
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
  const most = Math.max(...spots.map(({ r }) => r.missing));
  const links = add(svg, "g", { class: "links" });
  const kibs = add(svg, "g", {});
  const dots = add(svg, "g", {});
  const labels = add(svg, "g", { class: "labels", "font-size": 12 * k });
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
      add(links, "line", { x1: kx, y1: ky, x2: x, y2: y, class: chosen ? "chosen" : "", "stroke-width": 1.5 * k });
    }
    const g = add(dots, "g", { class: `spot ${r.pet.genus ?? ""}${chosen ? " chosen" : ""}`, tabindex: 0, role: "button", "aria-label": `${name(r.pet.name)}: faltam ${r.missing}` });
    const rad = (6 + 5 * (r.missing / most)) * k;
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
  input.addEventListener(kind === "check" ? "change" : "input", () =>
    update((s) => { (s.a11y as unknown as Record<string, unknown>)[key] = kind === "check" ? input.checked : Number(input.value); }));
}
$("#a-test").addEventListener("click", () => saved && chime(saved.settings.a11y));

function renderConfig(s: Settings) {
  clickThrough.checked = s.click_through;
  check("#timer-overlay").checked = s.timer_overlay;
  check("#pet-overlay").checked = s.pet_overlay;
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
  [saved, timers, souls] = await Promise.all([getSaved(), getTimers(), getSouls()]);
  const server = SERVERS.find((s) => s.id === saved!.settings.server_id);
  regionSel.value = String(server?.region ?? 4);
  fillServers(Number(regionSel.value), saved.settings.server_id);
  renderConfig(saved.settings);
  renderTimers();
  renderPets();
  renderCapture();
}

onStateChanged(refresh);
refresh();
setInterval(tickCountdowns, 1000);
setInterval(renderCapture, 5000);
// Scheduled events roll over to their next showing.
setInterval(async () => { timers = await getTimers(); renderTimers(); }, 30_000);
