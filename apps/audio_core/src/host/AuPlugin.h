#pragma once

#include "../platform/Json.h"
#include "../platform/Platform.h"
#include "InsertProcessor.h"

#include <memory>
#include <string>
#include <vector>

#if GHOSTDAW_MAC

namespace ghostdaw
{

// Audio Unit hosting through AudioToolbox's component API (macOS only):
// the system's component registry lists the units, an instance is
// configured through its properties, pulls its input from a render
// callback and renders into our buffers. A unit's pluginId is
// "au:<type>:<subtype>:<manufacturer>", the three four-character codes
// of its component description.

// What the registry says about one unit
struct AuComponentInfo
{
    std::string pluginId, name, vendor;
};

// The effect units (aufx, aumf) the system knows, in-process. The scan
// worker (ghostdaw --scan-au) calls this and prints the result, so a
// registry that misbehaves can't take GhostDAW down.
std::vector<AuComponentInfo> listAudioUnits();

// The worker's answer: { "plugins": [ { pluginId, name, vendor, format } ] }
Json describeAudioUnits();

// An Audio Unit effect as an insert. Parameters are exposed normalized
// (0..1 over the unit's range), with the unit's own text where it gives
// one; a change reaches the unit at once. The chain's transport reaches
// the unit through the host callbacks.
class AuInsert : public InsertProcessor
{
public:
    // Fails (nullptr, `error`) when no such unit exists or it can't be
    // created and configured for stereo float processing
    static std::unique_ptr<AuInsert> create (const std::string& pluginId, std::string& error);
    ~AuInsert() override;

    std::string getName() const override;
    std::string getFormat() const override { return "AU"; }
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

    // The unit's state (kAudioUnitProperty_ClassInfo as a binary property
    // list), for tests and saving
    bool getState (std::vector<uint8_t>& out);
    bool setState (const std::vector<uint8_t>& data);

    struct Impl;

private:
    AuInsert() = default;
    std::unique_ptr<Impl> instance;
};

} // namespace ghostdaw

#endif
