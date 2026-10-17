// One second-order section, direct form II transposed, with the
// coefficients the Web Audio spec gives BiquadFilterNode, so a filter here
// sounds as the native node did. As there, a lowpass or highpass takes its
// Q in dB; the rest take a plain ratio.

export type BiquadType = 'lowpass' | 'highpass' | 'bandpass' | 'notch' | 'peaking' | 'lowshelf' | 'highshelf';

export class Biquad {
  private b0 = 1; private b1 = 0; private b2 = 0; private a1 = 0; private a2 = 0;
  private z1 = 0; private z2 = 0;

  set(type: BiquadType, freq: number, q: number, gainDb: number, sampleRate: number) {
    const w0 = (2 * Math.PI * Math.min(Math.max(freq, 1), sampleRate / 2 - 1)) / sampleRate;
    const cos = Math.cos(w0), sin = Math.sin(w0);
    const A = Math.pow(10, gainDb / 40);
    let b0: number, b1: number, b2: number, a0: number, a1: number, a2: number;
    switch (type) {
      case 'lowpass': case 'highpass': {
        const alpha = sin / (2 * Math.pow(10, q / 20));
        const s = type === 'lowpass' ? 1 : -1;
        b0 = (1 - s * cos) / 2; b1 = s * (1 - s * cos); b2 = (1 - s * cos) / 2;
        a0 = 1 + alpha; a1 = -2 * cos; a2 = 1 - alpha;
        break;
      }
      case 'bandpass': {
        const alpha = sin / (2 * Math.max(q, 1e-4));
        b0 = alpha; b1 = 0; b2 = -alpha;
        a0 = 1 + alpha; a1 = -2 * cos; a2 = 1 - alpha;
        break;
      }
      case 'notch': {
        const alpha = sin / (2 * Math.max(q, 1e-4));
        b0 = 1; b1 = -2 * cos; b2 = 1;
        a0 = 1 + alpha; a1 = -2 * cos; a2 = 1 - alpha;
        break;
      }
      case 'peaking': {
        const alpha = sin / (2 * Math.max(q, 1e-4));
        b0 = 1 + alpha * A; b1 = -2 * cos; b2 = 1 - alpha * A;
        a0 = 1 + alpha / A; a1 = -2 * cos; a2 = 1 - alpha / A;
        break;
      }
      default: { // shelves
        const s = type === 'lowshelf' ? 1 : -1;
        const alpha = (sin / 2) * Math.sqrt((A + 1 / A) * (1 / Math.max(q, 1e-4) - 1) + 2);
        const k = 2 * Math.sqrt(A) * alpha;
        b0 = A * ((A + 1) - s * (A - 1) * cos + k);
        b1 = s * 2 * A * ((A - 1) - s * (A + 1) * cos);
        b2 = A * ((A + 1) - s * (A - 1) * cos - k);
        a0 = (A + 1) + s * (A - 1) * cos + k;
        a1 = -s * 2 * ((A - 1) + s * (A + 1) * cos);
        a2 = (A + 1) + s * (A - 1) * cos - k;
      }
    }
    this.b0 = b0 / a0; this.b1 = b1 / a0; this.b2 = b2 / a0; this.a1 = a1 / a0; this.a2 = a2 / a0;
  }

  tick(x: number): number {
    const y = this.b0 * x + this.z1;
    this.z1 = this.b1 * x - this.a1 * y + this.z2;
    this.z2 = this.b2 * x - this.a2 * y;
    return y;
  }
}
