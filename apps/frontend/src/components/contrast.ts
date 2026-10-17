// WCAG 2.2 contrast (1.4.3, 1.4.11) for the palette test and for track colours drawn as text.

const channels = (hex: string) => {
  const h = hex.replace('#', '');
  const full = h.length === 3 ? [...h].map((c) => c + c).join('') : h.slice(0, 6);
  return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16));
};

const luminance = (hex: string) => {
  const [r, g, b] = channels(hex).map((v) => { const c = v / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

export const contrastRatio = (a: string, b: string) => {
  const x = luminance(a), y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
};

const toHsl = (hex: string): [number, number, number] => {
  const [r, g, b] = channels(hex).map((v) => v / 255);
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2, d = max - min;
  if (!d) return [0, 0, l];
  const s = d / (1 - Math.abs(2 * l - 1));
  const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [(h * 60 + 360) % 360, s, l];
};

const fromHsl = (h: number, s: number, l: number) => {
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => { const k = (n + h / 30) % 12; return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)); };
  return '#' + [f(0), f(8), f(4)].map((v) => Math.round(v * 255).toString(16).padStart(2, '0')).join('');
};

// A colour the user picked, as text on a background: same hue and saturation,
// lighter until it reaches the ratio (the colour itself when it already does)
export function readableOn(color: string, background: string, ratio = 4.5) {
  if (contrastRatio(color, background) >= ratio) return color;
  const [h, s, l] = toHsl(color);
  for (let step = l + 0.01; step <= 1; step += 0.01) {
    const candidate = fromHsl(h, s, step);
    if (contrastRatio(candidate, background) >= ratio) return candidate;
  }
  return '#ffffff';
}
