// The panel's Checklist tab: daily and weekly tasks per character, ticked off
// here and counted again from zero after each reset.
import {
  ChecklistCharacter, ChecklistTask, ChecklistView, Period, checklistEdit, checklistMark, countdown, getChecklist, onChecklistChanged,
} from "./api";

const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T;
function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, unknown> = {}, ...kids: (Node | string)[]): HTMLElementTagNameMap[K] {
  const e = Object.assign(document.createElement(tag), props);
  e.append(...kids);
  return e;
}

const DAY = 86_400_000;
const PERIODS: [Period, string, string][] = [["daily", "Diárias", "Diária"], ["weekly", "Semanais", "Semanal"]];
const MAX_NAME = 50;

let view: ChecklistView | null = null;
/** The tasks and characters being edited, until saved or dropped. */
let draft: { tasks: ChecklistTask[]; characters: ChecklistCharacter[] } | null = null;
let fetching = false;

const newId = () => crypto.randomUUID();
const nextReset = (period: Period) => (period === "daily" ? view!.resets.daily_ms + DAY : view!.resets.weekly_ms + 7 * DAY);
const count = (c: string, t: string) => view?.counts[c]?.[t] ?? 0;

/** Fetch the checklist and draw it. */
export async function renderChecklist() {
  view = await getChecklist();
  // A redraw while editing would take the focus out of the field being typed in.
  if (draft) tickResets();
  else draw();
}

function draw() {
  if (!view) return;
  $("#check-edit").textContent = draft ? "Cancelar" : "Editar";
  tickResets();
  $("#checklist").replaceChildren(draft ? editor() : board());
}

function tickResets() {
  if (!view) return;
  const now = Date.now();
  // A reset just came: what was ticked before it no longer counts.
  if (now >= nextReset("daily") && view.resets.daily_ms > 0) {
    if (!fetching) {
      fetching = true;
      renderChecklist().finally(() => { fetching = false; });
    }
    return;
  }
  $("#check-resets").replaceChildren(
    ...PERIODS.map(([p, label]) => el("span", {}, `${label} zeram em `, el("strong", { className: "countdown" }, countdown(nextReset(p) - now)))),
  );
}

function board(): Node {
  const v = view!;
  if (v.characters.length === 0) {
    const add = el("button", { type: "button", textContent: "Adicionar personagens" });
    add.addEventListener("click", startEdit);
    return el("div", { className: "check-empty" },
      el("p", { className: "hint" }, "Marque aqui o que cada personagem já fez hoje e nesta semana. As marcas somem sozinhas no reset diário e no semanal."),
      add);
  }
  const head = el("tr", {}, el("th", {}, "Tarefa"), ...v.characters.map((c) => {
    const own = v.tasks.filter((t) => !c.skip.includes(t.id));
    const done = own.filter((t) => count(c.id, t.id) >= t.times).length;
    return el("th", { className: "check-col" }, el("strong", {}, c.name), el("span", { className: done === own.length ? "check-all" : "hint" }, ` ${done}/${own.length}`));
  }));
  const body = el("tbody");
  for (const [period, label] of PERIODS) {
    const tasks = v.tasks.filter((t) => t.period === period);
    if (tasks.length === 0) continue;
    body.append(el("tr", { className: "check-group" }, el("th", { colSpan: v.characters.length + 1, scope: "rowgroup" }, label)));
    for (const t of tasks) {
      body.append(el("tr", {}, el("td", {}, t.name, t.times > 1 ? el("span", { className: "hint" }, ` ×${t.times}`) : ""),
        ...v.characters.map((c) => el("td", { className: "check-col" }, cell(c, t)))));
    }
  }
  return el("div", {},
    el("table", { className: "list checklist" }, el("thead", {}, head), body),
    el("p", { className: "hint" }, "Clique para marcar. Nas tarefas com mais de uma vez, cada clique soma uma; clique com o botão direito para tirar uma."));
}

function cell(c: ChecklistCharacter, t: ChecklistTask): Node {
  if (c.skip.includes(t.id)) return el("span", { className: "hint", title: `${c.name} não faz esta tarefa` }, "—");
  const n = count(c.id, t.id);
  const done = n >= t.times;
  const b = el("button", {
    type: "button",
    className: done ? "tick done" : n > 0 ? "tick part" : "tick",
    textContent: t.times > 1 ? `${n}/${t.times}` : done ? "✓" : "",
    ariaLabel: `${c.name}: ${t.name}, ${t.times > 1 ? `${n} de ${t.times}` : done ? "feito" : "não feito"}`,
  });
  b.setAttribute("aria-pressed", String(done));
  const set = async (next: number) => {
    view!.counts[c.id] = { ...view!.counts[c.id], [t.id]: next };
    draw();
    await checklistMark(c.id, t.id, next);
  };
  // Past the last time it goes back to zero, so one button both ticks and unticks.
  b.addEventListener("click", () => set(n >= t.times ? 0 : n + 1));
  b.addEventListener("contextmenu", (e) => { e.preventDefault(); if (n > 0) set(n - 1); });
  return b;
}

