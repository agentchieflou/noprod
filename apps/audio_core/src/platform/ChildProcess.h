#pragma once

#include "Files.h"

#include <string>
#include <vector>

namespace ghostdaw
{

// Runs a program to completion, capturing its standard output, with a
// time limit: the plugin scanner runs itself once per plugin binary, so a
// plugin that crashes or hangs while loading takes a child down, not
// GhostDAW. Standard error is left attached to ours (it shows in the log).
struct ChildProcessResult
{
    bool started = false;   // the program could be run at all
    bool timedOut = false;  // killed at the limit
    bool crashed = false;   // ended by a signal (POSIX) or an exception (Windows)
    int exitCode = -1;      // when it exited normally
    std::string output;     // its standard output
    std::string error;      // why it couldn't be started
};

ChildProcessResult runChildProcess (const fs::path& program, const std::vector<std::string>& arguments, int timeoutMs);

// This executable's path (the scanner runs it again with --scan-file)
fs::path currentExecutablePath();

} // namespace ghostdaw
