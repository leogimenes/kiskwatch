// The overlay: the next timers with an alarm on, and the alarms as they ring.
import { Accessibility, Alarm, TimerRow, countdown, getSaved, getTimers, onAlarm, onStateChanged } from "./api";
import { t } from "./data";
import { applyLook, chime } from "./look";

const next = document.querySelector("#next") as HTMLUListElement;
const alerts = document.querySelector("#alerts") as HTMLDivElement;
const SHOWN = 6;

let rows: TimerRow[] = [];
let look: Accessibility | null = null;

function render() {
  const now = Date.now();
  const watched = rows.filter((r) => r.leads.length).slice(0, SHOWN);
  next.replaceChildren(
    ...watched.map((r) => {
      const li = document.createElement("li");
      const when = r.up ? "vivo" : r.start_ms == null ? "abra o mapa" : r.start_ms <= now ? "agora" : countdown(r.start_ms - now);
      li.innerHTML = `<span class="name"></span><span class="when"></span>`;
      (li.firstChild as HTMLElement).textContent = t(r.name);
      (li.lastChild as HTMLElement).textContent = when;
      return li;
    }),
  );
  if (!watched.length) next.innerHTML = `<li class="empty">Ative avisos no painel</li>`;
}

function ring(a: Alarm) {
  const div = document.createElement("div");
  div.className = "alert";
  div.textContent = `${t(a.name)} em ${a.lead === 60 ? "1 hora" : `${a.lead} min`}`;
  alerts.prepend(div);
  setTimeout(() => div.remove(), (look?.alert_seconds ?? 60) * 1000);
  if (look) chime(look);
}

async function refresh() {
  const [timers, saved] = await Promise.all([getTimers(), getSaved()]);
  rows = timers;
  look = saved.settings.a11y;
  applyLook(look);
  render();
}

onAlarm(ring);
onStateChanged(refresh);
refresh();
setInterval(render, 1000);
setInterval(refresh, 30_000);
