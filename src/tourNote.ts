// The panel's guided tour, on an overlay: a note saying what this overlay is,
// for as long as the tour is on its step (the app shows the window meanwhile).
import { onTourNote } from "./api";

onTourNote((note) => {
  document.querySelector(".tour-note")?.remove();
  if (!note) return;
  const div = document.createElement("div");
  div.className = "tour-note";
  div.setAttribute("role", "status");
  div.textContent = note;
  document.body.append(div);
});
