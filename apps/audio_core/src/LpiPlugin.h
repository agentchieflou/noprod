#pragma once

#include <JuceHeader.h>
#include <functional>
#include <memory>
#include <vector>

#include "InsertProcessor.h"
#include <lpi/lpi.h>

// B5a: dynamic loading of LPI (Loudio Plugin Interface) plugins.
//
// An LpiLibrary is one loaded plugin binary (.dll / .so / .dylib): the
// library handle plus the factory, info and vtable it exports. Instances
// share the library through a shared_ptr, so the binary stays loaded until
// the last instance created from it is destroyed.
class LpiLibrary
{
public:
    // Loads the binary, resolves lpi_get_factory and checks the ABI version.
    // Returns nullptr (and fills `error`) if any step fails.
    static std::shared_ptr<LpiLibrary> open (const juce::File& file, juce::String& error)
    {
        auto library = std::shared_ptr<LpiLibrary> (new LpiLibrary (file));

        if (! file.existsAsFile())
        {
            error = "No such file: " + file.getFullPathName();
            return nullptr;
        }

        if (! library->dynamicLibrary.open (file.getFullPathName()))
        {
            error = "Could not load " + file.getFileName() + " as a shared library";
            return nullptr;
        }

        auto getFactory = reinterpret_cast<lpi_get_factory_fn> (library->dynamicLibrary.getFunction (LPI_GET_FACTORY_SYMBOL_NAME));
        if (getFactory == nullptr)
        {
            error = file.getFileName() + " is not an LPI plugin (no " LPI_GET_FACTORY_SYMBOL_NAME " export)";
            return nullptr;
        }

        library->factory = getFactory();
        if (library->factory == nullptr)
        {
            error = file.getFileName() + ": lpi_get_factory returned null";
            return nullptr;
        }

        // Major versions must match exactly. Minor versions are additive, so a
        // plugin built against a newer minor still works with this host (it
        // only ever uses the 1.0 surface).
        auto version = library->factory->abi_version;
        if (version.major != LPI_ABI_VERSION_MAJOR)
        {
            error = file.getFileName() + " uses LPI ABI " + juce::String (version.major) + "." + juce::String (version.minor)
                  + ", but this host supports " + juce::String (LPI_ABI_VERSION_MAJOR) + ".x";
            return nullptr;
        }

        library->info = library->factory->get_info != nullptr ? library->factory->get_info() : nullptr;
        library->api = library->factory->get_api != nullptr ? library->factory->get_api() : nullptr;

        if (library->info == nullptr || library->api == nullptr || ! hasRequiredEntryPoints (*library->api))
        {
            error = file.getFileName() + ": incomplete LPI factory (missing info or required api functions)";
            return nullptr;
        }

        return library;
    }

    // True if the file is a shared library exporting lpi_get_factory. Used by
    // plugin scanning; loads and unloads the library.
    static bool isLpiPlugin (const juce::File& file)
    {
        juce::String ignored;
        return open (file, ignored) != nullptr;
    }

    const juce::File& getFile() const { return file; }
    const lpi_plugin_info& getInfo() const { return *info; }
    const lpi_plugin_api& getApi() const { return *api; }

private:
    explicit LpiLibrary (const juce::File& f) : file (f) {}

    static bool hasRequiredEntryPoints (const lpi_plugin_api& a)
    {
        return a.create != nullptr && a.destroy != nullptr && a.activate != nullptr && a.deactivate != nullptr
            && a.process != nullptr && a.get_parameter_count != nullptr && a.get_parameter_info != nullptr
            && a.get_parameter_value != nullptr && a.set_parameter_value != nullptr;
    }

    juce::File file;
    juce::DynamicLibrary dynamicLibrary;
    const lpi_plugin_factory* factory = nullptr;
    const lpi_plugin_info* info = nullptr;
    const lpi_plugin_api* api = nullptr;
};

// A parameter the plugin changed by itself (in its editor), with the
// gesture marks of lpi.params.changes.v1 when the plugin reports them
struct PluginParameterChange
{
    int index = 0;
    bool gestureBegin = false, gestureEnd = false;
};

