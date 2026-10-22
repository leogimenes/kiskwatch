// The panel's Enchant tab: how many tries, Kinah and stones it takes to take
// an item from its level to a target, on average and with good or bad luck.
import { DATA, GRADES, Grade, Kind, Plan, amplifyCap, chanceWithin, expected, ladder, percentile, simulate } from "./enchantCalc";

const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T;
function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, unknown> = {}, ...kids: (Node | string)[]): HTMLElementTagNameMap[K] {
  const e = Object.assign(document.createElement(tag), props);
  e.append(...kids);
  return e;
}

interface Inputs {
  kind: Kind;
  grade: Grade;
  itemLevel: number;
  from: number;
  to: number;
  fails: number;
  kinah: number | null;
  stones: number | null;
}

const KEY = "kiskwatch.enchant";
let inputs: Inputs = { kind: "gear", grade: "unique", itemLevel: 102, from: 10, to: 15, fails: 0, kinah: null, stones: null };
try {
  inputs = { ...inputs, ...JSON.parse(localStorage.getItem(KEY) ?? "{}") };
} catch { /* first time, or storage off */ }

const save = () => { try { localStorage.setItem(KEY, JSON.stringify(inputs)); } catch { /* storage off */ } };

const int = (n: number) => Math.round(n).toLocaleString("pt-BR");
const pct = (x: number) => `${(x * 100).toLocaleString("pt-BR", { maximumFractionDigits: 1 })}%`;
/** 14986721 → "14,99 mi". */
function short(n: number) {
  if (n >= 1e9) return `${(n / 1e9).toLocaleString("pt-BR", { maximumFractionDigits: 2 })} bi`;
  if (n >= 1e6) return `${(n / 1e6).toLocaleString("pt-BR", { maximumFractionDigits: 2 })} mi`;
  return int(n);
}

/** The highest level the picked item goes to. */
function maxLevel() {
  if (inputs.kind === "amplify") return amplifyCap(inputs.itemLevel) ?? DATA.amplify.steps.length;
  return GRADES[inputs.grade].max;
}

function field(label: string, input: HTMLElement) {
  return el("label", { className: "enchant-field" }, el("span", {}, label), input);
}

function select<T extends string | number>(options: [T, string][], value: T, pick: (v: T) => void) {
  const s = el("select", {}, ...options.map(([v, label]) => el("option", { value: String(v), textContent: label, selected: v === value })));
  s.addEventListener("change", () => pick(options[s.selectedIndex][0]));
  return s;
}

function number(value: number | null, pick: (v: number | null) => void, props: Record<string, unknown> = {}) {
  const i = el("input", { type: "number", min: "0", value: value === null ? "" : String(value), ...props });
  i.addEventListener("change", () => pick(i.value === "" ? null : Math.max(0, Math.floor(Number(i.value)))));
  return i;
}

function change(edit: (i: Inputs) => void) {
  edit(inputs);
  const max = maxLevel();
  inputs.to = Math.min(Math.max(inputs.to, 1), max);
  inputs.from = Math.min(Math.max(inputs.from, 0), inputs.to - 1);
  save();
  render();
}

const levels = (from: number, to: number, prefix = "+") => Array.from({ length: to - from + 1 }, (_, i): [number, string] => [from + i, `${prefix}${from + i}`]);

function renderForm() {
  const max = maxLevel();
  const amp = inputs.kind === "amplify";
  const prefix = amp ? "Amplificado +" : "+";
  return el("div", { className: "enchant-form" },
    field("O que", select<Kind>([["gear", "Equipamento (+0 a +15)"], ["amplify", "Amplificação (acima do +15)"]], inputs.kind, (v) => change((i) => {
      i.kind = v;
      i.from = 0;
      i.to = v === "amplify" ? 1 : GRADES[i.grade].max;
    }))),
    ...(amp ? [] : [field("Grau", select<Grade>(Object.entries(GRADES).map(([g, d]) => [g as Grade, `${d.label} (até +${d.max})`]), inputs.grade, (v) => change((i) => {
      i.grade = v;
    })))]),
    field("Nível do item", number(inputs.itemLevel, (v) => change((i) => { i.itemLevel = Math.max(1, v ?? 1); }), { min: "1", max: "200" })),
    field("Está em", select(levels(0, max - 1, prefix), inputs.from, (v) => change((i) => { i.from = v; i.fails = 0; }))),
    field("Falhas neste nível", number(inputs.fails, (v) => change((i) => { i.fails = v ?? 0; }), { title: "Cada falha soma o bônus do passo à próxima tentativa" })),
    field("Quero chegar a", select(levels(1, max, prefix), inputs.to, (v) => change((i) => { i.to = v; }))),
    field("Kinah que tenho", number(inputs.kinah, (v) => change((i) => { i.kinah = v; }), { placeholder: "opcional" })),
    field(amp ? "Pedras de amplificação" : "Pedras de encantamento", number(inputs.stones, (v) => change((i) => { i.stones = v; }), { placeholder: "opcional" })),
  );
}

