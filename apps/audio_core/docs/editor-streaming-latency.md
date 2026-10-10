# Plugin editor streaming: latency spike (#44 B6a)

The plan for plugin editors (#44 B6) is to render each editor off-screen in
the Audio Core and stream its pixels to the browser over a WebSocket, with
mouse input relayed back. Before building the rest of that pipeline, B6a
asked for end-to-end measurements of render → encode → send → decode → paint,
and of the input round trip. This is that measurement.

## What was measured

- **Server:** `tools/EditorStreamSpike.cpp` (build with `-DGHOSTDAW_BUILD_TOOLS=ON`).
  It serves a synthetic reverb editor (knobs, waveform, meter, a mouse-driven
  knob, drawn with JUCE's software renderer) through `src/editor/EditorStream.h`:
  - one render thread per connection;
  - ambient frames at a fixed rate, plus an immediate frame on every input;
  - full RGBA frames, raw or zlib-deflated (level 1);
  - one binary WebSocket message per frame on port 8084.
- **Browser:** `apps/frontend/editor-spike.html` (Vite dev server) mounts
  `PluginEditorCanvas`:
  - decodes frames with `DecompressionStream('deflate')`;
  - paints with `putImageData` and stamps the next animation frame as "on screen";
  - when frames pile up, draws only the newest one;
  - sends pointer events back as `INPUT` messages.
  - (The first measurements below decoded on the main thread without
    backpressure; see the follow-up section for the current pipeline.)
- **Per frame:**
  - render and encode time in the Audio Core;
  - transfer (send → received, same-machine wall clocks);
  - decode and draw time;
  - received → on screen.
  - For input, the pointer event's timestamp travels with the frame that
    answers it, giving **input → on screen**.
- **Run:**
  - 5 s of ambient frames at 20 fps;
  - then 60 drag events 33 ms apart (a fast knob drag);
  - in headless Chromium (software compositing) on a 4-core 2.1 GHz Xeon VM;
  - server and browser on the same machine.

Reproduce: start `EditorStreamSpike --size 800x600`, then open
`http://localhost:5173/editor-spike.html?compression=deflate&fps=20`.

## Results

Milliseconds, p50 / p95.

| Size | Encoding | KB/frame | Render | Encode | Transfer | Decode | Received → screen | **Input → screen** |
| --- | --- | ---: | --- | --- | --- | --- | --- | --- |
| 400×300 | raw | 469 | 0.9 / 1.2 | 0.2 / 0.3 | 2.8 / 3.5 | 0.3 / 0.5 | 4.7 / 5.6 | **15.9 / 24.6** |
| 400×300 | deflate | 15 | 0.9 / 1.2 | 1.3 / 1.8 | 0.8 / 1.1 | 3.3 / 3.9 | 16.3 / 17.0 | **16.9 / 30.2** |
| 800×600 | raw | 1875 | 2.3 / 3.4 | 1.0 / 1.3 | 11.5 / 15.0 | 0.9 / 1.6 | 10.9 / 14.1 | **56.3 / 162.5** |
| 800×600 | deflate | 41 | 2.4 / 3.5 | 4.7 / 7.1 | 1.2 / 1.9 | 6.7 / 8.5 | 10.4 / 23.6 | **26.6 / 35.0** |
| 1200×800 | raw | 3750 | 4.3 / 6.8 | 2.1 / 2.7 | 24.5 / 36.8 | 2.0 / 2.7 | 21.6 / 27.5 | **259.6 / 294.8** |
| 1200×800 | deflate | 60 | 4.2 / 5.1 | 9.2 / 12.4 | 0.9 / 1.4 | 10.6 / 14.5 | 19.3 / 27.9 | **35.7 / 55.1** |
| 800×600, 60 fps | deflate | 40 | 2.1 / 2.9 | 4.7 / 6.3 | 0.8 / 1.4 | 6.3 / 8.3 | 23.5 / 24.6 | **28.1 / 34.4** |

The 20 fps runs held their 20 fps ambient rate with no dropped frames. The
60 fps run held 59.4 fps and dropped 3 frames.

## What it says

1. **Full frames + generic lossless compression is good enough for v1.**
   - With deflate at level 1, a typical 800×600 editor answers a drag in
     about 27 ms (p50) / 35 ms (p95).
   - A large 1200×800 editor answers in 36 / 55 ms.
   - 20 fps ambient is easy, and 60 fps still fits at 800×600.
   - Frames are 15–60 KB, so bandwidth is no concern even over a real network.
2. **Raw frames are only fine for small editors.** At 800×600 and above,
   1.9–3.7 MB per frame takes 11–25 ms just to move through the socket. When
   input triggers frames faster than that, they queue: 160–300 ms of lag. Use
   deflate by default.
3. **The costs are encode (server) and decode (browser), not the network.**
   Both scale with pixel count:
   - deflate at 1200×800 costs about 9 ms to encode and 11 ms to decode;
   - the transfer itself is about 1 ms on localhost.
4. **Input lag is dominated by frame pacing.** The frame answering an input
   waits behind any frame already being encoded, decoded or painted.
   Received → on screen (10–25 ms) includes waiting for the next animation
   frame.

## Follow-up: backpressure and decoding off the main thread

Two of the recommendations below were cheap enough to do right away, and to
measure.

**Backpressure:**
- The browser acknowledges each frame once it has decoded it.
- The Audio Core renders nothing new while `window` frames are unacknowledged.

**Decoding off the main thread:**
- A worker (`native/editorStreamWorker.ts`) owns the socket and inflates frames.
- It hands the pixels to the canvas without copying.
- The canvas only runs `putImageData` (0.2–0.8 ms) on the main thread.

How large a window? Input → screen in ms, p50 / p95, same scenario as above:

| Size | Encoding | No acks, main-thread decode | Window 1 | Window 2 | Window 3 |
| --- | --- | --- | --- | --- | --- |
| 400×300 | raw | 15.9 / 24.6 | 12.4 / 15.9 | 13.8 / 18.8 | 10.2 / 23.6 |
| 400×300 | deflate | 16.9 / 30.2 | 15.1 / 20.1 | 18.4 / 23.0 | 13.5 / 25.2 |
| 800×600 | raw | 56.3 / 162.5 | 45.6 / 62.2 | 61.0 / 85.4 | 90.2 / 120.5 |
| 800×600 | deflate | 26.6 / 35.0 | 24.5 / 40.5 | 23.2 / 33.6 | 24.1 / 34.3 |
| 1200×800 | raw | 259.6 / 294.8 | 87.3 / 104.2 | 126.7 / 148.8 | 179.7 / 198.7 |
| 1200×800 | deflate | 35.7 / 55.1 | 43.4 / 63.0 | 38.9 / 60.7 | 38.6 / 66.5 |

**What the table shows:**
- **Raw frames need a window of 1.** Any larger window and the 2–4 MB frames
  queue in the socket again.
- **Deflated frames do best with a window of 2.** The next frame encodes
  while the browser decodes the last one. Latency is as good as without
  acknowledgements, and the queue is still bounded.
- These are now the defaults: `EditorStreamer` picks the window from the
  compression unless the browser asks for one.

Final defaults (deflate, window 2):

| Size | Input → screen |
| --- | --- |
| 400×300 | 16.6 / 20.4 ms |
| 800×600 | 27.8 / 32.9 ms |
| 1200×800 | 40.4 / 57.4 ms |

For comparison, raw frames at window 1: 800×600 is 46.3 / 66.5 ms and
1200×800 is 89.3 / 112.9 ms. All runs held 20 fps ambient.

## Recommendations for B6c–e

- **Keep full frames + deflate (level 1)** as v1 planned. Dirty-rect encoding
  can stay deferred: deflate already squeezes the unchanged areas.
- **Backpressure:** done (above). Frames are acknowledged on decode, with a
  window of 2 for deflate and 1 for raw.
- **Coalesce input on the server**, as `EditorStreamer` already does: inputs
  that arrive during a render are answered by the next frame.
- **Decode off the main thread:** done (above). An `OffscreenCanvas` in the
  worker could take `putImageData` off the main thread too, but at under 1 ms
  per frame it isn't needed yet.
- **Measure render cost again with cuif.** The synthetic editor uses JUCE's
  CPU renderer. cuif renders with OpenGL and needs a GPU → CPU readback.
  The extension now exists (v-loudio-t #111), but the Reverb's editor only
  builds for Windows, so this is still to measure on a Windows machine.

The streaming pieces built for the spike became B6c / B6d:
- `EditorStream.h` is the render / encode / send loop behind a
  `FrameSource` interface;
- `PluginEditorCanvas.tsx` draws the frames in the browser;
- `src/editor/LpiEditor.h` adapts LPI's off-screen GUI extension
  (`lpi.gui.offscreen.v1`) to `FrameSource`.

See "Plugin editors" in the Audio Core README.
