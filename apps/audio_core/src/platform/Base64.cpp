#include "Base64.h"

namespace ghostdaw
{

static constexpr const char* alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

std::string base64Encode (const void* data, size_t size)
{
    auto* bytes = static_cast<const uint8_t*> (data);
    std::string out;
    out.reserve ((size + 2) / 3 * 4);
    for (size_t i = 0; i < size; i += 3)
    {
        uint32_t triple = static_cast<uint32_t> (bytes[i]) << 16;
        if (i + 1 < size) triple |= static_cast<uint32_t> (bytes[i + 1]) << 8;
        if (i + 2 < size) triple |= bytes[i + 2];
        out += alphabet[(triple >> 18) & 0x3F];
        out += alphabet[(triple >> 12) & 0x3F];
        out += i + 1 < size ? alphabet[(triple >> 6) & 0x3F] : '=';
        out += i + 2 < size ? alphabet[triple & 0x3F] : '=';
    }
    return out;
}

static int base64Value (char c)
{
    if (c >= 'A' && c <= 'Z') return c - 'A';
    if (c >= 'a' && c <= 'z') return c - 'a' + 26;
    if (c >= '0' && c <= '9') return c - '0' + 52;
    if (c == '+') return 62;
    if (c == '/') return 63;
    return -1;
}

bool base64Decode (const std::string& text, std::vector<uint8_t>& out)
{
    out.clear();
    if (text.size() % 4 != 0)
        return false;
    for (size_t i = 0; i < text.size(); i += 4)
    {
        int values[4];
        int padding = 0;
        for (int n = 0; n < 4; ++n)
        {
            auto c = text[i + static_cast<size_t> (n)];
            if (c == '=' && n >= 2 && i + 4 == text.size())
            {
                values[n] = 0;
                ++padding;
            }
            else
            {
                values[n] = base64Value (c);
                if (values[n] < 0 || padding > 0)
                    return false;
            }
        }
        uint32_t triple = (static_cast<uint32_t> (values[0]) << 18) | (static_cast<uint32_t> (values[1]) << 12)
                        | (static_cast<uint32_t> (values[2]) << 6) | static_cast<uint32_t> (values[3]);
        out.push_back (static_cast<uint8_t> (triple >> 16));
        if (padding < 2) out.push_back (static_cast<uint8_t> (triple >> 8));
        if (padding < 1) out.push_back (static_cast<uint8_t> (triple));
    }
    return true;
}

std::string hexEncode (const void* data, size_t size)
{
    static constexpr const char* digits = "0123456789abcdef";
    auto* bytes = static_cast<const uint8_t*> (data);
    std::string out;
    out.reserve (size * 2);
    for (size_t i = 0; i < size; ++i)
    {
        out += digits[bytes[i] >> 4];
        out += digits[bytes[i] & 0xF];
    }
    return out;
}

bool hexDecode (const std::string& text, std::vector<uint8_t>& out)
{
    out.clear();
    if (text.size() % 2 != 0)
        return false;
    auto nibble = [] (char c) -> int
    {
        if (c >= '0' && c <= '9') return c - '0';
        if (c >= 'a' && c <= 'f') return c - 'a' + 10;
        if (c >= 'A' && c <= 'F') return c - 'A' + 10;
        return -1;
    };
    for (size_t i = 0; i < text.size(); i += 2)
    {
        auto high = nibble (text[i]), low = nibble (text[i + 1]);
        if (high < 0 || low < 0)
            return false;
        out.push_back (static_cast<uint8_t> ((high << 4) | low));
    }
    return true;
}

} // namespace ghostdaw
