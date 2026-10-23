// What the DPS overlay and the panel's DPS tab draw from a recording: the
// rows for the chosen target and bars, with each class's shield and color.
import { ClassName, DpsBars, DpsTarget, Fight, FightPlayer, Gear, playerGear } from "./api";

export const CLASS: Record<ClassName, { name: string; color: string }> = {
  Gladiator: { name: "Gladiador", color: "#e0823d" },
  Templar: { name: "Templário", color: "#4f7fe0" },
  Assassin: { name: "Assassino", color: "#a06ee0" },
  Ranger: { name: "Caçador", color: "#78c24e" },
  Sorcerer: { name: "Feiticeiro", color: "#45c8e0" },
  Elementalist: { name: "Elementalista", color: "#e0608f" },
  Cleric: { name: "Clérigo", color: "#ece3c4" },
  Chanter: { name: "Cantor", color: "#3fc49a" },
};

export const UNKNOWN_COLOR = "#8d99ab";

export const TARGETS: [DpsTarget, string][] = [["all", "All"], ["mob", "Mob"], ["boss", "Boss"]];
export const BARS: [DpsBars, string][] = [["damage", "Dano"], ["heal", "Cura"], ["both", "Dano e cura"]];

export interface Row {
  player: FightPlayer;
  damage: number;
  heal: number;
  /** What the row is sorted and measured by. */
  total: number;
  /** Per second in combat (on the bosses, for Boss); see `secondsFor`. */
  rate: number;
  share: number;
  color: string;
}

export const seconds = (f: Fight) => Math.max(1, (f.ended_ms - f.started_ms) / 1000);

/** The time on the bosses, from the first hit anyone landed on one to the
 *  last (at least a second), as the boss history counts it; null when the
 *  recording hit none or is from before bosses were kept. */
export function bossMs(f: Fight): number | null {
  const hit = (f.bosses ?? []).filter((b) => b.damage > 0);
  if (!hit.length) return null;
  return Math.max(1000, Math.max(...hit.map((b) => b.last_ms)) - Math.min(...hit.map((b) => b.first_ms)));
}

/** Stretches of a recording, [from, to] in seconds from the start. */
export type Windows = [number, number][];

/** When the group was fighting: the recording minus the stretches of 3 s
 *  or more nobody acted in (each player's `idle`). Recordings from before
 *  the timeline count whole. */
export function combatWindows(f: Fight): Windows {
  const secs = Math.max(1, (f.ended_ms - f.started_ms) / 1000);
  if (!f.players.some((p) => p.timeline.length)) return [[0, secs]];
  let calm: Windows = [[0, secs]];
  for (const p of f.players) {
    const idle = p.idle.map(([a, b]) => [a / 1000, b / 1000] as [number, number]);
    const both: Windows = [];
    for (const [a, b] of calm) for (const [c, d] of idle) {
      const [x, y] = [Math.max(a, c), Math.min(b, d)];
      if (y > x) both.push([x, y]);
    }
    calm = both;
  }
  calm = calm.filter(([a, b]) => b - a >= 3).sort((x, y) => x[0] - y[0]);
  const out: Windows = [];
  let from = 0;
  for (const [a, b] of calm) {
    if (a > from) out.push([from, a]);
    from = Math.max(from, b);
  }
  if (secs > from) out.push([from, secs]);
  return out;
}

/** The seconds the group was fighting (see `combatWindows`). */
export const combatSeconds = (f: Fight) => Math.max(1, combatWindows(f).reduce((n, [a, b]) => n + b - a, 0));

/** The seconds a target's numbers go per: the time on the bosses for Boss;
 *  the time the group was fighting otherwise, without the walks and waits
 *  between pulls. Either way, recordings of different stretches of the same
 *  play come out alike, whenever each one started or stopped. */
export function secondsFor(f: Fight, target: DpsTarget) {
  const boss = target === "boss" ? bossMs(f) : null;
  return boss ? boss / 1000 : combatSeconds(f);
}

/** The rows for a target and a kind of bar, biggest first. With `limit`,
 *  your own row stays in even when it would be cut. */
