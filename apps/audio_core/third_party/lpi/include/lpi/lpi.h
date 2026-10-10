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
 * Extension: "lpi.gui.offscreen.v1"
 * ------------------------------------------------------------------------
 * Plugin renders its editor into an offscreen RGBA8 framebuffer; the host
 * pulls frames and relays synthetic mouse input. No native window is ever
 * shown. Obtained via get_extension(instance, LPI_EXT_GUI_OFFSCREEN_V1);
 * NULL if the plugin has no GUI.
 *
 * Threading: every function below must be called from ONE consistent
 * thread (the "GUI thread") -- the GL context is thread-affine. That same
 * thread must also be the one calling set_parameter_value (the plugin's
 * GUI forwards edits through the same single-producer queue). Never call
 * these from the audio thread.
 *
 * v1 scope: one open editor per process, left mouse button only, no
 * keyboard. open() returns false if an editor is already open anywhere in
 * the process.
 */
#define LPI_EXT_GUI_OFFSCREEN_V1 "lpi.gui.offscreen.v1"

typedef struct {
    uint32_t logical_width;
    uint32_t logical_height;
    uint32_t physical_width;  /* = round(logical * dpi_scale); frames are this size */
    uint32_t physical_height;
} lpi_gui_offscreen_info;

enum {
    LPI_MOUSE_MOVE = 0,
    LPI_MOUSE_DOWN = 1, /* left button */
    LPI_MOUSE_UP   = 2  /* left button */
};

typedef struct lpi_gui_offscreen_v1 {
    /* dpi_scale <= 0 is treated as 1.0. */
    bool   (*open)(lpi_plugin* instance, float dpi_scale, lpi_gui_offscreen_info* out_info);
    void   (*close)(lpi_plugin* instance);
    /* Renders the current UI state into the offscreen target. Cheap to call
     * at any rate; the host decides cadence (ambient ~15-20fps plus after input). */
    bool   (*render)(lpi_plugin* instance);
    /* Tightly packed RGBA8, top-left origin; buffer_size >= physical_w * physical_h * 4. */
    bool   (*read_pixels)(lpi_plugin* instance, uint8_t* out_rgba, size_t buffer_size);
    /* Coordinates are LOGICAL pixels. */
    void   (*mouse_event)(lpi_plugin* instance, int event_type, float logical_x, float logical_y);
} lpi_gui_offscreen_v1;

/* ------------------------------------------------------------------------
 * Extension: "lpi.gui.keyboard.v1"
 * ------------------------------------------------------------------------
 * Keyboard input for an lpi.gui.offscreen.v1 editor (text entry in numeric
 * readouts, #131). Obtained via get_extension(instance,
 * LPI_EXT_GUI_KEYBOARD_V1); NULL if the editor takes no keyboard input.
 * Same thread as the other GUI calls. Both functions return void: routing
 * is purely by focus, the plugin never "consumes" a key for the host.
 *
 * Focus: the host decides when its editor surface has keyboard focus
 * (e.g. a click on the editor canvas; a click elsewhere or closing the
 * editor ends it) and calls focus(true/false) at the transitions, always
 * focus(false) before close. While focused, every key goes to the plugin
 * with none reserved by the host, so Escape, arrows and Space reach a text
 * field. On focus(false) the plugin ends any text entry and forgets held
 * keys: UPs for keys held across a blur never arrive.
 *
 * Events, delivered in the order they happened:
 *   - LPI_KEY_DOWN / LPI_KEY_UP: key is an LPI_VK_* code. Letters map from
 *     the typed letter when it is ASCII A-Z (so Ctrl+A is Ctrl+A on any
 *     layout), the physical key otherwise.
 *   - LPI_KEY_CHAR: key is a UTF-32 code point. Sent right after DOWN only
 *     when the key produces a single printable character and none of
 *     Ctrl/Alt/Meta is held.
 *   - Auto-repeat is DOWN (then CHAR) again with no UP in between.
 *   - IME composition is out of scope for v1.
 */
#define LPI_EXT_GUI_KEYBOARD_V1 "lpi.gui.keyboard.v1"

enum {
    LPI_KEY_DOWN = 0,
    LPI_KEY_UP   = 1,
    LPI_KEY_CHAR = 2
};

enum {
    LPI_MOD_SHIFT = 1u << 0,
    LPI_MOD_CTRL  = 1u << 1,
    LPI_MOD_ALT   = 1u << 2,
    LPI_MOD_META  = 1u << 3  /* Cmd on macOS, Win key elsewhere */
};

/* Digits and letters are their ASCII code; everything else is >= 0x100. */
enum {
    LPI_VK_NONE      = 0,
    LPI_VK_SPACE     = 0x20,
    LPI_VK_0 = '0', LPI_VK_9 = '9',
    LPI_VK_A = 'A', LPI_VK_Z = 'Z',
    LPI_VK_ENTER     = 0x101,
    LPI_VK_ESCAPE    = 0x102,
    LPI_VK_BACKSPACE = 0x103,
    LPI_VK_TAB       = 0x104,
    LPI_VK_DELETE    = 0x105,
    LPI_VK_HOME      = 0x106,
    LPI_VK_END       = 0x107,
    LPI_VK_LEFT      = 0x108,
    LPI_VK_RIGHT     = 0x109,
    LPI_VK_UP        = 0x10A,
    LPI_VK_DOWN      = 0x10B,
    LPI_VK_MINUS     = 0x10C,
    LPI_VK_PERIOD    = 0x10D,
    LPI_VK_COMMA     = 0x10E
};

typedef struct lpi_gui_keyboard_v1 {
    void (*key_event)(lpi_plugin* instance, int event_type, uint32_t key, uint32_t modifiers);
    void (*focus)(lpi_plugin* instance, bool focused);
} lpi_gui_keyboard_v1;

