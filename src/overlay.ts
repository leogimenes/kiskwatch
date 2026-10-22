// The reminder: shown at the top of the game's window only while an alarm
// rings (the app shows and hides the window), with the time left to the start.
import { Accessibility, Alarm, countdown, getSaved, onAlarm, onStateChanged } from "./api";
import { t } from "./data";
import { applyLook, chime } from "./look";

const alerts = document.querySelector("#alerts") as HTMLDivElement;
const SHOWN = 3;

type Ringing = Alarm & { until: number };
let ringing: Ringing[] = [];
let look: Accessibility | null = null;

function lead(minutes: number) {
  return minutes === 60 ? "1 hora" : `${minutes} min`;
}

function render() {
  const now = Date.now();
  // By time, not timeouts: a hidden window's timers can run late.
  ringing = ringing.filter((a) => a.until > now);
  alerts.replaceChildren(
    ...ringing.slice(0, SHOWN).map((a) => {
      const div = document.createElement("div");
      div.className = "alert";
      div.innerHTML = `<span class="name"></span><span class="when"></span>`;
      (div.firstChild as HTMLElement).textContent = t(a.name);
      (div.lastChild as HTMLElement).textContent = a.start_ms > now ? `em ${countdown(a.start_ms - now)}` : "agora";
      div.title = `Aviso de ${lead(a.lead)}`;
      return div;
    }),
  );
}

function ring(a: Alarm) {
  const until = Date.now() + (look?.alert_seconds ?? 60) * 1000;
  ringing = [{ ...a, until }, ...ringing.filter((r) => r.id !== a.id)];
  render();
  if (look) chime(look);
}

async function refresh() {
  look = (await getSaved()).settings.a11y;
  applyLook(look);
}

onAlarm(ring);
onStateChanged(refresh);
refresh();
setInterval(render, 1000);
