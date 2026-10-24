// The DPS overlay: the recording under way (or the last one), up to six
// players, with a button to start and stop and a name to change.
import { DpsBars, DpsTarget, Fight, Saved, dpsClear, dpsLive, dpsRename, dpsStart, dpsStop, getSaved, onDpsChanged, onGearChanged, onStateChanged, setSettings } from "./api";
import { BARS, TARGETS, bossName, bossNow, clock, loadGear, rowLine, rows } from "./dpsView";
import "./toast";
import "./tourNote";
import "./gear";
import { applyLook } from "./look";

const SHOWN = 6;

let saved: Saved | null = null;
let live: Fight | null = null;

const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T;

function chips<T extends string>(box: HTMLElement, options: [T, string][], current: T, pick: (v: T) => void) {
  box.replaceChildren(...options.map(([value, label]) => {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = label;
    b.setAttribute("aria-pressed", String(value === current));
    b.addEventListener("click", () => pick(value));
    return b;
  }));
}

async function pickSetting(change: { target?: DpsTarget; bars?: DpsBars }) {
  if (!saved) return;
  saved.settings.dps = { ...saved.settings.dps, ...change };
  render();
  await setSettings(saved.settings);
}

function render() {
  if (!saved) return;
  const s = saved.settings.dps;
  // The last saved one, unless it was cleared away.
  const last = saved.fights[0];
  const fight = live ?? (last && last.ended_ms > (saved.dps_cleared_ms ?? 0) ? last : null);
  const status = $("#dps-status");
  status.classList.toggle("rec", !!live);
  status.textContent = live ? clock(Date.now() - live.started_ms)
    : s.start === "hit" ? "começa no primeiro golpe" : "parado";
  const toggle = $<HTMLButtonElement>("#dps-toggle");
  toggle.textContent = live ? "Parar" : "Gravar";
  toggle.classList.toggle("rec", !!live);
  const name = $<HTMLInputElement>("#dps-name");
  name.disabled = !live;
  // Not while the user is typing in it.
  if (document.activeElement !== name) name.value = fight?.name ?? "";
  chips($("#dps-target"), TARGETS, s.target, (target) => pickSetting({ target }));
  chips($("#dps-bars"), BARS, s.bars, (bars) => pickSetting({ bars }));
  renderBoss(fight);
  const list = fight ? rows(fight, s.target, s.bars, SHOWN) : [];
  const top = list.reduce((n, r) => Math.max(n, r.total), 0);
  $("#dps-rows").replaceChildren(...(list.length ? list.map((r) => rowLine(r, s.bars, top))
    : [Object.assign(document.createElement("li"), { className: "empty", textContent: live ? "Ninguém causou dano ainda." : "Nenhuma gravação ainda." })]));
  loadGear(list).then((changed) => { if (changed) render(); });
}

/** The boss being fought: its HP, and the time left to its enrage. */
function renderBoss(fight: Fight | null) {
  const box = $("#dps-boss");
  const b = fight && bossNow(fight);
  box.hidden = !b;
  if (!b) return;
  const left = b.hp! / Math.max(1, b.max_hp!);
  const fill = document.createElement("span");
  fill.className = "dps-hp-fill";
  fill.style.width = `${Math.min(100, left * 100)}%`;
  const label = document.createElement("span");
  label.className = "dps-hp-label";
  label.textContent = `${bossName(b.code)} · ${(left * 100).toLocaleString("pt-BR", { maximumFractionDigits: 1 })}%`;
  const parts: Node[] = [fill, label];
  if (b.in_combat && b.enrage_ms) {
    const rage = document.createElement("span");
    const ms = b.enrage_ms - Date.now();
    rage.className = `dps-enrage${ms < 60_000 ? " soon" : ""}`;
    rage.textContent = ms > 0 ? `Fúria em ${clock(ms)}` : "Fúria!";
    rage.title = "Quando o chefe entra em fúria, pelo relógio do servidor";
    parts.push(rage);
  }
  box.replaceChildren(...parts);
}

async function poll() {
  live = await dpsLive();
  render();
}

async function refresh() {
  saved = await getSaved();
  applyLook(saved.settings.a11y);
  await poll();
}

$("#dps-toggle").addEventListener("click", async () => {
  if (live) await dpsStop(); else await dpsStart();
  await poll();
});

$("#dps-clear").addEventListener("click", async () => {
  await dpsClear();
  await refresh();
});

const name = $<HTMLInputElement>("#dps-name");
name.addEventListener("change", () => { if (live && name.value.trim()) dpsRename(null, name.value); });
name.addEventListener("keydown", (e) => { if (e.key === "Enter") name.blur(); });

onStateChanged(refresh);
onDpsChanged(refresh);
onGearChanged(render);
refresh();
// The clock and the numbers, while recording.
setInterval(() => { if (live) poll(); }, 1000);
