#pragma once

#include "Sockets.h"

#include <atomic>
#include <cstdint>
#include <functional>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

namespace ghostdaw
{

// A WebSocket server (RFC 6455) on the loopback interface. GhostDAW runs
// three: control (8082), the browser tracks' audio streams (8083) and the
// plugin editor streams (8085).
//
// Each accepted connection is served on its own thread, up to
// Options::maxConnections (beyond that, a 503 and the connection is
// dropped). The handshake must complete within handshakeTimeoutMs. Client
// frames must be masked; fragmented messages are reassembled, up to
// maxMessageBytes; pings are answered; a protocol error closes the
// connection with the code RFC 6455 gives it (1002, 1007, 1009).
//
// Admission: the Origin policy (isAllowedOrigin) and the pairing token,
// presented as `?token=...` in the request. With a `checkToken`, a wrong or
// missing token is refused with 403 unless `allowUnauthenticated`, in
// which case the connection is admitted but marked so (the control server
// lets such a connection do one thing: pair).
//
// Handlers run on the connection's thread. onBinary's data is only valid
// during the call and may be modified in place (the stream server
// processes audio there and sends it straight back).
class WebSocketServer
{
public:
    class Connection
    {
    public:
        bool sendText (const std::string& text);
        bool sendBinary (const void* data, size_t size);

        // Ends the connection (any thread): sends a close frame, stops
        // writing, and lets the connection's thread read on for up to a
        // second (the client's own close frame, or its end of stream)
        // before the socket goes, so the close frame always gets there
        void close (uint16_t code = 1000, const std::string& reason = {});

        bool isAuthenticated() const { return authenticated.load(); }
        void markAuthenticated() { authenticated.store (true); }

        const std::string& getPath() const { return path; }     // the request's path, without the query
        const std::string& getOrigin() const { return origin; }
        std::string getPeerName() const { return socket != nullptr ? socket->peerName() : std::string(); }
        bool isOpen() const { return socket != nullptr && socket->isOpen(); }

        std::shared_ptr<void> context; // per-connection state, owned by the handlers

    private:
        friend class WebSocketServer;
        std::unique_ptr<TcpSocket> socket;
        std::mutex writeLock;
        std::atomic<bool> authenticated { false };
        std::atomic<bool> admitted { false };   // the handshake succeeded
        std::atomic<bool> closeSent { false };
        std::atomic<double> drainUntil { 0.0 }; // set by close(): read until then, then shut down
        std::string path, origin;
        std::vector<uint8_t> message; // the message being assembled, reused
        std::atomic<bool> finished { false }; // its thread is done: join it

        bool sendFrame (uint8_t opcode, const void* data, size_t size);
    };

    using ConnectionPtr = std::shared_ptr<Connection>;

    struct Handlers
    {
        std::function<void (const ConnectionPtr&, const std::string& text)> onText;
        std::function<void (const ConnectionPtr&, uint8_t* data, size_t size)> onBinary;
        std::function<void (const ConnectionPtr&)> onClose;
    };

    struct Options
    {
        std::string name = "ws";            // for the log
        uint16_t port = 0;                  // 0: any free port
        int maxConnections = 32;
        int handshakeTimeoutMs = 5000;
        size_t maxMessageBytes = 1024 * 1024;
        // Checks the token a client presents (empty when it sent none).
        // Null: no token is needed.
        std::function<bool (const std::string& token)> checkToken;
        bool allowUnauthenticated = false;
        // Extra origins to admit (NOPROD_ALLOWED_ORIGINS)
        std::vector<std::string> extraOrigins;
    };

    WebSocketServer (Options options, Handlers handlers);
    ~WebSocketServer();
    WebSocketServer (const WebSocketServer&) = delete;
    WebSocketServer& operator= (const WebSocketServer&) = delete;

    // Listens and starts accepting. False, with the reason, when the port
    // can't be bound (taken, say).
    bool start (std::string& error);

    // Closes every connection, waits for their threads, stops listening
    void stop();

    uint16_t getPort() const { return listener.getPort(); }
    int getConnectionCount();
    const Options& getOptions() const { return options; }

    void broadcastText (const std::string& text);
    void broadcastBinary (const void* data, size_t size);

    // Browsers send an Origin header with every WebSocket handshake, and any
    // web page can try ws://127.0.0.1. Only non-browser clients (no Origin)
    // and pages served from this machine are let in, plus `extra` (the
    // NOPROD_ALLOWED_ORIGINS list).
    static bool isAllowedOrigin (const std::string& origin, const std::vector<std::string>& extra = {});

    // Where the web app is hosted: allowed beside the local dev origins
    static constexpr const char* hostedOrigin = "https://agentchieflou.github.io";

    // The handshake request parsed, for tests
    struct Request
    {
        std::string method, target, path, version, token;
        std::vector<std::pair<std::string, std::string>> headers; // names lower-cased
        std::string header (const std::string& name) const;
    };
    static bool parseRequest (const std::string& text, Request& request);

private:
    Options options;
    Handlers handlers;
    TcpListener listener;
    std::thread acceptThread;
    std::atomic<bool> stopping { false };
    // Each connection's thread, owned here (never by the connection, whose
    // thread could otherwise finish before the accept thread had stored it)
    struct Worker
    {
        std::thread thread;
        ConnectionPtr connection;
    };
    std::mutex lock;
    std::vector<ConnectionPtr> connections; // those being served
    std::vector<Worker> workers;

    void acceptLoop();
    void serve (const ConnectionPtr& connection);
    bool performHandshake (Connection& connection);
    // Reads frames and dispatches messages until the connection ends
    void readLoop (const ConnectionPtr& connection);
    bool readFully (Connection& connection, void* buffer, size_t bytes, int timeoutMs);
    void reapFinished();
    static void respond (TcpSocket& socket, const char* status);
};

} // namespace ghostdaw
