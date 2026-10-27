// The Group tab: the players the game named around you (your party, whoever
// fought with you), anyone by name, and the builds you saved; each one's
// public profile compared with your own character's.
import {
  Hit, Profile, ProfileItem, ProfileSkill, Reference, Saved, SeenPlayer, deleteReference, findPlayer, inspectProfile, nearbyPlayers,
  renameReference, saveReference,
} from "./api";
import { BoardPair, SLOT_NAME, boards, delta, differs, gear, grouped, itemLevel, itemPower, sameClass, skillLevel, skills, stats } from "./compare";
import { CLASS, UNKNOWN_COLOR } from "./dpsView";

const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T;
function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, unknown> = {}, ...kids: (Node | string)[]): HTMLElementTagNameMap[K] {
  const e = Object.assign(document.createElement(tag), props);
  e.append(...kids);
  return e;
}

const CATEGORY: Record<string, string> = { Active: "Ativas", Passive: "Passivas", Dp: "Stigmas", Stigma: "Stigmas" };
const CATEGORY_ORDER = ["Active", "Passive", "Dp", "Stigma"];

let saved: Saved | null = null;
let nearby: SeenPlayer[] = [];
/** The profile on the right: someone looked up now, or a saved build. */
let shown: { profile: Profile; ref: Reference | null } | null = null;
/** Search results waiting for a pick. */
let hits: Hit[] = [];
let status = "";
let busy = false;
let allSkills = false;
/** The Daevanion boards opened to list their nodes. */
const openBoards = new Set<number>();

const me = () => saved?.profile ?? null;
const ago = (ms: number) => {
  const min = Math.floor((Date.now() - ms) / 60_000);
  return min < 1 ? "agora" : min < 60 ? `há ${min} min` : min < 1440 ? `há ${Math.floor(min / 60)} h` : `há ${Math.floor(min / 1440)} d`;
};
const day = (ms: number) => new Date(ms).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", year: "2-digit", hour: "2-digit", minute: "2-digit" });
const num = (n?: number) => (n == null ? "—" : n.toLocaleString("pt-BR"));

function setStatus(text: string) {
  status = text;
  $("#group-status").textContent = text;
}

/** Look a name up on the official site; one exact match opens right away. */
async function find(name: string) {
  if (busy || !name.trim()) return;
  busy = true;
  hits = [];
  setStatus(`Buscando ${name}…`);
  try {
    const found = await findPlayer(name.trim());
    const exact = found.filter((h) => h.name.toLowerCase() === name.trim().toLowerCase());
    busy = false;
    if (exact.length === 1) return open(exact[0]);
    hits = found;
    setStatus(found.length ? "" : `Ninguém chamado ${name} no site oficial desta região.`);
  } catch (err) {
    setStatus(`Não deu para buscar: ${err}`);
  } finally {
    busy = false;
    render();
  }
}

async function open(h: { server_id: number; character_id: string; name: string }) {
  if (busy) return;
  busy = true;
  hits = [];
  setStatus(`Lendo o perfil de ${h.name}…`);
  render();
  try {
    shown = { profile: await inspectProfile(h.server_id, h.character_id), ref: null };
    openBoards.clear();
    setStatus("");
  } catch (err) {
    setStatus(`Não deu para ler o perfil: ${err}`);
  } finally {
    busy = false;
    render();
  }
}

// ---- The list on the left ----

function shield(cls: SeenPlayer["class"]) {
  const s = el("span", { className: "shield", title: cls ? CLASS[cls].name : "classe desconhecida" });
  s.style.background = cls ? CLASS[cls].color : UNKNOWN_COLOR;
  return s;
}

/** The players named around you, and the last recording's, once each. */
function people(): (SeenPlayer & { lastFight: boolean })[] {
  const list = nearby.map((p) => ({ ...p, lastFight: false }));
  const fight = saved?.fights[0];
  for (const p of fight?.players ?? []) {
    if (p.local || /^Jogador \d+$/.test(p.name)) continue;
    const there = list.find((x) => x.name === p.name);
    if (there) there.lastFight = true;
    else list.push({ name: p.name, class: p.class, seen_ms: fight!.ended_ms, fighting: false, lastFight: true });
  }
  return list;
}

