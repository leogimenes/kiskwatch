// Sharing the codes Kiskwatch couldn't name: monsters, their skills, player
// skills and buffs/debuffs that show as "Monstro 2001234", "Skill 12345" or
// "Efeito 678". With the player's word, a report with only those codes and
// what helps tell them apart goes to a Worker that opens a GitHub issue; the
// name tables in data/ are filled in from there. No names, chat or server.
import { gameData, getSaved, onDpsChanged } from "./api";
import { invoke } from "@tauri-apps/api/core";
import { Skill } from "./buildData";
import { Report, collect, summary } from "./shareReport";

export type ShareMode = "" | "ask" | "always" | "never";

interface ShareStatus { mode: ShareMode; sent: string[]; available: boolean }

const shareStatus = () => invoke<ShareStatus>("share_status");
const shareMode = (mode: ShareMode) => invoke<ShareStatus>("share_mode", { mode });
const shareSend = (report: Report, keys: string[]) => invoke<ShareStatus>("share_send", { report, keys });

let known: Map<number, Skill> | null = null;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, unknown> = {}, ...kids: (Node | string)[]): HTMLElementTagNameMap[K] {
  const e = Object.assign(document.createElement(tag), props);
  e.append(...kids);
  return e;
}

const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T;
const modeSelect = $<HTMLSelectElement>("#share-mode");
const shareText = $("#share-text");
const shareNow = $<HTMLButtonElement>("#share-now");
const shareError = $("#share-error");

let status: ShareStatus | null = null;
/** Asked once per run: "Agora não" waits for the next start. */
let askedThisRun = false;
let lastFight = "";

function render() {
  if (!status) return;
  $("#share-section").hidden = !status.available;
  modeSelect.value = status.mode || "ask";
  shareText.textContent = status.sent.length ? `${status.sent.length} código(s) já enviados.` : "Nada enviado ainda.";
}

function fail(e: unknown) {
  shareError.hidden = false;
  shareError.textContent = `Envio: ${e}`;
}

async function send(report: Report, keys: string[]) {
  status = await shareSend(report, keys);
  shareError.hidden = true;
  render();
}

/** The current unnamed codes, with dbaion2's skills if they come. */
async function pending() {
  if (!known) known = await gameData<Skill[]>("skills").then((l) => new Map(l.map((s) => [s.id, s])), () => null);
  const saved = await getSaved();
  return collect(saved.fights, saved, new Set(status?.sent ?? []), known);
}

/** The dialog: what would go, a note, and how to go on. `byHand` is from the
 *  settings' button, which doesn't change the mode unless told. */
function ask(report: Report, keys: string[], byHand: boolean) {
  const note = el("textarea", { rows: 3, maxLength: 500, placeholder: "Ex.: o chefe de 5 mi de HP perto de Kibelisk 12 era o Fulano" });
  const json = el("pre", { className: "share-json" }, JSON.stringify(report, null, 1));
  const err = el("p", { className: "hk-error", role: "alert", hidden: true });
  const button = (text: string, cls = "") => el("button", { type: "button", className: cls, textContent: text });
  const always = button("Enviar sempre", "primary");
  const once = button("Enviar só desta vez");
  const later = button("Agora não");
  const never = button("Nunca enviar");
  const box = el("dialog", { className: "skill-card share-card" },
    el("h3", {}, "Ajude a traduzir o Kiskwatch"),
    el("p", {}, `O Kiskwatch encontrou ${summary(report)} sem nome nas suas gravações de DPS. Enviar esses códigos ajuda a pôr os nomes certos numa próxima versão.`),
    el("p", { className: "hint" }, "Vão só os códigos, quantas vezes apareceram, o dano que causaram ou levaram, a classe que usou a skill, a versão do app e a região. Nunca vão nomes de personagens, chat, servidor nem pacotes do jogo. Cada envio vira uma issue pública no GitHub do Kiskwatch."),
    el("details", {}, el("summary", {}, "Ver exatamente o que será enviado"), json),
    el("label", { className: "share-note" }, "Sabe o nome de algum? Escreva aqui (opcional)", note),
    err,
    el("div", { className: "row" }, always, once, later, ...(byHand ? [] : [never])),
  );
  const go = async (mode: ShareMode | null) => {
    for (const b of [always, once, later, never]) b.disabled = true;
    try {
      if (mode) status = await shareMode(mode);
      await send({ ...report, note: note.value.trim() }, keys);
      box.close();
    } catch (e) {
      err.hidden = false;
      err.textContent = `Não foi possível enviar: ${e}`;
      for (const b of [always, once, later, never]) b.disabled = false;
    }
  };
  always.addEventListener("click", () => go("always"));
  once.addEventListener("click", () => go(byHand ? null : "ask"));
  later.addEventListener("click", () => box.close());
  never.addEventListener("click", async () => { status = await shareMode("never"); render(); box.close(); });
  box.addEventListener("close", () => box.remove());
  document.body.append(box);
  box.showModal();
}

/** After a recording is saved: send on its own, ask, or nothing. */
async function check() {
  if (!status?.available || status.mode === "never") return;
  const { report, keys } = await pending();
  if (!keys.length) return;
  if (status.mode === "always") return send(report, keys).catch(fail);
  if (askedThisRun || document.querySelector("dialog[open]")) return;
  askedThisRun = true;
  ask(report, keys, false);
}

modeSelect.addEventListener("change", async () => {
  status = await shareMode(modeSelect.value as ShareMode);
  render();
});
shareNow.addEventListener("click", async () => {
  const { report, keys } = await pending();
  if (!keys.length) {
    shareText.textContent = "Nenhum código sem nome novo nas suas gravações.";
    return;
  }
  ask(report, keys, true);
});

let timer = 0;
onDpsChanged(() => {
  clearTimeout(timer);
  timer = window.setTimeout(async () => {
    const id = (await getSaved()).fights[0]?.id ?? "";
    if (id && id !== lastFight) {
      lastFight = id;
      check().catch(() => {});
    }
  }, 5000);
});

shareStatus().then(async (s) => {
  status = s;
  render();
  lastFight = (await getSaved()).fights[0]?.id ?? "";
  setTimeout(() => check().catch(() => {}), 30_000);
});
