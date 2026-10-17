#pragma once

#include "../platform/Base64.h"
#include "../platform/Json.h"
#include "../platform/Log.h"
#include "../platform/Loop.h"
#include "../platform/Random.h"
#include "../platform/Strings.h"
#include "InsertChain.h"
#include "LpiPlugin.h"
#include "Mixer.h"
#include "PluginRegistry.h"
#include "TrackStreams.h"
#include "AuPlugin.h"
#include "Vst3Plugin.h"
#include "editor/LpiEditor.h"

#include <algorithm>
#include <functional>
#include <map>
#include <memory>
#include <mutex>
#include <string>
#include <vector>

namespace ghostdaw
{

// Plugin loading and control for the Mixer's insert chains: the master bus
// and one bus per track. Turns JSON commands into chain changes.
//
// Runs entirely on the control thread (the message loop): plugin creation,
// chain publishing, and parameter writes (LPI requires a single control
// thread per instance).
//
// Plugins are named by pluginId, from the registry's scanned list; a
// client never sends a path. Scanning itself is the PluginScanner's
// (started through `requestScan`).
//
// A bus is "master" or a track number (0..15; tracks are Strudel orbits).
// Slot ids are unique across buses, so commands on an existing insert only
// need its slotId.
//
// Commands (all reply with AUDIO_CORE_STATE unless noted):
//   GET_AUDIO_CORE_STATE
//   SCAN_PLUGINS                                 starts a scan of the scan folders (client paths are ignored)
//   LOAD_PLUGIN           { pluginId, bus?, index? }
//   REMOVE_PLUGIN         { slotId }
//   MOVE_PLUGIN           { slotId, index }      (within its bus)
//   SET_PLUGIN_BYPASS     { slotId, bypassed }
//   SET_PLUGIN_PARAMETER  { slotId, parameterIndex | parameterId, value }        -> PLUGIN_PARAMETER_CHANGED
//   SET_VST_PARAMETER     { trackIndex, pluginName, parameterIndex, value (0..1) } -> PLUGIN_PARAMETER_CHANGED
//   OPEN_EDITOR           { slotId, scale? }  -> EDITOR_OPENED { editorId, slotId, name, port, width, height, scale, keyboard }
//   CLOSE_EDITOR                              -> EDITOR_CLOSED { editorId, slotId }
// Failures reply AUDIO_CORE_ERROR { message, request }.
//
// Plugin editors: an LPI plugin with lpi.gui.offscreen.v1 has an editor
// (hasEditor in its slot). OPEN_EDITOR opens it off-screen; the browser
// then streams it from the editor server (editorPort, see
// editor/EditorStream.h), sending START { editorId }. Editor ids are
// random, so only the client that opened one can name it. One editor is
// open at a time (also an LPI v1 rule): opening another closes it, as does
// removing its plugin, and its stream then gets CLOSED. Parameters changed
// in the editor are announced with PLUGIN_PARAMETER_CHANGED { ..., source:
// 'editor', gestureBegin?, gestureEnd? } through `broadcast` (or, for a
// track stream's plugin, to that stream).
//
// A plugin's latency is read again after every parameter change (a
// lookahead may set it). When it moved, the insert's state goes out again:
// AUDIO_CORE_STATE through `broadcast`, or STREAM_STATE to its stream, so
// the browser re-compensates.
//
// The buses' inserts (plugin, bypass, parameter values and the plugin's own
// state, see InsertProcessor::getState) are saved to `stateFile` after
// every change and loaded again at the next launch. A browser track's
// plugin keeps its state in the project instead: its stream sends the
// chunk with LOAD and asks for it back with GET_PLUGIN_STATE.
class PluginHost
{
public:
    static constexpr int protocolVersion = 2;
    // The most a plugin's state chunk may hold, as a client sends or gets
    // it (a bigger one is refused, or not sent)
    static constexpr size_t maxStateBytes = 2 * 1024 * 1024;

    PluginHost (Mixer& mixerToControl, MessageLoop& controlLoop, PluginRegistry& pluginRegistry, fs::path busStateFile)
        : mixer (mixerToControl), loop (controlLoop), registry (pluginRegistry), stateFile (std::move (busStateFile))
    {
        setAudioFormat (defaultSampleRate, defaultBlockSize);
        garbageTimer = loop.addTimer (100, [this] { collectGarbage(); }); // frees snapshots the audio thread has finished with
        saveTimer = loop.addTimer (1000, [this] { if (stateDirty) saveState(); });
    }

