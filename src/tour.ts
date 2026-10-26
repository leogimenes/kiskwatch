// The panel's guided tour and help. Each tab has a short tour, shown the
// first time the tab opens (unless skipped); steps about an overlay show that
// overlay, with a note on it. Each tab also has a "?": hovering shows the
// tab's help as a tooltip, clicking opens it in the help window.
import { Onboarding, TourOverlay, onStartTour, openHelp, tourOverlay } from "./api";
import { topic } from "./helpTopics";
import { markdown } from "./markdown";
import "./help.css";

interface Step {
  /** What to light up; none (or not on the screen) puts the note in the middle. */
  at?: string;
  title: string;
  text: string;
  /** An overlay to show during the step, with this note on it. */
  overlay?: TourOverlay;
  note?: string;
}

const HELP_STEP = (tab: string): Step => ({
  at: `#tab-${tab} .help-btn`,
  title: "Ajuda desta aba",
  text: "Passe o mouse no ? para ler a ajuda aqui mesmo; clique para abrir numa janela à parte, que pode ficar aberta ao lado do jogo.",
});

const TOURS: Record<string, Step[]> = {
  timers: [
    { at: "#tab-timers .filters", title: "Busca e filtros", text: "Ache um boss ou evento pelo nome ou pelo lugar, ou veja só um tipo: field bosses, bosses agendados, eventos ou só os que têm aviso." },
    { at: "#timers .alarm", title: "Avisos", text: "Clique no sino de um timer e escolha com quanto tempo de antecedência quer ser avisado, de 1 hora a 1 minuto." },
    { overlay: "overlay", note: "Lembrete dos timers: aparece aqui quando um aviso toca.", title: "O lembrete", text: "Quando um aviso toca, um lembrete aparece no topo da janela do AION 2 com o nome e o tempo que falta, e some sozinho ou no ×. Ele está na tela agora, de exemplo." },
    { at: "#resets", title: "Resets", text: "O reset diário e o semanal ficam aqui em cima. Os field bosses se atualizam quando você abre o mapa no jogo." },
    HELP_STEP("timers"),
  ],
  pets: [
    { at: "#pet-summary", title: "Sua coleção", text: "Quantos pets você tem em cada nível. O Kiskwatch conta as almas sozinho enquanto você joga." },
    { at: "#tab-pets .filters", title: "Filtros", text: "Filtre por nome, monstro, gênero, região ou nível, e ordene pelo que falta." },
    { at: "#tab-pets table.list", title: "A lista", text: "Corrija nível e almas à mão se precisar. A estrela fixa o pet no overlay de pets, e o Ritmo mostra almas por hora no último farm." },
    { at: "#tab-pets .map-panel", title: "Mapa e rota", text: "Onde nascem os monstros que dropam as almas que faltam. Calcular monta a rota de farm com menos caminhada, usando os Kibelisks." },
    { overlay: "pets", note: "Overlay de pets: os últimos pets farmados, o próximo da rota e os fixados.", title: "Overlay de pets", text: "O overlay de pets mostra o que você está farmando sem sair do jogo. Ele está na tela agora; ligue de vez em Configurações." },
    HELP_STEP("pets"),
  ],
  build: [
    { at: "#char-pick", title: "Seu personagem", text: "Busque o personagem pelo nome no site oficial, no servidor escolhido no topo, e escolha na lista. O Kiskwatch passa a segui-lo." },
    { at: "#build", title: "A build", text: "Equipamento, atributos, skills, stigmas e Daevanion, do perfil público. Clique numa skill para ver o detalhe; Atualizar lê de novo." },
    HELP_STEP("build"),
  ],
  group: [
    { at: "#group-near", title: "Por perto", text: "Os jogadores que o jogo mostrou há pouco, como o seu grupo. Clique em alguém para comparar com o seu personagem." },
    { at: "#group-search", title: "Buscar jogador", text: "Ou procure qualquer personagem pelo nome no site oficial." },
    { at: "#group-refs", title: "Builds salvas", text: "Salve a build de alguém como referência para comparar de novo depois, mesmo que a pessoa mude." },
    HELP_STEP("group"),
  ],
  dps: [
    { at: "#dps-live", title: "Gravação", text: "A gravação começa sozinha no seu primeiro golpe (ou pelo botão, se preferir em Configurações) e para depois de 30 s sem dano. O atalho de teclado (Ctrl+Alt+D por padrão) grava e para com o jogo na frente." },
    { at: "#dps-view", title: "Gravações e chefes", text: "Veja as gravações uma a uma, ou por chefe para comparar com a sua melhor luta." },
    { at: "#dps-fights", title: "Detalhes", text: "Escolha uma gravação para ver dano e cura por jogador, por skill, a linha do tempo, o dano recebido e os buffs. Dá para exportar como imagem." },
    { overlay: "dps", note: "Overlay de DPS: grave, pare e acompanhe até 6 jogadores aqui.", title: "Overlay de DPS", text: "O overlay de DPS mostra a luta enquanto você joga. Ele está na tela agora; para arrastar, desligue os cliques passando para o jogo (atalho Ctrl+Alt+X por padrão)." },
    HELP_STEP("dps"),
  ],
  checklist: [
    { at: "#checklist", title: "Tarefas", text: "Clique para marcar o que cada personagem já fez hoje e nesta semana; o botão direito tira uma. As marcas zeram nos resets do jogo." },
    { at: "#check-edit", title: "Editar", text: "Adicione personagens e tarefas, mude a ordem e diga quantas vezes cada tarefa se faz." },
    HELP_STEP("checklist"),
  ],
  enchant: [
    { at: "#enchant .enchant-form", title: "O item", text: "Diga o que vai encantar, onde está e até onde quer chegar. Kinah e pedras são opcionais." },
    { at: "#enchant", title: "O custo", text: "A tabela mostra a chance e o custo esperado de cada passo, e o total. Os passos arriscados ficam em dourado." },
    HELP_STEP("enchant"),
  ],
  titles: [
    { at: "#titles .filters", title: "Busca", text: "Ache um título pelo nome ou pelo jeito de obter, e filtre por categoria, tipo, raridade e pelos que você tem ou não." },
    { at: "#titles .title-stats", title: "Atributos", text: "Escolha até 3 atributos para ver só os títulos que dão todos eles, com o maior valor primeiro." },
    { at: "#titles-list", title: "Os seus títulos", text: "Marque os que já tem. Com um personagem seguido na aba Build, a contagem do perfil oficial mostra quantos faltam marcar." },
    HELP_STEP("titles"),
  ],
  config: [
    { at: "label.row:has(#timer-overlay)", title: "Overlays", text: "Ligue o lembrete dos timers, o overlay de pets e o de DPS, e escolha quando eles aparecem." },
    { at: "label.row:has(#click-through)", title: "Mover os overlays", text: "Com esta opção os cliques passam para o jogo. Desmarque (ou use o atalho) para arrastar e redimensionar os overlays." },
    { at: ".settings:has(#hk-dps)", title: "Atalhos", text: "Atalhos que funcionam com o jogo na frente. Clique num e aperte a nova combinação." },
    { at: ".settings:has(#a-font)", title: "Acessibilidade", text: "Tamanho do texto, fundo dos overlays, contraste, cores para daltonismo, animações e som." },
    { at: "#cfg-tour", title: "Tour guiado", text: "Desligue os tours ou refaça todos por aqui." },
    { at: "label.row:has(#update-channel)", title: "Canal de atualização", text: "Estável recebe só as versões oficiais; canary recebe cada mudança assim que passa no CI, para testar antes." },
    { at: "#share-section", title: "Ajudar a traduzir", text: "Com a sua permissão, o Kiskwatch envia os códigos de monstros, skills e efeitos que ainda não sabe nomear, para os nomes entrarem numa próxima versão." },
    HELP_STEP("config"),
  ],
};

