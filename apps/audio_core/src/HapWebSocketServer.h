#pragma once

#include <JuceHeader.h>
#include <functional>
#include <memory>
#include <thread>
#include <iostream>

#include "Sha1.h"

// Minimal WebSocket server. The Orchestrator (apps/orchestrator/index.js)
// connects out to ws://localhost:8082 expecting the Audio Core to be
// listening there, and auto-reconnects every 3s if the connection drops.
// Each accepted connection is served on its own detached thread so the
// accept loop is never blocked by a long-lived client (the real Orchestrator
// connection is expected to stay open indefinitely).
//
// Handles text frames only (no fragmentation, ping/pong): the Orchestrator's
// `ws` library sends each message as a single unfragmented frame, which is
// all this needs to support.
class HapWebSocketServer : public juce::Thread
{
public:
    using MessageCallback = std::function<void (const juce::var&)>;

    HapWebSocketServer (int portToListenOn, MessageCallback callbackToInvoke)
        : juce::Thread ("HapWebSocketServer"), port (portToListenOn), onMessage (std::move (callbackToInvoke))
    {
    }

    ~HapWebSocketServer() override
    {
        listener.close();
        stopThread (2000);
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
            std::shared_ptr<juce::StreamingSocket> client (listener.waitForNextConnection());

            if (client == nullptr)
                continue; // listener was closed (shutdown) or a transient accept error

            std::cout << "HapWebSocketServer: client connected" << std::endl;

            std::thread ([this, client]
            {
                handleClient (*client);
                std::cout << "HapWebSocketServer: client disconnected" << std::endl;
            }).detach();
        }
    }

private:
    int port;
    MessageCallback onMessage;
    juce::StreamingSocket listener;

    static constexpr const char* websocketGuid = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

    void handleClient (juce::StreamingSocket& socket)
    {
        if (! performHandshake (socket))
            return;

        while (! threadShouldExit())
        {
            juce::var message;
            if (! readTextFrame (socket, message))
                return;

            if (onMessage)
                onMessage (message);
        }
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

    // Reads WebSocket frames until a text message arrives (skipping any
    // ping/binary/continuation frames along the way). Returns false if the
    // client disconnected, sent a close frame, or the connection errored.
    bool readTextFrame (juce::StreamingSocket& socket, juce::var& outMessage)
    {
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

            std::vector<uint8_t> payload (static_cast<size_t> (payloadLength));
            if (payloadLength > 0 && ! readExact (socket, payload.data(), (int) payloadLength))
                return false;

            if (masked)
                for (size_t i = 0; i < payload.size(); ++i)
                    payload[i] = static_cast<uint8_t> (payload[i] ^ maskKey[i % 4]);

            if (opcode == 0x8) // close
                return false;

            if (opcode == 0x1) // text frame
            {
                auto text = juce::String::fromUTF8 (reinterpret_cast<const char*> (payload.data()), (int) payload.size());
                outMessage = juce::JSON::parse (text);
                return true;
            }

            // Unhandled opcode (binary, ping, pong, continuation) -- skip and read the next frame.
        }
    }
};
