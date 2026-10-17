#include "Strings.h"

namespace ghostdaw
{

std::string trim (const std::string& text)
{
    auto isSpace = [] (char c) { return c == ' ' || c == '\t' || c == '\r' || c == '\n'; };
    size_t start = 0, end = text.size();
    while (start < end && isSpace (text[start])) ++start;
    while (end > start && isSpace (text[end - 1])) --end;
    return text.substr (start, end - start);
}

std::vector<std::string> split (const std::string& text, char separator)
{
    std::vector<std::string> pieces;
    size_t start = 0;
    for (;;)
    {
        auto at = text.find (separator, start);
        if (at == std::string::npos)
        {
            pieces.push_back (text.substr (start));
            return pieces;
        }
        pieces.push_back (text.substr (start, at - start));
        start = at + 1;
    }
}

std::string lowerCase (std::string text)
{
    for (auto& c : text)
        if (c >= 'A' && c <= 'Z')
            c = static_cast<char> (c - 'A' + 'a');
    return text;
}

bool equalsIgnoreCase (const std::string& a, const std::string& b)
{
    return lowerCase (a) == lowerCase (b);
}

bool startsWith (const std::string& text, const std::string& prefix)
{
    return text.size() >= prefix.size() && text.compare (0, prefix.size(), prefix) == 0;
}

bool endsWith (const std::string& text, const std::string& suffix)
{
    return text.size() >= suffix.size() && text.compare (text.size() - suffix.size(), suffix.size(), suffix) == 0;
}

bool containsOnly (const std::string& text, const std::string& allowed)
{
    for (auto c : text)
        if (allowed.find (c) == std::string::npos)
            return false;
    return true;
}

bool isValidUtf8 (const char* data, size_t size)
{
    auto* p = reinterpret_cast<const unsigned char*> (data);
    auto* end = p + size;
    while (p < end)
    {
        auto c = *p;
        if (c < 0x80)
        {
            ++p;
            continue;
        }

        int extra;
        uint32_t minimum;
        if ((c & 0xE0) == 0xC0) { extra = 1; minimum = 0x80; }
        else if ((c & 0xF0) == 0xE0) { extra = 2; minimum = 0x800; }
        else if ((c & 0xF8) == 0xF0) { extra = 3; minimum = 0x10000; }
        else return false;

        if (end - p < extra + 1)
            return false;
        uint32_t cp = c & (0x3F >> extra);
        for (int i = 1; i <= extra; ++i)
        {
            if ((p[i] & 0xC0) != 0x80)
                return false;
            cp = (cp << 6) | (p[i] & 0x3F);
        }
        if (cp < minimum || cp > 0x10FFFF || (cp >= 0xD800 && cp <= 0xDFFF))
            return false;
        p += extra + 1;
    }
    return true;
}

} // namespace ghostdaw
