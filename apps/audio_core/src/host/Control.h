#pragma once

#include "../platform/Json.h"
#include "../platform/Log.h"
#include "../platform/Pairing.h"
#include "../platform/WebSocketServer.h"
#include "HapAudioEngine.h"
#include "PluginHost.h"

#include <string>

namespace ghostdaw
{

// The control connections' messages (port 8082): pairing, the hap stream,
// and the plugin host's commands. Runs on the control thread. A connection
// that hasn't presented the token may only pair.
class Control
{
public:
    Control (Pairing& pairingToUse, HapAudioEngine& engineToFeed, PluginHost& hostToCommand)
        : pairing (pairingToUse), engine (engineToFeed), host (hostToCommand) {}

    void onText (const WebSocketServer::ConnectionPtr& connection, const std::string& text)
    {
        auto parsed = Json::parse (text);
        if (! parsed || ! parsed->isObject())
        {
            connection->sendText (PluginHost::makeError ("not a JSON object", "").dump());
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
            connection->sendText (PluginHost::makeError ("not paired: send PAIR with the code GhostDAW printed", type).dump());
            connection->close (1008, "not paired");
            return;
        }
        if (type == "HAP_STREAM")
        {
            engine.scheduleHaps (message["haps"]);
            return;
        }
        if (type == "ROTATE_PAIRING_TOKEN")
        {
            auto token = pairing.rotateToken();
            Log::info ("pairing token rotated at a client's request");
            connection->sendText (Json::object ({ { "type", "PAIRED" }, { "token", token }, { "rotated", true } }).dump());
            return;
        }

        auto reply = host.handleCommand (message);
        if (reply.isNull())
            reply = PluginHost::makeError ("unknown command '" + type + "'", type);
        connection->sendText (reply.dump());
    }

private:
    Pairing& pairing;
    HapAudioEngine& engine;
    PluginHost& host;

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

} // namespace ghostdaw
