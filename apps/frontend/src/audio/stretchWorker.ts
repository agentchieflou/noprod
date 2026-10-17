// Time-stretching warped clips off the main thread (warp.ts asks): the
// package's phase vocoder, a whole clip at a time.

import { stretch, type StretchOptions } from '@noprod/sound';

type Message = { id: number; channels: Float32Array[]; options: StretchOptions };

self.onmessage = (e: MessageEvent<Message>) => {
  const post = (data: unknown, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage(data, transfer);
  const { id, channels, options } = e.data;
  try {
    const out = stretch(channels, options);
    post({ id, channels: out }, out.map((c) => c.buffer));
  } catch (err) {
    post({ id, error: String(err) });
  }
};
