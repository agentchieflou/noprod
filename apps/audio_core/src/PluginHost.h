#pragma once

#include <JuceHeader.h>
#include <functional>
#include <memory>

#include "InsertChain.h"
#include "JucePluginInsert.h"
#include "LpiPlugin.h"

// Plugin scanning, loading and control for the master insert chain (B5b/B5c,
// and the native-hosting half of #26). Owns the plugin format manager and
// the list of known plugins, and turns JSON commands into chain changes.
//
// Runs entirely on the JUCE message thread: plugin creation (VST3 requires
// it), chain publishing, and parameter writes (LPI requires a single
// control thread per instance).
//
// Commands (all reply with AUDIO_CORE_STATE unless noted):
//   GET_AUDIO_CORE_STATE
//   SCAN_PLUGINS          { paths?: string[] }   VST3 + LPI in these folders and the default VST3 locations
//   LOAD_PLUGIN           { path, format?: 'VST3'|'AU'|'LPI', pluginId?, index? }
//   REMOVE_PLUGIN         { slotId }
//   MOVE_PLUGIN           { slotId, index }
//   SET_PLUGIN_BYPASS     { slotId, bypassed }
//   SET_PLUGIN_PARAMETER  { slotId, parameterIndex | parameterId, value }  -> PLUGIN_PARAMETER_CHANGED
//   SET_VST_PARAMETER     { pluginName, parameterIndex, value (0..1) }    -> PLUGIN_PARAMETER_CHANGED
// Failures reply AUDIO_CORE_ERROR { message, request }.
class PluginHost : private juce::Timer
{
public:
    PluginHost (InsertChain& masterInserts, juce::File knownPluginsCacheFile)
        : chain (masterInserts), cacheFile (std::move (knownPluginsCacheFile))
    {
        juce::addHeadlessDefaultFormatsToManager (formatManager);
        loadCache();

        juce::StringArray errors;
        chain.prepare (defaultSampleRate, defaultBlockSize, errors);

        startTimer (100); // frees snapshots the audio thread has finished with
    }

    ~PluginHost() override
    {
        stopTimer();
    }

    // Supplies device details for the state report (optional).
    std::function<juce::var()> describeDevice;
    // Supplies and resets the post-insert peak level (optional).
    std::function<float()> takeOutputPeak;

    // Called when the audio device (re)starts. Returns any processors that
    // failed to re-prepare as error strings.
    juce::StringArray setAudioFormat (double sampleRate, int blockSize)
    {
        juce::StringArray errors;
        chain.prepare (sampleRate, juce::jmax (blockSize, minimumBlockSize), errors);
        return errors;
    }

    // Scans the default VST3 locations (and any cached folders). Slow the
    // first time; plugins already in the cache aren't rescanned.
    void scanDefaultLocations()
    {
        scan ({});
    }

