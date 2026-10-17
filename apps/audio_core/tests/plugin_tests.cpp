// Tests for plugin hosting (#134, steps 3 and 4): LPI loading, the command
// path (plugins by id only), saved bus state, track streams, editors and
// their keyboard, the transport and latency extensions, the scanner's
// child process surviving a plugin that crashes or hangs, and VST 3
// through the SDK's interfaces. Ported from the JUCE host's tests, with
// the security rules added.

#include "Check.h"
#include "host/HapAudioEngine.h"
#include "host/InsertChain.h"
#include "host/LpiPlugin.h"
#include "host/Mixer.h"
#include "host/PluginHost.h"
#include "host/PluginRegistry.h"
#include "host/PluginScanner.h"
#include "host/TrackStreams.h"
#include "host/AuPlugin.h"
#include "host/Vst3Plugin.h"
#include "plugins/au_test_gain.h"
#include "host/editor/LpiEditor.h"
#include "platform/Base64.h"
#include "platform/ChildProcess.h"
#include "platform/Files.h"
#include "platform/Json.h"
#include "platform/Loop.h"
#include "platform/Platform.h"
#include "platform/Random.h"
#include "platform/Strings.h"

#include <array>
#include <atomic>
#include <cmath>
#include <cstring>
#include <functional>
#include <iostream>
#include <set>
#include <thread>

#if GHOSTDAW_MAC
#include <AudioToolbox/AudioToolbox.h>
#include <CoreFoundation/CoreFoundation.h>
#endif

using namespace ghostdaw;

namespace
{

constexpr double rate = 48000.0;

// Paths from the scan against the build's: on Windows, CMake writes them with
// forward slashes and the scan with backslashes
bool samePath (const std::string& a, const std::string& b)
{
    return pathFromUtf8 (a).lexically_normal() == pathFromUtf8 (b).lexically_normal();
}

fs::path tempDir (const char* name)
{
    auto dir = fs::temp_directory_path() / ("ghostdaw-tests-" + std::string (name) + "-" + secureRandomHex (4));
    createDirectories (dir);
    return dir;
}

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

// Runs a signal through a single processor the way InsertChain does
// (outputs pre-filled with the dry signal).
AudioBuffer runProcessor (InsertProcessor& processor, const AudioBuffer& input)
{
    auto output = copyOf (input);
    processor.process (input.getArrayOfReadPointers(), output.getArrayOfWritePointers(), 2, input.getNumSamples());
    return output;
}

AudioBuffer runChain (InsertChain& chain, const AudioBuffer& input)
{
    auto output = copyOf (input);
    chain.process (output.getArrayOfWritePointers(), 2, output.getNumSamples());
    return output;
}

Json command (std::initializer_list<std::pair<const char*, Json>> properties)
{
    return Json::object (properties);
}

Json findByName (const Json& list, const std::string& name)
{
    for (auto& item : list.elements())
        if (item["name"].toString() == name)
            return item;
    return {};
}

std::vector<uint8_t> floatBytes (float value)
{
    std::vector<uint8_t> bytes (sizeof (float));
    std::memcpy (bytes.data(), &value, sizeof (float));
    return bytes;
}

std::vector<uint8_t> operator+ (std::vector<uint8_t> bytes, const std::string& text)
{
    bytes.insert (bytes.end(), text.begin(), text.end());
    return bytes;
}

std::string textOf (const std::vector<uint8_t>& bytes) { return std::string (bytes.begin(), bytes.end()); }

// A VST3 state chunk as Vst3Insert saves it (Vst3Plugin.h)
std::vector<uint8_t> vst3Chunk (const std::vector<uint8_t>& component, const std::vector<uint8_t>& controller = {})
{
    std::vector<uint8_t> chunk;
    auto size = static_cast<uint32_t> (component.size());
    for (int shift : { 0, 8, 16, 24 })
        chunk.push_back (static_cast<uint8_t> (size >> shift));
    chunk.insert (chunk.end(), component.begin(), component.end());
    chunk.insert (chunk.end(), controller.begin(), controller.end());
    return chunk;
}

// The LPI test gain's state: its two values, then a preset name no
// parameter sets
std::vector<uint8_t> lpiGainState (float gain, float mute, const std::string& name)
{
    auto bytes = floatBytes (gain);
    auto muteBytes = floatBytes (mute);
    bytes.insert (bytes.end(), muteBytes.begin(), muteBytes.end());
    return bytes + name;
}

// What a processor's state holds, as text (the chunk the host saves, decoded)
std::string stateText (InsertProcessor& processor)
{
    std::vector<uint8_t> bytes;
    processor.getState (bytes);
    return textOf (bytes);
}

std::string savedChunk (const Json& savedState, const Json& bus, size_t insert = 0)
{
    for (auto& b : savedState["buses"].elements())
        if (b["bus"] == bus)
            return b["inserts"][insert]["state"].toString();
    return {};
}

// The master bus's inserts from an AUDIO_CORE_STATE reply
Json masterInserts (const Json& state)
{
    return state["buses"][0]["inserts"];
}

Json busInserts (const Json& state, const Json& bus)
{
    for (auto& b : state["buses"].elements())
        if (b["bus"] == bus)
            return b["inserts"];
    return {};
}

// The test plugins, registered the way a scan would list them (loaded
// here, in-process, since they are known good)
struct TestPlugins
{
    std::string gain = "com.noprod.test.gain", gui = "com.noprod.test.gui", polling = "com.noprod.test.gui.polling",
                latency = "com.noprod.test.gui.latency", transport = "com.noprod.test.gui.transport";

    static void registerAll (PluginRegistry& registry)
    {
        std::vector<KnownPlugin> known;
        for (auto* path : { LPI_TEST_GAIN_PATH, LPI_TEST_GUI_PATH, LPI_TEST_GUI_POLLING_PATH, LPI_TEST_GUI_LATENCY_PATH, LPI_TEST_GUI_TRANSPORT_PATH })
        {
            auto described = PluginScanner::describeFile (pathFromUtf8 (path));
            for (auto& p : described["plugins"].elements())
                known.push_back ({ p["pluginId"].toString(), p["name"].toString(), p["vendor"].toString(), p["format"].toString(), path,
                                   PluginRegistry::modificationTime (pathFromUtf8 (path)) });
        }
        registry.replace (known, {});
    }
};

// Everything a plugin host test needs, in a temporary data folder
struct Rig
{
    fs::path dir = tempDir ("host");
    MessageLoop loop;
    HapAudioEngine engine;
    Mixer mixer { engine };
    PluginRegistry registry { dir };
    PluginHost host { mixer, loop, registry, dir / "state.json" };
    std::vector<Json> broadcasts;

    Rig()
    {
        TestPlugins::registerAll (registry);
        host.broadcast = [this] (const Json& m) { broadcasts.push_back (m); };
    }

    ~Rig()
    {
        host.clearAllInserts();
        fs::remove_all (dir);
    }