export function rows(f: Fight, target: DpsTarget, bars: DpsBars, limit = Infinity): Row[] {
  const secs = secondsFor(f, target);
  const all = f.players.map((p) => {
    const damage = target === "boss" ? p.boss_damage : target === "mob" ? p.mob_damage : p.boss_damage + p.mob_damage;
    const heal = p.heal;
    const total = bars === "damage" ? damage : bars === "heal" ? heal : damage + heal;
    return { player: p, damage, heal, total, rate: total / secs, share: 0, color: p.class ? CLASS[p.class].color : UNKNOWN_COLOR };
  }).filter((r) => r.total > 0).sort((a, b) => b.total - a.total);
  const sum = all.reduce((n, r) => n + r.total, 0);
  for (const r of all) r.share = sum ? r.total / sum : 0;
  if (all.length <= limit) return all;
  const shown = all.slice(0, limit);
  const me = all.find((r) => r.player.local);
  if (me && !shown.includes(me)) shown[limit - 1] = me;
  return shown;
}

/** 1.234, 12,3 mil, 1,23 mi. */
export function short(n: number) {
  if (n >= 1e6) return `${(n / 1e6).toLocaleString("pt-BR", { maximumFractionDigits: 2 })} mi`;
  if (n >= 1e4) return `${(n / 1e3).toLocaleString("pt-BR", { maximumFractionDigits: 1 })} mil`;
  return Math.round(n).toLocaleString("pt-BR");
}

/** 1:05, 12:00, 1:02:03. */
export function clock(ms: number) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  const two = (n: number) => String(n).padStart(2, "0");
  return h ? `${h}:${two(m)}:${two(sec)}` : `${m}:${two(sec)}`;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", ...kids: (Node | string)[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  e.append(...kids);
  return e;
}

/** A class's shield, or a plain dot when the class isn't known yet. */
export function shield(p: FightPlayer) {
  if (!p.class) return el("span", "shield none");
  const img = el("img", "shield");
  img.src = `/classes/${p.class}.png`;
  img.alt = CLASS[p.class].name;
  img.title = CLASS[p.class].name;
  return img;
}

/** Item level and combat power by name (any case), from the public profiles. */
const gear = new Map<string, Gear>();

/** Ask for the gear of the players on these rows. True when it changed what
 *  a bar shows, to draw them again. */
export async function loadGear(list: Row[]): Promise<boolean> {
  const names = list.map((r) => r.player.name);
  if (!names.length) return false;
  let changed = false;
  for (const g of await playerGear(names).catch(() => [] as Gear[])) {
    const key = g.name.toLowerCase(), was = gear.get(key);
    if (was?.item_level !== g.item_level || was?.combat_power !== g.combat_power) changed = true;
    gear.set(key, g);
  }
  return changed;
}

/** "GS 2.345 · CP 123,5 mil", or nothing while unknown. */
function gearTag(name: string) {
  const g = gear.get(name.toLowerCase());
  if (!g || (g.item_level == null && g.combat_power == null)) return "";
  const parts = [g.item_level != null ? `GS ${g.item_level.toLocaleString("pt-BR")}` : "", g.combat_power != null ? `CP ${short(g.combat_power)}` : ""];
  const tag = el("span", "dps-gear", parts.filter(Boolean).join(" · "));
  tag.title = [
    g.item_level != null ? `GS (nível de equipamento) ${g.item_level.toLocaleString("pt-BR")}` : "",
    g.combat_power != null ? `CP (poder de combate) ${g.combat_power.toLocaleString("pt-BR")}` : "",
  ].filter(Boolean).join(" · ") + " (perfil público, site oficial)";
  return tag;
}

/** A player's line: shield, name, the bar (stacked when both), and numbers. */
export function rowLine(r: Row, bars: DpsBars, top: number) {
  const track = el("span", "dps-track");
  const width = (n: number) => `${top ? (100 * n) / top : 0}%`;
  if (bars === "both") {
    const d = el("span", "dps-fill damage");
    d.style.width = width(r.damage);
    const h = el("span", "dps-fill heal");
    h.style.width = width(r.heal);
    track.append(d, h);
  } else {
    const f = el("span", `dps-fill ${bars}`);
    f.style.width = width(r.total);
    track.append(f);
  }
  const unit = bars === "heal" ? "/s cura" : "/s";
  const line = el("li", `dps-row${r.player.local ? " me" : ""}`,
    shield(r.player),
    el("span", "dps-who", el("span", "dps-name", r.player.name), gearTag(r.player.name)),
    el("span", "dps-num", `${short(r.total)} · ${short(r.rate)}${unit} · ${Math.round(r.share * 100)}%`),
    track);
  line.style.setProperty("--class", r.color);
  line.title = `${r.player.name}: ${short(r.damage)} de dano, ${short(r.heal)} de cura`;
  return line;
}
