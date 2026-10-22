// The Build tab: the character's skills, stigmas and Daevanion boards, from
// its public profile on the official site.
import { Profile, ProfileSkill, Saved, clearProfile, forgetPreset, loadProfile, movePreset, searchCharacters } from "./api";
import { Cell, GameData, boardCost, boardLevels, cells, findBoard, iconUrl, levelPoints, loadGameData, sources } from "./buildData";

const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T;
function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, unknown> = {}, ...kids: (Node | string)[]): HTMLElementTagNameMap[K] {
  const e = Object.assign(document.createElement(tag), props);
  e.append(...kids);
  return e;
}

/** The profile is read again after this long, while the panel is open. */
const REFRESH_MS = 20 * 60_000;

const CATEGORY: Record<string, string> = { Active: "Ativas", Passive: "Passivas", Dp: "Stigmas", Stigma: "Stigmas" };
const CATEGORY_ORDER = ["Active", "Passive", "Dp", "Stigma"];
const isStigma = (s: ProfileSkill) => s.category === "Dp" || s.category === "Stigma";
/** The game's skill presets. */
const PRESETS = [1, 2, 3];

let profile: Profile | null = null;
/** The skill preset on screen; null is the one the site shows now. */
let viewPreset: number | null = null;
let openBoard: number | null = null;
/** The node picked on the open board, by "row,col". */
let openNode: string | null = null;
let busy = false;
let rendered = false;
/** The source lists the user opened, kept open across redraws. */
const openSources = new Set<string>();
let game: GameData | null = null;
let gameError = "";

/** Stigma slots open at these character levels. */
const STIGMA_SLOTS = [22, 27, 32, 37];

const status = (text: string) => { $("#char-status").textContent = text; };

$("#char-search").addEventListener("submit", async (e) => {
  e.preventDefault();
  const name = $<HTMLInputElement>("#char-name").value.trim();
  if (!name) return;
  status("Buscando…");
  $("#char-hits").replaceChildren();
  try {
    const hits = await searchCharacters(name);
    status(hits.length ? "" : "Nenhum personagem com esse nome neste servidor.");
    $("#char-hits").replaceChildren(...hits.map((h) => {
      const b = el("button", {}, el("strong", {}, h.name), ` · nível ${h.level} · ${h.server_name}`);
      b.addEventListener("click", () => load(h.server_id, h.character_id));
      return el("li", {}, b);
    }));
  } catch (err) {
    status(`Não deu para buscar: ${err}`);
  }
});

async function load(serverId?: number, characterId?: string) {
  if (busy) return;
  busy = true;
  status("Lendo o perfil…");
  try {
    await loadProfile(serverId, characterId);
    status("");
    $("#char-hits").replaceChildren();
  } catch (err) {
    status(`Não deu para ler o perfil: ${err}`);
  } finally {
    busy = false;
  }
}

function ago(ms: number) {
  const min = Math.floor(ms / 60_000);
  return min < 1 ? "agora" : min < 60 ? `há ${min} min` : `há ${Math.floor(min / 60)} h`;
}

function bar(have: number, total: number) {
  const track = el("span", { className: "meter" });
  const fill = el("span", { className: "meter-fill" });
  fill.style.width = `${total ? (100 * have) / total : 0}%`;
  track.append(fill);
  return track;
}

function header(p: Profile) {
  const info = p.info.profile;
  const refresh = el("button", { textContent: "Atualizar", disabled: busy });
  refresh.addEventListener("click", () => load());
  const change = el("button", { textContent: "Trocar de personagem" });
  change.addEventListener("click", () => clearProfile());
  const img = info?.profileImage ? [el("img", { src: info.profileImage, alt: "", className: "portrait" })] : [];
  return el("div", { className: "char-card" }, ...img,
    el("div", { className: "char-main" },
      el("h2", {}, info?.characterName ?? p.name),
      el("div", { className: "hint" }, [info?.className, info && `nível ${info.characterLevel}`, info?.raceName, info?.serverName].filter(Boolean).join(" · ")),
      info?.titleName ? el("div", { className: "hint" }, info.titleName) : "",
    ),
    el("div", { className: "char-cp" }, el("small", {}, "Poder de combate"), el("strong", {}, (info?.combatPower ?? 0).toLocaleString("pt-BR"))),
    el("div", { className: "char-actions" }, el("small", { className: "hint" }, `Atualizado ${ago(Date.now() - p.fetched_ms)}`), refresh, change),
  );
}

