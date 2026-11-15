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
  const element = (selector) => {
    if (!elements.has(selector)) {
      elements.set(selector, {
        addEventListener() {}, append() {}, appendChild() {},
        dataset: {}, style: { setProperty() {} },
        classList: { toggle(key, value) { this[key] = value; } },
        setAttribute(key, value) { this[key] = value; },
      });
    }
    return elements.get(selector);
  };
  class Context extends AudioContextMock {
    constructor(...args) { super(...args); contexts.push(this); }
  }
  class Worklet extends AudioNode {
    constructor(...args) { super(...args); this.options = args[2]; worklets.push(this); }
  }
  const context = vm.createContext({
    console: { warn() {}, error() {} }, URL, Map, Set, Uint8Array,
    document: { querySelector: element, createElement: element, addEventListener() {} },
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
      hostHeartbeat, guestHeartbeat, connectToHost, teardown
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
  return { api, context, elements, messages, intervals, worklets, contexts, player, storage };
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
