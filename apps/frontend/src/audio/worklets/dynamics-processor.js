// NoProd dynamics processor (AudioWorklet): stereo-linked feed-forward
// compressor shared by the Compressor and Glue Compressor devices.
//
// Per sample: peak detect -> static gain curve with soft knee (dB) ->
// gain reduction clamped to `range` -> attack/release smoothing in the dB
// domain -> makeup -> dry/wet -> optional tanh soft clip.
// `release` <= 0 selects program-dependent auto release (Glue's "Auto").
// Posts { gr } (current gain reduction in dB, <= 0) ~40 times a second.

class NoProdDynamicsProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'threshold', defaultValue: -18, minValue: -80, maxValue: 0, automationRate: 'k-rate' },
      { name: 'ratio', defaultValue: 4, minValue: 1, maxValue: 100, automationRate: 'k-rate' },
      { name: 'attack', defaultValue: 0.01, minValue: 0.00001, maxValue: 1, automationRate: 'k-rate' },
      { name: 'release', defaultValue: 0.1, minValue: 0, maxValue: 5, automationRate: 'k-rate' },
      { name: 'knee', defaultValue: 6, minValue: 0, maxValue: 40, automationRate: 'k-rate' },
      { name: 'makeup', defaultValue: 0, minValue: -24, maxValue: 40, automationRate: 'k-rate' },
      { name: 'range', defaultValue: 100, minValue: 0, maxValue: 100, automationRate: 'k-rate' },
      { name: 'mix', defaultValue: 1, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'softClip', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' }
    ];
  }

  constructor() {
    super();
    this.env = 0;       // smoothed gain reduction (dB, <= 0)
    this.slowEnv = 0;   // long-term reduction, drives auto release
    this.meterCountdown = 0;
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0];
    const output = outputs[0];
    const sr = sampleRate;
    const threshold = parameters.threshold[0];
    const ratio = Math.max(1, parameters.ratio[0]);
    const knee = parameters.knee[0];
    const range = parameters.range[0];
    const mix = parameters.mix[0];
    const softClip = parameters.softClip[0] >= 0.5;
    const makeup = Math.pow(10, parameters.makeup[0] / 20);
    const attCoef = Math.exp(-1 / (Math.max(0.00001, parameters.attack[0]) * sr));
    const release = parameters.release[0];
    const slope = 1 / ratio - 1;
    const slowCoef = Math.exp(-1 / (2 * sr));

    const frames = output[0] ? output[0].length : 128;
    const chans = output.length;
    const inL = input[0];
    const inR = input[1] || input[0];

    for (let i = 0; i < frames; i++) {
      const l = inL ? inL[i] : 0;
      const r = inR ? inR[i] : 0;
      const peak = Math.max(Math.abs(l), Math.abs(r));
      const xDb = peak > 1e-6 ? 20 * Math.log10(peak) : -120;

      // Static curve: target gain reduction in dB
      const over = xDb - threshold;
      let target = 0;
      if (knee > 0 && 2 * Math.abs(over) <= knee) {
        target = (slope * (over + knee / 2) * (over + knee / 2)) / (2 * knee);
      } else if (over > 0) {
        target = slope * over;
      }
      if (target < -range) target = -range;

      let relCoef;
      if (release > 0) {
        relCoef = Math.exp(-1 / (release * sr));
      } else {
        // Auto: short release after transients, longer once reduction is sustained
        const sustained = Math.min(1, -this.slowEnv / 6);
        relCoef = Math.exp(-1 / ((0.08 + 1.1 * sustained) * sr));
      }
      const coef = target < this.env ? attCoef : relCoef;
      this.env = coef * this.env + (1 - coef) * target;
      this.slowEnv = slowCoef * this.slowEnv + (1 - slowCoef) * this.env;

      const g = Math.pow(10, this.env / 20) * makeup;
      for (let c = 0; c < chans; c++) {
        const x = c === 0 ? l : c === 1 ? r : (inL ? inL[i] : 0);
        let y = x * (1 - mix) + x * g * mix;
        if (softClip) y = Math.tanh(y);
        output[c][i] = y;
      }
    }

    this.meterCountdown -= frames;
    if (this.meterCountdown <= 0) {
      this.port.postMessage({ gr: this.env });
      this.meterCountdown = Math.floor(sr / 40);
    }
    return true;
  }
}

registerProcessor('noprod-dynamics', NoProdDynamicsProcessor);