/** A stigma with the equipped mark but no level sits on another preset. */
const elsewhere = (s: ProfileSkill) => isStigma(s) && !!s.equip && !!s.acquired && !s.skillLevel;

function skillTile(s: ProfileSkill) {
  const away = elsewhere(s);
  const tile = el("button", { className: `skill${s.acquired ? "" : " missing"}${s.equip && !away ? " equipped" : ""}${away ? " elsewhere" : ""}`, title: `${s.name}${s.acquired ? ` · nível ${s.skillLevel}` : ` · aprende no nível ${s.needLevel}`}${away ? " · equipada em outra preset" : s.equip ? " · equipada" : ""}` },
    s.icon ? el("img", { src: s.icon, alt: "", loading: "lazy" }) : el("span", { className: "noicon" }),
    el("span", { className: "skill-name" }, s.name),
    el("span", { className: "skill-level" }, away ? "outra preset" : s.acquired ? `Nv. ${s.skillLevel}` : `nv. ${s.needLevel}`));
  tile.addEventListener("click", () => showSkill(s.id));
  return el("li", {}, tile);
}

/** The presets read so far, by number; old saves have only the read itself. */
function presetsOf(p: Profile) {
  const kept = p.presets?.kept ?? {};
  const current = p.presets?.current || 1;
  return { current, kept: Object.keys(kept).length ? kept : { [current]: { skill: p.equipment.skill ?? null, fetched_ms: p.fetched_ms } } };
}

/** The skills of the preset on screen. */
function viewedSkills(p: Profile): ProfileSkill[] | null {
  const { current, kept } = presetsOf(p);
  const shown = kept[viewPreset ?? current];
  return shown ? shown.skill?.skillList ?? [] : null;
}

function presetBar(p: Profile) {
  const { current, kept } = presetsOf(p);
  const shown = viewPreset ?? current;
  const tabs = el("div", { className: "chip-group preset-tabs", role: "group", ariaLabel: "Preset de skills" }, ...PRESETS.map((n) => {
    const b = el("button", { ariaPressed: String(n === shown) },
      `Preset ${n}`,
      el("small", {}, n === current ? "em uso no site" : kept[n] ? `lida ${ago(Date.now() - kept[n].fetched_ms)}` : "não lida"));
    b.addEventListener("click", () => { viewPreset = n === current ? null : n; render(); });
    return b;
  }));
  const note = el("p", { className: "hint" });
  if (shown === current) {
    note.append("O site oficial mostra só a preset em uso. Para ler outra, troque de preset no jogo e clique em Atualizar depois que o site mudar. ",
      "Esta leitura não é a preset ", el("strong", {}, String(current)), "? Marque qual é: ",
      ...PRESETS.filter((n) => n !== current).flatMap((n) => {
        const b = el("button", { className: "link", textContent: `Preset ${n}` });
        b.addEventListener("click", () => { viewPreset = null; movePreset(n); });
        return [b, " "];
      }));
  } else if (kept[shown]) {
    const forget = el("button", { className: "link", textContent: "Esquecer esta preset" });
    forget.addEventListener("click", () => { viewPreset = null; forgetPreset(shown); });
    note.append(`Guardada da leitura de ${new Date(kept[shown].fetched_ms).toLocaleString("pt-BR")}. Para atualizar, troque para ela no jogo e clique em Atualizar. `, forget);
  } else {
    note.append("Ainda não lida. Troque para esta preset no jogo e clique em Atualizar depois que o site mudar: o Kiskwatch guarda cada preset que o site mostrar.");
  }
  return el("div", { className: "presets" }, tabs, note);
}

