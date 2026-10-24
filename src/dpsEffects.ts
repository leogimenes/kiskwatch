// The DPS tab's buffs and debuffs: for one player, or the main target, how
// long each one stayed on over the recording.
import abnormalsJson from "../data/abnormals.json";
import { sharedName } from "./sharedNames";
import { Fight, Uptime } from "./api";
import { iconUrl } from "./buildData";
import { clock, seconds } from "./dpsView";

const ABNORMALS: Record<string, string[]> = abnormalsJson;
const TARGET = -1;

/** Whose effects show: a player's id, or TARGET. Kept between recordings. */
let whose: number | null = null;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", ...kids: (Node | string)[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  e.append(...kids);
  return e;
}

function icon(u: Uptime) {
  const name = ABNORMALS[u.abnormal]?.[1];
  if (!name) return el("span", "fx-icon none");
  const img = el("img", "fx-icon");
  img.src = iconUrl(name);
  img.alt = "";
  img.loading = "lazy";
  img.addEventListener("error", () => img.replaceWith(el("span", "fx-icon none")), { once: true });
  return img;
}

function line(u: Uptime, f: Fight, from: string | null) {
  const share = Math.min(1, u.uptime_ms / 1000 / seconds(f));
  const pct = Math.round(share * 100);
  const name = ABNORMALS[u.abnormal]?.[0] || sharedName("effects", u.abnormal) || `Efeito ${u.abnormal}`;
  const fill = el("span", "fx-fill");
  fill.style.width = `${share * 100}%`;
  const extra = [u.applied ? `${u.applied}×` : "", u.stacks > 1 ? `até ${u.stacks} acúmulos` : ""].filter(Boolean).join(" · ");
  const row = el("li", "fx-row",
    icon(u),
    el("span", "fx-name", name, from ? el("span", "hint", ` · de ${from}`) : ""),
    el("span", "fx-num", `${pct}%`, extra ? el("span", "hint", ` · ${extra}`) : ""),
    el("span", "fx-track", fill));
  row.title = `${name}: ${clock(u.uptime_ms)} de ${clock(f.ended_ms - f.started_ms)} (${pct}%)${u.applied ? `, aplicado ${u.applied} vez(es)` : ""}`;
  return row;
}

function group(title: string, list: HTMLElement[], cls: string) {
  return list.length ? el("div", `fx-group ${cls}`, el("h4", "", title), el("ol", "fx-rows", ...list)) : null;
}

/** The section for a recording's detail; `redraw` after a pick. */
export function effectsSection(f: Fight, redraw: () => void) {
  const fx = f.effects;
  const box = el("section", "fx", el("h3", "", "Buffs e debuffs"));
  if (!fx || !fx.list.length) {
    box.append(el("p", "hint", fx ? "Nenhum buff ou debuff com duração durante esta gravação." : "Esta gravação é de antes do Kiskwatch ler buffs e debuffs."));
    return box;
  }
  const players = new Map(f.players.map((p) => [p.id, p]));
  const who = (id: number) => players.get(id)?.name ?? null;
  const options: [number, string][] = f.players.filter((p) => fx.list.some((u) => u.entity === p.id)).map((p) => [p.id, p.local ? `${p.name} (você)` : p.name]);
  if (fx.target != null && fx.list.some((u) => u.entity === fx.target)) options.push([TARGET, fx.target_boss ? "Chefe" : "Alvo principal"]);
  if (!options.some(([id]) => id === whose)) whose = (f.players.find((p) => p.local && options.some(([id]) => id === p.id)) ?? null)?.id ?? options[0]?.[0] ?? null;

  const picker = el("div", "chip-group");
  picker.setAttribute("role", "group");
  for (const [id, label] of options) {
    const b = el("button", "", label);
    b.type = "button";
    b.setAttribute("aria-pressed", String(id === whose));
    b.addEventListener("click", () => { whose = id; redraw(); });
    picker.append(b);
  }
  const entity = whose === TARGET ? fx.target : whose;
  const mine = fx.list.filter((u) => u.entity === entity);
  const byPlayer = mine.filter((u) => players.has(u.caster));
  const byOthers = mine.filter((u) => !players.has(u.caster));
  const from = (u: Uptime) => (u.caster === entity ? null : who(u.caster));
  const groups = whose === TARGET
    ? [group("Debuffs do grupo", byPlayer.map((u) => line(u, f, who(u.caster))), "debuff"), group("Buffs do alvo", byOthers.map((u) => line(u, f, null)), "buff")]
    : [group("Buffs", byPlayer.map((u) => line(u, f, from(u))), "buff"), group("Debuffs recebidos", byOthers.map((u) => line(u, f, null)), "debuff")];
  box.append(picker, ...groups.filter((g): g is HTMLDivElement => !!g),
    el("p", "hint", "Tempo com o efeito ativo sobre a duração da gravação. Passivas e efeitos sem fim ficam de fora; buffs já ativos quando o Kiskwatch abriu só aparecem depois de renovados."));
  return box;
}
