#include "Sockets.h"

#include "Platform.h"

#include <cstring>
#include <mutex>
#include <vector>

#if GHOSTDAW_WINDOWS
 #include <winsock2.h>
 #include <ws2tcpip.h>
 #include <iphlpapi.h>
 using socklen_type = int;
 static constexpr int sendFlags = 0;
 // WSAPoll refuses POLLPRI (part of POLLIN on Windows); the *NORM events are what a stream socket has
 static constexpr short readEvents = POLLRDNORM, writeEvents = POLLWRNORM;
#else
 #include <arpa/inet.h>
 #include <cerrno>
 #include <fcntl.h>
 #include <ifaddrs.h>
 #include <netinet/in.h>
 #include <netinet/tcp.h>
 #include <poll.h>
 #include <sys/socket.h>
 #include <unistd.h>
 using socklen_type = socklen_t;
 static constexpr short readEvents = POLLIN, writeEvents = POLLOUT;
 #if GHOSTDAW_LINUX
  static constexpr int sendFlags = MSG_NOSIGNAL;
 #else
  static constexpr int sendFlags = 0;
 #endif
#endif

namespace ghostdaw
{

namespace
{

#if GHOSTDAW_WINDOWS
using NativeSocket = SOCKET;
int lastError() { return WSAGetLastError(); }
bool wouldBlock (int error) { return error == WSAEWOULDBLOCK || error == WSAEINPROGRESS; }
bool wasInterrupted (int) { return false; }
void closeNative (NativeSocket s) { closesocket (s); }
int pollOne (NativeSocket s, short events, int timeoutMs)
{
    WSAPOLLFD fd { s, events, 0 };
    auto result = WSAPoll (&fd, 1, timeoutMs);
    if (result > 0)
        return fd.revents;
    return result;
}
#else
using NativeSocket = int;
int lastError() { return errno; }
bool wouldBlock (int error) { return error == EAGAIN || error == EWOULDBLOCK || error == EINPROGRESS; }
bool wasInterrupted (int error) { return error == EINTR; }
void closeNative (NativeSocket s) { ::close (s); }
int pollOne (NativeSocket s, short events, int timeoutMs)
{
    pollfd fd { s, events, 0 };
    auto result = ::poll (&fd, 1, timeoutMs);
    if (result > 0)
        return fd.revents;
    return result;
}
#endif

NativeSocket native (intptr_t handle) { return static_cast<NativeSocket> (handle); }

std::string errorText (int error)
{
   #if GHOSTDAW_WINDOWS
    return "Winsock error " + std::to_string (error);
   #else
    return std::strerror (error);
   #endif
}

sockaddr_in loopbackAddress (uint16_t port)
{
    sockaddr_in address {};
    address.sin_family = AF_INET;
    address.sin_port = htons (port);
    address.sin_addr.s_addr = htonl (INADDR_LOOPBACK);
    return address;
}

void setBlocking (NativeSocket s, bool blocking)
{
   #if GHOSTDAW_WINDOWS
    u_long mode = blocking ? 0 : 1;
    ioctlsocket (s, FIONBIO, &mode);
   #else
    auto flags = fcntl (s, F_GETFL, 0);
    fcntl (s, F_SETFL, blocking ? (flags & ~O_NONBLOCK) : (flags | O_NONBLOCK));
   #endif
}

} // namespace

bool TcpSocket::initialise()
{
   #if GHOSTDAW_WINDOWS
    static std::once_flag once;
    static bool ok = false;
    std::call_once (once, []
    {
        WSADATA data;
        ok = WSAStartup (MAKEWORD (2, 2), &data) == 0;
    });
    return ok;
   #else
    return true;
   #endif
}

TcpSocket::TcpSocket (intptr_t nativeHandle) : handle (nativeHandle)
{
    configure();
}

TcpSocket::~TcpSocket()
{
    if (handle != none)
        closeNative (native (handle));
}

void TcpSocket::configure()
{
    auto s = native (handle);
    int one = 1;
    setsockopt (s, IPPROTO_TCP, TCP_NODELAY, reinterpret_cast<const char*> (&one), sizeof (one));
   #if GHOSTDAW_MAC
    setsockopt (s, SOL_SOCKET, SO_NOSIGPIPE, &one, sizeof (one));
   #endif
    // A peer that stops reading fails our writes instead of blocking them
   #if GHOSTDAW_WINDOWS
    DWORD sendTimeout = 5000;
    setsockopt (s, SOL_SOCKET, SO_SNDTIMEO, reinterpret_cast<const char*> (&sendTimeout), sizeof (sendTimeout));
   #else
    timeval sendTimeout { 5, 0 };
    setsockopt (s, SOL_SOCKET, SO_SNDTIMEO, &sendTimeout, sizeof (sendTimeout));
   #endif
}

bool TcpSocket::connect (uint16_t port, int timeoutMs)
{
    return connectTo ("127.0.0.1", port, timeoutMs);
}

bool TcpSocket::connectTo (const std::string& ipv4, uint16_t port, int timeoutMs)
{
    if (! initialise() || handle != none)
        return false;

    sockaddr_in address = loopbackAddress (port);
    if (inet_pton (AF_INET, ipv4.c_str(), &address.sin_addr) != 1)
        return false;

    auto s = ::socket (AF_INET, SOCK_STREAM, 0);
   #if GHOSTDAW_WINDOWS
    if (s == INVALID_SOCKET)
        return false;
   #else
    if (s < 0)
        return false;
   #endif

    // Non-blocking connect so the timeout applies
    setBlocking (s, false);
    auto result = ::connect (s, reinterpret_cast<sockaddr*> (&address), sizeof (address));
    if (result != 0 && ! wouldBlock (lastError()))
    {
        closeNative (s);
        return false;
    }
    if (result != 0)
    {
        auto events = pollOne (s, writeEvents, timeoutMs);
        int error = 0;
        socklen_type length = sizeof (error);
        if (events <= 0 || getsockopt (s, SOL_SOCKET, SO_ERROR, reinterpret_cast<char*> (&error), &length) != 0 || error != 0)
        {
            closeNative (s);
            return false;
        }
    }
    setBlocking (s, true);

    handle = static_cast<intptr_t> (s);
    configure();
    return true;
}

int TcpSocket::read (void* buffer, size_t maxBytes, int timeoutMs)
{
    if (handle == none || closing.load())
        return -1;

    auto s = native (handle);
    for (;;)
    {
        auto events = pollOne (s, readEvents, timeoutMs);
        if (closing.load())
            return -1;
        if (events == 0)
            return -2;
        if (events < 0)
        {
            if (wasInterrupted (lastError()))
                continue;
            return -1;
        }
        // POLLHUP / POLLERR fall through to recv, which reports 0 or -1

        auto got = ::recv (s, static_cast<char*> (buffer), static_cast<int> (maxBytes), 0);
        if (got < 0 && wasInterrupted (lastError()))
            continue;
        if (got < 0 && wouldBlock (lastError()))
            continue; // a spurious wake-up
        return got < 0 ? -1 : static_cast<int> (got);
    }
}

bool TcpSocket::readExact (void* buffer, size_t bytes, int timeoutMs)
{
    auto* out = static_cast<uint8_t*> (buffer);
    size_t have = 0;
    auto deadline = timeoutMs < 0 ? 0.0 : monotonicMs() + timeoutMs;
    while (have < bytes)
    {
        int remaining = -1;
        if (timeoutMs >= 0)
        {
            remaining = static_cast<int> (deadline - monotonicMs());
            if (remaining < 0)
                return false;
        }
        auto got = read (out + have, bytes - have, remaining);
        if (got <= 0)
            return false;
        have += static_cast<size_t> (got);
    }
    return true;
}

bool TcpSocket::writeAll (const void* data, size_t bytes)
{
    if (handle == none || closing.load())
        return false;

    auto* p = static_cast<const char*> (data);
    auto s = native (handle);
    while (bytes > 0)
    {
        auto sent = ::send (s, p, static_cast<int> (bytes), sendFlags);
        if (sent < 0)
        {
            if (wasInterrupted (lastError()))
                continue;
            return false;
        }
        if (sent == 0)
            return false;
        p += sent;
        bytes -= static_cast<size_t> (sent);
    }
    return true;
}

void TcpSocket::shutdown()
{
    if (handle == none || closing.exchange (true))
        return;
   #if GHOSTDAW_WINDOWS
    ::shutdown (native (handle), SD_BOTH);
   #else
    ::shutdown (native (handle), SHUT_RDWR);
   #endif
}

std::string TcpSocket::peerName() const
{
    if (handle == none)
        return {};
    sockaddr_in address {};
    socklen_type length = sizeof (address);
    if (getpeername (native (handle), reinterpret_cast<sockaddr*> (&address), &length) != 0)
        return {};
    char text[INET_ADDRSTRLEN] = {};
    inet_ntop (AF_INET, &address.sin_addr, text, sizeof (text));
    return std::string (text) + ":" + std::to_string (ntohs (address.sin_port));
}

// --------------------------------------------------------------- listener

TcpListener::~TcpListener()
{
    close();
    if (handle != TcpSocket::none)
        closeNative (native (handle));
}

bool TcpListener::listen (uint16_t port, std::string& error)
{
    if (! TcpSocket::initialise())
    {
        error = "could not start Winsock";
        return false;
    }
    if (handle != TcpSocket::none)
    {
        error = "already listening";
        return false;
    }

    auto s = ::socket (AF_INET, SOCK_STREAM, 0);
   #if GHOSTDAW_WINDOWS
    if (s == INVALID_SOCKET)
   #else
    if (s < 0)
   #endif
    {
        error = "socket(): " + errorText (lastError());
        return false;
    }

    int one = 1;
   #if GHOSTDAW_WINDOWS
    // Nobody else may bind this port while we hold it (SO_REUSEADDR would
    // let another process take it over on Windows)
    setsockopt (s, SOL_SOCKET, SO_EXCLUSIVEADDRUSE, reinterpret_cast<const char*> (&one), sizeof (one));
   #else
    // A restart right after a shutdown mustn't wait out TIME_WAIT; a port
    // that another process is listening on still fails to bind
    setsockopt (s, SOL_SOCKET, SO_REUSEADDR, &one, sizeof (one));
   #endif

    auto address = loopbackAddress (port);
    if (::bind (s, reinterpret_cast<sockaddr*> (&address), sizeof (address)) != 0)
    {
        error = "bind 127.0.0.1:" + std::to_string (port) + ": " + errorText (lastError());
        closeNative (s);
        return false;
    }
    if (::listen (s, 16) != 0)
    {
        error = "listen(): " + errorText (lastError());
        closeNative (s);
        return false;
    }

    sockaddr_in bound {};
    socklen_type length = sizeof (bound);
    if (getsockname (s, reinterpret_cast<sockaddr*> (&bound), &length) == 0)
        boundPort = ntohs (bound.sin_port);
    else
        boundPort = port;

    handle = static_cast<intptr_t> (s);
    closing.store (false);
    return true;
}

std::unique_ptr<TcpSocket> TcpListener::accept (int timeoutMs)
{
    if (handle == TcpSocket::none || closing.load())
        return nullptr;

    auto s = native (handle);
    auto events = pollOne (s, readEvents, timeoutMs);
    if (events <= 0 || closing.load())
        return nullptr;

    sockaddr_in peer {};
    socklen_type length = sizeof (peer);
    auto client = ::accept (s, reinterpret_cast<sockaddr*> (&peer), &length);
   #if GHOSTDAW_WINDOWS
    if (client == INVALID_SOCKET)
        return nullptr;
   #else
    if (client < 0)
        return nullptr;
   #endif

    // Belt and braces: the socket is bound to loopback, so every peer is local
    if (peer.sin_family != AF_INET || ntohl (peer.sin_addr.s_addr) >> 24 != 127)
    {
        closeNative (client);
        return nullptr;
    }
    return std::make_unique<TcpSocket> (static_cast<intptr_t> (client));
}

void TcpListener::close()
{
    if (handle == TcpSocket::none || closing.exchange (true))
        return;
   #if GHOSTDAW_WINDOWS
    ::shutdown (native (handle), SD_BOTH);
   #else
    ::shutdown (native (handle), SHUT_RDWR);
   #endif
}

std::string firstNonLoopbackIpv4()
{
   #if GHOSTDAW_WINDOWS
    TcpSocket::initialise();
    ULONG size = 16 * 1024;
    std::vector<uint8_t> buffer (size);
    auto* adapters = reinterpret_cast<IP_ADAPTER_ADDRESSES*> (buffer.data());
    if (GetAdaptersAddresses (AF_INET, GAA_FLAG_SKIP_ANYCAST | GAA_FLAG_SKIP_MULTICAST | GAA_FLAG_SKIP_DNS_SERVER, nullptr, adapters, &size) != NO_ERROR)
        return {};
    for (auto* adapter = adapters; adapter != nullptr; adapter = adapter->Next)
    {
        if (adapter->OperStatus != IfOperStatusUp || adapter->IfType == IF_TYPE_SOFTWARE_LOOPBACK)
            continue;
        for (auto* unicast = adapter->FirstUnicastAddress; unicast != nullptr; unicast = unicast->Next)
        {
            if (unicast->Address.lpSockaddr->sa_family != AF_INET)
                continue;
            auto* address = reinterpret_cast<sockaddr_in*> (unicast->Address.lpSockaddr);
            char text[INET_ADDRSTRLEN] = {};
            inet_ntop (AF_INET, &address->sin_addr, text, sizeof (text));
            return text;
        }
    }
    return {};
   #else
    ifaddrs* list = nullptr;
    if (getifaddrs (&list) != 0)
        return {};
    std::string found;
    for (auto* entry = list; entry != nullptr && found.empty(); entry = entry->ifa_next)
    {
        if (entry->ifa_addr == nullptr || entry->ifa_addr->sa_family != AF_INET)
            continue;
        auto* address = reinterpret_cast<sockaddr_in*> (entry->ifa_addr);
        if (ntohl (address->sin_addr.s_addr) >> 24 == 127)
            continue;
        char text[INET_ADDRSTRLEN] = {};
        inet_ntop (AF_INET, &address->sin_addr, text, sizeof (text));
        found = text;
    }
    freeifaddrs (list);
    return found;
   #endif
}

} // namespace ghostdaw
