// The panel's Titles tab: every title of the player's side, with how to get
// it and what it gives, the ones the player marked as had, and a search by
// name and by up to three stats at once.
import { Profile, Saved, setTitles } from "./api";
import {
  CATEGORY, CATEGORY_ORDER, GRADE, GRADE_ORDER, SLOT, SLOT_ORDER, STATS, Slot, Title, TitleData, loadTitles, statName, statText, sumStats, valueIn,
} from "./titlesData";

const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T;
function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, unknown> = {}, ...kids: (Node | string)[]): HTMLElementTagNameMap[K] {
  const e = Object.assign(document.createElement(tag), props);
  e.append(...kids);
  return e;
}

/** How many stats the search combines. */
const MAX_STATS = 3;
/** Rows drawn at first; the rest on "Mostrar mais". */
const PAGE = 100;

interface Filters {
  q: string; cat: string; slot: string; grade: string;
  /** "" all, "yes" the ones had, "no" the missing. */
  have: "" | "yes" | "no";
  stats: string[];
  /** Where the stats count: worn, owned, or either. */
  scope: "any" | "equip" | "own";
}

const KEY = "kiskwatch.titles";
let filters: Filters = { q: "", cat: "", slot: "", grade: "", have: "", stats: [], scope: "any" };
try {
  filters = { ...filters, ...JSON.parse(localStorage.getItem(KEY) ?? "{}") };
  filters.stats = filters.stats.filter((s) => s in STATS).slice(0, MAX_STATS);
} catch { /* first time, or storage off */ }
const keep = () => { try { localStorage.setItem(KEY, JSON.stringify(filters)); } catch { /* storage off */ } };

let data: TitleData | null = null;
let error = "";
let profile: Profile | null = null;
let serverId = 0;
/** Marked by the player, for the character followed. */
let marked = new Set<number>();
let shown = PAGE;
let drawnKey = "";

/** The followed character's side, else the server's. */
const race = () => (profile ? (profile.info.profile?.raceId === 2 ? "Dark" : "Light") : Math.floor(serverId / 1000) === 2 ? "Dark" : "Light");
const ofSide = () => (data?.list ?? []).filter((t) => t.race === "All" || t.race === race());
/** The titles worn now: the official profile names one per slot. */
const worn = () => new Set((profile?.info.title?.titleList ?? []).map((t) => t.id));
const had = (t: Title) => marked.has(t.id) || worn().has(t.id);

/** Where a stat counts, by the scope picked. */
function lists(t: Title) {
  return filters.scope === "equip" ? [t.equip] : filters.scope === "own" ? [t.own] : [t.equip, t.own];
}

function matches(t: Title, q: string): boolean {
  if (filters.cat && t.cat !== filters.cat) return false;
  if (filters.slot && t.slot !== filters.slot) return false;
  if (filters.grade && t.grade !== filters.grade) return false;
  if (filters.have === "yes" && !had(t)) return false;
  if (filters.have === "no" && had(t)) return false;
  if (q && !t.name.toLowerCase().includes(q) && !t.desc.toLowerCase().includes(q)) return false;
  return filters.stats.every((s) => lists(t).some((l) => l.some(([id]) => id === s)));
}

/** With stats picked, the most of the first one first; else by category, slot and grade. */
function order(a: Title, b: Title): number {
  for (const s of filters.stats) {
    const d = lists(b).reduce((n, l) => n + valueIn(l, s), 0) - lists(a).reduce((n, l) => n + valueIn(l, s), 0);
    if (d) return d;
  }
  return CATEGORY_ORDER.indexOf(a.cat) - CATEGORY_ORDER.indexOf(b.cat)
    || SLOT_ORDER.indexOf(a.slot) - SLOT_ORDER.indexOf(b.slot)
    || GRADE_ORDER.indexOf(a.grade) - GRADE_ORDER.indexOf(b.grade)
    || a.name.localeCompare(b.name);
}

function select(options: [string, string][], value: string, pick: (v: string) => void, label: string) {
  const s = el("select", { ariaLabel: label }, ...options.map(([v, text]) => el("option", { value: v, textContent: text, selected: v === value })));
  s.addEventListener("change", () => pick(s.value));
  return s;
}

