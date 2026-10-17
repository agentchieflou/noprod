#pragma once

#include <cstdint>
#include <string>
#include <vector>

namespace ghostdaw
{

std::string trim (const std::string& text);
std::vector<std::string> split (const std::string& text, char separator); // empty pieces kept
std::string lowerCase (std::string text);
bool equalsIgnoreCase (const std::string& a, const std::string& b);
bool startsWith (const std::string& text, const std::string& prefix);
bool endsWith (const std::string& text, const std::string& suffix);
bool containsOnly (const std::string& text, const std::string& allowed);

// True for well-formed UTF-8 (RFC 3629: no overlongs, no surrogates, max U+10FFFF)
bool isValidUtf8 (const char* data, size_t size);

} // namespace ghostdaw
