#pragma once

#include <JuceHeader.h>
#include <atomic>
#include <chrono>
#include <functional>
#include <memory>
#include <mutex>
#include <thread>
#include <vector>
#include <iostream>

#include "Sha1.h"

// Minimal WebSocket server. The Orchestrator (apps/orchestrator/index.js)
// connects out to ws://localhost:8082 expecting the Audio Core to be
// listening there, and auto-reconnects every 3s if the connection drops.
// Each accepted connection is served on its own thread so the accept loop
// is never blocked by a long-lived client (the real Orchestrator connection
// is expected to stay open indefinitely).
//
// Receives unfragmented text (JSON) and binary frames (the `ws` library and
// browsers send each message as a single frame) and answers pings. Sends
// text and binary frames to one connection or to all of them (B6b); each
// connection has its own write lock, so any thread may send.
//
// GhostDAW runs two: the control server for the Orchestrator (8082) and the
// stream server browser tracks send audio to (8083, see TrackStreams.h).
class HapWebSocketServer : public juce::Thread
{
public:
    // One accepted client. Handlers are called on its own thread.
    class Connection
    {
    public:
        bool sendText (const juce::String& text)
        {
            auto utf8 = text.toUTF8();
            return sendFrame (*this, 0x1, utf8.getAddress(), utf8.sizeInBytes() - 1);
        }

        bool sendBinary (const void* data, size_t size) { return sendFrame (*this, 0x2, data, size); }

        std::shared_ptr<void> context; // per-connection state, owned by the handlers

    private:
        friend class HapWebSocketServer;
        std::shared_ptr<juce::StreamingSocket> socket;
        std::mutex writeLock;
        std::vector<uint8_t> payload; // reused for every frame read
    };

    using ConnectionPtr = std::shared_ptr<Connection>;
    using MessageCallback = std::function<void (const juce::var&)>;

    struct Handlers
    {
        std::function<void (const ConnectionPtr&, const juce::var&)> onText;
        // The data is only valid during the call, and may be modified in place
        std::function<void (const ConnectionPtr&, uint8_t* data, size_t size)> onBinary;
        std::function<void (const ConnectionPtr&)> onClose;
    };

    HapWebSocketServer (int portToListenOn, MessageCallback callbackToInvoke)
        : juce::Thread ("HapWebSocketServer"), port (portToListenOn)
    {
        handlers.onText = [callback = std::move (callbackToInvoke)] (const ConnectionPtr&, const juce::var& message)
        {
            if (callback)
                callback (message);
        };
    }

    HapWebSocketServer (int portToListenOn, Handlers connectionHandlers)
        : juce::Thread ("HapWebSocketServer"), port (portToListenOn), handlers (std::move (connectionHandlers))
    {
    }

    ~HapWebSocketServer() override
    {
        signalThreadShouldExit();
        listener.close();
        stopThread (2000);

        // Unblock every client thread's read, then wait for them to finish
        // before members they use go away.
        {
            std::lock_guard<std::mutex> lock (clientsLock);
            for (auto& client : clients)
                client->socket->close();
        }
        for (int i = 0; i < 200 && activeClients.load() > 0; ++i)
            std::this_thread::sleep_for (std::chrono::milliseconds (10));
    }

    int getNumClients() const { return activeClients.load(); }

    // Sends a text frame to every connected client.
    void broadcastText (const juce::String& text)
    {
        auto utf8 = text.toUTF8();
        broadcast (0x1, utf8.getAddress(), utf8.sizeInBytes() - 1);
    }

    // Sends a binary frame to every connected client.
    void broadcastBinary (const void* data, size_t size)
    {
        broadcast (0x2, data, size);
    }

    void run() override
    {
        if (! listener.createListener (port))
        {
            std::cerr << "HapWebSocketServer: failed to listen on port " << port << std::endl;
            return;
        }

        std::cout << "HapWebSocketServer: listening on port " << port << std::endl;

        while (! threadShouldExit())
        {
            std::shared_ptr<juce::StreamingSocket> socket (listener.waitForNextConnection());

            if (socket == nullptr)
                continue; // listener was closed (shutdown) or a transient accept error

            std::cout << "HapWebSocketServer: client connected" << std::endl;

            auto client = std::make_shared<Connection>();
            client->socket = socket;
            ++activeClients;

            std::thread ([this, client]
            {
                handleClient (client);
                // Close now: replies still queued elsewhere may hold the
                // connection, and the client waits for the TCP close. Under
                // the write lock, so a reply being written finishes first and
                // later ones see a closed socket.
                {
                    std::lock_guard<std::mutex> lock (client->writeLock);
                    client->socket->close();
                }
                removeClient (client);
                if (handlers.onClose)
                    handlers.onClose (client);
                std::cout << "HapWebSocketServer: client disconnected" << std::endl;
                --activeClients;
            }).detach();
        }
    }

private:
    int port;
    Handlers handlers;
    juce::StreamingSocket listener;
    std::mutex clientsLock;
    std::vector<ConnectionPtr> clients;
    std::atomic<int> activeClients { 0 };