/** The search bar: built once, so typing keeps the focus. */
function filterBar() {
  const search = el("input", { type: "search", className: "title-search", placeholder: "Buscar título pelo nome ou pelo jeito de obter", value: filters.q, ariaLabel: "Buscar título" });
  search.addEventListener("input", () => { filters.q = search.value; changed(); });
  const set = (k: "cat" | "slot" | "grade" | "have" | "scope") => (v: string) => { (filters as unknown as Record<string, string>)[k] = v; changed(); };
  return el("div", { className: "filters" },
    search,
    select([["", "Todas as categorias"], ...CATEGORY_ORDER.map((c): [string, string] => [c, CATEGORY[c]])], filters.cat, set("cat"), "Categoria"),
    select([["", "Todos os tipos"], ...SLOT_ORDER.map((s): [string, string] => [s, SLOT[s]])], filters.slot, set("slot"), "Tipo"),
    select([["", "Qualquer raridade"], ...GRADE_ORDER.map((g): [string, string] => [g, GRADE[g]])], filters.grade, set("grade"), "Raridade"),
    select([["", "Adquiridos e não adquiridos"], ["yes", "Só os adquiridos"], ["no", "Só os não adquiridos"]], filters.have, set("have"), "Adquiridos"));
}

/** Up to three stats, all of them on the title. */
function statBar() {
  const options = (): [string, string][] => Object.keys(STATS).map((id): [string, string] => [id, statName(id)]).sort((a, b) => a[1].localeCompare(b[1], "pt-BR"));
  const box = el("div", { className: "filters title-stats" });
  const draw = () => {
    const picks = filters.stats.map((s, i) => {
      const sel = select(options(), s, (v) => { filters.stats[i] = v; changed(); draw(); }, `Atributo ${i + 1}`);
      const drop = el("button", { type: "button", className: "chip-x", textContent: "×", title: "Tirar este atributo", ariaLabel: `Tirar ${statName(s)}` });
      drop.addEventListener("click", () => { filters.stats.splice(i, 1); changed(); draw(); });
      return el("span", { className: "title-stat" }, sel, drop);
    });
    const add = select([["", filters.stats.length ? "+ outro atributo" : "Filtrar por atributo"], ...options().filter(([id]) => !filters.stats.includes(id))], "", (v) => {
      if (v) { filters.stats.push(v); changed(); draw(); }
    }, "Adicionar atributo");
    add.disabled = filters.stats.length >= MAX_STATS;
    const scope = select([["any", "ao equipar ou permanente"], ["equip", "só ao equipar"], ["own", "só permanente"]], filters.scope, (v) => { filters.scope = v as Filters["scope"]; changed(); }, "Onde conta o atributo");
    box.replaceChildren(...picks, add, filters.stats.length ? scope : "",
      el("span", { className: "hint" }, filters.stats.length >= MAX_STATS ? `Até ${MAX_STATS} atributos, todos no mesmo título.` : filters.stats.length ? "O título precisa ter todos os escolhidos." : `Combine até ${MAX_STATS} atributos.`));
  };
  draw();
  return box;
}

function changed() {
  keep();
  shown = PAGE;
  drawList();
}

function stats(list: Title["equip"]) {
  return list.length ? el("ul", { className: "title-bonus" }, ...list.map((s) => el("li", { className: filters.stats.includes(s[0]) ? "picked" : "" }, statText(s)))) : el("span", { className: "hint" }, "—");
}

function row(t: Title) {
  const isWorn = worn().has(t.id);
  const box = el("input", { type: "checkbox", checked: had(t), disabled: isWorn, ariaLabel: `Tenho ${t.name}`, title: isWorn ? "Equipado agora, pelo perfil oficial" : "Marque se já tem" });
  box.addEventListener("change", () => setTitles([t.id], box.checked));
  return el("tr", { className: had(t) ? "had" : "" },
    el("td", {}, box),
    el("td", {},
      el("strong", { className: `title-name g-${t.grade.toLowerCase()}` }, t.name),
      el("div", { className: "hint" }, [GRADE[t.grade] ?? t.grade, CATEGORY[t.cat] ?? t.cat, isWorn ? "equipado" : ""].filter(Boolean).join(" · "))),
    el("td", {}, SLOT[t.slot] ?? t.slot),
    el("td", {}, stats(t.equip)),
    el("td", {}, stats(t.own)),
    el("td", { className: "title-how" }, t.desc));
}

