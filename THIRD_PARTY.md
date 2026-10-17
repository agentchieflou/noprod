# Vendored code

Native code copied into this repo. `scripts/check-licenses.mjs` fails if a
directory under `apps/audio_core/third_party`, or a git submodule, is missing
from this list. Permissive submodules go here too; restricted ones are
temporary exceptions in the script.

| Directory | What | License | Source |
|---|---|---|---|
| `apps/audio_core/third_party/lpi` | The LPI plugin ABI header (`lpi.h`), copied verbatim | MIT | `PluginABI/include/lpi/lpi.h` in agentchieflou/v-loudio-t, commit `0907dc4` |
| `apps/audio_core/third_party/miniaudio` | Audio device I/O (`miniaudio.h`, copied verbatim; `miniaudio.c` builds only its device parts) | Unlicense OR MIT-0 | [mackron/miniaudio](https://github.com/mackron/miniaudio) version 0.11.25, sha256 in its README |
| `apps/audio_core/third_party/vst3` | The VST 3 plug-in interfaces (`pluginterfaces/`: `base`, `vst`, `gui`, copied verbatim with `LICENSE.txt`) | MIT | [steinbergmedia/vst3_pluginterfaces](https://github.com/steinbergmedia/vst3_pluginterfaces) commit `4f547e8` (VST3 SDK 3.8.1) |
