// GhostDAW, the NoProd Audio Core: a headless host for VST3, AU and LPI
// plugins that the web app drives over WebSockets on the loopback
// interface, built on its own platform layer (src/platform) and host
// (src/host); see the README.
//
//   ghostdaw [--port 8082] [--stream-port 8083] [--editor-port 8085]
//            [--data-dir DIR] [--new-token] [--null-audio] [--no-scan]
//            [--add-scan-folder DIR] [--verbose] [--version]
//   ghostdaw --scan-file FILE      (the scan worker: describes one plugin binary)
//   ghostdaw --scan-au             (the scan worker: lists the Audio Units, macOS)
//
// Exit codes: 1 a bad argument or a port that is taken; 2 another
// GhostDAW is already running.

#include "platform/ChildProcess.h"
#include "platform/Files.h"
#include "platform/Json.h"
#include "platform/Log.h"
#include "platform/Loop.h"
#include "platform/Pairing.h"
#include "platform/Platform.h"
#include "platform/Process.h"
#include "platform/Strings.h"
#include "platform/WebSocketServer.h"
#include "host/AuPlugin.h"
#include "host/AudioDevice.h"
#include "host/Control.h"
#include "host/HapAudioEngine.h"
#include "host/Mixer.h"
#include "host/PluginHost.h"
#include "host/PluginRegistry.h"
#include "host/PluginScanner.h"
#include "host/TrackStreams.h"
#include "host/Watchdog.h"
#include "host/editor/EditorStream.h"

#include <cstdio>
#include <cstdlib>
#include <iostream>
#include <memory>
#include <string>

using namespace ghostdaw;

namespace
{

constexpr const char* version = "2.0.0-dev";

struct Arguments
{
    uint16_t controlPort = 8082;
    uint16_t streamPort = 8083;
    uint16_t editorPort = 8085;
    fs::path dataDir;
    fs::path scanFile;      // worker mode
    bool scanAu = false;    // worker mode too: the Audio Unit listing
    fs::path addScanFolder; // settings
    bool newToken = false;
    bool nullAudio = false;
    bool noScan = false;
    bool verbose = false;
    bool showVersion = false;
    bool help = false;
};

bool parsePort (const std::string& text, uint16_t& out)
{
    if (text.empty() || ! containsOnly (text, "0123456789") || text.size() > 5)
        return false;
    auto value = std::stoi (text);
    if (value < 1 || value > 65535)
        return false;
    out = static_cast<uint16_t> (value);
    return true;
}

bool parseArguments (int argc, char** argv, Arguments& args, std::string& error)
{
    for (int i = 1; i < argc; ++i)
    {
        std::string arg = argv[i];
        auto value = [&] (std::string& out)
        {
            if (i + 1 >= argc)
            {
                error = arg + " needs a value";
                return false;
            }
            out = argv[++i];
            return true;
        };

        std::string text;
        if (arg == "--port" || arg == "--stream-port" || arg == "--editor-port")
        {
            if (! value (text))
                return false;
            auto& port = arg == "--port" ? args.controlPort : arg == "--stream-port" ? args.streamPort : args.editorPort;
            if (! parsePort (text, port))
            {
                error = arg + ": not a port: " + text;
                return false;
            }
        }
        else if (arg == "--data-dir" || arg == "--scan-file" || arg == "--add-scan-folder")
        {
            if (! value (text))
                return false;
            auto path = pathFromUtf8 (text);
            if (arg == "--data-dir") args.dataDir = path;
            else if (arg == "--scan-file") args.scanFile = path;
            else args.addScanFolder = fs::absolute (path);
        }
        else if (arg == "--scan-au") args.scanAu = true;
        else if (arg == "--new-token") args.newToken = true;
        else if (arg == "--null-audio") args.nullAudio = true;
        else if (arg == "--no-scan") args.noScan = true;
        else if (arg == "--verbose") args.verbose = true;
        else if (arg == "--version") args.showVersion = true;
        else if (arg == "--help" || arg == "-h") args.help = true;
        else
        {
            error = "unknown argument " + arg;
            return false;
        }
    }
    if (args.dataDir.empty())
        args.dataDir = defaultDataDir();
    return true;
}

void printUsage()
{
    std::cout << "ghostdaw " << version << "\n"
                 "  --port N              control port (8082)\n"
                 "  --stream-port N       browser-track audio streams (8083)\n"
                 "  --editor-port N       plugin editor streams (8085)\n"
                 "  --data-dir DIR        where the token, settings, plugin list, bus state and log live\n"
                 "  --new-token           rotate the pairing token (every browser must pair again)\n"
                 "  --null-audio          no sound card: run the engine silently\n"
                 "  --no-scan             don't scan for plugins at launch\n"
                 "  --add-scan-folder DIR add a folder to scan for plugins (settings.json), then exit\n"
                 "  --verbose             debug logging\n"
                 "  --version\n";
}

} // namespace