function skills(list: ProfileSkill[] | null) {
  if (!list) return "";
  if (!list.length) return el("p", { className: "hint" }, "O perfil não trouxe skills.");
  const groups = new Map<string, ProfileSkill[]>();
  for (const s of list) groups.set(s.category, [...(groups.get(s.category) ?? []), s]);
  const order = [...groups.keys()].sort((a, b) => (CATEGORY_ORDER.indexOf(a) + 1 || 99) - (CATEGORY_ORDER.indexOf(b) + 1 || 99));
  return el("div", {}, el("p", { className: "hint" }, "Clique numa skill para ver o que ela faz."), ...order.map((cat) => {
    const all = groups.get(cat)!.sort((a, b) => b.acquired - a.acquired || b.skillLevel - a.skillLevel || a.needLevel - b.needLevel);
    const have = all.filter((s) => s.acquired).length;
    const levels = all.reduce((n, s) => n + (s.acquired ? s.skillLevel : 0), 0);
    return el("section", { className: "build-group" },
      el("h3", {}, `${CATEGORY[cat] ?? cat} `, el("span", { className: "hint" }, `${have} de ${all.length} obtidas · ${levels} níveis no total · ${all.filter((s) => s.equip && !elsewhere(s)).length} equipadas${all.some(elsewhere) ? ` · ${all.filter(elsewhere).length} em outra preset` : ""}`)),
      el("ul", { className: "skills" }, ...all.map(skillTile)));
  }));
}

/** Text with dbaion2's **bold** numbers. */
function rich(text: string) {
  return text.split(/\*\*(.+?)\*\*/).map((part, i) => (i % 2 ? el("strong", {}, part) : part));
}

const seconds = (n: number) => (n ? `${n.toLocaleString("pt-BR")} s` : "instantânea");

/** The skill's card: the profile's level and name, the game data's text. */
function showSkill(id: number) {
  const mine = (profile ? viewedSkills(profile) : null)?.find((s) => s.id === id);
  const known = game?.skills.get(id);
  const level = mine?.acquired ? mine.skillLevel : 0;
  const fromBoards = profile && game ? boardLevels(allCells(profile)).get(id) ?? 0 : 0;
  const rows = known?.levels ?? [];
  const now = rows.find((r) => r.level === level);
  const next = rows.find((r) => r.level === level + 1);
  const kind = mine ? CATEGORY[mine.category] ?? mine.category : known?.isStigma ? "Stigmas" : known?.type === "passive" ? "Passivas" : "Ativas";
  const icon = mine?.icon || (known ? iconUrl(known.icon) : "");
  const close = el("button", { className: "close", ariaLabel: "Fechar", textContent: "×" });
  const parts = [...new Set((known?.parts ?? []).map((x) => x.level))].sort((a, b) => a - b);
  const box = el("dialog", { className: "skill-card" },
    el("header", {},
      icon ? el("img", { src: icon, alt: "" }) : el("span", { className: "noicon" }),
      el("div", {}, el("h3", {}, mine?.name ?? known?.name ?? `Skill ${id}`),
        el("div", { className: "hint" }, [kind, known && known.name !== mine?.name ? known.name : ""].filter(Boolean).join(" · "))),
      close),
    el("div", { className: "stat-row" },
      stat("Nível", level ? `${level}${known ? `/${known.maxLevel}` : ""}` : "não aprendida", mine && !mine.acquired ? `aprende no nível ${mine.needLevel}` : mine && elsewhere(mine) ? "equipada em outra preset" : mine?.equip ? "equipada" : ""),
      ...(known && known.type !== "passive" ? [stat("Recarga", seconds(now?.cooldownSec ?? known.cooldownSec)), stat("Conjuração", seconds(now?.castTimeSec ?? known.castTimeSec))] : []),
      ...(fromBoards ? [stat("Nós Daevanion abertos", `+${fromBoards}`, "níveis extras desta skill")] : [])),
    known ? el("div", {},
      el("h4", {}, level ? `No nível ${level}` : "No nível 1"),
      el("p", {}, ...rich(now?.description ?? rows[0]?.description ?? known.description)),
      next && level ? el("h4", {}, `No nível ${level + 1}`) : "",
      next && level ? el("p", { className: "hint" }, ...rich(next.description)) : "",
      parts.length ? el("h4", {}, "Especializações") : "",
      ...parts.map((lv) => el("section", { className: `spec${level >= lv ? " open" : ""}` },
        el("small", {}, level >= lv ? `Nível ${lv} · liberada` : `Nível ${lv} · falta ${lv - level}`),
        el("ul", {}, ...known.parts!.filter((x) => x.level === lv).map((x) => el("li", {}, x.icon ? el("img", { src: iconUrl(x.icon), alt: "", loading: "lazy" }) : "", ...rich(x.desc)))))),
      el("p", { className: "hint" }, "Texto da dbaion2.ru, em inglês."),
    ) : el("p", { className: "hint" }, game ? "A dbaion2 não tem esta skill." : "Sem os dados do jogo, só o que o perfil diz."));
  close.addEventListener("click", () => box.close());
  box.addEventListener("click", (e) => { if (e.target === box) box.close(); });
  box.addEventListener("close", () => box.remove());
  document.body.append(box);
  box.showModal();
}

