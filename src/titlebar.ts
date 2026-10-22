// The panel's own title bar, in place of the system frame: dragging it moves
// the window, a double click maximizes, and the buttons on the right do what
// the system ones did. Closing still quits the app (see `CloseRequested`).
import { getCurrentWindow } from "@tauri-apps/api/window";

const win = getCurrentWindow();
const bar = document.querySelector("#titlebar") as HTMLElement;
const max = document.querySelector("#win-max") as HTMLButtonElement;

async function showMaximized() {
  const on = await win.isMaximized();
  bar.classList.toggle("maximized", on);
  max.title = max.ariaLabel = on ? "Restaurar" : "Maximizar";
}

document.querySelector("#win-min")!.addEventListener("click", () => win.minimize());
max.addEventListener("click", () => win.toggleMaximize());
document.querySelector("#win-close")!.addEventListener("click", () => win.close());

showMaximized();
win.onResized(showMaximized);
win.onFocusChanged(({ payload }) => bar.classList.toggle("blurred", !payload));