// One LPI plugin instance as an insert.
//
// LPI fixes sample rate and block size at create(), so prepare() destroys
// and recreates the instance when they change, carrying its state across
// through get_state/set_state and re-applying the parameter values this host
// set.
//
// Plugins with the lpi.gui.offscreen.v1 extension also have an editor, which
// is rendered off-screen and streamed to the browser (editor/LpiEditor.h).
// lpi.h requires every GUI call on the thread that sets parameters: the
// control thread here, like everything else but process(). More extensions
// are used when present: lpi.latency.v1 (the latency the browser compensates
// for), lpi.params.changes.v1 (what the editor changed) and lpi.transport.v1
// (tempo and position, on the audio thread before each process()), and
// lpi.gui.keyboard.v1 (keys for the editor while it has focus).
class LpiInsert : public InsertProcessor
{
public:
    explicit LpiInsert (std::shared_ptr<LpiLibrary> lib) : library (std::move (lib)) {}

    ~LpiInsert() override { destroyInstance(); }

    juce::String getName() const override { return juce::String::fromUTF8 (library->getInfo().name); }
    juce::String getFormat() const override { return "LPI"; }
    juce::String getPath() const override { return library->getFile().getFullPathName(); }
    juce::String getPluginId() const { return juce::String::fromUTF8 (library->getInfo().id); }

    bool prepare (double sampleRate, int maxBlockSize, juce::String& error) override
    {
        if (instance != nullptr && sampleRate == preparedRate && maxBlockSize == preparedBlockSize)
            return true;

        auto& api = library->getApi();

        // Keep what the plugin's own editor changed since this host last looked
        takeParameterChanges();

        juce::MemoryBlock savedState;
        if (instance != nullptr && api.get_state != nullptr)
        {
            auto size = api.get_state (instance, nullptr, 0);
            if (size > 0)
            {
                savedState.setSize (size);
                if (api.get_state (instance, savedState.getData(), size) != size)
                    savedState.reset();
            }
        }

        destroyInstance();

        instance = api.create (sampleRate, static_cast<uint32_t> (maxBlockSize));
        if (instance == nullptr)
        {
            error = getName() + ": create() failed";
            return false;
        }

        if (savedState.getSize() > 0 && api.set_state != nullptr)
            api.set_state (instance, savedState.getData(), savedState.getSize());

        if (! api.activate (instance))
        {
            error = getName() + ": activate() failed";
            destroyInstance();
            return false;
        }

        preparedRate = sampleRate;
        preparedBlockSize = maxBlockSize;

        if (values.empty())
        {
            for (auto& p : getParameters())
            {
                values.push_back (api.get_parameter_value (instance, static_cast<uint32_t> (p.index)));
                readOnly.push_back (p.readOnly);
            }
        }
        else
        {
            for (size_t i = 0; i < values.size(); ++i)
                if (! readOnly[i])
                    api.set_parameter_value (instance, static_cast<uint32_t> (i), values[i]);
        }

        reported.clear();
        for (size_t i = 0; i < values.size(); ++i)
            reported.push_back (api.get_parameter_value (instance, static_cast<uint32_t> (i)));

        latency = 0;
        refreshLatency();

        // Looked up here, on the control thread: process() runs on the audio thread
        transport = getExtension<lpi_transport_v1> (LPI_EXT_TRANSPORT_V1);
        if (transport != nullptr && transport->set_transport == nullptr)
            transport = nullptr;

        return true;
    }

    // lpi.latency.v1: read at activation, and again after parameter changes
    // (a lookahead parameter may change it)
    int getLatencySamples() const override { return latency; }

    bool refreshLatency() override
    {
        auto* extension = getExtension<lpi_latency_v1> (LPI_EXT_LATENCY_V1);
        auto now = extension != nullptr && extension->get_latency != nullptr ? static_cast<int> (extension->get_latency (instance)) : 0;
        if (now == latency)
            return false;
        latency = now;
        return true;
    }

    void process (const float* const* inputs, float* const* outputs, int numChannels, int numSamples) noexcept override
    {
        if (instance == nullptr)
            return; // outputs already hold the dry signal

        auto& info = library->getInfo();

        lpi_process_data data;
        data.inputs = info.num_audio_inputs > 0 ? inputs : nullptr;
        data.outputs = outputs;
        data.num_input_channels = juce::jmin (info.num_audio_inputs, static_cast<uint32_t> (numChannels));
        data.num_output_channels = juce::jmin (info.num_audio_outputs, static_cast<uint32_t> (numChannels));
        data.num_frames = static_cast<uint32_t> (numSamples);

        library->getApi().process (instance, &data);
    }

    // lpi.transport.v1
    void setTransport (const TransportInfo& t) noexcept override
    {
        if (instance == nullptr || transport == nullptr)
            return;
        lpi_transport_info info { t.tempoBpm, t.ppqPosition, preparedRate, t.flags };
        transport->set_transport (instance, &info);
    }

