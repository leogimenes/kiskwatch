// Cloudflare Worker: guarda num banco D1 os códigos que o Kiskwatch não soube
// nomear (src-tauri/src/share.rs) e serve os nomes achados para eles.
//
//   POST /          um relatório do app (sem chave): vira linhas em `sightings`
//   GET  /nomes     público e só de leitura: os nomes, que o app baixa de
//                   tempos em tempos e usa por cima de data/
//   GET  /pendentes com ADMIN_TOKEN: os códigos ainda sem nome, agregados
//   PUT  /nomes     com ADMIN_TOKEN: grava nomes (scripts/codigos.mjs)
//
// O banco só é alcançado por aqui (binding DB). Nada do pedido além do
// relatório validado é guardado: nem IP, nem cabeçalhos.

const MAX_BYTES = 64 * 1024;
const MAX_ITEMS = 300;
const NOTE_MAX = 500;
const NAME_MAX = 120;
/** Relatórios por IP por hora, contados na memória de cada instância. */
const PER_HOUR = 6;
const CLASSES = ["Gladiator", "Templar", "Assassin", "Ranger", "Sorcerer", "Elementalist", "Cleric", "Chanter"];
/** Tipo no banco ↔ lista no relatório e no JSON de nomes. */
const KINDS = { npc: "npcs", npc_skill: "npc_skills", skill: "skills", effect: "effects" };

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS sightings (id INTEGER PRIMARY KEY, at INTEGER NOT NULL, app TEXT NOT NULL, region INTEGER NOT NULL,
     kind TEXT NOT NULL, code INTEGER NOT NULL, data TEXT NOT NULL)`,
  "CREATE INDEX IF NOT EXISTS sightings_code ON sightings (kind, code)",
  "CREATE TABLE IF NOT EXISTS notes (id INTEGER PRIMARY KEY, at INTEGER NOT NULL, app TEXT NOT NULL, region INTEGER NOT NULL, note TEXT NOT NULL)",
  `CREATE TABLE IF NOT EXISTS names (kind TEXT NOT NULL, code INTEGER NOT NULL, name TEXT NOT NULL, source TEXT NOT NULL DEFAULT '',
     updated_at INTEGER NOT NULL, PRIMARY KEY (kind, code))`,
];

let ready = false;
async function schema(db) {
  if (ready) return;
  await db.batch(SCHEMA.map((s) => db.prepare(s)));
  ready = true;
}

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
export function clean(body) {
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
    app: body.app, region: body.region,
    npcs: npcs.map((n) => pick(n, ["code", "boss", "fights", "max_group_damage", "skills"])),
    npc_skills: npcSkills.map((s) => pick(s, ["code", "npc", "hits", "avg", "max"])),
    skills: skills.map((s) => pick(s, ["code", "class", "hits"])),
    effects: effects.map((e) => pick(e, ["code", "skill"])),
    note: (r.note ?? "").trim().slice(0, NOTE_MAX),
  };
}

async function store(db, data) {
  const at = Date.now();
  const add = db.prepare("INSERT INTO sightings (at, app, region, kind, code, data) VALUES (?, ?, ?, ?, ?, ?)");
  const rows = Object.entries(KINDS).flatMap(([kind, list]) =>
    data[list].map(({ code, ...rest }) => add.bind(at, data.app, data.region, kind, code, JSON.stringify(rest))));
  if (data.note) rows.push(db.prepare("INSERT INTO notes (at, app, region, note) VALUES (?, ?, ?, ?)").bind(at, data.app, data.region, data.note));
  await db.batch(rows);
}

/** { npcs: { "2001234": "Nome" }, npc_skills: {...}, skills: {...}, effects: {...} } */
async function names(db) {
  const out = Object.fromEntries(Object.values(KINDS).map((k) => [k, {}]));
  const { results } = await db.prepare("SELECT kind, code, name FROM names").all();
  for (const r of results) if (KINDS[r.kind]) out[KINDS[r.kind]][r.code] = r.name;
  return out;
}

/** Os códigos sem nome, do visto em mais relatórios para o menos visto, com
 *  até 5 amostras de contexto cada; e as notas dos jogadores. */
async function pending(db) {
  const { results } = await db.prepare(
    `SELECT s.kind, s.code, s.at, s.app, s.region, s.data FROM sightings s
     LEFT JOIN names n ON n.kind = s.kind AND n.code = s.code
     WHERE n.code IS NULL ORDER BY s.at DESC LIMIT 20000`).all();
  const codes = new Map();
  for (const r of results) {
    const key = `${r.kind}:${r.code}`;
    const c = codes.get(key) ?? { kind: r.kind, code: r.code, reports: 0, regions: [], first: r.at, last: r.at, apps: [], seen: [] };
    c.reports++;
    c.first = Math.min(c.first, r.at);
    c.last = Math.max(c.last, r.at);
    if (!c.regions.includes(r.region)) c.regions.push(r.region);
    if (!c.apps.includes(r.app)) c.apps.push(r.app);
    if (c.seen.length < 5) c.seen.push(JSON.parse(r.data));
    codes.set(key, c);
  }
  const notes = (await db.prepare("SELECT at, app, region, note FROM notes ORDER BY at DESC LIMIT 200").all()).results;
  return { codes: [...codes.values()].sort((a, b) => b.reports - a.reports), notes };
}

/** [{ kind: "npc", code: 2001234, name: "Nome", source: "dbaion2" }] */
async function setNames(db, list) {
  if (!Array.isArray(list) || list.length > 5000) return false;
  const ok = list.every((n) => KINDS[n?.kind] && int(n.code) && typeof n.name === "string" && n.name.trim() && n.name.length <= NAME_MAX
    && (n.source === undefined || (typeof n.source === "string" && n.source.length <= 200)));
  if (!ok) return false;
  const at = Date.now();
  const put = db.prepare(`INSERT INTO names (kind, code, name, source, updated_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (kind, code) DO UPDATE SET name = excluded.name, source = excluded.source, updated_at = excluded.updated_at`);
  for (let i = 0; i < list.length; i += 100) {
    await db.batch(list.slice(i, i + 100).map((n) => put.bind(n.kind, n.code, n.name.trim(), n.source ?? "", at)));
  }
  return true;
}

const reply = (status, text) => new Response(text, { status, headers: { "content-type": "text/plain; charset=utf-8" } });
const json = (value, headers = {}) => new Response(JSON.stringify(value), { headers: { "content-type": "application/json; charset=utf-8", ...headers } });

/** A chave do administrador, comparada sem vazar o tamanho pelo tempo. */
function admin(request, env) {
  const got = request.headers.get("authorization") ?? "";
  const want = `Bearer ${env.ADMIN_TOKEN ?? ""}`;
  if (!env.ADMIN_TOKEN || env.ADMIN_TOKEN.length < 20) return false;
  let diff = got.length ^ want.length;
  for (let i = 0; i < want.length; i++) diff |= want.charCodeAt(i) ^ (got.charCodeAt(i) || 0);
  return diff === 0;
}

async function body(request) {
  if (Number(request.headers.get("content-length") ?? 0) > MAX_BYTES * 8) return undefined;
  try {
    return JSON.parse(await request.text());
  } catch {
    return undefined;
  }
}

export default {
  async fetch(request, env) {
    if (!env.DB) return reply(500, "banco D1 não ligado ao Worker (binding DB)");
    await schema(env.DB);
    const path = new URL(request.url).pathname.replace(/\/+$/, "") || "/";

    if (path === "/nomes" && request.method === "GET") {
      return json(await names(env.DB), { "cache-control": "public, max-age=3600" });
    }
    if (path === "/pendentes" && request.method === "GET") {
      if (!admin(request, env)) return reply(401, "sem permissão");
      return json(await pending(env.DB));
    }
    if (path === "/nomes" && request.method === "PUT") {
      if (!admin(request, env)) return reply(401, "sem permissão");
      return (await setNames(env.DB, await body(request))) ? reply(200, "ok") : reply(400, "lista de nomes fora do formato");
    }
    if (path !== "/") return reply(404, "não encontrado");
    if (request.method !== "POST") return reply(405, "use POST");

    if (Number(request.headers.get("content-length") ?? 0) > MAX_BYTES) return reply(413, "relatório grande demais");
    if (limited(request.headers.get("cf-connecting-ip") ?? "")) return reply(429, "muitos envios; tente mais tarde");
    const text = await request.text();
    if (text.length > MAX_BYTES) return reply(413, "relatório grande demais");
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      return reply(400, "JSON inválido");
    }
    const data = clean(parsed);
    if (!data) return reply(400, "relatório fora do formato");
    await store(env.DB, data);
    return reply(201, "ok");
  },
};
