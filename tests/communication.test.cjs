const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
const flush = () => new Promise(setImmediate);

class Track extends EventEmitter {
  constructor() {
    super();
    this.kind = 'audio';
    this.enabled = true;
    this.readyState = 'live';
  }
  addEventListener(...args) { this.on(...args); }
  stop() { this.readyState = 'ended'; }
  disconnect() { this.stop(); this.emit('ended'); }
}

const stream = () => {
  const track = new Track();
  return { getAudioTracks: () => [track], getTracks: () => [track] };
};

class AudioNode extends EventEmitter {
  constructor() {
    super();
    this.connections = new Set();
    this.port = { postMessage() {} };
    this.stream = stream();
  }
  addEventListener(...args) { this.on(...args); }
  connect(node) { this.connections.add(node); return node; }
  disconnect(node) { if (node) this.connections.delete(node); else this.connections.clear(); }
}

class AudioContextMock extends EventEmitter {
  constructor() {
    super();
    this.state = 'running';
    this.audioWorklet = { addModule: async () => {} };
  }
  addEventListener(...args) { this.on(...args); }
  async resume() { this.state = 'running'; }
  async close() { this.state = 'closed'; }
  createMediaStreamDestination() { return new AudioNode(); }
  createMediaStreamSource() { return new AudioNode(); }
}

class Connection extends EventEmitter {
  constructor(peer) {
    super();
    this.peer = peer;
    this.open = true;
    this.peerConnection = { connectionState: 'connected' };
    this.messages = [];
  }
  send(msg) { this.messages.push(msg); }
  close() { this.open = false; this.emit('close'); }
}

function mediaCall(peer, localStream, metadata) {
  const call = new Connection(peer);
  call.metadata = metadata;
  call.sender = {
    track: localStream.getAudioTracks()[0],
    async replaceTrack(track) { this.track = track; },
  };
  call.peerConnection.getSenders = () => [call.sender];
  call.answer = (answerStream) => { call.sender.track = answerStream.getAudioTracks()[0]; };
  return call;
}

