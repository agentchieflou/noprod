// Tests for the host (#134, step 2): the insert chain and its lock-free
// publishing, the hap engine, the mixer's track and master buses, the
// audio device on miniaudio's null backend, and the watchdog. Ported from
// the JUCE host's tests; the plugin loaders' tests follow with the loaders.

#include "Check.h"
#include "host/AudioDevice.h"
#include "host/Dsp.h"
#include "host/HapAudioEngine.h"
#include "host/InsertChain.h"
#include "host/Mixer.h"
#include "host/Watchdog.h"
#include "platform/Json.h"
#include "platform/Platform.h"

#include <atomic>
#include <cmath>
#include <iostream>
#include <mutex>
#include <thread>
#include <vector>

using namespace ghostdaw;

namespace
{

constexpr double rate = 48000.0;

// A stereo test signal: different sines per channel so a channel swap shows.
AudioBuffer makeSignal (int numSamples)
{
    AudioBuffer buffer (2, numSamples);
    for (int i = 0; i < numSamples; ++i)
    {
        buffer.setSample (0, i, 0.5f * std::sin (0.05f * static_cast<float> (i)));
        buffer.setSample (1, i, 0.3f * std::sin (0.11f * static_cast<float> (i)));
    }
    return buffer;
}

// Largest |actual - scale * expected| over all samples.
float errorAgainst (const AudioBuffer& actual, const AudioBuffer& expected, float scale)
{
    float worst = 0.0f;
    for (int ch = 0; ch < actual.getNumChannels(); ++ch)
        for (int i = 0; i < actual.getNumSamples(); ++i)
            worst = std::max (worst, std::abs (actual.getSample (ch, i) - scale * expected.getSample (ch, i)));
    return worst;
}

AudioBuffer copyOf (const AudioBuffer& source)
{
    AudioBuffer copy (source.getNumChannels(), source.getNumSamples());
    for (int ch = 0; ch < source.getNumChannels(); ++ch)
        dsp::copy (copy.getWritePointer (ch), source.getReadPointer (ch), source.getNumSamples());
    return copy;
}

AudioBuffer runChain (InsertChain& chain, const AudioBuffer& input)
{
    auto output = copyOf (input);
    chain.process (output.getArrayOfWritePointers(), 2, output.getNumSamples());
    return output;
}

// A gain insert that stands in for a plugin: its "gain" is applied from
// the next block on, the way an LPI plugin queues parameter changes
struct TestGainInsert : public InsertProcessor
{
    std::atomic<float> gain { 1.0f };
    std::atomic<bool> mute { false };
    double preparedRate = 0.0;
    int preparedBlock = 0;

    std::string getName() const override { return "Test Gain"; }
    std::string getFormat() const override { return "TEST"; }
    std::string getPath() const override { return "/test/gain"; }
    std::string getPluginId() const override { return "test.gain"; }
    bool prepare (double sampleRate, int maxBlockSize, std::string&) override
    {
        preparedRate = sampleRate;
        preparedBlock = maxBlockSize;
        return true;
    }
    void process (const float* const* inputs, float* const* outputs, int numChannels, int numSamples) noexcept override
    {
        auto g = mute.load() ? 0.0f : gain.load();
        for (int ch = 0; ch < numChannels; ++ch)
            for (int i = 0; i < numSamples; ++i)
                outputs[ch][i] = inputs[ch][i] * g;
    }
    std::vector<PluginParameterInfo> getParameters() override
    {
        PluginParameterInfo g;
        g.index = 0; g.id = "gain"; g.name = "Gain"; g.minValue = 0.0f; g.maxValue = 2.0f; g.defaultValue = 1.0f;
        PluginParameterInfo m;
        m.index = 1; m.id = "mute"; m.name = "Mute"; m.boolean = m.stepped = true;
        return { g, m };
    }
    float getParameterValue (int index) override { return index == 0 ? gain.load() : index == 1 ? (mute.load() ? 1.0f : 0.0f) : 0.0f; }
    std::string getParameterText (int index) override { return std::to_string (getParameterValue (index)); }
    bool setParameterValue (int index, float value) override
    {
        if (index == 0) gain.store (value);
        else if (index == 1) mute.store (value >= 0.5f);
        else return false;
        return true;
    }
};

// A processor that detects being used after it was destroyed.
struct CanaryInsert : public InsertProcessor
{
    static inline std::atomic<int> live { 0 };
    static inline std::atomic<bool> usedAfterFree { false };
    std::atomic<uint32_t> magic { alive };
    static constexpr uint32_t alive = 0xC0FFEE, dead = 0xDEAD;