    // Runs `work` on another thread while this (the control) thread
    // dispatches, the way an editor stream's threads run against GhostDAW's
    void offControlThread (const std::function<void()>& work)
    {
        std::atomic<bool> done { false };
        std::thread thread ([&] { work(); done = true; });
        loop.runUntil ([&] { return done.load(); }, 10000);
        thread.join();
    }
};

Json haps (std::initializer_list<std::pair<const char*, int>> notes, double durationCycles = 0.01)
{
    auto list = Json::array();
    for (auto& [note, track] : notes)
        list.push (command ({ { "time", 0.0 }, { "duration", durationCycles }, { "note", note }, { "trackIndex", track } }));
    return list;
}

// ------------------------------------------------------------------ tests

void testLpiLoader()
{
    section ("LPI loader: errors");
    std::string error;
    CHECK (LpiLibrary::open (fs::path ("/definitely/not/here.so"), error) == nullptr);
    CHECK (error.find ("No such file") != std::string::npos);

    error = {};
    CHECK (LpiLibrary::open (pathFromUtf8 (LPI_TEST_NO_EXPORT_PATH), error) == nullptr);
    CHECK (error.find ("not an LPI plugin") != std::string::npos);

    error = {};
    CHECK (LpiLibrary::open (pathFromUtf8 (LPI_TEST_BAD_MAJOR_PATH), error) == nullptr);
    CHECK (error.find ("ABI 99.0") != std::string::npos);

    section ("LPI loader: info and parameters");
    error = {};
    auto library = LpiLibrary::open (pathFromUtf8 (LPI_TEST_GAIN_PATH), error);
    CHECK (library != nullptr);
    if (library == nullptr)
    {
        std::cerr << "  " << error << std::endl;
        return;
    }
    CHECK (library->getId() == "com.noprod.test.gain");

    LpiInsert insert (library);
    CHECK (insert.prepare (rate, 256, error));
    CHECK (insert.getName() == "NoProd Test Gain");
    CHECK (insert.getFormat() == "LPI" && insert.getPluginId() == "com.noprod.test.gain");

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

    section ("Insert chain: LPI inserts in series, thousands of swaps under an audio thread");
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
    for (int i = 0; i < 1000; ++i)
    {
        std::vector<InsertChain::Slot> slots;
        for (int n = 0; n < 1 + i % 3; ++n)
        {
            InsertChain::Slot slot;
            slot.id = std::to_string (i) + "-" + std::to_string (n);
            auto lpi = std::make_shared<LpiInsert> (library);
            lpi->prepare (rate, 64, error);
            slot.processor = lpi;
            slots.push_back (slot);
        }
        chain.setSlots (std::move (slots));
        chain.collectGarbage();
    }
    for (int waited = 0; callbacks.load() == 0 && waited < 200; ++waited)
        sleepMs (10); // a loaded machine may not have run the audio thread yet
    stop = true;
    audio.join();
    chain.audioStopped();
    chain.setSlots ({});
    chain.collectGarbage();
    CHECK (callbacks.load() > 0 && chain.getNumRetired() == 0);
}

void testPluginHost()
{
    section ("Plugin host: LOAD/SET/BYPASS/MOVE/REMOVE commands, by id");
    Rig rig;
    auto& host = rig.host;
    auto& chain = rig.mixer.getMasterChain();
    chain.audioStarted (PluginHost::defaultSampleRate);
    auto signal = makeSignal (512);

    auto state = host.handleCommand (command ({ { "type", "GET_AUDIO_CORE_STATE" } }));
    CHECK (state["type"].toString() == "AUDIO_CORE_STATE");
    CHECK (state["protocolVersion"].toInt() == 2);
    CHECK (masterInserts (state).size() == 0);
    CHECK (state["sampleRate"].toDouble() == PluginHost::defaultSampleRate);
    CHECK (state["availablePlugins"].size() == 5 && state["skippedPlugins"].isArray() && state["scanFolders"].isArray() && ! state["scanning"].toBool());

    state = host.handleCommand (command ({ { "type", "LOAD_PLUGIN" }, { "pluginId", "com.noprod.test.gain" } }));
    CHECK (state["type"].toString() == "AUDIO_CORE_STATE");
    CHECK (masterInserts (state).size() == 1);
    auto lpiSlot = masterInserts (state)[0];
    CHECK (lpiSlot["name"].toString() == "NoProd Test Gain");
    CHECK (lpiSlot["format"].toString() == "LPI" && lpiSlot["pluginId"].toString() == "com.noprod.test.gain");
    CHECK (lpiSlot["parameters"].size() == 2);
    CHECK (lpiSlot["parameters"][0]["id"].toString() == "gain");
    auto lpiId = lpiSlot["slotId"].toString();

    auto changed = host.handleCommand (command ({ { "type", "SET_PLUGIN_PARAMETER" }, { "slotId", lpiId },
                                                  { "parameterId", "gain" }, { "value", 0.5 } }));
    CHECK (changed["type"].toString() == "PLUGIN_PARAMETER_CHANGED");
    CHECK_NEAR (static_cast<float> (changed["value"].toDouble()), 0.5f, 1e-6f);
    CHECK (errorAgainst (runChain (chain, signal), signal, 0.5f) < 1e-6f);

    // Out-of-range values are clamped to the plugin's range
    changed = host.handleCommand (command ({ { "type", "SET_PLUGIN_PARAMETER" }, { "slotId", lpiId },
                                             { "parameterIndex", 0 }, { "value", 9.0 } }));
    CHECK_NEAR (static_cast<float> (changed["value"].toDouble()), 2.0f, 1e-6f);

    // SET_VST_PARAMETER (trackIndex -1 = master): normalized 0.25 of 0..2 = 0.5
    changed = host.handleCommand (command ({ { "type", "SET_VST_PARAMETER" }, { "trackIndex", -1 },
                                             { "pluginName", "NoProd Test Gain" }, { "parameterIndex", 0 }, { "value", 0.25 } }));
    CHECK (changed["type"].toString() == "PLUGIN_PARAMETER_CHANGED");
    CHECK_NEAR (static_cast<float> (changed["value"].toDouble()), 0.5f, 1e-6f);

    section ("Plugin host: plugins load by id only, never by path");
    auto error = host.handleCommand (command ({ { "type", "LOAD_PLUGIN" }, { "path", LPI_TEST_GUI_PATH } }));
    CHECK (error["type"].toString() == "AUDIO_CORE_ERROR" && error["message"].toString().find ("never by path") != std::string::npos);
    error = host.handleCommand (command ({ { "type", "LOAD_PLUGIN" } }));
    CHECK (error["type"].toString() == "AUDIO_CORE_ERROR" && error["message"].toString().find ("pluginId") != std::string::npos);
    error = host.handleCommand (command ({ { "type", "LOAD_PLUGIN" }, { "pluginId", "com.noprod.nope" } }));
    CHECK (error["type"].toString() == "AUDIO_CORE_ERROR" && error["message"].toString().find ("scanned list") != std::string::npos);
    // A path beside a known id is ignored: the registry's path is what loads
    state = host.handleCommand (command ({ { "type", "LOAD_PLUGIN" }, { "pluginId", "com.noprod.test.gui" }, { "path", "/nowhere/evil.so" }, { "index", 0 } }));
    CHECK (state["type"].toString() == "AUDIO_CORE_STATE" && masterInserts (state).size() == 2);
    CHECK (masterInserts (state)[0]["path"].toString() == LPI_TEST_GUI_PATH);
    auto guiId = masterInserts (state)[0]["slotId"].toString();
    CHECK (masterInserts (host.getState()).size() == 2);

    section ("Plugin host: SCAN_PLUGINS ignores the client's folders and asks the scanner");
    int scansRequested = 0;
    host.requestScan = [&] { ++scansRequested; return true; };
    state = host.handleCommand (command ({ { "type", "SCAN_PLUGINS" }, { "paths", Json::array().push ("/tmp").push ("C:\\\\evil") } }));
    CHECK (state["type"].toString() == "AUDIO_CORE_STATE" && scansRequested == 1);
    CHECK (state["scanFolders"].size() == rig.registry.getScanFolders().size());
    for (auto& f : state["scanFolders"].elements())
        CHECK (f.toString() != "/tmp" && f.toString() != "C:\\evil");

    section ("Plugin host: bypass, move, remove, errors");
    state = host.handleCommand (command ({ { "type", "SET_PLUGIN_BYPASS" }, { "slotId", lpiId }, { "bypassed", true } }));
    CHECK (masterInserts (state)[1]["bypassed"].toBool());
    CHECK (errorAgainst (runChain (chain, signal), signal, 1.0f) < 1e-5f); // the gui gain is at 1

    state = host.handleCommand (command ({ { "type", "MOVE_PLUGIN" }, { "slotId", lpiId }, { "index", 0 } }));
    CHECK (masterInserts (state)[0]["slotId"].toString() == lpiId);

    state = host.handleCommand (command ({ { "type", "REMOVE_PLUGIN" }, { "slotId", guiId } }));
    CHECK (masterInserts (state).size() == 1);
    CHECK (masterInserts (state)[0]["slotId"].toString() == lpiId);

    error = host.handleCommand (command ({ { "type", "REMOVE_PLUGIN" }, { "slotId", "nope" } }));
    CHECK (error["type"].toString() == "AUDIO_CORE_ERROR");
    CHECK (error["request"].toString() == "REMOVE_PLUGIN");

    error = host.handleCommand (command ({ { "type", "SET_PLUGIN_PARAMETER" }, { "slotId", lpiId },
                                           { "parameterId", "nope" }, { "value", 1 } }));
    CHECK (error["type"].toString() == "AUDIO_CORE_ERROR");

    CHECK (host.handleCommand (command ({ { "type", "HAP_STREAM" } })).isNull());

    section ("Plugin host: device restart re-prepares inserts");
    chain.audioStopped();
    CHECK (host.setAudioFormat (44100.0, 256).empty());
    chain.audioStarted (44100.0);
    state = host.getState();
    CHECK (state["sampleRate"].toDouble() == 44100.0);
    CHECK (state["blockSize"].toInt() == PluginHost::minimumBlockSize);
    state = host.handleCommand (command ({ { "type", "SET_PLUGIN_BYPASS" }, { "slotId", lpiId }, { "bypassed", false } }));
    CHECK (errorAgainst (runChain (chain, signal), signal, 0.5f) < 1e-6f);
    chain.audioStopped();
}

void testBusStatePersists()
{
    section ("Bus state: inserts, bypass and parameters come back after a restart");
    auto dir = tempDir ("state");
    MessageLoop loop;
    HapAudioEngine engine;
    Mixer mixer (engine);
    PluginRegistry registry (dir);
    TestPlugins::registerAll (registry);
    {
        PluginHost host (mixer, loop, registry, dir / "state.json");
        host.handleCommand (command ({ { "type", "LOAD_PLUGIN" }, { "pluginId", "com.noprod.test.gain" } }));
        auto state = host.handleCommand (command ({ { "type", "LOAD_PLUGIN" }, { "pluginId", "com.noprod.test.gui.latency" }, { "bus", 3 } }));
        auto gainId = masterInserts (state)[0]["slotId"].toString(), latencyId = busInserts (state, 3)[0]["slotId"].toString();
        host.handleCommand (command ({ { "type", "SET_PLUGIN_PARAMETER" }, { "slotId", gainId }, { "parameterId", "gain" }, { "value", 0.75 } }));
        host.handleCommand (command ({ { "type", "SET_PLUGIN_BYPASS" }, { "slotId", gainId }, { "bypassed", true } }));
        host.handleCommand (command ({ { "type", "SET_PLUGIN_PARAMETER" }, { "slotId", latencyId }, { "parameterId", "lookahead" }, { "value", 100 } }));
        CHECK (! fileExists (dir / "state.json"));
        loop.runFor (1200); // the save timer
        CHECK (fileExists (dir / "state.json"));
        host.clearAllInserts();
    }
    {
        HapAudioEngine engine2;
        Mixer mixer2 (engine2);
        PluginHost reloaded (mixer2, loop, registry, dir / "state.json");
        auto what = reloaded.restoreState();
        CHECK (what.find ("2 inserts restored") != std::string::npos);
        auto state = reloaded.getState();
        CHECK (masterInserts (state).size() == 1 && masterInserts (state)[0]["pluginId"].toString() == "com.noprod.test.gain");
        CHECK (masterInserts (state)[0]["bypassed"].toBool());
        CHECK_NEAR (static_cast<float> (masterInserts (state)[0]["parameters"][0]["value"].toDouble()), 0.75f, 1e-6f);
        CHECK (busInserts (state, 3).size() == 1 && busInserts (state, 3)[0]["latencySamples"].toInt() == 100);
        reloaded.clearAllInserts();
    }
    {
        // A plugin that disappeared from the registry is reported, the rest restored
        registry.replace ({ registry.getPlugins()[0] }, {});
        HapAudioEngine engine3;
        Mixer mixer3 (engine3);
        PluginHost reloaded (mixer3, loop, registry, dir / "state.json");
        auto what = reloaded.restoreState();
        CHECK (what.find ("1 insert restored, 1 missing") != std::string::npos);
        reloaded.clearAllInserts();
    }

    section ("Bus state: a plugin's own state (what no parameter sets) comes back after a restart");
    {
        HapAudioEngine engine4;
        Mixer mixer4 (engine4);
        PluginHost host (mixer4, loop, registry, dir / "state.json");
        auto state = host.handleCommand (command ({ { "type", "LOAD_PLUGIN" }, { "pluginId", "com.noprod.test.gain" } }));
        auto gainId = masterInserts (state)[0]["slotId"].toString();
        auto& processor = *mixer4.getMasterChain().getSlots().front().processor;
        CHECK (processor.setState (lpiGainState (0.25f, 0.0f, "verse")));
        CHECK_NEAR (processor.getParameterValue (0), 0.25f, 1e-6f); // the host's values follow the state
        host.handleCommand (command ({ { "type", "SET_PLUGIN_PARAMETER" }, { "slotId", gainId }, { "parameterId", "mute" }, { "value", 1 } }));
        loop.runFor (1200);
        std::string text;
        CHECK (readFile (dir / "state.json", text));
        auto saved = Json::parse (text);
        std::vector<uint8_t> chunk;
        CHECK (saved && base64Decode (savedChunk (*saved, "master"), chunk) && chunk == lpiGainState (0.25f, 1.0f, "verse"));
        host.clearAllInserts();
    }
    {
        HapAudioEngine engine5;
        Mixer mixer5 (engine5);
        PluginHost reloaded (mixer5, loop, registry, dir / "state.json");
        CHECK (reloaded.restoreState().find ("1 insert restored") != std::string::npos);
        auto& processor = *mixer5.getMasterChain().getSlots().front().processor;
        CHECK (stateText (processor).find ("verse") != std::string::npos);
        CHECK_NEAR (processor.getParameterValue (0), 0.25f, 1e-6f);
        CHECK_NEAR (processor.getParameterValue (1), 1.0f, 1e-6f);
        reloaded.clearAllInserts();
    }
    {
        // A chunk that isn't base64 (a damaged file) is reported; the insert
        // still comes back, with its parameter values
        std::string text;
        CHECK (readFile (dir / "state.json", text));
        auto saved = Json::parse (text);
        saved->member ("buses").element (0).member ("inserts").element (0).set ("state", "***");
        CHECK (writeFile (dir / "state.json", saved->dump (2)));
        HapAudioEngine engine6;
        Mixer mixer6 (engine6);
        PluginHost reloaded (mixer6, loop, registry, dir / "state.json");
        CHECK (reloaded.restoreState().find ("1 insert restored") != std::string::npos);
        auto& processor = *mixer6.getMasterChain().getSlots().front().processor;
        CHECK (stateText (processor).find ("verse") == std::string::npos);
        CHECK_NEAR (processor.getParameterValue (0), 0.25f, 1e-6f);
        reloaded.clearAllInserts();
    }
    fs::remove_all (dir);
}

void testTrackBuses()
{
    section ("Track buses: inserts on a track only affect that track");
    Rig rig;
    auto& host = rig.host;
    auto& engine = rig.engine;
    auto& mixer = rig.mixer;
    mixer.start (PluginHost::defaultSampleRate, 512);

    auto render = [&] (int samples)
    {
        AudioBuffer out (2, samples);
        mixer.renderBlock (out.getArrayOfWritePointers(), 2, samples);
        return out.getMagnitude (0, samples);
    };

    engine.scheduleHaps (haps ({ { "a4", 3 } }));
    auto dryPeak = render (2048);
    CHECK (dryPeak > 0.05f);

    auto state = host.handleCommand (command ({ { "type", "LOAD_PLUGIN" }, { "pluginId", "com.noprod.test.gain" }, { "bus", 2 } }));
    CHECK (state["type"].toString() == "AUDIO_CORE_STATE");
    CHECK (state["trackCount"].toInt() == Mixer::numTracks);
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
    state = host.handleCommand (command ({ { "type", "LOAD_PLUGIN" }, { "pluginId", "com.noprod.test.gain" }, { "bus", "master" } }));
    auto masterId = masterInserts (state)[0]["slotId"].toString();
    host.handleCommand (command ({ { "type", "SET_PLUGIN_PARAMETER" }, { "slotId", masterId }, { "parameterId", "gain" }, { "value", 0.25 } }));
    engine.scheduleHaps (haps ({ { "a4", 3 } }));
    CHECK_NEAR (render (2048), 0.25f * dryPeak, 1e-4f);

    section ("Track buses: commands address buses and slots");
    state = host.handleCommand (command ({ { "type", "LOAD_PLUGIN" }, { "pluginId", "com.noprod.test.gain" }, { "bus", "7" } }));
    CHECK (busInserts (state, 7).size() == 1);
    for (auto bad : { Json (99), Json (-1), Json ("nope") })
    {
        auto error = host.handleCommand (command ({ { "type", "LOAD_PLUGIN" }, { "pluginId", "com.noprod.test.gain" }, { "bus", bad } }));
        CHECK (error["type"].toString() == "AUDIO_CORE_ERROR");
    }

    // SET_VST_PARAMETER's trackIndex picks the bus: 0.75 of 0..2 = 1.5
    host.handleCommand (command ({ { "type", "SET_PLUGIN_PARAMETER" }, { "slotId", slotId }, { "parameterId", "mute" }, { "value", 0 } }));
    auto changed = host.handleCommand (command ({ { "type", "SET_VST_PARAMETER" }, { "trackIndex", 2 }, { "pluginName", "NoProd Test Gain" },
                                                  { "parameterIndex", 0 }, { "value", 0.75 } }));
    CHECK (changed["type"].toString() == "PLUGIN_PARAMETER_CHANGED" && changed["slotId"].toString() == slotId);
    CHECK_NEAR (static_cast<float> (changed["value"].toDouble()), 1.5f, 1e-6f);
    auto error = host.handleCommand (command ({ { "type", "SET_VST_PARAMETER" }, { "trackIndex", 5 }, { "pluginName", "NoProd Test Gain" },
                                                { "parameterIndex", 0 }, { "value", 0.5 } }));
    CHECK (error["type"].toString() == "AUDIO_CORE_ERROR" && error["message"].toString().find ("track 5") != std::string::npos);

    // Slot ids work across buses: remove the track 2 insert without naming its bus
    state = host.handleCommand (command ({ { "type", "REMOVE_PLUGIN" }, { "slotId", slotId } }));
    CHECK (busInserts (state, 2).isNull()); // empty track buses aren't listed
    CHECK (busInserts (state, 7).size() == 1 && masterInserts (state).size() == 1);

    mixer.stop();
}

// One stream audio message: header + planar samples (see TrackStreams.h)
std::vector<uint8_t> streamFrame (uint32_t seq, const AudioBuffer& audio)
{
    auto frames = static_cast<uint32_t> (audio.getNumSamples()), channels = static_cast<uint32_t> (audio.getNumChannels());
    std::vector<uint8_t> data (TrackStream::headerBytes + frames * channels * sizeof (float));
    uint32_t header[4] { seq, frames, channels, 0 };
    std::memcpy (data.data(), header, sizeof (header));
    for (uint32_t ch = 0; ch < channels; ++ch)
        std::memcpy (data.data() + TrackStream::headerBytes + ch * frames * sizeof (float), audio.getReadPointer (static_cast<int> (ch)), frames * sizeof (float));
    return data;
}

AudioBuffer streamAudio (const std::vector<uint8_t>& data, int channels, int frames)
{
    AudioBuffer audio (channels, frames);
    for (int ch = 0; ch < channels; ++ch)
        std::memcpy (audio.getWritePointer (ch), data.data() + TrackStream::headerBytes + static_cast<size_t> (ch * frames) * sizeof (float), static_cast<size_t> (frames) * sizeof (float));
    return audio;
}

void testTrackStreams()
{
    section ("Track streams: a browser track's audio runs through its stream's plugin");
    Rig rig;
    auto& host = rig.host;

    auto stream = std::make_shared<TrackStream>();
    stream->id = "device-1";
    stream->sampleRate = 44100.0;
    stream->maxBlockSize = 256;
    std::vector<std::string> errors;
    stream->chain.prepare (stream->sampleRate, stream->maxBlockSize, errors);
    stream->chain.audioStarted (stream->sampleRate);
    host.registerStream (stream);

    auto signal = makeSignal (256);
    auto frame = streamFrame (7, signal);
    CHECK (stream->processFrame (frame.data(), frame.size()));   // no plugin yet: unchanged
    CHECK (errorAgainst (streamAudio (frame, 2, 256), signal, 1.0f) < 1e-6f);

    // LOAD with saved parameter values (by parameter id); the path a browser
    // device still carries is ignored
    auto state = host.handleStreamCommand (*stream, command ({ { "type", "LOAD" }, { "pluginId", "com.noprod.test.gain" }, { "path", "/nowhere" },
                                                                { "parameters", Json::object ({ { "gain", 0.5 } }) } }));
    CHECK (state["type"].toString() == "STREAM_STATE");
    CHECK (state["insert"]["name"].toString() == "NoProd Test Gain");
    CHECK_NEAR (static_cast<float> (state["insert"]["parameters"][0]["value"].toDouble()), 0.5f, 1e-6f);

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

    section ("Track streams: a project's state chunk loads with the plugin and comes back for saving");
    auto chunk = lpiGainState (0.25f, 0.0f, "verse");
    state = host.handleStreamCommand (*stream, command ({ { "type", "LOAD" }, { "pluginId", "com.noprod.test.gain" },
                                                           { "state", base64Encode (chunk.data(), chunk.size()) }, { "parameters", Json::object ({ { "mute", 1 } }) } }));
    CHECK (state["type"].toString() == "STREAM_STATE");
    CHECK_NEAR (static_cast<float> (state["insert"]["parameters"][0]["value"].toDouble()), 0.25f, 1e-6f); // from the state
    CHECK_NEAR (static_cast<float> (state["insert"]["parameters"][1]["value"].toDouble()), 1.0f, 1e-6f);  // the values apply after it
    auto got = host.handleStreamCommand (*stream, command ({ { "type", "GET_PLUGIN_STATE" } }));
    std::vector<uint8_t> back;
    CHECK (got["type"].toString() == "STREAM_PLUGIN_STATE" && got["streamId"].toString() == "device-1");
    CHECK (base64Decode (got["state"].toString(), back) && back == lpiGainState (0.25f, 1.0f, "verse"));

    // Refused, the loaded plugin kept: a chunk that isn't base64, isn't a
    // string, or is more than the limit
    for (auto& bad : { Json ("***"), Json (42), Json (std::string (3 * 1024 * 1024, 'A')) })
    {
        auto refused = host.handleStreamCommand (*stream, command ({ { "type", "LOAD" }, { "pluginId", "com.noprod.test.gain" }, { "state", bad } }));
        CHECK (refused["type"].toString() == "AUDIO_CORE_ERROR" && refused["message"].toString().rfind ("state: ", 0) == 0);
    }
    CHECK (host.getState()["streams"][0]["inserts"].size() == 1);
    got = host.handleStreamCommand (*stream, command ({ { "type", "GET_PLUGIN_STATE" } }));
    CHECK (base64Decode (got["state"].toString(), back) && back == lpiGainState (0.25f, 1.0f, "verse"));

    section ("Track streams: state, errors, unload and close");
    auto all = host.getState();
    CHECK (all["streams"].size() == 1 && all["streams"][0]["streamId"].toString() == "device-1");
    auto error = host.handleStreamCommand (*stream, command ({ { "type", "LOAD" }, { "path", "/nope.so" } }));
    CHECK (error["type"].toString() == "AUDIO_CORE_ERROR" && error["request"].toString() == "STREAM_LOAD");
    error = host.handleStreamCommand (*stream, command ({ { "type", "LOAD" }, { "pluginId", "com.noprod.nope" } }));
    CHECK (error["type"].toString() == "AUDIO_CORE_ERROR");
    CHECK (host.getState()["streams"][0]["inserts"].size() == 1); // a failed LOAD keeps the current plugin
    state = host.handleStreamCommand (*stream, command ({ { "type", "UNLOAD" } }));
    CHECK (state["insert"].isNull());
    error = host.handleStreamCommand (*stream, command ({ { "type", "GET_PLUGIN_STATE" } }));
    CHECK (error["type"].toString() == "AUDIO_CORE_ERROR");
    error = host.handleStreamCommand (*stream, command ({ { "type", "SET_PARAM" }, { "parameterIndex", 0 }, { "value", 1 } }));
    CHECK (error["type"].toString() == "AUDIO_CORE_ERROR");

    stream->chain.audioStopped();
    host.closeStream (stream);
    CHECK (host.getState()["streams"].size() == 0);
}

// One RGBA pixel of a frame, as 0xRRGGBB
uint32_t pixelAt (const std::vector<uint8_t>& rgba, int width, int x, int y)
{
    auto* p = &rgba[(static_cast<size_t> (y) * static_cast<size_t> (width) + static_cast<size_t> (x)) * 4];
    return (static_cast<uint32_t> (p[0]) << 16) | (static_cast<uint32_t> (p[1]) << 8) | p[2];
}

constexpr uint32_t editorBackground = 0x181c28, editorBar = 0x3b82f6, editorMarker = 0xffffff;

// The test plugin's editor (tests/plugins/lpi_test_gui.cpp) is 200x150
// logical pixels: a bar as tall as the gain (full height at 2.0), and a
// white square where the mouse last was. Dragging up 1 logical pixel adds
// 0.02 to the gain.
void testEditors()
{
    section ("Editors: an LPI plugin's off-screen editor");
    std::string error;
    auto guiLibrary = LpiLibrary::open (pathFromUtf8 (LPI_TEST_GUI_PATH), error);
    auto gainLibrary = LpiLibrary::open (pathFromUtf8 (LPI_TEST_GAIN_PATH), error);
    CHECK (guiLibrary != nullptr && gainLibrary != nullptr);
    if (guiLibrary == nullptr || gainLibrary == nullptr)
        return;

    MessageLoop loop;
    {
        LpiInsert plain (gainLibrary);
        CHECK (plain.prepare (rate, 256, error));
        CHECK (! plain.hasEditor());
        lpi_gui_offscreen_info info;
        CHECK (! plain.openEditor (1.0f, info, error));

        LpiInsert withGui (guiLibrary), other (guiLibrary);
        CHECK (withGui.prepare (rate, 256, error) && other.prepare (rate, 256, error));
        CHECK (withGui.hasEditor());
        CHECK (withGui.openEditor (1.0f, info, error));
        CHECK (info.logical_width == 200 && info.logical_height == 150 && info.physical_width == 200 && info.physical_height == 150);
        CHECK (! withGui.openEditor (1.0f, info, error));  // already open
        CHECK (! other.openEditor (1.0f, info, error));    // one per process

        std::vector<uint8_t> frame (200 * 150 * 4);
        CHECK (withGui.renderEditor (frame.data(), frame.size()));
        CHECK (pixelAt (frame, 200, 5, 5) == editorBackground);       // top-left origin
        CHECK (pixelAt (frame, 200, 100, 140) == editorBar);          // gain 1.0: the bottom half
        CHECK (pixelAt (frame, 200, 100, 60) == editorBackground);
        CHECK (! withGui.renderEditor (frame.data(), frame.size() - 1)); // buffer too small

        // A drag in the editor changes the parameter like set_parameter_value would
        withGui.editorMouse (LPI_MOUSE_DOWN, 100, 100);
        withGui.editorMouse (LPI_MOUSE_MOVE, 100, 90);
        withGui.editorMouse (LPI_MOUSE_UP, 100, 90);
        auto changed = withGui.takeParameterChanges(); // lpi.params.changes.v1: one gesture, begun and ended
        CHECK (changed.size() == 1 && changed[0].index == 0 && changed[0].gestureBegin && changed[0].gestureEnd);
        CHECK_NEAR (withGui.getParameterValue (0), 1.2f, 1e-5f);
        CHECK (withGui.takeParameterChanges().empty());

        // ...while this host's own writes aren't reported back as changes
        withGui.setParameterValue (0, 0.25f);
        CHECK (withGui.takeParameterChanges().empty());
        CHECK_NEAR (withGui.getParameterValue (0), 0.25f, 1e-6f);

        // Re-preparing recreates the instance: the editor closes, and the
        // parameter values carry over
        auto closedByPlugin = false;
        withGui.onEditorClosed = [&] { closedByPlugin = true; };
        CHECK (withGui.prepare (44100.0, 256, error));
        CHECK (closedByPlugin && ! withGui.isEditorOpen());
        CHECK_NEAR (withGui.getParameterValue (0), 0.25f, 1e-6f);
        CHECK (other.openEditor (1.0f, info, error)); // the process-wide slot is free again
        CHECK (withGui.getLatencySamples() == 0); // no lpi.latency.v1

        // A busy control thread: the frame times out, and the next one isn't
        // queued behind it (it fails straight away) until the first has run
        auto session = std::make_shared<EditorSession> ("editor-test", "slot-test", other, info);
        LpiEditorSource busySource (session, loop, 50);
        auto first = true, second = true;
        double secondMs = 0;
        std::thread renderer ([&]
        {
            first = busySource.render (frame.data());
            auto t0 = monotonicMs();
            second = busySource.render (frame.data());
            secondMs = monotonicMs() - t0;
        });
        renderer.join(); // this (the control) thread dispatched nothing meanwhile
        CHECK (! first && ! second && secondMs < 25.0);
        loop.runFor (20);
        std::atomic<bool> done { false };
        std::thread again ([&] { first = busySource.render (frame.data()); done = true; });
        loop.runUntil ([&] { return done.load(); }, 5000);
        again.join();
        CHECK (first && pixelAt (frame, 200, 100, 140) == editorBar);
        session->close();
        CHECK (! other.isEditorOpen() && busySource.isClosed());
    }

    section ("Editors: plugins without lpi.params.changes.v1 are polled");
    {
        auto pollingLibrary = LpiLibrary::open (pathFromUtf8 (LPI_TEST_GUI_POLLING_PATH), error);
        CHECK (pollingLibrary != nullptr);
        LpiInsert polled (pollingLibrary);
        lpi_gui_offscreen_info info;
        CHECK (polled.prepare (rate, 256, error) && polled.openEditor (1.0f, info, error));
        polled.editorMouse (LPI_MOUSE_DOWN, 100, 100);
        polled.editorMouse (LPI_MOUSE_MOVE, 100, 75); // 1.0 -> 1.5
        auto changed = polled.takeParameterChanges();
        CHECK (changed.size() == 1 && changed[0].index == 0 && ! changed[0].gestureBegin && ! changed[0].gestureEnd);
        CHECK_NEAR (polled.getParameterValue (0), 1.5f, 1e-5f);
        polled.editorMouse (LPI_MOUSE_UP, 100, 75);
        polled.setParameterValue (0, 0.75f);
        CHECK (polled.takeParameterChanges().empty()); // the host's own write
        polled.closeEditor();
    }

    section ("Editors: lpi.latency.v1");
    {
        auto latencyLibrary = LpiLibrary::open (pathFromUtf8 (LPI_TEST_GUI_LATENCY_PATH), error);
        CHECK (latencyLibrary != nullptr);
        LpiInsert delayed (latencyLibrary);
        CHECK (delayed.prepare (rate, 256, error));
        CHECK (delayed.getLatencySamples() == 64);
        AudioBuffer impulse (2, 256);
        impulse.setSample (0, 0, 1.0f);
        impulse.setSample (1, 0, 1.0f);
        auto out = runProcessor (delayed, impulse);
        CHECK (out.getSample (0, 64) == 1.0f && out.getSample (1, 64) == 1.0f && out.getSample (0, 0) == 0.0f); // it really is 64 samples late
        CHECK (delayed.prepare (44100.0, 256, error) && delayed.getLatencySamples() == 64); // read again per activation

        // A lookahead parameter moves it: re-read after the change
        CHECK (delayed.setParameterValue (4, 128.0f) && delayed.refreshLatency() && delayed.getLatencySamples() == 128);
        CHECK (! delayed.refreshLatency());
        out = runProcessor (delayed, impulse);
        CHECK (out.getSample (0, 128) == 1.0f && out.getSample (0, 64) == 0.0f);
    }

    section ("Editors: OPEN_EDITOR / CLOSE_EDITOR and the stream source; random editor ids");
    {
        Rig rig;
        auto& host = rig.host;
        auto& mixer = rig.mixer;
        auto& broadcasts = rig.broadcasts;

        auto state = host.handleCommand (command ({ { "type", "LOAD_PLUGIN" }, { "pluginId", "com.noprod.test.gui" } }));
        state = host.handleCommand (command ({ { "type", "LOAD_PLUGIN" }, { "pluginId", "com.noprod.test.gain" } }));
        auto guiSlot = masterInserts (state)[0], gainSlot = masterInserts (state)[1];
        CHECK (guiSlot["hasEditor"].toBool() && ! guiSlot["editorOpen"].toBool());
        CHECK (! gainSlot["hasEditor"].toBool());
        CHECK (guiSlot["latencySamples"].toInt() == 0);
        state = host.handleCommand (command ({ { "type", "LOAD_PLUGIN" }, { "pluginId", "com.noprod.test.gui.latency" }, { "bus", 7 } }));
        CHECK (busInserts (state, 7)[0]["latencySamples"].toInt() == 64);
        host.handleCommand (command ({ { "type", "REMOVE_PLUGIN" }, { "slotId", busInserts (state, 7)[0]["slotId"] } }));
        auto guiId = guiSlot["slotId"].toString();

        auto refused = host.handleCommand (command ({ { "type", "OPEN_EDITOR" }, { "slotId", gainSlot["slotId"] } }));
        CHECK (refused["type"].toString() == "AUDIO_CORE_ERROR");
        refused = host.handleCommand (command ({ { "type", "OPEN_EDITOR" }, { "slotId", "insert-999" } }));
        CHECK (refused["type"].toString() == "AUDIO_CORE_ERROR");

        auto opened = host.handleCommand (command ({ { "type", "OPEN_EDITOR" }, { "slotId", guiId } }));
        CHECK (opened["type"].toString() == "EDITOR_OPENED");
        CHECK (opened["slotId"].toString() == guiId && opened["name"].toString() == "NoProd Test GUI");
        CHECK (opened["width"].toInt() == 200 && opened["height"].toInt() == 150);
        CHECK (opened["port"].toInt() == 8085);
        auto editorId = opened["editorId"].toString();
        CHECK (editorId.size() == 7 + 16 && startsWith (editorId, "editor-") && containsOnly (editorId.substr (7), "0123456789abcdef")); // random, not sequential
        CHECK (masterInserts (host.getState())[0]["editorOpen"].toBool());
        // Asking again reports the same editor
        CHECK (host.handleCommand (command ({ { "type", "OPEN_EDITOR" }, { "slotId", guiId } }))["editorId"].toString() == editorId);

        CHECK (host.makeEditorSource ("editor-999") == nullptr);
        CHECK (host.makeEditorSource ("editor-1") == nullptr); // the old sequential ids guess nothing
        auto source = host.makeEditorSource (editorId);
        CHECK (source != nullptr);
        if (source == nullptr)
            return;
        CHECK (source->getWidth() == 200 && source->getHeight() == 150 && ! source->isClosed());

        // The stream renders and sends mouse input from its own threads;
        // the plugin only ever sees the control thread
        std::vector<uint8_t> frame (200 * 150 * 4);
        auto rendered = false;
        rig.offControlThread ([&]
        {
            source->mouse ("down", 100, 100, 1);
            source->mouse ("move", 100, 80, 1); // up 20 px: gain 1.0 -> 1.4
            source->mouse ("up", 100, 80, 0);
            source->mouse ("down", 100, 80, 2); // right button: LPI v1 ignores it
            source->mouse ("move", 100, 30, 2);
            rendered = source->render (frame.data());
        });
        CHECK (rendered);
        CHECK (pixelAt (frame, 200, 100, 150 - 100) == editorBar);           // the bar is 105 px tall now
        CHECK (pixelAt (frame, 200, 100, 150 - 110) == editorBackground);
        CHECK (pixelAt (frame, 200, 100, 30) == editorMarker);              // the last mouse position

        // The editor's change is announced, and the host's state follows it.
        // Changes are collected after every mouse event, so the drag's start
        // and its release arrive separately.
        CHECK (broadcasts.size() == 2);
        if (broadcasts.size() == 2)
        {
            CHECK (broadcasts[0]["type"].toString() == "PLUGIN_PARAMETER_CHANGED" && broadcasts[0]["slotId"].toString() == guiId);
            CHECK (broadcasts[0]["source"].toString() == "editor");
            CHECK (broadcasts[0]["parameterIndex"].toInt() == 0);
            CHECK_NEAR (static_cast<float> (broadcasts[0]["value"].toDouble()), 1.4f, 1e-5f);
            CHECK (broadcasts[0]["gestureBegin"].toBool() && ! broadcasts[0].has ("gestureEnd"));
            CHECK (broadcasts[1]["gestureEnd"].toBool() && ! broadcasts[1].has ("gestureBegin"));
            CHECK_NEAR (static_cast<float> (broadcasts[1]["value"].toDouble()), 1.4f, 1e-5f);
        }
        CHECK_NEAR (static_cast<float> (masterInserts (host.getState())[0]["parameters"][0]["value"].toDouble()), 1.4f, 1e-5f);

        auto signal = makeSignal (256);
        mixer.getMasterChain().audioStarted (rate);
        CHECK (errorAgainst (runChain (mixer.getMasterChain(), signal), signal, 1.4f) < 1e-5f);

        // lpi.h: GUI calls and parameter writes on one thread only
        auto* plugin = dynamic_cast<LpiInsert*> (mixer.getMasterChain().getSlots()[0].processor.get());
        CHECK (plugin->getParameterValue (1) == 0.0f); // guiThreadViolations, read-only: read live

        section ("Editors: closing");
        // Closing mid-drag still ends the gesture
        broadcasts.clear();
        rig.offControlThread ([&]
        {
            source->mouse ("down", 100, 50, 1);
            source->mouse ("move", 100, 45, 1);
            rendered = source->render (frame.data());
        });
        CHECK (broadcasts.size() == 1 && broadcasts[0]["gestureBegin"].toBool());
        auto closed = host.handleCommand (command ({ { "type", "CLOSE_EDITOR" } }));
        CHECK (closed["type"].toString() == "EDITOR_CLOSED" && closed["editorId"].toString() == editorId);
        CHECK (broadcasts.size() == 2 && broadcasts[1]["gestureEnd"].toBool());
        CHECK_NEAR (static_cast<float> (broadcasts[1]["value"].toDouble()), 1.5f, 1e-5f);
        CHECK (source->isClosed() && host.makeEditorSource (editorId) == nullptr);
        rig.offControlThread ([&] { rendered = source->render (frame.data()); });
        CHECK (! rendered);
        source.reset();

        // Removing the plugin closes its editor; a new editor gets a new id
        opened = host.handleCommand (command ({ { "type", "OPEN_EDITOR" }, { "slotId", guiId }, { "scale", 2.0 } }));
        CHECK (opened["width"].toInt() == 400 && opened["height"].toInt() == 300);
        CHECK (opened["editorId"].toString() != editorId);
        source = host.makeEditorSource (opened["editorId"].toString());
        CHECK (source != nullptr);
        host.handleCommand (command ({ { "type", "REMOVE_PLUGIN" }, { "slotId", guiId } }));
        CHECK (source->isClosed());
        source.reset();

        // So does re-preparing it for a new sample rate; opening another closes the last
        host.handleCommand (command ({ { "type", "LOAD_PLUGIN" }, { "pluginId", "com.noprod.test.gui" }, { "bus", 3 } }));
        state = host.handleCommand (command ({ { "type", "LOAD_PLUGIN" }, { "pluginId", "com.noprod.test.gui" }, { "bus", 4 } }));
        auto first = busInserts (state, 3)[0]["slotId"].toString(), second = busInserts (state, 4)[0]["slotId"].toString();
        opened = host.handleCommand (command ({ { "type", "OPEN_EDITOR" }, { "slotId", first } }));
        source = host.makeEditorSource (opened["editorId"].toString());
        CHECK (source != nullptr);
        mixer.getMasterChain().audioStopped();
        host.setAudioFormat (96000.0, 512);
        CHECK (source->isClosed());
        CHECK (! busInserts (host.getState(), 3)[0]["editorOpen"].toBool());
        opened = host.handleCommand (command ({ { "type", "OPEN_EDITOR" }, { "slotId", first } }));
        source = host.makeEditorSource (opened["editorId"].toString());
        opened = host.handleCommand (command ({ { "type", "OPEN_EDITOR" }, { "slotId", second } }));
        CHECK (opened["type"].toString() == "EDITOR_OPENED" && opened["slotId"].toString() == second);
        CHECK (source->isClosed());
        source.reset();

        section ("Editors: a track stream's plugin");
        auto stream = std::make_shared<TrackStream>();
        stream->id = "device-9";
        std::vector<std::string> errors;
        stream->chain.prepare (stream->sampleRate, stream->maxBlockSize, errors);
        std::vector<Json> sent;
        stream->sendToBrowser = [&] (const Json& m) { sent.push_back (m); };
        host.registerStream (stream);
        host.handleStreamCommand (*stream, command ({ { "type", "LOAD" }, { "pluginId", "com.noprod.test.gui" } }));
        opened = host.handleStreamCommand (*stream, command ({ { "type", "OPEN_EDITOR" } }));
        CHECK (opened["type"].toString() == "EDITOR_OPENED");
        source = host.makeEditorSource (opened["editorId"].toString());
        CHECK (source != nullptr && host.handleStreamCommand (*stream, command ({ { "type", "GET_STATE" } }))["insert"]["editorOpen"].toBool());
        broadcasts.clear();
        rig.offControlThread ([&]
        {
            source->mouse ("down", 10, 100, 1);
            source->mouse ("move", 10, 125, 1); // down 25 px: 1.0 -> 0.5
            rendered = source->render (frame.data());
        });
        CHECK (rendered && sent.size() == 1 && broadcasts.empty()); // to the stream's device, not everyone
        CHECK (sent[0]["type"].toString() == "PLUGIN_PARAMETER_CHANGED");
        CHECK_NEAR (static_cast<float> (sent[0]["value"].toDouble()), 0.5f, 1e-5f);
        // A stream that closes mid-drag lets go of the button, ending the gesture
        source.reset();
        rig.loop.runFor (20);
        CHECK (sent.size() == 2 && sent[1]["gestureEnd"].toBool());
        auto* streamPlugin = dynamic_cast<LpiInsert*> (stream->chain.getSlots()[0].processor.get());
        streamPlugin->editorMouse (LPI_MOUSE_MOVE, 10, 0);
        CHECK (streamPlugin->takeParameterChanges().empty());
        host.closeStream (stream);
        CHECK (host.handleCommand (command ({ { "type", "CLOSE_EDITOR" } }))["editorId"].isNull()); // already closed
    }
}

// The test plugin's editor takes keys (lpi.gui.keyboard.v1): with focus it
// draws a yellow border; digits and '.' then Enter set the gain. Its
// read-only parameters 2 and 3 are "keyboard focused" and "keyboard contract
// violations" (keys without focus, or a close while focused).
void testEditorKeyboard()
{
    section ("Editors: keyboard focus and keys (lpi.gui.keyboard.v1)");
    constexpr uint32_t focusBorder = 0xffd400;
    Rig rig;
    auto& host = rig.host;
    auto& mixer = rig.mixer;
    auto& broadcasts = rig.broadcasts;

    auto state = host.handleCommand (command ({ { "type", "LOAD_PLUGIN" }, { "pluginId", "com.noprod.test.gui" } }));
    auto slotId = masterInserts (state)[0]["slotId"];
    auto opened = host.handleCommand (command ({ { "type", "OPEN_EDITOR" }, { "slotId", slotId } }));
    CHECK (opened["keyboard"].toBool());
    auto* plugin = dynamic_cast<LpiInsert*> (mixer.getMasterChain().getSlots()[0].processor.get());
    auto focused = [&] { return plugin->getParameterValue (2) == 1.0f; };
    auto contractBroken = [&] { return plugin->getParameterValue (3) != 0.0f; };

    auto source = host.makeEditorSource (opened["editorId"].toString());
    std::vector<uint8_t> frame (200 * 150 * 4);
    auto typeKeys = [&] (const char* text)
    {
        for (auto* c = text; *c != 0; ++c)
        {
            source->key ("down", *c == '.' ? static_cast<uint32_t> (LPI_VK_PERIOD) : static_cast<uint32_t> (*c), 0);
            source->key ("char", static_cast<uint32_t> (*c), 0);
            source->key ("up", *c == '.' ? static_cast<uint32_t> (LPI_VK_PERIOD) : static_cast<uint32_t> (*c), 0);
        }
    };

    // Without focus, keys go nowhere
    rig.offControlThread ([&]
    {
        typeKeys ("1.5");
        source->key ("down", LPI_VK_ENTER, 0);
        source->render (frame.data());
    });
    CHECK (! focused() && ! contractBroken() && broadcasts.empty());
    CHECK (pixelAt (frame, 200, 0, 0) != focusBorder);

    // With focus: typed digits then Enter set the gain, as one gesture
    rig.offControlThread ([&]
    {
        source->focus (true);
        typeKeys ("0.75");
        source->key ("down", LPI_VK_ENTER, 0);
        source->render (frame.data());
    });
    CHECK (focused() && pixelAt (frame, 200, 0, 0) == focusBorder && pixelAt (frame, 200, 199, 75) == focusBorder);
    CHECK (broadcasts.size() == 1);
    if (! broadcasts.empty())
    {
        CHECK_NEAR (static_cast<float> (broadcasts[0]["value"].toDouble()), 0.75f, 1e-6f);
        CHECK (broadcasts[0]["gestureBegin"].toBool() && broadcasts[0]["gestureEnd"].toBool());
    }
    CHECK_NEAR (plugin->getParameterValue (0), 0.75f, 1e-6f);

    // Escape drops what was typed; so does losing focus
    rig.offControlThread ([&]
    {
        typeKeys ("1");
        source->key ("down", LPI_VK_ESCAPE, 0);
        source->key ("down", LPI_VK_ENTER, 0);
        typeKeys ("1");
        source->focus (false);
        source->focus (true);
        source->key ("down", LPI_VK_ENTER, 0);
        source->render (frame.data());
    });
    CHECK (broadcasts.size() == 1 && ! contractBroken());
    CHECK_NEAR (plugin->getParameterValue (0), 0.75f, 1e-6f);

    // Closing the editor while it has focus releases the keyboard first
    auto closed = host.handleCommand (command ({ { "type", "CLOSE_EDITOR" } }));
    CHECK (closed["type"].toString() == "EDITOR_CLOSED" && ! focused() && ! contractBroken());
    source.reset();
    rig.loop.runFor (20);

    // A stream that drops while focused releases it too
    opened = host.handleCommand (command ({ { "type", "OPEN_EDITOR" }, { "slotId", slotId } }));
    source = host.makeEditorSource (opened["editorId"].toString());
    rig.offControlThread ([&] { source->focus (true); source->render (frame.data()); });
    CHECK (focused());
    source.reset();
    rig.loop.runFor (20);
    CHECK (! focused() && ! contractBroken());

    // ...and re-preparing the plugin (its editor closes) with focus held
    source = host.makeEditorSource (opened["editorId"].toString());
    rig.offControlThread ([&] { source->focus (true); source->render (frame.data()); });
    CHECK (focused());
    host.setAudioFormat (96000.0, 512);
    plugin = dynamic_cast<LpiInsert*> (mixer.getMasterChain().getSlots()[0].processor.get());
    CHECK (source->isClosed() && ! focused() && ! contractBroken());
    source.reset();
    rig.loop.runFor (20);
    CHECK (plugin->getParameterValue (1) == 0.0f); // and every call came from the GUI thread
}

// A plugin whose latency follows a parameter (lpi.latency.v1 re-read after
// each change): the new latency reaches whoever shows the insert
void testLatencyFollowsParameters()
{
    section ("Latency: a lookahead parameter's latency is republished");
    Rig rig;
    auto& host = rig.host;
    auto& broadcasts = rig.broadcasts;
    std::vector<Json> sent;

    // A browser track's plugin: the saved lookahead counts from LOAD, and a
    // change sends the stream a fresh STREAM_STATE
    auto stream = std::make_shared<TrackStream>();
    stream->id = "device-l";
    std::vector<std::string> errors;
    stream->chain.prepare (stream->sampleRate, stream->maxBlockSize, errors);
    stream->sendToBrowser = [&] (const Json& m) { sent.push_back (m); };
    host.registerStream (stream);
    auto state = host.handleStreamCommand (*stream, command ({ { "type", "LOAD" }, { "pluginId", "com.noprod.test.gui.latency" },
                                                                { "parameters", Json::object ({ { "lookahead", 32 } }) } }));
    CHECK (state["insert"]["latencySamples"].toInt() == 32);

    auto reply = host.handleStreamCommand (*stream, command ({ { "type", "SET_PARAM" }, { "parameterId", "lookahead" }, { "value", 100 } }));
    CHECK (reply["type"].toString() == "PLUGIN_PARAMETER_CHANGED");
    CHECK (sent.size() == 1 && sent[0]["type"].toString() == "STREAM_STATE" && sent[0]["insert"]["latencySamples"].toInt() == 100);
    host.handleStreamCommand (*stream, command ({ { "type", "SET_PARAM" }, { "parameterId", "gain" }, { "value", 0.5 } }));
    CHECK (sent.size() == 1); // no latency change, nothing extra

    // A bus insert: everyone gets the new AUDIO_CORE_STATE
    state = host.handleCommand (command ({ { "type", "LOAD_PLUGIN" }, { "pluginId", "com.noprod.test.gui.latency" }, { "bus", 2 } }));
    auto slotId = busInserts (state, 2)[0]["slotId"];
    CHECK (busInserts (state, 2)[0]["latencySamples"].toInt() == 64);
    host.handleCommand (command ({ { "type", "SET_PLUGIN_PARAMETER" }, { "slotId", slotId }, { "parameterId", "lookahead" }, { "value", 200 } }));
    CHECK (broadcasts.size() == 1 && broadcasts[0]["type"].toString() == "AUDIO_CORE_STATE");
    CHECK (busInserts (broadcasts[0], 2)[0]["latencySamples"].toInt() == 200);

    host.closeStream (stream);
}

// A stream audio message carrying a transport block (TrackStreams.h)
std::vector<uint8_t> streamFrameWithTransport (uint32_t seq, const AudioBuffer& audio, double tempo, double ppq, uint32_t transportFlags)
{
    auto plain = streamFrame (seq, audio);
    std::vector<uint8_t> data (plain.size() + TrackStream::transportBytes);
    std::memcpy (data.data(), plain.data(), TrackStream::headerBytes);
    auto flags = TrackStream::hasTransport;
    std::memcpy (data.data() + 12, &flags, 4);
    std::memcpy (data.data() + 16, &tempo, 8);
    std::memcpy (data.data() + 24, &ppq, 8);
    std::memcpy (data.data() + 32, &transportFlags, 4);
    std::memcpy (data.data() + TrackStream::headerBytes + TrackStream::transportBytes, plain.data() + TrackStream::headerBytes,
                 plain.size() - TrackStream::headerBytes);
    return data;
}

// What the transport test plugin last got: tempo, position, flags, calls
std::array<float, 4> transportSeen (PluginHost& host, TrackStream& stream)
{
    auto params = host.handleStreamCommand (stream, command ({ { "type", "GET_STATE" } }))["insert"]["parameters"];
    return { static_cast<float> (findByName (params, "Transport tempo")["value"].toDouble()), static_cast<float> (findByName (params, "Transport position")["value"].toDouble()),
             static_cast<float> (findByName (params, "Transport flags")["value"].toDouble()), static_cast<float> (findByName (params, "Transport calls")["value"].toDouble()) };
}

void testTransport()
{
    section ("Transport: a stream block's transport reaches lpi.transport.v1");
    Rig rig;
    auto& host = rig.host;

    auto stream = std::make_shared<TrackStream>();
    stream->id = "device-t";
    stream->sampleRate = 48000.0;
    stream->maxBlockSize = 256;
    std::vector<std::string> errors;
    stream->chain.prepare (stream->sampleRate, stream->maxBlockSize, errors);
    stream->chain.audioStarted (stream->sampleRate);
    host.registerStream (stream);
    auto state = host.handleStreamCommand (*stream, command ({ { "type", "LOAD" }, { "pluginId", "com.noprod.test.gui.transport" } }));
    CHECK (state["insert"]["name"].toString() == "NoProd Test GUI (transport)");

    constexpr uint32_t playing = TransportInfo::playing, tempoValid = TransportInfo::tempoValid, ppqValid = TransportInfo::ppqValid;
    auto signal = makeSignal (256);
    auto frame = streamFrameWithTransport (3, signal, 120.0, 8.0, playing | tempoValid | ppqValid);
    CHECK (stream->processFrame (frame.data(), frame.size()));
    auto seen = transportSeen (host, *stream);
    CHECK (seen[0] == 120.0f && seen[1] == 8.0f && seen[2] == static_cast<float> (playing | tempoValid | ppqValid) && seen[3] == 1.0f);
    // The audio itself sits after the transport block, and goes back processed (gain 1)
    AudioBuffer back (2, 256);
    for (int ch = 0; ch < 2; ++ch)
        std::memcpy (back.getWritePointer (ch), frame.data() + TrackStream::headerBytes + TrackStream::transportBytes + static_cast<size_t> (ch) * 256 * sizeof (float), 256 * sizeof (float));
    CHECK (errorAgainst (back, signal, 1.0f) < 1e-6f);

    // A block bigger than the chain's runs in chunks, each told where it starts:
    // the last of 1000 frames starts 768 frames (0.032 quarter notes at 120 bpm) in
    auto big = makeSignal (1000);
    frame = streamFrameWithTransport (4, big, 120.0, 8.0, playing | tempoValid | ppqValid);
    CHECK (stream->processFrame (frame.data(), frame.size()));
    seen = transportSeen (host, *stream);
    CHECK_NEAR (seen[1], 8.032f, 1e-5f);
    CHECK (seen[3] == 5.0f);

    // Stopped: the position stays put
    frame = streamFrameWithTransport (5, big, 120.0, 8.0, tempoValid | ppqValid);
    stream->processFrame (frame.data(), frame.size());
    seen = transportSeen (host, *stream);
    CHECK (seen[1] == 8.0f && seen[2] == static_cast<float> (tempoValid | ppqValid));

    // A tempo that isn't one isn't passed on as valid
    frame = streamFrameWithTransport (6, signal, std::nan (""), 9.0, playing | tempoValid | ppqValid);
    stream->processFrame (frame.data(), frame.size());
    CHECK (transportSeen (host, *stream)[2] == static_cast<float> (playing | ppqValid));

    // Blocks without a transport (older senders) still work, and tell the plugin nothing
    auto calls = transportSeen (host, *stream)[3];
    auto plain = streamFrame (7, signal);
    CHECK (stream->processFrame (plain.data(), plain.size()));
    CHECK (transportSeen (host, *stream)[3] == calls);

    // A transport flag on a block too short to hold one is refused
    plain = streamFrame (8, signal);
    auto flagOnly = TrackStream::hasTransport;
    std::memcpy (plain.data() + 12, &flagOnly, 4);
    CHECK (! stream->processFrame (plain.data(), plain.size()));

    stream->chain.audioStopped();
    host.closeStream (stream);
}

void testScanner()
{
    section ("Scanner: a child process per binary; crashes and hangs are skipped and reported");
    auto dir = tempDir ("scan");
    auto worker = pathFromUtf8 (GHOSTDAW_EXE_PATH);
    CHECK (fileExists (worker));
    // tests/lpi/<variant>/ and tests/lpi_bad/<variant>/ (a multi-config build adds /Release/)
    auto pluginFolder = pathFromUtf8 (LPI_TEST_FOLDER), badFolder = pathFromUtf8 (LPI_TEST_BAD_FOLDER);
    MessageLoop loop;
    PluginRegistry registry (dir);
    CHECK (registry.addUserScanFolder (pluginFolder) && ! registry.addUserScanFolder (pluginFolder));
    CHECK (registry.addUserScanFolder (badFolder));
    CHECK (registry.getUserScanFolders().size() == 2 && registry.getScanFolders().size() == PluginRegistry::defaultScanFolders().size() + 2);

    // The candidates: every shared library there, and a .vst3 bundle as
    // one candidate, whatever is inside it
    createDirectories (pluginFolder / "Fake.vst3" / "Contents");
    writeFile (pluginFolder / "Fake.vst3" / "Contents" / ("inside" + std::string (sharedLibraryExtension)), "");
    auto candidates = PluginScanner::candidates ({ pluginFolder, badFolder });
    CHECK (candidates.size() == 10); // gain x3, gui x4, crash, hang, the bundle
    int bundles = 0;
    for (auto& c : candidates)
    {
        CHECK (pathToUtf8 (c).find ("inside") == std::string::npos);
        bundles += c.filename() == "Fake.vst3";
    }
    CHECK (bundles == 1);
    fs::remove_all (pluginFolder / "Fake.vst3");

    PluginScanner::Options options;
    options.worker = worker;
    options.timeoutMs = 3000;
    options.audioUnits = false; // (the system's units would be counted on macOS)
    PluginScanner scanner (registry, loop, options);
    std::string summary;
    auto t0 = monotonicMs();
    CHECK (scanner.start ([&] (const std::string& s) { summary = s; }));
    CHECK (! scanner.start (nullptr)); // one at a time
    CHECK (loop.runUntil ([&] { return ! summary.empty(); }, 60000));
    auto firstScanMs = monotonicMs() - t0;
    std::cout << "  first scan: " << summary << " in " << static_cast<int> (firstScanMs) << " ms" << std::endl;
    CHECK (summary.find ("5 plugins loaded") != std::string::npos && summary.find ("2 skipped") != std::string::npos);
    CHECK (firstScanMs >= 3000.0); // the hang ran into its limit

    auto plugins = registry.getPlugins();
    CHECK (plugins.size() == 5);
    std::set<std::string> ids;
    for (auto& p : plugins)
    {
        ids.insert (p.pluginId);
        CHECK (p.format == "LPI" && ! p.name.empty() && p.modified != 0); // (the file clock's epoch varies; only changes matter)
    }
    CHECK (ids.count ("com.noprod.test.gain") == 1 && ids.count ("com.noprod.test.gui.transport") == 1);
    auto skipped = registry.getSkipped();
    CHECK (skipped.size() == 2);
    // (under a sanitizer, the worker reports the crash and exits instead of
    // dying by the signal; the scanner skips it either way)
    auto crashedOrFailed = [] (const std::string& reason) { return reason.find ("crashed") != std::string::npos || reason.find ("worker failed") != std::string::npos; };
    for (auto& s : skipped)
    {
        auto isCrash = samePath (s.path, LPI_TEST_CRASH_PATH), isHang = samePath (s.path, LPI_TEST_HANG_PATH);
        CHECK (isCrash || isHang);
        CHECK (isCrash ? crashedOrFailed (s.reason) : s.reason.find ("hung") != std::string::npos);
    }
    KnownPlugin found;
    CHECK (registry.find ("com.noprod.test.gain", found) && samePath (found.path, LPI_TEST_GAIN_PATH));
    CHECK (! registry.find ("com.noprod.nope", found));

    section ("Scanner: the next scan keeps what it knows and skips what crashed, without loading them again");
    summary.clear();
    t0 = monotonicMs();
    CHECK (scanner.start ([&] (const std::string& s) { summary = s; }));
    CHECK (loop.runUntil ([&] { return ! summary.empty(); }, 60000));
    auto secondScanMs = monotonicMs() - t0;
    std::cout << "  second scan: " << summary << " in " << static_cast<int> (secondScanMs) << " ms" << std::endl;
    CHECK (summary.find ("0 plugins loaded, 5 kept") != std::string::npos && summary.find ("0 skipped") != std::string::npos);
    CHECK (secondScanMs < 3000.0); // the hang was not run again
    CHECK (registry.getSkipped().size() == 2 && registry.getPlugins().size() == 5);

    // All of it survives a restart (plugins.json)
    PluginRegistry again (dir);
    CHECK (again.getPlugins().size() == 5 && again.getSkipped().size() == 2 && again.getUserScanFolders().size() == 2);
    std::string pluginsJson;
    CHECK (readFile (dir / "plugins.json", pluginsJson) && crashedOrFailed (pluginsJson) && pluginsJson.find ("hung") != std::string::npos);

    section ("Scanner: the dead man's pedal blocklists a binary that took GhostDAW down mid-scan");
    writeFile (dir / "scanning.json", Json::object ({ { "path", LPI_TEST_GAIN_PATH }, { "modified", 1 } }).dump());
    PluginRegistry recovered (dir);
    CHECK (! fileExists (dir / "scanning.json"));
    auto skippedNow = recovered.getSkipped();
    CHECK (skippedNow.size() == 3);
    bool pedal = false;
    for (auto& s : skippedNow)
        pedal = pedal || (samePath (s.path, LPI_TEST_GAIN_PATH) && s.reason.find ("did not survive") != std::string::npos);
    CHECK (pedal);
    // ...until the binary changes: its real modification time differs from the one written down, so the next scan tries it again
    PluginScanner rescanner (recovered, loop, options);
    summary.clear();
    CHECK (rescanner.start ([&] (const std::string& s) { summary = s; }));
    CHECK (loop.runUntil ([&] { return ! summary.empty(); }, 60000));
    CHECK (recovered.getSkipped().size() == 2 && recovered.find ("com.noprod.test.gain", found));

    section ("Scanner: the worker's own answers");
    auto described = PluginScanner::describeFile (pathFromUtf8 (LPI_TEST_GUI_PATH));
    CHECK (described["plugins"].size() == 1 && described["plugins"][0]["pluginId"].toString() == "com.noprod.test.gui");
    CHECK (PluginScanner::describeFile (pathFromUtf8 (LPI_TEST_NO_EXPORT_PATH)).has ("error"));
    auto result = runChildProcess (worker, { "--scan-file", LPI_TEST_NO_EXPORT_PATH }, 10000);
    CHECK (result.started && result.exitCode == PluginScanner::notAPluginExitCode);
    result = runChildProcess (worker, { "--scan-file", LPI_TEST_GAIN_PATH }, 10000);
    CHECK (result.started && result.exitCode == 0 && result.output.find ("com.noprod.test.gain") != std::string::npos);
    result = runChildProcess (worker, { "--scan-file", LPI_TEST_CRASH_PATH }, 10000);
    CHECK (result.started && (result.crashed || result.exitCode != 0) && ! result.timedOut && result.exitCode != PluginScanner::notAPluginExitCode);
    result = runChildProcess (worker, { "--scan-file", LPI_TEST_HANG_PATH }, 1500);
    CHECK (result.started && result.timedOut && ! result.crashed);
    result = runChildProcess (dir / "no-such-program", {}, 1000);
    CHECK (! result.started && ! result.error.empty());
    result = runChildProcess (worker, { "--scan-au" }, 20000);
    auto auList = result.started && result.exitCode == 0 ? Json::parse (result.output) : std::nullopt;
    CHECK (auList && (*auList)["plugins"].isArray());

    fs::remove_all (dir);
}

// ------------------------------------------------------------------ VST 3

// Registers the two VST 3 test bundles the way a scan would, and returns
// their class ids
std::pair<std::string, std::string> registerVst3 (PluginRegistry& registry)
{
    auto known = registry.getPlugins();
    std::vector<std::string> ids;
    for (auto* path : { VST3_TEST_GAIN_PATH, VST3_TEST_GAIN_SEPARATE_PATH })
    {
        auto described = PluginScanner::describeFile (pathFromUtf8 (path));
        for (auto& p : described["plugins"].elements())
        {
            known.push_back ({ p["pluginId"].toString(), p["name"].toString(), p["vendor"].toString(), p["format"].toString(), path,
                               PluginRegistry::modificationTime (pathFromUtf8 (path)) });
            ids.push_back (p["pluginId"].toString());
        }
    }
    registry.replace (known, {});
    return { ids.size() > 0 ? ids[0] : "", ids.size() > 1 ? ids[1] : "" };
}

void testVst3()
{
    section ("VST3: a module's classes, and what is not a module");
    std::string error;
    auto module = Vst3Module::open (pathFromUtf8 (VST3_TEST_GAIN_PATH), error);
    CHECK (module != nullptr);
    if (module == nullptr)
    {
        std::cerr << "  " << error << std::endl;
        return;
    }
    CHECK (module->getAudioEffects().size() == 1);
    auto& effect = module->getAudioEffects()[0];
    CHECK (effect.name == "NoProd Test Gain" && effect.vendor == "NoProd" && effect.version == "1.0.0");
    CHECK (effect.classId.size() == 32 && containsOnly (effect.classId, "0123456789ABCDEF"));
    CHECK (effect.subCategories.find ("Fx") != std::string::npos);
    CHECK (fileExists (Vst3Module::binaryPathFor (pathFromUtf8 (VST3_TEST_GAIN_PATH))));

    auto separate = Vst3Module::open (pathFromUtf8 (VST3_TEST_GAIN_SEPARATE_PATH), error);
    CHECK (separate != nullptr && separate->getAudioEffects().size() == 1); // the controller class is not an effect
    CHECK (separate != nullptr && separate->getAudioEffects()[0].classId != effect.classId);

    CHECK (Vst3Module::open (pathFromUtf8 (LPI_TEST_GAIN_PATH), error) == nullptr && error.find ("GetPluginFactory") != std::string::npos);
    CHECK (Vst3Module::open (pathFromUtf8 (VST3_TEST_GAIN_PATH) / "nope.vst3", error) == nullptr && ! error.empty());
    CHECK (Vst3Insert::create (module, "00000000000000000000000000000000", error) == nullptr && error.find ("No audio effect") != std::string::npos);

    section ("VST3: an insert processes audio and takes parameter changes, with the plug-in's text");
    auto signal = makeSignal (512);
    for (auto& [bundle, name] : { std::pair<std::shared_ptr<Vst3Module>, const char*> { module, "NoProd Test Gain" },
                                  { separate, "NoProd Test Gain (separate controller)" } })
    {
        auto insert = Vst3Insert::create (bundle, bundle->getAudioEffects()[0].classId, error);
        CHECK (insert != nullptr);
        if (insert == nullptr)
        {
            std::cerr << "  " << error << std::endl;
            continue;
        }
        CHECK (insert->getName() == name && insert->getFormat() == "VST3" && insert->getPluginId() == bundle->getAudioEffects()[0].classId);
        CHECK (insert->getPath() == pathToUtf8 (bundle->getPath()));
        auto params = insert->getParameters();
        CHECK (params.size() == 2);
        CHECK (params[0].name == "Gain" && params[0].id == "0" && ! params[0].readOnly && params[0].defaultValue == 1.0f);
        CHECK (params[1].name == "Host tempo" && params[1].readOnly);
        CHECK (insert->prepare (rate, 512, error));
        CHECK (insert->getLatencySamples() == 0);
        CHECK (errorAgainst (runProcessor (*insert, signal), signal, 1.0f) < 1e-6f);

        CHECK (insert->setParameterValue (0, 0.5f));
        CHECK_NEAR (insert->getParameterValue (0), 0.5f, 1e-6f);
        CHECK (startsWith (insert->getParameterText (0), "0.5"));
        runProcessor (*insert, signal); // the change reaches the processor with the next block
        CHECK (errorAgainst (runProcessor (*insert, signal), signal, 0.5f) < 1e-6f);
        CHECK (! insert->setParameterValue (1, 0.3f)); // read-only
        CHECK (! insert->setParameterValue (7, 0.3f));

        // The transport reaches the plug-in's ProcessContext; it reports the
        // tempo back through its output parameter changes
        TransportInfo transport;
        transport.tempoBpm = 133.0;
        transport.ppqPosition = 4.0;
        transport.flags = TransportInfo::playing | TransportInfo::tempoValid | TransportInfo::ppqValid;
        insert->setTransport (transport);
        runProcessor (*insert, signal);
        runProcessor (*insert, signal);
        CHECK_NEAR (insert->getParameterValue (1), 0.133f, 1e-4f);

        // State round trip: the gain, as the component saves it, restored
        // in the controller and the processor both
        std::vector<uint8_t> state;
        CHECK (insert->getState (state) && state == vst3Chunk (floatBytes (0.5f)));
        CHECK (insert->setParameterValue (0, 0.25f));
        runProcessor (*insert, signal);
        CHECK (errorAgainst (runProcessor (*insert, signal), signal, 0.25f) < 1e-6f);
        CHECK (insert->setState (state));
        CHECK_NEAR (insert->getParameterValue (0), 0.5f, 1e-6f);
        CHECK (errorAgainst (runProcessor (*insert, signal), signal, 0.5f) < 1e-6f);

        // Re-prepared at another rate, it still works
        CHECK (insert->prepare (44100.0, 256, error));
        auto shorter = makeSignal (256);
        runProcessor (*insert, shorter);
        CHECK (errorAgainst (runProcessor (*insert, shorter), shorter, 0.5f) < 1e-6f);
    }

    section ("VST3: a plug-in edits from its own thread while the control thread changes parameters");
    {
        // (the single-class test plug-in, told to by a state no parameter can
        // produce, performEdits its gain 2000 times from a thread of its own
        // and then reports 1.0 as the host tempo; the two producers must not
        // share a ring, which TSan sees)
        auto insert = Vst3Insert::create (module, module->getAudioEffects()[0].classId, error);
        CHECK (insert != nullptr && insert->prepare (rate, 64, error));
        if (insert != nullptr)
        {
            auto block = makeSignal (64);
            std::atomic<bool> stop { false };
            std::thread audio ([&] { while (! stop.load()) runProcessor (*insert, block); });
            CHECK (insert->setState (vst3Chunk (floatBytes (-1.0f))));
            auto allSet = true;
            for (int i = 0; i < 2000; ++i)
                allSet = insert->setParameterValue (0, static_cast<float> (i % 10) / 10.0f) && allSet;
            CHECK (allSet);
            for (int waited = 0; insert->getParameterValue (1) != 1.0f && waited < 500; ++waited)
                sleepMs (10);
            CHECK (insert->getParameterValue (1) == 1.0f);
            stop = true;
            audio.join();
            runProcessor (*insert, block); // whatever either thread left is drained
            CHECK (insert->setParameterValue (0, 0.75f));
            runProcessor (*insert, block);
            CHECK (errorAgainst (runProcessor (*insert, block), block, 0.75f) < 1e-6f);
        }
    }

    section ("VST3: through the host, by id, in a chain with an LPI insert");
    Rig rig;
    auto [gainId, separateId] = registerVst3 (rig.registry);
    CHECK (gainId == effect.classId && ! separateId.empty());
    auto& host = rig.host;
    auto& chain = rig.mixer.getMasterChain();
    chain.audioStarted (PluginHost::defaultSampleRate);
    auto state = host.getState();
    CHECK (state["availablePlugins"].size() == 7);
    CHECK (findByName (state["availablePlugins"], "NoProd Test Gain (separate controller)")["format"].toString() == "VST3");

    state = host.handleCommand (command ({ { "type", "LOAD_PLUGIN" }, { "pluginId", "com.noprod.test.gain" } }));
    auto lpiId = masterInserts (state)[0]["slotId"].toString();
    host.handleCommand (command ({ { "type", "SET_PLUGIN_PARAMETER" }, { "slotId", lpiId }, { "parameterId", "gain" }, { "value", 0.5 } }));
    state = host.handleCommand (command ({ { "type", "LOAD_PLUGIN" }, { "pluginId", gainId }, { "index", 0 } }));
    CHECK (state["type"].toString() == "AUDIO_CORE_STATE" && masterInserts (state).size() == 2);
    if (masterInserts (state).size() != 2)
    {
        std::cerr << "  " << state["message"].toString() << std::endl;
        return;
    }
    auto vst3Slot = masterInserts (state)[0];
    CHECK (vst3Slot["format"].toString() == "VST3" && vst3Slot["name"].toString() == "NoProd Test Gain" && vst3Slot["pluginId"].toString() == gainId);
    CHECK (vst3Slot["path"].toString() == VST3_TEST_GAIN_PATH);
    auto gainParam = findByName (vst3Slot["parameters"], "Gain");
    CHECK (! gainParam.isNull() && gainParam["id"].toString() == "0");
    CHECK (findByName (vst3Slot["parameters"], "Host tempo")["readOnly"].toBool());
    auto vst3Id = vst3Slot["slotId"].toString();

    // VST3 at unity, LPI at 0.5
    CHECK (errorAgainst (runChain (chain, signal), signal, 0.5f) < 1e-5f);
    auto changed = host.handleCommand (command ({ { "type", "SET_PLUGIN_PARAMETER" }, { "slotId", vst3Id },
                                                  { "parameterIndex", gainParam["index"].toInt() }, { "value", 0.5 } }));
    CHECK (changed["type"].toString() == "PLUGIN_PARAMETER_CHANGED");
    CHECK (startsWith (changed["text"].toString(), "0.5"));
    runChain (chain, signal); // VST3 parameter changes arrive with the next block
    CHECK (errorAgainst (runChain (chain, signal), signal, 0.25f) < 1e-5f);

    // A second instance of the same module, and the other bundle, on a track bus
    state = host.handleCommand (command ({ { "type", "LOAD_PLUGIN" }, { "pluginId", gainId }, { "bus", 2 } }));
    state = host.handleCommand (command ({ { "type", "LOAD_PLUGIN" }, { "pluginId", separateId }, { "bus", 2 } }));
    CHECK (busInserts (state, 2).size() == 2 && busInserts (state, 2)[1]["name"].toString() == "NoProd Test Gain (separate controller)");

    state = host.handleCommand (command ({ { "type", "REMOVE_PLUGIN" }, { "slotId", vst3Id } }));
    CHECK (masterInserts (state).size() == 1 && masterInserts (state)[0]["slotId"].toString() == lpiId);
    chain.audioStopped();

    section ("VST3: a track stream's transport reaches the plug-in's ProcessContext");
    auto stream = std::make_shared<TrackStream>();
    stream->id = "device-v";
    stream->sampleRate = 48000.0;
    stream->maxBlockSize = 256;
    std::vector<std::string> errors;
    stream->chain.prepare (stream->sampleRate, stream->maxBlockSize, errors);
    stream->chain.audioStarted (stream->sampleRate);
    host.registerStream (stream);
    state = host.handleStreamCommand (*stream, command ({ { "type", "LOAD" }, { "pluginId", separateId } }));
    CHECK (state["insert"]["format"].toString() == "VST3");
    constexpr uint32_t playing = TransportInfo::playing, tempoValid = TransportInfo::tempoValid, ppqValid = TransportInfo::ppqValid;
    auto block = makeSignal (256);
    for (int i = 0; i < 3; ++i) // the plug-in's answer reaches the host with the following block
    {
        auto frame = streamFrameWithTransport (static_cast<uint32_t> (10 + i), block, 133.0, 0.0, playing | tempoValid | ppqValid);
        stream->processFrame (frame.data(), frame.size());
    }
    auto hostTempo = findByName (host.handleStreamCommand (*stream, command ({ { "type", "GET_STATE" } }))["insert"]["parameters"], "Host tempo");
    CHECK_NEAR (static_cast<float> (hostTempo["value"].toDouble()), 0.133f, 1e-4f);
    stream->chain.audioStopped();
    host.closeStream (stream);

    section ("VST3: bus state comes back after a restart, by class id");
    {
        auto dir = tempDir ("vst3state");
        MessageLoop loop;
        HapAudioEngine engine;
        Mixer mixer (engine);
        PluginRegistry registry (dir);
        TestPlugins::registerAll (registry);
        registerVst3 (registry);
        {
            PluginHost saver (mixer, loop, registry, dir / "state.json");
            auto s = saver.handleCommand (command ({ { "type", "LOAD_PLUGIN" }, { "pluginId", gainId } }));
            auto slotId = masterInserts (s)[0]["slotId"].toString();
            saver.handleCommand (command ({ { "type", "SET_PLUGIN_PARAMETER" }, { "slotId", slotId }, { "parameterId", "0" }, { "value", 0.75 } }));
            // The plug-ins' own state too: the preset name the component keeps,
            // and the separate controller's note
            CHECK (mixer.getMasterChain().getSlots().front().processor->setState (vst3Chunk (floatBytes (0.75f) + "verse")));
            s = saver.handleCommand (command ({ { "type", "LOAD_PLUGIN" }, { "pluginId", separateId }, { "bus", 1 } }));
            CHECK (busInserts (s, 1).size() == 1);
            CHECK (mixer.getTrackChain (1).getSlots().front().processor->setState (vst3Chunk (floatBytes (0.5f) + "chorus", floatBytes (0.0f) + "dark")));
            CHECK (stateText (*mixer.getTrackChain (1).getSlots().front().processor) == textOf (vst3Chunk (floatBytes (0.5f) + "chorus", floatBytes (0.0f) + "dark")));
            saver.handleCommand (command ({ { "type", "SET_PLUGIN_BYPASS" }, { "slotId", busInserts (s, 1)[0]["slotId"].toString() }, { "bypassed", false } }));
            loop.runFor (1200);
            CHECK (fileExists (dir / "state.json"));
            saver.clearAllInserts();
        }
        HapAudioEngine engine2;
        Mixer mixer2 (engine2);
        PluginHost reloaded (mixer2, loop, registry, dir / "state.json");
        CHECK (reloaded.restoreState().find ("2 inserts restored") != std::string::npos);
        auto s = reloaded.getState();
        CHECK (masterInserts (s).size() == 1 && masterInserts (s)[0]["pluginId"].toString() == gainId);
        CHECK_NEAR (static_cast<float> (findByName (masterInserts (s)[0]["parameters"], "Gain")["value"].toDouble()), 0.75f, 1e-6f);
        CHECK (stateText (*mixer2.getMasterChain().getSlots().front().processor) == textOf (vst3Chunk (floatBytes (0.75f) + "verse")));
        CHECK (busInserts (s, 1).size() == 1 && busInserts (s, 1)[0]["pluginId"].toString() == separateId);
        CHECK (stateText (*mixer2.getTrackChain (1).getSlots().front().processor) == textOf (vst3Chunk (floatBytes (0.5f) + "chorus", floatBytes (0.0f) + "dark")));
        CHECK_NEAR (static_cast<float> (findByName (busInserts (s, 1)[0]["parameters"], "Gain")["value"].toDouble()), 0.5f, 1e-6f);
        reloaded.clearAllInserts();
        fs::remove_all (dir);
    }

    section ("VST3: the scan finds bundles, in the worker");
    {
        auto dir = tempDir ("vst3scan");
        auto vst3Folder = pathFromUtf8 (VST3_TEST_GAIN_PATH).parent_path();
        MessageLoop loop;
        PluginRegistry registry (dir);
        CHECK (registry.addUserScanFolder (vst3Folder));
        auto candidates = PluginScanner::candidates ({ vst3Folder });
        CHECK (candidates.size() == 2);
        // A symlink to a bundle, named like it (how the VST3 SDK installs
        // what it builds), is a candidate, and is described through the link
        auto linked = dir / pathFromUtf8 (VST3_TEST_GAIN_PATH).filename();
        std::error_code linkError;
        fs::create_directory_symlink (pathFromUtf8 (VST3_TEST_GAIN_PATH), linked, linkError);
        if (! linkError)
        {
            auto withLink = PluginScanner::candidates ({ dir });
            CHECK (withLink.size() == 1 && withLink[0] == linked);
            auto described = PluginScanner::describeFile (linked);
            CHECK (described["plugins"].size() == 1 && described["plugins"][0]["format"].toString() == "VST3");
            fs::remove (linked);
        }
        PluginScanner::Options options;
        options.worker = pathFromUtf8 (GHOSTDAW_EXE_PATH);
        options.timeoutMs = 20000;
        options.audioUnits = false; // (the system's units would be counted on macOS)
        PluginScanner scanner (registry, loop, options);
        std::string summary;
        CHECK (scanner.start ([&] (const std::string& s) { summary = s; }));
        CHECK (loop.runUntil ([&] { return ! summary.empty(); }, 60000));
        std::cout << "  " << summary << std::endl;
        CHECK (summary.find ("2 plugins loaded") != std::string::npos && summary.find ("0 skipped") != std::string::npos);
        int vst3Found = 0;
        for (auto& p : registry.getPlugins())
            vst3Found += p.format == "VST3" && p.vendor == "NoProd" && p.pluginId.size() == 32;
        CHECK (vst3Found == 2);
        KnownPlugin found;
        CHECK (registry.find (separateId, found) && samePath (found.path, VST3_TEST_GAIN_SEPARATE_PATH));

        auto result = runChildProcess (options.worker, { "--scan-file", VST3_TEST_GAIN_PATH }, 20000);
        CHECK (result.started && result.exitCode == 0 && result.output.find (gainId) != std::string::npos);
        fs::remove_all (dir);
    }
}

// ------------------------------------------------------------ Audio Units

#if GHOSTDAW_MAC
// The preset name in a unit's class info (its state as AuInsert saves it)
std::string auPresetName (const std::vector<uint8_t>& plistBytes)
{
    auto* data = CFDataCreate (kCFAllocatorDefault, plistBytes.data(), static_cast<CFIndex> (plistBytes.size()));
    auto plist = CFPropertyListCreateWithData (kCFAllocatorDefault, data, kCFPropertyListImmutable, nullptr, nullptr);
    CFRelease (data);
    std::string result;
    if (plist != nullptr && CFGetTypeID (plist) == CFDictionaryGetTypeID())
    {
        auto name = static_cast<CFStringRef> (CFDictionaryGetValue (static_cast<CFDictionaryRef> (plist), CFSTR (kAUPresetNameKey)));
        char text[64] = {};
        if (name != nullptr && CFGetTypeID (name) == CFStringGetTypeID() && CFStringGetCString (name, text, sizeof (text), kCFStringEncodingUTF8))
            result = text;
    }
    if (plist != nullptr)
        CFRelease (plist);
    return result;
}

// The same class info with another preset name
std::vector<uint8_t> auWithPresetName (const std::vector<uint8_t>& plistBytes, const char* name)
{
    auto* data = CFDataCreate (kCFAllocatorDefault, plistBytes.data(), static_cast<CFIndex> (plistBytes.size()));
    auto plist = CFPropertyListCreateWithData (kCFAllocatorDefault, data, kCFPropertyListMutableContainers, nullptr, nullptr);
    CFRelease (data);
    std::vector<uint8_t> result;
    if (plist != nullptr && CFGetTypeID (plist) == CFDictionaryGetTypeID())
    {
        auto* text = CFStringCreateWithCString (kCFAllocatorDefault, name, kCFStringEncodingUTF8);
        CFDictionarySetValue (static_cast<CFMutableDictionaryRef> (const_cast<void*> (plist)), CFSTR (kAUPresetNameKey), text);
        CFRelease (text);
        if (auto* out = CFPropertyListCreateData (kCFAllocatorDefault, plist, kCFPropertyListBinaryFormat_v1_0, 0, nullptr))
        {
            result.assign (CFDataGetBytePtr (out), CFDataGetBytePtr (out) + CFDataGetLength (out));
            CFRelease (out);
        }
    }
    if (plist != nullptr)
        CFRelease (plist);
    return result;
}

void testAudioUnits()
{
    section ("AU: the system's units and the test unit registered in this process are listed");
    registerAuTestGain();
    auto units = listAudioUnits();
    bool testFound = false, delayFound = false;
    for (auto& u : units)
    {
        testFound = testFound || (u.pluginId == auTestGainPluginId && u.name == "Test Gain" && u.vendor == "NoProd");
        delayFound = delayFound || (u.pluginId == "au:aufx:dely:appl" && u.vendor == "Apple");
    }
    CHECK (testFound);
    CHECK (delayFound);
    CHECK (describeAudioUnits()["plugins"].size() == units.size());

    section ("AU: an insert processes audio, takes parameters, sees the transport, saves state");
    std::string error;
    CHECK (AuInsert::create ("au:aufx:nope:nope", error) == nullptr && error.find ("No Audio Unit") != std::string::npos);
    CHECK (AuInsert::create ("com.noprod.nope", error) == nullptr && error.find ("not an Audio Unit id") != std::string::npos);
    auto insert = AuInsert::create (auTestGainPluginId, error);
    CHECK (insert != nullptr);
    if (insert == nullptr)
    {
        std::cerr << "  " << error << std::endl;
        return;
    }
    CHECK (insert->getName() == "Test Gain" && insert->getFormat() == "AU" && insert->getPluginId() == auTestGainPluginId);
    auto params = insert->getParameters();
    CHECK (params.size() == 2);
    CHECK (params[0].name == "Gain" && params[0].id == "0" && ! params[0].readOnly && params[0].defaultValue == 1.0f);
    CHECK (params[1].name == "Host tempo" && params[1].readOnly);
    auto signal = makeSignal (512);
    CHECK (insert->prepare (rate, 512, error));
    CHECK (insert->getLatencySamples() == 0);
    CHECK (errorAgainst (runProcessor (*insert, signal), signal, 1.0f) < 1e-6f);
    CHECK (insert->setParameterValue (0, 0.5f)); // at once, the AU way
    CHECK_NEAR (insert->getParameterValue (0), 0.5f, 1e-6f);
    CHECK (startsWith (insert->getParameterText (0), "0.50"));
    CHECK (errorAgainst (runProcessor (*insert, signal), signal, 0.5f) < 1e-6f);
    CHECK (! insert->setParameterValue (1, 0.3f));
    CHECK (! insert->setParameterValue (5, 0.3f));

    TransportInfo transport;
    transport.tempoBpm = 133.0;
    transport.ppqPosition = 4.0;
    transport.flags = TransportInfo::playing | TransportInfo::tempoValid | TransportInfo::ppqValid;
    insert->setTransport (transport);
    runProcessor (*insert, signal);
    CHECK_NEAR (insert->getParameterValue (1), 0.133f, 1e-4f);
    CHECK (startsWith (insert->getParameterText (1), "133") && insert->getParameterText (1).find ("bpm") != std::string::npos);

    std::vector<uint8_t> state;
    CHECK (insert->getState (state) && ! state.empty());
    CHECK (insert->setParameterValue (0, 0.25f));
    CHECK (errorAgainst (runProcessor (*insert, signal), signal, 0.25f) < 1e-6f);
    CHECK (insert->setState (state));
    CHECK_NEAR (insert->getParameterValue (0), 0.5f, 1e-6f);
    CHECK (errorAgainst (runProcessor (*insert, signal), signal, 0.5f) < 1e-6f);
    // What no parameter sets: the preset name in the class info
    CHECK (auPresetName (state) == "gain");
    CHECK (insert->setState (auWithPresetName (state, "verse")));
    CHECK (insert->getState (state) && auPresetName (state) == "verse");

    CHECK (insert->prepare (44100.0, 256, error));
    auto shorter = makeSignal (256);
    CHECK (errorAgainst (runProcessor (*insert, shorter), shorter, 0.5f) < 1e-6f);

    section ("AU: Apple's AUDelay, fully dry, passes the signal through");
    auto delay = AuInsert::create ("au:aufx:dely:appl", error);
    CHECK (delay != nullptr);
    if (delay != nullptr)
    {
        CHECK (delay->getName() == "AUDelay");
        auto delayParams = delay->getParameters();
        CHECK (delayParams.size() >= 4);
        int mix = -1; // kDelayParam_WetDryMix, id 0, in percent
        for (auto& p : delayParams)
            if (p.id == "0")
                mix = p.index;
        CHECK (mix >= 0);
        CHECK (delay->prepare (rate, 512, error));
        if (mix >= 0)
        {
            CHECK (delay->setParameterValue (mix, 0.0f));
            // (its own string if it has them, else "0 %": either starts with the value)
            std::cout << "  AUDelay's mix at 0: \"" << delay->getParameterText (mix) << "\"" << std::endl;
            CHECK (startsWith (delay->getParameterText (mix), "0"));
            runProcessor (*delay, signal);
            CHECK (errorAgainst (runProcessor (*delay, signal), signal, 1.0f) < 1e-3f);
        }
    }

    section ("AU: through the host, by id, and in the scan worker");
    Rig rig;
    auto known = rig.registry.getPlugins();
    known.push_back ({ auTestGainPluginId, "Test Gain", "NoProd", "AU", auTestGainPluginId, 0 });
    rig.registry.replace (known, {});
    auto& host = rig.host;
    auto& chain = rig.mixer.getMasterChain();
    chain.audioStarted (PluginHost::defaultSampleRate);
    auto state2 = host.handleCommand (command ({ { "type", "LOAD_PLUGIN" }, { "pluginId", auTestGainPluginId } }));
    CHECK (state2["type"].toString() == "AUDIO_CORE_STATE" && masterInserts (state2).size() == 1);
    if (masterInserts (state2).size() == 1)
    {
        auto slot = masterInserts (state2)[0];
        CHECK (slot["format"].toString() == "AU" && slot["name"].toString() == "Test Gain" && slot["pluginId"].toString() == auTestGainPluginId);
        auto changed = host.handleCommand (command ({ { "type", "SET_PLUGIN_PARAMETER" }, { "slotId", slot["slotId"].toString() }, { "parameterId", "0" }, { "value", 0.5 } }));
        CHECK (changed["type"].toString() == "PLUGIN_PARAMETER_CHANGED" && startsWith (changed["text"].toString(), "0.50"));
        CHECK (errorAgainst (runChain (chain, signal), signal, 0.5f) < 1e-6f);

        // The unit's state, preset name included, comes back after a restart
        std::vector<uint8_t> bytes;
        auto& processor = *chain.getSlots().front().processor;
        CHECK (processor.getState (bytes) && processor.setState (auWithPresetName (bytes, "verse")));
        host.handleCommand (command ({ { "type", "SET_PLUGIN_BYPASS" }, { "slotId", slot["slotId"].toString() }, { "bypassed", false } }));
        rig.loop.runFor (1200);
        chain.audioStopped();
        host.clearAllInserts();
        HapAudioEngine engine2;
        Mixer mixer2 (engine2);
        PluginHost reloaded (mixer2, rig.loop, rig.registry, rig.dir / "state.json");
        CHECK (reloaded.restoreState().find ("1 insert restored") != std::string::npos);
        auto& restored = *mixer2.getMasterChain().getSlots().front().processor;
        CHECK (restored.getState (bytes) && auPresetName (bytes) == "verse");
        CHECK_NEAR (restored.getParameterValue (0), 0.5f, 1e-6f);
        reloaded.clearAllInserts();
    }
    chain.audioStopped();

    auto result = runChildProcess (pathFromUtf8 (GHOSTDAW_EXE_PATH), { "--scan-au" }, 20000);
    CHECK (result.started && result.exitCode == 0 && result.output.find ("au:aufx:dely:appl") != std::string::npos);

    auto dir = tempDir ("auscan");
    MessageLoop loop;
    PluginRegistry registry (dir);
    PluginScanner::Options options;
    options.worker = pathFromUtf8 (GHOSTDAW_EXE_PATH);
    PluginScanner scanner (registry, loop, options);
    std::string summary;
    CHECK (scanner.start ([&] (const std::string& s) { summary = s; }));
    CHECK (loop.runUntil ([&] { return ! summary.empty(); }, 120000));
    KnownPlugin found;
    CHECK (registry.find ("au:aufx:dely:appl", found) && found.format == "AU" && found.vendor == "Apple");
    fs::remove_all (dir);
}
#endif

} // namespace

void pluginTests()
{
    testLpiLoader();
    testPluginHost();
    testBusStatePersists();
    testTrackBuses();
    testTrackStreams();
    testEditors();
    testEditorKeyboard();
    testLatencyFollowsParameters();
    testTransport();
    testScanner();
    testVst3();
   #if GHOSTDAW_MAC
    testAudioUnits();
   #endif
}