/** The class's boards: every one the game has, with the profile's view of each. */
function classBoards(p: Profile) {
  const listed = p.info.daevanion?.boardList ?? [];
  const known = game && listed.length ? findBoard(game, listed[0].id) : null;
  const ids = known ? known.boards.map((b) => b.id) : listed.map((b) => b.id);
  return ids.map((id) => ({ id, listed: listed.find((b) => b.id === id), board: known?.boards.find((b) => b.id === id) ?? null, detail: p.boards[String(id)] ?? null }));
}

function boardCells(p: Profile, b: ReturnType<typeof classBoards>[number]) {
  return cells(b.board, b.detail, p.equipment.skill?.skillList ?? [], game?.skills ?? new Map());
}

const allCells = (p: Profile) => classBoards(p).map((b) => boardCells(p, b));

function boardGrid(list: Cell[]) {
  if (!list.length) return el("p", { className: "hint" }, "Sem os nós deste tabuleiro.");
  // Boards don't start at row and column 1: trim the empty edge.
  const r0 = Math.min(...list.map((n) => n.row)) - 1, c0 = Math.min(...list.map((n) => n.col)) - 1;
  const rows = Math.max(...list.map((n) => n.row)) - r0, cols = Math.max(...list.map((n) => n.col)) - c0;
  const grid = el("div", { className: "board-grid", role: "group", ariaLabel: "Nós do tabuleiro: abertos em destaque" });
  grid.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
  grid.style.gridTemplateRows = `repeat(${rows}, 1fr)`;
  for (const n of list) {
    const picked = openNode === `${n.row},${n.col}`;
    const cell = el("button", { className: `node g-${n.grade.toLowerCase()} t-${n.kind}${n.open ? " open" : ""}${picked ? " picked" : ""}`, title: nodeTitle(n), ariaLabel: nodeTitle(n) },
      n.kind === "skill" && n.icon ? el("img", { src: n.icon, alt: "", loading: "lazy" }) : "");
    cell.style.gridRow = String(n.row - r0);
    cell.style.gridColumn = String(n.col - c0);
    cell.addEventListener("click", () => { openNode = picked ? null : `${n.row},${n.col}`; render(); });
    grid.append(cell);
  }
  return grid;
}

function nodeTitle(n: Cell) {
  return `${n.name}${n.effect && !n.effect.startsWith(n.name) ? `: ${n.effect}` : ""}${n.open ? " (aberto)" : " (fechado)"}`;
}

