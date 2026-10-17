# VST 3 plug-in interfaces

`pluginterfaces/` is a verbatim copy of the `base`, `vst` and `gui` folders
of [steinbergmedia/vst3_pluginterfaces](https://github.com/steinbergmedia/vst3_pluginterfaces)
at commit `4f547e8` (VST3 SDK 3.8.1, 2026-08-11), with its `LICENSE.txt`:
the MIT License, which CLAUDE.md's "Dependencies: we own what we ship"
allows. (The `test` folder, which is not needed to host plug-ins, is left
out.)

These headers are the VST 3 ABI: the COM-style interfaces a plug-in's
factory, component, processor and controller implement, and the ones a
host implements for them (`IHostApplication`, `IComponentHandler`,
`IParameterChanges`, `IBStream`, `IMessage`). GhostDAW hosts VST3 plug-ins
through them directly (`src/host/Vst3Plugin.cpp`), with none of the SDK's
`public.sdk` helper classes; `src/host/Vst3Iids.cpp` defines the interface
ids (`INIT_CLASS_IID`), which the headers only declare.

To update: copy the three folders and `LICENSE.txt` again and change the
commit above.