    ~PluginHost()
    {
        loop.removeTimer (garbageTimer);
        loop.removeTimer (saveTimer);
    }

    // Supplies device details for the state report (optional).
    std::function<Json()> describeDevice;
    // Supplies and resets the post-insert peak level (optional).
    std::function<float()> takeOutputPeak;
    // Sends a message to every control client (optional): parameter changes
    // made in a plugin's editor, and the state after a scan.
    std::function<void (const Json&)> broadcast;
    // Starts a plugin scan (optional); false if one is running already
    std::function<bool()> requestScan;
    // Whether a scan is running (for the state)
    std::function<bool()> isScanning;
    // Where the browser streams open editors from (reported in EDITOR_OPENED)
    int editorPort = 8085;
    // Where browser tracks stream their audio through plugins (in the state)
    int streamPort = 8083;
    // Extra words for the state (the version, say)
    std::string hostVersion;

    // Called when the audio device (re)starts. Returns any processors that
    // failed to re-prepare as error strings.
    std::vector<std::string> setAudioFormat (double sampleRate, int blockSize)
    {
        std::vector<std::string> errors;
        for (auto* chain : allChains())
            chain->prepare (sampleRate, std::max (blockSize, minimumBlockSize), errors);
        closeEditorIfGone(); // re-preparing an LPI plugin recreates it, closing its editor
        return errors;
    }

    Json handleCommand (const Json& message)
    {
        auto type = message["type"].toString();

        try
        {
            if (type == "GET_AUDIO_CORE_STATE")
                return getState();

            if (type == "SCAN_PLUGINS")
            {
                // Folders a client sends are never scanned: GhostDAW's own
                // settings say where (PluginRegistry)
                if (message.has ("paths") && message["paths"].size() > 0)
                    Log::warn ("SCAN_PLUGINS: ignoring the folders the client sent; scans cover the platform's plugin folders and the settings' scanFolders");
                if (requestScan)
                    requestScan();
                return getState();
            }

            if (type == "LOAD_PLUGIN")
            {
                auto* chain = chainForBus (message["bus"]);
                if (chain == nullptr)
                    return makeError ("No bus '" + message["bus"].toString() + "' (use \"master\" or a track 0-" + std::to_string (Mixer::numTracks - 1) + ")", type);

                std::string error;
                auto processor = createProcessor (message, error);
                if (processor == nullptr)
                    return makeError (error, type);

                if (! processor->prepare (chain->getSampleRate(), chain->getMaxBlockSize(), error))
                    return makeError (error, type);

                auto slots = chain->getSlots();
                InsertChain::Slot slot;
                slot.id = "insert-" + std::to_string (nextSlotNumber++);
                slot.processor = std::move (processor);

                auto index = message.has ("index") ? message["index"].toInt() : static_cast<int> (slots.size());
                slots.insert (slots.begin() + std::clamp (index, 0, static_cast<int> (slots.size())), slot);
                chain->setSlots (std::move (slots));
                stateChanged();
                return getState();
            }

            if (type == "REMOVE_PLUGIN" || type == "MOVE_PLUGIN" || type == "SET_PLUGIN_BYPASS" || type == "SET_PLUGIN_PARAMETER")
            {
                auto slotId = message["slotId"].toString();
                auto* chain = chainHoldingSlot (slotId);
                if (chain == nullptr)
                    return makeError ("No insert with id '" + slotId + "'", type);

                auto slots = chain->getSlots();
                auto it = std::find_if (slots.begin(), slots.end(), [&] (const InsertChain::Slot& s) { return s.id == slotId; });

                if (type == "SET_PLUGIN_PARAMETER")
                {
                    auto reply = setParameter (*it, message, type);
                    stateChanged();
                    if (it->processor->refreshLatency() && broadcast) // a lookahead may change it
                        broadcast (getState());
                    return reply;
                }

                if (type == "SET_PLUGIN_BYPASS")
                {
                    it->bypassed->store (message["bypassed"].toBool());
                    stateChanged();
                    return getState();
                }

                auto slot = *it;
                slots.erase (it);
                if (type == "MOVE_PLUGIN")
                {
                    auto index = std::clamp (message["index"].toInt(), 0, static_cast<int> (slots.size()));
                    slots.insert (slots.begin() + index, slot);
                }
                chain->setSlots (std::move (slots));
                closeEditorIfGone();
                stateChanged();
                return getState();
            }

            if (type == "OPEN_EDITOR")
            {
                auto slotId = message["slotId"].toString();
                auto* chain = chainHoldingSlot (slotId);
                if (chain == nullptr)
                    return makeError ("No insert with id '" + slotId + "'", type);

                for (auto& slot : chain->getSlots())
                    if (slot.id == slotId)
                        return openEditor (slot, message, type, broadcast, [this] { return getState(); });
            }

            if (type == "CLOSE_EDITOR")
                return closeEditor();

            if (type == "SET_VST_PARAMETER")
            {
                // Message from packages/shared: addresses a plugin by name on a
                // track (trackIndex; missing or negative means the master bus)
                // with a normalized value.
                auto trackIndex = message.has ("trackIndex") ? message["trackIndex"].toInt() : -1;
                auto* chain = trackIndex < 0 ? &mixer.getMasterChain() : chainForBus (Json (trackIndex));
                if (chain == nullptr)
                    return makeError ("No track " + std::to_string (trackIndex), type);

                auto name = message["pluginName"].toString();
                for (auto& slot : chain->getSlots())
                {
                    if (! equalsIgnoreCase (slot.processor->getName(), name))
                        continue;

                    auto index = message["parameterIndex"].toInt();
                    for (auto& p : slot.processor->getParameters())
                    {
                        if (p.index != index)
                            continue;
                        auto normalized = std::clamp (static_cast<float> (message["value"].toDouble()), 0.0f, 1.0f);
                        auto request = Json::object ({ { "parameterIndex", index }, { "value", p.minValue + normalized * (p.maxValue - p.minValue) } });
                        auto reply = setParameter (slot, request, type);
                        stateChanged();
                        if (slot.processor->refreshLatency() && broadcast)
                            broadcast (getState());
                        return reply;
                    }
                    return makeError (name + " has no parameter " + std::to_string (index), type);
                }
                return makeError ("No plugin named '" + name + "' on " + (trackIndex < 0 ? std::string ("the master bus") : "track " + std::to_string (trackIndex)), type);
            }
        }
        catch (const std::exception& e)
        {
            return makeError (e.what(), type);
        }

        return {}; // not a plugin command
    }