// ---- Editing ----
function startEdit() {
  draft = structuredClone({ tasks: view!.tasks, characters: view!.characters });
  draw();
}

$("#check-edit").addEventListener("click", () => {
  if (draft) draft = null;
  else startEdit();
  draw();
});

function editor(): Node {
  const d = draft!;
  // Characters: a name each, and one to add.
  const names = el("ul", { className: "check-chars" }, ...d.characters.map((c, i) => {
    const name = el("input", { value: c.name, maxLength: MAX_NAME, ariaLabel: "Nome do personagem" });
    name.addEventListener("input", () => { c.name = name.value; });
    const del = el("button", { type: "button", textContent: "✕", ariaLabel: `Remover ${c.name}` });
    del.addEventListener("click", () => { d.characters.splice(i, 1); draw(); });
    return el("li", {}, name, del);
  }));
  const known = el("datalist", { id: "check-known" }, ...view!.known.map((n) => el("option", { value: n })));
  const newName = el("input", { placeholder: "Novo personagem", maxLength: MAX_NAME, ariaLabel: "Novo personagem" });
  newName.setAttribute("list", "check-known");
  const add = el("form", { className: "filters" }, newName, known, el("button", { type: "submit", textContent: "Adicionar" }));
  add.addEventListener("submit", (e) => {
    e.preventDefault();
    const name = newName.value.trim();
    if (!name) return;
    d.characters.push({ id: newId(), name, skip: [] });
    draw();
    ($("#checklist input[aria-label='Novo personagem']") as HTMLInputElement | null)?.focus();
  });

  // Tasks: name, period, times, order, and who does each.
  const head = el("tr", {}, el("th", {}, "Tarefa"), el("th", {}, "Reset"), el("th", {}, "Vezes"), el("th", {}, el("span", { className: "sr" }, "Ordem")),
    ...d.characters.map((c) => el("th", { className: "check-col" }, c.name || "?")));
  const rows = d.tasks.map((t, i) => {
    const name = el("input", { value: t.name, maxLength: MAX_NAME, ariaLabel: "Nome da tarefa" });
    name.addEventListener("input", () => { t.name = name.value; });
    const period = el("select", { ariaLabel: "Reset" }, ...PERIODS.map(([p, , one]) => el("option", { value: p, textContent: one, selected: p === t.period })));
    period.addEventListener("change", () => { t.period = period.value as Period; });
    const times = el("input", { type: "number", min: "1", max: "99", value: String(t.times), className: "points", ariaLabel: "Vezes por reset" });
    times.addEventListener("input", () => { t.times = Math.min(99, Math.max(1, Number(times.value) || 1)); });
    const move = (by: number) => {
      const b = el("button", { type: "button", textContent: by < 0 ? "↑" : "↓", ariaLabel: by < 0 ? "Subir" : "Descer", disabled: !d.tasks[i + by] });
      b.addEventListener("click", () => { [d.tasks[i], d.tasks[i + by]] = [d.tasks[i + by], d.tasks[i]]; draw(); });
      return b;
    };
    const del = el("button", { type: "button", textContent: "✕", ariaLabel: `Remover ${t.name}` });
    del.addEventListener("click", () => { d.tasks.splice(i, 1); draw(); });
    return el("tr", {}, el("td", {}, name), el("td", {}, period), el("td", {}, times), el("td", { className: "check-order" }, move(-1), move(1), del),
      ...d.characters.map((c) => {
        const does = el("input", { type: "checkbox", checked: !c.skip.includes(t.id), ariaLabel: `${c.name || "?"} faz ${t.name}` });
        does.addEventListener("change", () => { c.skip = does.checked ? c.skip.filter((s) => s !== t.id) : [...c.skip, t.id]; });
        return el("td", { className: "check-col" }, does);
      }));
  });
  const addTask = el("button", { type: "button", textContent: "Nova tarefa" });
  addTask.addEventListener("click", () => {
    d.tasks.push({ id: newId(), name: "", period: "daily", times: 1 });
    draw();
    const inputs = document.querySelectorAll<HTMLInputElement>("#checklist input[aria-label='Nome da tarefa']");
    inputs[inputs.length - 1]?.focus();
  });
  const saveButton = el("button", { type: "button", textContent: "Salvar", className: "primary" });
  saveButton.addEventListener("click", async () => {
    const tasks = d.tasks.filter((t) => t.name.trim());
    const characters = d.characters.filter((c) => c.name.trim());
    draft = null;
    await checklistEdit(tasks, characters);
    await renderChecklist();
  });

  return el("div", { className: "check-editor" },
    el("h2", {}, "Personagens"), names, add,
    el("h2", {}, "Tarefas"),
    el("table", { className: "list checklist" }, el("thead", {}, head), el("tbody", {}, ...rows)),
    el("p", { className: "hint" }, "Desmarque a caixa de um personagem nas tarefas que ele não faz. Tarefas sem nome são descartadas ao salvar. As marcas zeram nos resets do jogo, os mesmos da aba Timers."),
    el("div", { className: "filters" }, addTask, saveButton));
}

onChecklistChanged(() => { if (!draft) renderChecklist(); });
setInterval(tickResets, 1000);
