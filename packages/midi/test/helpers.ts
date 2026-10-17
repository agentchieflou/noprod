// Fixtures built from bytes, so no binary files are checked in
export const vlq = (n: number): number[] => {
  const out = [n & 0x7f];
  for (let v = Math.floor(n / 128); v > 0; v = Math.floor(v / 128)) out.unshift((v & 0x7f) | 0x80);
  return out;
};
const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));
const u32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const u16 = (n: number) => [(n >> 8) & 255, n & 255];

export const chunk = (type: string, body: number[]) => [...ascii(type), ...u32(body.length), ...body];
export const header = (format: number, tracks: number, division: number) => chunk('MThd', [...u16(format), ...u16(tracks), ...u16(division)]);
export const END = [0, 0xff, 0x2f, 0];
// A track from (delta, bytes...) events; End of Track is added unless `end` is false
export const track = (events: number[][], end = true) => chunk('MTrk', [...events.flatMap((e) => e), ...(end ? END : [])]);
export const ev = (delta: number, ...bytes: number[]) => [...vlq(delta), ...bytes];
export const smf = (format: number, division: number, tracks: number[][]) =>
  Uint8Array.from([...header(format, tracks.length, division), ...tracks.flat()]);
export const tempoEv = (delta: number, bpm: number) => {
  const us = Math.round(60e6 / bpm);
  return ev(delta, 0xff, 0x51, 3, us >> 16, (us >> 8) & 255, us & 255);
};
export const meterEv = (delta: number, n: number, dd: number) => ev(delta, 0xff, 0x58, 4, n, dd, 24, 8);