    Json getState()
    {
        auto& master = mixer.getMasterChain();

        auto state = Json::object ({ { "type", "AUDIO_CORE_STATE" }, { "protocolVersion", protocolVersion } });
        if (! hostVersion.empty())
            state.set ("version", hostVersion);
        state.set ("sampleRate", master.getSampleRate());
        state.set ("blockSize", master.getMaxBlockSize());
        state.set ("trackCount", Mixer::numTracks);
        state.set ("streamPort", streamPort);
        if (describeDevice)
            state.set ("device", describeDevice());
        if (takeOutputPeak)
            state.set ("outputPeak", takeOutputPeak());

        // The master bus, then every track bus that has inserts
        auto buses = Json::array();
        auto describeBus = [this] (const Json& id, InsertChain& chain)
        {
            auto inserts = Json::array();
            for (auto& slot : chain.getSlots())
                inserts.push (describeSlot (slot));
            return Json::object ({ { "bus", id }, { "inserts", inserts } });
        };
        buses.push (describeBus ("master", master));
        for (int t = 0; t < Mixer::numTracks; ++t)
            if (! mixer.getTrackChain (t).getSlots().empty())
                buses.push (describeBus (t, mixer.getTrackChain (t)));
        state.set ("buses", buses);

        // Plugins the browser's tracks run through stream connections
        auto streamList = Json::array();
        for (auto& stream : streams)
        {
            auto inserts = Json::array();
            for (auto& slot : stream->chain.getSlots())
                inserts.push (describeSlot (slot));
            streamList.push (Json::object ({ { "streamId", stream->id }, { "inserts", inserts } }));
        }
        state.set ("streams", streamList);

        auto available = Json::array();
        for (auto& p : registry.getPlugins())
            available.push (Json::object ({ { "name", p.name }, { "vendor", p.vendor }, { "format", p.format }, { "path", p.path }, { "pluginId", p.pluginId } }));
        state.set ("availablePlugins", available);
        state.set ("scanFolders", registry.describeScanFolders());
        auto skippedList = Json::array();
        for (auto& s : registry.getSkipped())
            skippedList.push (Json::object ({ { "path", s.path }, { "reason", s.reason } }));
        state.set ("skippedPlugins", skippedList);
        state.set ("scanning", isScanning ? isScanning() : false);

        return state;
    }

