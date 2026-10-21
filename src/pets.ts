// The pets overlay: the pet being farmed, the nearest one to farm next, and
// the pets pinned in the panel, each with its level and the souls to the next.
import { Saved, SoulSeen, getSaved, getSouls, onStateChanged } from "./api";
import { GENUS, GENUS_MARK, PET_BY_ID, Pet, SOULS_PER_LEVEL, levelProgress, name, soulsToMax, t } from "./data";
import { FARMING_MS, nextOnRoute, nextPet } from "./farm";
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

/** "agora", "há 5 min", "há 2 h". */
function ago(ms: number) {
  const min = Math.floor(ms / 60_000);
  return min < 1 ? "agora" : min < 60 ? `há ${min} min` : `há ${Math.floor(min / 60)} h`;
}

/** At level 3 a pet takes no more souls: it leaves the overlay. */
const maxed = (pet: number) => progress(pet).level >= SOULS_PER_LEVEL.length;

function render() {
  const now = Date.now();
  // The queue the app keeps: new pets on top, known ones keep their place.
  const queue = saved?.pet_queue[String(saved.settings.server_id)] ?? { pets: [], last: null };
  const recents = queue.pets.map((pet) => {
    const mine = souls.filter((x) => x.pet === pet);
    const at_ms = mine.length ? mine[mine.length - 1].at_ms : 0;
    const amount = mine.filter((x) => now - x.at_ms <= FARMING_MS).reduce((n, x) => n + x.amount, 0);
    return { pet, at_ms, amount };
  });
  const top: HTMLElement[] = [];
  if (recents.length) {
    top.push(el("h3", "", "Almas recentes"));
    for (const r of recents) {
      const p = PET_BY_ID.get(r.pet);
      const farming = r.pet === queue.last && now - r.at_ms <= FARMING_MS;
      const when = farming ? "farmando agora" : r.at_ms ? `última ${ago(now - r.at_ms)}` : "";
      if (p) top.push(petCard(p, farming ? "farming" : "", [r.amount ? `+${r.amount} alma(s) em 30 min` : "", when].filter(Boolean).join(" · ")));
    }
  }
  // The route's next stop; without a route, the nearest pet still missing souls.
  const route = saved?.settings.route ?? [];
  const onRoute = route.length ? nextOnRoute(route, queue.last ?? recents[0]?.pet ?? null, progress) : null;
  const next = onRoute ?? (recents.length && !route.length ? nextPet(queue.last ?? recents[0].pet, progress) : null);
  if (next) {
    const k = next.drop.kibelisk;
    const where = `${t(next.drop.npc)} · ${next.drop.zones.map(t)[0] ?? t(next.drop.map)}${k ? ` · Kibelisk #${k.teleport}` : ""}`;
    top.push(el("h3", "", onRoute ? "Próximo na rota" : "Próximo (mais perto)"), petCard(next.pet, "next", where));
  } else if (route.length && recents.length) {
    top.push(el("h3", "", "Rota concluída"));
  }
  document.querySelector("#now")!.replaceChildren(...top);
  const ids = (saved?.settings.pinned_pets ?? []).filter((id) => !maxed(id) && !recents.some((r) => r.pet === id));
  const list = document.querySelector("#pinned")!;
  list.replaceChildren(...(ids.length ? [el("h3", "", "Fixados")] : []),
    ...ids.map((id) => PET_BY_ID.get(id)).filter((p): p is Pet => !!p).map((p) => petCard(p, "")));
  if (!ids.length && !recents.length) list.append(el("li", "empty", "Fixe pets (★) na aba Pets do painel. Os pets em que você pegar almas aparecem aqui sozinhos."));
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
