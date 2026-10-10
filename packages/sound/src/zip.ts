// A zip archive of files stored as they are (no compression: WAVs barely
// shrink), for exporting several sounds at once.

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

export function crc32(data: Uint8Array) {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export interface ZipEntry {
  name: string;      // path inside the archive
  data: Uint8Array;
}

export function zip(entries: ZipEntry[]): Uint8Array {
  const encoder = new TextEncoder();
  const files = entries.map((e) => ({ ...e, path: encoder.encode(e.name), crc: crc32(e.data) }));
  const localSize = files.reduce((n, f) => n + 30 + f.path.length + f.data.length, 0);
  const centralSize = files.reduce((n, f) => n + 46 + f.path.length, 0);
  const out = new Uint8Array(localSize + centralSize + 22);
  const view = new DataView(out.buffer);
  let at = 0;
  const offsets: number[] = [];

  // version 2.0, UTF-8 names, stored, no date
  const common = (f: (typeof files)[number], start: number) => {
    view.setUint16(start, 20, true);
    view.setUint16(start + 2, 0x0800, true);
    view.setUint16(start + 4, 0, true);
    view.setUint32(start + 6, 0, true);
    view.setUint32(start + 10, f.crc, true);
    view.setUint32(start + 14, f.data.length, true);
    view.setUint32(start + 18, f.data.length, true);
    view.setUint16(start + 22, f.path.length, true);
    view.setUint16(start + 24, 0, true);
  };

  for (const f of files) {
    offsets.push(at);
    view.setUint32(at, 0x04034b50, true);
    common(f, at + 4);
    out.set(f.path, at + 30);
    out.set(f.data, at + 30 + f.path.length);
    at += 30 + f.path.length + f.data.length;
  }
  const centralStart = at;
  files.forEach((f, i) => {
    view.setUint32(at, 0x02014b50, true);
    view.setUint16(at + 4, 20, true); // made by
    common(f, at + 6);
    view.setUint16(at + 32, 0, true); // comment
    view.setUint16(at + 34, 0, true); // disk
    view.setUint16(at + 36, 0, true); // internal attributes
    view.setUint32(at + 38, 0, true); // external attributes
    view.setUint32(at + 42, offsets[i], true);
    out.set(f.path, at + 46);
    at += 46 + f.path.length;
  });
  view.setUint32(at, 0x06054b50, true);
  view.setUint16(at + 8, files.length, true);
  view.setUint16(at + 10, files.length, true);
  view.setUint32(at + 12, at - centralStart, true);
  view.setUint32(at + 16, centralStart, true);
  return out;
}