    // Removes every insert from every bus (shutdown, before the control
    // thread goes away). The saved state keeps them for the next launch.
    void clearAllInserts()
    {
        if (stateDirty)
            saveState();
        closeEditor();
        for (auto* chain : allChains())
        {
            chain->setSlots ({});
            chain->collectGarbage();
        }
        for (auto& stream : streams)
        {
            stream->chain.audioStopped();
            stream->chain.setSlots ({});
            stream->chain.collectGarbage();
        }
        streams.clear();
    }

    // --------------------------------------------------------- saved state

    // The buses' inserts as saved: { buses: [ { bus, inserts: [ { pluginId, bypassed, parameters: { id: value }, state: base64 | null } ] } ] }
    Json describeBusState()
    {
        auto buses = Json::array();
        auto add = [&] (const Json& id, InsertChain& chain)
        {
            if (chain.getSlots().empty())
                return;
            auto inserts = Json::array();
            for (auto& slot : chain.getSlots())
            {
                auto parameters = Json::object();
                for (auto& p : slot.processor->getParameters())
                    if (! p.id.empty() && ! p.readOnly)
                        parameters.set (p.id.c_str(), slot.processor->getParameterValue (p.index));
                inserts.push (Json::object ({ { "pluginId", slot.processor->getPluginId() }, { "bypassed", slot.bypassed->load() },
                                              { "parameters", parameters }, { "state", stateChunk (*slot.processor) } }));
            }
            buses.push (Json::object ({ { "bus", id }, { "inserts", inserts } }));
        };
        add ("master", mixer.getMasterChain());
        for (int t = 0; t < Mixer::numTracks; ++t)
            add (t, mixer.getTrackChain (t));
        return Json::object ({ { "buses", buses } });
    }

    void saveState()
    {
        stateDirty = false;
        if (stateFile.empty())
            return;
        if (! writeFile (stateFile, describeBusState().dump (2) + "\n"))
            Log::warn ("could not save the bus state to " + pathToUtf8 (stateFile));
    }

    // Loads the inserts saved by the last run (plugins no longer in the
    // registry are reported and dropped). Returns what was restored.
    std::string restoreState()
    {
        std::string text;
        if (stateFile.empty() || ! readFile (stateFile, text))
            return {};
        auto parsed = Json::parse (text);
        if (! parsed)
        {
            Log::warn ("ignoring the unreadable bus state " + pathToUtf8 (stateFile));
            return {};
        }
        int restored = 0, missing = 0;
        for (auto& bus : (*parsed)["buses"].elements())
        {
            auto* chain = chainForBus (bus["bus"]);
            if (chain == nullptr)
                continue;
            auto slots = chain->getSlots();
            for (auto& insert : bus["inserts"].elements())
            {
                std::string error;
                auto processor = createProcessor (insert, error);
                if (processor == nullptr || ! processor->prepare (chain->getSampleRate(), chain->getMaxBlockSize(), error))
                {
                    Log::warn ("not restoring " + insert["pluginId"].toString() + " on bus " + bus["bus"].toString() + ": " + error);
                    ++missing;
                    continue;
                }
                if (! applyState (*processor, insert["state"], error))
                    Log::warn ("restoring " + insert["pluginId"].toString() + " on bus " + bus["bus"].toString() + " without its saved state: " + error);
                applyParameters (*processor, insert["parameters"]);
                InsertChain::Slot slot;
                slot.id = "insert-" + std::to_string (nextSlotNumber++);
                slot.processor = std::move (processor);
                slot.bypassed->store (insert["bypassed"].toBool());
                slots.push_back (slot);
                ++restored;
            }
            chain->setSlots (std::move (slots));
        }
        stateDirty = false;
        return std::to_string (restored) + " insert" + (restored == 1 ? "" : "s") + " restored" + (missing > 0 ? ", " + std::to_string (missing) + " missing" : "");
    }

    // ---------------------------------------------------------- track streams
    // (see TrackStreams.h; all called on the control thread)