const WELCOME: Step = {
  title: "Bem-vindo ao Kiskwatch",
  text: "Cada aba tem um tour curto como este, que abre na primeira vez que você entra nela. Pule só esta aba ou tudo de uma vez quando quiser: os tours voltam em Configurações.",
};

let state: Onboarding | null = null;
let save: (change: (o: Onboarding) => void) => void = () => {};

/** Change the tour settings here at once, and save them. */
function change(f: (o: Onboarding) => void) {
  if (state) {
    state = structuredClone(state);
    f(state);
  }
  save(f);
}
let running: { tab: string; steps: Step[]; at: number; overlay: boolean } | null = null;

const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T | null;
function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, unknown> = {}, ...kids: (Node | string)[]): HTMLElementTagNameMap[K] {
  const e = Object.assign(document.createElement(tag), props);
  e.append(...kids);
  return e;
}

export const activeTab = () => $<HTMLButtonElement>(".tabs button.active")?.dataset.tab ?? "timers";

// ---- The tour ----
const shade = el("div", { className: "tour-shade", hidden: true });
const spot = el("div", { className: "tour-spot", hidden: true });
const bubble = el("div", { className: "tour-bubble", hidden: true, role: "dialog", ariaModal: "true" });
document.body.append(shade, spot, bubble);

