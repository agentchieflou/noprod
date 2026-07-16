#include <iostream>
#include <JuceHeader.h>

#include "HapAudioEngine.h"
#include "HapWebSocketServer.h"

// The Ghost DAW is a headless C++ application acting as the Audio Muscle.
// It connects to the Orchestrator / Sequencer via WebSockets or UDP.
// It hosts VST3 and CLAP plugins and renders audio in real-time.

using namespace juce;

constexpr int audioCoreWebSocketPort = 8082;

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
        
        // 1. Initialize Audio Device Manager
        String audioError = deviceManager.initialiseWithDefaultDevices (2, 2);
        if (audioError.isNotEmpty())
        {
            std::cerr << "Audio Device Error: " << audioError << std::endl;
        }

        // 2. Setup Plugin Format Manager
        addHeadlessDefaultFormatsToManager (formatManager);
        
        // 3. Scan for plugins (VST3 on Windows)
        // In a production app, we would cache this in a KnownPluginList XML file.
        std::cout << "Scanning for VST3 plugins..." << std::endl;
        
        VST3PluginFormat vst3Format;
        FileSearchPath vst3Paths = vst3Format.getDefaultLocationsToSearch();
        
        PluginDirectoryScanner scanner (knownPluginList, 
                                        vst3Format, 
                                        vst3Paths, 
                                        true, 
                                        File(), 
                                        true);
                                        
        String pluginName;
        while (scanner.scanNextFile (true, pluginName))
        {
            std::cout << "Found plugin: " << pluginName << std::endl;
        }
        
        std::cout << "Scan complete. Found " << knownPluginList.getNumTypes() << " plugins." << std::endl;

        // 4. Start rendering audio from the Hap engine
        deviceManager.addAudioCallback (&audioEngine);

        // 5. Listen for the Orchestrator, which connects out to ws://localhost:8082
        //    and forwards the Sequencer's HAP_STREAM messages here.
        webSocketServer = std::make_unique<HapWebSocketServer> (audioCoreWebSocketPort,
            [this] (const var& message) { handleMessage (message); });
        webSocketServer->startThread();

        std::cout << "Running... Press Ctrl+C to exit." << std::endl;
    }

    void shutdown() override
    {
        std::cout << "Ghost DAW shutting down..." << std::endl;
        webSocketServer.reset();
        deviceManager.removeAudioCallback (&audioEngine);
        deviceManager.closeAudioDevice();
    }
    
    void systemRequestedQuit() override
    {
        quit();
    }

private:
    void handleMessage (const var& message)
    {
        if (message["type"].toString() == "HAP_STREAM")
        {
            auto haps = message["haps"];
            std::cout << "Received HAP_STREAM with "
                       << (haps.getArray() != nullptr ? haps.getArray()->size() : 0)
                       << " haps" << std::endl;
            audioEngine.scheduleHaps (haps);
        }
    }

    AudioDeviceManager deviceManager;
    AudioPluginFormatManager formatManager;
    KnownPluginList knownPluginList;
    HapAudioEngine audioEngine;
    std::unique_ptr<HapWebSocketServer> webSocketServer;
};

// This macro generates the main() routine that launches the app.
START_JUCE_APPLICATION (GhostDAWApplication)
