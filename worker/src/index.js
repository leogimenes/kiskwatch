// Cloudflare Worker: recebe do Kiskwatch um relatório de códigos que o app
// não soube nomear (src-tauri/src/share.rs) e abre uma issue no GitHub.
// O token do GitHub fica só aqui, como secret (GITHUB_TOKEN); o app não leva
// chave nenhuma. Nada do pedido além do relatório validado é guardado: nem IP,
// nem cabeçalhos.

const MAX_BYTES = 64 * 1024;
const MAX_ITEMS = 300;
const NOTE_MAX = 500;
/** Relatórios por IP por hora, contados na memória de cada instância. */
const PER_HOUR = 6;
const CLASSES = ["Gladiator", "Templar", "Assassin", "Ranger", "Sorcerer", "Elementalist", "Cleric", "Chanter"];

const recent = new Map();

function limited(ip) {
  const now = Date.now();
  const list = (recent.get(ip) ?? []).filter((t) => now - t < 3600_000);
  if (list.length >= PER_HOUR) return true;
  list.push(now);
  recent.set(ip, list);
  if (recent.size > 10_000) recent.clear();
  return false;
}

const int = (v) => Number.isSafeInteger(v) && v >= 0;
const intOrNull = (v) => v === null || int(v);

/** Só os campos esperados, só números; qualquer outra coisa recusa. */
function clean(body) {
  if (!body || body.v !== 1 || typeof body.app !== "string" || !/^\d+\.\d+\.\d+([-+][\w.-]+)?$/.test(body.app) || !int(body.region)) return null;
  const r = body.report;
  if (!r || typeof r !== "object") return null;
  const list = (v, ok) => Array.isArray(v) && v.length <= MAX_ITEMS && v.every(ok) ? v : null;
  const npcs = list(r.npcs ?? [], (n) => int(n.code) && typeof n.boss === "boolean" && int(n.fights) && int(n.max_group_damage)
    && Array.isArray(n.skills) && n.skills.length <= 100 && n.skills.every(int));
  const npcSkills = list(r.npc_skills ?? [], (s) => int(s.code) && int(s.npc) && int(s.hits) && int(s.avg) && int(s.max));
  const skills = list(r.skills ?? [], (s) => int(s.code) && (s.class === null || CLASSES.includes(s.class)) && int(s.hits));
  const effects = list(r.effects ?? [], (e) => int(e.code) && intOrNull(e.skill));
  if (!npcs || !npcSkills || !skills || !effects || (typeof r.note !== "string" && r.note !== undefined)) return null;
  if (!npcs.length && !npcSkills.length && !skills.length && !effects.length) return null;
  const pick = (o, keys) => Object.fromEntries(keys.map((k) => [k, o[k]]));
  return {
    v: 1, app: body.app, region: body.region,
    report: {
      npcs: npcs.map((n) => pick(n, ["code", "boss", "fights", "max_group_damage", "skills"])),
      npc_skills: npcSkills.map((s) => pick(s, ["code", "npc", "hits", "avg", "max"])),
      skills: skills.map((s) => pick(s, ["code", "class", "hits"])),
      effects: effects.map((e) => pick(e, ["code", "skill"])),
      note: (r.note ?? "").slice(0, NOTE_MAX),
    },
  };
}

function plural(n, one, many) {
  return `${n} ${n === 1 ? one : many}`;
}

function issue(data) {
  const r = data.report;
  const parts = [
    r.npcs.length && plural(r.npcs.length, "monstro", "monstros"),
    r.npc_skills.length && plural(r.npc_skills.length, "skill de monstro", "skills de monstro"),
    r.skills.length && plural(r.skills.length, "skill de jogador", "skills de jogador"),
    r.effects.length && plural(r.effects.length, "efeito", "efeitos"),
  ].filter(Boolean);
  const title = `Códigos sem nome: ${parts.join(", ")} (v${data.app})`;
  // A nota é texto livre: vai dentro de um bloco de código, sem como fechar
  // o bloco nem mencionar ninguém.
  const note = r.note.trim() ? `\n### Nota do jogador\n\n~~~text\n${r.note.replaceAll("~~~", "~ ~ ~")}\n~~~\n` : "";
  const body = [
    `Relatório enviado pelo Kiskwatch v${data.app}, região ${data.region}.`,
    note,
    "### Dados",
    "",
    "```json",
    JSON.stringify({ ...data, report: { ...r, note: undefined } }, null, 1),
    "```",
    "",
    "Gerado automaticamente; junte os relatórios com `node scripts/codigos.mjs`.",
  ].join("\n");
  return { title, body };
}

const reply = (status, text) => new Response(text, { status, headers: { "content-type": "text/plain; charset=utf-8" } });

export default {
  async fetch(request, env) {
    if (request.method !== "POST") return reply(405, "use POST");
    if (Number(request.headers.get("content-length") ?? 0) > MAX_BYTES) return reply(413, "relatório grande demais");
    if (limited(request.headers.get("cf-connecting-ip") ?? "")) return reply(429, "muitos envios; tente mais tarde");
    let body;
    try {
      const text = await request.text();
      if (text.length > MAX_BYTES) return reply(413, "relatório grande demais");
      body = JSON.parse(text);
    } catch {
      return reply(400, "JSON inválido");
    }
    const data = clean(body);
    if (!data) return reply(400, "relatório fora do formato");
    const { title, body: text } = issue(data);
    const res = await fetch(`https://api.github.com/repos/${env.REPO}/issues`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.GITHUB_TOKEN}`,
        accept: "application/vnd.github+json",
        "user-agent": "kiskwatch-codigos",
        "x-github-api-version": "2022-11-28",
      },
      body: JSON.stringify({ title, body: text, labels: [env.LABEL] }),
    });
    if (!res.ok) return reply(502, `GitHub respondeu ${res.status}`);
    return reply(201, "ok");
  },
};
