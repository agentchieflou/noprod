#include "PluginScanner.h"

#include "../platform/ChildProcess.h"
#include "../platform/Log.h"
#include "../platform/Platform.h"
#include "../platform/Strings.h"
#include "LpiPlugin.h"

#include <algorithm>

namespace ghostdaw
{

PluginScanner::PluginScanner (PluginRegistry& registryToFill, MessageLoop& loopToReportOn, Options scanOptions)
    : registry (registryToFill), loop (loopToReportOn), options (std::move (scanOptions))
{
}

PluginScanner::~PluginScanner()
{
    wait();
}

void PluginScanner::wait()
{
    if (thread.joinable())
        thread.join();
}

bool PluginScanner::start (std::function<void (const std::string&)> onDone)
{
    if (scanning.exchange (true))
        return false;
    wait(); // the previous thread, finished
    thread = std::thread ([this, onDone = std::move (onDone)]
    {
        auto summary = scan();
        scanning.store (false);
        if (onDone)
            loop.post ([onDone, summary] { onDone (summary); });
    });
    return true;
}

std::vector<fs::path> PluginScanner::candidates (const std::vector<fs::path>& folders)
{
    std::vector<fs::path> files;
    for (auto& folder : folders)
    {
        if (! directoryExists (folder))
            continue;
        // LPI plugins are plain shared libraries (or .lpi). On macOS a
        // module built by CMake is .so, not .dylib, so both count there.
        // Binaries inside a .vst3 bundle belong to the VST3 scan.
        std::vector<std::string> extensions { sharedLibraryExtension, ".lpi" };
       #if GHOSTDAW_MAC
        extensions.push_back (".so");
       #endif
        for (auto& file : listFiles (folder, extensions, 2000))
        {
            auto inBundle = false;
            for (auto part = file.parent_path(); ! part.empty() && part != part.root_path(); part = part.parent_path())
                if (endsWith (lowerCase (pathToUtf8 (part.filename())), ".vst3"))
                    inBundle = true;
            if (! inBundle && std::find (files.begin(), files.end(), file) == files.end())
                files.push_back (file);
        }
    }
    return files;
}

Json PluginScanner::describeFile (const fs::path& file)
{
    std::string error;
    if (auto library = LpiLibrary::open (file, error))
    {
        auto plugins = Json::array();
        plugins.push (Json::object ({ { "pluginId", library->getId() }, { "name", library->getName() },
                                      { "vendor", library->getVendor() }, { "format", "LPI" } }));
        return Json::object ({ { "plugins", plugins } });
    }
    return Json::object ({ { "error", error } });
}

std::string PluginScanner::scan()
{
    auto folders = registry.getScanFolders();
    auto files = candidates (folders);
    auto known = registry.getPlugins();
    auto skipped = registry.getSkipped();

    std::vector<KnownPlugin> found;
    std::vector<SkippedPlugin> stillSkipped;
    int loaded = 0, kept = 0, newlySkipped = 0, notPlugins = 0;

    for (auto& file : files)
    {
        auto path = pathToUtf8 (file);
        auto modified = PluginRegistry::modificationTime (file);

        // Skipped and unchanged: still skipped
        auto wasSkipped = std::find_if (skipped.begin(), skipped.end(), [&] (const SkippedPlugin& s) { return s.path == path; });
        if (wasSkipped != skipped.end() && wasSkipped->modified == modified)
        {
            stillSkipped.push_back (*wasSkipped);
            continue;
        }

        // Known and unchanged: kept without loading again
        auto unchanged = false;
        for (auto& k : known)
        {
            if (k.path == path && k.modified == modified)
            {
                found.push_back (k);
                unchanged = true;
            }
        }
        if (unchanged)
        {
            ++kept;
            continue;
        }

        registry.markScanning (file);
        auto result = runChildProcess (options.worker, { "--scan-file", path }, options.timeoutMs);
        registry.clearScanning();

        if (! result.started)
        {
            Log::error ("plugin scan: cannot run the scan worker " + pathToUtf8 (options.worker) + ": " + result.error);
            return "the scan worker could not be run: " + result.error;
        }
        if (result.timedOut || result.crashed)
        {
            auto reason = result.timedOut ? "hung while loading (no answer within " + std::to_string (options.timeoutMs / 1000) + " s)"
                                          : std::string ("crashed while loading");
            Log::error ("plugin scan: " + path + " " + reason + "; skipping it from now on");
            stillSkipped.push_back ({ path, reason, modified });
            ++newlySkipped;
            continue;
        }
        if (result.exitCode == notAPluginExitCode)
        {
            ++notPlugins;
            continue;
        }
        auto parsed = Json::parse (result.output);
        if (result.exitCode != 0 || ! parsed || ! (*parsed)["plugins"].isArray())
        {
            auto reason = "the scan worker failed on it (exit " + std::to_string (result.exitCode) + ")";
            Log::error ("plugin scan: " + path + ": " + reason);
            stillSkipped.push_back ({ path, reason, modified });
            ++newlySkipped;
            continue;
        }
        for (auto& p : (*parsed)["plugins"].elements())
        {
            if (p["pluginId"].toString().empty())
                continue;
            found.push_back ({ p["pluginId"].toString(), p["name"].toString(), p["vendor"].toString(), p["format"].toString(), path, modified });
            ++loaded;
        }
    }

    registry.replace (std::move (found), std::move (stillSkipped));
    auto summary = std::to_string (loaded) + " plugin" + (loaded == 1 ? "" : "s") + " loaded, " + std::to_string (kept) + " kept, "
                 + std::to_string (notPlugins) + " other binaries, " + std::to_string (newlySkipped) + " skipped";
    Log::info ("plugin scan of " + std::to_string (folders.size()) + " folders: " + summary);
    return summary;
}

} // namespace ghostdaw
