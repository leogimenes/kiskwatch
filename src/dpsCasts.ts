// The DPS tab's "Uso das recargas": how many times a player used each skill in
// a recording against how many its cooldown allowed, and how long it sat
// ready. Cooldowns come from dbaion2 (at the profile's skill level for your
// own character); when someone used a skill faster than that, a stigma or a
// Daevanion node shortened it, and the shortest gap seen is the cooldown
// (unless it's under half: charges, or one use read as two). Only the time
// the group was fighting counts, not the walks between fights.
import { Fight, FightPlayer, Profile, SkillCasts } from "./api";
import { GameData, iconUrl, loadGameData } from "./buildData";
import { Windows, combatWindows } from "./dpsView";

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, unknown> = {}, ...kids: (Node | string)[]): HTMLElementTagNameMap[K] {
  const e = Object.assign(document.createElement(tag), props);
  e.append(...kids);
  return e;
}

/** Skills with a shorter cooldown than this (basic attacks) aren't measured. */
const MIN_COOLDOWN = 1;

export interface CastRow {
  skill: number; name: string; icon: string; uses: number;
  /** In seconds; null when the game data doesn't know the skill. */
  cooldown: number | null;
  /** The cooldown is the shortest gap seen, below the game data's. */
  reduced: boolean;
  possible: number | null;
  /** Seconds the skill was ready and not used. */
  idle: number | null;
}

/** Combat seconds between `from` and `to`. */
function fighting(w: Windows, from: number, to: number) {
  return w.reduce((n, [a, b]) => n + Math.max(0, Math.min(b, to) - Math.max(a, from)), 0);
}

/** A shortest gap below this share of the game data's cooldown isn't a
 *  reduction: a skill with charges, or one use read as two. */
const MAX_REDUCTION = 0.5;

/** One skill's row: uses against what the cooldown allowed while fighting.
 *  The cooldown keeps running between fights, so each one starts ready. */
export function castRow(c: SkillCasts, w: Windows, data: number | null): Omit<CastRow, "name" | "icon"> {
  const uses = c.at.length;
  const gaps = c.at.slice(1).map((t, i) => (t - c.at[i]) / 1000);
  const shortest = gaps.length ? Math.min(...gaps) : Infinity;
  let cooldown = data, reduced = false;
  if (cooldown != null && shortest < cooldown * 0.95 && shortest >= cooldown * MAX_REDUCTION) [cooldown, reduced] = [shortest, true];
  if (cooldown == null || cooldown < MIN_COOLDOWN) return { skill: c.skill, uses, cooldown, reduced, possible: null, idle: null };
  // Used as soon as it's ready, from each fight's start on.
  let most = 0, ready = 0;
  for (const [a, b] of w) {
    const from = Math.max(a, ready);
    if (from > b) continue;
    const n = Math.floor((b - from) / cooldown) + 1;
    most += n;
    ready = from + n * cooldown;
  }
  const possible = Math.max(uses, most);
  const end = w.length ? w[w.length - 1][1] : 0;
  let idle = 0;
  ready = 0;
  for (const t of c.at.map((t) => t / 1000)) {
    idle += fighting(w, ready, t);
    ready = Math.max(ready, t + cooldown);
  }
  idle += fighting(w, ready, end);
  return { skill: c.skill, uses, cooldown, reduced, possible, idle };
}

/** A player's rows, the most uses lost first; unmeasured skills last. */
export function castRows(p: FightPlayer, w: Windows, game: GameData | null, profile: Profile | null): CastRow[] {
  const mine = p.local ? profile?.equipment.skill?.skillList ?? [] : [];
  return (p.casts ?? []).map((c) => {
    const known = game?.skills.get(c.skill);
    const own = mine.find((s) => s.id === c.skill);
    const level = own?.acquired ? known?.levels?.find((l) => l.level === own.skillLevel) : undefined;
    const data = known && known.type !== "passive" ? level?.cooldownSec ?? known.cooldownSec : null;
    return {
      ...castRow(c, w, data),
      name: own?.name || known?.name || `Skill ${c.skill}`,
      icon: own?.icon || (known?.icon ? iconUrl(known.icon) : ""),
    };
  }).sort((a, b) => (a.possible == null ? 1 : 0) - (b.possible == null ? 1 : 0)
    || (b.possible ?? 0) - b.uses - ((a.possible ?? 0) - a.uses) || b.uses - a.uses);
}

