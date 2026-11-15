# CinemaOnline

Assista a vídeos em sincronia com até 4 pessoas, com voz e chat em tempo real. Feito só com HTML, CSS e JavaScript: não tem backend, banco de dados nem login.

## Recursos

- Crie uma sala e convide amigos por link (`.../#sala=codigo`)
- No máximo 4 participantes por sala (o 5º é recusado)
- Vídeos do YouTube ou links diretos (`.mp4`, `.webm`, `.m3u8`), com play, pausa e avanço sincronizados para todos
- Controles próprios da sala: **voltar 30s**, **play/pausar**, **avançar 30s** e barra de progresso
  - Atalhos: **Espaço**/**K** para play/pausar, **←**/**J** para voltar 30s, **→**/**L** para avançar 30s
  - Arrastar a barra do próprio YouTube também sincroniza
- Voz em tempo real via WebRTC, com botão de mudo (atalho **M**) e indicador de quem está falando
- **Anti-ruído com IA** (desligado por padrão, ativável na barra superior): reduz ruídos de fundo
  - Filtro passa-alta: corta graves como batidas na mesa e pancadas
  - [RNNoise](https://github.com/xiph/rnnoise) (rede neural): remove chiado, ventilador e teclado, e silencia trechos em que não detecta voz
  - Gate de voz ([audio/voiceGateWorklet.js](audio/voiceGateWorklet.js)): só abre com som sustentado na faixa da fala, se adapta ao ruído de fundo do ambiente e não corta o início das palavras (atraso extra de ~100 ms)
  - Se o navegador não suportar, usa a supressão de ruído padrão do navegador
- Chat da sessão: fica só na memória e some quando a sala é encerrada

## Como funciona

- A conexão é ponto a ponto (WebRTC) usando [PeerJS](https://peerjs.com/). O servidor público do PeerJS serve só para os navegadores se encontrarem.
- Quem cria a sala é o **anfitrião**. Ele controla o limite de vagas, repassa o chat e os comandos do vídeo e envia o estado atual para quem entra depois.
- A entrada e a lista de participantes não esperam a configuração do microfone; a conexão de voz começa assim que o áudio estiver pronto.
- A sala existe enquanto a página do anfitrião estiver aberta. Se o anfitrião sair, a sala é encerrada para todos.

## Executar

O site precisa estar em `http://localhost` ou `https://` para o microfone e o YouTube funcionarem:

```bash
# na pasta do projeto
python -m http.server 8080
# ou
npx serve .
```

Abra `http://localhost:8080`.

Para convidar amigos de outras redes, publique a pasta em qualquer hospedagem estática com HTTPS, como GitHub Pages, Netlify, Vercel ou Cloudflare Pages.

## Limitações

- Alguns vídeos do YouTube bloqueiam a incorporação e não podem ser reproduzidos.
- O navegador embutido do VS Code não tem os codecs do YouTube e mostra a tela preta. Use Chrome, Edge, Firefox ou Safari.
- Links diretos dependem de o servidor do vídeo permitir a reprodução no navegador. Páginas de sites como Netflix não funcionam.
- Em redes muito restritivas (algumas corporativas), a conexão P2P pode falhar.