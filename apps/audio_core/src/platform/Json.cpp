#include "Json.h"

#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>

namespace ghostdaw
{

namespace
{
const Json nullJson;
constexpr int maxDepth = 128;
}

Json Json::object (std::initializer_list<std::pair<const char*, Json>> list)
{
    Json result = object();
    for (auto& [key, value] : list)
        result.set (key, value);
    return result;
}

bool Json::toBool (bool fallback) const
{
    switch (type_)
    {
        case Type::boolean: return bool_;
        case Type::number: return number_ != 0.0;
        case Type::string: return string_ == "true" || string_ == "1";
        default: return fallback;
    }
}

double Json::toDouble (double fallback) const
{
    switch (type_)
    {
        case Type::number: return number_;
        case Type::boolean: return bool_ ? 1.0 : 0.0;
        case Type::string:
        {
            char* end = nullptr;
            auto value = std::strtod (string_.c_str(), &end);
            return end != string_.c_str() && *end == 0 ? value : fallback;
        }
        default: return fallback;
    }
}

int Json::toInt (int fallback) const
{
    auto d = toDouble (std::nan (""));
    if (std::isnan (d) || d > 2147483647.0 || d < -2147483648.0)
        return fallback;
    return static_cast<int> (d);
}

int64_t Json::toInt64 (int64_t fallback) const
{
    auto d = toDouble (std::nan (""));
    if (std::isnan (d) || d > 9.2e18 || d < -9.2e18)
        return fallback;
    return static_cast<int64_t> (d);
}

static std::string numberToString (double d)
{
    if (std::isnan (d) || std::isinf (d))
        return "null"; // JSON has no such numbers
    if (d == std::floor (d) && std::fabs (d) < 9007199254740992.0)
        return std::to_string (static_cast<int64_t> (d));
    char buffer[32];
    std::snprintf (buffer, sizeof (buffer), "%.17g", d);
    // The shortest text that reads back as the same double
    for (int precision = 1; precision < 17; ++precision)
    {
        char shorter[32];
        std::snprintf (shorter, sizeof (shorter), "%.*g", precision, d);
        if (std::strtod (shorter, nullptr) == d)
            return shorter;
    }
    return buffer;
}

std::string Json::toString (const std::string& fallback) const
{
    switch (type_)
    {
        case Type::string: return string_;
        case Type::number: return numberToString (number_);
        case Type::boolean: return bool_ ? "true" : "false";
        default: return fallback;
    }
}

const Json& Json::operator[] (const char* key) const
{
    if (type_ == Type::object)
        for (auto& [k, v] : object_)
            if (k == key)
                return v;
    return nullJson;
}

Json& Json::member (const char* key)
{
    if (type_ != Type::object)
        *this = object();
    for (auto& [k, v] : object_)
        if (k == key)
            return v;
    object_.emplace_back (key, Json());
    return object_.back().second;
}

bool Json::has (const char* key) const
{
    if (type_ != Type::object)
        return false;
    for (auto& [k, v] : object_)
        if (k == key)
            return true;
    return false;
}

const Json& Json::get (const char* key, const Json& fallback) const
{
    auto& value = (*this)[key];
    return value.isNull() ? fallback : value;
}

Json& Json::set (const char* key, Json value)
{
    member (key) = std::move (value);
    return *this;
}

bool Json::remove (const char* key)
{
    if (type_ != Type::object)
        return false;
    for (auto it = object_.begin(); it != object_.end(); ++it)
    {
        if (it->first == key)
        {
            object_.erase (it);
            return true;
        }
    }
    return false;
}

const Json& Json::operator[] (size_t index) const
{
    if (type_ == Type::array && index < array_.size())
        return array_[index];
    return nullJson;
}

Json& Json::element (size_t index)
{
    if (type_ != Type::array)
        *this = array();
    if (index >= array_.size())
        array_.resize (index + 1);
    return array_[index];
}

Json& Json::push (Json value)
{
    if (type_ != Type::array)
        *this = array();
    array_.push_back (std::move (value));
    return *this;
}

size_t Json::size() const
{
    if (type_ == Type::array)
        return array_.size();
    if (type_ == Type::object)
        return object_.size();
    return 0;
}

bool Json::operator== (const Json& other) const
{
    if (type_ != other.type_)
        return false;
    switch (type_)
    {
        case Type::null: return true;
        case Type::boolean: return bool_ == other.bool_;
        case Type::number: return number_ == other.number_;
        case Type::string: return string_ == other.string_;
        case Type::array: return array_ == other.array_;
        case Type::object:
        {
            if (object_.size() != other.object_.size())
                return false;
            for (auto& [k, v] : object_)
                if (! other.has (k.c_str()) || other[k.c_str()] != v)
                    return false;
            return true;
        }
    }
    return false;
}

// ------------------------------------------------------------------ dump

static void dumpString (std::string& out, const std::string& s)
{
    out += '"';
    for (unsigned char c : s)
    {
        switch (c)
        {
            case '"': out += "\\\""; break;
            case '\\': out += "\\\\"; break;
            case '\b': out += "\\b"; break;
            case '\f': out += "\\f"; break;
            case '\n': out += "\\n"; break;
            case '\r': out += "\\r"; break;
            case '\t': out += "\\t"; break;
            default:
                if (c < 0x20)
                {
                    char buffer[8];
                    std::snprintf (buffer, sizeof (buffer), "\\u%04x", c);
                    out += buffer;
                }
                else
                {
                    out += static_cast<char> (c);
                }
        }
    }
    out += '"';
}

static void newline (std::string& out, int indent, int depth)
{
    if (indent <= 0)
        return;
    out += '\n';
    out.append (static_cast<size_t> (indent * depth), ' ');
}

void Json::dumpTo (std::string& out, int indent, int depth) const
{
    switch (type_)
    {
        case Type::null: out += "null"; break;
        case Type::boolean: out += bool_ ? "true" : "false"; break;
        case Type::number: out += numberToString (number_); break;
        case Type::string: dumpString (out, string_); break;
        case Type::array:
        {
            out += '[';
            for (size_t i = 0; i < array_.size(); ++i)
            {
                if (i > 0)
                    out += ',';
                newline (out, indent, depth + 1);
                array_[i].dumpTo (out, indent, depth + 1);
            }
            if (! array_.empty())
                newline (out, indent, depth);
            out += ']';
            break;
        }
        case Type::object:
        {
            out += '{';
            for (size_t i = 0; i < object_.size(); ++i)
            {
                if (i > 0)
                    out += ',';
                newline (out, indent, depth + 1);
                dumpString (out, object_[i].first);
                out += indent > 0 ? ": " : ":";
                object_[i].second.dumpTo (out, indent, depth + 1);
            }
            if (! object_.empty())
                newline (out, indent, depth);
            out += '}';
            break;
        }
    }
}

std::string Json::dump (int indent) const
{
    std::string out;
    dumpTo (out, indent, 0);
    return out;
}

// ----------------------------------------------------------------- parse

namespace
{

struct Parser
{
    const char* p;
    const char* end;
    std::string error;

