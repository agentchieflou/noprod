#include "WebSocketServer.h"

#include "Base64.h"
#include "Log.h"
#include "Platform.h"
#include "Sha1.h"
#include "Strings.h"

#include <algorithm>
#include <cstring>

namespace ghostdaw
{

namespace
{
constexpr const char* websocketGuid = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
constexpr size_t maxRequestBytes = 16 * 1024;
constexpr int readSliceMs = 500; // how often a blocked read checks for shutdown

enum Opcode : uint8_t { continuation = 0x0, text = 0x1, binary = 0x2, closeFrame = 0x8, ping = 0x9, pong = 0xA };

bool isValidCloseCode (uint16_t code)
{
    if (code >= 3000 && code <= 4999)
        return true;
    switch (code)
    {
        case 1000: case 1001: case 1002: case 1003: case 1007: case 1008: case 1009: case 1010: case 1011:
            return true;
        default:
            return false;
    }
}

// Percent-decoding for the query string
std::string urlDecode (const std::string& text)
{
    std::string out;
    for (size_t i = 0; i < text.size(); ++i)
    {
        if (text[i] == '%' && i + 2 < text.size())
        {
            auto hex = text.substr (i + 1, 2);
            std::vector<uint8_t> byte;
            if (hexDecode (hex, byte))
            {
                out += static_cast<char> (byte[0]);
                i += 2;
                continue;
            }
        }
        out += text[i] == '+' ? ' ' : text[i];
    }
    return out;
}
} // namespace

// ------------------------------------------------------------- connection

bool WebSocketServer::Connection::sendText (const std::string& t)
{
    return sendFrame (Opcode::text, t.data(), t.size());
}

bool WebSocketServer::Connection::sendBinary (const void* data, size_t size)
{
    return sendFrame (Opcode::binary, data, size);
}

void WebSocketServer::Connection::close (uint16_t code, const std::string& reason)
{
    if (socket == nullptr)
        return;
    if (! closeSent.exchange (true))
    {
        std::vector<uint8_t> payload;
        payload.push_back (static_cast<uint8_t> (code >> 8));
        payload.push_back (static_cast<uint8_t> (code & 0xFF));
        auto text = reason.substr (0, 123);
        payload.insert (payload.end(), text.begin(), text.end());
        sendFrame (Opcode::closeFrame, payload.data(), payload.size());
    }
    socket->shutdown();
}

// Server-to-client frames are never masked (RFC 6455 5.1)
bool WebSocketServer::Connection::sendFrame (uint8_t opcode, const void* data, size_t size)
{
    if (socket == nullptr)
        return false;

    uint8_t header[10];
    size_t headerSize = 2;
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

    const std::lock_guard<std::mutex> guard (writeLock);
    if (! socket->writeAll (header, headerSize))
        return false;
    return size == 0 || socket->writeAll (data, size);
}

// ----------------------------------------------------------------- server

WebSocketServer::WebSocketServer (Options serverOptions, Handlers connectionHandlers)
    : options (std::move (serverOptions)), handlers (std::move (connectionHandlers))
{
}

WebSocketServer::~WebSocketServer()
{
    stop();
}

bool WebSocketServer::start (std::string& error)
{
    if (acceptThread.joinable())
    {
        error = "already started";
        return false;
    }
    if (! listener.listen (options.port, error))
        return false;
    stopping.store (false);
    acceptThread = std::thread ([this] { acceptLoop(); });
    Log::info (options.name + ": listening on 127.0.0.1:" + std::to_string (listener.getPort()));
    return true;
}

void WebSocketServer::stop()
{
    if (! acceptThread.joinable())
        return;

    stopping.store (true);
    listener.close();
    acceptThread.join();

    std::vector<ConnectionPtr> open;
    {
        const std::lock_guard<std::mutex> guard (lock);
        open = connections;
    }
    for (auto& connection : open)
        connection->close (1001, "server shutting down");

    // Their threads end once their reads return; join them all
    for (;;)
    {
        reapFinished();
        {
            const std::lock_guard<std::mutex> guard (lock);
            if (workers.empty())
                break;
        }
        sleepMs (5);
    }
    Log::info (options.name + ": stopped");
}

int WebSocketServer::getConnectionCount()
{
    const std::lock_guard<std::mutex> guard (lock);
    return static_cast<int> (connections.size());
}

void WebSocketServer::broadcastText (const std::string& t)
{
    std::vector<ConnectionPtr> targets;
    {
        const std::lock_guard<std::mutex> guard (lock);
        targets = connections;
    }
    for (auto& connection : targets)
        if (connection->isAuthenticated())
            connection->sendText (t);
}

void WebSocketServer::broadcastBinary (const void* data, size_t size)
{
    std::vector<ConnectionPtr> targets;
    {
        const std::lock_guard<std::mutex> guard (lock);
        targets = connections;
    }
    for (auto& connection : targets)
        if (connection->isAuthenticated())
            connection->sendBinary (data, size);
}

void WebSocketServer::reapFinished()
{
    std::vector<Worker> done;
    {
        const std::lock_guard<std::mutex> guard (lock);
        for (auto it = workers.begin(); it != workers.end();)
        {
            if (it->connection->finished.load())
            {
                done.push_back (std::move (*it));
                it = workers.erase (it);
            }
            else
            {
                ++it;
            }
        }
    }
    for (auto& worker : done)
        worker.thread.join();
}

void WebSocketServer::respond (TcpSocket& socket, const char* status)
{
    std::string response = std::string ("HTTP/1.1 ") + status + "\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";
    socket.writeAll (response.data(), response.size());
}

void WebSocketServer::acceptLoop()
{
    while (! stopping.load())
    {
        auto socket = listener.accept (readSliceMs);
        reapFinished();
        if (socket == nullptr)
            continue;

        const std::lock_guard<std::mutex> guard (lock);
        if (static_cast<int> (connections.size()) >= options.maxConnections)
        {
            Log::warn (options.name + ": refused a connection, " + std::to_string (connections.size()) + " already open");
            respond (*socket, "503 Service Unavailable");
            continue; // the socket closes here
        }
        auto connection = std::make_shared<Connection>();
        connection->socket = std::move (socket);
        connections.push_back (connection);
        workers.push_back ({ std::thread ([this, connection] { serve (connection); }), connection });
    }
}

void WebSocketServer::serve (const ConnectionPtr& connection)
{
    bool admitted = performHandshake (*connection);
    if (admitted)
    {
        Log::debug (options.name + ": " + connection->getPeerName() + " connected");
        readLoop (connection);
    }

    // Close now: replies still queued elsewhere may hold the connection,
    // and the client waits for the TCP close. Under the write lock, so a
    // reply being written finishes first and later ones see a closed socket.
    {
        const std::lock_guard<std::mutex> guard (connection->writeLock);
        connection->socket->shutdown();
    }
    {
        const std::lock_guard<std::mutex> guard (lock);
        connections.erase (std::remove (connections.begin(), connections.end(), connection), connections.end());
    }
    if (admitted)
    {
        if (handlers.onClose)
            handlers.onClose (connection);
        Log::debug (options.name + ": " + connection->getPeerName() + " disconnected");
    }
    connection->finished.store (true); // the accept thread (or stop) joins it now
}

std::string WebSocketServer::Request::header (const std::string& name) const
{
    auto wanted = lowerCase (name);
    for (auto& [key, value] : headers)
        if (key == wanted)
            return value;
    return {};
}

bool WebSocketServer::parseRequest (const std::string& text, Request& request)
{
    request = {};
    auto lines = split (text, '\n');
    if (lines.empty())
        return false;

    auto requestLine = split (trim (lines[0]), ' ');
    if (requestLine.size() != 3)
        return false;
    request.method = requestLine[0];
    request.target = requestLine[1];
    request.version = requestLine[2];

    auto query = request.target.find ('?');
    request.path = request.target.substr (0, query);
    if (query != std::string::npos)
    {
        for (auto& pair : split (request.target.substr (query + 1), '&'))
        {
            auto equals = pair.find ('=');
            if (equals != std::string::npos && urlDecode (pair.substr (0, equals)) == "token")
                request.token = urlDecode (pair.substr (equals + 1));
        }
    }

    for (size_t i = 1; i < lines.size(); ++i)
    {
        auto line = trim (lines[i]);
        if (line.empty())
            break;
        auto colon = line.find (':');
        if (colon == std::string::npos)
            return false;
        request.headers.emplace_back (lowerCase (trim (line.substr (0, colon))), trim (line.substr (colon + 1)));
    }
    return true;
}

bool WebSocketServer::isAllowedOrigin (const std::string& origin, const std::vector<std::string>& extra)
{
    if (origin.empty())
        return true;

    for (auto& allowed : extra)
        if (trim (allowed) == origin)
            return true;

    // An Origin is exactly scheme://host[:port]
    auto separator = origin.find ("://");
    if (separator == std::string::npos)
        return false;
    auto scheme = origin.substr (0, separator);
    auto rest = origin.substr (separator + 3);
    std::string host;
    if (startsWith (rest, "["))
    {
        auto close = rest.find (']');
        if (close == std::string::npos)
            return false;
        host = rest.substr (0, close + 1);
    }
    else
    {
        host = rest.substr (0, rest.find (':'));
    }
    auto port = rest.substr (host.size());
    bool portOk = port.empty() || (startsWith (port, ":") && port.size() > 1 && containsOnly (port.substr (1), "0123456789"));

    return (scheme == "http" || scheme == "https") && portOk
        && (host == "localhost" || host == "127.0.0.1" || host == "[::1]");
}

bool WebSocketServer::performHandshake (Connection& connection)
{
    auto& socket = *connection.socket;
    auto deadline = monotonicMs() + options.handshakeTimeoutMs;

    // Read the HTTP upgrade request up to the blank line that ends the
    // header block, within the handshake timeout
    std::string request;
    char buffer[512];
    while (! endsWith (request, "\r\n\r\n"))
    {
        auto remaining = static_cast<int> (deadline - monotonicMs());
        if (remaining <= 0 || stopping.load())
        {
            Log::warn (options.name + ": " + connection.getPeerName() + " did not finish the handshake in time");
            return false;
        }
        auto got = socket.read (buffer, sizeof (buffer), std::min (remaining, readSliceMs));
        if (got == -2)
            continue;
        if (got <= 0)
            return false;
        request.append (buffer, static_cast<size_t> (got));
        if (request.size() > maxRequestBytes)
        {
            respond (socket, "431 Request Header Fields Too Large");
            return false;
        }
    }

    Request parsed;
    if (! parseRequest (request, parsed) || parsed.method != "GET"
        || ! equalsIgnoreCase (parsed.header ("Upgrade"), "websocket")
        || lowerCase (parsed.header ("Connection")).find ("upgrade") == std::string::npos
        || parsed.header ("Sec-WebSocket-Version") != "13")
    {
        respond (socket, "400 Bad Request");
        return false;
    }

    auto key = parsed.header ("Sec-WebSocket-Key");
    std::vector<uint8_t> keyBytes;
    if (! base64Decode (key, keyBytes) || keyBytes.size() != 16)
    {
        respond (socket, "400 Bad Request");
        return false;
    }

    connection.origin = parsed.header ("Origin");
    if (! isAllowedOrigin (connection.origin, options.extraOrigins))
    {
        Log::warn (options.name + ": rejected a connection from origin " + connection.origin);
        respond (socket, "403 Forbidden");
        return false;
    }

    if (options.checkToken)
    {
        if (options.checkToken (parsed.token))
        {
            connection.markAuthenticated();
        }
        else if (! options.allowUnauthenticated)
        {
            Log::warn (options.name + ": rejected a connection with " + (parsed.token.empty() ? "no" : "a wrong") + " pairing token");
            respond (socket, "403 Forbidden");
            return false;
        }
    }
    else
    {
        connection.markAuthenticated();
    }
    connection.path = parsed.path;

    auto material = key + websocketGuid;
    auto digest = sha1 (material.data(), material.size());
    auto response = "HTTP/1.1 101 Switching Protocols\r\n"
                    "Upgrade: websocket\r\n"
                    "Connection: Upgrade\r\n"
                    "Sec-WebSocket-Accept: " + base64Encode (digest.data(), digest.size()) + "\r\n\r\n";
    return socket.writeAll (response.data(), response.size());
}

bool WebSocketServer::readFully (Connection& connection, void* buffer, size_t bytes, int timeoutMs)
{
    auto* out = static_cast<uint8_t*> (buffer);
    size_t have = 0;
    auto deadline = timeoutMs < 0 ? 0.0 : monotonicMs() + timeoutMs;
    while (have < bytes)
    {
        if (stopping.load())
            return false;
        auto slice = readSliceMs;
        if (timeoutMs >= 0)
        {
            auto remaining = static_cast<int> (deadline - monotonicMs());
            if (remaining <= 0)
                return false;
            slice = std::min (slice, remaining);
        }
        auto got = connection.socket->read (out + have, bytes - have, slice);
        if (got == -2)
            continue;
        if (got <= 0)
            return false;
        have += static_cast<size_t> (got);
    }
    return true;
}

void WebSocketServer::readLoop (const ConnectionPtr& connectionPtr)
{
    auto& connection = *connectionPtr;
    auto& message = connection.message;
    message.clear();
    bool messageInProgress = false;
    uint8_t messageOpcode = 0;

    // A protocol failure: tell the client why, then drop it
    auto fail = [&] (uint16_t code, const char* why)
    {
        Log::warn (options.name + ": closing " + connection.getPeerName() + ": " + why);
        connection.close (code, why);
    };

    for (;;)
    {
        uint8_t header[2];
        if (! readFully (connection, header, 2, -1))
            return;

        bool fin = (header[0] & 0x80) != 0;
        bool rsv = (header[0] & 0x70) != 0;
        auto opcode = static_cast<uint8_t> (header[0] & 0x0F);
        bool masked = (header[1] & 0x80) != 0;
        uint64_t length = header[1] & 0x7F;

        if (rsv)
            return fail (1002, "reserved bits set (no extension was negotiated)");

        if (length == 126)
        {
            uint8_t ext[2];
            if (! readFully (connection, ext, 2, 10000))
                return;
            length = (static_cast<uint64_t> (ext[0]) << 8) | ext[1];
        }
        else if (length == 127)
        {
            uint8_t ext[8];
            if (! readFully (connection, ext, 8, 10000))
                return;
            length = 0;
            for (int i = 0; i < 8; ++i)
                length = (length << 8) | ext[i];
            if ((length >> 63) != 0)
                return fail (1002, "bad frame length");
        }

        // Clients must mask every frame (RFC 6455 5.1)
        if (! masked)
            return fail (1002, "client frame not masked");
        uint8_t mask[4];
        if (! readFully (connection, mask, 4, 10000))
            return;

        bool isControl = (opcode & 0x8) != 0;
        if (isControl)
        {
            if (! fin || length > 125)
                return fail (1002, "bad control frame");
            if (opcode != Opcode::closeFrame && opcode != Opcode::ping && opcode != Opcode::pong)
                return fail (1002, "unknown control opcode");

            uint8_t payload[125];
            if (length > 0 && ! readFully (connection, payload, static_cast<size_t> (length), 10000))
                return;
            for (size_t i = 0; i < length; ++i)
                payload[i] ^= mask[i % 4];

            if (opcode == Opcode::ping)
            {
                connection.sendFrame (Opcode::pong, payload, static_cast<size_t> (length));
                continue;
            }
            if (opcode == Opcode::pong)
                continue;

            // Close: echo the code back, then drop the connection
            uint16_t code = 1000;
            if (length == 1)
                return fail (1002, "close frame with a one-byte payload");
            if (length >= 2)
            {
                code = static_cast<uint16_t> ((payload[0] << 8) | payload[1]);
                if (! isValidCloseCode (code))
                    return fail (1002, "bad close code");
                if (! isValidUtf8 (reinterpret_cast<const char*> (payload + 2), static_cast<size_t> (length - 2)))
                    return fail (1007, "close reason is not UTF-8");
            }
            connection.close (code);
            return;
        }

        if (opcode != Opcode::continuation && opcode != Opcode::text && opcode != Opcode::binary)
            return fail (1002, "unknown opcode");
        if (opcode == Opcode::continuation && ! messageInProgress)
            return fail (1002, "continuation frame without a message");
        if (opcode != Opcode::continuation && messageInProgress)
            return fail (1002, "new message while another is in progress");

        auto already = message.size();
        if (length > options.maxMessageBytes || already + length > options.maxMessageBytes)
            return fail (1009, "message too big");

        if (! messageInProgress)
        {
            messageOpcode = opcode;
            messageInProgress = true;
        }

        message.resize (already + static_cast<size_t> (length)); // keeps its capacity: no allocation per frame once warm
        if (length > 0 && ! readFully (connection, message.data() + already, static_cast<size_t> (length), 30000))
            return;
        for (size_t i = 0; i < length; ++i)
            message[already + i] ^= mask[i % 4];

        if (! fin)
            continue;

        messageInProgress = false;
        if (messageOpcode == Opcode::text)
        {
            if (! isValidUtf8 (reinterpret_cast<const char*> (message.data()), message.size()))
                return fail (1007, "text is not UTF-8");
            if (handlers.onText)
                handlers.onText (connectionPtr, std::string (message.begin(), message.end()));
        }
        else if (handlers.onBinary)
        {
            handlers.onBinary (connectionPtr, message.data(), message.size());
        }
        message.clear();
    }
}

} // namespace ghostdaw
