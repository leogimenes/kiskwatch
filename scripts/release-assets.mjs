// Monta os arquivos da release a partir do instalador gerado pelo `tauri build`.
//
//   node scripts/release-assets.mjs <pasta de saída>
//
// Na pasta de saída ficam:
//   Kiskwatch_X.Y.Z_x64-setup.exe   o instalador
//   SHA256SUMS.txt                  "<sha256 hex>  <arquivo>", no formato do sha256sum
//   latest.json                     o que o atualizador do app lê para saber se há versão nova
// O atualizador busca https://github.com/<repo>/releases/latest/download/latest.json.
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = process.argv[2];
if (!out) {
  console.error('uso: node scripts/release-assets.mjs <pasta de saída>');
  process.exit(1);
}

const conf = JSON.parse(readFileSync(join(root, 'src-tauri/tauri.conf.json'), 'utf8'));
const version = conf.version;
const tag = `v${version}`;
const repo = process.env.GITHUB_REPOSITORY ?? 'leogimenes/kiskwatch';
const installer = `${conf.productName}_${version}_x64-setup.exe`;
const built = join(root, 'target/release/bundle/nsis', installer);

mkdirSync(out, { recursive: true });
copyFileSync(built, join(out, installer));
const sha256 = createHash('sha256').update(readFileSync(built)).digest('hex');

writeFileSync(join(out, 'SHA256SUMS.txt'), `${sha256}  ${installer}\n`);
writeFileSync(
  join(out, 'latest.json'),
  JSON.stringify(
    {
      version,
      tag,
      published_at: new Date().toISOString(),
      notes_url: `https://github.com/${repo}/releases/tag/${tag}`,
      installer: {
        name: installer,
        url: `https://github.com/${repo}/releases/download/${tag}/${installer}`,
        sha256,
        size: statSync(built).size,
      },
    },
    null,
    2,
  ) + '\n',
);
console.log(`${installer} ${sha256}`);
