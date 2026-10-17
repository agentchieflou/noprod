#include "Log.h"

#include "Platform.h"

#include <atomic>
#include <cstdio>
#include <mutex>

namespace ghostdaw::Log
{

namespace
{
std::atomic<int> currentLevel { static_cast<int> (Level::info) };
std::mutex lock;
std::filesystem::path filePath;
std::FILE* file = nullptr;
}

void setLevel (Level level) { currentLevel.store (static_cast<int> (level)); }
Level getLevel() { return static_cast<Level> (currentLevel.load()); }

const char* levelName (Level level)
{
    switch (level)
    {
        case Level::debug: return "DEBUG";
        case Level::info:  return "INFO";
        case Level::warn:  return "WARN";
        case Level::error: return "ERROR";
    }
    return "?";
}

bool setFile (const std::filesystem::path& path)
{
    const std::lock_guard<std::mutex> guard (lock);
    if (file != nullptr)
    {
        std::fclose (file);
        file = nullptr;
    }
    filePath = path;
    if (path.empty())
        return true;
   #if GHOSTDAW_WINDOWS
    file = _wfopen (path.c_str(), L"a");
   #else
    file = std::fopen (path.c_str(), "a");
   #endif
    return file != nullptr;
}

std::filesystem::path getFile()
{
    const std::lock_guard<std::mutex> guard (lock);
    return filePath;
}

void write (Level level, const std::string& message)
{
    if (static_cast<int> (level) < currentLevel.load())
        return;

    auto line = timestampNow() + " " + levelName (level) + " " + message + "\n";

    const std::lock_guard<std::mutex> guard (lock);
    std::fputs (line.c_str(), stderr);
    std::fflush (stderr);
    if (file != nullptr)
    {
        std::fputs (line.c_str(), file);
        std::fflush (file);
    }
}

} // namespace ghostdaw::Log
