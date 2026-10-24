# Privacidade

O Kiskwatch não tem conta, anúncios nem telemetria, e não vende nada a ninguém. Quase tudo fica no seu computador; abaixo está tudo o que sai dele, e quando.

## O que fica no seu computador

- **Configurações, pets, checklist, builds salvas, perfil seguido e gravações de DPS**, no `state.json` da pasta de dados do app (`%APPDATA%\io.github.leogimenes.kiskwatch`). As gravações têm os nomes, classes e o dano dos jogadores que lutaram perto de você.
- **O registro de erros**, em `%LOCALAPPDATA%\Kiskwatch\logs`.
- **As imagens que você salva**, em Imagens\Kiskwatch. Por padrão elas mostram só o seu nome; os outros viram "Jogador 2", "Jogador 3"…
- **O tráfego do jogo** é lido na hora e descartado. Nenhum pacote é guardado nem enviado.

Para apagar tudo, desinstale o Kiskwatch e apague essas pastas.

## O que sai do seu computador

- **Site oficial do AION 2** (aion2.plaync.com): a busca de um personagem e o perfil público dele, quando você pede nas abas Build e Grupo. O perfil que você segue é lido de novo a cada 20 minutos, e só com a aba Build aberta. Com a opção ligada em Configurações, o nível do item e o poder de combate dos jogadores nas barras do DPS são buscados pelo nome, cada um no máximo a cada 2 horas. As figuras de itens e skills vêm do site de arquivos do jogo.
- **dbaion2.ru**: a lista de skills, pontos e tabuleiros Daevanion, baixada uma vez por semana.
- **GitHub**: procura versão nova a cada 6 horas.
- **Servidor do Kiskwatch (Cloudflare)**: a tabela de nomes achados é baixada a cada 6 horas. Os códigos sem nome só vão se você aceitar o termo em Configurações > Ajudar a traduzir: códigos de monstros, skills e efeitos, contagens, a classe que usou a skill, a versão do app e a região. Nunca vão nomes de personagens, chat, servidor, conta ou pacotes, e o endereço IP não é guardado. A nota opcional aparece na lista pública: não escreva nela seu nome, contato ou dados da sua conta.
- **Links** (como o mapa do Aion 2 Timers) só abrem no navegador quando você clica.

## Cada pedido, um por um

Todo pedido se identifica como "Kiskwatch (github.com/leogimenes/kiskwatch)" e leva o seu endereço IP, como qualquer acesso à internet. Fora isso, vai só o que está abaixo.

- **api-search.plaync.com**, quando você busca um nome (Build e Grupo): o nome digitado, a região e o servidor.
- **aion2.plaync.com**, quando você abre um perfil, para reler o seguido (a cada 20 min, com a aba Build aberta) e, se ligado, para o nível e o poder nas barras do DPS: o código do personagem, a região e o servidor; para as barras, o nome que o jogo mostrou.
- **dbaion2.ru**, uma vez por semana: nada, só baixa a lista.
- **github.com**, a cada 6 horas e ao instalar uma versão: nada, só baixa o `latest.json` e o instalador.
- **Servidor do Kiskwatch, tabela de nomes**, a cada 6 horas: nada, só baixa a tabela.
- **Servidor do Kiskwatch, envio de códigos**, depois de cada gravação e só com o termo aceito: códigos, contagens, classe, versão do app, região e a nota opcional.

Os pacotes do jogo, o registro de erros e as gravações nunca saem do seu computador.

## Os outros jogadores

O dano e o nome de quem luta perto de você aparecem no overlay e nas gravações. Use isso para melhorar o seu jogo e o do seu grupo, e não publique o nome ou os números de ninguém sem o consentimento da pessoa.
