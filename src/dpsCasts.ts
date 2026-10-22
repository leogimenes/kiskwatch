// The DPS tab's "Uso das recargas": how many times a player used each skill in
// a recording against how many its cooldown allowed, and how long it sat
// ready. Cooldowns come from dbaion2 (at the profile's skill level for your
// own character); when someone used a skill faster than that, a stigma or a
// Daevanion node shortened it, and the shortest gap seen is the cooldown.
import { Fight, FightPlayer, Profile, SkillCasts } from "./api";
import { GameData, iconUrl, loadGameData } from "./buildData";
import { CLASS } from "./dpsView";

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

/** One skill's row: uses against what the cooldown allowed over `secs`. */
export function castRow(c: SkillCasts, secs: number, data: number | null): Omit<CastRow, "name" | "icon"> {
  const uses = c.at.length;
  const gaps = c.at.slice(1).map((t, i) => (t - c.at[i]) / 1000);
  const shortest = gaps.length ? Math.min(...gaps) : Infinity;
  let cooldown = data, reduced = false;
  if (cooldown != null && shortest < cooldown * 0.95) [cooldown, reduced] = [shortest, true];
  if (cooldown == null || cooldown < MIN_COOLDOWN) return { skill: c.skill, uses, cooldown, reduced, possible: null, idle: null };
  const possible = Math.max(uses, Math.floor(secs / cooldown) + 1);
  const at = c.at.map((t) => t / 1000);
  let idle = at[0] ?? secs;
  for (let i = 1; i < at.length; i++) idle += Math.max(0, at[i] - at[i - 1] - cooldown);
  if (at.length) idle += Math.max(0, secs - at[at.length - 1] - cooldown);
  return { skill: c.skill, uses, cooldown, reduced, possible, idle };
}

/** A player's rows, the most uses lost first; unmeasured skills last. */
export function castRows(p: FightPlayer, secs: number, game: GameData | null, profile: Profile | null): CastRow[] {
  const mine = p.local ? profile?.equipment.skill?.skillList ?? [] : [];
  return (p.casts ?? []).map((c) => {
    const known = game?.skills.get(c.skill);
    const own = mine.find((s) => s.id === c.skill);
    const level = own?.acquired ? known?.levels?.find((l) => l.level === own.skillLevel) : undefined;
    const data = known && known.type !== "passive" ? level?.cooldownSec ?? known.cooldownSec : null;
    return {
      ...castRow(c, secs, data),
      name: own?.name || known?.name || `Skill ${c.skill}`,
      icon: own?.icon || (known?.icon ? iconUrl(known.icon) : ""),
    };
  }).sort((a, b) => (a.possible == null ? 1 : 0) - (b.possible == null ? 1 : 0)
    || (b.possible ?? 0) - b.uses - ((a.possible ?? 0) - a.uses) || b.uses - a.uses);
}

const secondsText = (s: number) => `${s.toLocaleString("pt-BR", { maximumFractionDigits: s < 10 ? 1 : 0 })} s`;

let game: GameData | null = null;
let loading = false;
let who: number | null = null;

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

/** The section for a recording; `redraw` runs once the game data arrives. */
export function castsSection(f: Fight, profile: Profile | null, redraw: () => void) {
  if (!game && !loading) {
    loading = true;
    loadGameData().then((g) => { game = g; redraw(); }, () => {}).finally(() => { loading = false; });
  }
  const players = f.players.filter((p) => p.casts?.length);
  const box = el("section", { className: "casts-box" }, el("h3", {}, "Uso das recargas"));
  if (!players.length) {
    box.append(el("p", { className: "hint" }, "Nenhum uso de skill nesta gravação (gravações antigas não guardavam os usos)."));
    return box;
  }
  const p = players.find((x) => x.id === who) ?? players.find((x) => x.local) ?? players[0];
  const pick = el("select", { ariaLabel: "Jogador" }, ...players.map((x) =>
    el("option", { value: String(x.id), selected: x.id === p.id }, x.class ? `${x.name} (${CLASS[x.class].name})` : x.name)));
  pick.addEventListener("change", () => { who = Number(pick.value); redraw(); });
  const secs = Math.max(1, (f.ended_ms - f.started_ms) / 1000);
  const rows = castRows(p, secs, game, profile);
  const measured = rows.filter((r) => r.possible != null);
  const lost = measured.reduce((n, r) => n + r.possible! - r.uses, 0);
  box.append(
    el("div", { className: "casts-head" }, pick,
      el("span", { className: "hint" }, measured.length ? `${lost} uso(s) a mais cabiam nas recargas de ${measured.length} skill(s)` : game ? "" : "Carregando recargas da dbaion2…")),
    table(rows),
    el("p", { className: "hint" }, "Possíveis: quantas vezes a recarga deixava usar desde o início da gravação. Pronta sem uso: tempo somado com a skill disponível e parada. Golpes a menos de 1 s um do outro contam como um uso; danos contínuos não contam."),
  );
  return box;
}
