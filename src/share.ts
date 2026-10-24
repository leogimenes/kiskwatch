// Sharing the codes Kiskwatch couldn't name: monsters, their skills, player
// skills and buffs/debuffs that show as "Monstro 2001234", "Skill 12345" or
// "Efeito 678". The player reads a consent term once; once accepted, after
// each DPS recording the new codes, and what helps tell them apart, go to a
// Worker that keeps them in a database; the names found come back through
// sharedNames.ts. No names, chat or server. Settings take the consent back.
import { gameData, getSaved, onDpsChanged, onStateChanged } from "./api";
import { invoke } from "@tauri-apps/api/core";
import { Skill } from "./buildData";
import { Report, collect, summary } from "./shareReport";

/** "" before the term was answered; "always" accepted; "never" declined or taken back. */
export type ShareMode = "" | "always" | "never";

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
const onBox = $<HTMLInputElement>("#share-on");
const shareText = $("#share-text");
const shareNow = $<HTMLButtonElement>("#share-now");
const shareTerms = $<HTMLButtonElement>("#share-terms");
const shareError = $("#share-error");

let status: ShareStatus | null = null;
let lastFight = "";
/** What the last send did, this run. */
let lastSent = "";

function render() {
  if (!status) return;
  $("#share-section").hidden = !status.available;
  onBox.checked = status.mode === "always";
  shareNow.hidden = status.mode !== "always";
  const total = status.sent.length ? `${status.sent.length} código(s) enviados até agora.` : "Nada enviado ainda.";
  shareText.textContent = [lastSent, total].filter(Boolean).join(" ");
}

function fail(e: unknown) {
  shareError.hidden = false;
  shareError.textContent = `Envio: ${e}`;
}

async function send(report: Report, keys: string[]) {
  status = await shareSend(report, keys);
  shareError.hidden = true;
  lastSent = `Último envio: ${summary(report)}, às ${new Date().toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}.`;
  render();
}

/** The current unnamed codes, with dbaion2's skills if they come. */
async function pending() {
  if (!known) known = await gameData<Skill[]>("skills").then((l) => new Map(l.map((s) => [s.id, s])), () => null);
  const saved = await getSaved();
  return collect(saved.fights, saved, new Set(status?.sent ?? []), known);
}

const TERM = [
  "O Kiskwatch mostra como \"Monstro 2001234\", \"Skill 12345\" ou \"Efeito 678\" o que ele ainda não sabe nomear. Para pôr os nomes certos nas próximas versões, ele pode enviar esses códigos depois de cada gravação de DPS.",
  "O que é enviado: os códigos de monstros, skills e efeitos sem nome; quantas vezes apareceram; o dano que causaram ou levaram; a classe que usou a skill; a versão do Kiskwatch e a região do jogo.",
  "O que nunca é enviado: nomes de personagens (o seu ou de outros), chat, servidor, conta, endereço IP guardado, pacotes do jogo ou qualquer outra coisa da sua máquina.",
  "Para onde vai: um banco de dados do Kiskwatch, sem acesso público. A lista dos códigos que ainda faltam nomear, somada de todos os jogadores e sem dizer quem enviou o quê, é publicada no GitHub do Kiskwatch. Cada código vai uma vez só, e os nomes achados chegam ao app sozinhos.",
  "Você pode desligar quando quiser em Configurações > Ajudar a traduzir; a partir daí nada mais é enviado.",
];

/** The consent term: read once, accepted or not. `fromSettings` is the
 *  settings' checkbox or "Ler o termo", where closing changes nothing. */
