// Junta os relatórios de códigos sem nome (issues com o label
// codigos-desconhecidos, abertas pelo Worker em worker/) e lista o que ainda
// falta nomear nas tabelas de data/, do código visto em mais relatórios para
// o menos visto, com o contexto que ajuda a achar o nome e as notas dos
// jogadores.
//
//   node scripts/codigos.mjs                 relatórios das issues abertas
//   node scripts/codigos.mjs --todas         inclui as issues fechadas
//   node scripts/codigos.mjs --json          a mesma lista em JSON
//
// GITHUB_TOKEN no ambiente é opcional (sem ele, 60 pedidos por hora).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const REPO = 'leogimenes/kiskwatch';
const LABEL = 'codigos-desconhecidos';
const args = process.argv.slice(2);

const data = (f) => JSON.parse(readFileSync(join(root, 'data', f), 'utf8'));
const names = data('npc_names.json');
const bosses = data('boss_names.json');
const abnormals = data('abnormals.json');

async function issues() {
  const out = [];
  const headers = { accept: 'application/vnd.github+json', 'user-agent': 'kiskwatch-codigos' };
  if (process.env.GITHUB_TOKEN) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  for (let page = 1; ; page++) {
    const state = args.includes('--todas') ? 'all' : 'open';
    const res = await fetch(`https://api.github.com/repos/${REPO}/issues?labels=${LABEL}&state=${state}&per_page=100&page=${page}`, { headers });
    if (!res.ok) throw new Error(`GitHub respondeu ${res.status}: ${await res.text()}`);
    const list = await res.json();
    out.push(...list.filter((i) => !i.pull_request));
    if (list.length < 100) return out;
  }
}

/** O JSON e a nota de uma issue, ou null se ela não for um relatório. */
export function parse(body) {
  const json = /### Dados\n\n```json\n([\s\S]*?)\n```/.exec(body ?? '');
  if (!json) return null;
  try {
    const report = JSON.parse(json[1]);
    const note = /~~~text\n([\s\S]*?)\n~~~/.exec(body)?.[1] ?? '';
    return { ...report, note };
  } catch {
    return null;
  }
}

/** Soma os relatórios por código, sem os que data/ já nomeia. */
export function merge(reports) {
  const kinds = { npcs: new Map(), npc_skills: new Map(), skills: new Map(), effects: new Map() };
  const named = {
    npcs: (c) => names.npcs[c] || bosses[c],
    npc_skills: (c) => names.skills[c],
    skills: () => false,
    effects: (c) => abnormals[c]?.[0],
  };
  const notes = [];
  for (const { report, app, region, note, issue } of reports) {
    if (note.trim()) notes.push({ issue, app, region, note: note.trim() });
    for (const kind of Object.keys(kinds)) {
      for (const item of report?.[kind] ?? []) {
        if (named[kind](item.code)) continue;
        const m = kinds[kind].get(item.code) ?? { code: item.code, reports: 0, issues: [], regions: new Set(), seen: [] };
        m.reports++;
        m.issues.push(issue);
        m.regions.add(region);
        m.seen.push(item);
        kinds[kind].set(item.code, m);
      }
    }
  }
  const sorted = Object.fromEntries(Object.entries(kinds).map(([k, m]) => [k, [...m.values()].sort((a, b) => b.reports - a.reports)]));
  return { ...sorted, notes };
}

const max = (list, key) => Math.max(0, ...list.map((x) => x[key] ?? 0));
const sum = (list, key) => list.reduce((n, x) => n + (x[key] ?? 0), 0);
const uniq = (list) => [...new Set(list)].filter((x) => x !== null && x !== undefined);
const refs = (m) => m.issues.slice(0, 5).map((i) => `#${i}`).join(' ');

function markdown(all) {
  const out = [];
  const table = (title, head, rows) => {
    if (!rows.length) return;
    out.push(`## ${title} (${rows.length})`, '', `| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`, ...rows.map((r) => `| ${r.join(' | ')} |`), '');
  };
  table('Monstros', ['Código', 'Relatórios', 'Chefe', 'Maior dano do grupo', 'Skills que usou', 'Issues'],
    all.npcs.map((m) => [m.code, m.reports, m.seen.some((x) => x.boss) ? 'sim' : '', max(m.seen, 'max_group_damage'), uniq(m.seen.flatMap((x) => x.skills)).slice(0, 8).join(' '), refs(m)]));
  table('Skills de monstro', ['Código', 'Relatórios', 'Monstro', 'Golpes', 'Média', 'Maior', 'Issues'],
    all.npc_skills.map((m) => [m.code, m.reports, uniq(m.seen.map((x) => x.npc)).join(' '), sum(m.seen, 'hits'), max(m.seen, 'avg'), max(m.seen, 'max'), refs(m)]));
  table('Skills de jogador', ['Código', 'Relatórios', 'Classe', 'Golpes', 'Issues'],
    all.skills.map((m) => [m.code, m.reports, uniq(m.seen.map((x) => x.class)).join(' '), sum(m.seen, 'hits'), refs(m)]));
  table('Efeitos', ['Código', 'Relatórios', 'Skill que aplicou', 'Issues'],
    all.effects.map((m) => [m.code, m.reports, uniq(m.seen.map((x) => x.skill)).join(' '), refs(m)]));
  if (all.notes.length) {
    out.push('## Notas dos jogadores', '');
    for (const n of all.notes) out.push(`- #${n.issue} (v${n.app}, região ${n.region}): ${n.note.replace(/\s+/g, ' ')}`);
  }
  return out.join('\n') || 'Nenhum código sem nome nos relatórios.';
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const reports = (await issues()).map((i) => ({ ...parse(i.body), issue: i.number })).filter((r) => r.report);
  const all = merge(reports);
  if (args.includes('--json')) {
    console.log(JSON.stringify(all, (k, v) => (v instanceof Set ? [...v] : v), 1));
  } else {
    console.log(`${reports.length} relatório(s).\n`);
    console.log(markdown(all));
  }
}
