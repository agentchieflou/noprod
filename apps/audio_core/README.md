# Audio Core (GhostDAW)

Headless JUCE app that renders the Sequencer's haps, **one track per Strudel
orbit**, through per-track and master insert chains of hosted plugins: VST3
(all platforms), AudioUnit (macOS) and LPI, the Loudio Plugin Interface from
[v-loudio-t](https://github.com/agentchieflou/v-loudio-t). A pattern picks its
track with `.orbit(n)` (orbit 1 is Strudel's default). GhostDAW listens on
`ws://localhost:8082` for the Orchestrator, which relays the frontend's plugin
commands and sends the replies back.

It also hosts plugins for the **browser's own tracks**: a track device with a
plugin path streams the track's audio to `ws://localhost:8083` in 256-frame
blocks, GhostDAW runs it through that device's plugin and sends it straight
back, and the browser plays it a fixed ~40 ms later (delaying the other
tracks, the metronome and recordings to match). See `src/TrackStreams.h` and
`apps/frontend/src/native/trackBridge.ts`.

**Plugin editors** are shown in the browser: an LPI plugin with the
`lpi.gui.offscreen.v1` extension renders its editor off-screen in GhostDAW,
which streams the frames from `ws://localhost:8085` and takes mouse input
back. See [Plugin editors](#plugin-editors) below.

Plugin commands load code from disk, so the WebSocket servers (GhostDAW,
Orchestrator, Sequencer) refuse browser connections from other sites: only
clients without an `Origin` header and pages served from `localhost`,
`127.0.0.1` or `[::1]` get in. Add more origins with
`NOPROD_ALLOWED_ORIGINS=https://example.com,...`.

## Build

```sh
git submodule update --init apps/audio_core/JUCE
cmake -S apps/audio_core -B build/audio_core -DCMAKE_BUILD_TYPE=Release
cmake --build build/audio_core
```

On Linux, JUCE needs the ALSA, X11 and FreeType headers
(`libasound2-dev libx11-dev libxrandr-dev libxinerama-dev libxcursor-dev libfreetype-dev libfontconfig1-dev`).

Options:
- `--plugin-cache <file>` keeps the scanned plugin list somewhere other than
  the user app-data folder (`NoProd/GhostDAW/known-plugins.xml`).
- `--no-scan` skips the startup scan of the default VST3 folders.

## Tests

```sh
cmake -S apps/audio_core -B build/audio_core -DGHOSTDAW_BUILD_TESTS=ON
cmake --build build/audio_core
build/audio_core/tests/GhostDAWTests_artefacts/Release/GhostDAWTests
```

The tests build their own plugins: an LPI gain in good, wrong-ABI and
no-export variants, an LPI gain with an off-screen editor (plus variants
with latency, and without `lpi.params.changes.v1`), and a JUCE VST3 gain. They cover:
- loading, processing and parameter changes;
- scanning and the command protocol;
- thousands of chain swaps while an audio thread runs;
- editors: their frames, mouse input and closing, and lpi.h's GUI threading
  rule;
- the latency and parameter-change extensions, and polling for plugins
  without the latter.

## How it fits together

| File | Role |
| --- | --- |
| `src/LpiPlugin.h` | Loads an LPI binary (`lpi_get_factory`, ABI major check) and wraps an instance as an insert |
| `src/JucePluginInsert.h` | Wraps a JUCE-hosted VST3/AU instance as an insert |
| `src/InsertChain.h` | The chain the audio thread runs. Changes are published as immutable snapshots with one atomic pointer swap; old snapshots are freed once the audio thread has moved on, so the audio thread never locks |
| `src/HapAudioEngine.h` | Renders haps into per-track buffers; haps reach the audio thread through a lock-free FIFO |
| `src/Mixer.h` | Device callback: each track through its inserts, summed, then the master inserts |
| `src/PluginHost.h` | Scanning, the persisted plugin list, and the JSON commands |
| `src/TrackStreams.h` | The stream server's protocol: one plugin per browser track device, audio processed in place on the connection's thread |
| `src/editor/EditorStream.h` | Streams an editor's frames to the browser (render, deflate, send; backpressure from the browser's acks) |
| `src/editor/LpiEditor.h` | An LPI plugin's off-screen editor as a stream source; runs every GUI call on the message thread |
| `third_party/lpi` | Vendored `lpi.h` (see its README) |

Commands (types in `packages/shared/index.d.ts`): `GET_AUDIO_CORE_STATE`,
`SCAN_PLUGINS`, `LOAD_PLUGIN` (with a `bus`: `"master"` or a track 0-15),
`REMOVE_PLUGIN`, `MOVE_PLUGIN`, `SET_PLUGIN_BYPASS`, `SET_PLUGIN_PARAMETER`,
`SET_VST_PARAMETER` (by plugin name on `trackIndex`), `OPEN_EDITOR` and
`CLOSE_EDITOR`.
Each command except the parameter and editor ones gets an `AUDIO_CORE_STATE`
reply (or `AUDIO_CORE_ERROR`). The frontend's **VST Folders Scan** tab drives
them.

## Plugin editors

Plugins hosted in GhostDAW show their own editor in the browser (#44 B6).
Only LPI plugins with the `lpi.gui.offscreen.v1` extension have one so far;
VST3/AU editors need a native window.

1. **Open.**
   - `OPEN_EDITOR { slotId }` opens one on an Audio Core insert. A track
     stream takes `OPEN_EDITOR` without a slot id.
   - GhostDAW renders the editor off-screen and replies
     `EDITOR_OPENED { editorId, port, width, height }`.
   - The **open editor** button on an insert (Audio Core panel) or a native
     device card sends it.
2. **Stream.** The browser connects to `ws://localhost:8085` and sends
   `START { editorId }`.
   - Frames come back as deflated RGBA at 20 fps, plus one right after each
     input. Frame format and backpressure: `src/editor/EditorStream.h`.
   - Mouse input goes the other way.
   - The browser shows it in a floating window (`PluginEditorWindow`).
3. **Parameter changes.** Changes made in the editor are announced as
   `PLUGIN_PARAMETER_CHANGED { ..., source: 'editor' }`.
   - GhostDAW collects them after every mouse event and every frame. A
     plugin with `lpi.params.changes.v1` reports them itself, marking each
     drag's start and release (`gestureBegin`, `gestureEnd`). Without it,
     GhostDAW compares the values the plugin reports.
   - On a browser track, the device keeps the new value, so it is saved
     with the project and can be undone. A drag the plugin reports as a
     gesture is one undo step, however long it takes.
4. **Close.**
   - One editor is open at a time (an LPI v1 rule): opening another closes
     the first.
   - Removing its plugin, re-preparing it for a new sample rate, or
     `CLOSE_EDITOR` also closes it.
   - The stream then gets `CLOSED`, and the window goes away.

A plugin with `lpi.latency.v1` reports its latency, which shows as the
insert's `latencySamples`. The browser delays its other tracks to match a
track device's plugin.

lpi.h requires every GUI call, and every parameter write, on one thread.
GhostDAW uses the message thread, which already runs every other plugin call
except `process()`. The stream's render thread hands each frame and each
mouse event over to it and waits for the pixels.

The B6a latency spike (`tools/EditorStreamSpike.cpp`, built with
`-DGHOSTDAW_BUILD_TOOLS=ON`) measured this design. Its results and
recommendations are in
[docs/editor-streaming-latency.md](docs/editor-streaming-latency.md).

Not yet: VST3/AU editors, and delay compensation inside the Audio Core's own
buses (the browser compensates its tracks).
