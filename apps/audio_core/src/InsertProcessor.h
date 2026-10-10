#pragma once

#include <JuceHeader.h>
#include <cstdint>
#include <vector>

// One parameter of a hosted plugin, in the plugin's own value range.
// (VST3/AU parameters are exposed normalized, 0..1; LPI parameters use the
// min/max the plugin declares.)
struct PluginParameterInfo
{
    int index = 0;
    juce::String id;
    juce::String name;
    float minValue = 0.0f;
    float maxValue = 1.0f;
    float defaultValue = 0.0f;
    bool stepped = false;
    bool boolean = false;
    bool readOnly = false;
};

// Where the music is when a block plays, for tempo-synced plugins. The flags
// have the values of lpi.h's LPI_TRANSPORT_*.
struct TransportInfo
{
    static constexpr uint32_t playing = 1, looping = 2, tempoValid = 4, ppqValid = 8;

    double tempoBpm = 120.0;
    double ppqPosition = 0.0; // of the block's first frame, in quarter notes
    uint32_t flags = 0;

    // The same transport `frames` later (the position moves only while playing)
    TransportInfo advancedBy (int frames, double sampleRate) const noexcept
    {
        auto next = *this;
        if ((flags & playing) != 0 && (flags & tempoValid) != 0 && (flags & ppqValid) != 0 && sampleRate > 0.0)
            next.ppqPosition += frames / sampleRate * tempoBpm / 60.0;
        return next;
    }
};

// A plugin instance that can sit in an InsertChain, whatever its format.
//
// Threading contract (the same one lpi.h makes an ABI rule):
//   - prepare/release/setParameter and the destructor run on ONE control
//     thread (the JUCE message thread in GhostDAW);
//   - process runs on the real-time audio thread and must not allocate,
//     block or take a lock;
//   - getParameterValue/getParameterText may be called from the control thread.
class InsertProcessor
{
public:
    virtual ~InsertProcessor() = default;

    virtual juce::String getName() const = 0;
    virtual juce::String getFormat() const = 0; // "LPI", "VST3", "AU"
    virtual juce::String getPath() const = 0;
    virtual int getLatencySamples() const { return 0; }

    // (Re)allocates for a sample rate and maximum block size. Must be called
    // before the processor is published to the audio thread.
    virtual bool prepare (double sampleRate, int maxBlockSize, juce::String& error) = 0;

    // inputs and outputs never alias; numSamples <= the prepared maxBlockSize.
    // Output channels the plugin doesn't write must already hold the input
    // (the chain pre-fills outputs with the dry signal).
    virtual void process (const float* const* inputs, float* const* outputs, int numChannels, int numSamples) noexcept = 0;

    // Audio thread, right before process(): where the coming block sits
    // musically. Not called at all when the chain has no transport.
    virtual void setTransport (const TransportInfo&) noexcept {}

    virtual std::vector<PluginParameterInfo> getParameters() = 0;
    virtual float getParameterValue (int index) = 0;
    virtual juce::String getParameterText (int index) = 0;
    virtual bool setParameterValue (int index, float value) = 0;

    // True if the plugin has an editor GhostDAW can stream to the browser
    // (an LPI plugin with lpi.gui.offscreen.v1, see editor/LpiEditor.h)
    virtual bool hasEditor() { return false; }
};
