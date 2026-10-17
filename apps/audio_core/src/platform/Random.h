#pragma once

#include <cstdint>
#include <string>
#include <vector>

namespace ghostdaw
{

// Bytes from the OS's cryptographic generator (the pairing token and
// code, editor ids). Throws std::runtime_error if the OS can't provide any.
std::vector<uint8_t> secureRandomBytes (size_t count);

// `count` random bytes as lower-case hex
std::string secureRandomHex (size_t count);

// A uniformly random integer in [0, bound)
uint32_t secureRandomBelow (uint32_t bound);

} // namespace ghostdaw
