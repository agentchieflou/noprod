# Vendored code

Native code copied into this repo. `scripts/check-licenses.mjs` fails if a
directory under `apps/audio_core/third_party` is missing from this list.

| Directory | What | License | Source |
|---|---|---|---|
| `apps/audio_core/third_party/lpi` | The LPI plugin ABI header (`lpi.h`), copied verbatim | MIT | `PluginABI/include/lpi/lpi.h` in agentchieflou/v-loudio-t, commit `0907dc4` |
