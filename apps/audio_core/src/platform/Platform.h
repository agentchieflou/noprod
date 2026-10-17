#pragma once

// The platform layer GhostDAW is built on: no framework, just the C++17
// standard library and each OS's own APIs behind small headers. Everything
// here is dependency-free so the host, the scan worker and the tests build
// from a plain checkout with CMake.

#if defined(_WIN32)
 #define GHOSTDAW_WINDOWS 1
#elif defined(__APPLE__)
 #define GHOSTDAW_MAC 1
#else
 #define GHOSTDAW_LINUX 1
#endif

#if GHOSTDAW_WINDOWS
 #ifndef WIN32_LEAN_AND_MEAN
  #define WIN32_LEAN_AND_MEAN
 #endif
 #ifndef NOMINMAX
  #define NOMINMAX
 #endif
#endif

#include <cstdint>
#include <string>

namespace ghostdaw
{

// The shared-library extension plugins use on this platform
#if GHOSTDAW_WINDOWS
inline constexpr const char* sharedLibraryExtension = ".dll";
#elif GHOSTDAW_MAC
inline constexpr const char* sharedLibraryExtension = ".dylib";
#else
inline constexpr const char* sharedLibraryExtension = ".so";
#endif

// Monotonic milliseconds, for timing
double monotonicMs();

// Wall-clock milliseconds since the Unix epoch (the browser compares its
// own clock against these, same machine)
double wallClockMs();

// "YYYY-MM-DD HH:MM:SS.mmm" in local time
std::string timestampNow();

void sleepMs (int ms);

} // namespace ghostdaw
