// GhostDAW, the NoProd Audio Core: a headless host for VST3, AU and LPI
// plugins that the web app drives over WebSockets on the loopback
// interface. Being rebuilt without JUCE (#134); this build has the
// platform layer, the servers and pairing. The mixer and plugin hosting
// follow in later steps, and src/main.cpp (the JUCE host) keeps working
// until the switch.
//
//   ghostdaw [--port 8082] [--stream-port 8083] [--editor-port 8085]
//            [--data-dir DIR] [--new-token] [--verbose] [--version]
//
// Exit codes: 1 a bad argument or a port that is taken; 2 another
// GhostDAW is already running.

#include "platform/Files.h"
#include "platform/Json.h"
#include "platform/Log.h"
#include "platform/Loop.h"
#include "platform/Pairing.h"
#include "platform/Platform.h"
#include "platform/Process.h"
#include "platform/Strings.h"
#include "platform/WebSocketServer.h"

#include <cstdio>
#include <cstdlib>
#include <iostream>
#include <memory>
#include <string>

using namespace ghostdaw;

namespace
{

constexpr const char* version = "2.0.0-dev";
constexpr int protocolVersion = 2;

struct Arguments
{
    uint16_t controlPort = 8082;
    uint16_t streamPort = 8083;
    uint16_t editorPort = 8085;
    fs::path dataDir;
    bool newToken = false;
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
        else if (arg == "--data-dir")
        {
            if (! value (text))
                return false;
            args.dataDir = pathFromUtf8 (text);
        }
        else if (arg == "--new-token") args.newToken = true;
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

Json errorReply (const std::string& message, const std::string& request)
{
    return Json::object ({ { "type", "AUDIO_CORE_ERROR" }, { "message", message }, { "request", request } });
}

// The control connection's messages. A connection that hasn't presented
// the token may only pair.
class Control
{
public:
    explicit Control (Pairing& pairingToUse) : pairing (pairingToUse) {}

    void onText (const WebSocketServer::ConnectionPtr& connection, const std::string& text)
    {
        auto parsed = Json::parse (text);
        if (! parsed || ! parsed->isObject())
        {
            connection->sendText (errorReply ("not a JSON object", "").dump());
            return;
        }
        auto message = std::move (*parsed);
        auto type = message["type"].toString();

        if (type == "PAIR")
        {
            pair (connection, message["code"].toString());
            return;
        }
        if (! connection->isAuthenticated())
        {
            connection->sendText (errorReply ("not paired: send PAIR with the code GhostDAW printed", type).dump());
            connection->close (1008, "not paired");
            return;
        }
        if (type == "HAP_STREAM")
            return; // the hap engine arrives with the mixer (step 2)

        if (type == "ROTATE_PAIRING_TOKEN")
        {
            auto token = pairing.rotateToken();
            Log::info ("pairing token rotated at a client's request");
            connection->sendText (Json::object ({ { "type", "PAIRED" }, { "token", token }, { "rotated", true } }).dump());
            return;
        }

        if (type == "GET_AUDIO_CORE_STATE")
        {
            connection->sendText (Json::object ({ { "type", "AUDIO_CORE_STATE" }, { "protocolVersion", protocolVersion },
                                                 { "version", version }, { "sampleRate", 0 }, { "blockSize", 0 }, { "trackCount", 0 },
                                                 { "buses", Json::array() }, { "availablePlugins", Json::array() },
                                                 { "scanFolders", Json::array() }, { "streams", Json::array() } }).dump());
            return;
        }

        connection->sendText (errorReply ("this GhostDAW build has no plugin host yet (#134, step 1)", type).dump());
    }

private:
    Pairing& pairing;

