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
tracks, the metronome and recordings to match). Each block carries the
transport at its first frame (tempo, position in quarter notes, playing,
looping), so tempo-synced plugins follow the song: LPI plugins through
`lpi.transport.v1`, VST3s through their play head. Inserts on the Audio
Core's own buses get no transport yet; tempo-synced plugins there run free.
See `src/TrackStreams.h` and `apps/frontend/src/native/trackBridge.ts`.

**Plugin editors** are shown in the browser: an LPI plugin with the
`lpi.gui.offscreen.v1` extension renders its editor off-screen in GhostDAW,
which streams the frames from `ws://localhost:8085` and takes mouse input
back. See [Plugin editors](#plugin-editors) below.

Plugin commands load code from disk, so the WebSocket servers (GhostDAW,
Orchestrator, Sequencer) refuse browser connections from other sites: only
clients without an `Origin` header and pages served from `localhost`,
`127.0.0.1` or `[::1]` get in. Add more origins with
`NOPROD_ALLOWED_ORIGINS=https://example.com,...`.

## The rebuild without JUCE (#134)

GhostDAW is being rebuilt on its own platform layer, with no JUCE (AGPL or
paid) in what we ship: see CLAUDE.md, "Dependencies: we own what we ship".
The new host lives beside the old one until the switch:

| Path | What |
| --- | --- |
| `src/platform/` | Sockets (loopback only) and the WebSocket server, the message loop and timers, files, dynamic libraries, logging, JSON, pairing, the single-instance lock and the crash handler |
| `src/host/` | The host: `InsertChain` (RCU, as before), `Mixer`, `HapAudioEngine`, `AudioDevice`, the `Watchdog`, `LpiPlugin` (the LPI loader and insert), `Vst3Plugin` (VST 3 modules and inserts), `PluginRegistry` (the scanned list, the skipped binaries, the settings), `PluginScanner` (a child process per binary), `PluginHost` (the commands, by id), `TrackStreams`, `editor/` (off-screen editors streamed to the browser) and `Control` (pairing and the control messages) |
| `third_party/miniaudio/` | Device I/O: [miniaudio](https://github.com/mackron/miniaudio), public domain or MIT-0 (see its README there). Chosen over writing WASAPI, CoreAudio and ALSA backends ourselves: one well-tested file, no dependencies, a null backend for machines without a sound card and for CI |
| `third_party/vst3/` | The VST 3 SDK's `pluginterfaces` (MIT), the interfaces alone: what a plug-in's binary exports and the COM-style objects host and plug-in exchange. The SDK's helper classes (its hosting library, `base/`, `public.sdk/`) are not used; the host-side objects are ours, in `Vst3Plugin.cpp` |
| `src/ghostdaw_main.cpp` | The new entry point, `ghostdaw` |
| `tests/` | Its tests, `ghostdaw_tests`: the WebSocket server over real sockets (handshake, framing, masking, fragmentation, limits, the token), JSON, the loop, pairing, the chains and mixer under concurrent swaps, the device on the null backend, the watchdog, and the plugin tests ported from the JUCE host (LPI, VST 3, commands, streams, editors, keyboard, transport, latency), plus the scanner surviving a plugin that crashes or hangs. The VST 3 test plug-in (`tests/plugins/vst3_test_gain.cpp`) is written against the interfaces too, and built as a bundle in two variants: a component that is its own controller, and a separate controller class |
| `src/*.h`, `src/main.cpp` | The JUCE host, `GhostDAW`, until the switch |

```sh
cmake -S apps/audio_core -B build/audio_core -G Ninja -DCMAKE_BUILD_TYPE=Release -DGHOSTDAW_BUILD_TESTS=ON -DGHOSTDAW_JUCE_HOST=OFF
cmake --build build/audio_core
build/audio_core/tests/ghostdaw_tests
build/audio_core/ghostdaw --help
```

`ghostdaw` keeps its token, settings and log in `~/.config/NoProd/GhostDAW`
(Linux), `~/Library/Application Support/NoProd/GhostDAW` (macOS) or
`%APPDATA%\NoProd\GhostDAW` (Windows); `--data-dir` moves them. It exits 1
when a port is taken and 2 when another GhostDAW already runs with that
data folder. Crashes are written to `ghostdaw.log` there. `--null-audio`
runs without a sound card (a machine without one falls back to that by
itself).

### VST 3

A VST 3 plug-in is a bundle (`X.vst3/Contents/<arch>/X.so`, `.../MacOS/X`,
`.../x86_64-win/X.vst3`; a single `.vst3` file still loads on Windows)
exporting a module entry function and `GetPluginFactory`. `Vst3Module`
loads the binary for this platform, runs the entry function
(`ModuleEntry`, `bundleEntry` with the `CFBundle`, `InitDll`) and lists
the factory's audio effect classes. A class's `pluginId` is the 32-digit
hex of its class UID (the JUCE host used its own identifier string, so
VST 3 devices in projects saved before the switch are matched again by
name). `Vst3Insert` creates the component (and its separate controller,
when it names one, connected through `IConnectionPoint` with the
component's state copied over), takes stereo on the main buses and
activates the rest as the plug-in declares them, and processes 32-bit
float blocks with the chain's transport as its `ProcessContext`.

Parameters are the controller's, normalized 0..1 with the plug-in's own
text. A change from the browser goes to the controller at once and to the
processor with the next block, through a lock-free queue the audio thread
drains into `ProcessData.inputParameterChanges`; what the processor sends
back (`outputParameterChanges`) and what the plug-in edits itself
(`performEdit`, `restartComponent`) go the other way, to the controller
and the browser, on the control thread. The component's state
(`getState`/`setState`) is what a preset holds.

### Reliable

- **A watchdog thread** watches the audio callback and the control thread.
  A callback stuck for 2 s (a plugin hanging in `process()`) or a control
  thread silent for 5 s (a plugin hanging in a control call) is reported in
  the log and to every control client as `AUDIO_CORE_ERROR { request:
  "WATCHDOG" }`, naming the bus and insert, and again when it recovers.
  The servers keep answering meanwhile: nothing else shares those threads.
- **Audio re-routing** (the OS switching outputs) restarts the device from
  the control thread, re-preparing the mixer and inserts for the new rate.
- **Bus state** (each bus's inserts, their bypass and parameter values) is
  saved to `state.json` a second after every change and loaded again at the
  next launch, once the launch scan has listed the plugins.

### Secure by design

- **Localhost only.** Every server binds `127.0.0.1`.
- **Origin policy.** Browsers send an `Origin` with every WebSocket
  handshake; only pages from `localhost`, `127.0.0.1` or `[::1]`, the
  hosted web app (`https://agentchieflou.github.io`) and
  `NOPROD_ALLOWED_ORIGINS` get a handshake, as before. A hosted page is an
  https page opening `ws://localhost`: browsers allow that (loopback is a
  secure context), and Chrome asks the user once for Local Network Access
  before the page may reach a program on their own machine.
- **Pairing.** GhostDAW keeps a 256-bit random token in `pairing-token`
  (owner-only), created on first launch. Every connection on 8082, 8083 and
  8085 presents it as `?token=<hex>` in its URL; a wrong or missing token
  gets `403`. The web app gets the token by pairing: at each launch
  GhostDAW prints a pairing code (8 symbols, about 40 bits) to the console
  and the log; the web app's Audio Core panel asks for it, sends
  `PAIR { code }` on a tokenless control connection (the one thing such a
  connection may do), and gets `PAIRED { token }`, which it keeps in
  `localStorage`. Five wrong codes lock pairing until GhostDAW restarts.
  `ghostdaw --new-token`, or `ROTATE_PAIRING_TOKEN` from a paired client,
  rotates the token; every other browser must pair again. The Orchestrator,
  which runs as the same user, reads the token file. The token covers what
  `Origin` cannot: other local pages and non-browser clients.
- **Per-connection limits.** A connection cap per server (16 control, 64
  stream, 8 editor connections) and a shorter one on connections still in
  their handshake (8), so idle sockets can't fill the cap: each holds a
  slot for at most the 5 s handshake timeout. A message size
  limit per server (1 MiB, 4 MiB, 64 KiB), client masking enforced,
  fragmented messages reassembled, and the close codes RFC 6455 gives
  protocol errors (1002, 1007, 1009).
- **Plugins by id only.** Clients name a `pluginId` from `availablePlugins`,
  never a path (`LOAD_PLUGIN { pluginId }`, a stream's `LOAD { pluginId }`;
  a `path` is refused, or ignored beside an id). Scans cover the platform's
  VST3 folders plus the `scanFolders` in GhostDAW's own `settings.json`
  (`ghostdaw --add-scan-folder DIR` adds one), never folders a client sends
  with `SCAN_PLUGINS`.
- **Scans in a child process.** Each binary is loaded by `ghostdaw
  --scan-file FILE`, a child with a 20 s limit; one that crashes or hangs
  is written down in `plugins.json` as skipped, with the reason, listed in
  `AUDIO_CORE_STATE.skippedPlugins`, and not loaded again until its file
  changes. Before each child runs, the binary's path goes into
  `scanning.json` (the dead man's pedal): if GhostDAW itself dies
  mid-scan, the next launch skips that binary too. Binaries already known
  are not loaded again either, so a launch scan of an unchanged folder is
  instant.
- **Random editor ids** (`editor-` and 16 hex digits), so only the client
  that opened an editor can stream it, and a **protocol version**
  (`protocolVersion: 2`) in `AUDIO_CORE_STATE`.

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
     input. A frame identical to the last one sent is skipped, so an idle
     editor costs nothing. Frame format and backpressure:
     `src/editor/EditorStream.h`.
   - Mouse input goes the other way, and so do keys for plugins with
     `lpi.gui.keyboard.v1` (`keyboard` in EDITOR_OPENED). A click on the
     editor gives it keyboard focus. While it has focus, every key goes to
     the plugin, and the DAW's shortcuts and the computer MIDI keyboard
     stand down. A click elsewhere, closing the window, or the stream
     dropping takes focus away, and the plugin is always told before its
     editor closes.
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
track device's plugin. The latency is read again after every parameter
change, since a lookahead may set it. When it moves, the insert's state is
sent again and the browser re-compensates.

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