function nodeCard(n: Cell) {
  const more = n.skillId != null ? el("button", { textContent: "Ver a skill" }) : null;
  more?.addEventListener("click", () => showSkill(n.skillId!));
  return el("div", { className: "node-card" },
    n.icon ? el("img", { src: n.icon, alt: "" }) : "",
    el("div", {}, el("strong", {}, n.name), el("div", { className: "hint" }, [n.effect.startsWith(n.name) ? "" : n.effect, GRADE[n.grade] ?? n.grade, n.cost ? `${n.cost} cristal(is)` : "", n.open ? "aberto" : "fechado"].filter(Boolean).join(" · "))),
    more ?? "");
}

const GRADE: Record<string, string> = { Common: "comum", Rare: "raro", Legend: "lendário", Unique: "único", Epic: "épico", None: "" };

function daevanion(p: Profile) {
  const boards = classBoards(p);
  if (!boards.length) return el("p", { className: "hint" }, "O perfil não trouxe tabuleiros Daevanion.");
  const level = p.info.profile?.characterLevel ?? 1;
  // Crystals by type: spent on open nodes, against what the game gives at most.
  const byType = new Map<string, number>();
  const rows = boards.map((b) => {
    const list = boardCells(p, b);
    const open = list.filter((c) => c.open && c.kind !== "start").length;
    const total = b.listed?.totalNodeCount ?? list.filter((c) => c.kind !== "start").length;
    let crystals = "";
    if (b.board) {
      const n = list.reduce((sum, c) => sum + (c.open ? c.cost : 0), 0);
      byType.set(b.board.pointType, (byType.get(b.board.pointType) ?? 0) + n);
      crystals = ` · ${n}/${boardCost(b.board)} cristais`;
    }
    const locked = b.board && b.board.needLevel > level ? ` · abre no nível ${b.board.needLevel}` : "";
    const name = b.listed?.name ?? b.board?.name ?? `Tabuleiro ${b.id}`;
    const row = el("button", { className: `board-row${openBoard === b.id ? " active" : ""}${locked ? " locked" : ""}`, ariaExpanded: String(openBoard === b.id) },
      b.listed?.icon ? el("img", { src: b.listed.icon, alt: "" }) : el("span"),
      el("strong", {}, name),
      bar(b.listed?.openNodeCount ?? open, total),
      el("span", { className: "count" }, `${b.listed?.openNodeCount ?? open}/${total} nós${crystals}${locked}`));
    row.addEventListener("click", () => { openBoard = openBoard === b.id ? null : b.id; openNode = null; render(); });
    return row;
  });
  const shown = boards.find((b) => b.id === openBoard);
  const list = shown ? boardCells(p, shown) : [];
  const picked = list.find((c) => `${c.row},${c.col}` === openNode);
  const effects = shown?.detail ? [...(shown.detail.openStatEffectList ?? []), ...(shown.detail.openSkillEffectList ?? [])] : [];
  const detail = shown ? el("div", { className: "board-detail" },
    el("div", {},
      boardGrid(list),
      el("div", { className: "legend hint" }, el("span", { className: "node open g-common" }), " aberto ", el("span", { className: "node" }), " fechado · clique num nó para ver o que ele dá")),
    el("div", {},
      picked ? nodeCard(picked) : "",
      el("h4", {}, "Efeitos abertos"),
      effects.length ? el("ul", { className: "effects" }, ...effects.map((e) => el("li", {}, e.desc))) : el("p", { className: "hint" }, "Nenhum nó aberto neste tabuleiro."))) : "";
  const totals = game ? [...byType].map(([type, n]) => stat(game!.daevanion.points[type]?.name ?? type, `${n}/${game!.daevanion.points[type]?.max ?? "?"}`, "gastos / máximo do jogo")) : [];
  return el("div", {},
    totals.length ? el("div", { className: "stat-row" }, ...totals) : "",
    el("div", { className: "boards" }, ...rows),
    el("p", { className: "hint" }, "Cristais Daevanion vêm das dungeons seladas e dos Kibelisks; os Cristais de Batalha (tabuleiro Azphel), do PvP."),
    detail);
}

