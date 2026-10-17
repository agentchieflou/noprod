# miniaudio

`miniaudio.h` is a verbatim copy of
[mackron/miniaudio](https://github.com/mackron/miniaudio) version 0.11.25
(the `0.11.25` tag, sha256
`ac7af4de748b7e26b777f37e01cee313a308a7296a3eb080e2906b320cc55c89`), with
its `LICENSE`: the author's choice of public domain (Unlicense) or MIT-0,
both of which CLAUDE.md's "Dependencies: we own what we ship" allows.

GhostDAW uses it for audio device I/O only (`src/host/AudioDevice.cpp`):
WASAPI on Windows, CoreAudio on macOS, ALSA/PulseAudio on Linux, plus its
null backend when no device can be opened (and in CI). The decoding,
encoding, generation, resource-manager, node-graph and engine parts are
compiled out (`miniaudio.c`).

To update: copy the new `miniaudio.h` and `LICENSE`, and change the version
and hash above.
