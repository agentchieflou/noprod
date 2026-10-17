#include "Platform.h"

#include <chrono>
#include <cstdio>
#include <ctime>
#include <thread>

namespace ghostdaw
{

double monotonicMs()
{
    using namespace std::chrono;
    return static_cast<double> (duration_cast<microseconds> (steady_clock::now().time_since_epoch()).count()) / 1000.0;
}

double wallClockMs()
{
    using namespace std::chrono;
    return static_cast<double> (duration_cast<microseconds> (system_clock::now().time_since_epoch()).count()) / 1000.0;
}

std::string timestampNow()
{
    using namespace std::chrono;
    auto now = system_clock::now();
    auto seconds = system_clock::to_time_t (now);
    auto millis = duration_cast<milliseconds> (now.time_since_epoch()).count() % 1000;

    std::tm local {};
   #if GHOSTDAW_WINDOWS
    localtime_s (&local, &seconds);
   #else
    localtime_r (&seconds, &local);
   #endif

    char buffer[80];
    std::snprintf (buffer, sizeof (buffer), "%04d-%02d-%02d %02d:%02d:%02d.%03d",
                   local.tm_year + 1900, local.tm_mon + 1, local.tm_mday,
                   local.tm_hour, local.tm_min, local.tm_sec, static_cast<int> (millis));
    return buffer;
}

void sleepMs (int ms)
{
    std::this_thread::sleep_for (std::chrono::milliseconds (ms));
}

} // namespace ghostdaw
