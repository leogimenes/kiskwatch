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

### Como o dano por segundo é calculado

- **Total**: a soma dos golpes de cada jogador que chegaram ao seu app, com summons e dano contínuo.
- **Duração**: do primeiro golpe de quem grava até 30 s sem dano (ou até o botão, numa gravação iniciada à mão).
- **/s** em **All** e **Mob**: o total dividido pelo **tempo em combate**, que é a duração sem os trechos de 3 s ou mais em que ninguém do grupo agiu (caminhadas e esperas entre os pulls).
- **/s** em **Boss**: o dano no chefe dividido pelo tempo do primeiro ao último golpe de qualquer jogador nele, igual à visão **por chefe**.

### Por que dois jogadores veem números diferentes

Cada app grava um trecho: começa no primeiro golpe de quem grava e para em momentos diferentes. Os totais só batem se as gravações cobrirem o mesmo trecho; a porcentagem de cada um e o /s ficam parecidos. Além disso, o jogo só manda a cada um o que acontece perto dele: quem estava longe pode ver menos golpes dos outros.

## Por chefe

A visão **por chefe** junta as lutas contra o mesmo chefe e compara uma luta com a sua melhor. O tempo é o do primeiro ao último golpe no chefe. Clique numa luta (**Detalhes ▾**) para abrir o **detalhamento** logo abaixo dela, já com o filtro **Boss**: dano por jogador e por skill, linha do tempo, dano recebido e a comparação com a melhor luta. Clique de novo para fechar, ou em **Abrir em Gravações** para vê-la na lista de gravações com o mesmo filtro.

## Overlay de DPS

O overlay mostra a gravação em andamento (ou a última) com até 6 jogadores. Ligue em **Configurações > Overlays**.