function term(fromSettings: boolean) {
  if (document.querySelector(".share-card")) return;
  const accept = el("button", { type: "button", className: "primary", textContent: "Aceito enviar" });
  const decline = el("button", { type: "button", textContent: status?.mode === "always" ? "Parar de enviar" : "Não, obrigado" });
  const box = el("dialog", { className: "skill-card share-card" },
    el("h3", {}, "Ajude a traduzir o Kiskwatch"),
    ...TERM.map((p, i) => el("p", { className: i ? "hint" : "" }, p)),
    el("div", { className: "row" }, accept, decline),
  );
  let answered = false;
  const answer = async (mode: ShareMode) => {
    answered = true;
    status = await shareMode(mode);
    render();
    box.close();
    if (mode === "always") check().catch(fail);
  };
  accept.addEventListener("click", () => answer("always"));
  decline.addEventListener("click", () => answer("never"));
  // Esc before the first answer asks again next time.
  box.addEventListener("cancel", (e) => { if (!fromSettings) e.preventDefault(); });
  box.addEventListener("close", () => { box.remove(); if (!answered) render(); });
  document.body.append(box);
  box.showModal();
}

/** "Ver e enviar agora": what would go, with a note, sent on the spot. */
function preview(report: Report, keys: string[]) {
  const note = el("textarea", { rows: 3, maxLength: 500, placeholder: "Ex.: o chefe de 5 mi de HP perto de Kibelisk 12 era o Fulano" });
  const err = el("p", { className: "hk-error", role: "alert", hidden: true });
  const go = el("button", { type: "button", className: "primary", textContent: "Enviar agora" });
  const cancel = el("button", { type: "button", textContent: "Cancelar" });
  const box = el("dialog", { className: "skill-card share-card" },
    el("h3", {}, "Códigos sem nome"),
    el("p", {}, `${summary(report)} ainda não foram enviados.`),
    el("details", {}, el("summary", {}, "Ver exatamente o que será enviado"), el("pre", { className: "share-json" }, JSON.stringify(report, null, 1))),
    el("label", { className: "share-note" }, "Sabe o nome de algum? Escreva aqui (opcional). A nota aparece na lista pública, sem dizer quem enviou: não escreva seu nome, contato ou dados da sua conta.", note),
    err,
    el("div", { className: "row" }, go, cancel),
  );
  go.addEventListener("click", async () => {
    go.disabled = true;
    try {
      await send({ ...report, note: note.value.trim() }, keys);
      box.close();
    } catch (e) {
      err.hidden = false;
      err.textContent = `Não foi possível enviar: ${e}`;
      go.disabled = false;
    }
  });
  cancel.addEventListener("click", () => box.close());
  box.addEventListener("close", () => box.remove());
  document.body.append(box);
  box.showModal();
}

/** After a recording is saved, with consent: the new codes go on their own. */
async function check() {
  if (!status?.available || status.mode !== "always") return;
  const { report, keys } = await pending();
  if (keys.length) await send(report, keys);
}

/** The term, the first time: once nothing else (the tour, a dialog) is up. */
function offerTerm() {
  if (!status?.available || status.mode !== "") return;
  const busy = document.querySelector("dialog[open]") || document.querySelector(".tour-bubble:not([hidden])") || document.hidden;
  if (busy) setTimeout(offerTerm, 3000);
  else term(false);
}

onBox.addEventListener("change", async () => {
  if (onBox.checked) term(true);
  else {
    status = await shareMode("never");
    render();
  }
});
shareTerms.addEventListener("click", () => term(true));
shareNow.addEventListener("click", async () => {
  const { report, keys } = await pending();
  if (!keys.length) {
    shareText.textContent = "Nenhum código sem nome novo nas suas gravações.";
    return;
  }
  preview(report, keys);
});

let timer = 0;
onDpsChanged(() => {
  clearTimeout(timer);
  timer = window.setTimeout(async () => {
    const id = (await getSaved()).fights[0]?.id ?? "";
    if (id && id !== lastFight) {
      lastFight = id;
      check().catch(fail);
    }
  }, 5000);
});

/** The panel can load before the app is ready to answer; the first state
 *  change, or a retry, gets the status then. */
async function start() {
  if (status) return;
  try {
    status = await shareStatus();
  } catch {
    setTimeout(start, 2000);
    return;
  }
  render();
  lastFight = (await getSaved()).fights[0]?.id ?? "";
  setTimeout(offerTerm, 1500);
}

onStateChanged(start);
start();
