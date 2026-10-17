#include "Random.h"

#include "Base64.h"
#include "Platform.h"

#include <stdexcept>

#if GHOSTDAW_WINDOWS
 #include <windows.h>
 #include <bcrypt.h>
#else
 #include <cstdio>
#endif

namespace ghostdaw
{

std::vector<uint8_t> secureRandomBytes (size_t count)
{
    std::vector<uint8_t> bytes (count);
    if (count == 0)
        return bytes;

   #if GHOSTDAW_WINDOWS
    if (BCryptGenRandom (nullptr, bytes.data(), static_cast<ULONG> (count), BCRYPT_USE_SYSTEM_PREFERRED_RNG) != 0)
        throw std::runtime_error ("BCryptGenRandom failed");
   #else
    auto* urandom = std::fopen ("/dev/urandom", "rb");
    if (urandom == nullptr)
        throw std::runtime_error ("/dev/urandom is not available");
    auto got = std::fread (bytes.data(), 1, count, urandom);
    std::fclose (urandom);
    if (got != count)
        throw std::runtime_error ("/dev/urandom gave too few bytes");
   #endif
    return bytes;
}

std::string secureRandomHex (size_t count)
{
    auto bytes = secureRandomBytes (count);
    return hexEncode (bytes.data(), bytes.size());
}

uint32_t secureRandomBelow (uint32_t bound)
{
    if (bound <= 1)
        return 0;
    // Rejection sampling keeps it uniform
    auto limit = static_cast<uint32_t> (0xFFFFFFFFu - (0xFFFFFFFFu % bound));
    for (;;)
    {
        auto bytes = secureRandomBytes (4);
        uint32_t value = (static_cast<uint32_t> (bytes[0]) << 24) | (static_cast<uint32_t> (bytes[1]) << 16)
                       | (static_cast<uint32_t> (bytes[2]) << 8) | bytes[3];
        if (value < limit)
            return value % bound;
    }
}

} // namespace ghostdaw
