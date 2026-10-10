# LPI (Loudio Plugin Interface) ABI header

`include/lpi/lpi.h` is a verbatim copy of `PluginABI/include/lpi/lpi.h` from
the sibling repo [agentchieflou/v-loudio-t](https://github.com/agentchieflou/v-loudio-t),
taken from its main branch at commit `8ded1e38b7ea2b4418a40fca0a96c50c11e63810`
(ABI version 1.0). It includes the `lpi.gui.offscreen.v1` editor extension
the Audio Core streams to the browser (v-loudio-t #111).

It is vendored rather than referenced by relative path so `audio_core` builds
from a plain checkout of this repo. The header is dependency-free C, so there
is nothing else to copy. To build against a live v-loudio-t checkout instead,
configure with `-DLPI_INCLUDE_DIR=/path/to/v-loudio-t/PluginABI/include`.

When v-loudio-t bumps `LPI_ABI_VERSION_MAJOR`, re-copy the header and update
the commit above; the host refuses plugins whose major version differs from
the one it was built with.
