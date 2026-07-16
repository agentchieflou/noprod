#include <iostream>
#include <JuceHeader.h>

// The Ghost DAW is a headless C++ application acting as the Audio Muscle.
// It connects to the Orchestrator / Sequencer via WebSockets or UDP.
// It hosts VST3 and CLAP plugins and renders audio in real-time.

using namespace juce;

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
        formatManager.addDefaultFormats();
        
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
        
        // TODO: Initialize WebSocket client to connect to ws://localhost:8081 (Sequencer) or 8080 (Orchestrator)
        // TODO: Start AudioProcessorGraph and handle 'Haps' -> MIDI mapping
        
        std::cout << "Running... Press Ctrl+C to exit." << std::endl;
    }

    void shutdown() override
    {
        std::cout << "Ghost DAW shutting down..." << std::endl;
        deviceManager.closeAudioDevice();
    }
    
    void systemRequestedQuit() override
    {
        quit();
    }

private:
    AudioDeviceManager deviceManager;
    AudioPluginFormatManager formatManager;
    KnownPluginList knownPluginList;
};

// This macro generates the main() routine that launches the app.
START_JUCE_APPLICATION (GhostDAWApplication)