/** What the official profile counts against what is marked here, by slot. */
function summary(side: Title[]) {
  const have = side.filter(had);
  const official = profile?.info.title;
  const bySlot = official?.titleList ?? [];
  const lines: (Node | string)[] = [
    el("span", {}, el("strong", {}, String(have.length)), ` de ${side.length} marcados`),
  ];
  if (official?.ownedCount != null) {
    lines.push(el("span", {}, `Perfil oficial de ${profile!.name}: `, el("strong", {}, String(official.ownedCount)), ` de ${official.totalCount ?? "?"}`));
    for (const s of bySlot) {
      const slot = s.equipCategory as Slot;
      const mine = have.filter((t) => t.slot === slot).length;
      const gap = s.ownedCount - mine;
      lines.push(el("span", { className: gap > 0 ? "missing" : "", title: gap > 0 ? `O perfil oficial conta ${gap} a mais que os marcados aqui` : "" },
        `${SLOT[slot] ?? s.equipCategory}: ${s.ownedCount}/${s.totalCount}${gap > 0 ? ` (${gap === 1 ? "falta 1" : `faltam ${gap}`} para marcar)` : ""}`));
    }
  } else if (!profile) {
    lines.push(el("span", { className: "hint" }, "Siga um personagem na aba Build para conferir com a contagem do perfil oficial."));
  }
  const bonus = sumStats(have, (t) => t.own);
  return el("div", {},
    el("div", { className: "summary title-summary" }, ...lines),
    bonus.length ? el("details", { className: "title-total" },
      el("summary", {}, "Bônus permanente dos adquiridos"),
      el("ul", { className: "title-bonus" }, ...bonus.map((s) => el("li", {}, statText(s))))) : "");
}

function drawList() {
  const box = $("#titles-list");
  if (!box) return;
  if (!data) {
    box.replaceChildren(el("p", { className: "hint" }, error ? `Não deu para baixar os títulos: ${error}` : "Carregando os títulos da dbaion2…"));
    return;
  }
  const side = ofSide();
  const q = filters.q.trim().toLowerCase();
  const rows = side.filter((t) => matches(t, q)).sort(order);
  const more = el("button", { type: "button", textContent: `Mostrar mais (${rows.length - shown})` });
  more.addEventListener("click", () => { shown += PAGE * 3; drawList(); });
  const markAll = (owned: boolean) => {
    const ids = rows.filter((t) => had(t) !== owned && !worn().has(t.id)).map((t) => t.id);
    if (!ids.length) return;
    if (confirm(`${owned ? "Marcar" : "Desmarcar"} ${ids.length} título(s) da lista?`)) setTitles(ids, owned);
  };
  const all = el("button", { type: "button", textContent: "Marcar os listados" });
  all.addEventListener("click", () => markAll(true));
  const none = el("button", { type: "button", textContent: "Desmarcar os listados" });
  none.addEventListener("click", () => markAll(false));
  box.replaceChildren(
    summary(side),
    el("div", { className: "filters" }, el("span", { className: "hint" }, `${rows.length} título(s)`), all, none),
    rows.length ? el("table", { className: "list titles" },
      el("thead", {}, el("tr", {}, ...["Tenho", "Título", "Tipo", "Ao equipar", "Permanente", "Como obter"].map((h) => el("th", {}, h)))),
      el("tbody", {}, ...rows.slice(0, shown).map(row))) : el("p", { className: "hint" }, "Nenhum título com esses filtros."),
    rows.length > shown ? more : "",
    el("p", { className: "hint" }, "Lista, bônus e textos da ", el("a", { href: "https://dbaion2.ru/en/titles/" }, "dbaion2.ru"),
      " (cliente Global, em inglês). O jogo não conta ao site oficial quais títulos você tem, só quantos: marque aqui os seus. Os equipados vêm marcados pelo perfil."));
}

/** The tab's frame, once. */
function frame() {
  $("#titles").replaceChildren(filterBar(), statBar(), el("div", { id: "titles-list" }));
}

export function renderTitles(saved: Saved) {
  profile = saved.profile;
  serverId = saved.settings.server_id;
  const key = profile ? `${profile.server_id}:${profile.character_id}` : "";
  marked = new Set(saved.titles?.[key] ?? []);
  // The panel refreshes on every game event: only a change redraws.
  const now = `${key}:${profile?.fetched_ms}:${serverId}:${[...marked]}`;
  if (now === drawnKey) return;
  drawnKey = now;
  if (!$("#titles-list")) {
    frame();
    load();
  }
  drawList();
}

function load() {
  error = "";
  loadTitles().then((d) => { data = d; drawList(); }).catch((e) => { error = String(e); drawList(); });
}

// After a failed download, opening the tab tries again.
document.querySelector('.tabs button[data-tab="titles"]')?.addEventListener("click", () => { if (!data && error) { load(); drawList(); } });