function app() {
  const elements = new Map();
  const messages = [];
  const intervals = [];
  const worklets = [];
  const contexts = [];
  const storage = new Map();
  const player = { loads: [], applies: [], time: 0, playing: true };
  const controls = { workletStartup: 'ready' };
  const makeElement = () => {
    const node = new EventEmitter();
    Object.assign(node, {
      children: [], value: '', hidden: false, disabled: false,
      dataset: {}, style: { setProperty() {} },
      classList: { toggle(key, value) { this[key] = value; } },
      setAttribute(key, value) { this[key] = value; },
      removeAttribute(key) { delete this[key]; },
      append(...children) { this.children.push(...children); },
      appendChild(child) { this.children.push(child); return child; },
      remove() { this.removed = true; },
      focus() {}, pause() {}, load() {},
      setRangeText(text, start, end) {
        this.value = this.value.slice(0, start) + text + this.value.slice(end);
        this.selectionStart = this.selectionEnd = start + text.length;
      },
    });
    node.addEventListener = node.on.bind(node);
    return node;
  };
  const element = (selector) => {
    if (!elements.has(selector)) {
      elements.set(selector, makeElement());
    }
    return elements.get(selector);
  };
  class Context extends AudioContextMock {
    constructor(...args) { super(...args); contexts.push(this); }
  }
  class Worklet extends AudioNode {
    constructor(...args) {
      super(...args);
      this.options = args[2];
      worklets.push(this);
      queueMicrotask(() => {
        if (controls.workletStartup) this.port.onmessage?.({ data: { type: controls.workletStartup, message: 'WASM initialization failed' } });
      });
    }
  }
  const context = vm.createContext({
    console: { warn() {}, error() {} }, URL, Blob, ArrayBuffer, Map, Set, Uint8Array,
    document: { querySelector: element, createElement: makeElement, addEventListener() {} },
    window: { AudioContext: Context, AudioWorkletNode: Worklet, WebAssembly: {} },
    AudioContext: Context, AudioWorkletNode: Worklet, BiquadFilterNode: AudioNode,
    Audio: class { setAttribute() {} async play() {} pause() {} },
    navigator: { mediaDevices: { getUserMedia: async () => stream() } },
    localStorage: { getItem: (key) => storage.get(key), setItem: (key, value) => storage.set(key, value) },
    fetch: async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(8) }),
    WebAssembly: { validate: () => false },
    setTimeout, clearTimeout,
    setInterval: (fn) => { intervals.push(fn); return intervals.length; },
    clearInterval() {}, messages, player,
    location: { href: 'http://localhost/', protocol: 'http:', hash: '' },
    history: { replaceState() {} },
  });
  vm.runInContext(source.replace('  init();', `
    toast = (text) => messages.push(text);
    renderParticipants = () => {};
    Speaking.add = () => {};
    Speaking.remove = () => {};
    playMuteSound = () => {};
    Player.getTime = () => player.time;
    Player.isPlaying = () => player.playing;
    Player.ready = () => true;
    Player.load = (src, options) => player.loads.push({ src, options });
    Player.apply = (action, time) => player.applies.push({ action, time });
    Player.reset = () => {};
    Speaking.stop = () => {};
    globalThis.api = {
      state, NoiseFilter, setupMic, setLocalStream, setMuted, enableMicrophone,
      toggleNoiseFilter, fallbackNoiseFilter, callPeer, maintainCalls,
      onIncomingCall, setupCall, attachAudio, attachPeerHandlers,
      onGuestConnection, handleGuestMessage, handleHostMessage,
      hostHeartbeat, guestHeartbeat, connectToHost, teardown,
      validVoiceMessage, startVoiceRecording, stopVoiceRecording,
      cancelVoiceRecording, sendVoiceMessage, setupEmojis, sendChat, addChatMessage
    };
  `), context);
  const api = context.api;
  api.state.myId = 'z-guest';
  api.state.roomCode = 'room';
  api.state.localStream = stream();
  api.state.peer = new EventEmitter();
  api.state.peer.call = (id, outgoing, options) => mediaCall(id, outgoing, options.metadata);
  api.state.peer.connect = (id) => new Connection(id);
  api.state.peer.reconnect = () => { api.state.peer.disconnected = false; };
  api.state.participants.set(api.state.myId, { id: api.state.myId, muted: true });
  return { api, context, elements, messages, intervals, worklets, contexts, player, storage, controls };
}

test('both ends send their real microphone even when a call precedes permission', async () => {
  const caller = app();
  const receiver = app();
  receiver.api.state.myId = 'a-host';
  caller.api.state.participants.set('a-host', { id: 'a-host' });
  caller.api.maintainCalls();
  const outgoing = caller.api.state.calls.get('a-host');
  const incoming = mediaCall('z-guest', receiver.api.state.localStream, { room: 'room' });
  receiver.api.onIncomingCall(incoming);
  await Promise.all([
    caller.api.setupMic(Promise.resolve(false)),
    receiver.api.setupMic(Promise.resolve(false)),
  ]);
  assert.equal(outgoing.sender.track, caller.api.state.rawStream.getAudioTracks()[0]);
  assert.equal(incoming.sender.track, receiver.api.state.rawStream.getAudioTracks()[0]);
  assert.equal(outgoing.sender.track.enabled, true);
  assert.equal(incoming.sender.track.enabled, true);
});

test('one caller per pair and stale call callbacks do not detach replacement audio', () => {
  const { api } = app();
  api.state.participants.set('a-host', { id: 'a-host' });
  api.state.participants.set('zz-guest', { id: 'zz-guest' });
  api.maintainCalls();
  assert.equal(api.state.calls.size, 1);
  const old = api.state.calls.get('a-host');
  const replacement = mediaCall('a-host', api.state.localStream, { room: 'room' });
  api.setupCall(replacement);
  api.attachAudio('a-host', stream());
  const audio = api.state.audioEls.get('a-host');
  old.emit('close');
  old.emit('stream', stream());
  assert.equal(api.state.calls.get('a-host'), replacement);
  assert.equal(api.state.audioEls.get('a-host'), audio);
});

