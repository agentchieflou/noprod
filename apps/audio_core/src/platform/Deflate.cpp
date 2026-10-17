#include "Deflate.h"

#include <algorithm>
#include <array>
#include <cstring>

namespace ghostdaw
{

uint32_t adler32 (const uint8_t* data, size_t size)
{
    uint32_t a = 1, b = 0;
    size_t i = 0;
    while (i < size)
    {
        // 5552 is the most bytes before the sums need reducing modulo 65521
        auto chunk = std::min<size_t> (5552, size - i);
        for (size_t n = 0; n < chunk; ++n)
        {
            a += data[i + n];
            b += a;
        }
        a %= 65521;
        b %= 65521;
        i += chunk;
    }
    return (b << 16) | a;
}

namespace
{

// RFC 1951 3.2.5: the length and distance code tables
constexpr uint16_t lengthBase[29] = { 3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258 };
constexpr uint8_t lengthExtra[29] = { 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0 };
constexpr uint16_t distanceBase[30] = { 1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577 };
constexpr uint8_t distanceExtra[30] = { 0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13 };

// Bits go out least-significant first; Huffman codes most-significant first
class BitWriter
{
public:
    explicit BitWriter (std::vector<uint8_t>& o) : out (o) {}

    void putBits (uint32_t value, int count)
    {
        accumulator |= static_cast<uint64_t> (value) << filled;
        filled += count;
        while (filled >= 8)
        {
            out.push_back (static_cast<uint8_t> (accumulator & 0xFF));
            accumulator >>= 8;
            filled -= 8;
        }
    }

    void putCode (uint32_t code, int length)
    {
        uint32_t reversed = 0;
        for (int i = 0; i < length; ++i)
            reversed |= ((code >> i) & 1u) << (length - 1 - i);
        putBits (reversed, length);
    }

