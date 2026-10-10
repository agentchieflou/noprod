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

The tests build their own plugins (an LPI gain in good, wrong-ABI and
no-export variants, and a JUCE VST3 gain) and cover loading, processing,
parameter changes, scanning, the command protocol, and thousands of chain
swaps while an audio thread runs.

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
| `third_party/lpi` | Vendored `lpi.h` (see its README) |

Commands (types in `packages/shared/index.d.ts`): `GET_AUDIO_CORE_STATE`,
`SCAN_PLUGINS`, `LOAD_PLUGIN` (with a `bus`: `"master"` or a track 0-15),
`REMOVE_PLUGIN`, `MOVE_PLUGIN`, `SET_PLUGIN_BYPASS`, `SET_PLUGIN_PARAMETER` and
`SET_VST_PARAMETER` (by plugin name on `trackIndex`).
Each command except the parameter ones gets an `AUDIO_CORE_STATE` reply (or
`AUDIO_CORE_ERROR`). The frontend's **VST Folders Scan** tab drives them.

Plugin editors will be streamed to the browser as frames (#44 B6).
`src/editor/EditorStream.h` and `tools/EditorStreamSpike.cpp`
(`-DGHOSTDAW_BUILD_TOOLS=ON`) are the B6a latency spike; results and
recommendations are in [docs/editor-streaming-latency.md](docs/editor-streaming-latency.md).

Not yet: real plugin editors (they need LPI's off-screen GUI extension), and
delay compensation inside the Audio Core's own buses (the browser compensates
its tracks).