    void registerStream (std::shared_ptr<TrackStream> stream)
    {
        streams.push_back (std::move (stream));
    }

    void closeStream (const std::shared_ptr<TrackStream>& stream)
    {
        stream->chain.setSlots ({});
        stream->chain.collectGarbage();
        streams.erase (std::remove (streams.begin(), streams.end(), stream), streams.end());
        closeEditorIfGone();
    }

    // A stream hosts one plugin. Commands:
    //   LOAD       { pluginId, parameters?: { [parameterId]: value }, state?: base64 }  -> STREAM_STATE
    //   UNLOAD                                                             -> STREAM_STATE
    //   SET_PARAM  { parameterId | parameterIndex, value }                 -> PLUGIN_PARAMETER_CHANGED
    //   GET_STATE                                                          -> STREAM_STATE
    //   GET_PLUGIN_STATE                                                   -> STREAM_PLUGIN_STATE { state: base64 | null }
    //   OPEN_EDITOR { scale? } / CLOSE_EDITOR    as the commands above, for the stream's plugin
    // A LOAD's state (the chunk GET_PLUGIN_STATE gave for this plugin) must
    // decode to at most maxStateBytes, or the LOAD is refused.
    Json handleStreamCommand (TrackStream& stream, const Json& message)
    {
        auto type = message["type"].toString();

        if (type == "OPEN_EDITOR")
        {
            if (stream.chain.getSlots().empty())
                return makeError ("No plugin loaded", "STREAM_" + type);
            auto streamId = stream.id;
            return openEditor (stream.chain.getSlots().front(), message, "STREAM_" + type, stream.sendToBrowser,
                               [this, streamId]
                               {
                                   for (auto& s : streams)
                                       if (s->id == streamId)
                                           return describeStream (*s);
                                   return Json();
                               });
        }

        if (type == "CLOSE_EDITOR")
            return closeEditor();

        if (type == "LOAD")
        {
            std::string error;
            std::vector<uint8_t> state;
            if (message.has ("state") && ! decodeState (message["state"], state, error))
                return makeError (error, "STREAM_" + type);
            auto processor = createProcessor (message, error);
            if (processor == nullptr || ! processor->prepare (stream.sampleRate, stream.maxBlockSize, error))
                return makeError (error, "STREAM_" + type);

            if (! state.empty() && ! processor->setState (state))
                Log::warn (processor->getName() + " refused the state its project holds; loading it without");
            applyParameters (*processor, message["parameters"]);

            InsertChain::Slot slot;
            slot.id = "insert-" + std::to_string (nextSlotNumber++);
            slot.processor = std::move (processor);
            stream.chain.setSlots ({ slot });
            closeEditorIfGone();
            return describeStream (stream);
        }

        if (type == "UNLOAD")
        {
            stream.chain.setSlots ({});
            closeEditorIfGone();
            return describeStream (stream);
        }

        if (type == "SET_PARAM")
        {
            if (stream.chain.getSlots().empty())
                return makeError ("No plugin loaded", "STREAM_" + type);
            auto reply = setParameter (stream.chain.getSlots().front(), message, "STREAM_" + type);
            // A latency change: the browser re-compensates from the new state
            if (stream.chain.getSlots().front().processor->refreshLatency() && stream.sendToBrowser)
                stream.sendToBrowser (describeStream (stream));
            return reply;
        }

        if (type == "GET_STATE")
            return describeStream (stream);

        if (type == "GET_PLUGIN_STATE")
        {
            if (stream.chain.getSlots().empty())
                return makeError ("No plugin loaded", "STREAM_" + type);
            auto& processor = *stream.chain.getSlots().front().processor;
            auto reply = Json::object ({ { "type", "STREAM_PLUGIN_STATE" }, { "streamId", stream.id }, { "state", stateChunk (processor) } });
            std::vector<uint8_t> bytes;
            if (reply["state"].isNull() && processor.getState (bytes) && bytes.size() > maxStateBytes)
                reply.set ("message", processor.getName() + "'s state (" + std::to_string (bytes.size()) + " bytes) is more than GhostDAW sends");
            return reply;
        }

        return makeError ("Unknown stream command '" + type + "'", "STREAM_" + type);
    }

