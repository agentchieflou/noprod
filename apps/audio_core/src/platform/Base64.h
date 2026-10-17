#pragma once

#include <cstdint>
#include <string>
#include <vector>

namespace ghostdaw
{

std::string base64Encode (const void* data, size_t size);
// Standard alphabet with padding; nullopt-like empty result for bad input
bool base64Decode (const std::string& text, std::vector<uint8_t>& out);

std::string hexEncode (const void* data, size_t size);
bool hexDecode (const std::string& text, std::vector<uint8_t>& out);

} // namespace ghostdaw
