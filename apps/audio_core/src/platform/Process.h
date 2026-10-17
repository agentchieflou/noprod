#pragma once

#include "Files.h"

#include <functional>
#include <string>

namespace ghostdaw
{

// One GhostDAW at a time: a lock on a file in the data folder (a named
// mutex on Windows). Released when destroyed, and by the OS if the process
// dies.
class InstanceLock
{
public:
    explicit InstanceLock (const fs::path& lockFile);
    ~InstanceLock();
    InstanceLock (const InstanceLock&) = delete;
    InstanceLock& operator= (const InstanceLock&) = delete;

    // False if another process holds it
    bool isHeld() const { return held; }

private:
    bool held = false;
    intptr_t handle = -1;
    fs::path path;
};

// On a crash (a segfault or other fatal signal, an abort, an unhandled
// Windows exception), appends what happened, with a backtrace where the
// platform has one, to `logFile`, then lets the process die. Install once.
void installCrashHandler (const fs::path& logFile);

// Runs `handler` once on Ctrl+C, SIGTERM or a console close (from a
// signal handler or a system thread: it must only set flags and wake things)
void onTerminationRequest (std::function<void()> handler);

// A client closing its socket mid-write must fail that write, not kill
// the process (POSIX)
void ignoreSigpipe();

} // namespace ghostdaw
