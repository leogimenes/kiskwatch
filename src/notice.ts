// The notice on the risks of a third-party tool and on privacy: shown once,
// before the first tour, and again from Configurações > Riscos e privacidade.
import { Onboarding, openHelp } from "./api";

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, unknown> = {}, ...kids: (Node | string)[]): HTMLElementTagNameMap[K] {
  const e = Object.assign(document.createElement(tag), props);
  e.append(...kids);
  return e;
}

const NOTICE = [
  "O Kiskwatch é um projeto de fã, sem afiliação com a NCSoft. Ele só lê uma cópia do tráfego de rede do jogo no seu computador: não altera nem envia pacotes, não lê a memória do jogo e não aperta teclas por você.",
  "Mesmo assim, os Termos de Serviço do AION 2 não autorizam programas de terceiros, e a NCSoft pode agir contra contas que os usam, até com banimento. Não há caso conhecido de banimento por ferramentas que só leem o tráfego, mas ninguém pode garantir. Use por sua conta e risco.",
  "Respeite os outros jogadores: o dano deles aparece para você, mas não publique o nome de ninguém sem consentimento. Ao exportar a imagem de uma gravação, os nomes dos outros saem escondidos, a menos que você desmarque.",
];

/** The notice; `done` runs when it closes. */
export function showNotice(done: () => void = () => {}) {
  if (document.querySelector(".notice-card")) return;
  const ok = el("button", { type: "button", className: "primary", textContent: "Entendi" });
  const privacy = el("button", { type: "button", textContent: "O que sai do seu computador" });
  const box = el("dialog", { className: "skill-card share-card notice-card" },
    el("h3", {}, "Antes de começar"),
    ...NOTICE.map((p, i) => el("p", { className: i ? "hint" : "" }, p)),
    el("div", { className: "row" }, ok, privacy),
  );
  ok.addEventListener("click", () => box.close());
  privacy.addEventListener("click", () => openHelp("privacidade"));
  box.addEventListener("close", () => { box.remove(); done(); });
  document.body.append(box);
  box.showModal();
}

let offered = false;
/** The first time the panel opens: the notice, then `next` (the tour).
 *  `seen` keeps it from coming back. */
export function noticeOnce(o: Onboarding, next: () => void, seen: () => void) {
  if (offered || o.notice) return;
  offered = true;
  showNotice(() => { seen(); next(); });
}

document.querySelector("#notice-read")?.addEventListener("click", () => showNotice());
document.querySelector("#privacy-read")?.addEventListener("click", () => openHelp("privacidade"));