    juce::var handleCommand (const juce::var& message)
    {
        auto type = message["type"].toString();

        try
        {
            if (type == "GET_AUDIO_CORE_STATE")
                return getState();

            if (type == "SCAN_PLUGINS")
            {
                juce::StringArray paths;
                if (auto* array = message["paths"].getArray())
                    for (auto& p : *array)
                        paths.add (p.toString());
                scan (paths);
                return getState();
            }

            if (type == "LOAD_PLUGIN")
            {
                juce::String error;
                auto processor = createProcessor (message["path"].toString(), message["format"].toString(),
                                                  message["pluginId"].toString(), error);
                if (processor == nullptr)
                    return makeError (error, type);

                if (! processor->prepare (chain.getSampleRate(), chain.getMaxBlockSize(), error))
                    return makeError (error, type);

                auto slots = chain.getSlots();
                InsertChain::Slot slot;
                slot.id = "insert-" + juce::String (nextSlotNumber++);
                slot.processor = std::move (processor);

                auto index = message.hasProperty ("index") ? static_cast<int> (message["index"]) : static_cast<int> (slots.size());
                slots.insert (slots.begin() + juce::jlimit (0, static_cast<int> (slots.size()), index), slot);
                chain.setSlots (std::move (slots));
                return getState();
            }

            if (type == "REMOVE_PLUGIN" || type == "MOVE_PLUGIN" || type == "SET_PLUGIN_BYPASS" || type == "SET_PLUGIN_PARAMETER")
            {
                auto slotId = message["slotId"].toString();
                auto slots = chain.getSlots();
                auto it = std::find_if (slots.begin(), slots.end(), [&] (const InsertChain::Slot& s) { return s.id == slotId; });
                if (it == slots.end())
                    return makeError ("No insert with id '" + slotId + "'", type);

                if (type == "SET_PLUGIN_PARAMETER")
                    return setParameter (*it, message, type);

                if (type == "SET_PLUGIN_BYPASS")
                {
                    it->bypassed->store (static_cast<bool> (message["bypassed"]));
                    return getState();
                }

                auto slot = *it;
                slots.erase (it);
                if (type == "MOVE_PLUGIN")
                {
                    auto index = juce::jlimit (0, static_cast<int> (slots.size()), static_cast<int> (message["index"]));
                    slots.insert (slots.begin() + index, slot);
                }
                chain.setSlots (std::move (slots));
                return getState();
            }

            if (type == "SET_VST_PARAMETER")
            {
                // Legacy message from packages/shared: addresses a plugin by name
                // with a normalized value. There is one bus (the master) for now,
                // so trackIndex is ignored.
                auto name = message["pluginName"].toString();
                for (auto& slot : chain.getSlots())
                {
                    if (! slot.processor->getName().equalsIgnoreCase (name))
                        continue;

                    auto index = static_cast<int> (message["parameterIndex"]);
                    for (auto& p : slot.processor->getParameters())
                    {
                        if (p.index != index)
                            continue;
                        auto normalized = juce::jlimit (0.0f, 1.0f, static_cast<float> (message["value"]));
                        juce::DynamicObject::Ptr request = new juce::DynamicObject();
                        request->setProperty ("parameterIndex", index);
                        request->setProperty ("value", p.minValue + normalized * (p.maxValue - p.minValue));
                        return setParameter (slot, juce::var (request.get()), type);
                    }
                    return makeError (name + " has no parameter " + juce::String (index), type);
                }
                return makeError ("No loaded plugin named '" + name + "'", type);
            }
        }
        catch (const std::exception& e)
        {
            return makeError (e.what(), type);
        }

        return {}; // not a plugin command
    }

    juce::var getState()
    {
        juce::DynamicObject::Ptr state = new juce::DynamicObject();
        state->setProperty ("type", "AUDIO_CORE_STATE");
        state->setProperty ("sampleRate", chain.getSampleRate());
        state->setProperty ("blockSize", chain.getMaxBlockSize());
        if (describeDevice)
            state->setProperty ("device", describeDevice());
        if (takeOutputPeak)
            state->setProperty ("outputPeak", takeOutputPeak());

        juce::Array<juce::var> inserts;
        for (auto& slot : chain.getSlots())
            inserts.add (describeSlot (slot));
        state->setProperty ("inserts", inserts);

        juce::Array<juce::var> available;
        for (auto& desc : knownPlugins.getTypes())
        {
            juce::DynamicObject::Ptr p = new juce::DynamicObject();
            p->setProperty ("name", desc.name);
            p->setProperty ("vendor", desc.manufacturerName);
            p->setProperty ("format", desc.pluginFormatName);
            p->setProperty ("path", desc.fileOrIdentifier);
            p->setProperty ("pluginId", desc.createIdentifierString());
            available.add (juce::var (p.get()));
        }
        for (auto& lpi : lpiPlugins)
        {
            juce::DynamicObject::Ptr p = new juce::DynamicObject();
            p->setProperty ("name", lpi.name);
            p->setProperty ("vendor", lpi.vendor);
            p->setProperty ("format", "LPI");
            p->setProperty ("path", lpi.path);
            p->setProperty ("pluginId", lpi.id);
            available.add (juce::var (p.get()));
        }
        state->setProperty ("availablePlugins", available);

        juce::Array<juce::var> folders;
        for (auto& f : scanFolders)
            folders.add (f);
        state->setProperty ("scanFolders", folders);

        return juce::var (state.get());
    }

    InsertChain& getChain() { return chain; }

    static constexpr double defaultSampleRate = 48000.0;
    static constexpr int defaultBlockSize = 512;
    static constexpr int minimumBlockSize = 512;

private:
    struct LpiEntry
    {
        juce::String path, name, vendor, id;
    };

    void timerCallback() override
    {
        chain.collectGarbage();
    }

