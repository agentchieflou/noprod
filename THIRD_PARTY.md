# Vendored code

Native code copied into this repo. `scripts/check-licenses.mjs` fails if a
directory under `apps/audio_core/third_party`, or a git submodule, is missing
from this list. Permissive submodules go here too; restricted ones are
temporary exceptions in the script.

| Directory | What | License | Source |
|---|---|---|---|
| `apps/audio_core/third_party/lpi` | The LPI plugin ABI header (`lpi.h`), copied verbatim | MIT | `PluginABI/include/lpi/lpi.h` in agentchieflou/v-loudio-t, commit `0907dc4` |
