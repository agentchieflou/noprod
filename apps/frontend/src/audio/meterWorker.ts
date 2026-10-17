// Master loudness off the main thread: measures the blocks the meter worklet
// sends (see worklets/meter-processor.js) and posts the readings back about
// ten times a second.

import { analysis } from '@noprod/sound';

export interface LoudnessReadings { momentary: number; shortTerm: number; integrated: number; truePeak: number }

const REPORT_MS = 100;

let meter: analysis.LoudnessMeter | null = null;
let lastReport = 0;

const report = () => {
  if (!meter) return;
  const readings: LoudnessReadings = { momentary: meter.momentary, shortTerm: meter.shortTerm, integrated: meter.integrated, truePeak: meter.truePeak };
  (self as unknown as Worker).postMessage(readings);
  lastReport = performance.now();
};

self.onmessage = (e: MessageEvent) => {
  if (e.data.type === 'reset') { meter?.reset(); report(); return; }
  meter = new analysis.LoudnessMeter(e.data.sampleRate);
  const port: MessagePort = e.data.port;
  port.onmessage = (block: MessageEvent<[Float32Array, Float32Array]>) => {
    meter!.push(block.data[0], block.data[1]);
    port.postMessage(block.data, [block.data[0].buffer, block.data[1].buffer]); // back to the worklet's pool
    if (performance.now() - lastReport >= REPORT_MS) report();
  };
};
