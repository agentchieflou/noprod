#ifndef LPI_H
#define LPI_H

/*
 * LPI -- Loudio Plugin Interface.
 *
 * A minimal, versioned, C-linkage plugin ABI for in-process dynamic loading
 * (LoadLibrary + GetProcAddress on Windows), intended as the primary plugin
 * format for noprod. VST3 remains the compatibility bridge for Ableton/
 * third-party DAWs -- see Plugins/Reverb/ARCHITECTURE_DECISIONS.md.
 *
 * This header is intentionally dependency-free (plain C, <stdint.h>/
 * <stddef.h>/<stdbool.h> only) and physically separate from cuif: a plugin
 * implementing this ABI is not required to use cuif at all. C linkage
 * throughout (not C++) for binary compatibility across compilers/versions --
 * a plugin DLL and its host are never guaranteed to be built with the same
 * compiler/runtime.
 *
 * RT-SAFETY IS AN ABI CONTRACT, NOT A HOST RESPONSIBILITY:
 * lpi_plugin_api::process() runs on the host's real-time audio thread and
 * must never allocate, block, or take a lock. lpi_plugin_api::
 * set_parameter_value() may be called from one single non-realtime thread
 * (a UI or network thread -- but always the SAME thread for a given
 * instance, e.g. never two different threads racing each other) and must
 * ALSO never block -- the plugin is responsible for internally enqueuing
 * the change (e.g. via a lock-free SPSC ring buffer, the same pattern
 * already used for audio<->UI communication in
 * Framework/include/cuif/ring_buffer.h and VSTs/Reverb/src/PluginProcessor)
 * and applying it from within process(). Hosts calling set_parameter_value
 * never need their own locking around it. A plugin wanting to accept
 * parameter changes from genuinely multiple concurrent non-audio threads
 * (rather than funneling them through one, e.g. a single UI/control
 * thread, which is what every host in this codebase does today) would need
 * its own additional synchronization -- that is explicitly out of scope
 * for what this ABI guarantees.
 *
 * VERSIONING / GROWTH:
 * The core lpi_plugin_api below is meant to stay small and stable. New
 * capabilities (a GUI, MIDI, sidechain input, ...) are added as separate
 * extensions, requested by a stable string id via get_extension() -- a
 * proven shape borrowed from other minimal plugin ABIs, not any specific
 * SDK adopted wholesale. A host that doesn't know about an extension id
 * just gets NULL back; a plugin that doesn't implement one returns NULL
 * too. This is how the ABI grows without ever breaking an old plugin
 * against a new host, or a new plugin against an old host.
 *
 * Native-window (VST3-style HWND embedding) GUIs are deliberately NOT part
 * of LPI v1 -- the VST3/JUCE wrapper already covers that case for Ableton
 * and other third-party hosts. LPI's own GUI story (an "lpi.gui.offscreen.v1"
 * extension, added in a later issue) only needs to serve noprod's chosen
 * frame-streaming model.
 */

#include <stddef.h>
#include <stdint.h>
#include <stdbool.h>

