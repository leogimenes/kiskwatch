// The reminder: shown at the top of the game's window only while an alarm
// rings (the app shows and hides the window), with when the thing starts.
// Each one is drawn once, when it rings, and goes when its time is up or on
// its ×; nothing redraws it in between, so it doesn't blink.
import { Accessibility, Alarm, getSaved, onAlarm, onStateChanged, reminderClose, reminderFit } from "./api";
import { t } from "./data";
import { applyLook, chime } from "./look";
import "./tourNote";

const alerts = document.querySelector("#alerts") as HTMLDivElement;
const SHOWN = 3;

type Ringing = Alarm & { until: number; el: HTMLDivElement };
let ringing: Ringing[] = [];
let look: Accessibility | null = null;

function lead(minutes: number) {
  return minutes === 60 ? "1 hora" : `${minutes} min`;
}

function clock(ms: number) {
  return new Date(ms).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
}

function card(a: Alarm): HTMLDivElement {
  const div = document.createElement("div");
  div.className = "alert";
  div.title = `Aviso de ${lead(a.lead)}`;
  div.innerHTML = `<span class="name"></span><span class="when"></span><button class="close" type="button" title="Fechar" aria-label="Fechar">×</button>`;
  (div.querySelector(".name") as HTMLElement).textContent = t(a.name);
  (div.querySelector(".when") as HTMLElement).textContent = a.lead > 0 ? `em ${lead(a.lead)} · ${clock(a.start_ms)}` : "agora";
  (div.querySelector(".close") as HTMLButtonElement).onclick = () => close(a.id);
  return div;
}

/** Put the ringing ones on the screen, touching only what changed. */
function render() {
  const shown = ringing.slice(0, SHOWN).map((r) => r.el);
  for (const el of [...alerts.children]) if (!shown.includes(el as HTMLDivElement)) el.remove();
  shown.forEach((el, i) => {
    if (alerts.children[i] !== el) alerts.insertBefore(el, alerts.children[i] ?? null);
  });
  fit();
}

/** The window as big as the reminders, so it takes no clicks around them;
 *  the whole of it while the tour's note is on it. */
function fit() {
  const tour = document.querySelector(".tour-note") !== null;
  if (!tour && ringing.length === 0) return;
  // On the screen, the look's zoom included.
  const box = alerts.getBoundingClientRect();
  const size = tour ? null : { width: Math.ceil(box.width), height: Math.ceil(box.height) };
  reminderFit(size).catch(() => {});
}

function expire() {
  const now = Date.now();
  // By time, not timeouts: a hidden window's timers can run late.
  if (!ringing.some((a) => a.until <= now)) return;
  ringing = ringing.filter((a) => a.until > now);
  render();
}

function close(id: string) {
  ringing = ringing.filter((r) => r.id !== id);
  render();
  if (ringing.length === 0) reminderClose().catch(() => {});
}

function ring(a: Alarm) {
  const until = Date.now() + (look?.alert_seconds ?? 60) * 1000;
  ringing = [{ ...a, until, el: card(a) }, ...ringing.filter((r) => r.id !== a.id)];
  render();
  if (look) chime(look);
}

async function refresh() {
  look = (await getSaved()).settings.a11y;
  applyLook(look);
}

onAlarm(ring);
onStateChanged(refresh);
// The tour's note comes and goes: the window grows for it, and back.
new MutationObserver(fit).observe(document.body, { childList: true });
refresh();
setInterval(expire, 1000);
