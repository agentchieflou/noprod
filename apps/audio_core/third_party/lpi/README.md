# LPI (Loudio Plugin Interface) ABI header

`include/lpi/lpi.h` is a verbatim copy of `PluginABI/include/lpi/lpi.h` from
the sibling repo [agentchieflou/v-loudio-t](https://github.com/agentchieflou/v-loudio-t),
taken at commit `89296fb7d179e6f1dc215c70d3209c2817a3599a` (ABI version 1.0): the
head of v-loudio-t PR #111, which adds the `lpi.gui.offscreen.v1` editor
extension the Audio Core streams to the browser. Re-copy once #111 merges.

It is vendored rather than referenced by relative path so `audio_core` builds
from a plain checkout of this repo. The header is dependency-free C, so there
is nothing else to copy. To build against a live v-loudio-t checkout instead,
configure with `-DLPI_INCLUDE_DIR=/path/to/v-loudio-t/PluginABI/include`.

When v-loudio-t bumps `LPI_ABI_VERSION_MAJOR`, re-copy the header and update
the commit above; the host refuses plugins whose major version differs from
the one it was built with.