    std::vector<PluginParameterInfo> getParameters() override
    {
        std::vector<PluginParameterInfo> result;
        if (instance == nullptr)
            return result;

        auto& api = library->getApi();
        auto count = api.get_parameter_count (instance);

        for (uint32_t i = 0; i < count; ++i)
        {
            lpi_parameter_info raw {};
            if (! api.get_parameter_info (instance, i, &raw))
                continue;

            PluginParameterInfo p;
            p.index = static_cast<int> (i);
            p.id = juce::String::fromUTF8 (raw.id != nullptr ? raw.id : "");
            p.name = juce::String::fromUTF8 (raw.name != nullptr ? raw.name : "");
            p.minValue = raw.min_value;
            p.maxValue = raw.max_value;
            p.defaultValue = raw.default_value;
            p.stepped = (raw.flags & LPI_PARAM_STEPPED) != 0;
            p.boolean = (raw.flags & LPI_PARAM_BOOLEAN) != 0;
            p.readOnly = (raw.flags & LPI_PARAM_READONLY) != 0;
            result.push_back (p);
        }

        return result;
    }

    // The value this host last set (or the plugin's initial value). An LPI
    // plugin applies queued changes inside process(), so asking the plugin
    // directly would lag until the next audio block. Read-only parameters
    // are the plugin's outputs (meters and the like): those are read live.
    float getParameterValue (int index) override
    {
        auto i = static_cast<size_t> (index);
        if (index >= 0 && i < values.size() && ! readOnly[i])
            return values[i];
        return instance != nullptr ? library->getApi().get_parameter_value (instance, static_cast<uint32_t> (index)) : 0.0f;
    }

    juce::String getParameterText (int index) override
    {
        return juce::String (getParameterValue (index), 3);
    }

    bool setParameterValue (int index, float value) override
    {
        if (instance == nullptr || index < 0 || static_cast<size_t> (index) >= values.size())
            return false;

        if (! library->getApi().set_parameter_value (instance, static_cast<uint32_t> (index), value))
            return false;

        values[static_cast<size_t> (index)] = value;
        return true;
    }

    // Parameters the plugin changed by itself (its editor) since the last
    // call, with getParameterValue updated to match. Control thread (which
    // is also the plugin's GUI thread).
    //
    // A plugin with lpi.params.changes.v1 says what changed, with gesture
    // marks. For any other plugin, a change shows as the plugin reporting a
    // value it didn't report last time. A value this host set doesn't count:
    // the plugin may report it only once process() has applied it, and by
    // then this host already holds it.
    std::vector<PluginParameterChange> takeParameterChanges()
    {
        std::vector<PluginParameterChange> changed;
        if (instance == nullptr)
            return changed;

        if (auto* extension = getExtension<lpi_param_changes_v1> (LPI_EXT_PARAM_CHANGES_V1);
            extension != nullptr && extension->get_parameter_changes != nullptr)
        {
            // At most one entry per parameter is queued, so a plugin that
            // keeps returning full batches is cut off after that many
            lpi_param_change batch[32];
            for (size_t taken = 0; taken <= values.size(); taken += 32)
            {
                auto count = juce::jmin (extension->get_parameter_changes (instance, batch, 32), 32u);
                for (uint32_t n = 0; n < count; ++n)
                {
                    auto i = static_cast<size_t> (batch[n].index);
                    if (i >= values.size() || readOnly[i])
                        continue;
                    values[i] = batch[n].value;
                    changed.push_back ({ static_cast<int> (i), (batch[n].flags & LPI_PARAM_CHANGE_GESTURE_BEGIN) != 0,
                                         (batch[n].flags & LPI_PARAM_CHANGE_GESTURE_END) != 0 });
                }
                if (count < 32)
                    break;
            }
            return changed;
        }

        auto& api = library->getApi();
        for (size_t i = 0; i < reported.size() && i < values.size(); ++i)
        {
            if (readOnly[i])
                continue;
            auto now = api.get_parameter_value (instance, static_cast<uint32_t> (i));
            if (now == reported[i])
                continue;
            reported[i] = now;
            if (now != values[i])
            {
                values[i] = now;
                changed.push_back ({ static_cast<int> (i) });
            }
        }
        return changed;
    }

    // ------------------------------------------- editor (lpi.gui.offscreen.v1)

    bool hasEditor() override { return getGui() != nullptr; }

