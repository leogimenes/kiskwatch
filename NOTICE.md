# Créditos e código de terceiros

Kiskwatch é distribuído sob a GPL-3.0 (veja `LICENSE`) porque reaproveita código e dados de projetos GPL-3.0:

- **A2Tools DPS Meter**: https://github.com/taengu/A2Tools-DPS-Meter (GPL-3.0)
  - `crates/core/src/framing.rs`: separação de pacotes e bundles LZ4, copiado sem mudanças de lógica.
  - `crates/core/src/boss_map.rs`: leitura do mapa de field bosses (`01 91`), com `Serialize`/`Deserialize` adicionados.
  - `crates/core/src/varint.rs`: `read_varint` copiado do `stream_processor.rs`.
  - `crates/core/src/testdata/boss_map_*.hex`: capturas de teste.
  - `src-tauri/src/pcap.rs`: FFI da libpcap/Npcap, listagem de dispositivos, filtro de captura e leitura dos quadros, de `pcap_capturer.rs`.
  - `crates/core/src/dispatch.rs`: a ideia de achar a conexão do jogo pela taxa do terminador `0E 00 36`, de `capture_dispatcher.rs` (código próprio).
  - `crates/core/src/combat.rs`: leitura própria de dano, cura, jogadores, invocações e NPCs, seguindo os formatos de registro (`04 38`, `05 38`, `33 36`, `45 36`, `41 36`) documentados no `stream_processor.rs`.
  - `data/combat.json`: gerado por `scripts/import-a2tools-combat.mjs` a partir de `src/data/dot_skill_ids.json`, `resource_restore_skills.json` e `i18n/npcs/pt.json` (códigos dos chefes).
  - `public/classes/*.png`: escudos das classes, de `src/assets`.
- **A2Tools Plugins**: https://github.com/taengu/A2Tools-Plugins (GPL-3.0)
  - Formato dos registros de pets (`00 90`, `0D 90`, `14 90`) do plugin Pet Soul Tracker.
  - `data/*.json`: gerados por `scripts/import-a2tools-data.mjs` a partir de `pet-souls/pets.js`, `pet-souls/sources.js` e `event-timers/schedule.js`.

Dados consultados em tempo de execução (não distribuídos com o Kiskwatch):

- Perfil público dos personagens no site oficial do AION 2 (aion2.plaync.com). Endpoints como documentados por https://github.com/nuriland/aion2-api (MIT).
- Pontos de skill, fontes, tabuleiros Daevanion e skills da https://dbaion2.ru, baixados pelo app e guardados em cache na pasta de dados.

Kiskwatch não tem afiliação com a NCSoft nem com os autores do A2Tools.