test('missing senders and failed track replacements renegotiate instead of reporting silent success', async () => {
  for (const missing of [true, false]) {
    const { api } = app();
    api.state.participants.set('a-host', { id: 'a-host' });
    api.maintainCalls();
    const old = api.state.calls.get('a-host');
    if (missing) old.peerConnection.getSenders = () => [];
    else old.sender.replaceTrack = async () => { throw new Error('replacement failed'); };
    const raw = stream();
    await api.setLocalStream(raw);
    const replacement = api.state.calls.get('a-host');
    assert.notEqual(replacement, old);
    assert.equal(replacement.sender.track, raw.getAudioTracks()[0]);
  }
});

test('callee requests renegotiation from the designated caller when its sender is missing', async () => {
  const receiver = app();
  receiver.api.state.myId = 'a-host';
  receiver.api.state.isHost = true;
  const caller = app();
  caller.api.state.participants.set('a-host', { id: 'a-host' });
  caller.api.maintainCalls();
  const old = caller.api.state.calls.get('a-host');
  const conn = new Connection('z-guest');
  receiver.api.state.conns.set('z-guest', conn);
  const incoming = mediaCall('z-guest', receiver.api.state.localStream, { room: 'room' });
  incoming.peerConnection.getSenders = () => [];
  receiver.api.setupCall(incoming);
  await receiver.api.setLocalStream(stream());
  assert.equal(conn.messages[0].t, 'voice-reconnect');
  caller.api.handleHostMessage(conn.messages[0]);
  assert.notEqual(caller.api.state.calls.get('a-host'), old);
});

test('permission retry, capture loss and duplicate clicks preserve accurate microphone state', async () => {
  const { api, context, messages, elements } = app();
  context.navigator.mediaDevices.getUserMedia = async () => {
    throw Object.assign(new Error('denied'), { name: 'NotAllowedError' });
  };
  await api.enableMicrophone();
  assert.equal(api.state.micAvailable, false);
  assert.equal(api.state.muted, true);
  assert.match(messages.at(-1), /bloqueado/);
  let resolve;
  let requests = 0;
  context.navigator.mediaDevices.getUserMedia = () => {
    requests++;
    return new Promise((r) => { resolve = r; });
  };
  const enabling = api.enableMicrophone();
  await api.enableMicrophone();
  assert.equal(requests, 1);
  const raw = stream();
  resolve(raw);
  await enabling;
  assert.equal(api.state.micAvailable, true);
  assert.equal(api.state.muted, false);
  raw.getAudioTracks()[0].disconnect();
  await flush();
  assert.equal(api.state.micAvailable, false);
  assert.equal(api.state.muted, true);
  assert.equal(elements.get('#btn-mic').classList.off, true);
  assert.equal(api.state.localStream.getAudioTracks()[0].readyState, 'live');
});

test('filter switching preserves mute and sends raw audio when disabled', async () => {
  const { api, worklets } = app();
  await api.setupMic(api.NoiseFilter.prepare());
  const raw = api.state.rawStream;
  assert.equal(api.state.localStream, raw);
  assert.equal(worklets.length, 1);
  assert.equal(worklets[0].options.processorOptions.vad, undefined);
  api.setMuted(true);
  await api.toggleNoiseFilter();
  assert.notEqual(api.state.localStream, raw);
  assert.equal(api.state.localStream.getAudioTracks()[0].enabled, false);
  api.setMuted(false);
  await api.toggleNoiseFilter();
  assert.equal(api.state.localStream, raw);
  assert.equal(raw.getAudioTracks()[0].enabled, true);
});