function nearbyList() {
  const list = people();
  if (!list.length) {
    return el("p", { className: "hint" }, "Ninguém por perto ainda. Os nomes aparecem quando o jogo mostra outros jogadores (o seu grupo, quem luta perto de você).");
  }
  return el("ul", { className: "people" }, ...list.map((p) => {
    const note = p.fighting ? "na luta agora" : p.lastFight ? "na última luta" : ago(p.seen_ms);
    const b = el("button", { type: "button", disabled: busy, className: shown?.profile.name === p.name && !shown.ref ? "active" : "" },
      shield(p.class), el("strong", {}, p.name), el("span", { className: "hint" }, note));
    b.addEventListener("click", () => find(p.name));
    return el("li", {}, b);
  }));
}

function refList() {
  const refs = saved?.references ?? [];
  if (!refs.length) return el("p", { className: "hint" }, "Nenhuma build salva. Abra o perfil de alguém e clique em Salvar como referência.");
  return el("ul", { className: "people" }, ...refs.map((r) => {
    const p = r.profile.info.profile;
    const b = el("button", { type: "button", className: shown?.ref?.id === r.id ? "active" : "" },
      el("strong", {}, r.label),
      el("span", { className: "hint" }, [p?.className, p && `nv. ${p.characterLevel}`, `salva ${day(r.profile.fetched_ms)}`].filter(Boolean).join(" · ")));
    b.addEventListener("click", () => { shown = { profile: r.profile, ref: r }; hits = []; openBoards.clear(); render(); });
    return el("li", {}, b);
  }));
}

// ---- The comparison ----

function deltaCell(mine: number | undefined, theirs: number | undefined, show = true) {
  const d = delta(mine, theirs);
  return el("td", { className: `delta ${d.sign > 0 ? "more" : d.sign < 0 ? "less" : ""}` }, show ? d.text : "");
}

function card(p: Profile | null, who: string) {
  if (!p) {
    return el("div", { className: "char-card compare-card empty" }, el("div", {}, el("small", { className: "hint" }, who),
      el("p", { className: "hint" }, "Siga o seu personagem na aba Build para comparar.")));
  }
  const info = p.info.profile;
  return el("div", { className: "char-card compare-card" },
    info?.profileImage ? el("img", { src: info.profileImage, alt: "", className: "portrait" }) : "",
    el("div", { className: "char-main" },
      el("small", { className: "hint" }, who),
      el("h2", {}, info?.characterName ?? p.name),
      el("div", { className: "hint" }, [info?.className, info && `nível ${info.characterLevel}`, info?.serverName].filter(Boolean).join(" · "))),
    el("div", { className: "char-cp" }, el("small", {}, "Poder de combate"), el("strong", {}, num(info?.combatPower))));
}

function summary(mine: Profile | null, theirs: Profile) {
  const a = mine?.info.profile, b = theirs.info.profile;
  const row = (label: string, x?: number, y?: number) => el("tr", {}, el("th", {}, label), el("td", {}, num(x)), el("td", {}, num(y)), deltaCell(x, y, !!mine));
  return table(theirs, [
    row("Poder de combate", a?.combatPower, b?.combatPower),
    row("Nível", a?.characterLevel, b?.characterLevel),
    row("Nível de item", itemLevel(mine), itemLevel(theirs)),
  ]);
}

function table(theirs: Profile, rows: HTMLTableRowElement[], first = "") {
  return el("table", { className: "list compare" },
    el("thead", {}, el("tr", {}, el("th", {}, first), el("th", {}, "Você"), el("th", {}, theirs.name), el("th", {}, "Diferença"))),
    el("tbody", {}, ...rows));
}

function attributes(mine: Profile | null, theirs: Profile) {
  const rows = stats(mine, theirs).filter((r) => r.key !== "ItemLevel");
  if (!rows.length) return el("p", { className: "hint" }, "O perfil não trouxe atributos.");
  return table(theirs, rows.map((r) => el("tr", {}, el("th", {}, r.label), el("td", {}, num(r.mine)), el("td", {}, num(r.theirs)), deltaCell(r.mine, r.theirs, !!mine))));
}

