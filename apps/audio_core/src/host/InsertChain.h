#pragma once

#include "Dsp.h"
#include "InsertProcessor.h"

#include <algorithm>
#include <atomic>
#include <chrono>
#include <memory>
#include <string>
#include <thread>
#include <vector>

namespace ghostdaw
{

// An insert chain the audio thread runs without ever taking a lock.
//
// The control thread never mutates what the audio thread is reading. Every
// change builds a new immutable Snapshot and publishes it with one atomic
// pointer store (RCU style). The old snapshot is retired and freed only
// once the audio thread can no longer be using it: after one audio
// callback has completed since the swap, or straight away when no audio
// device is running. Processors are shared between snapshots through
// shared_ptr, so a plugin is destroyed (on the control thread) only when
// the last snapshot holding it is freed.
class InsertChain
{
public:
    struct Slot
    {
        std::string id;
        std::shared_ptr<InsertProcessor> processor;
        std::shared_ptr<std::atomic<bool>> bypassed = std::make_shared<std::atomic<bool>> (false);
    };

    ~InsertChain()
    {
        published.store (nullptr);
    }

    // ------------------------------------------------------------ control thread

    const std::vector<Slot>& getSlots() const { return slots; }
    double getSampleRate() const { return sampleRate; }
    int getMaxBlockSize() const { return maxBlockSize; }

    // Publishes a new list of slots. Every processor must already be
    // prepared for the chain's sample rate and block size.
    void setSlots (std::vector<Slot> newSlots)
    {
        slots = std::move (newSlots);
        publish();
    }

    // Changes the sample rate / maximum block size. The audio thread is moved
    // onto an empty chain and waited out before any processor is re-prepared,
    // since prepare() mutates the processor itself. Processors that fail to
    // re-prepare are dropped and reported through `errors`.
    void prepare (double newSampleRate, int newMaxBlockSize, std::vector<std::string>& errors)
    {
        if (newSampleRate == sampleRate && newMaxBlockSize == maxBlockSize)
            return;

        sampleRate = newSampleRate;
        maxBlockSize = newMaxBlockSize;

        if (! slots.empty())
        {
            auto live = std::move (slots);
            slots.clear();
            publish();
            waitForAudioThread();
            collectGarbage();

            for (auto& slot : live)
            {
                std::string error;
                if (slot.processor->prepare (sampleRate, maxBlockSize, error))
                    slots.push_back (std::move (slot));
                else
                    errors.push_back (error);
            }
        }

        publish();
    }

    // Frees retired snapshots the audio thread is done with. Call regularly.
    void collectGarbage()
    {
        auto completed = completedCallbacks.load();
        auto running = audioRunning.load();

        retired.erase (std::remove_if (retired.begin(), retired.end(), [&] (const Retired& r)
                       {
                           return ! running || completed > r.completedAtSwap;
                       }),
                       retired.end());
    }

    size_t getNumRetired() const { return retired.size(); }

    // -------------------------------------------------------------- audio thread

    void audioStarted (double deviceSampleRate)
    {
        deviceRate.store (deviceSampleRate);
        audioRunning.store (true);
    }

    void audioStopped()
    {
        audioRunning.store (false);
    }

    // Runs every non-bypassed insert over the channels in place. Blocks larger
    // than the prepared maximum are processed in chunks. If the device rate
    // no longer matches the rate the chain was prepared for (the device was
    // just reconfigured), audio passes through until the control thread
    // re-prepares. Returns whether the chain has inserts it ran (bypassed
    // ones count, so a bypass toggle doesn't change what the caller mixes).
    // With a transport (where the block's first frame sits), each insert is
    // told where its chunk starts.
    bool process (float* const* channels, int numChannels, int numSamples, const TransportInfo* transport = nullptr) noexcept
    {
        auto* snapshot = published.load();
        bool ran = false;

        if (snapshot != nullptr && ! snapshot->slots.empty() && numChannels > 0
            && snapshot->sampleRate == deviceRate.load())
        {
            ran = true;
            numChannels = std::min (numChannels, std::min (snapshot->dry.getNumChannels(), maxChannels));

            for (int offset = 0; offset < numSamples; offset += snapshot->maxBlockSize)
            {
                auto count = std::min (snapshot->maxBlockSize, numSamples - offset);
                float* outputs[maxChannels];
                for (int ch = 0; ch < numChannels; ++ch)
                    outputs[ch] = channels[ch] + offset;

                TransportInfo chunkTransport;
                if (transport != nullptr)
                    chunkTransport = transport->advancedBy (offset, snapshot->sampleRate);

                int index = 0;
                for (auto& slot : snapshot->slots)
                {
                    processingSlot.store (index++, std::memory_order_relaxed);
                    if (slot.bypassed->load (std::memory_order_relaxed))
                        continue;

                    for (int ch = 0; ch < numChannels; ++ch)
                        dsp::copy (snapshot->dry.getWritePointer (ch), outputs[ch], count);

                    if (transport != nullptr)
                        slot.processor->setTransport (chunkTransport);
                    slot.processor->process (snapshot->dry.getArrayOfReadPointers(), outputs, numChannels, count);
                }
                processingSlot.store (-1, std::memory_order_relaxed);
            }
        }

        completedCallbacks.fetch_add (1);
        return ran;
    }

    // Any thread: the slot index process() is inside right now, or -1
    // (the watchdog names it when a callback hangs)
    int getProcessingSlot() const { return processingSlot.load (std::memory_order_relaxed); }

    static constexpr int maxChannels = 32;

private:
    struct Snapshot
    {
        std::vector<Slot> slots;
        AudioBuffer dry; // the input copy each insert reads from
        double sampleRate = 0.0;
        int maxBlockSize = 0;
    };

    struct Retired
    {
        std::unique_ptr<Snapshot> snapshot;
        uint64_t completedAtSwap = 0;
    };

    void publish()
    {
        auto next = std::make_unique<Snapshot>();
        next->slots = slots;
        next->dry.setSize (maxChannels, std::max (1, maxBlockSize));
        next->sampleRate = sampleRate;
        next->maxBlockSize = std::max (1, maxBlockSize);

        // seq_cst on both sides: the audio thread's load of `published` and
        // this thread's load of `completedCallbacks` must not be reordered
        // around the store, or a callback still holding the old snapshot
        // could be missed.
        published.store (next.get());
        auto completedAtSwap = completedCallbacks.load();

        if (current != nullptr)
            retired.push_back ({ std::move (current), completedAtSwap });
        current = std::move (next);

        collectGarbage();
    }

    // Blocks until a callback that might hold the previous snapshot has
    // finished (or no device is running). Only used for re-preparing.
    void waitForAudioThread()
    {
        auto target = completedCallbacks.load();
        for (int waited = 0; waited < 2000 && audioRunning.load() && completedCallbacks.load() <= target; ++waited)
            std::this_thread::sleep_for (std::chrono::milliseconds (1));
    }

    std::vector<Slot> slots;
    double sampleRate = 0.0;
    int maxBlockSize = 0;

    std::unique_ptr<Snapshot> current;
    std::vector<Retired> retired;

    std::atomic<Snapshot*> published { nullptr };
    std::atomic<uint64_t> completedCallbacks { 0 };
    std::atomic<bool> audioRunning { false };
    std::atomic<double> deviceRate { 0.0 };
    std::atomic<int> processingSlot { -1 };
};

} // namespace ghostdaw
