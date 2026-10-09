#pragma once

#include <JuceHeader.h>
#include <atomic>
#include <functional>

#include "InsertChain.h"

// The device callback: renders the source (the Hap engine) and runs the
// master insert chain over its output. Also keeps a post-insert peak level
// the control thread can read for metering.
class MasterBus : public juce::AudioIODeviceCallback
{
public:
    MasterBus (juce::AudioIODeviceCallback& sourceToRender, InsertChain& masterInserts)
        : source (sourceToRender), chain (masterInserts)
    {
    }

    // Called on the device's thread when it (re)starts, with its sample rate
    // and block size. GhostDAW uses it to re-prepare the inserts.
    std::function<void (double sampleRate, int blockSize)> onDeviceStarted;

    // Peak level since the last call (resets it).
    float takePeak() { return peak.exchange (0.0f); }

    void audioDeviceAboutToStart (juce::AudioIODevice* device) override
    {
        source.audioDeviceAboutToStart (device);
        auto rate = device->getCurrentSampleRate() > 0 ? device->getCurrentSampleRate() : 44100.0;
        chain.audioStarted (rate);
        if (onDeviceStarted)
            onDeviceStarted (rate, device->getCurrentBufferSizeSamples());
    }

    void audioDeviceStopped() override
    {
        chain.audioStopped();
        source.audioDeviceStopped();
    }

    void audioDeviceError (const juce::String& message) override
    {
        source.audioDeviceError (message);
    }

    void audioDeviceIOCallbackWithContext (const float* const* inputChannelData, int numInputChannels,
                                           float* const* outputChannelData, int numOutputChannels,
                                           int numSamples, const juce::AudioIODeviceCallbackContext& context) override
    {
        source.audioDeviceIOCallbackWithContext (inputChannelData, numInputChannels,
                                                 outputChannelData, numOutputChannels, numSamples, context);

        float* channels[InsertChain::maxChannels];
        int count = 0;
        for (int ch = 0; ch < numOutputChannels && count < InsertChain::maxChannels; ++ch)
            if (outputChannelData[ch] != nullptr)
                channels[count++] = outputChannelData[ch];

        chain.process (channels, count, numSamples);

        float blockPeak = 0.0f;
        for (int ch = 0; ch < count; ++ch)
            blockPeak = juce::jmax (blockPeak, juce::FloatVectorOperations::findMaximum (channels[ch], numSamples),
                                    -juce::FloatVectorOperations::findMinimum (channels[ch], numSamples));

        auto previous = peak.load (std::memory_order_relaxed);
        while (blockPeak > previous && ! peak.compare_exchange_weak (previous, blockPeak, std::memory_order_relaxed)) {}
    }

private:
    juce::AudioIODeviceCallback& source;
    InsertChain& chain;
    std::atomic<float> peak { 0.0f };
};
