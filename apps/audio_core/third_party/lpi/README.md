# LPI (Loudio Plugin Interface) ABI header

`include/lpi/lpi.h` is a verbatim copy of `PluginABI/include/lpi/lpi.h` from
the sibling repo [agentchieflou/v-loudio-t](https://github.com/agentchieflou/v-loudio-t),
taken from its main branch at commit `58d082f7c11b3f19addda4a0179b8f799ac95788`
(ABI version 1.0). It has the extensions the Audio Core uses:
- `lpi.gui.offscreen.v1`, the editor streamed to the browser (v-loudio-t #111);
- `lpi.latency.v1` and `lpi.params.changes.v1` (v-loudio-t #120).

It is vendored rather than referenced by relative path so `audio_core` builds
from a plain checkout of this repo. The header is dependency-free C, so there
is nothing else to copy. To build against a live v-loudio-t checkout instead,
configure with `-DLPI_INCLUDE_DIR=/path/to/v-loudio-t/PluginABI/include`.

When v-loudio-t bumps `LPI_ABI_VERSION_MAJOR`, re-copy the header and update
the commit above; the host refuses plugins whose major version differs from
the one it was built with.
