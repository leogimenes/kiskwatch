# Worker de códigos sem nome

Recebe do Kiskwatch os relatórios de códigos que o app não soube nomear (monstros, skills de monstro, skills de jogador e efeitos) e abre uma issue com o label `codigos-desconhecidos` neste repositório. O app só envia se o jogador permitir (Configurações > Ajudar a traduzir).

O relatório traz só códigos e números: quantas vezes apareceram, dano, a classe que usou a skill, a versão do app e a região. O Worker recusa qualquer campo fora desse formato, não guarda IP nem cabeçalhos e aceita no máximo 6 envios por hora de cada IP.

## Publicar (uma vez)

1. **Token do GitHub.** Em GitHub > Settings > Developer settings > Fine-grained tokens, crie um token só para o repositório `kiskwatch`, com a permissão *Issues: Read and write* e nada mais.
2. **Label.** Crie no repositório o label `codigos-desconhecidos` (Issues > Labels).
3. **Conta Cloudflare.** Crie uma conta gratuita em <https://dash.cloudflare.com/sign-up>. O plano gratuito aceita 100 mil pedidos por dia.
4. **Publicar.** Nesta pasta:

   ```sh
   npx wrangler login
   npx wrangler secret put GITHUB_TOKEN   # cole o token do passo 1
   npx wrangler deploy
   ```

   O `deploy` mostra o endereço, algo como `https://kiskwatch-codigos.<sua-conta>.workers.dev`.

   Pelo painel também dá: Workers & Pages > Create > Worker, cole `src/index.js`, e em Settings > Variables adicione `REPO = leogimenes/kiskwatch`, `LABEL = codigos-desconhecidos` e o secret `GITHUB_TOKEN`.
5. **Ligar no app.** Ponha o endereço em `URL`, em `src-tauri/src/share.rs`. Enquanto `URL` estiver vazio, o app não mostra nada de compartilhamento.

## Usar os relatórios

```sh
node scripts/codigos.mjs           # o que falta nomear, do mais visto ao menos visto
node scripts/codigos.mjs --json    # o mesmo em JSON
```

Com os nomes achados (pela dbaion2, pelas notas dos jogadores ou no jogo), atualize `data/npc_names.json`, `data/boss_names.json` ou `data/abnormals.json` num PR e feche as issues usadas.
