# Kiskwatch

Overlay e painel para acompanhar seus personagens de AION 2: timers de eventos e field bosses com avisos no topo da janela do jogo, coleção de pets com as almas que faltam e onde farmar, e (em breve) build e sugestões por IA.

> Projeto de fã, sem afiliação com a NCSoft. GPL-3.0.

## Estado atual

| Parte | Estado |
|---|---|
| Agenda de eventos, resets e bosses agendados | ✅ com contagem regressiva no fuso da região |
| Avisos no topo da janela do jogo (1h, 30, 15, 10, 5, 2, 1 min), só enquanto tocam | ✅ com som |
| Field bosses pelo mapa do jogo (`01 91`) | ✅ ao abrir o mapa no jogo |
| Pets: nível, almas, quanto falta, filtros, ordenação | ✅ com edição manual |
| Pets: leitura automática (`00 90`, `0D 90`, `14 90`) | ✅ no login e a cada alma coletada |
| Mapa dos spawns dos pets faltantes | ✅ esquemático com zoom, áreas das zonas e seleção; print do mapa do próprio jogador como fundo (alinhado por 3 Kibelisks); arte do mapa via link para o Aion 2 Timers |
| Overlay de pets (almas recentes, próximo da rota, fixados) | ✅ |
| Rota de farm (caminho mínimo com Kibelisks, sem IA) | ✅ no mapa e no overlay de pets |
| Ritmo de farm: almas/hora por pet e tempo até o nível 3 | ✅ no overlay de pets e na lista do painel |
| Acessibilidade (texto, contraste, daltonismo, animações, som) | ✅ |
| Captura ao vivo via Npcap | ✅ |
| Build: skills, stigmas e tabuleiros Daevanion do perfil oficial | ✅ |
| Build: pontos possíveis, fontes e custo em cristais (dados da dbaion2.ru, baixados pelo app) | ✅ |
| Build: Daevanion completo com ícones e detalhe das skills no clique | ✅ |
| Grupo: jogadores vistos no jogo (grupo, quem luta perto), busca pelo nome e perfil oficial | ✅ |
| Comparar build com outro jogador (equipamento, skills, Daevanion, atributos) e salvar builds como referência | ✅ |
| Overlay de DPS: dano e cura por jogador, All/Mob/Boss, gravações no painel | 🧪 parser próprio, a validar no jogo |
| DPS: uso das recargas por skill (usos feitos x possíveis, tempo pronta sem uso) | 🧪 a validar no jogo |
| Atalhos globais: gravar/parar o DPS e ligar/desligar os cliques nos overlays | ✅ Ctrl+Alt+D e Ctrl+Alt+X, trocáveis em Configurações |
| Dano recebido de cada monstro, skill a skill (golpes, maior golpe), nas gravações | 🧪 parser próprio, a validar no jogo |
| Checklist diária e semanal por personagem, zerada sozinha nos resets | ✅ |
| Calculadora de encantamento: tentativas, Kinah e pedras até o alvo, com sorte/azar e pior caso | ✅ chances oficiais (KR) e custos por nível do item |
| Atualizador automático: avisa da versão nova e instala com o SHA-256 conferido | ✅ a partir da primeira release |
| Sugestões por IA (opcional, chave própria) | ⏳ |

## Como funciona

- `crates/core`: o núcleo sem janela nem rede. Acha a conexão do jogo entre tudo que foi capturado (`dispatch.rs`), separa os pacotes do fluxo TCP do jogo, abre os bundles LZ4, decodifica os registros de bosses, pets e combate (`combat.rs`, somado por jogador em `dps.rs`), e calcula a agenda e os avisos. Testável em qualquer sistema: `cargo test -p kiskwatch-core`.
- `src-tauri`: o app (Tauri 2). `pcap.rs` captura o tráfego via Npcap/libpcap. Quatro janelas: o painel, dois overlays transparentes (pets e DPS), sempre no topo, que podem deixar os cliques passarem para o jogo, e o lembrete dos timers, que só aparece no topo da janela do jogo quando um aviso toca. Guarda o estado em `state.json` na pasta de dados do app.
- Atualizações: `updater.rs` lê o `latest.json` da última release do GitHub a cada 6 horas e, quando o jogador pede, baixa o instalador, confere o SHA-256 (`crates/core/src/update.rs`) e o roda no modo passivo; o app fecha e volta na versão nova.
- `src`: as telas (TypeScript + Vite).
- `data`: dados do jogo (pets, drops, spawns, Kibelisks, agenda, servidores), gerados de A2Tools-Plugins.

O app só **lê** uma cópia do tráfego de rede (como o A2Tools e a Questlog). Não lê nem altera a memória do jogo e não envia nada ao servidor.

## Desenvolvimento

Requisitos: Rust estável e Node 22. No Windows, o WebView2 já vem no Windows 10/11.

Para ler o jogo, o Kiskwatch precisa do [Npcap](https://npcap.com/#download) instalado (marque "WinPcap API-compatible Mode"). O ponto ao lado das abas mostra a captura: verde lendo o jogo, amarelo procurando, vermelho desligada. Clique nele para ver o motivo; em geral é o Npcap faltando ou o app sem permissão (abra como administrador).

```sh
npm install
npm run tauri dev      # abre o painel e os overlays
cargo test -p kiskwatch-core
npx tauri build        # gera o instalador (.exe) em target/release/bundle/nsis
```

O CI roda os testes a cada pull request (menos de um minuto). O instalador do Windows sai como artefato pelo botão "Run workflow" na aba Actions ou num pull request com o label `build-windows`, e como canary a cada push na `main`.

As versões seguem semver e saem por um PR de release (aba Actions > "Preparar release"). Ao mesclar esse PR, o GitHub cria a tag `vX.Y.Z` e publica o instalador em [Releases](https://github.com/leogimenes/kiskwatch/releases) com o `SHA256SUMS.txt`. A cada mudança que entra na `main` e passa no CI, sai também uma versão canary de teste (`0.2.3-canary.42.abc1234`), que o app instala sozinho para quem escolher o canal canary em Configurações > Versão. Detalhes no `CLAUDE.md`.

### Atualizar os dados do jogo

```sh
git clone --depth 1 https://github.com/taengu/A2Tools-Plugins ../A2Tools-Plugins
npm run import-data -- ../A2Tools-Plugins

# skills de DoT, skills de recurso, códigos dos chefes e nomes dos monstros e das skills deles, para o DPS
git clone --depth 1 https://github.com/taengu/A2Tools-DPS-Meter ../A2Tools-DPS-Meter
node scripts/import-a2tools-combat.mjs ../A2Tools-DPS-Meter
```

## Créditos

Veja `NOTICE.md`.