test('worklet error or suspended filter falls back to a live raw microphone', async () => {
  for (const error of ['processorerror', 'suspended']) {
    const { api, worklets, contexts } = app();
    await api.setupMic(api.NoiseFilter.prepare());
    await api.toggleNoiseFilter();
    if (error === 'processorerror') worklets[0].emit('processorerror');
    else {
      contexts[0].state = 'suspended';
      contexts[0].emit('statechange');
    }
    await flush();
    assert.equal(api.state.localStream, api.state.rawStream);
    assert.equal(api.state.rawStream.getAudioTracks()[0].readyState, 'live');
    assert.equal(api.state.micAvailable, true);
    assert.equal(api.NoiseFilter.available, false);
  }
});

test('raw microphone stays live until WASM readiness and initialization errors fail open', async () => {
  for (const result of ['ready', 'error']) {
    const { api, controls, worklets, messages } = app();
    controls.workletStartup = null;
    const setup = api.setupMic(api.NoiseFilter.prepare());
    await flush();
    assert.equal(api.state.localStream, api.state.rawStream);
    assert.equal(api.state.localStream.getAudioTracks()[0].enabled, true);
    assert.equal(api.NoiseFilter.available, false);
    worklets[0].port.onmessage({ data: { type: result, message: 'bad wasm' } });
    await setup;
    assert.equal(api.NoiseFilter.available, result === 'ready');
    assert.equal(api.state.localStream, api.state.rawStream);
    assert.equal(api.state.micAvailable, true);
    if (result === 'error') assert.match(messages.at(-1), /áudio direto/);
  }
});

test('WASM startup timeout preserves the raw microphone', async () => {
  const { api, context, controls } = app();
  controls.workletStartup = null;
  await api.NoiseFilter.prepare();
  context.setTimeout = (fn) => setTimeout(fn, 0);
  await api.setupMic(Promise.resolve(true));
  assert.equal(api.state.localStream, api.state.rawStream);
  assert.equal(api.state.micAvailable, true);
  assert.equal(api.NoiseFilter.available, false);
});

test('exiting during WASM initialization cancels its wait and releases capture', async () => {
  const { api, controls } = app();
  controls.workletStartup = null;
  const setup = api.setupMic(api.NoiseFilter.prepare());
  await flush();
  const raw = api.state.rawStream;
  api.state.ended = true;
  api.state.peer.destroy = () => {};
  api.teardown();
  await setup;
  assert.equal(raw.getAudioTracks()[0].readyState, 'ended');
  assert.equal(api.NoiseFilter.available, false);
});

test('failed resume while enabling noise reduction restores raw audio rather than keeping a dead route', async () => {
  const { api, contexts } = app();
  await api.setupMic(api.NoiseFilter.prepare());
  contexts[0].state = 'suspended';
  contexts[0].resume = async () => { throw new Error('resume denied'); };
  await api.toggleNoiseFilter();
  assert.equal(api.state.localStream, api.state.rawStream);
  assert.equal(api.state.rawStream.getAudioTracks()[0].enabled, true);
  assert.equal(api.NoiseFilter.available, false);
});

test('unsupported filter and capture resolving after exit do not stop valid audio or leak capture', async () => {
  const first = app();
  first.storage.set('cinemaonline:anti-ruido', 'on');
  first.context.window.AudioWorkletNode = undefined;
  await first.api.setupMic(first.api.NoiseFilter.prepare());
  assert.equal(first.api.state.localStream, first.api.state.rawStream);
  assert.equal(first.api.state.micAvailable, true);
  const second = app();
  let resolve;
  second.context.navigator.mediaDevices.getUserMedia = () => new Promise((r) => { resolve = r; });
  const setup = second.api.setupMic(Promise.resolve(false));
  second.api.state.ended = true;
  const raw = stream();
  resolve(raw);
  await setup;
  assert.equal(raw.getAudioTracks()[0].readyState, 'ended');
});