    bool fail (const char* message)
    {
        if (error.empty())
            error = message;
        return false;
    }

    void skipSpace()
    {
        while (p < end && (*p == ' ' || *p == '\t' || *p == '\n' || *p == '\r'))
            ++p;
    }

    bool consume (const char* literal)
    {
        auto length = std::strlen (literal);
        if (static_cast<size_t> (end - p) < length || std::memcmp (p, literal, length) != 0)
            return false;
        p += length;
        return true;
    }

    static void appendUtf8 (std::string& out, uint32_t cp)
    {
        if (cp < 0x80)
        {
            out += static_cast<char> (cp);
        }
        else if (cp < 0x800)
        {
            out += static_cast<char> (0xC0 | (cp >> 6));
            out += static_cast<char> (0x80 | (cp & 0x3F));
        }
        else if (cp < 0x10000)
        {
            out += static_cast<char> (0xE0 | (cp >> 12));
            out += static_cast<char> (0x80 | ((cp >> 6) & 0x3F));
            out += static_cast<char> (0x80 | (cp & 0x3F));
        }
        else
        {
            out += static_cast<char> (0xF0 | (cp >> 18));
            out += static_cast<char> (0x80 | ((cp >> 12) & 0x3F));
            out += static_cast<char> (0x80 | ((cp >> 6) & 0x3F));
            out += static_cast<char> (0x80 | (cp & 0x3F));
        }
    }

    bool hex4 (uint32_t& value)
    {
        if (end - p < 4)
            return fail ("truncated \\u escape");
        value = 0;
        for (int i = 0; i < 4; ++i)
        {
            auto c = *p++;
            value <<= 4;
            if (c >= '0' && c <= '9') value |= static_cast<uint32_t> (c - '0');
            else if (c >= 'a' && c <= 'f') value |= static_cast<uint32_t> (c - 'a' + 10);
            else if (c >= 'A' && c <= 'F') value |= static_cast<uint32_t> (c - 'A' + 10);
            else return fail ("bad \\u escape");
        }
        return true;
    }

