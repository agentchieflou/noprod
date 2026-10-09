#pragma once

#include <JuceHeader.h>
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

// One LPI plugin instance as an insert.
//
// LPI fixes sample rate and block size at create(), so prepare() destroys
// and recreates the instance when they change, carrying its state across
// through get_state/set_state and re-applying the parameter values this host
// set.
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
            for (auto& p : getParameters())
                values.push_back (api.get_parameter_value (instance, static_cast<uint32_t> (p.index)));
        else
            for (size_t i = 0; i < values.size(); ++i)
                api.set_parameter_value (instance, static_cast<uint32_t> (i), values[i]);

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
    // directly would lag until the next audio block.
    float getParameterValue (int index) override
    {
        if (index >= 0 && static_cast<size_t> (index) < values.size())
            return values[static_cast<size_t> (index)];
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

private:
    void destroyInstance()
    {
        if (instance == nullptr)
            return;

        auto& api = library->getApi();
        api.deactivate (instance);
        api.destroy (instance);
        instance = nullptr;
    }

    std::shared_ptr<LpiLibrary> library;
    lpi_plugin* instance = nullptr;
    double preparedRate = 0.0;
    int preparedBlockSize = 0;
    std::vector<float> values;
};