    void alignToByte()
    {
        if (filled > 0)
            putBits (0, 8 - filled);
    }

private:
    std::vector<uint8_t>& out;
    uint64_t accumulator = 0;
    int filled = 0;
};

// The fixed literal/length code (RFC 1951 3.2.6)
void putLiteral (BitWriter& bits, int literal)
{
    if (literal < 144) bits.putCode (0x30 + static_cast<uint32_t> (literal), 8);
    else if (literal < 256) bits.putCode (0x190 + static_cast<uint32_t> (literal - 144), 9);
    else if (literal < 280) bits.putCode (static_cast<uint32_t> (literal - 256), 7);
    else bits.putCode (0xC0 + static_cast<uint32_t> (literal - 280), 8);
}

void putMatch (BitWriter& bits, int length, int distance)
{
    int lengthCode = 28;
    while (lengthCode > 0 && lengthBase[lengthCode] > length)
        --lengthCode;
    putLiteral (bits, 257 + lengthCode);
    if (lengthExtra[lengthCode] > 0)
        bits.putBits (static_cast<uint32_t> (length - lengthBase[lengthCode]), lengthExtra[lengthCode]);

    int distanceCode = 29;
    while (distanceCode > 0 && distanceBase[distanceCode] > distance)
        --distanceCode;
    bits.putCode (static_cast<uint32_t> (distanceCode), 5);
    if (distanceExtra[distanceCode] > 0)
        bits.putBits (static_cast<uint32_t> (distance - distanceBase[distanceCode]), distanceExtra[distanceCode]);
}

constexpr int windowSize = 32768;
constexpr int hashBits = 15;
constexpr int minMatch = 3, maxMatch = 258;

uint32_t hash3 (const uint8_t* p)
{
    uint32_t v = (static_cast<uint32_t> (p[0]) << 16) | (static_cast<uint32_t> (p[1]) << 8) | p[2];
    return (v * 2654435761u) >> (32 - hashBits);
}

void storedBlocks (const uint8_t* data, size_t size, std::vector<uint8_t>& out)
{
    BitWriter bits (out);
    size_t offset = 0;
    do
    {
        auto count = std::min<size_t> (65535, size - offset);
        bool last = offset + count == size;
        bits.putBits (last ? 1u : 0u, 1);
        bits.putBits (0, 2); // stored
        bits.alignToByte();
        out.push_back (static_cast<uint8_t> (count & 0xFF));
        out.push_back (static_cast<uint8_t> (count >> 8));
        out.push_back (static_cast<uint8_t> (~count & 0xFF));
        out.push_back (static_cast<uint8_t> ((~count >> 8) & 0xFF));
        out.insert (out.end(), data + offset, data + offset + count);
        offset += count;
    }
    while (offset < size);
}

void fixedHuffmanBlock (const uint8_t* data, size_t size, int level, std::vector<uint8_t>& out)
{
    BitWriter bits (out);
    bits.putBits (1, 1); // final
    bits.putBits (1, 2); // fixed Huffman

    std::vector<int32_t> head (1u << hashBits, -1);
    std::vector<int32_t> prev (size, -1);
    auto maxChain = level <= 1 ? 4 : level <= 3 ? 16 : level <= 6 ? 64 : 256;
    auto niceLength = level <= 1 ? 32 : level <= 6 ? 128 : maxMatch;

    size_t i = 0;
    auto insert = [&] (size_t at)
    {
        if (at + minMatch <= size)
        {
            auto h = hash3 (data + at);
            prev[at] = head[h];
            head[h] = static_cast<int32_t> (at);
        }
    };

    while (i < size)
    {
        int bestLength = 0, bestDistance = 0;
        if (i + minMatch <= size)
        {
            auto candidate = head[hash3 (data + i)];
            auto limit = std::min<size_t> (maxMatch, size - i);
            for (int chain = 0; candidate >= 0 && chain < maxChain; ++chain)
            {
                auto distance = static_cast<int> (i) - candidate;
                if (distance > windowSize)
                    break;
                auto* a = data + i;
                auto* b = data + candidate;
                if (b[bestLength] == a[bestLength] && b[0] == a[0])
                {
                    size_t length = 0;
                    while (length < limit && a[length] == b[length])
                        ++length;
                    if (static_cast<int> (length) > bestLength)
                    {
                        bestLength = static_cast<int> (length);
                        bestDistance = distance;
                        if (bestLength >= niceLength)
                            break;
                    }
                }
                candidate = prev[static_cast<size_t> (candidate)];
            }
        }

        if (bestLength >= minMatch)
        {
            putMatch (bits, bestLength, bestDistance);
            for (int n = 0; n < bestLength; ++n)
                insert (i + static_cast<size_t> (n));
            i += static_cast<size_t> (bestLength);
        }
        else
        {
            putLiteral (bits, data[i]);
            insert (i);
            ++i;
        }
    }

    putLiteral (bits, 256); // end of block
    bits.alignToByte();
}

} // namespace

std::vector<uint8_t> zlibCompress (const uint8_t* data, size_t size, int level)
{
    std::vector<uint8_t> out;
    out.reserve (size / 4 + 64);
    out.push_back (0x78); // deflate, a 32 KiB window
    out.push_back (level <= 1 ? 0x01 : level <= 5 ? 0x5E : level <= 6 ? 0x9C : 0xDA); // the level hint; the pair is a multiple of 31

    if (level <= 0 || size == 0)
        storedBlocks (data, size, out);
    else
        fixedHuffmanBlock (data, size, level, out);

    auto checksum = adler32 (data, size);
    for (int shift = 24; shift >= 0; shift -= 8)
        out.push_back (static_cast<uint8_t> ((checksum >> shift) & 0xFF));
    return out;
}

// --------------------------------------------------------------- inflate

namespace
{

class BitReader
{
public:
    BitReader (const uint8_t* d, size_t s) : data (d), size (s) {}

    bool getBits (int count, uint32_t& value)
    {
        while (filled < count)
        {
            if (position >= size)
                return false;
            accumulator |= static_cast<uint64_t> (data[position++]) << filled;
            filled += 8;
        }
        value = static_cast<uint32_t> (accumulator & ((1ull << count) - 1));
        accumulator >>= count;
        filled -= count;
        return true;
    }

