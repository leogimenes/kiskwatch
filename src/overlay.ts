// The overlay: the next timers with an alarm on, and the alarms as they ring.
import { Alarm, TimerRow, countdown, getTimers, onAlarm, onStateChanged } from "./api";
import { t } from "./data";

const next = document.querySelector("#next") as HTMLUListElement;
const alerts = document.querySelector("#alerts") as HTMLDivElement;
const ALERT_MS = 60_000;
const SHOWN = 6;

let rows: TimerRow[] = [];

function render() {
  const now = Date.now();
  const watched = rows.filter((r) => r.leads.length && (r.start_ms != null || r.up)).slice(0, SHOWN);
  next.replaceChildren(
    ...watched.map((r) => {
      const li = document.createElement("li");
      const when = r.up ? "vivo" : r.start_ms! <= now ? "agora" : countdown(r.start_ms! - now);
      li.innerHTML = `<span class="name"></span><span class="when"></span>`;
      (li.firstChild as HTMLElement).textContent = t(r.name);
      (li.lastChild as HTMLElement).textContent = when;
      return li;
    }),
  );
  if (!watched.length) next.innerHTML = `<li class="empty">Ative avisos no painel</li>`;
}

/** A short two-tone chime, so no sound file has to ship. */
function chime() {
  const ctx = new AudioContext();
  [880, 1320].forEach((f, i) => {
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.frequency.value = f;
    g.gain.setValueAtTime(0.0001, ctx.currentTime + i * 0.18);
    g.gain.exponentialRampToValueAtTime(0.25, ctx.currentTime + i * 0.18 + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + i * 0.18 + 0.5);
    o.connect(g).connect(ctx.destination);
    o.start(ctx.currentTime + i * 0.18);
    o.stop(ctx.currentTime + i * 0.18 + 0.55);
  });
}

function ring(a: Alarm) {
  const div = document.createElement("div");
  div.className = "alert";
  div.textContent = `${t(a.name)} em ${a.lead === 60 ? "1 hora" : `${a.lead} min`}`;
  alerts.prepend(div);
  setTimeout(() => div.remove(), ALERT_MS);
  chime();
}

async function refresh() {
  rows = await getTimers();
  render();
}

onAlarm(ring);
onStateChanged(refresh);
refresh();
setInterval(render, 1000);
setInterval(refresh, 30_000);
