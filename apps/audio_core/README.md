# Audio Core (GhostDAW)

Headless JUCE app that renders the Sequencer's haps through a **master insert
chain of hosted plugins**: VST3 (all platforms), AudioUnit (macOS) and LPI, the
Loudio Plugin Interface from [v-loudio-t](https://github.com/agentchieflou/v-loudio-t).
It listens on `ws://localhost:8082` for the Orchestrator, which relays the
frontend's plugin commands and sends the replies back.

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
| `src/MasterBus.h` | Device callback: Hap engine output, then the inserts |
| `src/PluginHost.h` | Scanning, the persisted plugin list, and the JSON commands |
| `third_party/lpi` | Vendored `lpi.h` (see its README) |

Commands (types in `packages/shared/index.d.ts`): `GET_AUDIO_CORE_STATE`,
`SCAN_PLUGINS`, `LOAD_PLUGIN`, `REMOVE_PLUGIN`, `MOVE_PLUGIN`,
`SET_PLUGIN_BYPASS`, `SET_PLUGIN_PARAMETER` and the older `SET_VST_PARAMETER`.
Each command except the parameter ones gets an `AUDIO_CORE_STATE` reply (or
`AUDIO_CORE_ERROR`). The frontend's **VST Folders Scan** tab drives them.

Not yet: per-track inserts (the chain is the master bus only), plugin editors
(LPI's off-screen GUI extension and the frame streaming in #44 B6), and plugin
delay compensation.