test('delayed heartbeats do not expire a room even after multiple films', () => {
  const { api, context } = app();
  let now = Date.now();
  context.Date = class extends Date { static now() { return now; } };
  api.state.joined = true;
  api.state.lastHostMsg = Date.now() - 12 * 60 * 60 * 1000;
  api.state.hostConn = new Connection('host');
  api.guestHeartbeat();
  assert.equal(api.state.ended, false);
  assert.equal(api.state.hostConn.open, true);
  api.state.isHost = true;
  const conn = new Connection('guest');
  api.handleGuestMessage(conn, { t: 'hello', name: 'Guest', muted: false });
  now += 12 * 60 * 60 * 1000;
  api.hostHeartbeat();
  assert.equal(api.state.participants.has('guest'), true);
  assert.equal(api.state.conns.get('guest').open, true);
});

test('reconnection reserves the seat and ignores old connection events', () => {
  const { api } = app();
  api.state.isHost = true;
  api.state.myId = 'a-host';
  api.state.participants = new Map([['a-host', { id: 'a-host', isHost: true }]]);
  const old = new Connection('z-guest');
  api.onGuestConnection(old);
  old.emit('data', { t: 'hello', name: 'Guest', muted: false });
  old.close();
  assert.equal(api.state.participants.get('z-guest').connected, false);
  api.state.participants.set('other1', { id: 'other1' });
  api.state.participants.set('other2', { id: 'other2' });
  const current = new Connection('z-guest');
  api.onGuestConnection(current);
  current.emit('data', { t: 'hello', name: 'Guest', muted: false });
  old.emit('close');
  old.emit('data', { t: 'bye' });
  assert.equal(api.state.conns.get('z-guest'), current);
  assert.equal(api.state.participants.get('z-guest').connected, true);
  assert.equal(current.messages[0].t, 'welcome');
  current.emit('data', { t: 'ping' });
  assert.equal(current.messages.at(-1).t, 'sync');
  current.emit('data', { t: 'bye' });
  assert.equal(api.state.participants.has('z-guest'), false);
});

test('guest reconnects without reloading the film, requesting mic again or duplicating timers', () => {
  const { api, player, intervals, context } = app();
  api.state.joined = true;
  api.state.video.url = 'https://example.com/movie.mp4';
  const timerCount = intervals.length;
  let captures = 0;
  context.navigator.mediaDevices.getUserMedia = async () => { captures++; return stream(); };
  api.connectToHost();
  const old = api.state.hostConn;
  old.close();
  assert.equal(api.state.ended, false);
  api.guestHeartbeat();
  const current = api.state.hostConn;
  assert.notEqual(current, old);
  current.emit('data', {
    t: 'welcome', participants: [{ id: api.state.myId, muted: true }],
    video: { url: api.state.video.url, playing: true, time: 3600 },
  });
  old.emit('close');
  assert.equal(api.state.hostConn, current);
  assert.equal(player.loads.length, 0);
  assert.equal(player.applies[0].time, 3600);
  assert.equal(captures, 0);
  assert.equal(intervals.length, timerCount);
  assert.equal(api.state.reconnecting, false);
});

test('signaling reconnects and failed data channels retry without ending the session', () => {
  const { api } = app();
  api.state.joined = true;
  api.state.peer.disconnected = true;
  api.state.hostConn = new Connection('host');
  const old = api.state.hostConn;
  old.peerConnection.connectionState = 'failed';
  api.guestHeartbeat();
  assert.equal(api.state.peer.disconnected, false);
  assert.notEqual(api.state.hostConn, old);
  assert.equal(api.state.ended, false);
});

test('explicit host shutdown still ends the session', () => {
  const { api } = app();
  api.state.peer.destroy = () => {};
  api.handleHostMessage({ t: 'end' });
  assert.equal(api.state.ended, true);
});

function installRecorder(instance, options = {}) {
  const recordings = [];
  class Recorder extends EventEmitter {
    static isTypeSupported(type) { return type.startsWith('audio/webm'); }
    constructor(capture, config) {
      super();
      this.capture = capture;
      this.mimeType = config.mimeType;
      this.state = 'inactive';
      recordings.push(this);
    }
    addEventListener(...args) { this.on(...args); }
    start() { this.state = 'recording'; }
    stop() {
      this.state = 'inactive';
      this.emit('dataavailable', { data: new Blob([new Uint8Array(options.bytes ?? 32)], { type: this.mimeType }) });
      this.emit('stop');
    }
  }
  instance.context.MediaRecorder = instance.context.window.MediaRecorder = Recorder;
  instance.api.state.joined = true;
  instance.api.state.hostConn = new Connection('host');
  instance.api.state.myName = 'Guest';
  return recordings;
}

