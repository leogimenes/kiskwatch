// The panel's Evolution tab: where the followed character is behind, the
// biggest gaps first, each with its numbers and the tab that shows it.
import { Profile, Saved, loadProfile } from "./api";
import { GameData, loadGameData } from "./buildData";
import { itemLevel } from "./compare";
import { Analysis, Finding, Level, Note, analyze } from "./evolution";

const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T;
function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, unknown> = {}, ...kids: (Node | string)[]): HTMLElementTagNameMap[K] {
  const e = Object.assign(document.createElement(tag), props);
  e.append(...kids);
  return e;
}

const LEVEL: Record<Level, string> = { alta: "Prioridade alta", media: "Prioridade média", baixa: "Prioridade baixa" };
const TAB_NAME: Record<NonNullable<Finding["tab"]>, string> = {
  build: "Build", group: "Grupo", dps: "DPS", titles: "Títulos", pets: "Pets", enchant: "Encantar",
};

let saved: Saved | null = null;
let game: GameData | null = null;
let gameError = "";
let asked = false;
let busy = false;
let status = "";
let drawnKey = "";

function ago(ms: number) {
  const min = Math.floor(ms / 60_000);
  return min < 1 ? "agora" : min < 60 ? `há ${min} min` : min < 48 * 60 ? `há ${Math.floor(min / 60)} h` : `há ${Math.floor(min / 1440)} dias`;
}

function stat(label: string, value: string, note = "") {
  return el("div", { className: "stat" }, el("small", {}, label), el("strong", {}, value), note ? el("span", { className: "hint" }, note) : "");
}

async function refresh() {
  if (busy) return;
  busy = true;
  status = "Lendo o perfil…";
  draw();
  try {
    await loadProfile();
    status = "";
  } catch (err) {
    status = `Não deu para ler o perfil: ${err}`;
  } finally {
    busy = false;
    draw();
  }
}

/** Who is being analyzed, and the numbers the game itself shows. */
function header(p: Profile) {
  const info = p.info.profile;
  const boards = p.info.daevanion?.boardList ?? [];
  const open = boards.reduce((n, b) => n + b.openNodeCount, 0), total = boards.reduce((n, b) => n + b.totalNodeCount, 0);
  const update = el("button", { textContent: "Atualizar perfil", disabled: busy });
  update.addEventListener("click", refresh);
  const il = itemLevel(p);
  return el("div", {},
    el("div", { className: "char-card" },
      el("div", { className: "char-main" },
        el("h2", {}, info?.characterName ?? p.name),
        el("div", { className: "hint" }, [info?.className, info && `nível ${info.characterLevel}`, info?.serverName].filter(Boolean).join(" · "))),
      el("div", { className: "char-actions" }, el("small", { className: "hint" }, `Perfil lido ${ago(Date.now() - p.fetched_ms)}`), update)),
    status ? el("p", { className: "hint" }, status) : "",
    el("div", { className: "stat-row" },
      stat("Poder de combate", (info?.combatPower ?? 0).toLocaleString("pt-BR")),
      il != null ? stat("Nível do item", il.toLocaleString("pt-BR")) : "",
      total ? stat("Nós Daevanion", `${open}/${total}`) : "",
      p.info.title?.totalCount ? stat("Títulos", `${p.info.title.ownedCount ?? 0}/${p.info.title.totalCount}`) : ""));
}

function goTo(tab: string) {
  document.querySelector<HTMLButtonElement>(`.tabs button[data-tab="${tab}"]`)?.click();
}

function card(f: Finding) {
  const go = f.tab ? el("button", { type: "button", className: "link", textContent: `Ver na aba ${TAB_NAME[f.tab]}` }) : null;
  go?.addEventListener("click", () => goTo(f.tab!));
  return el("article", { className: `finding lv-${f.level}` },
    el("header", {}, el("span", { className: "finding-area" }, f.area), el("h4", {}, f.title)),
    el("p", {}, f.detail),
    f.items?.length ? el("ul", {}, ...f.items.map((i) => el("li", {}, i))) : "",
    go ?? "");
}

function notes(title: string, list: Note[], open = false) {
  if (!list.length) return "";
  return el("details", { className: "evo-notes", open },
    el("summary", {}, `${title} (${list.length})`),
    el("ul", {}, ...list.map((n) => el("li", {}, el("strong", {}, `${n.area}: `), n.text))));
}

function body(a: Analysis) {
  const groups = (["alta", "media", "baixa"] as Level[]).map((lv) => {
    const list = a.findings.filter((f) => f.level === lv);
    return list.length ? el("section", { className: "evo-group" }, el("h3", {}, `${LEVEL[lv]} `, el("span", { className: "hint" }, String(list.length))), ...list.map(card)) : "";
  });
  return el("div", {},
    a.findings.length ? "" : el("p", {}, "Nenhum ponto atrasado com os dados de agora."),
    ...groups,
    notes("Em dia", a.ok),
    notes("Faltam dados para", a.missing));
}

function draw() {
  const box = $("#evolution");
  if (!box) return;
  const p = saved?.profile;
  if (!p) {
    box.replaceChildren(el("p", { className: "hint" }, "Siga um personagem na aba Build. A análise usa o perfil público dele, os dados do jogo da dbaion2 e as suas gravações de DPS."));
    return;
  }
  const a = analyze({ profile: p, game, fights: saved!.fights, pets: saved!.pets, serverId: saved!.settings.server_id });
  box.replaceChildren(
    header(p),
    !game && !gameError ? el("p", { className: "hint" }, "Carregando os dados do jogo…") : "",
    gameError ? el("p", { className: "hint" }, `Sem os dados do jogo (${gameError}): algumas regras ficam de fora.`) : "",
    body(a),
    el("p", { className: "hint" }, "Tudo é calculado no seu computador, com regras fixas e sem IA: nada desta aba é enviado. Os limites de cada regra estão na ajuda (?)."));
}

export function renderEvolution(s: Saved) {
  saved = s;
  if (s.profile && !asked) {
    asked = true;
    loadGameData().then((g) => { game = g; drawnKey = ""; draw(); }).catch((e) => { gameError = String(e); drawnKey = ""; draw(); });
  }
  // The panel refreshes on every game event: only a change redraws.
  const pets = JSON.stringify(s.pets[String(s.settings.server_id)] ?? {});
  const key = `${s.profile?.character_id}:${s.profile?.fetched_ms}:${s.fights.length}:${s.fights[0]?.id}:${s.settings.server_id}:${pets.length}:${pets}`;
  if (key === drawnKey) return;
  drawnKey = key;
  draw();
}