    void alignToByte()
    {
        accumulator >>= filled % 8;
        filled -= filled % 8;
    }

    bool getBytes (size_t count, const uint8_t*& out)
    {
        // After alignToByte the accumulator holds whole bytes not yet consumed
        while (filled >= 8)
        {
            --position;
            accumulator = 0;
            filled -= 8;
        }
        if (position + count > size)
            return false;
        out = data + position;
        position += count;
        return true;
    }

    size_t getPosition() const { return position; }

private:
    const uint8_t* data;
    size_t size;
    size_t position = 0;
    uint64_t accumulator = 0;
    int filled = 0;
};

// A canonical Huffman decoder built from code lengths (RFC 1951 3.2.2)
struct Huffman
{
    std::array<uint16_t, 16> counts {};
    std::vector<uint16_t> symbols;

    bool build (const uint8_t* lengths, int count)
    {
        counts.fill (0);
        for (int i = 0; i < count; ++i)
            ++counts[lengths[i]];
        counts[0] = 0;
        int left = 1;
        for (int length = 1; length < 16; ++length)
        {
            left <<= 1;
            left -= counts[length];
            if (left < 0)
                return false; // over-subscribed
        }
        std::array<uint16_t, 16> offsets {};
        for (int length = 1; length < 15; ++length)
            offsets[length + 1] = static_cast<uint16_t> (offsets[length] + counts[length]);
        symbols.assign (static_cast<size_t> (count), 0);
        for (int i = 0; i < count; ++i)
            if (lengths[i] != 0)
                symbols[offsets[lengths[i]]++] = static_cast<uint16_t> (i);
        return true;
    }

