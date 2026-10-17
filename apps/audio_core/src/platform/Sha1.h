#pragma once

#include <array>
#include <cstddef>
#include <cstdint>

namespace ghostdaw
{

// SHA-1 (RFC 3174). The WebSocket handshake (RFC 6455) hardcodes it for
// Sec-WebSocket-Accept, so there is no substituting a different digest.
std::array<uint8_t, 20> sha1 (const void* data, size_t length);

} // namespace ghostdaw