    void pair (const WebSocketServer::ConnectionPtr& connection, const std::string& code)
    {
        if (connection->isAuthenticated())
        {
            connection->sendText (Json::object ({ { "type", "PAIRED" }, { "token", pairing.getToken() } }).dump());
            return;
        }
        if (pairing.tryCode (code))
        {
            connection->markAuthenticated();
            Log::info ("paired with " + connection->getPeerName() + " (origin " + (connection->getOrigin().empty() ? "none" : connection->getOrigin()) + ")");
            connection->sendText (Json::object ({ { "type", "PAIRED" }, { "token", pairing.getToken() } }).dump());
            return;
        }
        auto left = Pairing::maxAttempts - pairing.getFailures();
        Log::warn ("wrong pairing code from " + connection->getPeerName() + (pairing.isLocked() ? "; pairing is now locked until GhostDAW restarts" : ", " + std::to_string (left) + " attempts left"));
        connection->sendText (Json::object ({ { "type", "PAIR_FAILED" }, { "locked", pairing.isLocked() }, { "attemptsLeft", left } }).dump());
        if (pairing.isLocked())
            connection->close (1008, "pairing locked");
    }
};

void printUsage()
{
    std::cout << "ghostdaw " << version << "\n"
                 "  --port N          control port (8082)\n"
                 "  --stream-port N   browser-track audio streams (8083)\n"
                 "  --editor-port N   plugin editor streams (8085)\n"
                 "  --data-dir DIR    where the token, settings and log live\n"
                 "  --new-token       rotate the pairing token (every browser must pair again)\n"
                 "  --verbose         debug logging\n"
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

    if (! createDirectories (args.dataDir))
    {
        std::cerr << "ghostdaw: cannot create the data folder " << pathToUtf8 (args.dataDir) << "\n";
        return 1;
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
    Control control (*pairing);
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
    controlHandlers.onText = [&control] (const WebSocketServer::ConnectionPtr& c, const std::string& text) { control.onText (c, text); };
    WebSocketServer controlServer (controlOptions, controlHandlers);

    // 8083: browser tracks' audio through their plugins (step 3)
    WebSocketServer::Options streamOptions;
    streamOptions.name = "streams";
    streamOptions.port = args.streamPort;
    streamOptions.maxConnections = 64;
    streamOptions.maxMessageBytes = 4 * 1024 * 1024; // 8192 frames x 32 channels of float32, plus the headers
    streamOptions.checkToken = checkToken;
    streamOptions.extraOrigins = extraOrigins;
    WebSocketServer::Handlers streamHandlers;
    streamHandlers.onText = [] (const WebSocketServer::ConnectionPtr& c, const std::string&)
    {
        c->sendText (errorReply ("this GhostDAW build has no track streams yet (#134, step 3)", "STREAM").dump());
    };
    WebSocketServer streamServer (streamOptions, streamHandlers);

    // 8085: plugin editors streamed to the browser (step 3)
    WebSocketServer::Options editorOptions;
    editorOptions.name = "editors";
    editorOptions.port = args.editorPort;
    editorOptions.maxConnections = 8;
    editorOptions.maxMessageBytes = 64 * 1024;
    editorOptions.checkToken = checkToken;
    editorOptions.extraOrigins = extraOrigins;
    WebSocketServer::Handlers editorHandlers;
    editorHandlers.onText = [] (const WebSocketServer::ConnectionPtr& c, const std::string&)
    {
        c->sendText (R"({"type":"CLOSED"})");
    };
    WebSocketServer editorServer (editorOptions, editorHandlers);

    for (auto* server : { &controlServer, &streamServer, &editorServer })
    {
        if (! server->start (error))
        {
            Log::error (server->getOptions().name + ": " + error);
            Log::error ("is another GhostDAW, or something else, using the port?");
            return 1;
        }
    }

    std::cout << "\n  GhostDAW is running. To pair the web app, enter this code in its Audio Core panel:\n\n"
                 "      " << pairing->getCode() << "\n\n"
                 "  Press Ctrl+C to quit.\n\n";
    Log::info ("pairing code for this launch: " + pairing->getCode());

    onTerminationRequest ([&loop] { loop.stop(); });
    loop.run();

    Log::info ("shutting down");
    editorServer.stop();
    streamServer.stop();
    controlServer.stop();
    Log::info ("bye");
    return 0;
}
