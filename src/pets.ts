// The pets overlay: the pet being farmed, the nearest one to farm next, and
// the pets pinned in the panel, each with its level and the souls to the next.
import { Saved, SoulSeen, getSaved, getSouls, onStateChanged } from "./api";
import { GENUS, GENUS_MARK, PET_BY_ID, Pet, SOULS_PER_LEVEL, levelProgress, name, soulsToMax, t } from "./data";
import { FARMING_MS, farming, nextPet } from "./farm";
import { applyLook } from "./look";

let saved: Saved | null = null;
let souls: SoulSeen[] = [];

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", ...kids: (Node | string)[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  e.append(...kids);
  return e;
}

function progress(pet: number) {
  const server = saved?.settings.server_id ?? 0;
  return saved?.pets[String(server)]?.pets[String(pet)] ?? { level: 0, points: 0 };
}

const badge = (p: Pet) => {
  const b = el("span", `genus ${p.genus ?? ""}`, GENUS_MARK[p.genus ?? ""] ?? "");
  b.title = p.genus ? name(GENUS[p.genus] ?? {}) : "";
  return b;
};

/** Filled pips for the levels reached, empty for the rest. */
function pips(level: number) {
  const box = el("span", "pips");
  box.setAttribute("aria-label", `nível ${level} de ${SOULS_PER_LEVEL.length}`);
  for (let l = 1; l <= SOULS_PER_LEVEL.length; l++) box.append(el("i", l <= level ? "on" : ""));
  return box;
}

/** The pet's line: type, name, level, and a bar of the souls to the next level. */
function petCard(p: Pet, cls: string, note?: string) {
  const g = progress(p.id);
  const lp = levelProgress(g.level, g.points);
  const bar = el("span", "bar-track");
  const fill = el("span", "bar-fill");
  fill.style.width = lp ? `${(100 * lp.have) / lp.need}%` : "100%";
  bar.append(fill);
  const count = lp ? `${lp.have}/${lp.need} · faltam ${lp.need - lp.have}` : "nível máximo";
  const card = el("li", `pet ${cls} ${p.genus ?? ""}${lp ? "" : " maxed"}`,
    el("div", "line", badge(p), el("span", "name", name(p.name)), pips(g.level)),
    el("div", "line", bar, el("span", "count", count)),
  );
  if (note) card.append(el("div", "note", note));
  card.title = `${name(p.name)}: faltam ${soulsToMax(g.level, g.points)} almas para o máximo`;
  return card;
}

function render() {
  const now = Date.now();
  const cur = farming(souls, now);
  const top: HTMLElement[] = [];
  if (cur) {
    const p = PET_BY_ID.get(cur.pet);
    const recent = souls.filter((s) => s.pet === cur.pet && now - s.at_ms <= FARMING_MS).reduce((n, s) => n + s.amount, 0);
    if (p) top.push(el("h3", "", "Farmando agora"), petCard(p, "farming", `+${recent} alma(s) nos últimos 30 min`));
    const next = nextPet(cur.pet, progress);
    if (next) {
      const k = next.drop.kibelisk;
      const where = `${t(next.drop.npc)} · ${next.drop.zones.map(t)[0] ?? t(next.drop.map)}${k ? ` · Kibelisk #${k.teleport}` : ""}`;
      top.push(el("h3", "", "Próximo (mais perto)"), petCard(next.pet, "next", where));
    }
  }
  document.querySelector("#now")!.replaceChildren(...top);
  const ids = (saved?.settings.pinned_pets ?? []).filter((id) => id !== cur?.pet);
  const list = document.querySelector("#pinned")!;
  list.replaceChildren(...ids.map((id) => PET_BY_ID.get(id)).filter((p): p is Pet => !!p).map((p) => petCard(p, "")));
  if (!ids.length && !cur) list.append(el("li", "empty", "Fixe pets (★) na aba Pets do painel. O pet que você estiver farmando aparece aqui sozinho."));
}

async function refresh() {
  [saved, souls] = await Promise.all([getSaved(), getSouls()]);
  applyLook(saved.settings.a11y);
  render();
}

onStateChanged(refresh);
refresh();
// "Farming now" lapses after a while without souls.
setInterval(render, 30_000);