#ifdef __cplusplus
extern "C" {
#endif

#if defined(_WIN32)
#define LPI_EXPORT __declspec(dllexport)
#else
#define LPI_EXPORT
#endif

/* ------------------------------------------------------------------------
 * Versioning
 * ------------------------------------------------------------------------
 * Major version bumps on any breaking change to lpi_plugin_api's layout or
 * semantics. Minor version bumps on purely additive changes (new extension
 * ids don't require a minor bump either -- extensions are already
 * independently versioned by their own id string, e.g. "lpi.gui.offscreen.v1"
 * vs a hypothetical future "lpi.gui.offscreen.v2").
 */
#define LPI_ABI_VERSION_MAJOR 1
#define LPI_ABI_VERSION_MINOR 0

typedef struct {
    uint32_t major;
    uint32_t minor;
} lpi_version;

/* Opaque per-instance handle. A plugin's internal struct definition is
 * never visible to the host -- only ever touched through the vtable below. */
typedef struct lpi_plugin lpi_plugin;

/* ------------------------------------------------------------------------
 * Static, type-level plugin info (one per plugin type, not per instance)
 * ------------------------------------------------------------------------ */
typedef struct {
    const char* id;    /* stable, e.g. "com.loudio.reverb" -- used for
                         * state/preset compatibility checks, never shown to
                         * the user and never changes across versions of the
                         * same plugin. */
    const char* name;  /* display name, e.g. "Loudio Reverb" */
    const char* vendor;
    uint32_t    num_audio_inputs;
    uint32_t    num_audio_outputs;
} lpi_plugin_info;

/* ------------------------------------------------------------------------
 * Parameters
 * ------------------------------------------------------------------------ */
enum {
    LPI_PARAM_BOOLEAN  = 1u << 0, /* value is conceptually 0.0/1.0 */
    LPI_PARAM_STEPPED  = 1u << 1, /* value should snap to integer steps between min/max */
    LPI_PARAM_READONLY = 1u << 2  /* host-visible meter/output, not user-settable (set_parameter_value on it is a no-op) */
};

typedef struct {
    uint32_t    index;
    const char* id;    /* stable string id, e.g. "decayTime" -- NOT the
                         * numeric index, which is only positionally stable
                         * within one build. Presets/state must key on this
                         * id, not on index, so a future parameter-table
                         * reordering can't silently corrupt saved state. */
    const char* name;  /* display name */
    float       min_value;
    float       max_value;
    float       default_value;
    uint32_t    flags; /* bitwise OR of LPI_PARAM_* above */
} lpi_parameter_info;

/* ------------------------------------------------------------------------
 * Audio processing
 * ------------------------------------------------------------------------ */
typedef struct {
    const float* const* inputs;         /* inputs[channel][frame], NULL if num_input_channels == 0 */
    float* const*       outputs;        /* outputs[channel][frame] */
    uint32_t             num_input_channels;
    uint32_t             num_output_channels;
    uint32_t             num_frames;
} lpi_process_data;

/* ------------------------------------------------------------------------
 * Per-instance API. One static vtable instance is shared by every instance
 * of a given plugin type (returned once by lpi_plugin_factory::get_api) --
 * it is not itself per-instance state.
 * ------------------------------------------------------------------------ */
typedef struct lpi_plugin_api {
    /* Allocates a new instance. sample_rate/max_block_size are fixed for
     * the instance's lifetime -- matches every DSP object in this codebase
     * already following a one-time prepare(sampleRate, blockSize) contract
     * rather than taking a rate per process() call, which would be pure
     * overhead with no plugin here ever needing a mid-stream rate change. */
    lpi_plugin* (*create)(double sample_rate, uint32_t max_block_size);
    void        (*destroy)(lpi_plugin* instance);

    /* activate/deactivate mirror JUCE's prepareToPlay/releaseResources:
     * allocate/release any DSP resources sized off sample_rate/max_block_size.
     * Must be called (activate) before the first process() call. */
    bool        (*activate)(lpi_plugin* instance);
    void        (*deactivate)(lpi_plugin* instance);

    /* Real-time audio thread only. Must not allocate, block, or take a lock. */
    void        (*process)(lpi_plugin* instance, const lpi_process_data* data);

    uint32_t    (*get_parameter_count)(lpi_plugin* instance);
    bool        (*get_parameter_info)(lpi_plugin* instance, uint32_t index, lpi_parameter_info* out_info);

    /* get_parameter_value: any thread, a plain read of a single float (no
     * torn-read hazard on x86/x64). set_parameter_value: one single
     * non-realtime thread only, must never block -- see the RT-safety
     * contract at the top of this file. */
    float       (*get_parameter_value)(lpi_plugin* instance, uint32_t index);
    bool        (*set_parameter_value)(lpi_plugin* instance, uint32_t index, float value);

    /* State save/load for presets. get_state(instance, NULL, 0) returns the
     * required buffer size without writing anything -- the standard
     * two-call sizing idiom (query size, allocate, call again to fill). */
    size_t      (*get_state)(lpi_plugin* instance, void* buffer, size_t buffer_size);
    bool        (*set_state)(lpi_plugin* instance, const void* data, size_t size);

    /* Capability negotiation. Returns NULL if this plugin doesn't implement
     * the requested extension. See the header comment above for the
     * growth-without-breaking-changes rationale. */
    void*       (*get_extension)(lpi_plugin* instance, const char* extension_id);
} lpi_plugin_api;

/* ------------------------------------------------------------------------
 * Factory -- the one thing a host looks up by name in the plugin DLL.
 * ------------------------------------------------------------------------ */
typedef struct {
    lpi_version                   abi_version;
    const lpi_plugin_info*      (*get_info)(void);
    const lpi_plugin_api*       (*get_api)(void);
} lpi_plugin_factory;

/* The one required exported symbol every LPI plugin DLL provides. A host
 * resolves this via GetProcAddress after LoadLibrary -- no import library,
 * no compile-time link dependency on the plugin at all. */
typedef const lpi_plugin_factory* (*lpi_get_factory_fn)(void);
#define LPI_GET_FACTORY_SYMBOL_NAME "lpi_get_factory"

#ifdef __cplusplus
}
#endif

#endif /* LPI_H */
