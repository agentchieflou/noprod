#pragma once

#include <JuceHeader.h>
#include <array>
#include <atomic>
#include <functional>

#include "HapAudioEngine.h"
#include "InsertChain.h"

// The device callback. Renders the Hap engine's tracks, runs each track's
// insert chain (B5d), sums the tracks, then runs the master insert chain.
// Also keeps a post-master peak level the control thread can read.
class Mixer : public juce::AudioIODeviceCallback
{
public:
    static constexpr int numTracks = HapAudioEngine::maxTracks;

    explicit Mixer (HapAudioEngine& engineToRender) : engine (engineToRender) {}

    InsertChain& getMasterChain() { return master; }
    InsertChain& getTrackChain (int track) { return tracks[static_cast<size_t> (track)]; }

    // Called on the device's thread when it (re)starts, with its sample rate
    // and block size. GhostDAW uses it to re-prepare the inserts.
    std::function<void (double sampleRate, int blockSize)> onDeviceStarted;

    // Peak level since the last call (resets it).
    float takePeak() { return peak.exchange (0.0f); }

    // Prepares the engine and tells every chain the rate audio now runs at.
    // Called by audioDeviceAboutToStart (and directly by tests).
    void start (double sampleRate, int blockSize)
    {
        engine.prepare (sampleRate, juce::jmax (blockSize, 512));
        master.audioStarted (sampleRate);
        for (auto& chain : tracks)
            chain.audioStarted (sampleRate);
    }

    void stop()
    {
        master.audioStopped();
        for (auto& chain : tracks)
            chain.audioStopped();
    }

    // Renders numSamples into the output channels (overwriting them).
    void renderBlock (float* const* outputs, int numChannels, int numSamples) noexcept
    {
        for (int ch = 0; ch < numChannels; ++ch)
            juce::FloatVectorOperations::clear (outputs[ch], numSamples);

        for (int offset = 0; offset < numSamples; offset += engine.getMaxBlockSize())
        {
            auto count = juce::jmin (engine.getMaxBlockSize(), numSamples - offset);
            float* chunk[InsertChain::maxChannels];
            for (int ch = 0; ch < numChannels; ++ch)
                chunk[ch] = outputs[ch] + offset;

            engine.render (count);

            for (int t = 0; t < numTracks; ++t)
            {
                auto* const* trackChannels = engine.getTrackChannels (t);

                // Always run the chain (cheap when empty) so its retired
                // snapshots can be freed; mix the track if it made sound or
                // has inserts (which may ring on after the notes stop).
                bool processed = tracks[static_cast<size_t> (t)].process (trackChannels, 2, count);
                if (! processed && ! engine.isTrackActive (t))
                    continue;

                for (int ch = 0; ch < numChannels; ++ch)
                    juce::FloatVectorOperations::add (chunk[ch], trackChannels[juce::jmin (ch, 1)], count);
            }

            master.process (chunk, numChannels, count);
        }

        float blockPeak = 0.0f;
        for (int ch = 0; ch < numChannels; ++ch)
        {
            juce::FloatVectorOperations::clip (outputs[ch], outputs[ch], -1.0f, 1.0f, numSamples);
            auto range = juce::FloatVectorOperations::findMinAndMax (outputs[ch], numSamples);
            blockPeak = juce::jmax (blockPeak, range.getEnd(), -range.getStart());
        }

        auto previous = peak.load (std::memory_order_relaxed);
        while (blockPeak > previous && ! peak.compare_exchange_weak (previous, blockPeak, std::memory_order_relaxed)) {}
    }

    void audioDeviceAboutToStart (juce::AudioIODevice* device) override
    {
        auto rate = device->getCurrentSampleRate() > 0 ? device->getCurrentSampleRate() : 44100.0;
        auto blockSize = device->getCurrentBufferSizeSamples();
        start (rate, blockSize);
        if (onDeviceStarted)
            onDeviceStarted (rate, blockSize);
    }

    void audioDeviceStopped() override
    {
        stop();
    }

    void audioDeviceIOCallbackWithContext (const float* const*, int,
                                           float* const* outputChannelData, int numOutputChannels,
                                           int numSamples, const juce::AudioIODeviceCallbackContext&) override
    {
        float* channels[InsertChain::maxChannels];
        int count = 0;
        for (int ch = 0; ch < numOutputChannels; ++ch)
        {
            if (outputChannelData[ch] == nullptr)
                continue;
            if (count < InsertChain::maxChannels)
                channels[count++] = outputChannelData[ch];
            else
                juce::FloatVectorOperations::clear (outputChannelData[ch], numSamples);
        }

        renderBlock (channels, count, numSamples);
    }

private:
    HapAudioEngine& engine;
    InsertChain master;
    std::array<InsertChain, numTracks> tracks;
    std::atomic<float> peak { 0.0f };
};
