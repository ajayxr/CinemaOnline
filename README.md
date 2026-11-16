# CinemaOnline

Assista a vídeos em sincronia com até 4 pessoas, com voz e chat em tempo real. O aplicativo usa HTML, CSS e JavaScript; um servidor estático Node.js sem dependências cuida apenas dos arquivos e cabeçalhos HTTP. Não há backend para as salas, banco de dados nem login.

## Recursos

- Crie uma sala e convide amigos por link (`.../#sala=codigo`)
- No máximo 4 participantes por sala (o 5º é recusado)
- Vídeos do YouTube ou links diretos (`.mp4`, `.webm`, `.m3u8`), com play, pausa e avanço sincronizados para todos
- Controles próprios da sala: **voltar 30s**, **play/pausar**, **avançar 30s** e barra de progresso
  - Atalhos: **Espaço**/**K** para play/pausar, **←**/**J** para voltar 30s, **→**/**L** para avançar 30s
  - Arrastar a barra do próprio YouTube também sincroniza
- Voz em tempo real via WebRTC, com botão de mudo (atalho **M**), confirmação sonora ao mutar/desmutar e indicador de quem está falando
  - Sem acesso ao microfone, o ícone fica desligado. Ao tentar ativá-lo, o site solicita a permissão ao navegador e conecta o microfone sem recarregar a sala. Se o acesso estiver bloqueado, orienta como liberar nas permissões do site.
  - As chamadas começam com uma faixa de áudio válida; a captura real substitui essa faixa assim que o microfone estiver pronto, nos dois sentidos.
  - Se a captura for interrompida, o ícone fica desligado e é possível tentar ativá-la novamente sem sair da sala.
- **Anti-ruído com IA** (desligado por padrão, ativável na barra superior): reduz ruídos de fundo
  - Filtro passa-alta: corta graves como batidas na mesa e pancadas
  - [RNNoise](https://github.com/xiph/rnnoise) (rede neural): reduz chiado, ventilador e teclado, sem os bloqueios adicionais de voz que podiam silenciar a fala
  - Alternar o filtro não reinicia a captura do microfone
  - O áudio direto continua ativo durante a inicialização do RNNoise; o filtro só fica disponível depois da confirmação do processador, com saída mono para a chamada
  - Com o filtro desligado, a captura é enviada diretamente, com a supressão básica do navegador
  - Se o filtro falhar ou seu contexto de áudio for suspenso, o envio volta automaticamente à captura direta, com um aviso
- Chat da sessão: fica só na memória e some quando a sala é encerrada
  - Seletor com 36 emojis, organizados em reações, cinema e boas vibrações; insere na posição do cursor
  - No celular, controles com área de toque de pelo menos 44 px e grades que se ajustam à tela, sem nomes de participantes expandirem a página
  - Mensagens de voz: clique em **Gravar áudio**, depois em **Parar gravação**; ouça a prévia e escolha **Enviar áudio** ou **Cancelar**
  - A gravação usa uma captura separada: funciona mesmo com a chamada no mudo, sem desmutar sua voz ao vivo
  - Até 60 segundos e 1 MB por áudio; sem reprodução automática. Os áudios são enviados aos participantes e entram no histórico temporário para quem chega depois
  - Histórico limitado às 200 mensagens mais recentes e a 8 MB de áudio por navegador; o anfitrião compartilha as últimas 100 mensagens com novos participantes

## Como funciona

- A conexão é ponto a ponto (WebRTC) usando [PeerJS](https://peerjs.com/). O servidor público do PeerJS serve só para os navegadores se encontrarem.
- Quem cria a sala é o **anfitrião**. Ele controla o limite de vagas, repassa o chat e os comandos do vídeo e envia o estado atual para quem entra depois.
- A entrada e a lista de participantes não esperam a configuração do microfone; a conexão de voz começa assim que o áudio estiver pronto.
- A sala existe enquanto a página do anfitrião estiver aberta. Se o anfitrião sair, a sala é encerrada para todos.
- Não há expiração por tempo de filme ou heartbeat atrasado. Uma interrupção temporária da conexão não fecha o vídeo; o convidado tenta reconectar automaticamente e sincroniza a posição quando a conexão volta.
- A vaga de um participante em reconexão é preservada. Use **Sair** para liberar sua vaga; fechar a página abruptamente pode deixá-la reservada até o fim da sala.

## Executar

O site precisa estar em `http://localhost` ou `https://` para o microfone e o YouTube funcionarem:

```bash
# Node.js 22 ou mais recente, na pasta do projeto
npm start
```

Abra `http://localhost:8080`.

Para convidar amigos de outras redes, publique a pasta em qualquer hospedagem estática com HTTPS, como GitHub Pages, Netlify, Vercel ou Cloudflare Pages.

### Railway: um único serviço

- Publique estas alterações no **serviço atual**, mantendo o mesmo repositório e domínio. Não crie outro serviço.
- O `Dockerfile` faz o Railway usar Node.js e executar `node server.cjs`, sem instalar dependências. Se houver um comando de inicialização personalizado no painel, remova-o ou ajuste-o para `npm start`.
- O servidor escuta em `0.0.0.0` na variável `PORT` fornecida pelo Railway; localmente, usa a porta 8080. O caminho `/` pode ser usado como healthcheck.
- O servidor só entrega arquivos estáticos. Chat, voz e sincronização continuam P2P; não há banco, autenticação, armazenamento de mensagens ou serviços novos.
- A política HTTP permite áudio `blob:` (prévia e mensagens de voz), WebAssembly do RNNoise, WebSockets do PeerJS, YouTube e HLS. A permissão de microfone continua sendo solicitada pelo navegador.
- HTML, scripts, estilos e WASM usam `Cache-Control: no-cache` com ETag: o navegador revalida os arquivos antes de reutilizá-los. Os recursos atualizados também têm uma versão na URL para evitar misturar o novo HTML com scripts antigos.
- Depois do deploy, recarregue o site no celular. Para conferir a configuração publicada, a resposta de `/` deve conter `media-src 'self' blob:` e `'wasm-unsafe-eval'` no cabeçalho `Content-Security-Policy`, além de `Cache-Control: no-cache`.

O modo puramente estático (`python -m http.server 8080` ou outra hospedagem) continua funcionando. Em hospedagens que enviam uma política CSP própria, ela também precisa permitir áudio `blob:` e WebAssembly; uma política enviada pelo servidor não pode ser relaxada pelo HTML.

## Limitações

- Alguns vídeos do YouTube bloqueiam a incorporação e não podem ser reproduzidos.
- O navegador embutido do VS Code não tem os codecs do YouTube e mostra a tela preta. Use Chrome, Edge, Firefox ou Safari.
- Links diretos dependem de o servidor do vídeo permitir a reprodução no navegador. Páginas de sites como Netflix não funcionam.
- Em redes muito restritivas (algumas corporativas), a conexão P2P pode falhar.
- O sistema operacional pode suspender o navegador ou o microfone em segundo plano, especialmente em celulares. Mantenha a página do anfitrião aberta e ativa; a recuperação depende de a rede e o navegador voltarem a funcionar.

## Testes

Com Node.js instalado, execute os testes de áudio, permissões, reconexão, emojis e mensagens de voz:

```bash
npm test
```
