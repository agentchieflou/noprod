#pragma once

#include <cstdint>
#include <cstring>
#include <array>
#include <vector>

// Minimal SHA-1 implementation (RFC 3174). JUCE ships MD5/SHA256/Whirlpool but
// not SHA-1, which the WebSocket handshake (RFC 6455) hardcodes as the hash
// algorithm for Sec-WebSocket-Accept -- there is no substituting a different
// digest here, so this is a small self-contained implementation.
class Sha1
{
public:
    static std::array<uint8_t, 20> hash (const void* data, size_t length)
    {
        uint32_t h[5] = { 0x67452301, 0xEFCDAB89, 0x98BADCFE, 0x10325476, 0xC3D2E1F0 };

        auto rol = [] (uint32_t value, int bits) {
            return (value << bits) | (value >> (32 - bits));
        };

        const auto* bytes = static_cast<const uint8_t*> (data);
        size_t bitLength = length * 8;

        std::vector<uint8_t> message (bytes, bytes + length);
        message.push_back (0x80);
        while (message.size () % 64 != 56)
            message.push_back (0);

        for (int i = 7; i >= 0; --i)
            message.push_back (static_cast<uint8_t> ((bitLength >> (i * 8)) & 0xFF));

        for (size_t chunkStart = 0; chunkStart < message.size (); chunkStart += 64)
        {
            uint32_t w[80];
            for (int i = 0; i < 16; ++i)
            {
                const auto* p = &message[chunkStart + static_cast<size_t> (i) * 4];
                w[i] = (static_cast<uint32_t> (p[0]) << 24) | (static_cast<uint32_t> (p[1]) << 16)
                     | (static_cast<uint32_t> (p[2]) << 8)  |  static_cast<uint32_t> (p[3]);
            }
            for (int i = 16; i < 80; ++i)
                w[i] = rol (w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16], 1);

            uint32_t a = h[0], b = h[1], c = h[2], d = h[3], e = h[4];

            for (int i = 0; i < 80; ++i)
            {
                uint32_t f, k;
                if (i < 20)      { f = (b & c) | ((~b) & d);        k = 0x5A827999; }
                else if (i < 40) { f = b ^ c ^ d;                   k = 0x6ED9EBA1; }
                else if (i < 60) { f = (b & c) | (b & d) | (c & d); k = 0x8F1BBCDC; }
                else             { f = b ^ c ^ d;                   k = 0xCA62C1D6; }

                uint32_t temp = rol (a, 5) + f + e + k + w[i];
                e = d; d = c; c = rol (b, 30); b = a; a = temp;
            }

            h[0] += a; h[1] += b; h[2] += c; h[3] += d; h[4] += e;
        }

        std::array<uint8_t, 20> digest {};
        for (int i = 0; i < 5; ++i)
        {
            digest[static_cast<size_t> (i) * 4]     = static_cast<uint8_t> ((h[i] >> 24) & 0xFF);
            digest[static_cast<size_t> (i) * 4 + 1] = static_cast<uint8_t> ((h[i] >> 16) & 0xFF);
            digest[static_cast<size_t> (i) * 4 + 2] = static_cast<uint8_t> ((h[i] >> 8) & 0xFF);
            digest[static_cast<size_t> (i) * 4 + 3] = static_cast<uint8_t> (h[i] & 0xFF);
        }
        return digest;
    }
};
