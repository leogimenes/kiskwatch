# Kiskwatch

Overlay e painel para acompanhar seus personagens de AION 2: timers de eventos e field bosses com avisos no overlay, coleção de pets com as almas que faltam e onde farmar, e (em breve) build e sugestões por IA.

> Projeto de fã, sem afiliação com a NCSoft. GPL-3.0.

## Estado atual

| Parte | Estado |
|---|---|
| Agenda de eventos, resets e bosses agendados | ✅ com contagem regressiva no fuso da região |
| Avisos no overlay (1h, 30, 15, 10, 5, 2, 1 min) | ✅ com som |
| Field bosses pelo mapa do jogo (`01 91`) | ✅ decodificação; falta a captura ao vivo |
| Pets: nível, almas, quanto falta, filtros, ordenação | ✅ com edição manual |
| Pets: leitura automática (`00 90`, `0D 90`, `14 90`) | ✅ decodificação; falta a captura ao vivo |
| Mapa dos spawns dos pets faltantes | 🟡 esquemático, sem a arte do mapa |
| Captura ao vivo via Npcap | ⏳ próximo passo |
| Build (Skills, Stigmas, Daevanion) | ⏳ |
| Sugestões por IA | ⏳ |

## Como funciona

- `crates/core`: o núcleo sem janela nem rede. Separa os pacotes do fluxo TCP do jogo, abre os bundles LZ4, decodifica os registros de bosses e pets, e calcula a agenda e os avisos. Testável em qualquer sistema: `cargo test -p kiskwatch-core`.
- `src-tauri`: o app (Tauri 2). Duas janelas: o painel e o overlay transparente, sempre no topo, que pode deixar os cliques passarem para o jogo. Guarda o estado em `state.json` na pasta de dados do app.
- `src`: as telas (TypeScript + Vite).
- `data`: dados do jogo (pets, drops, spawns, Kibelisks, agenda, servidores), gerados de A2Tools-Plugins.

O app só **lê** uma cópia do tráfego de rede (como o A2Tools e a Questlog). Não lê nem altera a memória do jogo e não envia nada ao servidor.

## Desenvolvimento

Requisitos: Rust estável e Node 22. No Windows, o WebView2 já vem no Windows 10/11. Para a captura ao vivo, futuramente, o [Npcap](https://npcap.com).

```sh
npm install
npm run tauri dev      # abre o painel e o overlay
cargo test -p kiskwatch-core
npx tauri build        # gera o instalador (.exe) em target/release/bundle/nsis
```

A cada pull request, o CI gera o instalador do Windows como artefato para teste.

### Atualizar os dados do jogo

```sh
git clone --depth 1 https://github.com/taengu/A2Tools-Plugins ../A2Tools-Plugins
npm run import-data -- ../A2Tools-Plugins
```

## Créditos

Veja `NOTICE.md`.
