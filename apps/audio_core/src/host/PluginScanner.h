#pragma once

#include "../platform/Files.h"
#include "../platform/Json.h"
#include "../platform/Loop.h"
#include "PluginRegistry.h"

#include <atomic>
#include <functional>
#include <string>
#include <thread>
#include <vector>

namespace ghostdaw
{

// Finds plugins in the scan folders, each binary loaded in a child
// process (ghostdaw --scan-file FILE) with a time limit, so one that
// crashes or hangs while loading is written down as skipped and reported,
// and never touches GhostDAW itself. Binaries already known, and skipped
// ones, are not loaded again until their file changes. On macOS the
// Audio Units the system registers are listed too, by one more child
// (ghostdaw --scan-au), fresh at every scan.
//
// The scan runs on its own thread (plugins can take seconds to load);
// its result goes into the registry, and `onDone` runs on the loop.
class PluginScanner
{
public:
    struct Options
    {
        fs::path worker;       // the executable to run with --scan-file
        int timeoutMs = 20000; // per binary
    };

    PluginScanner (PluginRegistry& registryToFill, MessageLoop& loopToReportOn, Options scanOptions);
    ~PluginScanner();

    bool isScanning() const { return scanning.load(); }

    // Starts a scan; false if one is running. `onDone` gets a one-line
    // summary, on the loop thread.
    bool start (std::function<void (const std::string& summary)> onDone);

    // Blocks until the running scan (if any) finishes
    void wait();

    // What the worker does, in its own process: loads the binary and
    // describes the plugins in it, as { "plugins": [ { pluginId, name,
    // vendor, format } ] }, or { "error": "..." } when it is not one
    static Json describeFile (const fs::path& file);

    // The exit code the worker uses for a file that is no plugin
    static constexpr int notAPluginExitCode = 3;

    // The binaries a scan of these folders would look at
    static std::vector<fs::path> candidates (const std::vector<fs::path>& folders);

private:
    PluginRegistry& registry;
    MessageLoop& loop;
    Options options;
    std::thread thread;
    std::atomic<bool> scanning { false };

    std::string scan();
};

} // namespace ghostdaw
