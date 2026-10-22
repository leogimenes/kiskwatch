// A short note on an overlay, for what a global shortcut just did: with the
// game in front, it's the only sign the key worked.
import { onToast } from "./api";

const SHOWN_MS = 2500;

onToast((text) => {
  const div = document.createElement("div");
  div.className = "toast";
  div.setAttribute("role", "status");
  div.textContent = text;
  document.querySelector(".toast")?.remove();
  document.body.append(div);
  setTimeout(() => div.remove(), SHOWN_MS);
});
