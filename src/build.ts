// The Build tab: the character's skills, stigmas and Daevanion boards, from
// its public profile on the official site.
import { BoardDetail, BoardNode, Profile, ProfileSkill, Saved, clearProfile, loadProfile, searchCharacters } from "./api";
import { GameData, boardCost, findBoard, levelPoints, loadGameData, sources, spent } from "./buildData";

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

let profile: Profile | null = null;
let openBoard: number | null = null;
let busy = false;
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

function skillTile(s: ProfileSkill) {
  const tile = el("li", { className: `skill${s.acquired ? "" : " missing"}${s.equip ? " equipped" : ""}`, title: `${s.name}${s.acquired ? ` · nível ${s.skillLevel}` : ` · aprende no nível ${s.needLevel}`}${s.equip ? " · equipada" : ""}` },
    s.icon ? el("img", { src: s.icon, alt: "", loading: "lazy" }) : el("span", { className: "noicon" }),
    el("span", { className: "skill-name" }, s.name),
    el("span", { className: "skill-level" }, s.acquired ? `Nv. ${s.skillLevel}` : `nv. ${s.needLevel}`));
  return tile;
}

function skills(p: Profile) {
  const list = p.equipment.skill?.skillList ?? [];
  if (!list.length) return el("p", { className: "hint" }, "O perfil não trouxe skills.");
  const groups = new Map<string, ProfileSkill[]>();
  for (const s of list) groups.set(s.category, [...(groups.get(s.category) ?? []), s]);
  const order = [...groups.keys()].sort((a, b) => (CATEGORY_ORDER.indexOf(a) + 1 || 99) - (CATEGORY_ORDER.indexOf(b) + 1 || 99));
  return el("div", {}, ...order.map((cat) => {
    const all = groups.get(cat)!.sort((a, b) => b.acquired - a.acquired || b.skillLevel - a.skillLevel || a.needLevel - b.needLevel);
    const have = all.filter((s) => s.acquired).length;
    const levels = all.reduce((n, s) => n + (s.acquired ? s.skillLevel : 0), 0);
    return el("section", { className: "build-group" },
      el("h3", {}, `${CATEGORY[cat] ?? cat} `, el("span", { className: "hint" }, `${have} de ${all.length} obtidas · ${levels} níveis no total · ${all.filter((s) => s.equip).length} equipadas`)),
      el("ul", { className: "skills" }, ...all.map(skillTile)));
  }));
}

function boardGrid(detail: BoardDetail) {
  const nodes = detail.nodeList ?? [];
  if (!nodes.length) return el("p", { className: "hint" }, "Sem os nós deste tabuleiro.");
  // Boards don't start at row and column 1: trim the empty edge.
  const r0 = Math.min(...nodes.map((n) => n.row)) - 1, c0 = Math.min(...nodes.map((n) => n.col)) - 1;
  const rows = Math.max(...nodes.map((n) => n.row)) - r0, cols = Math.max(...nodes.map((n) => n.col)) - c0;
  const grid = el("div", { className: "board-grid", role: "img", ariaLabel: "Nós do tabuleiro: abertos em destaque" });
  grid.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
  grid.style.gridTemplateRows = `repeat(${rows}, 1fr)`;
  for (const n of nodes) {
    const cell = el("span", { className: `node g-${n.grade.toLowerCase()} t-${n.type.toLowerCase()}${n.open ? " open" : ""}`, title: nodeTitle(n) });
    cell.style.gridRow = String(n.row - r0);
    cell.style.gridColumn = String(n.col - c0);
    grid.append(cell);
  }
  return grid;
}

function nodeTitle(n: BoardNode) {
  const effects = n.effectList.map((e) => e.desc).join(", ");
  return `${n.name || n.type}${effects ? `: ${effects}` : ""}${n.open ? " (aberto)" : ""}`;
}

function daevanion(p: Profile) {
  const boards = p.info.daevanion?.boardList ?? [];
  if (!boards.length) return el("p", { className: "hint" }, "O perfil não trouxe tabuleiros Daevanion.");
  // Crystals by type: spent on open nodes, against what the game gives at most.
  const byType = new Map<string, number>();
  const rows = boards.map((b) => {
    const known = game ? findBoard(game, b.id) : null;
    const nodes = p.boards[String(b.id)]?.nodeList ?? [];
    let crystals = "";
    if (known && nodes.length) {
      const { crystals: n } = spent(known.board, nodes);
      byType.set(known.board.pointType, (byType.get(known.board.pointType) ?? 0) + n);
      crystals = ` · ${n}/${boardCost(known.board)} cristais`;
    }
    const row = el("button", { className: `board-row${openBoard === b.id ? " active" : ""}`, ariaExpanded: String(openBoard === b.id) },
      b.icon ? el("img", { src: b.icon, alt: "" }) : el("span"),
      el("strong", {}, b.name),
      bar(b.openNodeCount, b.totalNodeCount),
      el("span", { className: "count" }, `${b.openNodeCount}/${b.totalNodeCount} nós${crystals}`));
    row.addEventListener("click", () => { openBoard = openBoard === b.id ? null : b.id; render(); });
    return row;
  });
  const shown = openBoard != null ? p.boards[String(openBoard)] : null;
  const detail = shown ? el("div", { className: "board-detail" },
    boardGrid(shown),
    el("div", {},
      el("h4", {}, "Efeitos abertos"),
      el("ul", { className: "effects" }, ...[...(shown.openStatEffectList ?? []), ...(shown.openSkillEffectList ?? [])].map((e) => el("li", {}, e.desc)))),
  ) : "";
  const level = p.info.profile?.characterLevel ?? 1;
  const known = game ? findBoard(game, boards[0].id) : null;
  const locked = known ? known.boards.filter((b) => b.needLevel > level) : [];
  const totals = game ? [...byType].map(([type, n]) => stat(game!.daevanion.points[type]?.name ?? type, `${n}/${game!.daevanion.points[type]?.max ?? "?"}`, "gastos / máximo do jogo")) : [];
  return el("div", {},
    totals.length ? el("div", { className: "stat-row" }, ...totals) : "",
    el("div", { className: "boards" }, ...rows),
    locked.length ? el("p", { className: "hint" }, `Próximos tabuleiros: ${locked.map((b) => `${b.name} no nível ${b.needLevel}`).join(", ")}.`) : "",
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
    ...groups.map((g) => el("details", { className: "source" },
      el("summary", {}, el("strong", {}, g.name), ` · ${g.points} pontos em ${g.list.length}`),
      el("ul", {}, ...g.list.map((x) => el("li", {}, `${x.name} · ${x.points} ponto(s)${x.limit ? ` · até ${x.limit}x` : ""}${x.price ? ` · ${x.price} cada` : ""}`))))),
  );
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
    el("h2", {}, "Skills e Stigmas"), skills(profile),
    el("h2", {}, "Pontos e onde conseguir"), points(profile),
    el("h2", {}, "Daevanion"), daevanion(profile),
    el("p", { className: "hint" }, "Dados do perfil público no site oficial do AION 2. Pontos, tabuleiros e custos da ", el("a", { href: "https://dbaion2.ru" }, "dbaion2.ru"), " (cliente Global, em inglês)."),
  );
}

export function renderBuild(saved: Saved) {
  profile = saved.profile;
  if (profile && !game && !gameError) {
    loadGameData().then((g) => { game = g; render(); }).catch((e) => { gameError = String(e); render(); });
  }
  if (profile && Date.now() - profile.fetched_ms > REFRESH_MS) load();
  render();
}

setInterval(() => { if (profile && Date.now() - profile.fetched_ms > REFRESH_MS) load(); }, 60_000);