    static constexpr const char* websocketGuid = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

    void handleClient (const ConnectionPtr& client)
    {
        if (! performHandshake (*client->socket))
            return;

        {
            std::lock_guard<std::mutex> lock (clientsLock);
            clients.push_back (client);
        }

        while (! threadShouldExit())
        {
            juce::var message;
            if (! readTextFrame (client, message))
                return;

            if (handlers.onText)
                handlers.onText (client, message);
        }
    }

    void removeClient (const ConnectionPtr& client)
    {
        std::lock_guard<std::mutex> lock (clientsLock);
        clients.erase (std::remove (clients.begin(), clients.end(), client), clients.end());
    }

    void broadcast (uint8_t opcode, const void* data, size_t size)
    {
        std::vector<ConnectionPtr> targets;
        {
            std::lock_guard<std::mutex> lock (clientsLock);
            targets = clients;
        }

        for (auto& client : targets)
            sendFrame (*client, opcode, data, size);
    }

    // Server-to-client frames are never masked (RFC 6455 5.1).
    static bool sendFrame (Connection& client, uint8_t opcode, const void* data, size_t size)
    {
        uint8_t header[10];
        int headerSize = 2;
        header[0] = static_cast<uint8_t> (0x80 | opcode); // FIN + opcode

        if (size < 126)
        {
            header[1] = static_cast<uint8_t> (size);
        }
        else if (size <= 0xFFFF)
        {
            header[1] = 126;
            header[2] = static_cast<uint8_t> (size >> 8);
            header[3] = static_cast<uint8_t> (size & 0xFF);
            headerSize = 4;
        }
        else
        {
            header[1] = 127;
            for (int i = 0; i < 8; ++i)
                header[2 + i] = static_cast<uint8_t> ((static_cast<uint64_t> (size) >> (56 - 8 * i)) & 0xFF);
            headerSize = 10;
        }

        std::lock_guard<std::mutex> lock (client.writeLock);
        if (client.socket->write (header, headerSize) != headerSize)
            return false;
        return size == 0 || client.socket->write (data, static_cast<int> (size)) == static_cast<int> (size);
    }

    bool performHandshake (juce::StreamingSocket& socket)
    {
        juce::String request;
        char buffer[1];

        // Read the HTTP upgrade request line-by-line until the blank line
        // that terminates the header block.
        while (! request.endsWith ("\r\n\r\n"))
        {
            auto bytesRead = socket.read (buffer, 1, true);
            if (bytesRead <= 0)
                return false;
            request += juce::String::charToString (buffer[0]);

            if (request.length() > 16384) // guard against a malformed/oversized request
                return false;
        }

        auto origin = extractHeaderValue (request, "Origin");
        if (! isAllowedOrigin (origin))
        {
            std::cerr << "HapWebSocketServer: rejected connection from origin " << origin << std::endl;
            const char* forbidden = "HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";
            socket.write (forbidden, (int) strlen (forbidden));
            return false;
        }

        auto key = extractHeaderValue (request, "Sec-WebSocket-Key");
        if (key.isEmpty())
        {
            std::cerr << "HapWebSocketServer: handshake missing Sec-WebSocket-Key" << std::endl;
            return false;
        }

        auto digest = Sha1::hash ((key + websocketGuid).toRawUTF8(), (size_t) (key + websocketGuid).getNumBytesAsUTF8());
        auto acceptKey = juce::Base64::toBase64 (digest.data(), digest.size());

        juce::String response = "HTTP/1.1 101 Switching Protocols\r\n"
                                 "Upgrade: websocket\r\n"
                                 "Connection: Upgrade\r\n"
                                 "Sec-WebSocket-Accept: " + acceptKey + "\r\n\r\n";

        auto utf8 = response.toRawUTF8();
        return socket.write (utf8, (int) strlen (utf8)) > 0;
    }

public:
    // Browsers send an Origin header with every WebSocket handshake, and any
    // web page can try ws://localhost. Plugin commands load code from disk,
    // so only non-browser clients (the Orchestrator sends no Origin) and
    // pages served from this machine are let in, plus any origins listed in
    // NOPROD_ALLOWED_ORIGINS (comma-separated).
    static bool isAllowedOrigin (const juce::String& origin)
    {
        if (origin.isEmpty())
            return true;

        auto extra = juce::StringArray::fromTokens (juce::SystemStats::getEnvironmentVariable ("NOPROD_ALLOWED_ORIGINS", {}), ",", {});
        extra.trim();
        if (extra.contains (origin))
            return true;

        // An Origin is exactly scheme://host[:port]
        auto scheme = origin.upToFirstOccurrenceOf ("://", false, false);
        auto rest = origin.fromFirstOccurrenceOf ("://", false, false);
        auto host = rest.startsWithChar ('[') ? rest.upToFirstOccurrenceOf ("]", true, false)
                                              : rest.upToFirstOccurrenceOf (":", false, false);
        auto port = rest.substring (host.length());
        bool portOk = port.isEmpty() || (port.startsWithChar (':') && port.length() > 1 && port.substring (1).containsOnly ("0123456789"));

        return (scheme == "http" || scheme == "https") && portOk
            && (host == "localhost" || host == "127.0.0.1" || host == "[::1]");
    }

private:
    static juce::String extractHeaderValue (const juce::String& request, const juce::String& headerName)
    {
        auto lines = juce::StringArray::fromLines (request);
        for (auto& line : lines)
        {
            if (line.startsWithIgnoreCase (headerName + ":"))
                return line.fromFirstOccurrenceOf (":", false, false).trim();
        }
        return {};
    }

