#include <iostream>
#include <JuceHeader.h>
#if JUCE_LINUX || JUCE_MAC || JUCE_BSD
 #include <csignal>
#endif

#include "HapAudioEngine.h"
#include "HapWebSocketServer.h"
#include "Mixer.h"
#include "PluginHost.h"
#include "TrackStreams.h"
#include "editor/EditorStream.h"

// The Ghost DAW is a headless C++ application acting as the Audio Muscle.
// It connects to the Orchestrator / Sequencer via WebSockets or UDP.
// It renders the Sequencer's haps in real time, one track per Strudel orbit,
// through per-track and master insert chains of hosted plugins (VST3, AU on
// macOS, and LPI).

using namespace juce;

constexpr int audioCoreWebSocketPort = 8082;
constexpr int trackStreamPort = 8083; // browser tracks' native plugins (TrackStreams.h)
constexpr int editorStreamPort = 8085; // plugin editors streamed to the browser (editor/EditorStream.h)

class GhostDAWApplication : public JUCEApplication
{
public:
    GhostDAWApplication() {}

    const String getApplicationName() override { return "GhostDAW"; }
    const String getApplicationVersion() override { return "1.0.0"; }
    bool moreThanOneInstanceAllowed() override { return true; }

    void initialise (const String& commandLine) override
    {
        std::cout << "Ghost DAW (NoProd Audio Core) initializing..." << std::endl;

       #if JUCE_LINUX || JUCE_MAC || JUCE_BSD
        // A client closing its socket mid-write must fail that write, not
        // kill the process
        std::signal (SIGPIPE, SIG_IGN);
       #endif

        // 1. Plugin host: format manager, cached plugin list, insert chains.
        //    --plugin-cache <file> overrides where the scanned list is kept.
        auto args = StringArray::fromTokens (commandLine, true);
        auto cacheArg = args.indexOf ("--plugin-cache");
        auto cacheFile = cacheArg >= 0 && cacheArg + 1 < args.size()
            ? File (args[cacheArg + 1].unquoted())
            : File::getSpecialLocation (File::userApplicationDataDirectory).getChildFile ("NoProd/GhostDAW/known-plugins.xml");

        pluginHost = std::make_unique<PluginHost> (mixer, cacheFile);
        pluginHost->describeDevice = [this] { return describeDevice(); };
        pluginHost->takeOutputPeak = [this] { return mixer.takePeak(); };
        pluginHost->broadcast = [this] (const var& message) { broadcast (message); };
        pluginHost->editorPort = editorStreamPort;

        // 2. Scan for plugins (default VST3 locations plus remembered folders;
        //    plugins already in the cache aren't rescanned).
        if (! args.contains ("--no-scan"))
        {
            std::cout << "Scanning for plugins..." << std::endl;
            pluginHost->scanDefaultLocations();
            auto available = pluginHost->getState()["availablePlugins"];
            std::cout << "Scan complete. Found " << available.size() << " plugins." << std::endl;
        }

        // 3. Re-prepare the inserts whenever the device (re)starts
        mixer.onDeviceStarted = [this] (double sampleRate, int blockSize)
        {
            MessageManager::callAsync ([this, sampleRate, blockSize]
            {
                for (auto& error : pluginHost->setAudioFormat (sampleRate, blockSize))
                    std::cerr << "Insert dropped: " << error << std::endl;
                broadcast (pluginHost->getState());
            });
        };

        // 4. Initialize the audio device and start rendering the Hap engine
        //    through the track and master inserts
        String audioError = deviceManager.initialiseWithDefaultDevices (2, 2);
        if (audioError.isNotEmpty())
        {
            std::cerr << "Audio Device Error: " << audioError << std::endl;
        }
        deviceManager.addAudioCallback (&mixer);

        // 5. Listen for the Orchestrator, which connects out to ws://localhost:8082,
        //    forwards the Sequencer's HAP_STREAM messages and the frontend's plugin
        //    commands here, and relays replies back to the frontend.
        webSocketServer = std::make_unique<HapWebSocketServer> (audioCoreWebSocketPort,
            [this] (const var& message) { handleMessage (message); });
        webSocketServer->startThread();

        // 6. Browser tracks with native plugins stream their audio through here
        streamServer = std::make_unique<HapWebSocketServer> (trackStreamPort, makeTrackStreamHandlers (*pluginHost));
        streamServer->startThread();

        // 7. Open plugin editors are streamed to the browser from here
        editorServer = std::make_unique<HapWebSocketServer> (editorStreamPort, makeEditorStreamHandlers ([this] (const var& start)
        {
            return pluginHost->makeEditorSource (start["editorId"].toString());
        }));
        editorServer->startThread();

        std::cout << "Running... Press Ctrl+C to exit." << std::endl;
    }

    void shutdown() override
    {
        std::cout << "Ghost DAW shutting down..." << std::endl;
        pluginHost->closeEditor(); // its streams stop asking for frames
        editorServer.reset();
        streamServer.reset();
        webSocketServer.reset();
        deviceManager.removeAudioCallback (&mixer);
        deviceManager.closeAudioDevice();

        // Destroy the hosted plugins while the message thread still exists
        pluginHost->clearAllInserts();
        pluginHost.reset();
    }

    void systemRequestedQuit() override
    {
        quit();
    }

private:
    // Called on a WebSocket client thread
    void handleMessage (const var& message)
    {
        if (message["type"].toString() == "HAP_STREAM")
        {
            auto haps = message["haps"];
            std::cout << "Received HAP_STREAM with "
                       << (haps.getArray() != nullptr ? haps.getArray()->size() : 0)
                       << " haps" << std::endl;
            audioEngine.scheduleHaps (haps);
            return;
        }

        // Plugin commands run on the message thread (see PluginHost)
        MessageManager::callAsync ([this, message]
        {
            if (pluginHost == nullptr)
                return;
            auto reply = pluginHost->handleCommand (message);
            if (! reply.isVoid())
                broadcast (reply);
        });
    }

    void broadcast (const var& message)
    {
        if (webSocketServer != nullptr)
            webSocketServer->broadcastText (JSON::toString (message, true));
    }

    var describeDevice()
    {
        DynamicObject::Ptr device = new DynamicObject();
        auto* current = deviceManager.getCurrentAudioDevice();
        device->setProperty ("name", current != nullptr ? current->getName() : String());
        device->setProperty ("running", current != nullptr && current->isPlaying());
        return var (device.get());
    }

    AudioDeviceManager deviceManager;
    HapAudioEngine audioEngine;
    Mixer mixer { audioEngine };
    std::unique_ptr<PluginHost> pluginHost;
    std::unique_ptr<HapWebSocketServer> webSocketServer;
    std::unique_ptr<HapWebSocketServer> streamServer;
    std::unique_ptr<HapWebSocketServer> editorServer;
};

// This macro generates the main() routine that launches the app.
START_JUCE_APPLICATION (GhostDAWApplication)