test('voice messages can be previewed and sent while the live call stays muted', async () => {
  const instance = app();
  const recordings = installRecorder(instance);
  const { api, elements } = instance;
  await api.setupMic(Promise.resolve(false));
  api.setMuted(true);
  const liveTrack = api.state.rawStream.getAudioTracks()[0];
  await api.startVoiceRecording();
  assert.equal(recordings[0].capture.getAudioTracks()[0].enabled, true);
  assert.equal(liveTrack.enabled, false);
  api.stopVoiceRecording();
  assert.equal(recordings[0].capture.getAudioTracks()[0].readyState, 'ended');
  assert.equal(liveTrack.readyState, 'live');
  assert.equal(elements.get('#voice-preview').hidden, false);
  assert.equal(api.state.hostConn.messages.filter((m) => m.t === 'chat-audio').length, 0);
  await api.sendVoiceMessage();
  const sent = api.state.hostConn.messages.at(-1);
  assert.equal(sent.t, 'chat-audio');
  assert.equal(api.validVoiceMessage(sent), true);
  assert.equal(sent.audio.byteLength, 32);
  assert.equal(elements.get('#voice-composer').hidden, true);
  assert.equal(liveTrack.enabled, false);
});

test('voice messages are relayed with trusted identity and included in room history', async () => {
  const guest = app();
  installRecorder(guest);
  await guest.api.startVoiceRecording();
  guest.api.stopVoiceRecording();
  await guest.api.sendVoiceMessage();
  const host = app();
  host.api.state.isHost = true;
  const conn = new Connection('guest');
  host.api.handleGuestMessage(conn, { t: 'hello', name: 'Guest' });
  const other = new Connection('other');
  host.api.handleGuestMessage(other, { t: 'hello', name: 'Other' });
  const payload = { ...guest.api.state.hostConn.messages.at(-1), from: 'forged', name: 'forged' };
  host.api.handleGuestMessage(conn, payload);
  const stored = host.api.state.chat.at(-1);
  assert.equal(stored.from, 'guest');
  assert.equal(stored.name, 'Guest');
  assert.equal(other.messages.at(-1).t, 'chat-audio');
  assert.equal(host.elements.get('#chat-messages').children.at(-1).children.at(-1).controls, true);
  const newcomer = new Connection('new');
  host.api.handleGuestMessage(newcomer, { t: 'hello', name: 'New' });
  const history = newcomer.messages[0].chat;
  assert.equal(history.at(-1).audio.byteLength, 32);
});

test('invalid voice payloads are refused and audio history has a byte budget', () => {
  const { api } = app();
  api.state.isHost = true;
  const conn = new Connection('guest');
  api.handleGuestMessage(conn, { t: 'hello', name: 'Guest' });
  const message = { t: 'chat-audio', audio: new ArrayBuffer(1024 * 1024), mime: 'audio/webm;codecs=opus', duration: 60 };
  for (const invalid of [
    { audio: new ArrayBuffer(0) }, { audio: new ArrayBuffer(1024 * 1024 + 1) },
    { audio: 'data:text/html,test' }, { mime: 'text/html' },
    { duration: 0 }, { duration: 61 }, { duration: NaN },
  ]) {
    api.handleGuestMessage(conn, { ...message, ...invalid });
    assert.equal(conn.messages.at(-1).t, 'chat-error');
    assert.equal(api.state.chat.length, 0);
  }
  for (let i = 0; i < 10; i++) api.handleGuestMessage(conn, message);
  assert.equal(api.state.chat.length, 8);
});