// What the level gives and where the rest of the skill points come from.
function points(p: Profile) {
  if (!game) return el("p", { className: "hint" }, gameError ? `Sem os dados do jogo: ${gameError}` : "Carregando os dados do jogo…");
  const level = p.info.profile?.characterLevel ?? 1;
  const lp = levelPoints(game, level);
  const slots = STIGMA_SLOTS.filter((l) => level >= l).length;
  const nextSlot = STIGMA_SLOTS.find((l) => level < l);
  const groups = sources(game, p);
  const extra = groups.reduce((n, g) => n + g.points, 0);
  return el("div", { className: "point-box" },
    el("div", { className: "stat-row" },
      stat("Pontos de skill do nível", String(lp.skill), `nível ${level}`),
      stat("Pontos de skill de outras fontes", `até ${extra}`, "missões, dungeons, lojas"),
      stat("Pontos de stigma do nível", String(lp.stigma)),
      stat("Slots de stigma", `${slots}/${STIGMA_SLOTS.length}`, nextSlot ? `próximo no nível ${nextSlot}` : "todos abertos"),
    ),
    el("h3", {}, "Onde conseguir pontos de skill"),
    el("p", { className: "hint" }, "O perfil oficial não diz quais fontes você já fez: esta é a lista do que existe para o seu lado."),
    ...groups.map((g) => withToggle(g.name, el("details", { className: "source", open: openSources.has(g.name) },
      el("summary", {}, el("strong", {}, g.name), ` · ${g.points} pontos em ${g.list.length}`),
      el("ul", {}, ...g.list.map((x) => el("li", {}, `${x.name} · ${x.points} ponto(s)${x.limit ? ` · até ${x.limit}x` : ""}${x.price ? ` · ${x.price} cada` : ""}`)))))),
  );
}

function withToggle(key: string, d: HTMLDetailsElement) {
  d.addEventListener("toggle", () => { if (d.open) openSources.add(key); else openSources.delete(key); });
  return d;
}

function stat(label: string, value: string, note = "") {
  return el("div", { className: "stat" }, el("small", {}, label), el("strong", {}, value), note ? el("span", { className: "hint" }, note) : "");
}

function render() {
  $("#char-pick").hidden = !!profile;
  const box = $("#build");
  if (!profile) {
    box.replaceChildren(el("p", { className: "hint" }, "Busque seu personagem pelo nome. O Kiskwatch lê o perfil público no site oficial (sem login) e mostra suas skills, stigmas e tabuleiros Daevanion."));
    return;
  }
  box.replaceChildren(
    header(profile),
    el("h2", {}, "Skills e Stigmas"), presetBar(profile), skills(viewedSkills(profile)),
    el("h2", {}, "Pontos e onde conseguir"), points(profile),
    el("h2", {}, "Daevanion"), daevanion(profile),
    el("p", { className: "hint" }, "Dados do perfil público no site oficial do AION 2. Pontos, tabuleiros e custos da ", el("a", { href: "https://dbaion2.ru" }, "dbaion2.ru"), " (cliente Global, em inglês)."),
  );
}

export function renderBuild(saved: Saved) {
  // The panel refreshes on every game event: only a new profile redraws.
  const presetKey = (p: Profile | null) => `${p?.presets?.current}:${Object.keys(p?.presets?.kept ?? {})}`;
  const same = saved.profile?.character_id === profile?.character_id && saved.profile?.fetched_ms === profile?.fetched_ms && presetKey(saved.profile) === presetKey(profile);
  if (same && rendered) return;
  if (saved.profile?.character_id !== profile?.character_id) viewPreset = null;
  rendered = true;
  profile = saved.profile;
  if (profile && !game && !gameError) {
    loadGameData().then((g) => { game = g; render(); }).catch((e) => { gameError = String(e); render(); });
  }
  if (profile && Date.now() - profile.fetched_ms > REFRESH_MS) load();
  render();
}

setInterval(() => { if (profile && Date.now() - profile.fetched_ms > REFRESH_MS) load(); }, 60_000);