    // Opens the editor at a DPI scale; fills `info` with its size. Fails if
    // the plugin has no GUI or another editor is open in this process.
    bool openEditor (float dpiScale, lpi_gui_offscreen_info& info, juce::String& error)
    {
        auto* gui = getGui();
        if (gui == nullptr)
        {
            error = getName() + " has no editor";
            return false;
        }
        if (editorOpen)
        {
            error = getName() + ": its editor is already open";
            return false;
        }

        info = {};
        if (! gui->open (instance, dpiScale, &info) || info.physical_width == 0 || info.physical_height == 0
            || info.logical_width == 0 || info.logical_height == 0)
        {
            error = getName() + ": could not open its editor";
            return false;
        }

        editorOpen = true;
        return true;
    }

    bool isEditorOpen() const { return editorOpen; }

    void closeEditor()
    {
        if (! editorOpen)
            return;
        editorFocus (false); // lpi.gui.keyboard.v1: always before close
        editorOpen = false;
        getGui()->close (instance);
    }

    // Renders the editor and reads its pixels (tightly packed RGBA, top-left)
    bool renderEditor (uint8_t* rgba, size_t size)
    {
        auto* gui = editorOpen ? getGui() : nullptr;
        return gui != nullptr && gui->render (instance) && gui->read_pixels (instance, rgba, size);
    }

    // type is LPI_MOUSE_*; coordinates in logical pixels
    void editorMouse (int type, float x, float y)
    {
        if (auto* gui = editorOpen ? getGui() : nullptr)
            gui->mouse_event (instance, type, x, y);
    }

    // lpi.gui.keyboard.v1: the editor takes keys while it has keyboard focus
    bool hasKeyboard() const { return getKeyboard() != nullptr; }

    // type is LPI_KEY_*, key an LPI_VK_* code (or a code point for CHAR),
    // modifiers LPI_MOD_*
    void editorKey (int type, uint32_t key, uint32_t modifiers)
    {
        if (auto* keyboard = editorOpen && keyboardFocused ? getKeyboard() : nullptr)
            keyboard->key_event (instance, type, key, modifiers);
    }

    void editorFocus (bool focused)
    {
        auto* keyboard = editorOpen ? getKeyboard() : nullptr;
        if (keyboard == nullptr || focused == keyboardFocused)
            return;
        keyboardFocused = focused;
        keyboard->focus (instance, focused);
    }

    // Called (on the control thread) when the instance goes away while its
    // editor is open: re-prepared for a new sample rate, or destroyed
    std::function<void()> onEditorClosed;

private:
    template <typename Extension>
    const Extension* getExtension (const char* id) const
    {
        auto& api = library->getApi();
        if (instance == nullptr || api.get_extension == nullptr)
            return nullptr;
        return static_cast<const Extension*> (api.get_extension (instance, id));
    }

    const lpi_gui_keyboard_v1* getKeyboard() const
    {
        auto* keyboard = getExtension<lpi_gui_keyboard_v1> (LPI_EXT_GUI_KEYBOARD_V1);
        return keyboard != nullptr && keyboard->key_event != nullptr && keyboard->focus != nullptr ? keyboard : nullptr;
    }

    const lpi_gui_offscreen_v1* getGui() const
    {
        auto* gui = getExtension<lpi_gui_offscreen_v1> (LPI_EXT_GUI_OFFSCREEN_V1);
        if (gui == nullptr || gui->open == nullptr || gui->close == nullptr || gui->render == nullptr
            || gui->read_pixels == nullptr || gui->mouse_event == nullptr)
            return nullptr;
        return gui;
    }

    void destroyInstance()
    {
        if (instance == nullptr)
            return;

        if (editorOpen)
        {
            closeEditor();
            auto closed = std::move (onEditorClosed);
            onEditorClosed = nullptr;
            if (closed)
                closed();
        }

        transport = nullptr;
        auto& api = library->getApi();
        api.deactivate (instance);
        api.destroy (instance);
        instance = nullptr;
    }

    std::shared_ptr<LpiLibrary> library;
    lpi_plugin* instance = nullptr;
    double preparedRate = 0.0;
    int preparedBlockSize = 0;
    std::vector<float> values;   // what this host set, or the plugin's own changes it has seen
    std::vector<float> reported; // what the plugin last reported (see takeParameterChanges)
    std::vector<bool> readOnly;  // the plugin's outputs, never set
    int latency = 0;
    const lpi_transport_v1* transport = nullptr;
    bool editorOpen = false;
    bool keyboardFocused = false;
};
