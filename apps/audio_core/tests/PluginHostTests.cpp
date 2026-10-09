// Plugin-hosting tests for the Audio Core: LPI loading (B5a), the master
// insert chain and its lock-free publishing (B5b), the JSON command path
// (B5c), and VST3 hosting through JUCE (#26). Exits non-zero on failure.

#include <JuceHeader.h>
#include <atomic>
#include <cmath>
#include <iostream>
#include <thread>

#include "InsertChain.h"
#include "LpiPlugin.h"
#include "PluginHost.h"

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
    InsertChain chain;
    juce::var lpiSlot, vst3Slot;

    {
        PluginHost host (chain, cache);
        chain.audioStarted (PluginHost::defaultSampleRate);
        auto signal = makeSignal (512);

        auto state = host.handleCommand (command ({ { "type", "GET_AUDIO_CORE_STATE" } }));
        CHECK (state["type"].toString() == "AUDIO_CORE_STATE");
        CHECK (state["inserts"].size() == 0);
        CHECK (static_cast<double> (state["sampleRate"]) == PluginHost::defaultSampleRate);

        state = host.handleCommand (command ({ { "type", "LOAD_PLUGIN" }, { "path", LPI_TEST_GAIN_PATH } }));
        CHECK (state["type"].toString() == "AUDIO_CORE_STATE");
        CHECK (state["inserts"].size() == 1);
        lpiSlot = state["inserts"][0];
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

        // The legacy SET_VST_PARAMETER message: normalized 0.25 of 0..2 = 0.5
        changed = host.handleCommand (command ({ { "type", "SET_VST_PARAMETER" }, { "trackIndex", 0 },
                                                  { "pluginName", "NoProd Test Gain" }, { "parameterIndex", 0 }, { "value", 0.25 } }));
        CHECK (changed["type"].toString() == "PLUGIN_PARAMETER_CHANGED");
        CHECK_NEAR (static_cast<float> (changed["value"]), 0.5f, 1e-6f);

        section ("Plugin host: VST3 via JUCE");
        state = host.handleCommand (command ({ { "type", "LOAD_PLUGIN" }, { "path", TEST_VST3_PATH }, { "index", 0 } }));
        CHECK (state["type"].toString() == "AUDIO_CORE_STATE");
        CHECK (state["inserts"].size() == 2);
        if (state["inserts"].size() != 2)
        {
            std::cerr << "  " << state["message"].toString() << std::endl;
            return;
        }
        vst3Slot = state["inserts"][0];
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
        CHECK (static_cast<bool> (state["inserts"][1]["bypassed"]));
        CHECK (errorAgainst (runChain (chain, signal), signal, 0.5f) < 1e-5f);

        state = host.handleCommand (command ({ { "type", "MOVE_PLUGIN" }, { "slotId", lpiId }, { "index", 0 } }));
        CHECK (state["inserts"][0]["slotId"].toString() == lpiId);

        state = host.handleCommand (command ({ { "type", "REMOVE_PLUGIN" }, { "slotId", vst3Id } }));
        CHECK (state["inserts"].size() == 1);
        CHECK (state["inserts"][0]["slotId"].toString() == lpiId);

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
        chain.setSlots ({});
        chain.collectGarbage();
    }

    section ("Plugin host: scanned list persists");
    InsertChain otherChain;
    PluginHost reloaded (otherChain, cache);
    auto available = reloaded.getState()["availablePlugins"];
    CHECK (! findByName (available, "NoProd Test Gain").isVoid());
    CHECK (available.size() == 2);
    CHECK (reloaded.getState()["scanFolders"].size() == 2);
    cache.deleteFile();
}

int main()
{
    juce::ScopedJuceInitialiser_GUI juce; // this thread is the message thread

    testLpiLoader();
    testChain();
    testConcurrentSwaps();
    testPluginHost();

    std::cout << (failures == 0 ? "PASS" : "FAIL") << ": " << (checks - failures) << "/" << checks << " checks" << std::endl;
    return failures == 0 ? 0 : 1;
}