    std::unique_ptr<InsertProcessor> createProcessor (const juce::String& path, juce::String format,
                                                      const juce::String& pluginId, juce::String& error)
    {
        if (path.isEmpty())
        {
            error = "LOAD_PLUGIN needs a path";
            return nullptr;
        }

        juce::File file (path);
        if (format.isEmpty())
        {
            auto ext = file.getFileExtension().toLowerCase();
            format = ext == ".vst3" ? "VST3" : ext == ".component" ? "AudioUnit" : "LPI";
        }

        if (format.equalsIgnoreCase ("LPI"))
        {
            auto library = LpiLibrary::open (file, error);
            return library != nullptr ? std::make_unique<LpiInsert> (library) : nullptr;
        }

        auto* pluginFormat = findFormat (format);
        if (pluginFormat == nullptr)
        {
            error = "This build can't host " + format + " plugins";
            return nullptr;
        }

        juce::OwnedArray<juce::PluginDescription> types;
        pluginFormat->findAllTypesForFile (types, path);
        if (types.isEmpty())
        {
            error = "No " + format + " plugin found at " + path;
            return nullptr;
        }

        auto* description = types.getFirst();
        for (auto* t : types)
            if (pluginId.isNotEmpty() && t->createIdentifierString() == pluginId)
                description = t;

        knownPlugins.addType (*description);

        auto instance = formatManager.createPluginInstance (*description, chain.getSampleRate(), chain.getMaxBlockSize(), error);
        if (instance == nullptr)
        {
            if (error.isEmpty())
                error = "Could not instantiate " + description->name;
            return nullptr;
        }

        return std::make_unique<JucePluginInsert> (std::move (instance), path);
    }

    juce::AudioPluginFormat* findFormat (const juce::String& name)
    {
        for (auto* f : formatManager.getFormats())
            if (f->getName().equalsIgnoreCase (name) || (name.equalsIgnoreCase ("AU") && f->getName() == "AudioUnit"))
                return f;
        return nullptr;
    }

    juce::var setParameter (const InsertChain::Slot& slot, const juce::var& message, const juce::String& type)
    {
        auto params = slot.processor->getParameters();
        const PluginParameterInfo* target = nullptr;

        for (auto& p : params)
            if ((message.hasProperty ("parameterId") && p.id == message["parameterId"].toString())
                || (! message.hasProperty ("parameterId") && p.index == static_cast<int> (message["parameterIndex"])))
                target = &p;

        if (target == nullptr)
            return makeError (slot.processor->getName() + ": no such parameter", type);

        auto value = juce::jlimit (target->minValue, target->maxValue, static_cast<float> (message["value"]));
        if (target->readOnly || ! slot.processor->setParameterValue (target->index, value))
            return makeError (slot.processor->getName() + ": could not set " + target->name, type);

        juce::DynamicObject::Ptr reply = new juce::DynamicObject();
        reply->setProperty ("type", "PLUGIN_PARAMETER_CHANGED");
        reply->setProperty ("slotId", slot.id);
        reply->setProperty ("parameterIndex", target->index);
        reply->setProperty ("value", slot.processor->getParameterValue (target->index));
        reply->setProperty ("text", slot.processor->getParameterText (target->index));
        return juce::var (reply.get());
    }

    juce::var describeSlot (const InsertChain::Slot& slot)
    {
        auto& processor = *slot.processor;
        juce::DynamicObject::Ptr s = new juce::DynamicObject();
        s->setProperty ("slotId", slot.id);
        s->setProperty ("name", processor.getName());
        s->setProperty ("format", processor.getFormat());
        s->setProperty ("path", processor.getPath());
        s->setProperty ("bypassed", slot.bypassed->load());
        s->setProperty ("latencySamples", processor.getLatencySamples());

        juce::Array<juce::var> params;
        for (auto& p : processor.getParameters())
        {
            juce::DynamicObject::Ptr o = new juce::DynamicObject();
            o->setProperty ("index", p.index);
            o->setProperty ("id", p.id);
            o->setProperty ("name", p.name);
            o->setProperty ("min", p.minValue);
            o->setProperty ("max", p.maxValue);
            o->setProperty ("default", p.defaultValue);
            o->setProperty ("value", processor.getParameterValue (p.index));
            o->setProperty ("text", processor.getParameterText (p.index));
            o->setProperty ("stepped", p.stepped);
            o->setProperty ("boolean", p.boolean);
            o->setProperty ("readOnly", p.readOnly);
            params.add (juce::var (o.get()));
        }
        s->setProperty ("parameters", params);
        return juce::var (s.get());
    }