int main (int argc, char** argv)
{
    Arguments args;
    std::string error;
    if (! parseArguments (argc, argv, args, error))
    {
        std::cerr << "ghostdaw: " << error << "\n";
        printUsage();
        return 1;
    }
    if (args.help)
    {
        printUsage();
        return 0;
    }
    if (args.showVersion)
    {
        std::cout << version << "\n";
        return 0;
    }

    // The scan worker: load one binary here, where a crash costs nothing,
    // and describe it on stdout
    if (! args.scanFile.empty())
    {
        auto described = PluginScanner::describeFile (args.scanFile);
        std::cout << described.dump() << "\n";
        return described.has ("error") ? PluginScanner::notAPluginExitCode : 0;
    }
    if (args.scanAu)
    {
       #if GHOSTDAW_MAC
        std::cout << describeAudioUnits().dump() << "\n";
       #else
        std::cout << Json::object ({ { "plugins", Json::array() } }).dump() << "\n";
       #endif
        return 0;
    }

    if (! createDirectories (args.dataDir))
    {
        std::cerr << "ghostdaw: cannot create the data folder " << pathToUtf8 (args.dataDir) << "\n";
        return 1;
    }

    if (! args.addScanFolder.empty())
    {
        PluginRegistry registry (args.dataDir);
        if (registry.addUserScanFolder (args.addScanFolder))
            std::cout << "added " << pathToUtf8 (args.addScanFolder) << " to " << pathToUtf8 (registry.getSettingsFile()) << "\n";
        else
            std::cout << pathToUtf8 (args.addScanFolder) << " is already in " << pathToUtf8 (registry.getSettingsFile()) << "\n";
        return 0;
    }

    auto logFile = args.dataDir / "ghostdaw.log";
    Log::setFile (logFile);
    if (args.verbose)
        Log::setLevel (Log::Level::debug);
    installCrashHandler (logFile);
    ignoreSigpipe();

    Log::info (std::string ("GhostDAW ") + version + " starting; data in " + pathToUtf8 (args.dataDir));

    // One at a time
    InstanceLock instance (args.dataDir / "ghostdaw.lock");
    if (! instance.isHeld())
    {
        Log::error ("another GhostDAW is already running with this data folder");
        return 2;
    }

    std::unique_ptr<Pairing> pairing;
    try
    {
        pairing = std::make_unique<Pairing> (args.dataDir);
        if (args.newToken)
        {
            pairing->rotateToken();
            Log::info ("pairing token rotated: every browser must pair again");
        }
    }
    catch (const std::exception& e)
    {
        Log::error (e.what());
        return 1;
    }

    std::vector<std::string> extraOrigins;
    if (auto* env = std::getenv ("NOPROD_ALLOWED_ORIGINS"))
        for (auto& origin : split (env, ','))
            if (! trim (origin).empty())
                extraOrigins.push_back (trim (origin));

    MessageLoop loop;

    // The engine and mixer, on the audio device's thread; the watchdog
    // says so if a callback or the control thread ever stops answering
    HapAudioEngine engine;
    Mixer mixer (engine);
    std::unique_ptr<WebSocketServer> controlServerPtr; // set below; the watchdog's reports go out through it
    auto broadcast = [&controlServerPtr] (const Json& message)
    {
        if (controlServerPtr != nullptr)
            controlServerPtr->broadcastText (message.dump());
    };
    Watchdog watchdog ([&broadcast] (const Watchdog::Report& r)
    {
        auto where = r.bus == Mixer::masterBus ? std::string ("the master bus") : r.bus >= 0 ? "track " + std::to_string (r.bus) : std::string ("no bus");
        auto message = r.what == "audio"
            ? (r.stalled ? "the audio callback has been stuck for " + std::to_string (static_cast<int> (r.seconds)) + " s in " + where
                               + (r.slot >= 0 ? ", insert #" + std::to_string (r.slot) : std::string()) + ": a plugin is hanging"
                         : std::string ("the audio callback is running again"))
            : (r.stalled ? "the control thread has not answered for " + std::to_string (static_cast<int> (r.seconds)) + " s: a plugin call is hanging"
                         : std::string ("the control thread is answering again"));
        if (r.stalled)
            Log::error ("watchdog: " + message);
        else
            Log::info ("watchdog: " + message);
        broadcast (PluginHost::makeError (message, "WATCHDOG"));
    });
    watchdog.getBus = [&mixer] { return mixer.getProcessingBus(); };
    watchdog.getSlot = [&mixer]
    {
        auto bus = mixer.getProcessingBus();
        return bus == Mixer::masterBus ? mixer.getMasterChain().getProcessingSlot() : bus >= 0 ? mixer.getTrackChain (bus).getProcessingSlot() : -1;
    };
    loop.addTimer (250, [&watchdog] { watchdog.beat(); });

    // Plugins: the scanned list and the settings, the scanner (a child
    // process per binary), and the host that loads them by id
    PluginRegistry registry (args.dataDir);
    PluginScanner::Options scanOptions;
    scanOptions.worker = currentExecutablePath();
    PluginScanner scanner (registry, loop, scanOptions);
    AudioDevice device (mixer, &watchdog);
    PluginHost host (mixer, loop, registry, args.dataDir / "state.json");
    host.hostVersion = version;
    host.editorPort = args.editorPort;
    host.streamPort = args.streamPort;
    host.describeDevice = [&device] { return device.describe(); };
    host.takeOutputPeak = [&mixer] { return mixer.takePeak(); };
    host.broadcast = broadcast;
    host.isScanning = [&scanner] { return scanner.isScanning(); };

    // The saved buses come back once the plugin list is known: after the
    // launch scan, or right away without one
    bool restored = false;
    auto restore = [&]
    {
        if (restored)
            return;
        restored = true;
        auto what = host.restoreState();
        if (! what.empty())
            Log::info ("bus state: " + what);
        broadcast (host.getState());
    };
    host.requestScan = [&scanner, &host, &broadcast, &restore]
    {
        return scanner.start ([&host, &broadcast, &restore] (const std::string& summary)
        {
            restore();
            broadcast (host.getState());
            (void) summary; // already logged by the scanner
        });
    };

    Control control (*pairing, engine, host);
    device.onStarted = [&loop, &host, &broadcast] (double sampleRate, int blockSize)
    {
        loop.post ([&host, &broadcast, sampleRate, blockSize]
        {
            Log::info ("audio running at " + std::to_string (static_cast<int> (sampleRate)) + " Hz, blocks of " + std::to_string (blockSize));
            for (auto& dropped : host.setAudioFormat (sampleRate, blockSize))
                Log::error ("insert dropped: " + dropped);
            broadcast (host.getState());
        });
    };
    device.onRerouted = [&loop, &device]
    {
        loop.post ([&device]
        {
            std::string why;
            if (! device.restart (why))
                Log::error ("audio: " + why);
        });
    };

    auto checkToken = [&pairing] (const std::string& token) { return pairing->checkToken (token); };

    // 8082: the web app's commands (and the Orchestrator's HAP_STREAM). A
    // connection without the token is let in to pair, and nothing else.
    WebSocketServer::Options controlOptions;
    controlOptions.name = "control";
    controlOptions.port = args.controlPort;
    controlOptions.maxConnections = 16;
    controlOptions.maxMessageBytes = 1024 * 1024;
    controlOptions.checkToken = checkToken;
    controlOptions.allowUnauthenticated = true;
    controlOptions.extraOrigins = extraOrigins;
    WebSocketServer::Handlers controlHandlers;
    controlHandlers.onText = [&control, &loop] (const WebSocketServer::ConnectionPtr& c, const std::string& text)
    {
        loop.post ([&control, c, text] { control.onText (c, text); }); // plugin commands run on the control thread
    };
    controlServerPtr = std::make_unique<WebSocketServer> (controlOptions, controlHandlers);
    auto& controlServer = *controlServerPtr;

    // 8083: browser tracks' audio through their plugins
    WebSocketServer::Options streamOptions;
    streamOptions.name = "streams";
    streamOptions.port = args.streamPort;
    streamOptions.maxConnections = 64;
    streamOptions.maxMessageBytes = 4 * 1024 * 1024; // 8192 frames x 32 channels of float32, plus the headers
    streamOptions.checkToken = checkToken;
    streamOptions.extraOrigins = extraOrigins;
    WebSocketServer streamServer (streamOptions, makeTrackStreamHandlers (host, loop));

    // 8085: plugin editors streamed to the browser
    WebSocketServer::Options editorOptions;
    editorOptions.name = "editors";
    editorOptions.port = args.editorPort;
    editorOptions.maxConnections = 8;
    editorOptions.maxMessageBytes = 64 * 1024;
    editorOptions.checkToken = checkToken;
    editorOptions.extraOrigins = extraOrigins;
    WebSocketServer editorServer (editorOptions, makeEditorStreamHandlers ([&host] (const Json& start)
    {
        return host.makeEditorSource (start["editorId"].toString());
    }));

    for (auto* server : { &controlServer, &streamServer, &editorServer })
    {
        if (! server->start (error))
        {
            Log::error (server->getOptions().name + ": " + error);
            Log::error ("is another GhostDAW, or something else, using the port?");
            return 1;
        }
    }

    AudioDevice::Options audioOptions;
    audioOptions.nullBackend = args.nullAudio;
    if (! device.open (audioOptions, error))
        Log::error ("audio: " + error);

    if (args.noScan)
        loop.post (restore);
    else
        loop.post ([&host] { host.requestScan(); });

    std::cout << "\n  GhostDAW is running. To pair the web app, enter this code in its Audio Core panel:\n\n"
                 "      " << pairing->getCode() << "\n\n"
                 "  Press Ctrl+C to quit.\n\n" << std::flush; // (a pipe would hold it back)
    Log::info ("pairing code for this launch: " + pairing->getCode());

    onTerminationRequest ([&loop] { loop.stop(); });
    loop.run();

    Log::info ("shutting down");
    device.close();
    editorServer.stop();
    streamServer.stop();
    controlServer.stop();
    scanner.wait();
    host.clearAllInserts(); // saves the buses, destroys the plugins on this (the control) thread
    Log::info ("bye");
    return 0;
}