function target(step: Step) {
  const e = step.at ? document.querySelector<HTMLElement>(step.at) : null;
  return e && e.getClientRects().length ? e : null;
}

function place() {
  if (!running) return;
  const t = target(running.steps[running.at]);
  const pad = 6;
  const gap = 12;
  const vw = innerWidth;
  const vh = innerHeight;
  const b = bubble.getBoundingClientRect();
  spot.hidden = !t;
  shade.classList.toggle("dim", !t);
  if (!t) {
    bubble.style.left = `${Math.max(8, (vw - b.width) / 2)}px`;
    bubble.style.top = `${Math.max(8, (vh - b.height) / 2)}px`;
    return;
  }
  const r = t.getBoundingClientRect();
  // Something taller than the window: light up the part on the screen.
  const top = Math.max(r.top, 0);
  const bottom = Math.min(r.bottom, vh);
  Object.assign(spot.style, { left: `${r.left - pad}px`, top: `${top - pad}px`, width: `${r.width + 2 * pad}px`, height: `${bottom - top + 2 * pad}px` });
  let y = bottom + pad + gap;
  if (y + b.height > vh - 8) y = top - pad - gap - b.height;
  if (y < 8) y = Math.min(vh - b.height - 8, Math.max(8, top + 8));
  const x = Math.min(Math.max(8, r.left), vw - b.width - 8);
  bubble.style.left = `${x}px`;
  bubble.style.top = `${y}px`;
}

function show() {
  if (!running) return;
  const { steps, at, tab } = running;
  const step = steps[at];
  const t = target(step);
  t?.scrollIntoView({ block: "nearest" });
  // The overlay, if this step is about one; or back as the settings say.
  if (step.overlay) {
    running.overlay = true;
    tourOverlay(step.overlay, step.note ?? null);
  } else if (running.overlay) {
    running.overlay = false;
    tourOverlay(null);
  }
  const last = at === steps.length - 1;
  const back = el("button", { type: "button", textContent: "Voltar", disabled: at === 0 });
  back.addEventListener("click", () => go(-1));
  const next = el("button", { type: "button", className: "primary", textContent: last ? "Concluir" : "Próximo" });
  next.addEventListener("click", () => (last ? finish(tab, false) : go(1)));
  const skip = el("button", { type: "button", className: "link", textContent: "Pular esta aba" });
  skip.addEventListener("click", () => finish(tab, false));
  const skipAll = el("button", { type: "button", className: "link", textContent: "Pular tudo" });
  skipAll.addEventListener("click", () => finish(tab, true));
  const title = el("h3", { id: "tour-title", textContent: step.title });
  bubble.setAttribute("aria-labelledby", "tour-title");
  bubble.replaceChildren(
    el("div", { className: "tour-count" }, `${at + 1} de ${steps.length}`),
    title,
    el("p", { textContent: step.text }),
    el("div", { className: "tour-actions" }, el("span", { className: "tour-skips" }, skip, skipAll), back, next),
  );
  shade.hidden = spot.hidden = bubble.hidden = false;
  place();
  next.focus();
}

function go(by: number) {
  if (!running) return;
  running.at = Math.min(Math.max(0, running.at + by), running.steps.length - 1);
  show();
}

/** Done with a tab's tour (seen or skipped), or with all of them. */
function finish(tab: string, all: boolean) {
  if (running?.overlay) tourOverlay(null);
  running = null;
  shade.hidden = spot.hidden = bubble.hidden = true;
  change((o) => {
    if (!o.seen.includes(tab)) o.seen.push(tab);
    if (all) o.off = true;
  });
}

/** Run a tab's tour now, seen or not. */
export function runTour(tab: string) {
  const steps = TOURS[tab];
  if (!steps) return;
  if (running?.overlay) tourOverlay(null);
  const first = state != null && !state.off && state.seen.length === 0;
  // Parts the panel isn't showing now (like a section turned off) are left out.
  const shown = steps.filter((st) => !st.at || target(st));
  running = { tab, steps: first ? [WELCOME, ...shown] : shown, at: 0, overlay: false };
  show();
}

