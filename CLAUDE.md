# Kiskwatch

Overlay e painel para AION 2 (Tauri 2 + Rust + TypeScript). Leo escreve em pt-BR; responda e escreva textos do app em pt-BR.

## Versionamento (semver)

A versão segue [semver](https://semver.org/lang/pt-BR/): `MAJOR.MINOR.PATCH`, com tags `vX.Y.Z`.

- **PATCH** (`0.4.1 → 0.4.2`): só correções, sem nada novo para o usuário aprender.
- **MINOR** (`0.4.2 → 0.5.0`): funcionalidade nova ou mudança visível que não quebra o que o usuário já tem.
- **MAJOR** (`0.5.0 → 1.0.0`): quebra compatibilidade, como um `state.json` antigo que deixa de abrir sem migração, configurações perdidas ou um requisito novo de instalação. Enquanto estivermos em `0.x`, uma quebra dessas sobe o MINOR e precisa vir explicada nas notas.
- Sufixo de pré-release (`1.0.0-beta.1`) sai como prerelease no GitHub e o atualizador automático não oferece.

Regras:

- A versão fica em `src-tauri/tauri.conf.json`, `package.json`, `package-lock.json`, `src-tauri/Cargo.toml`, `crates/core/Cargo.toml` e `Cargo.lock`. Nunca edite à mão: use `node scripts/version.mjs bump <patch|minor|major|X.Y.Z>`, que troca todos juntos.
- **PRs de funcionalidade ou correção não mexem na versão.** O CI (`version.mjs check-pr`) reprova um PR que mude a versão fora de um branch `release/vX.Y.Z`.
- A versão só sobe num **PR de release**: branch `release/vX.Y.Z`, título `Release vX.Y.Z`, com nada além do bump. Escolha o tipo pelo maior impacto entre os PRs mesclados desde a última tag.
- Os títulos dos PRs viram as notas da release (`--generate-notes`), então escreva títulos que façam sentido para quem usa o app.

## Releases

1. Abra o PR de release: aba Actions > **Preparar release** > Run workflow (escolha patch/minor/major), ou localmente `node scripts/version.mjs bump minor` num branch `release/vX.Y.Z` e abra o PR.
2. O CI roda os testes e o build do Windows no branch; o instalador fica como artefato para testar antes.
3. Ao mesclar, o workflow **Release** (`.github/workflows/release.yml`) gera o instalador, cria a tag `vX.Y.Z` no commit do merge e publica a release com:
   - `Kiskwatch_X.Y.Z_x64-setup.exe`
   - `SHA256SUMS.txt` (formato do `sha256sum`)
   - `latest.json` (`version`, `tag`, `installer.url`, `installer.sha256`, `installer.size`), lido pelo atualizador em `https://github.com/leogimenes/kiskwatch/releases/latest/download/latest.json`.
4. Se o workflow falhar, conserte na `main` só se o problema for do workflow; "Re-run jobs" na execução tenta de novo, e nada é publicado antes do último passo.

Não crie tags nem releases à mão.

## Desenvolvimento

- Testes do núcleo: `cargo test -p kiskwatch-core`. Frontend: `npm run build` (inclui `tsc`).
- O build do Windows não roda em PR, a não ser com o label `build-windows`.
