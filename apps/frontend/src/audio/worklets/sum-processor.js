// A strip's input: sums what feeds it in the order of its inputs, so a mix
// adds up the same way every time. A native node with several connections
// sums them in whatever order the browser keeps them, which differs from one
// context to the next by a rounding error; a render must not. Input 0 is
// for the strip's own sources (the engine worklet, a monitored input);
// the mixer gives each routed strip and send an input of its own.
class SumProcessor extends AudioWorkletProcessor {
  process(inputs, outputs) {
    const out = outputs[0];
    const l = out[0], r = out[1] || out[0];
    l.fill(0);
    if (r !== l) r.fill(0);
    for (let i = 0; i < inputs.length; i++) {
      const input = inputs[i];
      if (!input.length) continue;
      const a = input[0], b = input[1] || input[0];
      for (let k = 0; k < l.length; k++) { l[k] += a[k]; r[k] += b[k]; }
    }
    return true;
  }
}

registerProcessor('noprod-sum', SumProcessor);
