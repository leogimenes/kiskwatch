// The gear on an overlay's bar brings the panel up on that overlay's settings.
import { openSettings } from "./api";
import "./gear.css";

document.querySelectorAll<HTMLButtonElement>(".gear").forEach((b) =>
  b.addEventListener("click", () => openSettings(b.dataset.overlay as "pets" | "dps")),
);