    // Scans the given folders (remembered for later scans) plus the default
    // VST3 locations, for VST3 bundles and LPI binaries.
    void scan (const juce::StringArray& paths)
    {
        // Only absolute paths for this machine (the frontend's default list
        // holds Windows folders, which mean nothing elsewhere)
        for (auto& p : paths)
            if (juce::File::isAbsolutePath (p.trim()))
                scanFolders.addIfNotAlreadyThere (p.trim());

        if (auto* vst3 = findFormat ("VST3"))
        {
            auto searchPath = vst3->getDefaultLocationsToSearch();
            for (auto& f : scanFolders)
                searchPath.addIfNotAlreadyThere (juce::File (f));

            juce::PluginDirectoryScanner scanner (knownPlugins, *vst3, searchPath, true, juce::File(), false);
            juce::String name;
            while (scanner.scanNextFile (true, name)) {}
        }

        // LPI plugins are plain shared libraries: probe each one for the
        // lpi_get_factory export. Bounded so a huge folder can't stall forever.
        lpiPlugins.clear();
        int probed = 0;
        for (auto& folder : scanFolders)
        {
            juce::File dir (folder);
            if (! dir.isDirectory())
                continue;

            for (const auto& entry : juce::RangedDirectoryIterator (dir, true, "*.dll;*.so;*.dylib;*.lpi", juce::File::findFiles))
            {
                if (++probed > 2000)
                    break;

                // Binaries inside a .vst3 bundle belong to the VST3 scan
                if (entry.getFile().getFullPathName().containsIgnoreCase (".vst3" + juce::File::getSeparatorString()))
                    continue;

                juce::String error;
                if (auto library = LpiLibrary::open (entry.getFile(), error))
                {
                    auto& info = library->getInfo();
                    lpiPlugins.add ({ entry.getFile().getFullPathName(), juce::String::fromUTF8 (info.name),
                                      juce::String::fromUTF8 (info.vendor), juce::String::fromUTF8 (info.id) });
                }
            }
        }

        saveCache();
    }

    void loadCache()
    {
        if (auto xml = juce::XmlDocument::parse (cacheFile))
        {
            if (auto* list = xml->getChildByName ("KNOWNPLUGINS"))
                knownPlugins.recreateFromXml (*list);

            if (auto* folders = xml->getChildByName ("SCANFOLDERS"))
                for (auto* f : folders->getChildIterator())
                    scanFolders.addIfNotAlreadyThere (f->getStringAttribute ("path"));

            if (auto* lpi = xml->getChildByName ("LPIPLUGINS"))
                for (auto* p : lpi->getChildIterator())
                    lpiPlugins.add ({ p->getStringAttribute ("path"), p->getStringAttribute ("name"),
                                      p->getStringAttribute ("vendor"), p->getStringAttribute ("id") });
        }
    }

    void saveCache()
    {
        if (cacheFile == juce::File())
            return;

        juce::XmlElement root ("GHOSTDAW_PLUGINS");
        if (auto list = knownPlugins.createXml())
            root.addChildElement (list.release());

        auto* folders = root.createNewChildElement ("SCANFOLDERS");
        for (auto& f : scanFolders)
            folders->createNewChildElement ("FOLDER")->setAttribute ("path", f);

        auto* lpi = root.createNewChildElement ("LPIPLUGINS");
        for (auto& p : lpiPlugins)
        {
            auto* e = lpi->createNewChildElement ("PLUGIN");
            e->setAttribute ("path", p.path);
            e->setAttribute ("name", p.name);
            e->setAttribute ("vendor", p.vendor);
            e->setAttribute ("id", p.id);
        }

        cacheFile.getParentDirectory().createDirectory();
        root.writeTo (cacheFile);
    }

    static juce::var makeError (const juce::String& message, const juce::String& request)
    {
        juce::DynamicObject::Ptr error = new juce::DynamicObject();
        error->setProperty ("type", "AUDIO_CORE_ERROR");
        error->setProperty ("message", message);
        error->setProperty ("request", request);
        return juce::var (error.get());
    }

    InsertChain& chain;
    juce::File cacheFile;
    juce::AudioPluginFormatManager formatManager;
    juce::KnownPluginList knownPlugins;
    juce::Array<LpiEntry> lpiPlugins;
    juce::StringArray scanFolders;
    int nextSlotNumber = 1;
};
