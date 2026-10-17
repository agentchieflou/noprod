#pragma once

#include <atomic>
#include <cstdint>
#include <memory>
#include <string>

namespace ghostdaw
{

// TCP over the loopback interface only: GhostDAW never listens on a
// network-facing address. Blocking sockets with timeouts; every read and
// accept polls with a timeout so a thread can be asked to stop.
class TcpSocket
{
public:
    // The invalid handle
    static constexpr intptr_t none = -1;

    // Winsock needs starting once per process; a no-op elsewhere. Called by
    // the listener and connect(), so there is no need to call it directly.
    static bool initialise();

    TcpSocket() = default;
    explicit TcpSocket (intptr_t nativeHandle);
    ~TcpSocket();
    TcpSocket (TcpSocket&&) = delete;
    TcpSocket& operator= (TcpSocket&&) = delete;

    // Connects to 127.0.0.1:port (tests, and the scan worker's parent)
    bool connect (uint16_t port, int timeoutMs = 5000);
    // Connects to an IPv4 address in dotted form
    bool connectTo (const std::string& ipv4, uint16_t port, int timeoutMs = 5000);

    // Returns the bytes read (> 0); 0 when the peer closed; -1 on an error
    // or after shutdown(); -2 when `timeoutMs` passed with nothing to read
    // (-1 for timeoutMs < 0: wait forever).
    int read (void* buffer, size_t maxBytes, int timeoutMs);

    // Reads exactly `bytes` or fails (closed, error, or the deadline passed)
    bool readExact (void* buffer, size_t bytes, int timeoutMs);

    // Writes everything or fails. Bounded by the send timeout (5 s): a peer
    // that stops reading can't block a writer forever.
    bool writeAll (const void* data, size_t bytes);

    // Any thread: ends the connection; a read in progress on another
    // thread returns. The handle is closed by the destructor.
    void shutdown();

    bool isOpen() const { return handle != none && ! closing.load(); }
    intptr_t nativeHandle() const { return handle; }

    // "127.0.0.1:54321"
    std::string peerName() const;

private:
    intptr_t handle = none;
    std::atomic<bool> closing { false };

    void configure();
};

class TcpListener
{
public:
    TcpListener() = default;
    ~TcpListener();
    TcpListener (const TcpListener&) = delete;
    TcpListener& operator= (const TcpListener&) = delete;

    // Binds 127.0.0.1:port (0: any free port, see getPort()) and listens.
    // False with the OS's reason in `error` (a taken port, for one).
    bool listen (uint16_t port, std::string& error);

    uint16_t getPort() const { return boundPort; }
    bool isListening() const { return handle != TcpSocket::none && ! closing.load(); }

    // The next connection, or nullptr after `timeoutMs` (or once closed)
    std::unique_ptr<TcpSocket> accept (int timeoutMs);

    // Any thread: stops accepting; an accept in progress returns
    void close();

private:
    intptr_t handle = TcpSocket::none;
    uint16_t boundPort = 0;
    std::atomic<bool> closing { false };
};

// The machine's first non-loopback IPv4 address in dotted form, or empty
// (tests check that the servers can't be reached through it)
std::string firstNonLoopbackIpv4();

} // namespace ghostdaw
