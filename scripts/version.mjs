// Versão do app (semver), guardada em seis arquivos que precisam andar juntos.
//
//   node scripts/version.mjs get                 imprime a versão atual
//   node scripts/version.mjs check               confere que todos os arquivos têm a mesma versão
//   node scripts/version.mjs check-pr            no CI: só PR de release (release/vX.Y.Z) muda a versão, e para cima
//   node scripts/version.mjs bump <patch|minor|major|X.Y.Z>   troca a versão em todos os arquivos
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?$/;

// Cada arquivo: como ler a versão e como trocá-la sem reformatar o resto.
const FILES = [
  ['src-tauri/tauri.conf.json', /^(  "version": ")([^"]+)(")/m],
  ['package.json', /^(  "version": ")([^"]+)(")/m],
  ['package-lock.json', /^(  "version": ")([^"]+)(")/m],
  ['package-lock.json', /^(    "": \{\n      "name": "kiskwatch",\n      "version": ")([^"]+)(")/m],
  ['src-tauri/Cargo.toml', /^(version = ")([^"]+)(")/m],
  ['crates/core/Cargo.toml', /^(version = ")([^"]+)(")/m],
  ['Cargo.lock', /^(name = "kiskwatch"\nversion = ")([^"]+)(")/m],
  ['Cargo.lock', /^(name = "kiskwatch-core"\nversion = ")([^"]+)(")/m],
];

function read(file) {
  return readFileSync(join(root, file), 'utf8').replace(/\r\n/g, '\n');
}

function versions() {
  return FILES.map(([file, re]) => {
    const m = read(file).match(re);
    if (!m) throw new Error(`versão não encontrada em ${file}`);
    return [file, m[2]];
  });
}

function current() {
  const found = versions();
  const distinct = [...new Set(found.map(([, v]) => v))];
  if (distinct.length > 1) {
    const list = found.map(([f, v]) => `  ${f}: ${v}`).join('\n');
    throw new Error(`as versões não batem:\n${list}\nUse: node scripts/version.mjs bump X.Y.Z`);
  }
  if (!SEMVER.test(distinct[0])) throw new Error(`"${distinct[0]}" não é semver (X.Y.Z)`);
  return distinct[0];
}

function parse(v) {
  const [, major, minor, patch, pre] = v.match(SEMVER);
  return { major: +major, minor: +minor, patch: +patch, pre };
}

// Ordem do semver: a pré-release (1.0.0-beta) vem antes da versão final (1.0.0).
function compare(a, b) {
  const x = parse(a);
  const y = parse(b);
  for (const k of ['major', 'minor', 'patch']) if (x[k] !== y[k]) return x[k] - y[k];
  if (x.pre === y.pre) return 0;
  if (!x.pre) return 1;
  if (!y.pre) return -1;
  return x.pre < y.pre ? -1 : 1;
}

function next(version, kind) {
  if (SEMVER.test(kind)) return kind;
  const v = parse(version);
  if (kind === 'major') return `${v.major + 1}.0.0`;
  if (kind === 'minor') return `${v.major}.${v.minor + 1}.0`;
  if (kind === 'patch') return v.pre ? `${v.major}.${v.minor}.${v.patch}` : `${v.major}.${v.minor}.${v.patch + 1}`;
  throw new Error(`use patch, minor, major ou uma versão X.Y.Z, não "${kind}"`);
}

function bump(kind) {
  const from = current();
  const to = next(from, kind);
  if (compare(to, from) <= 0) throw new Error(`${to} não é maior que ${from}`);
  const texts = new Map();
  for (const [file, re] of FILES) {
    const text = texts.get(file) ?? read(file);
    texts.set(file, text.replace(re, `$1${to}$3`));
  }
  for (const [file, text] of texts) writeFileSync(join(root, file), text);
  return to;
}

// Versão na base do PR (main), lida do git. O CI precisa ter buscado a base antes.
function baseVersion(base) {
  const text = execFileSync('git', ['show', `origin/${base}:src-tauri/tauri.conf.json`], { cwd: root, encoding: 'utf8' });
  return JSON.parse(text).version;
}

function checkPr() {
  const version = current();
  const head = process.env.GITHUB_HEAD_REF ?? '';
  const base = process.env.GITHUB_BASE_REF;
  if (!base) throw new Error('check-pr roda só em pull request (GITHUB_BASE_REF vazio)');
  const before = baseVersion(base);
  const release = head.match(/^release\/v(.+)$/);
  if (release) {
    if (release[1] !== version) throw new Error(`o branch ${head} pede ${release[1]}, mas os arquivos têm ${version}`);
    if (compare(version, before) <= 0) throw new Error(`${version} não é maior que a versão da ${base} (${before})`);
    return `release ${before} -> ${version}`;
  }
  if (version !== before) {
    throw new Error(`este PR muda a versão (${before} -> ${version}); a versão só muda num PR de release (branch release/vX.Y.Z)`);
  }
  return `versão ${version} sem mudança`;
}

try {
  const [cmd, arg] = process.argv.slice(2);
  if (cmd === 'get') console.log(current());
  else if (cmd === 'check') console.log(`versão ${current()} em todos os arquivos`);
  else if (cmd === 'check-pr') console.log(checkPr());
  else if (cmd === 'bump') console.log(bump(arg));
  else throw new Error('uso: node scripts/version.mjs <get|check|check-pr|bump patch|minor|major|X.Y.Z>');
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