    Json describeStream (TrackStream& stream)
    {
        auto& slots = stream.chain.getSlots();
        return Json::object ({ { "type", "STREAM_STATE" }, { "streamId", stream.id }, { "sampleRate", stream.sampleRate },
                               { "maxBlockSize", stream.maxBlockSize }, { "insert", slots.empty() ? Json() : describeSlot (slots.front()) } });
    }

    // ------------------------------------------------------------------ editors

    // Closes the open editor, if any. Replies EDITOR_CLOSED.
    Json closeEditor()
    {
        std::shared_ptr<EditorSession> closing;
        {
            const std::lock_guard<std::mutex> guard (editorLock);
            closing = std::move (editor);
            editor.reset();
        }

        auto reply = Json::object ({ { "type", "EDITOR_CLOSED" } });
        if (closing != nullptr)
        {
            closing->close();
            reply.set ("editorId", closing->editorId);
            reply.set ("slotId", closing->slotId);
            stateChanged(); // whatever the editor did to the plugin's state is saved
        }
        return reply;
    }

    // Any thread (the editor server's connections): a stream source for the
    // open editor if `editorId` names it, else nullptr
    std::unique_ptr<FrameSource> makeEditorSource (const std::string& editorId)
    {
        const std::lock_guard<std::mutex> guard (editorLock);
        if (editor == nullptr || editor->isClosed() || editor->editorId != editorId)
            return nullptr;
        return std::make_unique<LpiEditorSource> (editor, loop);
    }

    static constexpr double defaultSampleRate = 48000.0;
    static constexpr int defaultBlockSize = 512;
    static constexpr int minimumBlockSize = 512;

    static Json makeError (const std::string& message, const std::string& request)
    {
        return Json::object ({ { "type", "AUDIO_CORE_ERROR" }, { "message", message }, { "request", request } });
    }

private:
    void collectGarbage()
    {
        for (auto* chain : allChains())
            chain->collectGarbage();
        for (auto& stream : streams)
            stream->chain.collectGarbage();
    }

    void stateChanged() { stateDirty = true; }

    std::vector<InsertChain*> allChains()
    {
        std::vector<InsertChain*> chains { &mixer.getMasterChain() };
        for (int t = 0; t < Mixer::numTracks; ++t)
            chains.push_back (&mixer.getTrackChain (t));
        return chains;
    }

    // "master" (or no bus) is the master bus; a number 0..15 is a track
    InsertChain* chainForBus (const Json& bus)
    {
        if (bus.isNull() || bus.toString() == "master")
            return &mixer.getMasterChain();

        auto text = bus.toString();
        if (! (bus.isNumber() || (! text.empty() && containsOnly (text, "0123456789"))))
            return nullptr;

        auto track = bus.toInt (-1);
        return track >= 0 && track < Mixer::numTracks ? &mixer.getTrackChain (track) : nullptr;
    }

    InsertChain* chainHoldingSlot (const std::string& slotId)
    {
        for (auto* chain : allChains())
            for (auto& slot : chain->getSlots())
                if (slot.id == slotId)
                    return chain;
        return nullptr;
    }

    // A processor for the plugin a message names by pluginId. A path in the
    // message is never used: plugins load from the registry only.
    std::unique_ptr<InsertProcessor> createProcessor (const Json& message, std::string& error)
    {
        auto pluginId = message["pluginId"].toString();
        if (pluginId.empty())
        {
            error = message.has ("path") ? "Plugins load by pluginId (from availablePlugins), never by path"
                                         : "LOAD_PLUGIN needs a pluginId (from availablePlugins)";
            return nullptr;
        }

        KnownPlugin known;
        if (! registry.find (pluginId, known))
        {
            error = "No plugin with id '" + pluginId + "' in the scanned list";
            return nullptr;
        }

        if (equalsIgnoreCase (known.format, "LPI"))
        {
            auto library = LpiLibrary::open (pathFromUtf8 (known.path), error);
            return library != nullptr ? std::make_unique<LpiInsert> (library) : nullptr;
        }

        if (equalsIgnoreCase (known.format, "VST3"))
        {
            // Instances of one module share it, so its binary loads once
            auto module = vst3Modules[known.path].lock();
            if (module == nullptr)
            {
                module = Vst3Module::open (pathFromUtf8 (known.path), error);
                if (module == nullptr)
                    return nullptr;
                vst3Modules[known.path] = module;
            }
            auto insert = Vst3Insert::create (module, pluginId, error);
            if (insert == nullptr)
                return nullptr;
            return insert;
        }

       #if GHOSTDAW_MAC
        if (equalsIgnoreCase (known.format, "AU"))
            return AuInsert::create (pluginId, error);
       #endif

        error = "This build can't host " + known.format + " plugins";
        return nullptr;
    }

