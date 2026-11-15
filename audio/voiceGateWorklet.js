// Gate de voz: só deixa o som passar quando há energia sustentada na faixa da fala.
// Batidas graves ficam fora da faixa analisada e cliques curtos não duram o suficiente
// para abrir o gate. Um pequeno atraso (lookahead) preserva o início das palavras.
class VoiceGateProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const o = (options && options.processorOptions) || {};
    const ms = (v) => Math.max(1, Math.round((sampleRate * v) / 1000));

    this.openLevel = 10 ** ((o.openDb ?? -46) / 20);
    this.closeLevel = 10 ** ((o.closeDb ?? -54) / 20);
    this.minSpeech = ms(o.minSpeechMs ?? 90);
    this.holdTime = ms(o.holdMs ?? 300);
    this.delay = ms(o.lookaheadMs ?? 100);

    this.ring = new Float32Array(this.delay + 1);
    this.pos = 0;

    const dt = 1 / sampleRate;
    const rcHp = 1 / (2 * Math.PI * 250);
    const rcLp = 1 / (2 * Math.PI * 3500);
    this.aHp = rcHp / (rcHp + dt);
    this.aLp = dt / (rcLp + dt);
    this.aEnv = 1 - Math.exp(-1 / (sampleRate * 0.012));
    this.attack = 1 - Math.exp(-1 / (sampleRate * 0.004));
    this.release = 1 - Math.exp(-1 / (sampleRate * 0.06));

    this.hpX = 0;
    this.hpY = 0;
    this.hp2X = 0;
    this.hp2Y = 0;
    this.lp = 0;
    this.env = 0;
    this.above = 0;
    this.hold = 0;
    this.open = false;
    this.gain = 0;

    // Nível do ruído de fundo do ambiente: desce rápido, sobe devagar (ventilador, ar-condicionado...).
    this.floor = this.closeLevel;
    this.floorDown = 1 - Math.exp(-1 / (sampleRate * 0.15));
    this.floorUp = 1 - Math.exp(-1 / (sampleRate * 4));
  }

  process(inputs, outputs) {
    const input = inputs[0];
    const output = outputs[0];
    if (!output || !output.length) return true;
    const x = input && input[0];
    const out = output[0];

    for (let i = 0; i < out.length; i++) {
      const s = x ? x[i] : 0;

      // Cadeia de análise: passa-faixa ~250–3500 Hz (passa-alta de 2ª ordem) + envelope RMS.
      const hp1 = this.aHp * (this.hpY + s - this.hpX);
      this.hpX = s;
      this.hpY = hp1;
      const hp = this.aHp * (this.hp2Y + hp1 - this.hp2X);
      this.hp2X = hp1;
      this.hp2Y = hp;
      this.lp += this.aLp * (hp - this.lp);
      this.env += this.aEnv * (this.lp * this.lp - this.env);
      const level = Math.sqrt(this.env);

      if (!this.open) this.floor += (level < this.floor ? this.floorDown : this.floorUp) * (level - this.floor);
      const openAt = Math.max(this.openLevel, this.floor * 3.2);   // +10 dB acima do fundo
      const closeAt = Math.max(this.closeLevel, this.floor * 2);   // +6 dB acima do fundo

      if (level > openAt) this.above++;
      else this.above = 0;

      if (!this.open && this.above >= this.minSpeech) {
        this.open = true;
        this.hold = this.holdTime;
      } else if (this.open) {
        if (level > closeAt) this.hold = this.holdTime;
        else if (--this.hold <= 0) this.open = false;
      }

      const target = this.open ? 1 : 0;
      this.gain += (target > this.gain ? this.attack : this.release) * (target - this.gain);

      const delayed = this.ring[this.pos];
      this.ring[this.pos] = s;
      this.pos = (this.pos + 1) % this.ring.length;
      out[i] = delayed * this.gain;
    }

    for (let c = 1; c < output.length; c++) output[c].set(out);
    return true;
  }
}

registerProcessor('cinemaonline-voice-gate', VoiceGateProcessor);
