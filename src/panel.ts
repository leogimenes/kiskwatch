// The panel: timers with their alarms, the pet collection and its map, settings.
import {
  ALARM_LEADS, Saved, captureStatus, TimerRow, countdown, getSaved, getTimers, ingestHex, onStateChanged, setAlarm, setClickThrough,
  setPet, setSettings,
} from "./api";
import { Drop, GENUS, PETS, Pet, REGIONS, SERVERS, name, soulsToMax, t } from "./data";

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
serverSel.addEventListener("change", () => {
  if (!saved) return;
  setSettings({ ...saved.settings, server_id: Number(serverSel.value) });
});

// ---- Timers ----
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

function renderTimers() {
  const now = Date.now();
  $("#timers").replaceChildren(
    ...timers.map((row) => {
      const leads = el("div", { className: "leads" });
      for (const lead of ALARM_LEADS) {
        const on = row.leads.includes(lead);
        const chip = el("button", { className: on ? "chip on" : "chip", textContent: lead === 60 ? "1h" : `${lead}m` });
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

const mapSel = $<HTMLSelectElement>("#map-select");
mapSel.addEventListener("change", () => renderPets());

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
  const q = petFilters.search.value.trim().toLowerCase();
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
    .filter((r) => !q || name(r.pet.name).toLowerCase().includes(q) || (r.pet.name.en ?? "").toLowerCase().includes(q)
      || r.pet.drops.some((d) => t(d.npc).toLowerCase().includes(q)));
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
  const tp = d.kibelisk ? ` · Kibelisk #${d.kibelisk.teleport} ${t(d.kibelisk.name)}` : "";
  return `${t(d.npc)} (nv. ${d.level}, ${d.chance}) · ${t(d.map)}${zone ? ` · ${zone}` : ""} · ${d.spawns} spawns${tp}`;
}

function renderPets() {
  const rows = filteredPets();
  const all = PETS.filter((p) => p.genus !== "special" && !p.unreleased);
  const missingTotal = all.reduce((sum, p) => { const g = progress(p.id); return sum + soulsToMax(g.level, g.points); }, 0);
  // As the game counts them: every pet you have, Special ones included (they
  // come at their highest level and take no souls).
  const owned = PETS.filter((p) => !p.unreleased && progress(p.id).level >= 1);
  const maxed = owned.filter((p) => p.genus === "special" || progress(p.id).level >= 3).length;
  $("#pet-summary").textContent = `Coleção ${owned.length} · ${maxed} no nível máximo · ${missingTotal} almas faltando no total · ${rows.length} pets na lista`;

  $("#pets").replaceChildren(
    ...rows.map((r) => {
      const level = el("select");
      for (let l = 0; l <= 3; l++) level.append(el("option", { value: String(l), textContent: String(l), selected: l === r.level }));
      const points = el("input", { type: "number", min: "0", value: String(r.points), className: "points" });
      const save = () => setPet(r.pet.id, Number(level.value), Number(points.value) || 0);
      level.addEventListener("change", save);
      points.addEventListener("change", save);
      const best = [...r.drops].sort((a, b) => b.spawns - a.spawns);
      const where = best.length ? best.slice(0, 2).map(dropText).join("\n") : r.pet.chests.length ? "Só em baús de alma" : "—";
      return el("tr", {},
        el("td", {}, el("strong", {}, name(r.pet.name)), el("br"), el("small", {}, r.pet.genus ? name(GENUS[r.pet.genus] ?? {}) : "")),
        el("td", {}, level),
        el("td", {}, points),
        el("td", { className: "missing" }, String(r.missing)),
        el("td", { className: "where" }, where),
      );
    }),
  );
  renderMap(rows);
}

// A schematic map: the middle of each monster's spawns and its Kibelisk, in
// the game's map coordinates, fitted to the box. No map art yet.
function renderMap(rows: PetRow[]) {
  const drops = rows.filter((r) => r.missing > 0).flatMap((r) => r.drops.map((d) => ({ r, d })));
  const maps = [...new Map(drops.map(({ d }) => [d.mapId, d.map])).entries()];
  const keep = mapSel.value;
  mapSel.replaceChildren(...maps.map(([id, key]) => el("option", { value: String(id), textContent: `${t(key)} (${id})`, selected: String(id) === keep })));
  const mapId = Number(mapSel.value);
  const here = drops.filter(({ d }) => d.mapId === mapId && d.kibelisk);
  const svg = $("#map") as unknown as SVGSVGElement;
  svg.replaceChildren();
  if (!here.length) return;
  const pts = here.flatMap(({ d }) => [d.kibelisk!.to, d.kibelisk!.at]);
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const span = Math.max(x1 - x0, y1 - y0, 1);
  const px = (p: [number, number]) => [40 + ((p[0] - x0) / span) * 920, 960 - ((p[1] - y0) / span) * 920];
  const NS = "http://www.w3.org/2000/svg";
  const add = (tag: string, attrs: Record<string, string | number>, title?: string) => {
    const e = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
    if (title) { const tt = document.createElementNS(NS, "title"); tt.textContent = title; e.append(tt); }
    svg.append(e);
  };
  const kibs = new Map(here.map(({ d }) => [d.kibelisk!.teleport, d.kibelisk!]));
  for (const k of kibs.values()) {
    const [x, y] = px(k.at);
    add("rect", { x: x - 7, y: y - 7, width: 14, height: 14, class: "kib" }, `Kibelisk #${k.teleport} ${t(k.name)}`);
    add("text", { x: x + 10, y: y + 4, class: "kib-label" });
    (svg.lastChild as SVGTextElement).textContent = `#${k.teleport}`;
  }
  const most = Math.max(...here.map(({ r }) => r.missing));
  for (const { r, d } of here) {
    const [x, y] = px(d.kibelisk!.to);
    add("circle", { cx: x, cy: y, r: 6 + 10 * (r.missing / most), class: `spawn ${r.pet.genus ?? ""}` },
      `${name(r.pet.name)}: faltam ${r.missing}\n${dropText(d)}`);
  }
}

// ---- Config ----
const clickThrough = $<HTMLInputElement>("#click-through");
clickThrough.addEventListener("change", () => setClickThrough(clickThrough.checked));
$("#ingest-go").addEventListener("click", async () => {
  const out = $("#ingest-result");
  try {
    const n = await ingestHex($<HTMLTextAreaElement>("#ingest").value);
    out.textContent = `${n} registro(s) reconhecido(s).`;
  } catch (e) {
    out.textContent = `Erro: ${e}`;
  }
});

// ---- Capture ----
async function renderCapture() {
  const pill = $("#capture");
  const st = await captureStatus();
  const [cls, text, tip] = st.error
    ? ["off", "Captura desligada", st.error]
    : st.locked
      ? ["on", "Lendo o jogo", st.last_event_ms ? `Último dado do jogo: ${new Date(st.last_event_ms).toLocaleTimeString()}` : "Conectado ao jogo"]
      : st.running
        ? ["wait", "Procurando o jogo…", `Capturando em: ${st.devices.join(", ")}`]
        : ["off", "Captura iniciando…", ""];
  pill.className = `capture ${cls}`;
  pill.textContent = text;
  pill.title = tip;
}

// ---- Refresh ----
async function refresh() {
  [saved, timers] = await Promise.all([getSaved(), getTimers()]);
  const server = SERVERS.find((s) => s.id === saved!.settings.server_id);
  regionSel.value = String(server?.region ?? 4);
  fillServers(Number(regionSel.value), saved.settings.server_id);
  clickThrough.checked = saved.settings.click_through;
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