    bool parseString (std::string& out)
    {
        if (p >= end || *p != '"')
            return fail ("expected a string");
        ++p;
        while (p < end)
        {
            auto c = static_cast<unsigned char> (*p++);
            if (c == '"')
                return true;
            if (c == '\\')
            {
                if (p >= end)
                    break;
                auto e = *p++;
                switch (e)
                {
                    case '"': out += '"'; break;
                    case '\\': out += '\\'; break;
                    case '/': out += '/'; break;
                    case 'b': out += '\b'; break;
                    case 'f': out += '\f'; break;
                    case 'n': out += '\n'; break;
                    case 'r': out += '\r'; break;
                    case 't': out += '\t'; break;
                    case 'u':
                    {
                        uint32_t cp;
                        if (! hex4 (cp))
                            return false;
                        if (cp >= 0xD800 && cp <= 0xDBFF) // a surrogate pair
                        {
                            uint32_t low;
                            if (! consume ("\\u") || ! hex4 (low) || low < 0xDC00 || low > 0xDFFF)
                                return fail ("bad surrogate pair");
                            cp = 0x10000 + ((cp - 0xD800) << 10) + (low - 0xDC00);
                        }
                        else if (cp >= 0xDC00 && cp <= 0xDFFF)
                        {
                            return fail ("lone surrogate");
                        }
                        appendUtf8 (out, cp);
                        break;
                    }
                    default: return fail ("bad escape");
                }
            }
            else if (c < 0x20)
            {
                return fail ("control character in string");
            }
            else
            {
                out += static_cast<char> (c);
            }
        }
        return fail ("unterminated string");
    }

    bool parseNumber (Json& out)
    {
        auto start = p;
        if (p < end && *p == '-')
            ++p;
        if (p >= end)
            return fail ("bad number");
        if (*p == '0')
            ++p;
        else if (*p >= '1' && *p <= '9')
            while (p < end && *p >= '0' && *p <= '9') ++p;
        else
            return fail ("bad number");
        if (p < end && *p == '.')
        {
            ++p;
            if (p >= end || *p < '0' || *p > '9')
                return fail ("bad number");
            while (p < end && *p >= '0' && *p <= '9') ++p;
        }
        if (p < end && (*p == 'e' || *p == 'E'))
        {
            ++p;
            if (p < end && (*p == '+' || *p == '-'))
                ++p;
            if (p >= end || *p < '0' || *p > '9')
                return fail ("bad number");
            while (p < end && *p >= '0' && *p <= '9') ++p;
        }
        std::string text (start, p);
        out = Json (std::strtod (text.c_str(), nullptr));
        return true;
    }

    bool parseValue (Json& out, int depth)
    {
        if (depth > maxDepth)
            return fail ("nested too deep");
        skipSpace();
        if (p >= end)
            return fail ("unexpected end");

        switch (*p)
        {
            case '{':
            {
                ++p;
                out = Json::object();
                skipSpace();
                if (p < end && *p == '}')
                {
                    ++p;
                    return true;
                }
                for (;;)
                {
                    skipSpace();
                    std::string key;
                    if (! parseString (key))
                        return false;
                    skipSpace();
                    if (p >= end || *p != ':')
                        return fail ("expected ':'");
                    ++p;
                    Json value;
                    if (! parseValue (value, depth + 1))
                        return false;
                    out.member (key) = std::move (value);
                    skipSpace();
                    if (p < end && *p == ',')
                    {
                        ++p;
                        continue;
                    }
                    if (p < end && *p == '}')
                    {
                        ++p;
                        return true;
                    }
                    return fail ("expected ',' or '}'");
                }
            }
            case '[':
            {
                ++p;
                out = Json::array();
                skipSpace();
                if (p < end && *p == ']')
                {
                    ++p;
                    return true;
                }
                for (;;)
                {
                    Json value;
                    if (! parseValue (value, depth + 1))
                        return false;
                    out.push (std::move (value));
                    skipSpace();
                    if (p < end && *p == ',')
                    {
                        ++p;
                        continue;
                    }
                    if (p < end && *p == ']')
                    {
                        ++p;
                        return true;
                    }
                    return fail ("expected ',' or ']'");
                }
            }
            case '"':
            {
                std::string s;
                if (! parseString (s))
                    return false;
                out = Json (std::move (s));
                return true;
            }
            case 't': if (consume ("true")) { out = Json (true); return true; } break;
            case 'f': if (consume ("false")) { out = Json (false); return true; } break;
            case 'n': if (consume ("null")) { out = Json(); return true; } break;
            default: break;
        }
        if (*p == '-' || (*p >= '0' && *p <= '9'))
            return parseNumber (out);
        return fail ("unexpected character");
    }
};

} // namespace

std::optional<Json> Json::parse (const std::string& text, std::string* error)
{
    Parser parser { text.data(), text.data() + text.size(), {} };
    Json value;
    if (parser.parseValue (value, 0))
    {
        parser.skipSpace();
        if (parser.p == parser.end)
            return value;
        parser.fail ("trailing characters");
    }
    if (error != nullptr)
        *error = parser.error + " at offset " + std::to_string (parser.p - text.data());
    return std::nullopt;
}

} // namespace ghostdaw
