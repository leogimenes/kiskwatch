// Updates: a badge in the header when a newer release is out, and the
// Version section of the settings to install it.
import { UpdateStatus, onUpdateChanged, updateCheck, updateInstall, updateStatus } from "./api";

const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T;
const badge = $<HTMLButtonElement>("#update-badge");
const text = $("#update-text");
const install = $<HTMLButtonElement>("#update-install");
const check = $<HTMLButtonElement>("#update-check");
const notes = $<HTMLAnchorElement>("#update-notes");
const error = $("#update-error");

function mb(bytes: number | null) {
  return bytes ? ` (${(bytes / 1048576).toFixed(1)} MB)` : "";
}

function render(st: UpdateStatus) {
  const next = st.available;
  badge.hidden = !next;
  badge.textContent = next ? `Nova versão ${next.version}` : "";
  const checked = st.checked_ms ? ` Última busca: ${new Date(st.checked_ms).toLocaleString("pt-BR")}.` : "";
  text.textContent = st.installing
    ? `Baixando e conferindo a versão ${next?.version}…`
    : next
      ? `Você usa a versão ${st.current}. A versão ${next.version} está disponível${mb(next.installer.size)}.`
      : `Você usa a versão ${st.current}, a mais recente.${checked}`;
  install.hidden = !next;
  install.disabled = st.installing;
  check.disabled = st.installing;
  notes.hidden = !next?.notes_url;
  notes.href = next?.notes_url ?? "";
  error.hidden = !st.error;
  error.textContent = st.error ? `Atualização: ${st.error}` : "";
}

const refresh = () => updateStatus().then(render);

badge.addEventListener("click", () => {
  document.querySelector<HTMLButtonElement>(".tabs button[data-tab='config']")?.click();
  $("#update-title").scrollIntoView({ behavior: "smooth", block: "start" });
});
check.addEventListener("click", async () => {
  check.disabled = true;
  text.textContent = "Procurando…";
  render(await updateCheck());
});
install.addEventListener("click", () => updateInstall().catch(refresh));

onUpdateChanged(refresh);
refresh();