const secondsText = (s: number) => `${s.toLocaleString("pt-BR", { maximumFractionDigits: s < 10 ? 1 : 0 })} s`;

let game: GameData | null = null;
let loading = false;

function table(rows: CastRow[]) {
  const head = el("tr", {}, ...["Skill", "Usos", "Possíveis", "Aproveitamento", "Recarga", "Pronta sem uso"].map((t) => el("th", { scope: "col" }, t)));
  return el("table", { className: "casts" }, el("thead", {}, head), el("tbody", {}, ...rows.map((r) => {
    const share = r.possible ? r.uses / r.possible : null;
    const bar = el("span", { className: "casts-bar" }, el("span", {}));
    (bar.firstChild as HTMLElement).style.width = `${Math.round((share ?? 0) * 100)}%`;
    const cooldown = el("td", {}, r.cooldown == null ? "—" : secondsText(r.cooldown));
    if (r.reduced) {
      cooldown.append(el("span", { className: "hint" }, " (reduzida)"));
      cooldown.title = "Usada mais rápido que a recarga da dbaion2: um stigma ou nó Daevanion reduz a recarga. Vale o menor intervalo visto.";
    }
    return el("tr", { className: r.possible == null ? "unmeasured" : "" },
      el("td", { className: "casts-skill" }, r.icon ? el("img", { src: r.icon, alt: "", loading: "lazy" }) : el("span", { className: "noicon" }), el("span", {}, r.name)),
      el("td", {}, String(r.uses)),
      el("td", {}, r.possible == null ? "—" : String(r.possible)),
      el("td", {}, share == null ? "—" : el("span", { className: "casts-share" }, bar, `${Math.round(share * 100)}%`)),
      cooldown,
      el("td", {}, r.idle == null ? "—" : secondsText(r.idle)));
  })));
}

/** The section for a player's recording; `redraw` runs once the game data arrives. */
export function castsSection(f: Fight, p: FightPlayer, profile: Profile | null, redraw: () => void) {
  if (!game && !loading) {
    loading = true;
    loadGameData().then((g) => { game = g; redraw(); }, () => {}).finally(() => { loading = false; });
  }
  const box = el("section", { className: "casts-box" }, el("h3", {}, `Uso das recargas de ${p.name}`));
  if (!p.casts?.length) {
    box.append(el("p", { className: "hint" }, "Nenhum uso de skill deste jogador nesta gravação (gravações antigas não guardavam os usos)."));
    return box;
  }
  const rows = castRows(p, combatWindows(f), game, profile);
  const measured = rows.filter((r) => r.possible != null);
  const lost = measured.reduce((n, r) => n + r.possible! - r.uses, 0);
  box.append(
    el("div", { className: "casts-head" },
      el("span", { className: "hint" }, measured.length ? `${lost} uso(s) a mais cabiam nas recargas de ${measured.length} skill(s)` : game ? "" : "Carregando recargas da dbaion2…")),
    table(rows),
    el("p", { className: "hint" }, "Possíveis: quantas vezes a recarga deixava usar durante o combate. Pronta sem uso: tempo de combate somado com a skill disponível e parada. Fora de combate (3 s ou mais sem ninguém do grupo agir) não conta, e a recarga segue correndo entre as lutas. Golpes a menos de 1 s um do outro contam como um uso; danos contínuos não contam."),
  );
  return box;
}
