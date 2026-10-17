#include "Pairing.h"

#include "Random.h"
#include "Strings.h"

#include <stdexcept>

namespace ghostdaw
{

namespace
{
constexpr const char* codeAlphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
constexpr size_t codeLength = 8;
constexpr size_t tokenBytes = 32;

bool constantTimeEquals (const std::string& a, const std::string& b)
{
    if (a.size() != b.size())
        return false;
    unsigned char difference = 0;
    for (size_t i = 0; i < a.size(); ++i)
        difference |= static_cast<unsigned char> (a[i] ^ b[i]);
    return difference == 0;
}
} // namespace

Pairing::Pairing (const fs::path& dataDir) : tokenPath (dataDir / "pairing-token")
{
    createDirectories (dataDir);

    std::string stored;
    if (readFile (tokenPath, stored))
    {
        stored = trim (stored);
        if (stored.size() == tokenBytes * 2 && containsOnly (stored, "0123456789abcdef"))
            token = stored;
    }
    if (token.empty())
    {
        token = secureRandomHex (tokenBytes);
        save();
    }
    code = makeCode();
}

void Pairing::save()
{
    if (! writeFile (tokenPath, token + "\n"))
        throw std::runtime_error ("could not write the pairing token to " + pathToUtf8 (tokenPath));
    restrictToOwner (tokenPath);
}

std::string Pairing::getToken() const
{
    const std::lock_guard<std::mutex> guard (lock);
    return token;
}

std::string Pairing::rotateToken()
{
    const std::lock_guard<std::mutex> guard (lock);
    token = secureRandomHex (tokenBytes);
    save();
    return token;
}

std::string Pairing::makeCode()
{
    std::string out;
    for (size_t i = 0; i < codeLength; ++i)
    {
        if (i == codeLength / 2)
            out += '-';
        out += codeAlphabet[secureRandomBelow (32)];
    }
    return out;
}

std::string Pairing::normaliseCode (const std::string& typed)
{
    std::string out;
    for (auto c : typed)
    {
        if (c >= 'a' && c <= 'z')
            c = static_cast<char> (c - 'a' + 'A');
        if ((c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9'))
            out += c;
    }
    return out;
}

std::string Pairing::getCode() const
{
    const std::lock_guard<std::mutex> guard (lock);
    return code;
}

bool Pairing::tryCode (const std::string& typed)
{
    if (isLocked())
        return false;
    bool matches;
    {
        const std::lock_guard<std::mutex> guard (lock);
        matches = constantTimeEquals (normaliseCode (typed), normaliseCode (code));
    }
    if (! matches)
        ++failures;
    return matches;
}

bool Pairing::checkToken (const std::string& presented) const
{
    const std::lock_guard<std::mutex> guard (lock);
    return constantTimeEquals (lowerCase (presented), token);
}

} // namespace ghostdaw
