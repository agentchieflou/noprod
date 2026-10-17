#pragma once

#include "Dsp.h"
#include "HapAudioEngine.h"
#include "InsertChain.h"

#include <array>
#include <atomic>
#include <functional>

namespace ghostdaw
{

// The device callback's work. Renders the Hap engine's tracks, runs each
// track's insert chain, sums the tracks, then runs the master insert
// chain. Also keeps a post-master peak level the control thread can read,
// and which bus the callback is inside (for the watchdog).
class Mixer
{
public:
    static constexpr int numTracks = HapAudioEngine::maxTracks;
    static constexpr int masterBus = -1, noBus = -2;

    explicit Mixer (HapAudioEngine& engineToRender) : engine (engineToRender) {}

    InsertChain& getMasterChain() { return master; }
    InsertChain& getTrackChain (int track) { return tracks[static_cast<size_t> (track)]; }

    // Peak level since the last call (resets it).
    float takePeak() { return peak.exchange (0.0f); }

    // Prepares the engine and tells every chain the rate audio now runs at.
    // Called by the device when it (re)starts (and directly by tests).
    void start (double sampleRate, int blockSize)
    {
        engine.prepare (sampleRate, std::max (blockSize, 512));
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
            dsp::clear (outputs[ch], numSamples);

        for (int offset = 0; offset < numSamples; offset += engine.getMaxBlockSize())
        {
            auto count = std::min (engine.getMaxBlockSize(), numSamples - offset);
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
                processingBus.store (t, std::memory_order_relaxed);
                bool processed = tracks[static_cast<size_t> (t)].process (trackChannels, 2, count);
                if (! processed && ! engine.isTrackActive (t))
                    continue;

                for (int ch = 0; ch < numChannels; ++ch)
                    dsp::add (chunk[ch], trackChannels[std::min (ch, 1)], count);
            }

            processingBus.store (masterBus, std::memory_order_relaxed);
            master.process (chunk, numChannels, count);
            processingBus.store (noBus, std::memory_order_relaxed);
        }

        float blockPeak = 0.0f;
        for (int ch = 0; ch < numChannels; ++ch)
        {
            dsp::clip (outputs[ch], -1.0f, 1.0f, numSamples);
            blockPeak = std::max (blockPeak, dsp::peak (outputs[ch], numSamples));
        }

        auto previous = peak.load (std::memory_order_relaxed);
        while (blockPeak > previous && ! peak.compare_exchange_weak (previous, blockPeak, std::memory_order_relaxed)) {}
    }

    // The device callback: interleaved output, as miniaudio hands it over.
    // De-interleaves into scratch buffers sized at prepare time; a bigger
    // callback than that is rendered in pieces.
    void renderInterleaved (float* interleaved, int numChannels, int numFrames) noexcept
    {
        auto channels = std::min (numChannels, scratch.getNumChannels());
        if (channels <= 0 || scratch.getNumSamples() == 0)
        {
            dsp::clear (interleaved, numChannels * numFrames);
            return;
        }

        for (int offset = 0; offset < numFrames; offset += scratch.getNumSamples())
        {
            auto count = std::min (scratch.getNumSamples(), numFrames - offset);
            auto* block = interleaved + static_cast<size_t> (offset) * static_cast<size_t> (numChannels);
            renderBlock (scratch.getArrayOfWritePointers(), channels, count);
            for (int i = 0; i < count; ++i)
                for (int ch = 0; ch < numChannels; ++ch)
                    block[i * numChannels + ch] = ch < channels ? scratch.getSample (ch, i) : 0.0f;
        }
    }

    // Control thread, before the device runs: the scratch space the
    // interleaved callback needs
    void prepareScratch (int numChannels, int maxFrames)
    {
        scratch.setSize (std::min (numChannels, InsertChain::maxChannels), std::max (1, maxFrames));
    }

    // Any thread: the bus renderBlock() is inside right now (a track
    // number, masterBus, or noBus)
    int getProcessingBus() const { return processingBus.load (std::memory_order_relaxed); }

private:
    HapAudioEngine& engine;
    InsertChain master;
    std::array<InsertChain, numTracks> tracks;
    std::atomic<float> peak { 0.0f };
    std::atomic<int> processingBus { noBus };
    AudioBuffer scratch;
};

} // namespace ghostdaw