    bool readExact (juce::StreamingSocket& socket, void* dest, int numBytes)
    {
        return socket.read (dest, numBytes, true) == numBytes;
    }

    // Reads WebSocket frames until a text message arrives, answering pings,
    // handing binary frames to onBinary and skipping pong/continuation
    // frames along the way. Returns false if the client disconnected, sent a
    // close frame, or the connection errored.
    bool readTextFrame (const ConnectionPtr& connection, juce::var& outMessage)
    {
        auto& client = *connection;
        auto& socket = *client.socket;

        for (;;)
        {
            uint8_t header[2];
            if (! readExact (socket, header, 2))
                return false;

            auto opcode = header[0] & 0x0F;
            bool masked = (header[1] & 0x80) != 0;
            uint64_t payloadLength = header[1] & 0x7F;

            if (payloadLength == 126)
            {
                uint8_t ext[2];
                if (! readExact (socket, ext, 2)) return false;
                payloadLength = (static_cast<uint64_t> (ext[0]) << 8) | ext[1];
            }
            else if (payloadLength == 127)
            {
                uint8_t ext[8];
                if (! readExact (socket, ext, 8)) return false;
                payloadLength = 0;
                for (int i = 0; i < 8; ++i)
                    payloadLength = (payloadLength << 8) | ext[i];
            }

            uint8_t maskKey[4] = { 0, 0, 0, 0 };
            if (masked && ! readExact (socket, maskKey, 4))
                return false;

            if (payloadLength > 16 * 1024 * 1024) // sanity guard, well above any real HAP_STREAM payload
                return false;

            auto& payload = client.payload;
            payload.resize (static_cast<size_t> (payloadLength)); // keeps its capacity: no allocation per frame
            if (payloadLength > 0 && ! readExact (socket, payload.data(), (int) payloadLength))
                return false;

            if (masked)
                for (size_t i = 0; i < payload.size(); ++i)
                    payload[i] = static_cast<uint8_t> (payload[i] ^ maskKey[i % 4]);

            if (opcode == 0x8) // close: echo it back, then drop the connection
            {
                sendFrame (client, 0x8, payload.data(), juce::jmin<size_t> (payload.size(), 2));
                return false;
            }

            if (opcode == 0x9) // ping
            {
                sendFrame (client, 0xA, payload.data(), payload.size());
                continue;
            }

            if (opcode == 0x1) // text frame
            {
                auto text = juce::String::fromUTF8 (reinterpret_cast<const char*> (payload.data()), (int) payload.size());
                outMessage = juce::JSON::parse (text);
                return true;
            }

            if (opcode == 0x2 && handlers.onBinary) // binary frame
            {
                handlers.onBinary (connection, payload.data(), payload.size());
                continue;
            }

            // Unhandled opcode (pong, continuation, binary without a handler) -- skip and read the next frame.
        }
    }
};