    CanaryInsert() { ++live; }
    ~CanaryInsert() override { magic = dead; --live; }

    std::string getName() const override { return "Canary"; }
    std::string getFormat() const override { return "TEST"; }
    std::string getPath() const override { return {}; }
    std::string getPluginId() const override { return "test.canary"; }
    bool prepare (double, int, std::string&) override { return true; }
    void process (const float* const*, float* const* outputs, int, int numSamples) noexcept override
    {
        if (magic.load() != alive)
            usedAfterFree = true;
        outputs[0][numSamples - 1] += 0.0f;
    }
    std::vector<PluginParameterInfo> getParameters() override { return {}; }
    float getParameterValue (int) override { return 0.0f; }
    std::string getParameterText (int) override { return {}; }
    bool setParameterValue (int, float) override { return false; }
};

// An insert that blocks inside process() for as long as it is told to
struct StuckInsert : public TestGainInsert
{
    std::atomic<bool> stuck { false };
    std::string getName() const override { return "Stuck"; }
    void process (const float* const* inputs, float* const* outputs, int numChannels, int numSamples) noexcept override
    {
        while (stuck.load())
            sleepMs (10);
        TestGainInsert::process (inputs, outputs, numChannels, numSamples);
    }
};

Json haps (std::initializer_list<std::pair<const char*, int>> notes, double durationCycles = 0.01)
{
    auto list = Json::array();
    for (auto& [note, track] : notes)
        list.push (Json::object ({ { "time", 0.0 }, { "duration", durationCycles }, { "note", note }, { "trackIndex", track } }));
    return list;
}

void testChain()
{
    section ("Insert chain: series processing, bypass, chunking, rate mismatch");
    InsertChain chain;
    std::vector<std::string> errors;
    chain.prepare (rate, 256, errors);

    auto a = std::make_shared<TestGainInsert>();
    auto b = std::make_shared<TestGainInsert>();
    std::string error;
    CHECK (a->prepare (rate, 256, error) && b->prepare (rate, 256, error));
    a->setParameterValue (0, 0.5f);
    b->setParameterValue (0, 0.5f);

    InsertChain::Slot slotA, slotB;
    slotA.id = "a"; slotA.processor = a;
    slotB.id = "b"; slotB.processor = b;
    chain.setSlots ({ slotA, slotB });

    auto signal = makeSignal (256);

    // Device not started yet: the chain hasn't seen a matching rate, audio passes through
    CHECK (errorAgainst (runChain (chain, signal), signal, 1.0f) < 1e-6f);

    chain.audioStarted (rate);
    CHECK (errorAgainst (runChain (chain, signal), signal, 0.25f) < 1e-6f);

    slotB.bypassed->store (true);
    CHECK (errorAgainst (runChain (chain, signal), signal, 0.5f) < 1e-6f);
    slotB.bypassed->store (false);

    // A device block bigger than the prepared maximum is processed in chunks
    auto big = makeSignal (1000);
    CHECK (errorAgainst (runChain (chain, big), big, 0.25f) < 1e-6f);

    // The device reopened at another rate: pass through until re-prepared
    chain.audioStarted (44100.0);
    CHECK (errorAgainst (runChain (chain, signal), signal, 1.0f) < 1e-6f);

    chain.audioStopped();
    chain.prepare (44100.0, 128, errors);
    CHECK (errors.empty() && a->preparedRate == 44100.0 && a->preparedBlock == 128);
    chain.audioStarted (44100.0);
    CHECK (errorAgainst (runChain (chain, signal), signal, 0.25f) < 1e-6f);
    CHECK (chain.getProcessingSlot() == -1);

    chain.audioStopped();
    chain.setSlots ({});
    chain.collectGarbage();
    CHECK (chain.getNumRetired() == 0);
}

void testConcurrentSwaps()
{
    section ("Insert chain: thousands of swaps while the audio thread runs");
    InsertChain chain;
    std::vector<std::string> errors;
    chain.prepare (rate, 64, errors);
    chain.audioStarted (rate);

    std::atomic<bool> stop { false };
    std::atomic<int> callbacks { 0 };
    std::thread audio ([&]
    {
        AudioBuffer buffer (2, 64);
        while (! stop.load())
        {
            buffer.clear();
            chain.process (buffer.getArrayOfWritePointers(), 2, 64);
            ++callbacks;
        }
    });

    for (int i = 0; i < 3000; ++i)
    {
        std::vector<InsertChain::Slot> slots;
        for (int n = 0; n < 1 + i % 3; ++n)
        {
            InsertChain::Slot slot;
            slot.id = std::to_string (i) + "-" + std::to_string (n);
            if (n == 1)
            {
                auto gain = std::make_shared<TestGainInsert>();
                std::string error;
                gain->prepare (rate, 64, error);
                slot.processor = gain;
            }
            else
            {
                slot.processor = std::make_shared<CanaryInsert>();
            }
            slots.push_back (slot);
        }
        chain.setSlots (std::move (slots));
        chain.collectGarbage();
        if (i % 500 == 0)
            std::this_thread::yield();
    }

    stop = true;
    audio.join();
    chain.audioStopped();
    chain.setSlots ({});
    chain.collectGarbage();

    std::cout << "  " << callbacks.load() << " audio callbacks during 3000 swaps" << std::endl;
    CHECK (callbacks.load() > 0);
    CHECK (! CanaryInsert::usedAfterFree.load());
    CHECK (CanaryInsert::live.load() == 0);
    CHECK (chain.getNumRetired() == 0);
}

void testEngineTracks()
{
    section ("Hap engine: haps render on their track");
    HapAudioEngine engine;
    engine.prepare (rate, 512);

    auto list = Json::array();
    list.push (Json::object ({ { "time", 0.0 }, { "duration", 0.01 }, { "note", "bd" } })); // no trackIndex: track 0
    list.push (Json::object ({ { "time", 0.0 }, { "duration", 0.01 }, { "note", "c4" }, { "trackIndex", 2 } }));
    list.push (Json::object ({ { "time", 0.0 }, { "duration", 0.01 }, { "note", "e4" }, { "trackIndex", 40 } })); // clamped to 15
    engine.scheduleHaps (list);
    engine.render (512);

    CHECK (engine.isTrackActive (0) && engine.isTrackActive (2) && engine.isTrackActive (15));
    int active = 0;
    for (int t = 0; t < HapAudioEngine::maxTracks; ++t)
        active += engine.isTrackActive (t) ? 1 : 0;
    CHECK (active == 3);

    // A pitched note is a sine at that pitch: c4 is 261.63 Hz, one period every 183.5 samples
    auto* const* c4 = engine.getTrackChannels (2);
    int crossings = 0;
    for (int i = 1; i < 512; ++i)
        if ((c4[0][i - 1] < 0.0f) != (c4[0][i] < 0.0f))
            ++crossings;
    CHECK (crossings >= 4 && crossings <= 7);
    CHECK (c4[0][10] == c4[1][10]); // stereo, the same on both sides

    section ("Hap engine: a burst bigger than the queue drops events instead of blocking");
    auto burst = Json::array();
    for (int i = 0; i < 5000; ++i)
        burst.push (Json::object ({ { "time", 0.0 }, { "duration", 0.01 }, { "note", "hh" }, { "trackIndex", 1 } }));
    engine.scheduleHaps (burst);
    engine.render (512);
    CHECK (engine.getDroppedEvents() > 0);
    CHECK (engine.isTrackActive (1));
    engine.scheduleHaps (Json ("not a list")); // ignored
}

void testTrackBuses()
{
    section ("Track buses: inserts on a track only affect that track; master inserts process every track");
    HapAudioEngine engine;
    Mixer mixer (engine);
    std::vector<std::string> errors;
    mixer.getMasterChain().prepare (rate, 512, errors);
    for (int t = 0; t < Mixer::numTracks; ++t)
        mixer.getTrackChain (t).prepare (rate, 512, errors);
    mixer.start (rate, 512);

    auto render = [&] (int samples)
    {
        AudioBuffer out (2, samples);
        mixer.renderBlock (out.getArrayOfWritePointers(), 2, samples);
        return out.getMagnitude (0, samples);
    };

    engine.scheduleHaps (haps ({ { "a4", 3 } }));
    auto dryPeak = render (2048);
    CHECK (dryPeak > 0.05f);
    CHECK_NEAR (mixer.takePeak(), dryPeak, 1e-6f);
    CHECK (mixer.takePeak() == 0.0f); // reset by the read

    auto gain = std::make_shared<TestGainInsert>();
    std::string error;
    gain->prepare (rate, 512, error);
    gain->setParameterValue (0, 0.5f);
    InsertChain::Slot slot;
    slot.id = "insert-1";
    slot.processor = gain;
    mixer.getTrackChain (2).setSlots ({ slot });

    engine.scheduleHaps (haps ({ { "a4", 2 } }));
    CHECK_NEAR (render (2048), 0.5f * dryPeak, 1e-4f);  // track 2 through its gain
    engine.scheduleHaps (haps ({ { "a4", 3 } }));
    CHECK_NEAR (render (2048), dryPeak, 1e-4f);         // track 3 untouched

    gain->setParameterValue (1, 1.0f);
    engine.scheduleHaps (haps ({ { "a4", 2 } }));
    CHECK (render (2048) < 1e-6f);
    gain->setParameterValue (1, 0.0f);

    auto masterGain = std::make_shared<TestGainInsert>();
    masterGain->prepare (rate, 512, error);
    masterGain->setParameterValue (0, 0.25f);
    InsertChain::Slot masterSlot;
    masterSlot.id = "insert-2";
    masterSlot.processor = masterGain;
    mixer.getMasterChain().setSlots ({ masterSlot });
    engine.scheduleHaps (haps ({ { "a4", 3 } }));
    CHECK_NEAR (render (2048), 0.25f * dryPeak, 1e-4f);

    // The interleaved callback gives the same audio, de-interleaved
    mixer.prepareScratch (2, 256);
    engine.scheduleHaps (haps ({ { "a4", 3 } }));
    std::vector<float> interleaved (2 * 2048, 0.0f);
    mixer.renderInterleaved (interleaved.data(), 2, 2048); // 8 scratch-sized pieces
    float peak = 0.0f;
    for (auto v : interleaved)
        peak = std::max (peak, std::abs (v));
    CHECK_NEAR (peak, 0.25f * dryPeak, 1e-4f);
    CHECK (interleaved[100] == interleaved[101]); // left == right
    CHECK (mixer.getProcessingBus() == Mixer::noBus);

    mixer.stop();
    for (int t = 0; t < Mixer::numTracks; ++t)
        mixer.getTrackChain (t).setSlots ({});
    mixer.getMasterChain().setSlots ({});
}

void testMixerConcurrency()
{
    section ("Mixer: haps, track and master swaps from other threads while audio runs");
    HapAudioEngine engine;
    Mixer mixer (engine);
    std::vector<std::string> errors;
    std::vector<InsertChain*> chains { &mixer.getMasterChain() };
    for (int t = 0; t < Mixer::numTracks; ++t)
        chains.push_back (&mixer.getTrackChain (t));
    for (auto* chain : chains)
        chain->prepare (rate, 256, errors);
    mixer.start (rate, 256);

    std::atomic<bool> stop { false };
    std::atomic<int> blocks { 0 };
    std::thread audio ([&]
    {
        AudioBuffer out (2, 256);
        while (! stop.load())
        {
            mixer.renderBlock (out.getArrayOfWritePointers(), 2, 256);
            ++blocks;
        }
    });
    std::thread producer ([&]
    {
        for (int i = 0; ! stop.load(); ++i)
        {
            engine.scheduleHaps (haps ({ { "c4", i % Mixer::numTracks }, { "bd", (i * 7) % Mixer::numTracks } }));
            std::this_thread::sleep_for (std::chrono::microseconds (200));
        }
    });

    int swaps = 0;
    for (; swaps < 1500 || blocks.load() < 2000; ++swaps)
    {
        auto i = swaps;
        auto* chain = chains[static_cast<size_t> (i % static_cast<int> (chains.size()))];
        std::vector<InsertChain::Slot> slots;
        for (int n = 0; n < i % 3; ++n)
        {
            InsertChain::Slot slot;
            slot.id = std::to_string (i) + "-" + std::to_string (n);
            if (n == 1)
            {
                auto gain = std::make_shared<TestGainInsert>();
                std::string error;
                gain->prepare (rate, 256, error);
                slot.processor = gain;
            }
            else
            {
                slot.processor = std::make_shared<CanaryInsert>();
            }
            slots.push_back (slot);
        }
        chain->setSlots (std::move (slots));
        for (auto* c : chains)
            c->collectGarbage();
    }

    stop = true;
    audio.join();
    producer.join();
    mixer.stop();
    for (auto* chain : chains)
    {
        chain->setSlots ({});
        chain->collectGarbage();
    }

    std::cout << "  " << blocks.load() << " audio blocks during " << swaps << " swaps across 17 buses" << std::endl;
    CHECK (blocks.load() > 0);
    CHECK (! CanaryInsert::usedAfterFree.load());
    CHECK (CanaryInsert::live.load() == 0);
}

void testAudioDevice()
{
    section ("Audio device: the null backend runs the mixer and reports its format");
    HapAudioEngine engine;
    Mixer mixer (engine);
    std::atomic<int> started { 0 };
    std::atomic<double> startedRate { 0.0 };
    std::atomic<int> startedBlock { 0 };
    AudioDevice device (mixer);
    device.onStarted = [&] (double sampleRate, int blockSize) { startedRate = sampleRate; startedBlock = blockSize; ++started; };
    CHECK (! device.isOpen() && device.describe()["running"].toBool() == false);

    AudioDevice::Options options;
    options.nullBackend = true;
    options.preferredBlockSize = 256;
    std::string error;
    CHECK (device.open (options, error));
    CHECK (device.isOpen() && device.isNull() && device.getBackendName() == "Null");
    CHECK (started.load() == 1 && startedRate.load() > 8000.0 && startedBlock.load() > 0);
    CHECK (device.getSampleRate() == startedRate.load() && device.getBlockSize() == startedBlock.load());
    auto described = device.describe();
    CHECK (described["running"].toBool() && ! described["name"].toString().empty() && described["backend"].toString() == "Null");

    // The callback renders: haps make a peak
    engine.scheduleHaps (haps ({ { "a4", 1 } }, 0.5));
    auto end = monotonicMs() + 3000;
    float peak = 0.0f;
    while (peak == 0.0f && monotonicMs() < end)
    {
        sleepMs (20);
        peak = std::max (peak, mixer.takePeak());
    }
    CHECK (peak > 0.05f);

    // A restart (what a re-route leads to) prepares the mixer again before
    // the callbacks resume
    CHECK (device.restart (error) && started.load() == 2 && device.describe()["running"].toBool());
    engine.scheduleHaps (haps ({ { "a4", 1 } }, 0.5));
    end = monotonicMs() + 3000;
    peak = 0.0f;
    while (peak == 0.0f && monotonicMs() < end)
    {
        sleepMs (20);
        peak = std::max (peak, mixer.takePeak());
    }
    CHECK (peak > 0.05f);

    device.close();
    CHECK (! device.isOpen() && ! device.describe()["running"].toBool());
    CHECK (! device.restart (error));

    // Opening the default backends on a machine with no output falls back to null
    options.nullBackend = false;
    CHECK (device.open (options, error));
    CHECK (device.isOpen() && started.load() == 3);
    std::cout << "  default audio: " << device.getName() << " through " << device.getBackendName() << " at " << device.getSampleRate() << " Hz" << std::endl;
    device.close();
}

void testWatchdog()
{
    section ("Watchdog: a stuck audio callback and a stalled control thread are reported, then their recovery");
    std::mutex lock;
    std::vector<Watchdog::Report> reports;
    HapAudioEngine engine;
    Mixer mixer (engine);
    Watchdog watchdog ([&] (const Watchdog::Report& r) { const std::lock_guard<std::mutex> guard (lock); reports.push_back (r); }, 0.3, 0.5);
    watchdog.getBus = [&] { return mixer.getProcessingBus(); };
    watchdog.getSlot = [&] { auto bus = mixer.getProcessingBus(); return bus == Mixer::masterBus ? mixer.getMasterChain().getProcessingSlot() : bus >= 0 ? mixer.getTrackChain (bus).getProcessingSlot() : -1; };

    auto count = [&] { const std::lock_guard<std::mutex> guard (lock); return reports.size(); };
    auto report = [&] (size_t i) { const std::lock_guard<std::mutex> guard (lock); return reports[i]; };

    // Beating keeps the control side quiet
    for (int i = 0; i < 8; ++i)
    {
        watchdog.beat();
        sleepMs (100);
    }
    CHECK (count() == 0 && ! watchdog.isControlStalled());

    // A callback stuck in a track 5 insert
    std::vector<std::string> errors;
    mixer.getTrackChain (5).prepare (rate, 256, errors);
    mixer.start (rate, 256);
    auto gain = std::make_shared<TestGainInsert>();
    auto stuck = std::make_shared<StuckInsert>();
    std::string error;
    gain->prepare (rate, 256, error);
    stuck->prepare (rate, 256, error);
    InsertChain::Slot first, second;
    first.id = "a"; first.processor = gain;
    second.id = "b"; second.processor = stuck;
    mixer.getTrackChain (5).setSlots ({ first, second });
    stuck->stuck = true;
    std::thread audio ([&]
    {
        AudioBuffer out (2, 256);
        watchdog.callbackBegan();
        mixer.renderBlock (out.getArrayOfWritePointers(), 2, 256);
        watchdog.callbackEnded();
    });
    auto end = monotonicMs() + 3000;
    while (count() < 1 && monotonicMs() < end)
    {
        watchdog.beat();
        sleepMs (50);
    }
    CHECK (count() == 1 && watchdog.isAudioStalled());
    if (count() >= 1)
    {
        auto r = report (0);
        CHECK (r.what == "audio" && r.stalled && r.seconds >= 0.3 && r.bus == 5 && r.slot == 1);
    }
    stuck->stuck = false;
    audio.join();
    end = monotonicMs() + 3000;
    while (count() < 2 && monotonicMs() < end)
    {
        watchdog.beat();
        sleepMs (50);
    }
    CHECK (count() == 2 && ! watchdog.isAudioStalled());
    if (count() >= 2)
        CHECK (report (1).what == "audio" && ! report (1).stalled);

    // The control thread stops beating
    sleepMs (800);
    CHECK (count() == 3 && watchdog.isControlStalled());
    if (count() >= 3)
        CHECK (report (2).what == "control" && report (2).stalled && report (2).seconds >= 0.5);
    watchdog.beat();
    sleepMs (300);
    CHECK (count() == 4 && ! watchdog.isControlStalled());

    mixer.stop();
    mixer.getTrackChain (5).setSlots ({});
}

} // namespace

void hostTests()
{
    testChain();
    testConcurrentSwaps();
    testEngineTracks();
    testTrackBuses();
    testMixerConcurrency();
    testAudioDevice();
    testWatchdog();
}
