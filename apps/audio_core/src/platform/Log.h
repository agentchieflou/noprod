#pragma once

#include <filesystem>
#include <string>

// Logging with timestamps and levels, to stderr and (once a file is set) a
// log file. Any thread may log. The crash handler writes to the same file.
//
//   Log::info ("listening on " + std::to_string (port));
//   Log::warn (...); Log::error (...); Log::debug (...)   (debug is off by default)
namespace ghostdaw::Log
{

enum class Level { debug = 0, info = 1, warn = 2, error = 3 };

// Lines below this level are dropped
void setLevel (Level level);
Level getLevel();

// Also append every line to this file (created if missing). An empty path
// stops file logging. Fails quietly: a log that can't be written mustn't
// stop the host.
bool setFile (const std::filesystem::path& path);
std::filesystem::path getFile();

void write (Level level, const std::string& message);

inline void debug (const std::string& message) { write (Level::debug, message); }
inline void info (const std::string& message) { write (Level::info, message); }
inline void warn (const std::string& message) { write (Level::warn, message); }
inline void error (const std::string& message) { write (Level::error, message); }

const char* levelName (Level level);

} // namespace ghostdaw::Log
