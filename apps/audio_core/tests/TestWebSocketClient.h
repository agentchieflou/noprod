#pragma once

// A raw WebSocket client for the server tests: it writes whatever frames
// the test asks for, well-formed or not, and reads frames back.

#include "platform/Base64.h"
#include "platform/Platform.h"
#include "platform/Random.h"
#include "platform/Sockets.h"
#include "platform/Strings.h"

#include <cstring>
#include <string>
#include <vector>

struct TestWebSocketClient
{
    ghostdaw::TcpSocket socket;
    std::string responseHeaders;

    struct Frame
    {
        uint8_t opcode = 0;
        bool fin = true;
        std::vector<uint8_t> payload;
        std::string text() const { return std::string (payload.begin(), payload.end()); }
        uint16_t closeCode() const
        {
            return payload.size() >= 2 ? static_cast<uint16_t> ((payload[0] << 8) | payload[1]) : 0;
        }
    };

    // Performs the handshake; returns the HTTP status (101 when upgraded),
    // 0 when the connection failed before any response
    int connect (uint16_t port, const std::string& path = "/", const std::string& origin = {},
                 const std::string& extraHeaders = {}, const std::string& key = "dGhlIHNhbXBsZSBub25jZQ==",
                 bool upgradeHeaders = true)
    {
        if (! socket.connect (port))
            return 0;
        std::string request = "GET " + path + " HTTP/1.1\r\nHost: 127.0.0.1:" + std::to_string (port) + "\r\n";
        if (upgradeHeaders)
            request += "Upgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\n";
        request += "Sec-WebSocket-Key: " + key + "\r\n";
        if (! origin.empty())
            request += "Origin: " + origin + "\r\n";
        request += extraHeaders + "\r\n";
        if (! socket.writeAll (request.data(), request.size()))
            return 0;
        return readResponse();
    }

    // Reads an HTTP response's status line and headers
    int readResponse (int timeoutMs = 5000)
    {
        responseHeaders.clear();
        char c;
        auto deadline = ghostdaw::monotonicMs() + timeoutMs;
        while (! ghostdaw::endsWith (responseHeaders, "\r\n\r\n"))
        {
            auto remaining = static_cast<int> (deadline - ghostdaw::monotonicMs());
            if (remaining <= 0 || socket.read (&c, 1, remaining) != 1)
                return 0;
            responseHeaders += c;
        }
        if (! ghostdaw::startsWith (responseHeaders, "HTTP/1.1 ") || responseHeaders.size() < 12)
            return 0;
        return std::stoi (responseHeaders.substr (9, 3));
    }

    std::string responseHeader (const std::string& name) const
    {
        for (auto& line : ghostdaw::split (responseHeaders, '\n'))
        {
            auto colon = line.find (':');
            if (colon != std::string::npos && ghostdaw::equalsIgnoreCase (ghostdaw::trim (line.substr (0, colon)), name))
                return ghostdaw::trim (line.substr (colon + 1));
        }
        return {};
    }

    bool sendFrame (uint8_t opcode, const void* data, size_t size, bool fin = true, bool mask = true, uint8_t rsv = 0)
    {
        std::vector<uint8_t> frame;
        frame.push_back (static_cast<uint8_t> ((fin ? 0x80 : 0) | (rsv << 4) | opcode));
        uint8_t maskBit = mask ? 0x80 : 0;
        if (size < 126)
        {
            frame.push_back (static_cast<uint8_t> (maskBit | size));
        }
        else if (size <= 0xFFFF)
        {
            frame.push_back (static_cast<uint8_t> (maskBit | 126));
            frame.push_back (static_cast<uint8_t> (size >> 8));
            frame.push_back (static_cast<uint8_t> (size & 0xFF));
        }
        else
        {
            frame.push_back (static_cast<uint8_t> (maskBit | 127));
            for (int i = 0; i < 8; ++i)
                frame.push_back (static_cast<uint8_t> ((static_cast<uint64_t> (size) >> (56 - 8 * i)) & 0xFF));
        }
        uint8_t key[4] = { 0x12, 0x34, 0x56, 0x78 };
        if (mask)
            frame.insert (frame.end(), key, key + 4);
        auto* bytes = static_cast<const uint8_t*> (data);
        for (size_t i = 0; i < size; ++i)
            frame.push_back (mask ? static_cast<uint8_t> (bytes[i] ^ key[i % 4]) : bytes[i]);
        return socket.writeAll (frame.data(), frame.size());
    }

    bool sendText (const std::string& text, bool fin = true, bool mask = true) { return sendFrame (0x1, text.data(), text.size(), fin, mask); }
    bool sendBinary (const std::vector<uint8_t>& data) { return sendFrame (0x2, data.data(), data.size()); }
    bool sendContinuation (const std::string& text, bool fin) { return sendFrame (0x0, text.data(), text.size(), fin); }
    bool sendPing (const std::string& payload = "hi") { return sendFrame (0x9, payload.data(), payload.size()); }
    bool sendClose (uint16_t code, const std::string& reason = {})
    {
        std::vector<uint8_t> payload { static_cast<uint8_t> (code >> 8), static_cast<uint8_t> (code & 0xFF) };
        payload.insert (payload.end(), reason.begin(), reason.end());
        return sendFrame (0x8, payload.data(), payload.size());
    }

    // Reads one (server, unmasked) frame
    bool readFrame (Frame& frame, int timeoutMs = 5000)
    {
        uint8_t header[2];
        if (! socket.readExact (header, 2, timeoutMs))
            return false;
        frame.fin = (header[0] & 0x80) != 0;
        frame.opcode = header[0] & 0x0F;
        uint64_t length = header[1] & 0x7F;
        if ((header[1] & 0x80) != 0)
            return false; // the server must not mask
        if (length == 126)
        {
            uint8_t ext[2];
            if (! socket.readExact (ext, 2, timeoutMs)) return false;
            length = (static_cast<uint64_t> (ext[0]) << 8) | ext[1];
        }
        else if (length == 127)
        {
            uint8_t ext[8];
            if (! socket.readExact (ext, 8, timeoutMs)) return false;
            length = 0;
            for (int i = 0; i < 8; ++i)
                length = (length << 8) | ext[i];
        }
        frame.payload.resize (static_cast<size_t> (length));
        return length == 0 || socket.readExact (frame.payload.data(), frame.payload.size(), timeoutMs);
    }

    // Reads frames until a text frame arrives (skipping others)
    bool readText (std::string& text, int timeoutMs = 5000)
    {
        Frame frame;
        while (readFrame (frame, timeoutMs))
        {
            if (frame.opcode == 0x1)
            {
                text = frame.text();
                return true;
            }
            if (frame.opcode == 0x8)
                return false;
        }
        return false;
    }

    // True once the server has closed the TCP connection (within timeoutMs)
    bool waitForClose (int timeoutMs = 5000)
    {
        char c;
        auto deadline = ghostdaw::monotonicMs() + timeoutMs;
        for (;;)
        {
            auto remaining = static_cast<int> (deadline - ghostdaw::monotonicMs());
            if (remaining <= 0)
                return false;
            auto got = socket.read (&c, 1, remaining);
            if (got == 0 || got == -1)
                return true;
            if (got == -2)
                return false;
        }
    }
};
