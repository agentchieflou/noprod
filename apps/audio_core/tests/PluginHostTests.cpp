// Plugin-hosting tests for the Audio Core: LPI loading (B5a), the master
// insert chain and its lock-free publishing (B5b), the JSON command path
// (B5c), and VST3 hosting through JUCE (#26). Exits non-zero on failure.

#include <JuceHeader.h>
#include <atomic>
#include <cmath>
#include <cstring>
#include <iostream>
#include <thread>

#include "HapAudioEngine.h"
#include "HapWebSocketServer.h"
#include "InsertChain.h"
#include "LpiPlugin.h"
#include "Mixer.h"
#include "PluginHost.h"
#include "TrackStreams.h"

static int checks = 0, failures = 0;

#define CHECK(cond)                                                                          \
    do {                                                                                     \
        ++checks;                                                                            \
        if (! (cond)) {                                                                      \
            ++failures;                                                                      \
            std::cerr << "  FAILED line " << __LINE__ << ": " #cond << std::endl;            \
        }                                                                                    \
    } while (0)

#define CHECK_NEAR(a, b, eps) CHECK (std::abs ((a) - (b)) <= (eps))

static void section (const char* name) { std::cout << "- " << name << std::endl; }

// ---------------------------------------------------------------- helpers

static constexpr double rate = 48000.0;

// A stereo test signal: different sines per channel so a channel swap shows.
static juce::AudioBuffer<float> makeSignal (int numSamples)
{
    juce::AudioBuffer<float> buffer (2, numSamples);
    for (int i = 0; i < numSamples; ++i)
    {
        buffer.setSample (0, i, 0.5f * std::sin (0.05f * static_cast<float> (i)));
        buffer.setSample (1, i, 0.3f * std::sin (0.11f * static_cast<float> (i)));
    }
    return buffer;
}

// Largest |actual - scale * expected| over all samples.
static float errorAgainst (const juce::AudioBuffer<float>& actual, const juce::AudioBuffer<float>& expected, float scale)
{
    float worst = 0.0f;
    for (int ch = 0; ch < actual.getNumChannels(); ++ch)
        for (int i = 0; i < actual.getNumSamples(); ++i)
            worst = juce::jmax (worst, std::abs (actual.getSample (ch, i) - scale * expected.getSample (ch, i)));
    return worst;
}

// Runs a signal through a single processor the way InsertChain does
// (outputs pre-filled with the dry signal).
static juce::AudioBuffer<float> runProcessor (InsertProcessor& processor, const juce::AudioBuffer<float>& input)
{
    juce::AudioBuffer<float> output (input);
    processor.process (input.getArrayOfReadPointers(), output.getArrayOfWritePointers(), 2, input.getNumSamples());
    return output;
}

static juce::AudioBuffer<float> runChain (InsertChain& chain, const juce::AudioBuffer<float>& input)
{
    juce::AudioBuffer<float> output (input);
    chain.process (output.getArrayOfWritePointers(), 2, output.getNumSamples());
    return output;
}

static juce::var command (std::initializer_list<std::pair<const char*, juce::var>> properties)
{
    juce::DynamicObject::Ptr object = new juce::DynamicObject();
    for (auto& [key, value] : properties)
        object->setProperty (key, value);
    return juce::var (object.get());
}

static juce::var findByName (const juce::var& list, const juce::String& name)
{
    if (auto* array = list.getArray())
        for (auto& item : *array)
            if (item["name"].toString() == name)
                return item;
    return {};
}

// The master bus's inserts from an AUDIO_CORE_STATE reply
static juce::var masterInserts (const juce::var& state)
{
    return state["buses"][0]["inserts"];
}

static juce::var busInserts (const juce::var& state, const juce::var& bus)
{
    if (auto* buses = state["buses"].getArray())
        for (auto& b : *buses)
            if (b["bus"] == bus)
                return b["inserts"];
    return {};
}

// A processor that detects being used after it was destroyed.
struct CanaryInsert : public InsertProcessor
{
    static inline std::atomic<int> live { 0 };
    static inline std::atomic<bool> usedAfterFree { false };
    std::atomic<uint32_t> magic { alive };
    static constexpr uint32_t alive = 0xC0FFEE, dead = 0xDEAD;

