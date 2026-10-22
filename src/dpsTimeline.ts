// The fight's timeline in the panel's DPS tab: each player's damage second by
// second, with the stretches they stood without hitting marked under it.
import { Fight, FightPlayer } from "./api";
import { CLASS, UNKNOWN_COLOR, clock, shield, short } from "./dpsView";

/** At most this many bars a strip, so long fights stay readable. */
const BARS = 240;
const SVG = "http://www.w3.org/2000/svg";

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", ...kids: (Node | string)[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  e.append(...kids);
  return e;
}

function svg(tag: string, attrs: Record<string, string | number>) {
  const e = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  return e;
}

/** Damage per bar, `step` seconds each. */
function bucket(timeline: number[], step: number) {
  const out: number[] = [];
  for (let i = 0; i < timeline.length; i += step) out.push(timeline.slice(i, i + step).reduce((n, v) => n + v, 0) / step);
  return out;
}

const secs = (ms: number) => `${Math.round(ms / 1000)} s`;

function strip(p: FightPlayer, step: number, top: number, readout: HTMLElement) {
  const bars = bucket(p.timeline, step);
  const color = p.class ? CLASS[p.class].color : UNKNOWN_COLOR;
  const box = svg("svg", { class: "tl-strip", viewBox: `0 0 ${bars.length} 100`, preserveAspectRatio: "none", role: "img" });
  box.setAttribute("aria-label", `Linha do tempo de ${p.name}`);
  for (const [from, to] of p.idle) {
    box.append(svg("rect", { class: "tl-idle", x: from / 1000 / step, y: 0, width: (to - from) / 1000 / step, height: 100 }));
  }
  bars.forEach((v, i) => {
    if (!v) return;
    const h = Math.max(2, (100 * v) / top);
    box.append(svg("rect", { x: i + 0.1, y: 100 - h, width: 0.8, height: h, fill: color }));
  });
  box.addEventListener("mousemove", (e) => {
    const r = box.getBoundingClientRect();
    const i = Math.min(bars.length - 1, Math.max(0, Math.floor(((e.clientX - r.left) / r.width) * bars.length)));
    const ms = i * step * 1000;
    const still = p.idle.some(([a, b]) => ms + step * 500 >= a && ms + step * 500 < b);
    readout.textContent = `${clock(ms)} · ${short(bars[i])}/s${still ? " · parado" : ""}`;
  });
  box.addEventListener("mouseleave", () => { readout.textContent = ""; });
  return box;
}

function line(p: FightPlayer, f: Fight, step: number, top: number) {
  const length = Math.max(1, f.ended_ms - f.started_ms);
  const readout = el("span", "tl-readout");
  const pauses = [...p.idle].sort((a, b) => (b[1] - b[0]) - (a[1] - a[0])).slice(0, 3)
    .map(([a, b]) => `${clock(a)} (${secs(b - a)})`).join(", ");
  const row = el("li", `tl-row${p.local ? " me" : ""}`,
    shield(p),
    el("span", "dps-name", p.name),
    el("span", "dps-num", `parado ${secs(p.idle_ms)} · ${Math.round((100 * p.idle_ms) / length)}%`),
    strip(p, step, top, readout),
    el("span", "tl-pauses hint", pauses ? `Maiores pausas: ${pauses}` : "Sem pausas de 3 s ou mais."),
    readout);
  row.style.setProperty("--class", p.class ? CLASS[p.class].color : UNKNOWN_COLOR);
  return row;
}

function axis(f: Fight) {
  const length = f.ended_ms - f.started_ms;
  return el("div", "tl-axis", ...[0, 0.25, 0.5, 0.75, 1].map((x) => el("span", "", clock(x * length))));
}

/** The timeline section for a recording, players as `order` lists them. */
export function timeline(f: Fight, order: FightPlayer[]) {
  const players = order.filter((p) => p.timeline?.length);
  const head = el("h3", "", "Linha do tempo");
  if (!players.length) return el("section", "dps-timeline", head, el("p", "hint", "Esta gravação é de antes da linha do tempo."));
  const length = Math.max(...players.map((p) => p.timeline.length));
  const step = Math.ceil(length / BARS);
  const top = Math.max(1, ...players.flatMap((p) => bucket(p.timeline, step)));
  return el("section", "dps-timeline", head,
    el("p", "hint", `Dano por segundo${step > 1 ? ` (média de ${step} s por barra)` : ""}. Em vermelho, 3 s ou mais sem um golpe ou cura sua; invocações e dano contínuo não contam.`),
    el("ol", "tl-rows", ...players.map((p) => line(p, f, step, top))),
    axis(f));
}
