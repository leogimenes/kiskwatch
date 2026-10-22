// The help window: one topic at a time (a panel tab or the overlays), with
// the others on the side. The panel's "?" and the overlays' pick the topic.
import { getSaved, onHelpTopic, onStateChanged, openTour, openUrl } from "./api";
import { TOPICS, topic } from "./helpTopics";
import { applyLook } from "./look";
import { markdown } from "./markdown";

const nav = document.querySelector("#help-topics") as HTMLElement;
const text = document.querySelector("#help-text") as HTMLElement;
const tour = document.querySelector("#help-tour") as HTMLButtonElement;
let shown = topic(location.hash.slice(1)).id;

function render() {
  const t = topic(shown);
  document.title = `Kiskwatch ajuda: ${t.title}`;
  nav.replaceChildren(...TOPICS.map((x) => {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = x.title;
    b.setAttribute("aria-current", String(x.id === t.id));
    b.addEventListener("click", () => show(x.id));
    return b;
  }));
  text.innerHTML = markdown(t.text);
  text.scrollTop = 0;
  // The overlays have no tour of their own: theirs is in the Configurações tab's.
  tour.hidden = t.id === "overlays";
}

function show(id: string) {
  shown = topic(id).id;
  history.replaceState(null, "", `#${shown}`);
  render();
}

tour.addEventListener("click", () => openTour(shown));
onHelpTopic(show);
async function look() { applyLook((await getSaved()).settings.a11y); }
onStateChanged(look);
look();
// Links open in the browser.
text.addEventListener("click", (e) => {
  const a = (e.target as HTMLElement).closest("a[href^='http']") as HTMLAnchorElement | null;
  if (!a) return;
  e.preventDefault();
  openUrl(a.href);
});
render();