/* ------------------------------------------------------------------------
 * Extension: "lpi.latency.v1"
 * ------------------------------------------------------------------------
 * Processing latency in samples, for host delay compensation. Call from the
 * control thread after activate(). The value is fixed for the life of an
 * activation: a plugin whose latency would change must have the host
 * re-create (or deactivate/activate) the instance, the same as a
 * sample-rate change. A plugin without this extension has 0 latency.
 */
#define LPI_EXT_LATENCY_V1 "lpi.latency.v1"

typedef struct lpi_latency_v1 {
    uint32_t (*get_latency)(lpi_plugin* instance);
} lpi_latency_v1;

/* ------------------------------------------------------------------------
 * Extension: "lpi.params.changes.v1"
 * ------------------------------------------------------------------------
 * Parameter changes the PLUGIN made itself -- in practice, edits in its own
 * editor -- so the host can mirror them (parameter views, automation
 * lanes). Pull-based: the host drains the queue; there is no callback, no
 * host context pointer and no re-entrancy.
 *
 * Threading: GUI thread only (the same thread the lpi.gui.offscreen.v1
 * calls and set_parameter_value run on).
 *
 * Semantics:
 *   - Only plugin-originated changes are reported. Anything the host
 *     caused is never echoed back: values set via set_parameter_value, and
 *     values loaded by set_state (presets).
 *   - Read-only parameters (LPI_PARAM_READONLY: meters and other outputs)
 *     are never queued. A host that wants them reads them with
 *     get_parameter_value.
 *   - lpi_param_change.value is in the parameter's own min_value..max_value
 *     range -- the same units get_parameter_value returns.
 *   - Coalesced per parameter since the last call: one entry per changed
 *     parameter, carrying its latest value and the OR of its flags.
 *   - GESTURE_BEGIN marks the first change of a user gesture (e.g. a knob
 *     drag from mouse-down); GESTURE_END marks the gesture's release. A
 *     gesture both started and ended since the last call reports both
 *     bits. An END entry's value is the final settled value.
 *   - Returns the number of entries written to out (<= max). Entries that
 *     didn't fit stay queued for the next call. Entries are in ascending
 *     parameter index order.
 *   - Lifetime: the queue is dropped on deactivate() and destroy(). Closing
 *     the editor (lpi.gui.offscreen.v1 close) mid-gesture queues the
 *     gesture's END; it stays queued until the host drains it, so a host
 *     that drains before close() and one that drains after both see it.
 */
#define LPI_EXT_PARAM_CHANGES_V1 "lpi.params.changes.v1"

enum {
    LPI_PARAM_CHANGE_GESTURE_BEGIN = 1u << 0,
    LPI_PARAM_CHANGE_GESTURE_END   = 1u << 1
};

typedef struct {
    uint32_t index;
    float    value;
    uint32_t flags; /* bitwise OR of LPI_PARAM_CHANGE_* */
} lpi_param_change;

typedef struct lpi_param_changes_v1 {
    uint32_t (*get_parameter_changes)(lpi_plugin* instance, lpi_param_change* out, uint32_t max);
} lpi_param_changes_v1;

/* ------------------------------------------------------------------------
 * Extension: "lpi.transport.v1"
 * ------------------------------------------------------------------------
 * Host transport (tempo, musical position, play state) for tempo-synced
 * delays and LFOs. Push-based, one plain copy: the host fills an
 * lpi_transport_info and calls set_transport() on the AUDIO THREAD once
 * per block, before process(). The plugin copies the struct and must not
 * block, allocate or call back. A plugin that doesn't need transport
 * doesn't implement the extension; a host that has none never calls it,
 * and the plugin keeps its free-running rates.
 *
 * Fields:
 *   - tempo_bpm:    valid when TEMPO_VALID is set.
 *   - ppq_position: musical position of the FIRST frame of the coming
 *                   process() call, in quarter notes, valid when PPQ_VALID
 *                   is set. A host whose position is only approximate
 *                   (a pattern sequencer) may set TEMPO_VALID without
 *                   PPQ_VALID, or set PPQ_VALID and accept best-effort sync.
 *   - sample_rate:  the rate the host is running at (informational; it
 *                   never differs from create()'s within an instance).
 *   - flags:        PLAYING while the transport runs; LOOPING when the
 *                   position will jump back at a loop end (a plugin may
 *                   resync at the jump).
 *
 * Contract for plugins: a host MAY call set_transport with PLAYING clear
 * and a stale ppq_position (while stopped, or with no exact position),
 * and may stop calling it entirely. A tempo-synced plugin therefore keeps
 * a free-running fallback (its own phase accumulator) and resyncs to
 * ppq_position only when PLAYING and PPQ_VALID are both set; tempo alone
 * (TEMPO_VALID) may be used whenever it is set.
 */
#define LPI_EXT_TRANSPORT_V1 "lpi.transport.v1"

enum {
    LPI_TRANSPORT_PLAYING     = 1u << 0,
    LPI_TRANSPORT_LOOPING     = 1u << 1,
    LPI_TRANSPORT_TEMPO_VALID = 1u << 2,
    LPI_TRANSPORT_PPQ_VALID   = 1u << 3
};

typedef struct {
    double   tempo_bpm;
    double   ppq_position;
    double   sample_rate;
    uint32_t flags; /* bitwise OR of LPI_TRANSPORT_* */
} lpi_transport_info;

typedef struct lpi_transport_v1 {
    /* Audio thread, once per block before process(). info is never NULL. */
    void (*set_transport)(lpi_plugin* instance, const lpi_transport_info* info);
} lpi_transport_v1;

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
