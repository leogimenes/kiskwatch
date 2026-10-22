// The gear on an overlay's bar brings the panel up on that overlay's settings;
// the "?" beside it opens the help on the overlays.
import { openHelp, openSettings } from "./api";
import "./gear.css";

document.querySelectorAll<HTMLButtonElement>(".gear[data-overlay]").forEach((b) =>
  b.addEventListener("click", () => openSettings(b.dataset.overlay as "pets" | "dps")),
);
document.querySelectorAll<HTMLButtonElement>(".gear[data-help]").forEach((b) =>
  b.addEventListener("click", () => openHelp(b.dataset.help!)),
);