    // The plugin's state as a chunk (base64), null when it has none or it
    // is too big to send
    static Json stateChunk (InsertProcessor& processor)
    {
        std::vector<uint8_t> bytes;
        if (! processor.getState (bytes) || bytes.empty() || bytes.size() > maxStateBytes)
            return {};
        return base64Encode (bytes.data(), bytes.size());
    }

    // A chunk from a client or the saved state to bytes: refused (false,
    // `error`) when it isn't base64 or is more than maxStateBytes
    static bool decodeState (const Json& chunk, std::vector<uint8_t>& bytes, std::string& error)
    {
        bytes.clear();
        if (chunk.isNull())
            return true;
        if (! chunk.isString())
        {
            error = "state: expected a base64 string";
            return false;
        }
        auto text = chunk.toString();
        auto tooBig = [&] { error = "state: more than " + std::to_string (maxStateBytes) + " bytes"; return false; };
        if (text.size() > (maxStateBytes + 2) / 3 * 4)
            return tooBig();
        if (! base64Decode (text, bytes))
        {
            bytes.clear();
            error = "state: not base64";
            return false;
        }
        if (bytes.size() > maxStateBytes)
        {
            bytes.clear();
            return tooBig();
        }
        return true;
    }

    // A saved chunk into the plugin. False (with the reason) when it can't
    // be decoded or the plugin refuses it.
    static bool applyState (InsertProcessor& processor, const Json& chunk, std::string& error)
    {
        std::vector<uint8_t> bytes;
        if (! decodeState (chunk, bytes, error))
            return false;
        if (bytes.empty())
            return true;
        if (! processor.setState (bytes))
        {
            error = processor.getName() + " refused it";
            return false;
        }
        processor.refreshLatency();
        return true;
    }

    // Saved values, by parameter id
    static void applyParameters (InsertProcessor& processor, const Json& values)
    {
        if (! values.isObject())
            return;
        for (auto& p : processor.getParameters())
            if (! p.id.empty() && values.has (p.id) && ! p.readOnly)
                processor.setParameterValue (p.index, std::clamp (static_cast<float> (values[p.id].toDouble()), p.minValue, p.maxValue));
        processor.refreshLatency(); // the saved values may include a lookahead
    }

    // `notify` sends to whoever shows this insert; `describe` makes the state
    // message they need when its latency changes
    Json openEditor (const InsertChain::Slot& slot, const Json& message, const std::string& type,
                     std::function<void (const Json&)> notify, std::function<Json()> describe)
    {
        auto* lpi = dynamic_cast<LpiInsert*> (slot.processor.get());
        if (lpi == nullptr || ! lpi->hasEditor())
            return makeError (slot.processor->getName() + " has no editor GhostDAW can show", type);

        // Asking again for the open one (another browser window) just reports it
        if (editor != nullptr && ! editor->isClosed() && editor->slotId == slot.id)
            return describeEditor (*editor, *lpi);

        closeEditor();

        auto scale = std::clamp (static_cast<float> (message.get ("scale", 1.0).toDouble()), 0.5f, 4.0f);
        lpi_gui_offscreen_info info;
        std::string error;
        if (! lpi->openEditor (scale, info, error))
            return makeError (error, type);

        auto session = std::make_shared<EditorSession> ("editor-" + secureRandomHex (8), slot.id, *lpi, info);
        lpi->onEditorClosed = [weak = std::weak_ptr<EditorSession> (session)]
        {
            if (auto s = weak.lock())
                s->markClosed();
        };
        session->onParametersChanged = [this, slotId = slot.id, notify, describe, lpi] (const std::vector<PluginParameterChange>& changed)
        {
            // (only called while the editor, and so the plugin, is open)
            stateChanged();
            if (! notify)
                return;
            for (auto& change : changed)
            {
                auto m = parameterChanged (slotId, *lpi, change.index);
                m.set ("source", "editor"); // not an answer to a SET
                if (change.gestureBegin)
                    m.set ("gestureBegin", true);
                if (change.gestureEnd)
                    m.set ("gestureEnd", true);
                notify (m);
            }
            if (lpi->refreshLatency() && describe)
                if (auto state = describe(); ! state.isNull())
                    notify (state);
        };

        {
            const std::lock_guard<std::mutex> guard (editorLock);
            editor = session;
        }
        return describeEditor (*session, *lpi);
    }