function stat(label: string, value: string, note = "") {
  return el("div", { className: "stat" }, el("small", {}, label), el("strong", {}, value), ...(note ? [el("small", {}, note)] : []));
}

function renderResult() {
  const { steps, exact } = ladder(inputs.kind, inputs.itemLevel);
  const plan: Plan = { kind: inputs.kind, steps, from: inputs.from, to: inputs.to, fails: inputs.fails };
  const amp = inputs.kind === "amplify";
  const stoneName = amp ? "Amplify Stone" : "Enhance Stone";
  const prefix = amp ? "A+" : "+";
  const e = expected(plan);
  const risky = e.steps.some((s) => s.chance < 1);
  const spread = risky ? simulate(plan) : null;
  const luck = spread ? [0.1, 0.5, 0.9].map((q) => percentile(spread, q)) : null;
  const has = inputs.kinah !== null || inputs.stones !== null;

  const cards = el("div", { className: "stat-row" },
    stat("Tentativas", e.total.tries.toLocaleString("pt-BR", { maximumFractionDigits: 2 }), risky ? "em média" : "sem risco: sempre dá certo"),
    stat("Kinah", short(e.total.kinah), risky ? "em média" : ""),
    stat(stoneName, int(e.total.stones), risky ? "em média" : ""),
    ...(e.worst && risky ? [stat("Pior caso", short(e.worst.kinah), `${e.worst.tries} tentativas · ${int(e.worst.stones)} pedras`)] : []),
    ...(spread && has ? [stat("Chance com o que você tem", pct(chanceWithin(spread, inputs.kinah, inputs.stones)), "de chegar ao alvo")] : []),
  );

  const luckRow = luck ? el("p", { className: "hint" },
    `Com sorte (1 em 10): ${short(luck[0].kinah)} Kinah · Típico (metade dos casos): ${short(luck[1].kinah)} · Com azar (9 em 10 gastam menos): ${short(luck[2].kinah)}`) : "";

  const table = el("table", { className: "list enchant-steps" },
    el("thead", {}, el("tr", {}, ...["Passo", "Chance", "Bônus por falha", "Tentativas (média)", "Máximo", "Custo por tentativa", "Custo médio"].map((h) => el("th", { textContent: h })))),
    el("tbody", {}, ...e.steps.map((s) => el("tr", { className: s.chance < 1 ? "risky" : "" },
      el("td", { textContent: `${prefix}${s.level - 1} → ${prefix}${s.level}` }),
      el("td", { textContent: pct(s.chance) }),
      el("td", { textContent: s.step.pity ? `+${pct(s.step.pity)}` : "—" }),
      el("td", { textContent: s.tries.toLocaleString("pt-BR", { maximumFractionDigits: 2 }) }),
      el("td", { textContent: s.max === null ? "—" : String(s.max) }),
      el("td", { textContent: `${int(s.step.kinah)} Kinah + ${int(s.step.stones)}` }),
      el("td", { textContent: `${short(s.kinah)} + ${int(s.stones)}` }),
    ))),
  );

  const notes: (Node | string)[] = [];
  if (!exact) notes.push(el("p", { className: "hint" }, `Custos estimados para o nível ${inputs.itemLevel} a partir das tabelas dos níveis ${Object.keys(DATA.gear.known).join(", ")} (erro de até ~3%).`));
  if (amp) notes.push(el("p", { className: "hint" }, DATA.amplify.about));
  if (!amp && inputs.grade !== "unique") notes.push(el("p", { className: "hint" }, `${GRADES[inputs.grade].label} nunca falha até o máximo: o custo é fixo.`));
  notes.push(el("p", { className: "hint" },
    "Falhar não quebra nem baixa o item: só gasta o material. Cada falha soma o bônus do passo à próxima tentativa daquele nível, até 100%; o acerto zera o bônus. ",
    "Chances: dados do cliente Global, iguais à ",
    el("a", { href: "https://probability.plaync.com/aion2/index", textContent: "divulgação oficial da NCSoft" }),
    " (Coreia). Custos: tabelas de ",
    el("a", { href: "https://metabot.gg/en/aion-2/enhancement", textContent: "metabot.gg" }), " e ",
    el("a", { href: "https://allthings.how/aion-2-enhancement-success-chance-and-cost-of-every-step-to-15-by-grade/", textContent: "allthings.how" }),
    ". Colares, cintos e a Runa do Confronto ainda não entram: as fontes não fecham os custos nem o que acontece na falha."));

  return el("div", {}, cards, luckRow, table, ...notes);
}

function render() {
  $("#enchant").replaceChildren(renderForm(), renderResult());
}

render();