    CanaryInsert() { ++live; }
    ~CanaryInsert() override { magic = dead; --live; }

    juce::String getName() const override { return "Canary"; }
    juce::String getFormat() const override { return "TEST"; }
    juce::String getPath() const override { return {}; }
    bool prepare (double, int, juce::String&) override { return true; }
    void process (const float* const*, float* const* outputs, int, int numSamples) noexcept override
    {
        if (magic.load() != alive)
            usedAfterFree = true;
        outputs[0][numSamples - 1] += 0.0f;
    }
    std::vector<PluginParameterInfo> getParameters() override { return {}; }
    float getParameterValue (int) override { return 0.0f; }
    juce::String getParameterText (int) override { return {}; }
    bool setParameterValue (int, float) override { return false; }
};

// ------------------------------------------------------------------ tests

static void testLpiLoader()
{
    section ("LPI loader: errors");
    juce::String error;
    CHECK (LpiLibrary::open (juce::File ("/definitely/not/here.so"), error) == nullptr);
    CHECK (error.contains ("No such file"));

    error = {};
    CHECK (LpiLibrary::open (juce::File (LPI_TEST_NO_EXPORT_PATH), error) == nullptr);
    CHECK (error.contains ("not an LPI plugin"));

    error = {};
    CHECK (LpiLibrary::open (juce::File (LPI_TEST_BAD_MAJOR_PATH), error) == nullptr);
    CHECK (error.contains ("ABI 99.0"));

    section ("LPI loader: info and parameters");
    error = {};
    auto library = LpiLibrary::open (juce::File (LPI_TEST_GAIN_PATH), error);
    CHECK (library != nullptr);
    if (library == nullptr)
    {
        std::cerr << "  " << error << std::endl;
        return;
    }
    CHECK (juce::String (library->getInfo().id) == "com.noprod.test.gain");

    LpiInsert insert (library);
    CHECK (insert.prepare (rate, 256, error));
    CHECK (insert.getName() == "NoProd Test Gain");
    CHECK (insert.getFormat() == "LPI");

    auto params = insert.getParameters();
    CHECK (params.size() == 2);
    if (params.size() == 2)
    {
        CHECK (params[0].id == "gain" && params[0].maxValue == 2.0f && params[0].defaultValue == 1.0f);
        CHECK (params[1].id == "mute" && params[1].boolean && params[1].stepped);
    }

    section ("LPI insert: processes audio, applies parameter changes");
    auto signal = makeSignal (256);
    CHECK (errorAgainst (runProcessor (insert, signal), signal, 1.0f) < 1e-6f);

    CHECK (insert.setParameterValue (0, 0.5f));
    CHECK_NEAR (insert.getParameterValue (0), 0.5f, 1e-6f);
    CHECK (errorAgainst (runProcessor (insert, signal), signal, 0.5f) < 1e-6f);

    CHECK (insert.setParameterValue (1, 1.0f));
    CHECK (errorAgainst (runProcessor (insert, signal), signal, 0.0f) < 1e-6f);
    CHECK (insert.setParameterValue (1, 0.0f));
    CHECK (! insert.setParameterValue (7, 1.0f));

    section ("LPI insert: re-prepare at a new rate keeps state");
    CHECK (insert.prepare (44100.0, 128, error));
    auto shorter = makeSignal (128);
    CHECK (errorAgainst (runProcessor (insert, shorter), shorter, 0.5f) < 1e-6f);
}

static void testChain()
{
    section ("Insert chain: series processing, bypass, chunking, rate mismatch");
    juce::String error;
    auto library = LpiLibrary::open (juce::File (LPI_TEST_GAIN_PATH), error);
    if (library == nullptr)
        return;

    InsertChain chain;
    juce::StringArray errors;
    chain.prepare (rate, 256, errors);

    auto a = std::make_shared<LpiInsert> (library);
    auto b = std::make_shared<LpiInsert> (library);
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
    CHECK (errors.isEmpty());
    chain.audioStarted (44100.0);
    CHECK (errorAgainst (runChain (chain, signal), signal, 0.25f) < 1e-6f);

    chain.audioStopped();
    chain.setSlots ({});
    chain.collectGarbage();
    CHECK (chain.getNumRetired() == 0);
}