    Json describeEditor (const EditorSession& session, InsertProcessor& processor)
    {
        auto* lpi = dynamic_cast<LpiInsert*> (&processor);
        return Json::object ({ { "type", "EDITOR_OPENED" }, { "editorId", session.editorId }, { "slotId", session.slotId },
                               { "name", processor.getName() }, { "port", editorPort }, { "width", session.width }, { "height", session.height },
                               { "scale", session.scale }, { "keyboard", lpi != nullptr && lpi->hasKeyboard() } });
    }

    // After inserts went away: close the editor if its plugin was one of them
    void closeEditorIfGone()
    {
        if (editor == nullptr)
            return;

        auto holds = [this] (const InsertChain& chain)
        {
            for (auto& slot : chain.getSlots())
                if (slot.id == editor->slotId && slot.processor.get() == editor->getInsert())
                    return true;
            return false;
        };

        auto found = false;
        for (auto* chain : allChains())
            found = found || holds (*chain);
        for (auto& stream : streams)
            found = found || holds (stream->chain);

        if (! found || editor->isClosed())
            closeEditor();
    }

    static Json parameterChanged (const std::string& slotId, InsertProcessor& processor, int index)
    {
        return Json::object ({ { "type", "PLUGIN_PARAMETER_CHANGED" }, { "slotId", slotId }, { "parameterIndex", index },
                               { "value", processor.getParameterValue (index) }, { "text", processor.getParameterText (index) } });
    }

    Json setParameter (const InsertChain::Slot& slot, const Json& message, const std::string& type)
    {
        auto params = slot.processor->getParameters();
        const PluginParameterInfo* target = nullptr;

        for (auto& p : params)
            if ((message.has ("parameterId") && p.id == message["parameterId"].toString())
                || (! message.has ("parameterId") && p.index == message["parameterIndex"].toInt (-1)))
                target = &p;

        if (target == nullptr)
            return makeError (slot.processor->getName() + ": no such parameter", type);

        auto value = std::clamp (static_cast<float> (message["value"].toDouble()), target->minValue, target->maxValue);
        if (target->readOnly || ! slot.processor->setParameterValue (target->index, value))
            return makeError (slot.processor->getName() + ": could not set " + target->name, type);

        return parameterChanged (slot.id, *slot.processor, target->index);
    }

    Json describeSlot (const InsertChain::Slot& slot)
    {
        auto& processor = *slot.processor;
        auto s = Json::object ({ { "slotId", slot.id }, { "name", processor.getName() }, { "format", processor.getFormat() },
                                 { "path", processor.getPath() }, { "pluginId", processor.getPluginId() }, { "bypassed", slot.bypassed->load() },
                                 { "latencySamples", processor.getLatencySamples() }, { "hasEditor", processor.hasEditor() },
                                 { "editorOpen", editor != nullptr && ! editor->isClosed() && editor->slotId == slot.id } });

        auto params = Json::array();
        for (auto& p : processor.getParameters())
            params.push (Json::object ({ { "index", p.index }, { "id", p.id }, { "name", p.name }, { "min", p.minValue }, { "max", p.maxValue },
                                         { "default", p.defaultValue }, { "value", processor.getParameterValue (p.index) },
                                         { "text", processor.getParameterText (p.index) }, { "stepped", p.stepped }, { "boolean", p.boolean },
                                         { "readOnly", p.readOnly } }));
        s.set ("parameters", params);
        return s;
    }

    Mixer& mixer;
    MessageLoop& loop;
    PluginRegistry& registry;
    std::map<std::string, std::weak_ptr<Vst3Module>> vst3Modules; // by path
    fs::path stateFile;
    bool stateDirty = false;
    MessageLoop::TimerId garbageTimer = 0, saveTimer = 0;
    int nextSlotNumber = 1;
    std::vector<std::shared_ptr<TrackStream>> streams;

    // The open editor. Changed only on the control thread, under the lock
    // (the editor server reads it from its connections' threads).
    std::mutex editorLock;
    std::shared_ptr<EditorSession> editor;
};

} // namespace ghostdaw