    bool decode (BitReader& bits, int& symbol) const
    {
        int code = 0, first = 0, index = 0;
        for (int length = 1; length < 16; ++length)
        {
            uint32_t bit;
            if (! bits.getBits (1, bit))
                return false;
            code |= static_cast<int> (bit);
            auto count = counts[length];
            if (code - count < first)
            {
                symbol = symbols[static_cast<size_t> (index + (code - first))];
                return true;
            }
            index += count;
            first += count;
            first <<= 1;
            code <<= 1;
        }
        return false;
    }
};

bool inflateBlockData (BitReader& bits, const Huffman& literals, const Huffman& distances, std::vector<uint8_t>& out)
{
    for (;;)
    {
        int symbol;
        if (! literals.decode (bits, symbol))
            return false;
        if (symbol < 256)
        {
            out.push_back (static_cast<uint8_t> (symbol));
            continue;
        }
        if (symbol == 256)
            return true;
        symbol -= 257;
        if (symbol >= 29)
            return false;
        uint32_t extra = 0;
        if (lengthExtra[symbol] > 0 && ! bits.getBits (lengthExtra[symbol], extra))
            return false;
        auto length = lengthBase[symbol] + extra;

        int distanceSymbol;
        if (! distances.decode (bits, distanceSymbol) || distanceSymbol >= 30)
            return false;
        extra = 0;
        if (distanceExtra[distanceSymbol] > 0 && ! bits.getBits (distanceExtra[distanceSymbol], extra))
            return false;
        auto distance = distanceBase[distanceSymbol] + extra;
        if (distance > out.size())
            return false;
        auto from = out.size() - distance;
        for (uint32_t i = 0; i < length; ++i)
            out.push_back (out[from + i]);
    }
}

bool inflateFixed (BitReader& bits, std::vector<uint8_t>& out)
{
    uint8_t lengths[288];
    for (int i = 0; i < 144; ++i) lengths[i] = 8;
    for (int i = 144; i < 256; ++i) lengths[i] = 9;
    for (int i = 256; i < 280; ++i) lengths[i] = 7;
    for (int i = 280; i < 288; ++i) lengths[i] = 8;
    Huffman literals, distances;
    literals.build (lengths, 288);
    uint8_t distanceLengths[30];
    for (auto& l : distanceLengths) l = 5;
    distances.build (distanceLengths, 30);
    return inflateBlockData (bits, literals, distances, out);
}

bool inflateDynamic (BitReader& bits, std::vector<uint8_t>& out)
{
    uint32_t hlit, hdist, hclen;
    if (! bits.getBits (5, hlit) || ! bits.getBits (5, hdist) || ! bits.getBits (4, hclen))
        return false;
    auto literalCount = static_cast<int> (hlit) + 257, distanceCount = static_cast<int> (hdist) + 1, codeLengthCount = static_cast<int> (hclen) + 4;
    if (literalCount > 286 || distanceCount > 30)
        return false;

    static constexpr uint8_t order[19] = { 16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15 };
    uint8_t codeLengths[19] = {};
    for (int i = 0; i < codeLengthCount; ++i)
    {
        uint32_t v;
        if (! bits.getBits (3, v))
            return false;
        codeLengths[order[i]] = static_cast<uint8_t> (v);
    }
    Huffman codeLengthCode;
    if (! codeLengthCode.build (codeLengths, 19))
        return false;

    uint8_t lengths[316] = {};
    int index = 0;
    while (index < literalCount + distanceCount)
    {
        int symbol;
        if (! codeLengthCode.decode (bits, symbol))
            return false;
        if (symbol < 16)
        {
            lengths[index++] = static_cast<uint8_t> (symbol);
            continue;
        }
        uint32_t repeat;
        uint8_t value = 0;
        if (symbol == 16)
        {
            if (index == 0 || ! bits.getBits (2, repeat))
                return false;
            value = lengths[index - 1];
            repeat += 3;
        }
        else if (symbol == 17)
        {
            if (! bits.getBits (3, repeat))
                return false;
            repeat += 3;
        }
        else
        {
            if (! bits.getBits (7, repeat))
                return false;
            repeat += 11;
        }
        if (index + static_cast<int> (repeat) > literalCount + distanceCount)
            return false;
        while (repeat-- > 0)
            lengths[index++] = value;
    }

    Huffman literals, distances;
    if (! literals.build (lengths, literalCount) || ! distances.build (lengths + literalCount, distanceCount))
        return false;
    return inflateBlockData (bits, literals, distances, out);
}

} // namespace

bool zlibDecompress (const uint8_t* data, size_t size, std::vector<uint8_t>& out)
{
    out.clear();
    if (size < 6 || (data[0] & 0x0F) != 8 || ((data[0] << 8) | data[1]) % 31 != 0 || (data[1] & 0x20) != 0)
        return false;

    BitReader bits (data + 2, size - 6);
    for (;;)
    {
        uint32_t final, type;
        if (! bits.getBits (1, final) || ! bits.getBits (2, type))
            return false;
        if (type == 0)
        {
            bits.alignToByte();
            const uint8_t* header;
            if (! bits.getBytes (4, header))
                return false;
            auto length = static_cast<size_t> (header[0] | (header[1] << 8));
            auto check = static_cast<size_t> (header[2] | (header[3] << 8));
            if ((length ^ 0xFFFF) != check)
                return false;
            const uint8_t* block;
            if (! bits.getBytes (length, block))
                return false;
            out.insert (out.end(), block, block + length);
        }
        else if (type == 1)
        {
            if (! inflateFixed (bits, out))
                return false;
        }
        else if (type == 2)
        {
            if (! inflateDynamic (bits, out))
                return false;
        }
        else
        {
            return false;
        }
        if (final)
            break;
    }

    uint32_t stored = (static_cast<uint32_t> (data[size - 4]) << 24) | (static_cast<uint32_t> (data[size - 3]) << 16)
                    | (static_cast<uint32_t> (data[size - 2]) << 8) | data[size - 1];
    return stored == adler32 (out.data(), out.size());
}

} // namespace ghostdaw