static void testConcurrentSwaps()
{
    section ("Insert chain: thousands of swaps while the audio thread runs");
    juce::String error;
    auto library = LpiLibrary::open (juce::File (LPI_TEST_GAIN_PATH), error);
    if (library == nullptr)
        return;

    InsertChain chain;
    juce::StringArray errors;
    chain.prepare (rate, 64, errors);
    chain.audioStarted (rate);

    std::atomic<bool> stop { false };
    std::atomic<int> callbacks { 0 };
    std::thread audio ([&]
    {
        juce::AudioBuffer<float> buffer (2, 64);
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
            slot.id = juce::String (i) + "-" + juce::String (n);
            if (n == 1)
            {
                auto lpi = std::make_shared<LpiInsert> (library);
                lpi->prepare (rate, 64, error);
                slot.processor = lpi;
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

static void testPluginHost()
{
    section ("Plugin host: LOAD/SET/BYPASS/MOVE/REMOVE commands");
    auto cache = juce::File::createTempFile (".xml");
    HapAudioEngine engine;
    Mixer mixer (engine);
    auto& chain = mixer.getMasterChain();
    juce::var lpiSlot, vst3Slot;

    {
        PluginHost host (mixer, cache);
        chain.audioStarted (PluginHost::defaultSampleRate);
        auto signal = makeSignal (512);

        auto state = host.handleCommand (command ({ { "type", "GET_AUDIO_CORE_STATE" } }));
        CHECK (state["type"].toString() == "AUDIO_CORE_STATE");
        CHECK (masterInserts (state).size() == 0);
        CHECK (static_cast<double> (state["sampleRate"]) == PluginHost::defaultSampleRate);

        state = host.handleCommand (command ({ { "type", "LOAD_PLUGIN" }, { "path", LPI_TEST_GAIN_PATH } }));
        CHECK (state["type"].toString() == "AUDIO_CORE_STATE");
        CHECK (masterInserts (state).size() == 1);
        lpiSlot = masterInserts (state)[0];
        CHECK (lpiSlot["name"].toString() == "NoProd Test Gain");
        CHECK (lpiSlot["format"].toString() == "LPI");
        CHECK (lpiSlot["parameters"].size() == 2);
        CHECK (lpiSlot["parameters"][0]["id"].toString() == "gain");
        auto lpiId = lpiSlot["slotId"].toString();

        auto changed = host.handleCommand (command ({ { "type", "SET_PLUGIN_PARAMETER" }, { "slotId", lpiId },
                                                       { "parameterId", "gain" }, { "value", 0.5 } }));
        CHECK (changed["type"].toString() == "PLUGIN_PARAMETER_CHANGED");
        CHECK_NEAR (static_cast<float> (changed["value"]), 0.5f, 1e-6f);
        CHECK (errorAgainst (runChain (chain, signal), signal, 0.5f) < 1e-6f);

        // Out-of-range values are clamped to the plugin's range
        changed = host.handleCommand (command ({ { "type", "SET_PLUGIN_PARAMETER" }, { "slotId", lpiId },
                                                  { "parameterIndex", 0 }, { "value", 9.0 } }));
        CHECK_NEAR (static_cast<float> (changed["value"]), 2.0f, 1e-6f);

        // SET_VST_PARAMETER (trackIndex -1 = master): normalized 0.25 of 0..2 = 0.5
        changed = host.handleCommand (command ({ { "type", "SET_VST_PARAMETER" }, { "trackIndex", -1 },
                                                  { "pluginName", "NoProd Test Gain" }, { "parameterIndex", 0 }, { "value", 0.25 } }));
        CHECK (changed["type"].toString() == "PLUGIN_PARAMETER_CHANGED");
        CHECK_NEAR (static_cast<float> (changed["value"]), 0.5f, 1e-6f);

        section ("Plugin host: VST3 via JUCE");
        state = host.handleCommand (command ({ { "type", "LOAD_PLUGIN" }, { "path", TEST_VST3_PATH }, { "index", 0 } }));
        CHECK (state["type"].toString() == "AUDIO_CORE_STATE");
        CHECK (masterInserts (state).size() == 2);
        if (masterInserts (state).size() != 2)
        {
            std::cerr << "  " << state["message"].toString() << std::endl;
            return;
        }
        vst3Slot = masterInserts (state)[0];
        CHECK (vst3Slot["format"].toString() == "VST3");
        CHECK (vst3Slot["name"].toString() == "NoProd Test Gain");
        auto gainParam = findByName (vst3Slot["parameters"], "Gain");
        CHECK (! gainParam.isVoid());
        auto vst3Id = vst3Slot["slotId"].toString();

        // VST3 at unity, LPI at 0.5
        CHECK (errorAgainst (runChain (chain, signal), signal, 0.5f) < 1e-5f);

        changed = host.handleCommand (command ({ { "type", "SET_PLUGIN_PARAMETER" }, { "slotId", vst3Id },
                                                  { "parameterIndex", gainParam["index"] }, { "value", 0.5 } }));
        CHECK (changed["type"].toString() == "PLUGIN_PARAMETER_CHANGED");
        CHECK (changed["text"].toString().startsWith ("0.5"));
        runChain (chain, signal); // VST3 parameter changes arrive with the next block
        CHECK (errorAgainst (runChain (chain, signal), signal, 0.25f) < 1e-5f);

        section ("Plugin host: bypass, move, remove, errors");
        state = host.handleCommand (command ({ { "type", "SET_PLUGIN_BYPASS" }, { "slotId", lpiId }, { "bypassed", true } }));
        CHECK (static_cast<bool> (masterInserts (state)[1]["bypassed"]));
        CHECK (errorAgainst (runChain (chain, signal), signal, 0.5f) < 1e-5f);

        state = host.handleCommand (command ({ { "type", "MOVE_PLUGIN" }, { "slotId", lpiId }, { "index", 0 } }));
        CHECK (masterInserts (state)[0]["slotId"].toString() == lpiId);

        state = host.handleCommand (command ({ { "type", "REMOVE_PLUGIN" }, { "slotId", vst3Id } }));
        CHECK (masterInserts (state).size() == 1);
        CHECK (masterInserts (state)[0]["slotId"].toString() == lpiId);

        auto error = host.handleCommand (command ({ { "type", "REMOVE_PLUGIN" }, { "slotId", "nope" } }));
        CHECK (error["type"].toString() == "AUDIO_CORE_ERROR");
        CHECK (error["request"].toString() == "REMOVE_PLUGIN");

        error = host.handleCommand (command ({ { "type", "LOAD_PLUGIN" }, { "path", LPI_TEST_BAD_MAJOR_PATH } }));
        CHECK (error["type"].toString() == "AUDIO_CORE_ERROR");
        CHECK (error["message"].toString().contains ("ABI"));

        error = host.handleCommand (command ({ { "type", "SET_PLUGIN_PARAMETER" }, { "slotId", lpiId },
                                                { "parameterId", "nope" }, { "value", 1 } }));
        CHECK (error["type"].toString() == "AUDIO_CORE_ERROR");

        CHECK (host.handleCommand (command ({ { "type", "HAP_STREAM" } })).isVoid());

        section ("Plugin host: device restart re-prepares inserts");
        chain.audioStopped();
        CHECK (host.setAudioFormat (44100.0, 256).isEmpty());
        chain.audioStarted (44100.0);
        state = host.getState();
        CHECK (static_cast<double> (state["sampleRate"]) == 44100.0);
        CHECK (static_cast<int> (state["blockSize"]) == PluginHost::minimumBlockSize);
        state = host.handleCommand (command ({ { "type", "SET_PLUGIN_BYPASS" }, { "slotId", lpiId }, { "bypassed", false } }));
        CHECK (errorAgainst (runChain (chain, signal), signal, 0.5f) < 1e-6f);

        section ("Plugin host: SCAN_PLUGINS finds LPI and VST3 in given folders");
        auto lpiFolder = juce::File (LPI_TEST_GAIN_PATH).getParentDirectory().getParentDirectory();
        auto vst3Folder = juce::File (TEST_VST3_PATH).getParentDirectory();
        state = host.handleCommand (command ({ { "type", "SCAN_PLUGINS" },
                                               { "paths", juce::Array<juce::var> { lpiFolder.getFullPathName(), vst3Folder.getFullPathName(), "not/absolute" } } }));
        auto available = state["availablePlugins"];
        int lpiFound = 0, vst3Found = 0;
        for (auto& p : *available.getArray())
        {
            if (p["format"].toString() == "LPI") ++lpiFound;
            if (p["format"].toString() == "VST3" && p["name"].toString() == "NoProd Test Gain") ++vst3Found;
        }
        CHECK (lpiFound == 1); // the wrong-ABI and no-export variants are not listed
        CHECK (vst3Found == 1);
        CHECK (state["scanFolders"].size() == 2);

        chain.audioStopped();
        host.clearAllInserts();
    }

    section ("Plugin host: scanned list persists");
    HapAudioEngine otherEngine;
    Mixer otherMixer (otherEngine);
    PluginHost reloaded (otherMixer, cache);
    auto available = reloaded.getState()["availablePlugins"];
    CHECK (! findByName (available, "NoProd Test Gain").isVoid());
    CHECK (available.size() == 2);
    CHECK (reloaded.getState()["scanFolders"].size() == 2);
    cache.deleteFile();
}

static juce::var haps (std::initializer_list<std::pair<const char*, int>> notes, double durationCycles = 0.01)
{
    juce::Array<juce::var> list;
    for (auto& [note, track] : notes)
        list.add (command ({ { "time", 0.0 }, { "duration", durationCycles }, { "note", note }, { "trackIndex", track } }));
    return list;
}

static void testOrigins()
{
    section ("WebSocket origin policy");
    CHECK (HapWebSocketServer::isAllowedOrigin ({}));                      // non-browser client (the Orchestrator)
    CHECK (HapWebSocketServer::isAllowedOrigin ("http://localhost:5173"));
    CHECK (HapWebSocketServer::isAllowedOrigin ("http://127.0.0.1"));
    CHECK (HapWebSocketServer::isAllowedOrigin ("https://[::1]:4173"));
    CHECK (! HapWebSocketServer::isAllowedOrigin ("https://evil.example"));
    CHECK (! HapWebSocketServer::isAllowedOrigin ("http://localhost.evil.example"));
    CHECK (! HapWebSocketServer::isAllowedOrigin ("http://localhost:80@evil.example"));
    CHECK (! HapWebSocketServer::isAllowedOrigin ("http://localhost:"));
    CHECK (! HapWebSocketServer::isAllowedOrigin ("null"));
    CHECK (! HapWebSocketServer::isAllowedOrigin ("file://"));
}

static void testEngineTracks()
{
    section ("Hap engine: haps render on their track");
    HapAudioEngine engine;
    engine.prepare (rate, 512);

    juce::Array<juce::var> list;
    list.add (command ({ { "time", 0.0 }, { "duration", 0.01 }, { "note", "bd" } })); // no trackIndex: track 0
    list.add (command ({ { "time", 0.0 }, { "duration", 0.01 }, { "note", "c4" }, { "trackIndex", 2 } }));
    list.add (command ({ { "time", 0.0 }, { "duration", 0.01 }, { "note", "e4" }, { "trackIndex", 40 } })); // clamped to 15
    engine.scheduleHaps (list);
    engine.render (512);

    CHECK (engine.isTrackActive (0) && engine.isTrackActive (2) && engine.isTrackActive (15));
    int active = 0;
    for (int t = 0; t < HapAudioEngine::maxTracks; ++t)
        active += engine.isTrackActive (t) ? 1 : 0;
    CHECK (active == 3);

    section ("Hap engine: a burst bigger than the queue drops events instead of blocking");
    juce::Array<juce::var> burst;
    for (int i = 0; i < 5000; ++i)
        burst.add (command ({ { "time", 0.0 }, { "duration", 0.01 }, { "note", "hh" }, { "trackIndex", 1 } }));
    engine.scheduleHaps (burst);
    engine.render (512);
    CHECK (engine.getDroppedEvents() > 0);
    CHECK (engine.isTrackActive (1));
}

static void testTrackBuses()
{
    section ("Track buses: inserts on a track only affect that track");
    auto cache = juce::File::createTempFile (".xml");
    HapAudioEngine engine;
    Mixer mixer (engine);
    PluginHost host (mixer, cache);
    mixer.start (PluginHost::defaultSampleRate, 512);

    auto render = [&] (int samples)
    {
        juce::AudioBuffer<float> out (2, samples);
        mixer.renderBlock (out.getArrayOfWritePointers(), 2, samples);
        return out.getMagnitude (0, samples);
    };

    engine.scheduleHaps (haps ({ { "a4", 3 } }));
    auto dryPeak = render (2048);
    CHECK (dryPeak > 0.05f);

    auto state = host.handleCommand (command ({ { "type", "LOAD_PLUGIN" }, { "path", LPI_TEST_GAIN_PATH }, { "bus", 2 } }));
    CHECK (state["type"].toString() == "AUDIO_CORE_STATE");
    CHECK (static_cast<int> (state["trackCount"]) == Mixer::numTracks);
    CHECK (masterInserts (state).size() == 0);
    CHECK (busInserts (state, 2).size() == 1);
    auto slotId = busInserts (state, 2)[0]["slotId"].toString();

    host.handleCommand (command ({ { "type", "SET_PLUGIN_PARAMETER" }, { "slotId", slotId }, { "parameterId", "gain" }, { "value", 0.5 } }));
    engine.scheduleHaps (haps ({ { "a4", 2 } }));
    CHECK_NEAR (render (2048), 0.5f * dryPeak, 1e-4f);  // track 2 through its gain
    engine.scheduleHaps (haps ({ { "a4", 3 } }));
    CHECK_NEAR (render (2048), dryPeak, 1e-4f);         // track 3 untouched

    host.handleCommand (command ({ { "type", "SET_PLUGIN_PARAMETER" }, { "slotId", slotId }, { "parameterId", "mute" }, { "value", 1 } }));
    engine.scheduleHaps (haps ({ { "a4", 2 } }));
    CHECK (render (2048) < 1e-6f);

    section ("Track buses: master inserts process every track");
    state = host.handleCommand (command ({ { "type", "LOAD_PLUGIN" }, { "path", LPI_TEST_GAIN_PATH }, { "bus", "master" } }));
    auto masterId = masterInserts (state)[0]["slotId"].toString();
    host.handleCommand (command ({ { "type", "SET_PLUGIN_PARAMETER" }, { "slotId", masterId }, { "parameterId", "gain" }, { "value", 0.25 } }));
    engine.scheduleHaps (haps ({ { "a4", 3 } }));
    CHECK_NEAR (render (2048), 0.25f * dryPeak, 1e-4f);

    section ("Track buses: commands address buses and slots");
    state = host.handleCommand (command ({ { "type", "LOAD_PLUGIN" }, { "path", LPI_TEST_GAIN_PATH }, { "bus", "7" } }));
    CHECK (busInserts (state, 7).size() == 1);
    for (auto bad : { juce::var (99), juce::var (-1), juce::var ("nope") })
    {
        auto error = host.handleCommand (command ({ { "type", "LOAD_PLUGIN" }, { "path", LPI_TEST_GAIN_PATH }, { "bus", bad } }));
        CHECK (error["type"].toString() == "AUDIO_CORE_ERROR");
    }

    // SET_VST_PARAMETER's trackIndex picks the bus: 0.75 of 0..2 = 1.5
    host.handleCommand (command ({ { "type", "SET_PLUGIN_PARAMETER" }, { "slotId", slotId }, { "parameterId", "mute" }, { "value", 0 } }));
    auto changed = host.handleCommand (command ({ { "type", "SET_VST_PARAMETER" }, { "trackIndex", 2 }, { "pluginName", "NoProd Test Gain" },
                                                  { "parameterIndex", 0 }, { "value", 0.75 } }));
    CHECK (changed["type"].toString() == "PLUGIN_PARAMETER_CHANGED" && changed["slotId"].toString() == slotId);
    CHECK_NEAR (static_cast<float> (changed["value"]), 1.5f, 1e-6f);
    auto error = host.handleCommand (command ({ { "type", "SET_VST_PARAMETER" }, { "trackIndex", 5 }, { "pluginName", "NoProd Test Gain" },
                                                { "parameterIndex", 0 }, { "value", 0.5 } }));
    CHECK (error["type"].toString() == "AUDIO_CORE_ERROR" && error["message"].toString().contains ("track 5"));

    // Slot ids work across buses: remove the track 2 insert without naming its bus
    state = host.handleCommand (command ({ { "type", "REMOVE_PLUGIN" }, { "slotId", slotId } }));
    CHECK (busInserts (state, 2).isVoid()); // empty track buses aren't listed
    CHECK (busInserts (state, 7).size() == 1 && masterInserts (state).size() == 1);

    mixer.stop();
    host.clearAllInserts();
    cache.deleteFile();
}

static void testMixerConcurrency()
{
    section ("Mixer: haps, track and master swaps from other threads while audio runs");
    juce::String error;
    auto library = LpiLibrary::open (juce::File (LPI_TEST_GAIN_PATH), error);
    if (library == nullptr)
        return;

    HapAudioEngine engine;
    Mixer mixer (engine);
    juce::StringArray errors;
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
        juce::AudioBuffer<float> out (2, 256);
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
            slot.id = juce::String (i) + "-" + juce::String (n);
            if (n == 1)
            {
                auto lpi = std::make_shared<LpiInsert> (library);
                lpi->prepare (rate, 256, error);
                slot.processor = lpi;
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

// One stream audio message: header + planar samples (see TrackStreams.h)
static std::vector<uint8_t> streamFrame (uint32_t seq, const juce::AudioBuffer<float>& audio)
{
    auto frames = static_cast<uint32_t> (audio.getNumSamples()), channels = static_cast<uint32_t> (audio.getNumChannels());
    std::vector<uint8_t> data (TrackStream::headerBytes + frames * channels * sizeof (float));
    uint32_t header[4] { seq, frames, channels, 0 };
    std::memcpy (data.data(), header, sizeof (header));
    for (uint32_t ch = 0; ch < channels; ++ch)
        std::memcpy (data.data() + TrackStream::headerBytes + ch * frames * sizeof (float), audio.getReadPointer (static_cast<int> (ch)), frames * sizeof (float));
    return data;
}

static juce::AudioBuffer<float> streamAudio (const std::vector<uint8_t>& data, int channels, int frames)
{
    juce::AudioBuffer<float> audio (channels, frames);
    for (int ch = 0; ch < channels; ++ch)
        std::memcpy (audio.getWritePointer (ch), data.data() + TrackStream::headerBytes + static_cast<size_t> (ch * frames) * sizeof (float), static_cast<size_t> (frames) * sizeof (float));
    return audio;
}

static void testTrackStreams()
{
    section ("Track streams: a browser track's audio runs through its stream's plugin");
    auto cache = juce::File::createTempFile (".xml");
    HapAudioEngine engine;
    Mixer mixer (engine);
    PluginHost host (mixer, cache);

    auto stream = std::make_shared<TrackStream>();
    stream->id = "device-1";
    stream->sampleRate = 44100.0;
    stream->maxBlockSize = 256;
    juce::StringArray errors;
    stream->chain.prepare (stream->sampleRate, stream->maxBlockSize, errors);
    stream->chain.audioStarted (stream->sampleRate);
    host.registerStream (stream);

    auto signal = makeSignal (256);
    auto frame = streamFrame (7, signal);
    CHECK (stream->processFrame (frame.data(), frame.size()));   // no plugin yet: unchanged
    CHECK (errorAgainst (streamAudio (frame, 2, 256), signal, 1.0f) < 1e-6f);

    // LOAD with saved parameter values (by parameter id)
    juce::DynamicObject::Ptr values = new juce::DynamicObject();
    values->setProperty ("gain", 0.5);
    auto state = host.handleStreamCommand (*stream, command ({ { "type", "LOAD" }, { "path", LPI_TEST_GAIN_PATH }, { "parameters", juce::var (values.get()) } }));
    CHECK (state["type"].toString() == "STREAM_STATE");
    CHECK (state["insert"]["name"].toString() == "NoProd Test Gain");
    CHECK_NEAR (static_cast<float> (state["insert"]["parameters"][0]["value"]), 0.5f, 1e-6f);

    frame = streamFrame (8, signal);
    CHECK (stream->processFrame (frame.data(), frame.size()));
    CHECK (errorAgainst (streamAudio (frame, 2, 256), signal, 0.5f) < 1e-6f);
    uint32_t seq = 0;
    std::memcpy (&seq, frame.data(), 4);
    CHECK (seq == 8); // the header goes back as it came

    auto changed = host.handleStreamCommand (*stream, command ({ { "type", "SET_PARAM" }, { "parameterId", "mute" }, { "value", 1 } }));
    CHECK (changed["type"].toString() == "PLUGIN_PARAMETER_CHANGED");
    frame = streamFrame (9, signal);
    stream->processFrame (frame.data(), frame.size());
    CHECK (errorAgainst (streamAudio (frame, 2, 256), signal, 0.0f) < 1e-6f);

    // Blocks bigger than the stream's block size are processed in chunks
    auto big = makeSignal (1000);
    host.handleStreamCommand (*stream, command ({ { "type", "SET_PARAM" }, { "parameterId", "mute" }, { "value", 0 } }));
    frame = streamFrame (10, big);
    CHECK (stream->processFrame (frame.data(), frame.size()));
    CHECK (errorAgainst (streamAudio (frame, 2, 1000), big, 0.5f) < 1e-6f);

    section ("Track streams: malformed audio is refused untouched");
    frame = streamFrame (11, signal);
    auto truncated = frame;
    truncated.resize (frame.size() - 4);
    CHECK (! stream->processFrame (truncated.data(), truncated.size()));
    CHECK (! stream->processFrame (frame.data(), 10));
    auto tooManyChannels = frame;
    uint32_t badChannels = 99;
    std::memcpy (tooManyChannels.data() + 8, &badChannels, 4);
    CHECK (! stream->processFrame (tooManyChannels.data(), tooManyChannels.size()));
    CHECK (errorAgainst (streamAudio (frame, 2, 256), signal, 1.0f) < 1e-6f);

    section ("Track streams: state, errors, unload and close");
    auto all = host.getState();
    CHECK (all["streams"].size() == 1 && all["streams"][0]["streamId"].toString() == "device-1");
    auto error = host.handleStreamCommand (*stream, command ({ { "type", "LOAD" }, { "path", "/nope.so" } }));
    CHECK (error["type"].toString() == "AUDIO_CORE_ERROR" && error["request"].toString() == "STREAM_LOAD");
    CHECK (host.getState()["streams"][0]["inserts"].size() == 1); // a failed LOAD keeps the current plugin
    state = host.handleStreamCommand (*stream, command ({ { "type", "UNLOAD" } }));
    CHECK (state["insert"].isVoid());
    error = host.handleStreamCommand (*stream, command ({ { "type", "SET_PARAM" }, { "parameterIndex", 0 }, { "value", 1 } }));
    CHECK (error["type"].toString() == "AUDIO_CORE_ERROR");

    stream->chain.audioStopped();
    host.closeStream (stream);
    CHECK (host.getState()["streams"].size() == 0);
    cache.deleteFile();
}

int main()
{
    juce::ScopedJuceInitialiser_GUI juce; // this thread is the message thread

    testLpiLoader();
    testChain();
    testConcurrentSwaps();
    testPluginHost();
    testOrigins();
    testEngineTracks();
    testTrackBuses();
    testMixerConcurrency();
    testTrackStreams();

    std::cout << (failures == 0 ? "PASS" : "FAIL") << ": " << (checks - failures) << "/" << checks << " checks" << std::endl;
    return failures == 0 ? 0 : 1;
}