/** A tab just opened: its tour, the first time. */
export function tourTab(tab: string) {
  hideTip();
  if (!state || state.off || state.seen.includes(tab) || running?.tab === tab) return;
  // Not over a dialog already open (like the one asking to share codes).
  if (document.querySelector("dialog[open]")) return;
  // Leaving a tab mid-tour leaves its tour for next time.
  if (running?.overlay) tourOverlay(null);
  running = null;
  // After the tab has drawn, so its parts are on the screen to light up.
  requestAnimationFrame(() => runTour(tab));
}

let started = false;
/** The settings, as the panel reads them; the first time, the tour of the tab open. */
export function tourSettings(o: Onboarding) {
  state = o;
  const box = $<HTMLInputElement>("#tour-on");
  if (box) box.checked = !o.off;
  if (!started) {
    started = true;
    tourTab(activeTab());
  }
}

/** How the tour saves what was seen. */
export function initTour(saveChange: (change: (o: Onboarding) => void) => void) {
  save = saveChange;
}

document.addEventListener("keydown", (e) => {
  if (!running) return;
  if (e.key === "Escape") finish(running.tab, false);
  else if (e.key === "ArrowRight") go(1);
  else if (e.key === "ArrowLeft") go(-1);
  else return;
  e.preventDefault();
});
addEventListener("resize", place);
// The panel scrolls inside: follow what is lit up.
document.addEventListener("scroll", place, true);

// The help window's "Ver o tour desta aba".
onStartTour((tab) => {
  $<HTMLButtonElement>(`.tabs button[data-tab="${tab}"]`)?.click();
  requestAnimationFrame(() => runTour(tab));
});

// The tour settings, in Configurações.
$("#tour-on")?.addEventListener("change", (e) => {
  const on = (e.target as HTMLInputElement).checked;
  change((o) => { o.off = !on; });
});
$("#tour-reset")?.addEventListener("click", () => {
  change((o) => { o.off = false; o.seen = []; });
  runTour(activeTab());
});

// ---- Help: a "?" on each tab ----
const tip = el("div", { className: "help-tip md", hidden: true, role: "tooltip", id: "help-tip" });
document.body.append(tip);
let tipFor: HTMLElement | null = null;
let tipTimer = 0;

function showTip(button: HTMLElement) {
  const tab = button.dataset.help!;
  tipFor = button;
  const more = el("p", { className: "help-tip-more" }, "Clique no ? para abrir numa janela. ");
  const tourLink = el("button", { type: "button", className: "link", textContent: "Ver o tour" });
  tourLink.addEventListener("click", () => { hideTip(); runTour(tab); });
  if (TOURS[tab]) more.append(tourLink);
  tip.innerHTML = markdown(topic(tab).text);
  tip.append(more);
  tip.hidden = false;
  const r = button.getBoundingClientRect();
  const w = tip.offsetWidth;
  tip.style.left = `${Math.max(8, Math.min(r.right - w, innerWidth - w - 8))}px`;
  tip.style.top = `${r.bottom + 8}px`;
  tip.style.maxHeight = `${Math.max(160, innerHeight - r.bottom - 24)}px`;
  tip.scrollTop = 0;
}

function hideTip() {
  clearTimeout(tipTimer);
  tip.hidden = true;
  tipFor = null;
}

/** Hover in, after a moment; out, after a moment, unless onto the tooltip itself. */
function soon(f: () => void, ms: number) {
  clearTimeout(tipTimer);
  tipTimer = window.setTimeout(f, ms);
}

for (const section of document.querySelectorAll<HTMLElement>("main > .tab")) {
  const tab = section.id.replace(/^tab-/, "");
  if (!topic(tab) || topic(tab).id !== tab) continue;
  const b = el("button", { type: "button", className: "help-btn", textContent: "?", title: "", ariaLabel: `Ajuda: ${topic(tab).title}` });
  b.dataset.help = tab;
  b.setAttribute("aria-describedby", "help-tip");
  b.addEventListener("mouseenter", () => soon(() => showTip(b), 250));
  b.addEventListener("mouseleave", () => soon(hideTip, 250));
  b.addEventListener("focus", () => showTip(b));
  b.addEventListener("blur", () => soon(() => { if (!tip.contains(document.activeElement)) hideTip(); }, 150));
  b.addEventListener("click", () => { hideTip(); openHelp(tab); });
  section.prepend(b);
}
tip.addEventListener("mouseenter", () => clearTimeout(tipTimer));
tip.addEventListener("mouseleave", () => soon(hideTip, 250));
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && tipFor) hideTip(); });
