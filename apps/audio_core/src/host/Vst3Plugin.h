#pragma once

#include "../platform/Files.h"
#include "InsertProcessor.h"

#include <array>
#include <atomic>
#include <memory>
#include <string>
#include <vector>

namespace ghostdaw
{

// VST 3 hosting through the SDK's interfaces alone (third_party/vst3,
// MIT): the module's factory, its component and controller, parameters
// and processing. No SDK helper classes; the host-side objects a plug-in
// talks to (the host application, the component handler, parameter
// changes, streams, messages) are in Vst3Plugin.cpp.

// What the module says about one audio effect class
struct Vst3ClassInfo
{
    std::string classId; // the 32-digit hex of its class UID: what pluginId names
    std::string name, vendor, version, subCategories;
};

// One loaded .vst3 bundle (or legacy single-file module on Windows).
// Instances share the module through a shared_ptr, so the binary stays
// loaded until the last one is destroyed.
class Vst3Module
{
public:
    // Opens the bundle at `path` (a .vst3 folder, or a .vst3 file on
    // Windows): loads the binary for this platform, runs its entry
    // function and gets the factory. Returns nullptr (and fills `error`)
    // if any step fails.
    static std::shared_ptr<Vst3Module> open (const fs::path& path, std::string& error);
    ~Vst3Module();

    const fs::path& getPath() const { return path; }
    const std::vector<Vst3ClassInfo>& getAudioEffects() const { return effects; }

    // The binary a bundle holds for this platform and architecture
    static fs::path binaryPathFor (const fs::path& bundle);

    struct Impl;
    Impl& getImpl() { return *impl; }

private:
    Vst3Module() = default;
    fs::path path;
    std::vector<Vst3ClassInfo> effects;
    std::unique_ptr<Impl> impl;
};

// One VST 3 effect instance as an insert. Parameters are exposed
// normalized (0..1), with the plug-in's own text for display; changes go
// to the controller at once and to the processor with the next block,
// through a lock-free queue. The chain's transport reaches the plug-in
// as its ProcessContext.
class Vst3Insert : public InsertProcessor
{
public:
    // Fails (nullptr, `error`) when the class can't be created and set up
    static std::unique_ptr<Vst3Insert> create (std::shared_ptr<Vst3Module> module, const std::string& classId, std::string& error);
    ~Vst3Insert() override;

    std::string getName() const override;
    std::string getFormat() const override { return "VST3"; }
    std::string getPath() const override;
    std::string getPluginId() const override;
    int getLatencySamples() const override;

    bool prepare (double sampleRate, int maxBlockSize, std::string& error) override;
    void process (const float* const* inputs, float* const* outputs, int numChannels, int numSamples) noexcept override;
    void setTransport (const TransportInfo& transport) noexcept override;

    std::vector<PluginParameterInfo> getParameters() override;
    float getParameterValue (int index) override;
    std::string getParameterText (int index) override;
    bool setParameterValue (int index, float value) override;
    bool refreshLatency() override;

    // The component's state (what a preset holds), for tests and saving
    bool getState (std::vector<uint8_t>& out);
    bool setState (const std::vector<uint8_t>& data);

    struct Impl;

private:
    Vst3Insert() = default;
    std::unique_ptr<Impl> instance;
};

std::string utf16ToUtf8 (const char16_t* text, size_t maxLength = 128);

} // namespace ghostdaw
