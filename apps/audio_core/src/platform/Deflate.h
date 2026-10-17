#pragma once

#include <cstddef>
#include <cstdint>
#include <vector>

namespace ghostdaw
{

// zlib-format DEFLATE (RFC 1950 and 1951), for the plugin editor frames
// the browser inflates with DecompressionStream('deflate'). Our own
// encoder: LZ77 over a hash chain with the fixed Huffman code, which is
// what UI pixels (long runs, repeated rows) compress well with and what a
// frame has to be encoded with in under a millisecond or two.
//
// level 0 writes stored blocks (no compression); 1..9 trade match effort
// for ratio.
std::vector<uint8_t> zlibCompress (const uint8_t* data, size_t size, int level = 1);

// Inflates what zlibCompress (or zlib) produced, for the tests. False on
// a malformed stream; dynamic Huffman blocks are supported too.
bool zlibDecompress (const uint8_t* data, size_t size, std::vector<uint8_t>& out);

uint32_t adler32 (const uint8_t* data, size_t size);

} // namespace ghostdaw