function item(i?: ProfileItem) {
  if (!i) return el("td", { className: "hint" }, "—");
  return el("td", {}, el("span", { className: `item g-${i.grade.toLowerCase()}` },
    i.icon ? el("img", { src: i.icon, alt: "", loading: "lazy" }) : "",
    el("span", {}, i.name, el("span", { className: "hint" }, ` +${i.enchantLevel}${i.exceedLevel ? ` · ${i.exceedLevel} além` : ""}`))));
}

function equipment(mine: Profile | null, theirs: Profile) {
  const rows = gear(mine, theirs).map((r) => el("tr", {}, el("th", {}, SLOT_NAME[r.label] ?? r.label), item(r.mine), item(r.theirs),
    deltaCell(itemPower(r.mine), itemPower(r.theirs), !!mine)));
  const pw = (p: Profile | null) => p?.equipment.petwing;
  const wing = (p: Profile | null) => pw(p)?.wing;
  const pet = (p: Profile | null) => pw(p)?.pet;
  const extra = (label: string, x?: { name: string; icon: string } | null, xn?: number, y?: { name: string; icon: string } | null, yn?: number, unit = "+") =>
    el("tr", {}, el("th", {}, label),
      ...[[x, xn], [y, yn]].map(([v, n]) => {
        const o = v as { name: string; icon: string } | null | undefined;
        return o ? el("td", {}, el("span", { className: "item" }, o.icon ? el("img", { src: o.icon, alt: "", loading: "lazy" }) : "", el("span", {}, o.name, el("span", { className: "hint" }, ` ${unit}${n ?? 0}`)))) : el("td", { className: "hint" }, "—");
      }),
      deltaCell(xn, yn, !!mine && !!x && !!y));
  if (wing(mine) || wing(theirs)) rows.push(extra("Asas", wing(mine), wing(mine)?.enchantLevel, wing(theirs), wing(theirs)?.enchantLevel));
  if (pet(mine) || pet(theirs)) rows.push(extra("Montaria", pet(mine), pet(mine)?.level, pet(theirs), pet(theirs)?.level, "nv. "));
  if (!rows.length) return el("p", { className: "hint" }, "O perfil não trouxe equipamento.");
  return el("div", {}, table(theirs, rows, "Espaço"), el("p", { className: "hint" }, "A diferença do equipamento soma encantamento e nível além."));
}

function skillCell(s?: ProfileSkill) {
  if (!s) return el("td", { className: "hint" }, "—");
  return el("td", { className: s.acquired ? "" : "hint" }, s.acquired ? `Nv. ${s.skillLevel}` : "não tem", s.equip ? el("span", { className: "tag", title: "equipada" }, "eq.") : "");
}