test('cancel, empty recordings and oversized recordings release capture without sending', async () => {
  for (const bytes of [0, 1024 * 1024 + 1, 32]) {
    const instance = app();
    const recordings = installRecorder(instance, { bytes });
    await instance.api.startVoiceRecording();
    if (bytes === 32) instance.api.cancelVoiceRecording();
    else instance.api.stopVoiceRecording();
    assert.equal(recordings[0].capture.getAudioTracks()[0].readyState, 'ended');
    assert.equal(instance.api.state.hostConn.messages.length, 0);
    assert.equal(instance.elements.get('#voice-composer').hidden, true);
  }
});

test('cancelled permission request and recording teardown release only their own capture', async () => {
  const instance = app();
  installRecorder(instance);
  let resolve;
  instance.context.navigator.mediaDevices.getUserMedia = () => new Promise((r) => { resolve = r; });
  const pending = instance.api.startVoiceRecording();
  instance.api.cancelVoiceRecording();
  const raw = stream();
  resolve(raw);
  await pending;
  assert.equal(raw.getAudioTracks()[0].readyState, 'ended');
  instance.context.navigator.mediaDevices.getUserMedia = async () => stream();
  await instance.api.startVoiceRecording();
  instance.api.state.peer.destroy = () => {};
  instance.api.state.ended = true;
  instance.api.teardown();
  assert.equal(instance.elements.get('#voice-composer').hidden, true);
  assert.equal(instance.api.state.hostConn.messages.length, 0);
});

test('disconnected voice send keeps the preview for a retry', async () => {
  const instance = app();
  installRecorder(instance);
  await instance.api.startVoiceRecording();
  instance.api.stopVoiceRecording();
  instance.api.state.hostConn.open = false;
  await instance.api.sendVoiceMessage();
  assert.equal(instance.elements.get('#voice-preview').hidden, false);
  assert.match(instance.messages.at(-1), /conexão/);
  instance.api.cancelVoiceRecording();
});

test('emoji picker inserts at the selection and refuses to split an emoji at the text limit', () => {
  const { api, context, elements, messages } = app();
  api.setupEmojis();
  const smile = elements.get('#emoji-picker').children[1].children[0];
  const input = context.document.querySelector('#chat-input');
  input.value = 'Oi mundo';
  input.selectionStart = 3;
  input.selectionEnd = 8;
  smile.emit('click');
  assert.equal(input.value, 'Oi 😀');
  input.value = 'x'.repeat(499);
  input.selectionStart = input.selectionEnd = 499;
  smile.emit('click');
  assert.equal(input.value.length, 499);
  assert.match(messages.at(-1), /500/);
});

test('worklet passes through audio before readiness and reports asynchronous WASM failure', async () => {
  const worklet = readFileSync(path.join(__dirname, '..', 'vendor', 'noise-suppressor', 'rnnoiseWorklet.js'), 'utf8');
  const code = worklet.slice(worklet.indexOf('class CinemaNoiseProcessor'));
  for (const failure of [false, true]) {
    let resolve;
    let Processor;
    const statuses = [];
    vm.runInNewContext(code, {
      AudioWorkletProcessor: class { constructor() { this.port = { postMessage: (m) => statuses.push(m) }; } },
      s: { loadBinary: () => new Promise((r, reject) => { resolve = failure ? () => reject(new Error('bad wasm')) : r; }) },
      p: () => ({ process: (input, output) => output[0].set(input[0].map((s) => s * 0.5)), destroy() {} }),
      registerProcessor: (name, ctor) => { Processor = ctor; },
    });
    const processor = new Processor({ processorOptions: { maxChannels: 1 } });
    const input = new Float32Array([0.2, -0.3, 0.1]);
    const output = new Float32Array(3);
    processor.process([[input]], [[output]]);
    assert.deepEqual(output, input);
    resolve({});
    await flush();
    assert.equal(statuses[0].type, failure ? 'error' : 'ready');
    processor.process([[input]], [[output]]);
    assert.deepEqual(output, failure ? input : input.map((s) => s * 0.5));
    processor.port.onmessage({ data: 'destroy' });
    assert.equal(processor.process([[input]], [[output]]), false);
  }
});
