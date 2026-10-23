# DPS

O medidor de dano e cura: grava as lutas e mostra quanto cada jogador causou.

## Gravação

- Por padrão, a gravação **começa sozinha no seu primeiro golpe** e termina depois de 30 segundos sem dano. Em **Configurações** dá para mudar para começar só pelo botão.
- **Gravar agora** e **Parar** funcionam aqui, no overlay de DPS ou pelo atalho de teclado (Ctrl+Alt+D por padrão).
- **Limpar** zera a gravação em andamento, sem salvar, e tira a última da tela do overlay.

## Gravações salvas

Escolha uma gravação na lista para ver:

- dano e cura por jogador, contra **todos**, só **monstros** ou só **chefes**;
- dano por skill, golpes, críticos e maior golpe;
- a linha do tempo da luta, o tempo parado e o uso das recargas;
- o dano que cada jogador recebeu, por skill de monstro;
- buffs e debuffs.

Dá para renomear, apagar e **exportar a gravação como imagem** para colar no Discord.

### Por que dois jogadores veem números diferentes

Cada app grava do seu jeito: começa no primeiro golpe de quem grava e para depois de 30 s sem dano (ou no botão). Por isso o tempo total muda de uma gravação para outra, e o dano por segundo em **All** e **Mob** muda junto.

No filtro **Boss**, o dano por segundo conta do primeiro ao último golpe de qualquer jogador no chefe, igual em todas as gravações da mesma luta e igual à visão **por chefe**. Mesmo assim, o jogo só manda a cada um o que acontece perto dele: quem estava longe pode ver menos golpes dos outros.

## Por chefe

A visão **por chefe** junta as lutas contra o mesmo chefe e compara uma luta com a sua melhor. O tempo é o do primeiro ao último golpe no chefe. Clique numa luta (**Detalhes ▾**) para abrir o **detalhamento** logo abaixo dela, já com o filtro **Boss**: dano por jogador e por skill, linha do tempo, dano recebido e a comparação com a melhor luta. Clique de novo para fechar, ou em **Abrir em Gravações** para vê-la na lista de gravações com o mesmo filtro.

## Overlay de DPS

O overlay mostra a gravação em andamento (ou a última) com até 6 jogadores. Ligue em **Configurações > Overlays**.