function skillTable(mine: Profile | null, theirs: Profile) {
  if (!sameClass(mine, theirs)) {
    // Another class: their skills alone, to see what they took.
    const list = (theirs.equipment.skill?.skillList ?? []).filter((s) => s.acquired);
    return el("div", {},
      el("p", { className: "hint" }, mine ? `Classes diferentes: as skills não se comparam. Estas são as de ${theirs.name}, equipadas em destaque.` : ""),
      el("ul", { className: "tags" }, ...list.sort((a, b) => b.equip - a.equip || b.skillLevel - a.skillLevel)
        .map((s) => el("li", { className: s.equip ? "on" : "" }, s.icon ? el("img", { src: s.icon, alt: "", loading: "lazy" }) : "", `${s.name} ${s.skillLevel}`))));
  }
  const rows = skills(mine, theirs);
  const shownRows = allSkills ? rows : rows.filter(differs);
  const toggle = el("label", { className: "row" }, el("input", { type: "checkbox", checked: allSkills }), " Mostrar também as iguais");
  toggle.querySelector("input")!.addEventListener("change", (e) => { allSkills = (e.target as HTMLInputElement).checked; render(); });
  const groups = [...new Set(shownRows.map((r) => r.category))].sort((a, b) => (CATEGORY_ORDER.indexOf(a) + 1 || 99) - (CATEGORY_ORDER.indexOf(b) + 1 || 99));
  const behind = rows.filter((r) => r.gap > 0).reduce((n, r) => n + r.gap, 0);
  const ahead = rows.filter((r) => r.gap < 0).reduce((n, r) => n - r.gap, 0);
  return el("div", {},
    el("p", { className: "hint" }, `Somando as diferenças: ${theirs.name} está ${behind} nível(is) de skill à sua frente e você ${ahead} à frente. "eq." é skill equipada.`),
    toggle,
    shownRows.length ? table(theirs, groups.flatMap((cat) => [
      el("tr", { className: "group-head" }, el("th", { colSpan: 4 }, CATEGORY[cat] ?? cat)),
      ...shownRows.filter((r) => r.category === cat).sort((a, b) => b.gap - a.gap || a.label.localeCompare(b.label)).map((r) => {
        const s = (r.theirs ?? r.mine)!;
        return el("tr", {}, el("th", {}, el("span", { className: "item" }, s.icon ? el("img", { src: s.icon, alt: "", loading: "lazy" }) : "", r.label)),
          skillCell(r.mine), skillCell(r.theirs), deltaCell(skillLevel(r.mine), skillLevel(r.theirs)));
      }),
    ]), "Skill") : el("p", { className: "hint" }, "Mesmas skills, nos mesmos níveis e espaços."));
}

function nodeList(title: string, nodes: BoardPair["ahead"]) {
  if (!nodes.length) return "";
  return el("div", {}, el("h4", {}, title), el("ul", { className: "effects" }, ...grouped(nodes).map((g) => el("li", {}, g.count > 1 ? `${g.text} ×${g.count}` : g.text))));
}

function daevanion(mine: Profile | null, theirs: Profile) {
  const list = boards(mine, theirs);
  if (!list.length) return el("p", { className: "hint" }, "O perfil não trouxe tabuleiros Daevanion.");
  const same = sameClass(mine, theirs);
  return el("div", { className: "boards" }, ...list.map((b) => {
    const isOpen = openBoards.has(b.id);
    const canOpen = same && (b.ahead.length > 0 || b.behind.length > 0);
    const row = el("button", { type: "button", className: `board-row compare-board${isOpen ? " active" : ""}`, disabled: !canOpen, ariaExpanded: String(isOpen) },
      b.icon ? el("img", { src: b.icon, alt: "" }) : el("span"),
      el("strong", {}, b.name),
      el("span", { className: "two-bars" }, bar(b.mine, b.total, "Você"), bar(b.theirs, b.total, theirs.name)),
      el("span", { className: "count" }, `${mine ? b.mine : "—"} / ${b.theirs} de ${b.total}`));
    row.addEventListener("click", () => { if (isOpen) openBoards.delete(b.id); else openBoards.add(b.id); render(); });
    return el("div", {}, row, isOpen ? el("div", { className: "board-diff" },
      nodeList(`Abertos só por ${theirs.name} (${b.ahead.length})`, b.ahead),
      nodeList(`Abertos só por você (${b.behind.length})`, b.behind)) : "");
  }), el("p", { className: "hint" }, `Barra azul: você. Barra dourada: ${theirs.name}.${same ? " Clique num tabuleiro para ver os nós abertos só de um dos lados." : ""}`));
}

function bar(have: number, total: number, who: string) {
  const track = el("span", { className: "meter", title: `${who}: ${have}/${total}` });
  const fill = el("span", { className: "meter-fill" });
  fill.style.width = `${total ? (100 * have) / total : 0}%`;
  track.append(fill);
  return track;
}

