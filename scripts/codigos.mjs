// Os códigos sem nome que os jogadores compartilharam (guardados no banco D1
// do Worker em worker/) e os nomes achados para eles.
//
//   node scripts/codigos.mjs pendentes            o que falta nomear, do mais visto ao menos visto
//   node scripts/codigos.mjs pendentes --json     o mesmo em JSON
//   node scripts/codigos.mjs pendentes --issue    atualiza a issue "Códigos sem nome pendentes" (CI)
//   node scripts/codigos.mjs publicar             manda data/shared_names.json para o Worker
//
// Precisa de KISKWATCH_ADMIN_TOKEN (o ADMIN_TOKEN do Worker); sem ele, avisa e
// sai sem erro. --issue usa GITHUB_TOKEN e GITHUB_REPOSITORY, que o Actions dá.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const [command, ...args] = process.argv.slice(2);
const ISSUE_TITLE = 'Códigos sem nome pendentes';

const read = (f) => readFileSync(join(root, f), 'utf8');
const data = (f) => JSON.parse(read(join('data', f)));
/** O endereço do Worker é o mesmo que o app usa. */
const URL = /pub const URL: &str = "([^"]*)"/.exec(read('src-tauri/src/share.rs'))?.[1];

/** Tipo no banco ↔ lista em data/shared_names.json. */
const KINDS = { npc: 'npcs', npc_skill: 'npc_skills', skill: 'skills', effect: 'effects' };
const LABELS = { npc: 'Monstros', npc_skill: 'Skills de monstro', skill: 'Skills de jogador', effect: 'Efeitos' };

function token() {
  const t = process.env.KISKWATCH_ADMIN_TOKEN;
  if (!t || !URL) {
    console.log('Sem KISKWATCH_ADMIN_TOKEN (ou sem URL em share.rs): nada a fazer.');
    process.exit(0);
  }
  return t;
}

async function worker(path, init = {}) {
  const res = await fetch(`${URL}${path}`, { ...init, headers: { authorization: `Bearer ${token()}`, 'content-type': 'application/json', ...init.headers } });
  if (!res.ok) throw new Error(`o Worker respondeu ${res.status}: ${await res.text()}`);
  return res;
}

/** Já nomeado em data/ (o Worker só sabe dos nomes que recebeu). */
export function named(kind, code) {
  const npcs = data('npc_names.json');
  const shared = data('shared_names.json');
  if (shared[KINDS[kind]]?.[code]) return true;
  if (kind === 'npc') return !!(npcs.npcs[code] || data('boss_names.json')[code]);
  if (kind === 'npc_skill') return !!npcs.skills[code];
  if (kind === 'effect') return !!data('abnormals.json')[code]?.[0];
  return false;
}

const uniq = (list) => [...new Set(list)].filter((x) => x !== null && x !== undefined);
const max = (list, key) => Math.max(0, ...list.map((x) => x[key] ?? 0));
const day = (ms) => new Date(ms).toISOString().slice(0, 10);

/** O contexto que ajuda a achar o nome, por tipo. */
function context(c) {
  const s = c.seen;
  if (c.kind === 'npc') return `${s.some((x) => x.boss) ? 'chefe · ' : ''}maior dano do grupo ${max(s, 'max_group_damage')} · skills ${uniq(s.flatMap((x) => x.skills)).slice(0, 6).join(' ')}`;
  if (c.kind === 'npc_skill') return `monstro ${uniq(s.map((x) => x.npc)).join(' ')} · média ${max(s, 'avg')} · maior ${max(s, 'max')}`;
  if (c.kind === 'skill') return `classe ${uniq(s.map((x) => x.class)).join(' ') || '?'}`;
  return `skill que aplicou ${uniq(s.map((x) => x.skill)).join(' ') || '?'}`;
}

export function markdown({ codes, notes }) {
  const out = [];
  for (const kind of Object.keys(KINDS)) {
    const list = codes.filter((c) => c.kind === kind);
    if (!list.length) continue;
    out.push(`## ${LABELS[kind]} (${list.length})`, '', '| Código | Relatórios | Regiões | Visto | Contexto |', '|---|---|---|---|---|');
    for (const c of list.slice(0, 150)) out.push(`| ${c.code} | ${c.reports} | ${c.regions.join(' ')} | ${day(c.first)} a ${day(c.last)} | ${context(c)} |`);
    out.push('');
  }
  if (notes.length) {
    out.push('## Notas dos jogadores', '', '~~~text');
    for (const n of notes.slice(0, 100)) out.push(`${day(n.at)} v${n.app} região ${n.region}: ${n.note.replace(/\s+/g, ' ').replaceAll('~~~', '~ ~ ~')}`);
    out.push('~~~', '');
  }
  return out.join('\n') || 'Nenhum código sem nome pendente.';
}

async function issue(body) {
  const repo = process.env.GITHUB_REPOSITORY;
  const gh = (path, init = {}) => fetch(`https://api.github.com/repos/${repo}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${process.env.GITHUB_TOKEN}`, accept: 'application/vnd.github+json', 'user-agent': 'kiskwatch-codigos', ...init.headers },
  });
  const found = (await (await gh(`/issues?state=open&labels=codigos-desconhecidos&per_page=50`)).json()).find((i) => i.title === ISSUE_TITLE);
  const text = `${body}\n\n---\nAtualizada todo dia pelo workflow **Códigos sem nome**. Para nomear: adicione os nomes em \`data/shared_names.json\` num PR; ao mesclar, eles vão para o Worker e chegam aos apps em algumas horas.`;
  const res = found
    ? await gh(`/issues/${found.number}`, { method: 'PATCH', body: JSON.stringify({ body: text }) })
    : await gh('/issues', { method: 'POST', body: JSON.stringify({ title: ISSUE_TITLE, body: text, labels: ['codigos-desconhecidos'] }) });
  if (!res.ok) throw new Error(`GitHub respondeu ${res.status}: ${await res.text()}`);
  console.log(`Issue ${found ? 'atualizada' : 'criada'}: ${(await res.json()).html_url}`);
}

async function pendentes() {
  const all = await (await worker('/pendentes')).json();
  const left = { ...all, codes: all.codes.filter((c) => !named(c.kind, c.code)) };
  if (args.includes('--json')) console.log(JSON.stringify(left, null, 1));
  else if (args.includes('--issue')) await issue(markdown(left));
  else console.log(markdown(left));
}

async function publicar() {
  const shared = data('shared_names.json');
  const list = Object.entries(KINDS).flatMap(([kind, key]) =>
    Object.entries(shared[key] ?? {}).map(([code, name]) => ({ kind, code: Number(code), name, source: 'data/shared_names.json' })));
  await worker('/nomes', { method: 'PUT', body: JSON.stringify(list) });
  console.log(`${list.length} nome(s) publicados no Worker.`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (command === 'pendentes') await pendentes();
  else if (command === 'publicar') await publicar();
  else {
    console.error('use: node scripts/codigos.mjs pendentes [--json|--issue] | publicar');
    process.exit(1);
  }
}
