# Worker de códigos sem nome

Recebe do Kiskwatch os códigos que o app não soube nomear (monstros, skills de monstro, skills de jogador e efeitos) e guarda num banco Cloudflare D1. Os nomes achados para eles voltam ao app pela rota pública `/nomes`. O app só envia se o jogador aceitar o termo (Configurações > Ajudar a traduzir).

O relatório traz só códigos e números: quantas vezes apareceram, dano, a classe que usou a skill, a versão do app e a região. O Worker recusa qualquer campo fora desse formato, não guarda IP nem cabeçalhos e aceita no máximo 6 envios por hora de cada IP. O banco só é acessível pelo Worker.

| Rota | Quem | O quê |
|---|---|---|
| `POST /` | o app | um relatório |
| `GET /nomes` | qualquer um | os nomes, por tipo (o app baixa a cada 6 h) |
| `GET /pendentes` | com `ADMIN_TOKEN` | os códigos ainda sem nome, agregados, e as notas |
| `PUT /nomes` | com `ADMIN_TOKEN` | grava nomes |

As tabelas são criadas sozinhas no primeiro pedido.

## Ligar o banco (uma vez, pelo painel da Cloudflare)

1. **Criar o banco.** Vá em *Storage & Databases* > *D1 SQL Database* > *Create*, com o nome `kiskwatch-codigos`.
2. **Ligar ao Worker.** No Worker `kiskwatch-codigos`, abra *Settings* > *Bindings* > *Add* > *D1 database*. Use o nome da variável `DB` e escolha o banco `kiskwatch-codigos`.
3. **Chave do administrador.** Gere uma senha longa, com 32 caracteres ou mais (um gerador de senhas serve). No Worker, em *Settings* > *Variables and Secrets*, adicione um *Secret* `ADMIN_TOKEN` com essa senha.
4. **Colar o código novo.** Em *Edit code*, troque o conteúdo pelo [index.js](https://raw.githubusercontent.com/leogimenes/kiskwatch/main/worker/src/index.js) e clique em *Deploy*.
5. **Secret no GitHub.** No repositório, vá em *Settings* > *Secrets and variables* > *Actions* > *New repository secret* e crie `KISKWATCH_ADMIN_TOKEN` com a mesma senha do passo 3.
6. **Limpeza.** O Worker não abre mais issues: apague o secret `GITHUB_TOKEN` e as variáveis `REPO` e `LABEL` do Worker, e revogue o token no GitHub.

Para testar, abra `https://<seu-worker>.workers.dev/nomes` no navegador. A resposta esperada é `{"npcs":{},"npc_skills":{},"skills":{},"effects":{}}`.

## Usar os dados

- O workflow **Códigos sem nome** atualiza todo dia a issue "Códigos sem nome pendentes" com o que falta nomear, do mais visto ao menos visto, e as notas dos jogadores. Também roda pela aba Actions > *Run workflow*.
- Para nomear, ponha os nomes em `data/shared_names.json` (`{"npcs": {"2001234": "Nome"}, ...}`) num PR. Ao mesclar, o workflow manda para o Worker, e os apps baixam em até 6 horas, sem precisar de versão nova.
- Localmente: `KISKWATCH_ADMIN_TOKEN=... node scripts/codigos.mjs pendentes`.