function actions(p: Profile, ref: Reference | null) {
  const box = el("div", { className: "compare-actions" });
  if (ref) {
    const label = el("input", { value: ref.label, maxLength: 50, ariaLabel: "Nome da build salva" });
    label.addEventListener("change", () => { if (label.value.trim()) renameReference(ref.id, label.value); });
    const fresh = el("button", { type: "button", textContent: "Ver a build de agora", disabled: busy });
    fresh.addEventListener("click", () => open(p));
    const del = el("button", { type: "button", textContent: "Apagar" });
    del.addEventListener("click", async () => {
      if (!confirm(`Apagar a build salva "${ref.label}"?`)) return;
      await deleteReference(ref.id);
      shown = null;
    });
    box.append(label, el("span", { className: "hint" }, `salva com o perfil de ${day(p.fetched_ms)}`), fresh, del);
  } else {
    const keep = el("button", { type: "button", textContent: "Salvar como referência" });
    keep.addEventListener("click", async () => {
      const info = p.info.profile;
      const label = `${p.name}${info ? ` · ${info.className} ${info.characterLevel}` : ""}`;
      const id = await saveReference(p, label);
      shown = { profile: p, ref: { id, label, profile: p } };
      render();
    });
    const fresh = el("button", { type: "button", textContent: "Atualizar", disabled: busy });
    fresh.addEventListener("click", () => open(p));
    box.append(el("span", { className: "hint" }, `Perfil lido ${ago(p.fetched_ms)}`), fresh, keep);
  }
  return box;
}

function comparison() {
  if (hits.length) {
    return el("div", {}, el("h3", {}, "Qual destes?"), el("ul", { className: "hits" }, ...hits.map((h) => {
      const b = el("button", { type: "button" }, el("strong", {}, h.name), ` · nível ${h.level} · ${h.server_name}`);
      b.addEventListener("click", () => open(h));
      return el("li", {}, b);
    })));
  }
  if (!shown) {
    return el("p", { className: "hint" }, "Escolha alguém à esquerda: o Kiskwatch lê o perfil público no site oficial e compara com o seu personagem (o da aba Build). Salve a build de quem você quer usar como referência para comparar de novo depois, mesmo que a pessoa mude.");
  }
  const { profile: theirs, ref } = shown;
  const mine = me();
  return el("div", {},
    actions(theirs, ref),
    el("div", { className: "compare-cards" }, card(mine, "Você"), card(theirs, ref ? `Build salva: ${ref.label}` : "Comparando com")),
    el("h2", {}, "Resumo"), summary(mine, theirs),
    el("h2", {}, "Equipamento"), equipment(mine, theirs),
    el("h2", {}, "Skills e stigmas"), skillTable(mine, theirs),
    el("h2", {}, "Daevanion"), daevanion(mine, theirs),
    el("h2", {}, "Atributos"), attributes(mine, theirs),
    el("p", { className: "hint" }, "Dados dos perfis públicos no site oficial do AION 2."),
  );
}

function render() {
  $("#group-near").replaceChildren(nearbyList());
  $("#group-refs").replaceChildren(refList());
  $("#group-status").textContent = status;
  $("#group-view").replaceChildren(comparison());
}

$("#group-search").addEventListener("submit", (e) => {
  e.preventDefault();
  find($<HTMLInputElement>("#group-name").value);
});

let lastKey = "";

export function renderGroup(s: Saved) {
  saved = s;
  // A saved build that was deleted elsewhere closes.
  if (shown?.ref && !s.references.some((r) => r.id === shown!.ref!.id)) shown = null;
  // The panel refreshes on every game event: redraw only when something here changed.
  const key = JSON.stringify([s.profile?.fetched_ms, s.references.map((r) => [r.id, r.label]), s.fights[0]?.id]);
  if (key === lastKey) return;
  lastKey = key;
  render();
}

async function poll(force = false) {
  if (!force && !$("#tab-group").classList.contains("active")) return;
  const next = await nearbyPlayers();
  if (JSON.stringify(next.map((p) => [p.name, p.fighting])) === JSON.stringify(nearby.map((p) => [p.name, p.fighting]))) {
    nearby = next;
    return;
  }
  nearby = next;
  $("#group-near").replaceChildren(nearbyList());
}

setInterval(poll, 5_000);
document.querySelector<HTMLButtonElement>(".tabs button[data-tab='group']")?.addEventListener("click", () => { poll(true); render(); });
