(() => {
  'use strict';

  const PEER_PREFIX = 'cinemaonline-v1-';
  const MAX_PARTICIPANTS = 4;
  const HEARTBEAT_MS = 4000;
  const TIMEOUT_MS = 15000;
  const DRIFT_TOLERANCE = 2.5;
  const CODE_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
  const MIC_ICON = '<svg viewBox="0 0 24 24"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M6 11a6 6 0 0 0 12 0M12 17v4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
  const MIC_OFF_ICON = '<svg viewBox="0 0 24 24"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M6 11a6 6 0 0 0 12 0M12 17v4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M4 4l16 16" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg>';

  const $ = (sel, root = document) => root.querySelector(sel);
  const el = (tag, cls, text) => {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  };

  const state = {
    peer: null,
    isHost: false,
    joined: false,
    ended: false,
    roomCode: null,
    myId: null,
    myName: '',
    hostConn: null,
    lastHostMsg: 0,
    reconnecting: false,
    hostRetryAt: 0,
    filterReadyPromise: null,
    conns: new Map(),        // anfitrião: peerId -> DataConnection
    participants: new Map(), // peerId -> { id, name, muted, isHost }
    calls: new Map(),        // peerId -> MediaConnection
    audioEls: new Map(),     // peerId -> HTMLAudioElement
    chat: [],                // histórico mantido pelo anfitrião para quem chega depois
    video: { url: null },
    localStream: null,
    rawStream: null,
    micAvailable: false,
    micRequestPending: false,
    muted: true,
    mismatch: 0,
    timers: [],
  };

  /* ================= Utilidades ================= */

  function randomCode(len) {
    const bytes = crypto.getRandomValues(new Uint8Array(len));
    return Array.from(bytes, (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
  }

  function cleanName(name) {
    return String(name || '').replace(/\s+/g, ' ').trim().slice(0, 24);
  }

  function formatTime(sec) {
    sec = Math.max(0, Math.floor(sec || 0));
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = String(sec % 60).padStart(2, '0');
    return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${String(m).padStart(2, '0')}:${s}`;
  }

  function clock(ts) {
    return new Date(ts).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  }

  function hueFor(id) {
    let h = 0;
    for (const c of String(id)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
    return h % 360;
  }

  function initials(name) {
    return name.split(' ').filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase() || '?';
  }

  function baseUrl() {
    return location.href.split('#')[0];
  }

  function inviteLink() {
    return `${baseUrl()}#sala=${state.roomCode}`;
  }

  function parseRoomCode(input) {
    const s = String(input || '').trim();
    const m = s.match(/sala=([a-z0-9]{4,16})/i) || s.match(/^([a-z0-9]{4,16})$/i);
    return m ? m[1].toLowerCase() : null;
  }

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.onload = resolve;
      s.onerror = () => reject(new Error('Falha ao carregar ' + src));
      document.head.appendChild(s);
    });
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = el('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
  }

  /* ================= UI geral ================= */

  function toast(message, type = 'info', ms = 3500) {
    const t = el('div', `toast toast-${type}`, message);
    $('#toasts').appendChild(t);
    requestAnimationFrame(() => t.classList.add('show'));
    setTimeout(() => {
      t.classList.remove('show');
      setTimeout(() => t.remove(), 250);
    }, ms);
  }

  function showLoading(text) {
    $('#loading-text').textContent = text;
    $('#loading').hidden = false;
  }

  function hideLoading() {
    $('#loading').hidden = true;
  }

  function showView(name) {
    $('#view-home').hidden = name !== 'home';
    $('#view-room').hidden = name !== 'room';
  }

  function setActivity(text) {
    $('#activity-text').textContent = text;
  }

  /* ================= Player (YouTube + HTML5/HLS) ================= */

  const Player = (() => {
    const ytHost = $('#yt-host');
    const video = $('#html-player');
    const empty = $('#player-empty');
    const unlock = $('#player-unlock');

    let kind = null;          // 'youtube' | 'html' | null
    let yt = null;
    let ytReady = false;
    let ytApi = null;
    let hls = null;
    let token = 0;
    let pending = null;       // { time, playing } aplicado quando o player fica pronto
    let desiredPlaying = false;
    let suppressUntil = 0;
    let listener = () => {};

    function quiet(ms = 900) {
      suppressUntil = Math.max(suppressUntil, Date.now() + ms);
    }

    function emit(action) {
      if (Date.now() < suppressUntil) return;
      desiredPlaying = action === 'play' ? true : action === 'pause' ? false : desiredPlaying;
      listener(action, getTime());
    }

    video.addEventListener('play', () => { unlock.hidden = true; emit('play'); });
    video.addEventListener('pause', () => emit('pause'));
    video.addEventListener('seeked', () => emit('seek'));
    video.addEventListener('error', () => {
      if (kind === 'html' && video.getAttribute('src') !== null) {
        toast('Não foi possível reproduzir este vídeo. Use um link direto (.mp4, .webm, .m3u8) ou do YouTube.', 'error', 6000);
      }
    });

    unlock.addEventListener('click', () => {
      unlock.hidden = true;
      quiet(1500);
      play();
    });

    function parse(raw) {
      let text = String(raw || '').trim();
      if (!text) return null;
      if (!/^https?:\/\//i.test(text)) text = 'https://' + text;
      let u;
      try { u = new URL(text); } catch { return null; }
      if (!/^https?:$/.test(u.protocol) || !u.hostname.includes('.')) return null;

      const host = u.hostname.replace(/^(www|m|music)\./, '');
      let id = null;
      if (host === 'youtu.be') {
        id = u.pathname.slice(1).split('/')[0];
      } else if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
        if (u.pathname === '/watch') id = u.searchParams.get('v');
        else {
          const m = u.pathname.match(/^\/(embed|shorts|live|v)\/([\w-]{11})/);
          if (m) id = m[2];
        }
      }
      if (id && /^[\w-]{11}$/.test(id)) return { type: 'youtube', id, url: u.href };
      if (/\.m3u8$/i.test(u.pathname)) return { type: 'hls', url: u.href };
      return { type: 'file', url: u.href };
    }

    function loadYouTubeApi() {
      if (ytApi) return ytApi;
      ytApi = new Promise((resolve, reject) => {
        if (window.YT && window.YT.Player) return resolve();
        const prev = window.onYouTubeIframeAPIReady;
        window.onYouTubeIframeAPIReady = () => { if (prev) prev(); resolve(); };
        loadScript('https://www.youtube.com/iframe_api').catch((e) => { ytApi = null; reject(e); });
      });
      return ytApi;
    }

    function reset() {
      token++;
      quiet(1200);
      if (yt) { try { yt.destroy(); } catch { /* ignora */ } }
      yt = null;
      ytReady = false;
      ytHost.innerHTML = '';
      ytHost.hidden = true;
      if (hls) { hls.destroy(); hls = null; }
      video.pause();
      video.removeAttribute('src');
      video.load();
      video.hidden = true;
      kind = null;
      pending = null;
      desiredPlaying = false;
      unlock.hidden = true;
      empty.hidden = false;
    }

    async function load(src, { time = 0, playing = false } = {}) {
      reset();
      const myToken = token;
      quiet(3000);
      empty.hidden = true;
      pending = { time, playing };
      desiredPlaying = playing;

      if (src.type === 'youtube') {
        kind = 'youtube';
        ytHost.hidden = false;
        const mount = el('div');
        ytHost.appendChild(mount);
        try {
          await loadYouTubeApi();
        } catch {
          toast('Não foi possível carregar o player do YouTube.', 'error');
          return;
        }
        if (myToken !== token) return;
        const startAt = Math.floor(time);
        yt = new YT.Player(mount, {
          width: '100%',
          height: '100%',
          videoId: src.id,
          playerVars: { playsinline: 1, rel: 0, modestbranding: 1, start: startAt },
          events: {
            onReady: () => {
              if (myToken !== token) return;
              ytReady = true;
              quiet(1500);
              const p = pending || { time: 0, playing: false };
              pending = null;
              if (p.playing) {
                if (Math.abs(p.time - startAt) > 1) yt.seekTo(p.time, true);
                yt.playVideo();
                watchAutoplay();
              } else if (Math.abs(p.time - startAt) > 1) {
                yt.seekTo(p.time, true);
                setTimeout(() => { if (!desiredPlaying && ytReady) { quiet(); yt.pauseVideo(); } }, 400);
              }
            },
            onStateChange: (e) => {
              if (e.data === YT.PlayerState.PLAYING) { unlock.hidden = true; emit('play'); }
              else if (e.data === YT.PlayerState.PAUSED) emit('pause');
            },
            onError: () => toast('O YouTube não permitiu reproduzir este vídeo (pode estar bloqueado para incorporação).', 'error', 6000),
          },
        });
        return;
      }

      kind = 'html';
      video.hidden = false;
      video.addEventListener('loadedmetadata', () => {
        if (myToken !== token) return;
        quiet(1500);
        const p = pending || { time: 0, playing: false };
        pending = null;
        if (p.time) video.currentTime = p.time;
        if (p.playing) play();
      }, { once: true });

      if (src.type === 'hls' && !video.canPlayType('application/vnd.apple.mpegurl')) {
        try {
          if (!window.Hls) await loadScript('https://cdn.jsdelivr.net/npm/hls.js@1/dist/hls.min.js');
        } catch { /* tenta reprodução nativa abaixo */ }
        if (myToken !== token) return;
        if (window.Hls && window.Hls.isSupported()) {
          hls = new window.Hls();
          hls.loadSource(src.url);
          hls.attachMedia(video);
          return;
        }
      }
      video.src = src.url;
    }

    function ready() {
      if (kind === 'youtube') return ytReady;
      if (kind === 'html') return video.readyState >= 1;
      return false;
    }

    function getTime() {
      if (kind === 'youtube') return ytReady ? yt.getCurrentTime() || 0 : 0;
      if (kind === 'html') return video.currentTime || 0;
      return 0;
    }

    function getDuration() {
      if (kind === 'youtube') return ytReady ? yt.getDuration() || 0 : 0;
      if (kind === 'html') return Number.isFinite(video.duration) ? video.duration : 0;
      return 0;
    }

    // O YouTube não avisa quando o usuário arrasta a barra dele; detectamos saltos no tempo.
    let lastPoll = null;
    setInterval(() => {
      if (kind !== 'youtube' || !ytReady) { lastPoll = null; return; }
      const t = getTime();
      const at = performance.now();
      if (lastPoll && Date.now() >= suppressUntil) {
        const diff = t - lastPoll.t;
        const elapsed = (at - lastPoll.at) / 1000;
        if (diff < -1.5 || diff > elapsed + 1.5) emit('seek');
      }
      lastPoll = { t, at };
    }, 500);

    function isPlaying() {
      if (kind === 'youtube') return ytReady && [1, 3].includes(yt.getPlayerState());
      if (kind === 'html') return !video.paused && !video.ended;
      return false;
    }

    function watchAutoplay() {
      setTimeout(() => {
        if (!desiredPlaying || !kind || isPlaying()) return;
        if (kind === 'youtube' && !getDuration()) {
          toast('Este navegador não conseguiu reproduzir o vídeo do YouTube. Abra o site no Chrome, Edge ou Firefox.', 'error', 8000);
          return;
        }
        unlock.hidden = false;
      }, 3000);
    }

    function play() {
      desiredPlaying = true;
      if (kind === 'youtube' && ytReady) {
        yt.playVideo();
        watchAutoplay();
      } else if (kind === 'html') {
        const p = video.play();
        if (p) p.catch(() => { unlock.hidden = false; });
      }
    }

    function pause() {
      desiredPlaying = false;
      if (kind === 'youtube' && ytReady) yt.pauseVideo();
      else if (kind === 'html') video.pause();
    }

    function seekTo(time) {
      if (kind === 'youtube' && ytReady) {
        yt.seekTo(time, true);
        if (!desiredPlaying) setTimeout(() => { if (!desiredPlaying && ytReady) { quiet(); yt.pauseVideo(); } }, 400);
      } else if (kind === 'html') {
        video.currentTime = time;
      }
    }

    // Aplica um comando vindo de outro participante, sem reemitir o evento.
    function apply(action, time) {
      if (!kind) return;
      if (!ready()) {
        const wasPlaying = pending ? pending.playing : false;
        pending = { time, playing: action === 'play' ? true : action === 'pause' ? false : wasPlaying };
        desiredPlaying = pending.playing;
        return;
      }
      quiet();
      const diff = Math.abs(getTime() - time);
      if (action === 'play') {
        desiredPlaying = true;
        if (diff > 1) seekTo(time);
        play();
      } else if (action === 'pause') {
        pause();
        if (diff > 0.5) seekTo(time);
      } else if (action === 'seek' && diff > 0.5) {
        seekTo(time);
      }
    }

    return {
      parse, load, reset, apply, ready, getTime, getDuration, isPlaying,
      get kind() { return kind; },
      onLocal(cb) { listener = cb; },
    };
  })();

  /* ================= Indicador de fala ================= */

  const Speaking = (() => {
    let ctx = null;
    let raf = null;
    const meters = new Map();

    function audioCtx() {
      if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
      if (ctx.state === 'suspended') ctx.resume().catch(() => {});
      return ctx;
    }

    function add(id, stream) {
      remove(id);
      try {
        const c = audioCtx();
        const src = c.createMediaStreamSource(stream);
        const analyser = c.createAnalyser();
        analyser.fftSize = 512;
        src.connect(analyser);
        meters.set(id, { src, analyser, data: new Uint8Array(analyser.fftSize), until: 0 });
        if (!raf) raf = requestAnimationFrame(tick);
      } catch { /* sem indicador, mas o áudio segue funcionando */ }
    }

    function remove(id) {
      const m = meters.get(id);
      if (m) { m.src.disconnect(); meters.delete(id); }
    }

    function tick() {
      const now = performance.now();
      for (const [id, m] of meters) {
        m.analyser.getByteTimeDomainData(m.data);
        let sum = 0;
        for (const v of m.data) { const x = (v - 128) / 128; sum += x * x; }
        const rms = Math.sqrt(sum / m.data.length);
        const p = state.participants.get(id);
        if (rms > 0.035 && !(p && p.muted)) m.until = now + 300;
        const node = document.querySelector(`.participant[data-id="${id}"]`);
        if (node) node.classList.toggle('speaking', now < m.until);
      }
      raf = meters.size ? requestAnimationFrame(tick) : null;
    }

    function stop() {
      for (const id of [...meters.keys()]) remove(id);
      if (ctx) ctx.close().catch(() => {});
      ctx = null;
    }

    return { add, remove, stop, audioCtx };
  })();

  /* ================= Redução de ruído (RNNoise) ================= */

  // O áudio sem filtro usa a captura direta, independente do AudioContext.
  const NoiseFilter = (() => {
    const PATH = 'vendor/noise-suppressor/';
    const SIMD_PROBE = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11]);
    let ctx = null;
    let wasm = null;
    let source = null;
    let chainIn = null;
    let dest = null;
    let activeRoute = null;
    let nodes = [];
    let rawStream = null;
    let available = false;
    let enabled = true;
    let preparation = null;

    async function prepare() {
      if (preparation) return preparation;
      preparation = (async () => {
        let timer;
        try {
          if (!window.AudioWorkletNode || !window.WebAssembly) return false;
          ctx = new AudioContext({ sampleRate: 48000 });
          const resume = ctx.resume();
          const wasmFile = WebAssembly.validate(SIMD_PROBE) ? 'rnnoise_simd.wasm' : 'rnnoise.wasm';
          [wasm] = await Promise.race([
            Promise.all([
              fetch(PATH + wasmFile).then((r) => { if (!r.ok) throw new Error('wasm ' + r.status); return r.arrayBuffer(); }),
              ctx.audioWorklet.addModule(PATH + 'rnnoiseWorklet.js'),
              resume,
            ]),
            new Promise((_, reject) => {
              timer = setTimeout(() => reject(new Error('Tempo esgotado ao preparar redução de ruído')), 5000);
            }),
          ]);
          if (ctx.state !== 'running') throw new Error('AudioContext não iniciou');
          return true;
        } catch (err) {
          console.warn('[anti-ruído] indisponível:', err);
          destroy();
          return false;
        } finally {
          clearTimeout(timer);
        }
      })();
      return preparation;
    }

    function build(raw, startEnabled) {
      try {
        rawStream = raw;
        enabled = startEnabled;
        const mono = { channelCount: 1, channelCountMode: 'explicit', channelInterpretation: 'speakers' };
        source = ctx.createMediaStreamSource(raw);
        const highpass = new BiquadFilterNode(ctx, { type: 'highpass', frequency: 100, Q: 0.7 });
        const rnnoise = new AudioWorkletNode(ctx, '@sapphi-red/web-noise-suppressor/rnnoise', {
          ...mono, processorOptions: { maxChannels: 1, wasmBinary: wasm },
        });
        dest = ctx.createMediaStreamDestination();
        dest.channelCount = 1;
        highpass.connect(rnnoise).connect(dest);
        chainIn = highpass;
        nodes = [highpass, rnnoise];
        route();
        if (ctx.state !== 'running') throw new Error('AudioContext suspenso');
        rnnoise.addEventListener('processorerror', () => fallbackNoiseFilter('O processador de redução de ruído parou.'));
        ctx.addEventListener('statechange', () => {
          if (available && enabled && ctx && ctx.state !== 'running' && !state.ended) {
            fallbackNoiseFilter('A redução de ruído foi suspensa pelo navegador.');
          }
        });
        available = true;
        return startEnabled ? dest.stream : raw;
      } catch (err) {
        console.warn('[anti-ruído] falha ao montar filtro:', err);
        rawStream = null;
        destroy();
        return raw;
      }
    }

    function route() {
      const next = enabled ? chainIn : null;
      if (next === activeRoute) return;
      if (next) source.connect(next);
      if (activeRoute) source.disconnect(activeRoute);
      activeRoute = next;
    }

    async function setEnabled(on) {
      if (!available || !ctx) throw new Error('Redução de ruído indisponível');
      if (on && ctx.state !== 'running') await ctx.resume();
      if (on && ctx.state !== 'running') throw new Error('AudioContext suspenso');
      enabled = on;
      route();
      return on ? dest.stream : rawStream;
    }

    function destroy() {
      nodes.forEach((n) => {
        try { if (n.port) n.port.postMessage('destroy'); n.disconnect(); } catch { /* ignora */ }
      });
      nodes = [];
      rawStream = null;
      if (ctx) ctx.close().catch(() => {});
      ctx = null;
      source = null;
      chainIn = null;
      dest = null;
      activeRoute = null;
      wasm = null;
      available = false;
      preparation = null;
    }

    return {
      prepare, build, setEnabled, destroy,
      get available() { return available; },
      get enabled() { return enabled; },
    };
  })();

  /* ================= Microfone e voz ================= */

  function requestMicrophone(noiseSuppression = true) {
    return navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression,
        autoGainControl: true,
        channelCount: 1,
      },
      video: false,
    });
  }

  function publishMicrophoneState() {
    updateMicButton();
    updateNoiseButton();
    const me = state.participants.get(state.myId);
    if (me) me.muted = state.muted;
    if (!state.joined || state.ended) return;
    renderParticipants();
    if (state.isHost) broadcastParticipants();
    else sendToHost({ t: 'mute', muted: state.muted });
  }

  async function setLocalStream(stream) {
    const track = stream.getAudioTracks()[0];
    if (!track || track.readyState === 'ended') throw new Error('Faixa de áudio indisponível');
    track.enabled = !state.muted;
    state.localStream = stream;
    for (const [id, call] of state.calls) {
      try {
        const pc = call.peerConnection;
        const sender = pc && pc.getSenders().find((s) => s.track && s.track.kind === 'audio');
        if (!sender) {
          restartCall(id);
          continue;
        }
        await sender.replaceTrack(track);
      } catch (err) {
        console.warn('[voz] renegociando envio de áudio:', err);
        if (state.calls.get(id) === call) restartCall(id);
      }
    }
    if (state.ended) return;
    maintainCalls();
    if (state.micAvailable && state.myId) Speaking.add(state.myId, stream);
  }

  async function setupMic(filterReadyPromise = NoiseFilter.prepare(), retry = false) {
    Speaking.audioCtx();
    const wantFilter = localStorage.getItem('cinemaonline:anti-ruido') === 'on';
    state.micRequestPending = true;
    updateMicButton();
    let raw;
    try {
      raw = await requestMicrophone();
      const filterReady = await filterReadyPromise;
      if (state.ended) {
        return;
      }
      const previousStream = state.localStream;
      const previousRaw = state.rawStream;
      state.rawStream = raw;
      state.micAvailable = true;
      state.muted = false;
      raw.getAudioTracks()[0].addEventListener('ended', () => {
        if (state.rawStream !== raw || state.ended) return;
        state.micAvailable = false;
        state.muted = true;
        state.rawStream = null;
        NoiseFilter.destroy();
        publishMicrophoneState();
        setLocalStream(Speaking.audioCtx().createMediaStreamDestination().stream).catch((err) => {
          console.error('[microfone] falha ao manter recepção:', err);
          toast('A conexão de voz precisa ser recuperada. Clique no microfone para tentar novamente.', 'warn');
        });
        toast('O microfone foi desconectado ou perdeu a permissão. Clique no microfone para ativá-lo novamente.', 'warn', 7000);
      });
      await setLocalStream(filterReady ? NoiseFilter.build(raw, wantFilter) : raw);
      if (previousStream && previousStream !== previousRaw) previousStream.getTracks().forEach((t) => t.stop());
      if (previousRaw) previousRaw.getTracks().forEach((t) => t.stop());
      publishMicrophoneState();
    } catch (err) {
      if (state.ended) return;
      console.warn('[microfone]', err);
      NoiseFilter.destroy();
      if (!state.localStream) state.localStream = Speaking.audioCtx().createMediaStreamDestination().stream;
      state.micAvailable = false;
      state.muted = true;
      publishMicrophoneState();
      const denied = err.name === 'NotAllowedError' || err.name === 'SecurityError';
      toast(retry && denied
        ? 'O acesso ao microfone está bloqueado. Abra as permissões deste site no navegador (ícone ao lado do endereço), permita o microfone e tente novamente.'
        : 'Microfone indisponível — você pode ouvir os outros. Clique no microfone para permitir o acesso ou tentar novamente.', 'warn', 7000);
    } finally {
      if (raw && (state.ended || state.rawStream !== raw)) raw.getTracks().forEach((t) => t.stop());
      state.micRequestPending = false;
      updateMicButton();
    }
  }

  async function fallbackNoiseFilter(reason) {
    if (state.ended || !state.rawStream) return;
    console.warn('[anti-ruído]', reason);
    NoiseFilter.destroy();
    try {
      await setLocalStream(state.rawStream);
      publishMicrophoneState();
      toast('A redução de ruído com IA falhou. O microfone continua com o áudio direto.', 'warn', 6000);
    } catch (err) {
      console.error('[anti-ruído] falha ao recuperar áudio:', err);
      state.micAvailable = false;
      state.muted = true;
      publishMicrophoneState();
      toast('Não foi possível recuperar o áudio. Clique no microfone para tentar novamente.', 'warn');
    }
  }

  async function toggleNoiseFilter() {
    if (!NoiseFilter.available) {
      toast(state.micAvailable
        ? 'A redução de ruído com IA não é suportada neste navegador. Usando o filtro básico.'
        : 'Microfone indisponível.', 'warn');
      return;
    }
    const on = !NoiseFilter.enabled;
    try {
      await setLocalStream(await NoiseFilter.setEnabled(on));
    } catch (err) {
      console.warn('[anti-ruído]', err);
      toast('Não foi possível alterar a redução de ruído. O modo atual foi mantido.', 'warn');
      return;
    }
    localStorage.setItem('cinemaonline:anti-ruido', on ? 'on' : 'off');
    updateNoiseButton();
    toast(on ? 'Redução de ruído ligada.' : 'Redução de ruído desligada.', on ? 'success' : 'info');
  }

  function updateNoiseButton() {
    const btn = $('#btn-nr');
    const on = NoiseFilter.available && NoiseFilter.enabled;
    btn.classList.toggle('on', on);
    btn.setAttribute('aria-pressed', String(on));
    btn.title = !NoiseFilter.available
      ? 'Redução de ruído com IA indisponível neste navegador'
      : on ? 'Redução de ruído ligada (clique para desligar)' : 'Redução de ruído desligada (clique para ligar)';
  }

  function callPeer(id) {
    // Apenas um lado inicia a chamada, evitando duas negociações concorrentes.
    if (id === state.myId || state.myId < id || state.calls.has(id) || !state.localStream || state.ended) return;
    const call = state.peer.call(id, state.localStream, { metadata: { room: state.roomCode } });
    if (call) setupCall(call);
  }

  function maintainCalls() {
    if (!state.peer || state.peer.disconnected || state.ended || !state.localStream) return;
    for (const p of state.participants.values()) {
      if (p.connected === false) continue;
      const call = state.calls.get(p.id);
      if (call && (!call.peerConnection || ['failed', 'closed', 'disconnected'].includes(call.peerConnection.connectionState))) restartCall(p.id);
      callPeer(p.id);
    }
  }

  function restartCall(id) {
    closeCall(id);
    if (state.ended || state.myId > id) return;
    const msg = { t: 'voice-reconnect', from: state.myId, to: id };
    if (state.isHost) {
      const conn = state.conns.get(id);
      if (conn && conn.open) conn.send(msg);
    } else {
      sendToHost(msg);
    }
  }

  function onIncomingCall(call) {
    if (!call.metadata || call.metadata.room !== state.roomCode || state.ended || !state.localStream) {
      call.close();
      return;
    }
    if (state.calls.has(call.peer)) closeCall(call.peer);
    call.answer(state.localStream);
    setupCall(call);
  }

  function setupCall(call) {
    const old = state.calls.get(call.peer);
    if (old && old !== call) old.close();
    state.calls.set(call.peer, call);
    call.on('stream', (stream) => {
      if (state.calls.get(call.peer) === call) attachAudio(call.peer, stream);
    });
    call.on('close', () => {
      if (state.calls.get(call.peer) !== call) return;
      state.calls.delete(call.peer);
      detachAudio(call.peer);
    });
    call.on('error', (err) => {
      console.warn('[voz]', err);
      if (state.calls.get(call.peer) === call) closeCall(call.peer);
    });
  }

  function closeCall(id) {
    const call = state.calls.get(id);
    if (call) call.close();
    state.calls.delete(id);
    detachAudio(id);
  }

  function attachAudio(id, stream) {
    detachAudio(id);
    const audio = new Audio();
    audio.autoplay = true;
    audio.setAttribute('playsinline', '');
    audio.srcObject = stream;
    state.audioEls.set(id, audio);
    audio.play().catch(() => {
      toast('Clique em qualquer lugar da página para ativar o áudio.', 'warn', 5000);
      document.addEventListener('click', () => {
        state.audioEls.forEach((a) => a.play().catch((err) => {
          console.warn('[voz] reprodução bloqueada:', err);
          toast('O navegador bloqueou o áudio. Permita a reprodução de som nas configurações do site.', 'warn');
        }));
      }, { once: true });
    });
    Speaking.add(id, stream);
  }

  function detachAudio(id) {
    const audio = state.audioEls.get(id);
    if (audio) { audio.pause(); audio.srcObject = null; }
    state.audioEls.delete(id);
    Speaking.remove(id);
  }

  async function enableMicrophone() {
    if (state.micRequestPending || state.ended) return;
    if (!state.localStream) {
      toast('O microfone ainda está sendo preparado. Aguarde um instante.', 'info');
      return;
    }
    await setupMic(NoiseFilter.prepare(), true);
  }

  function setMuted(muted) {
    if (!state.micAvailable) {
      if (!muted) enableMicrophone();
      return;
    }
    state.muted = muted;
    state.localStream.getAudioTracks().forEach((t) => { t.enabled = !muted; });
    if (state.rawStream) state.rawStream.getAudioTracks().forEach((t) => { t.enabled = !muted; });
    publishMicrophoneState();
    try {
      playMuteSound(muted);
    } catch (err) {
      console.warn('[som do microfone]', err);
    }
  }

  function playMuteSound(muted) {
    const ctx = Speaking.audioCtx();
    const oscillator = ctx.createOscillator();
    const gain = ctx.createGain();
    const start = ctx.currentTime;

    oscillator.type = 'sine';
    oscillator.frequency.setValueAtTime(muted ? 420 : 660, start);
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(0.06, start + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.11);
    oscillator.connect(gain).connect(ctx.destination);
    oscillator.addEventListener('ended', () => {
      oscillator.disconnect();
      gain.disconnect();
    }, { once: true });
    oscillator.start(start);
    oscillator.stop(start + 0.12);
  }

  function updateMicButton() {
    const btn = $('#btn-mic');
    const off = !state.micAvailable || state.muted;
    btn.classList.toggle('off', off);
    btn.setAttribute('aria-pressed', String(off));
    btn.disabled = state.micRequestPending;
    btn.title = !state.micAvailable
      ? 'Ativar microfone e solicitar permissão no navegador (M)'
      : off ? 'Ativar microfone (M)' : 'Silenciar microfone (M)';
  }

  /* ================= PeerJS ================= */

  function openPeer(id) {
    return new Promise((resolve, reject) => {
      const peer = new Peer(id, { debug: 1 });
      const onError = (err) => { peer.destroy(); reject(err); };
      peer.once('open', () => { peer.off('error', onError); resolve(peer); });
      peer.once('error', onError);
    });
  }

  function attachPeerHandlers(peer) {
    peer.on('call', onIncomingCall);
    peer.on('open', () => {
      if (state.ended) return;
      if (!state.isHost) connectToHost();
      maintainCalls();
    });
    peer.on('disconnected', () => {
      if (state.ended || peer.destroyed) return;
      if (!state.isHost && state.joined) notifyReconnecting();
    });
    peer.on('error', (err) => {
      if (state.ended) return;
      if (err.type === 'peer-unavailable') {
        if (!state.isHost && !state.joined) {
          endSession('Sala não encontrada. Confira o link e se o anfitrião está com a sala aberta.', 'Não foi possível entrar');
        } else if (!state.isHost) {
          notifyReconnecting();
        }
        return;
      }
      if (['network', 'server-error', 'socket-error', 'socket-closed'].includes(err.type)) {
        toast('Instabilidade na conexão. Tentando reconectar…', 'warn');
        return;
      }
      console.warn('[peer]', err.type, err);
    });
  }

  function recoverSignaling() {
    if (state.peer && state.peer.disconnected && !state.peer.destroyed && !state.ended) state.peer.reconnect();
  }

  function participantList() {
    return [...state.participants.values()];
  }

  function broadcast(msg, exceptId) {
    for (const [id, conn] of state.conns) {
      if (id !== exceptId && conn.open) conn.send(msg);
    }
  }

  function broadcastParticipants() {
    broadcast({ t: 'participants', list: participantList() });
  }

  function sendToHost(msg) {
    if (state.hostConn && state.hostConn.open) state.hostConn.send(msg);
  }

  function systemMessage(text) {
    addSystemMessage(text);
    if (state.isHost) broadcast({ t: 'system', text });
  }

  /* ================= Anfitrião ================= */

  async function createRoom(name) {
    state.isHost = true;
    state.myName = name;
    showLoading('Criando sua sala…');
    await setupMic();

    let peer = null;
    let code = null;
    for (let attempt = 0; attempt < 4 && !peer; attempt++) {
      code = randomCode(6);
      try {
        peer = await openPeer(PEER_PREFIX + code);
      } catch (err) {
        if (err.type !== 'unavailable-id') {
          endSession('Não foi possível conectar ao servidor de sinalização. Verifique sua internet e tente novamente.', 'Falha ao criar sala');
          return;
        }
      }
    }
    if (!peer) {
      endSession('Não foi possível gerar um código de sala. Tente novamente.', 'Falha ao criar sala');
      return;
    }

    state.peer = peer;
    state.roomCode = code;
    state.myId = peer.id;
    state.joined = true;
    state.participants.set(state.myId, { id: state.myId, name, muted: state.muted, isHost: true });
    attachPeerHandlers(peer);
    peer.on('connection', onGuestConnection);
    history.replaceState(null, '', '#sala=' + code);

    enterRoom();
    addSystemMessage('Sala criada. Compartilhe o link para convidar até 3 amigos.');
    state.timers.push(setInterval(hostHeartbeat, HEARTBEAT_MS));
  }

  function onGuestConnection(conn) {
    conn.on('data', (msg) => handleGuestMessage(conn, msg));
    conn.on('close', () => disconnectParticipant(conn));
    conn.on('error', (err) => {
      console.warn('[sala] conexão do convidado:', err);
      disconnectParticipant(conn);
    });
  }

  function disconnectParticipant(conn) {
    if (state.ended || state.conns.get(conn.peer) !== conn) return;
    state.conns.delete(conn.peer);
    const p = state.participants.get(conn.peer);
    if (p) p.connected = false;
    closeCall(conn.peer);
    renderParticipants();
    broadcastParticipants();
  }

  function handleGuestMessage(conn, msg) {
    if (!msg || typeof msg !== 'object' || state.ended) return;
    const id = conn.peer;
    const p = state.participants.get(id);

    if (msg.t === 'hello') {
      if (!p && state.participants.size >= MAX_PARTICIPANTS) {
        conn.send({ t: 'full' });
        setTimeout(() => conn.close(), 800);
        return;
      }
      const name = cleanName(msg.name) || 'Convidado';
      const old = state.conns.get(id);
      state.conns.set(id, conn);
      if (old && old !== conn) old.close();
      state.participants.set(id, { id, name, muted: !!msg.muted, isHost: false, connected: true });
      conn.send({
        t: 'welcome',
        participants: participantList(),
        chat: state.chat.slice(-100),
        video: currentVideoState(),
      });
      broadcastParticipants();
      renderParticipants();
      maintainCalls();
      if (!p) systemMessage(`${name} entrou na sala`);
      return;
    }

    if (!p || state.conns.get(id) !== conn) return;

    switch (msg.t) {
      case 'voice-reconnect':
        if (msg.to === state.myId) {
          closeCall(id);
          maintainCalls();
        } else {
          const target = state.conns.get(msg.to);
          if (target && target.open) target.send({ t: 'voice-reconnect', from: id, to: msg.to });
        }
        break;
      case 'ping':
        conn.send({ t: 'sync', url: state.video.url, video: currentVideoState() });
        break;
      case 'chat': {
        const text = String(msg.text || '').trim().slice(0, 500);
        if (!text) return;
        const m = { t: 'chat', from: id, name: p.name, text, ts: Date.now() };
        pushChat(m);
        addChatMessage(m);
        broadcast(m, id);
        break;
      }
      case 'video': {
        const v = sanitizeVideoMsg(msg, id, p.name);
        if (!v) return;
        applyRemoteVideo(v);
        broadcast(v, id);
        break;
      }
      case 'mute':
        p.muted = !!msg.muted;
        renderParticipants();
        broadcastParticipants();
        break;
      case 'bye':
        removeParticipant(id);
        break;
    }
  }

  function sanitizeVideoMsg(msg, from, by) {
    const action = msg.action;
    if (action === 'load') {
      const src = Player.parse(msg.url);
      return src ? { t: 'video', action, url: src.url, from, by } : null;
    }
    if (['play', 'pause', 'seek'].includes(action) && Number.isFinite(msg.time)) {
      return { t: 'video', action, time: msg.time, from, by };
    }
    return null;
  }

  function removeParticipant(id) {
    const p = state.participants.get(id);
    const conn = state.conns.get(id);
    state.conns.delete(id);
    closeCall(id);
    if (conn && conn.open) conn.close();
    if (!p || p.isHost) return;
    state.participants.delete(id);
    renderParticipants();
    broadcastParticipants();
    systemMessage(`${p.name} saiu da sala`);
  }

  function currentVideoState() {
    if (!state.video.url) return null;
    return { url: state.video.url, time: Player.getTime(), playing: Player.isPlaying() };
  }

  function hostHeartbeat() {
    if (state.ended) return;
    recoverSignaling();
    maintainCalls();
    const v = currentVideoState();
    broadcast({ t: 'sync', url: state.video.url, video: v && Player.ready() ? { time: v.time, playing: v.playing } : null });
  }

  function pushChat(m) {
    state.chat.push(m);
    if (state.chat.length > 200) state.chat.shift();
  }

  /* ================= Convidado ================= */

  async function joinRoom(code, name) {
    state.isHost = false;
    state.myName = name;
    state.roomCode = code;
    state.localStream = Speaking.audioCtx().createMediaStreamDestination().stream;
    state.filterReadyPromise = NoiseFilter.prepare();
    showLoading('Entrando na sala…');

    let peer;
    try {
      peer = await openPeer(PEER_PREFIX + 'u-' + randomCode(12));
    } catch {
      endSession('Não foi possível conectar ao servidor de sinalização. Verifique sua internet e tente novamente.', 'Falha na conexão');
      return;
    }
    state.peer = peer;
    state.myId = peer.id;
    attachPeerHandlers(peer);

    state.timers.push(setInterval(guestHeartbeat, HEARTBEAT_MS));
    connectToHost();
  }

  function notifyReconnecting() {
    if (state.reconnecting || state.ended) return;
    state.reconnecting = true;
    toast('Conexão interrompida. Reconectando à sala sem fechar o vídeo…', 'warn', 6000);
  }

  function connectToHost() {
    if (!state.peer || state.peer.disconnected || state.peer.destroyed || state.ended) return;
    if (state.hostConn && state.hostConn.open) return;
    if (state.hostConn && Date.now() - state.hostRetryAt < TIMEOUT_MS) return;
    const previous = state.hostConn;
    state.hostConn = null;
    if (previous) previous.close();
    const conn = state.peer.connect(PEER_PREFIX + state.roomCode, { reliable: true, serialization: 'json' });
    state.hostConn = conn;
    state.hostRetryAt = Date.now();

    conn.on('open', () => {
      if (state.hostConn === conn && !state.ended) conn.send({ t: 'hello', name: state.myName, muted: state.muted });
    });
    conn.on('data', (msg) => {
      if (state.hostConn !== conn || state.ended) return;
      state.lastHostMsg = Date.now();
      handleHostMessage(msg, state.filterReadyPromise);
    });
    conn.on('close', () => {
      if (state.hostConn !== conn || state.ended) return;
      state.hostConn = null;
      if (state.joined) notifyReconnecting();
    });
    conn.on('error', (err) => {
      if (state.hostConn !== conn || state.ended) return;
      console.warn('[sala] conexão com anfitrião:', err);
      state.hostConn = null;
      conn.close();
      if (state.joined) notifyReconnecting();
    });
  }

  function handleHostMessage(msg, filterReadyPromise) {
    if (!msg || typeof msg !== 'object' || state.ended) return;
    switch (msg.t) {
      case 'full':
        endSession(`Esta sala já está cheia (${MAX_PARTICIPANTS}/${MAX_PARTICIPANTS}). Peça para alguém sair ou crie sua própria sala.`, 'Sala cheia');
        break;

      case 'welcome': {
        const wasJoined = state.joined;
        state.joined = true;
        state.reconnecting = false;
        state.participants = new Map(msg.participants.map((p) => [p.id, p]));
        enterRoom();
        if (!wasJoined) {
          (msg.chat || []).forEach(addChatMessage);
          addSystemMessage('Você entrou na sala');
        } else {
          toast('Conexão com a sala recuperada.', 'success');
        }
        const v = msg.video;
        if (v && v.url) {
          const src = Player.parse(v.url);
          if (src) {
            if (wasJoined && state.video.url === src.url) {
              Player.apply(v.playing ? 'play' : 'pause', v.time);
            } else {
              state.video.url = src.url;
              $('#video-url').value = src.url;
              Player.load(src, { time: v.time + (v.playing ? 1 : 0), playing: v.playing });
            }
            setActivity('Sincronizado com a sala');
          }
        }
        maintainCalls();
        if (!wasJoined) setupGuestAudio(filterReadyPromise);
        break;
      }

      case 'participants': {
        const ids = new Set(msg.list.map((p) => p.id));
        for (const id of state.participants.keys()) if (!ids.has(id)) closeCall(id);
        state.participants = new Map(msg.list.map((p) => [p.id, p]));
        renderParticipants();
        maintainCalls();
        break;
      }

      case 'voice-reconnect':
        if (msg.to === state.myId && state.participants.has(msg.from)) {
          closeCall(msg.from);
          maintainCalls();
        }
        break;

      case 'chat':
        addChatMessage(msg);
        break;

      case 'system':
        addSystemMessage(msg.text);
        break;

      case 'video':
        applyRemoteVideo(msg);
        break;

      case 'sync':
        handleSync(msg);
        break;

      case 'end':
        endSession('O anfitrião encerrou a sala.');
        break;
    }
  }

  function setupGuestAudio(filterReadyPromise) {
    setupMic(filterReadyPromise).then(() => {
      if (state.ended) {
        if (state.localStream) state.localStream.getTracks().forEach((track) => track.stop());
        state.localStream = null;
        NoiseFilter.destroy();
        return;
      }

      updateMicButton();
      updateNoiseButton();
      const me = state.participants.get(state.myId);
      if (me) me.muted = state.muted;
      renderParticipants();
      if (state.localStream && state.micAvailable) Speaking.add(state.myId, state.localStream);
      for (const p of state.participants.values()) callPeer(p.id);
      sendToHost({ t: 'mute', muted: state.muted });
    }).catch((err) => {
      if (state.ended) return;
      console.error('[microfone]', err);
      toast('Não foi possível preparar o áudio. Tente recarregar a página.', 'error');
    });
  }

  function handleSync(msg) {
    if (msg.url && msg.url !== state.video.url) {
      const src = Player.parse(msg.url);
      if (src) {
        state.video.url = src.url;
        $('#video-url').value = src.url;
        Player.load(src, msg.video || {});
      }
      return;
    }
    if (!msg.video || !Player.ready()) return;
    const { time, playing } = msg.video;
    if (playing !== Player.isPlaying()) {
      // Só corrige após duas divergências seguidas para não brigar com buffering.
      if (++state.mismatch >= 2) {
        state.mismatch = 0;
        Player.apply(playing ? 'play' : 'pause', time);
      }
      return;
    }
    state.mismatch = 0;
    if (playing && Math.abs(Player.getTime() - time) > DRIFT_TOLERANCE) {
      Player.apply('seek', time + 0.3);
    }
  }

  function guestHeartbeat() {
    if (state.ended) return;
    recoverSignaling();
    if (state.hostConn && state.hostConn.peerConnection && ['failed', 'closed', 'disconnected'].includes(state.hostConn.peerConnection.connectionState)) {
      const conn = state.hostConn;
      state.hostConn = null;
      conn.close();
      if (state.joined) notifyReconnecting();
    }
    connectToHost();
    sendToHost({ t: 'ping' });
    maintainCalls();
  }

  /* ================= Vídeo compartilhado ================= */

  const VERBS = { play: 'deu play', pause: 'pausou', seek: 'pulou para' };

  function applyRemoteVideo(msg) {
    if (msg.action === 'load') {
      const src = Player.parse(msg.url);
      if (!src) return;
      state.video.url = src.url;
      Player.load(src, { time: 0, playing: false });
      $('#video-url').value = src.url;
      setActivity(`${msg.by} carregou um novo vídeo`);
      addSystemMessage(`${msg.by} carregou um novo vídeo`);
      return;
    }
    Player.apply(msg.action, msg.time);
    setActivity(`${msg.by} ${VERBS[msg.action]} · ${formatTime(msg.time)}`);
  }

  function sendVideo(payload) {
    const msg = { t: 'video', ...payload, from: state.myId, by: state.myName };
    if (state.isHost) broadcast(msg);
    else sendToHost(msg);
  }

  Player.onLocal((action, time) => {
    if (!state.joined) return;
    sendVideo({ action, time });
    setActivity(`Você ${VERBS[action]} · ${formatTime(time)}`);
  });

  /* ================= Controles sincronizados ================= */

  let seeking = false;

  // Executa um comando localmente e envia para todos da sala.
  function localCommand(action, time) {
    if (!Player.kind) {
      toast('Carregue um vídeo primeiro.', 'warn');
      return;
    }
    const duration = Player.getDuration();
    time = Math.max(0, duration ? Math.min(time, duration - 0.5) : time);
    Player.apply(action, time);
    sendVideo({ action, time });
    setActivity(`Você ${VERBS[action]} · ${formatTime(time)}`);
    updateControls();
  }

  function togglePlay() {
    localCommand(Player.isPlaying() ? 'pause' : 'play', Player.getTime());
  }

  function skip(seconds) {
    localCommand('seek', Player.getTime() + seconds);
  }

  function updateControls() {
    const ready = !!Player.kind && Player.ready();
    $('#controls').classList.toggle('disabled', !Player.kind);
    $('#ctl-play').classList.toggle('playing', ready && Player.isPlaying());
    if (seeking) return;
    const duration = ready ? Player.getDuration() : 0;
    const time = ready ? Player.getTime() : 0;
    const range = $('#ctl-seek');
    range.max = String(duration || 0);
    range.value = String(time);
    range.style.setProperty('--p', duration ? `${(time / duration) * 100}%` : '0%');
    $('#ctl-time').textContent = `${formatTime(time)} / ${formatTime(duration)}`;
  }

  function bindControls() {
    $('#ctl-play').addEventListener('click', togglePlay);
    $('#ctl-back').addEventListener('click', () => skip(-30));
    $('#ctl-fwd').addEventListener('click', () => skip(30));
    // Evita que a barra de espaço "clique" de novo no último botão usado.
    document.querySelectorAll('.ctl').forEach((b) => b.addEventListener('mouseup', () => b.blur()));

    const range = $('#ctl-seek');
    range.addEventListener('input', () => {
      seeking = true;
      const duration = Number(range.max) || 0;
      const value = Number(range.value);
      range.style.setProperty('--p', duration ? `${(value / duration) * 100}%` : '0%');
      $('#ctl-time').textContent = `${formatTime(value)} / ${formatTime(duration)}`;
    });
    range.addEventListener('change', () => {
      seeking = false;
      localCommand('seek', Number(range.value));
    });

    setInterval(updateControls, 250);
  }

  function loadVideoFromInput() {
    const input = $('#video-url');
    const src = Player.parse(input.value);
    if (!src) {
      toast('URL inválida. Use um link do YouTube ou um arquivo de vídeo direto.', 'error');
      input.focus();
      return;
    }
    state.video.url = src.url;
    input.value = src.url;
    Player.load(src, { time: 0, playing: false });
    sendVideo({ action: 'load', url: src.url });
    setActivity('Você carregou um novo vídeo');
    addSystemMessage('Você carregou um novo vídeo');
  }

  /* ================= Render: participantes e chat ================= */

  function renderParticipants() {
    const list = $('#participants');
    list.innerHTML = '';
    const people = participantList();

    for (const p of people) {
      const li = el('li', 'participant');
      li.dataset.id = p.id;
      const avatar = el('span', 'avatar', initials(p.name));
      avatar.style.setProperty('--hue', hueFor(p.id));
      const name = el('span', 'p-name', p.name);
      if (p.id === state.myId) name.appendChild(el('small', null, '(você)'));
      li.append(avatar, name);
      if (p.isHost) li.appendChild(el('span', 'badge', 'Anfitrião'));
      if (p.connected === false) li.appendChild(el('span', 'badge', 'Reconectando'));
      const mic = el('span', 'p-mic' + (p.muted ? ' off' : ''));
      mic.innerHTML = p.muted ? MIC_OFF_ICON : MIC_ICON;
      mic.title = p.muted ? 'Microfone desligado' : 'Microfone ligado';
      li.appendChild(mic);
      list.appendChild(li);
    }
    for (let i = people.length; i < MAX_PARTICIPANTS; i++) {
      const li = el('li', 'participant empty');
      li.append(el('span', 'avatar', '+'), el('span', 'p-name', 'Vaga disponível'));
      list.appendChild(li);
    }

    $('#participants-count').textContent = `${people.length} de ${MAX_PARTICIPANTS}`;
    $('#room-count').textContent = `${people.length}/${MAX_PARTICIPANTS}`;
  }

  function addChatMessage(m) {
    const box = $('#chat-messages');
    const mine = m.from === state.myId;
    const wrap = el('div', 'msg' + (mine ? ' mine' : ''));
    const meta = el('div', 'msg-meta');
    const name = el('span', 'msg-name', mine ? 'Você' : m.name);
    name.style.setProperty('--hue', hueFor(m.from));
    meta.append(name, el('time', null, clock(m.ts)));
    wrap.append(meta, el('div', 'msg-text', m.text));
    appendToChat(box, wrap, mine);
  }

  function addSystemMessage(text) {
    appendToChat($('#chat-messages'), el('div', 'msg-system', text), false);
  }

  function appendToChat(box, node, forceScroll) {
    const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
    box.appendChild(node);
    if (nearBottom || forceScroll) box.scrollTop = box.scrollHeight;
  }

  function sendChat() {
    const input = $('#chat-input');
    const text = input.value.trim().slice(0, 500);
    if (!text) return;
    input.value = '';
    const m = { t: 'chat', from: state.myId, name: state.myName, text, ts: Date.now() };
    addChatMessage(m);
    if (state.isHost) {
      pushChat(m);
      broadcast(m);
    } else {
      sendToHost({ t: 'chat', text });
    }
  }

  /* ================= Ciclo de vida da sessão ================= */

  function enterRoom() {
    hideLoading();
    $('#modal-join').hidden = true;
    showView('room');
    $('#room-code').textContent = state.roomCode;
    $('#invite-link').value = inviteLink();
    document.title = `Sala ${state.roomCode} — CinemaOnline`;
    updateMicButton();
    updateNoiseButton();
    renderParticipants();
    if (state.localStream && state.micAvailable) Speaking.add(state.myId, state.localStream);
  }

  function teardown() {
    state.timers.forEach(clearInterval);
    state.timers = [];
    for (const id of [...state.calls.keys()]) closeCall(id);
    state.conns.forEach((c) => c.close());
    if (state.hostConn) state.hostConn.close();
    if (state.peer && !state.peer.destroyed) state.peer.destroy();
    if (state.localStream) state.localStream.getTracks().forEach((t) => t.stop());
    if (state.rawStream) state.rawStream.getTracks().forEach((t) => t.stop());
    NoiseFilter.destroy();
    Player.reset();
    Speaking.stop();
  }

  function endSession(reason, title = 'Sessão encerrada') {
    if (state.ended) return;
    state.ended = true;
    teardown();
    hideLoading();
    $('#modal-join').hidden = true;
    showView('home');
    history.replaceState(null, '', baseUrl());
    document.title = 'CinemaOnline — Assista junto';
    $('#end-title').textContent = title;
    $('#end-reason').textContent = reason;
    $('#modal-end').hidden = false;
  }

  function leaveRoom() {
    if (state.isHost) {
      if (state.participants.size > 1 && !confirm('Ao sair, a sala será encerrada para todos. Deseja continuar?')) return;
      broadcast({ t: 'end' });
    } else {
      sendToHost({ t: 'bye' });
    }
    state.ended = true;
    setTimeout(() => {
      teardown();
      location.replace(baseUrl());
    }, 200);
  }

  function askName(inputSel) {
    const input = $(inputSel);
    const name = cleanName(input.value);
    if (!name) {
      toast('Digite seu nome para continuar.', 'warn');
      input.focus();
      return null;
    }
    sessionStorage.setItem('cinemaonline:name', name);
    return name;
  }

  /* ================= Eventos ================= */

  function bindEvents() {
    $('#form-create').addEventListener('submit', (e) => {
      e.preventDefault();
      const name = askName('#home-name');
      if (name) createRoom(name);
    });

    $('#form-join-code').addEventListener('submit', (e) => {
      e.preventDefault();
      const code = parseRoomCode($('#home-code').value);
      if (!code) {
        toast('Link ou código de sala inválido.', 'error');
        return;
      }
      const name = askName('#home-name');
      if (!name) return;
      history.replaceState(null, '', '#sala=' + code);
      joinRoom(code, name);
    });

    $('#form-join').addEventListener('submit', (e) => {
      e.preventDefault();
      const name = askName('#join-name');
      if (!name) return;
      $('#modal-join').hidden = true;
      joinRoom(state.roomCode, name);
    });

    $('#form-url').addEventListener('submit', (e) => {
      e.preventDefault();
      loadVideoFromInput();
    });

    $('#form-chat').addEventListener('submit', (e) => {
      e.preventDefault();
      sendChat();
    });

    const copyInvite = async () => {
      await copyText(inviteLink());
      toast('Link de convite copiado!', 'success');
    };
    $('#btn-invite').addEventListener('click', copyInvite);
    $('#btn-copy-invite').addEventListener('click', copyInvite);
    $('#invite-link').addEventListener('focus', (e) => e.target.select());

    $('#btn-mic').addEventListener('click', () => setMuted(!state.muted));
    $('#btn-nr').addEventListener('click', toggleNoiseFilter);
    $('#btn-leave').addEventListener('click', leaveRoom);
    $('#btn-home').addEventListener('click', () => location.replace(baseUrl()));

    document.addEventListener('keydown', (e) => {
      if (!state.joined || state.ended) return;
      const typing = /^(INPUT|TEXTAREA)$/.test(document.activeElement.tagName) && document.activeElement.type !== 'range';
      if (typing || e.ctrlKey || e.metaKey || e.altKey) return;
      const key = e.key.toLowerCase();
      if (key === ' ' && document.activeElement.tagName === 'BUTTON' && !document.activeElement.classList.contains('ctl')) return;
      if (key === 'm') setMuted(!state.muted);
      else if (!Player.kind) return;
      else if (key === ' ' || key === 'k') { e.preventDefault(); togglePlay(); }
      else if (key === 'arrowleft' || key === 'j') { e.preventDefault(); skip(-30); }
      else if (key === 'arrowright' || key === 'l') { e.preventDefault(); skip(30); }
    });

    window.addEventListener('beforeunload', (e) => {
      if (state.isHost && state.joined && !state.ended && state.participants.size > 1) {
        e.preventDefault();
        e.returnValue = '';
      }
    });

    const resumeConnections = () => {
      if (state.ended || !state.peer) return;
      if (state.isHost) hostHeartbeat();
      else guestHeartbeat();
    };
    window.addEventListener('online', resumeConnections);
    window.addEventListener('pageshow', resumeConnections);
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) resumeConnections();
    });

    window.addEventListener('pagehide', (e) => {
      if (e.persisted) return;
      if (!state.joined || state.ended) return;
      if (state.isHost) broadcast({ t: 'end' });
      else sendToHost({ t: 'bye' });
    });
  }

  function init() {
    if (location.protocol === 'file:') $('#file-warning').hidden = false;
    if (/Electron|\bCode\//.test(navigator.userAgent)) $('#embedded-warning').hidden = false;
    bindEvents();
    bindControls();

    const savedName = sessionStorage.getItem('cinemaonline:name') || '';
    $('#home-name').value = savedName;
    $('#join-name').value = savedName;

    if (typeof Peer === 'undefined') {
      endSession('Não foi possível carregar a biblioteca de conexão (PeerJS). Verifique sua internet.', 'Erro ao carregar');
      return;
    }

    const code = parseRoomCode(location.hash);
    if (code) {
      state.roomCode = code;
      $('#join-code').textContent = code;
      $('#modal-join').hidden = false;
      setTimeout(() => $('#join-name').focus(), 50);
    } else {
      $('#home-name').focus();
    }
  }

  init();
})();
