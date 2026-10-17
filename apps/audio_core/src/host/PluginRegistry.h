#pragma once

#include "../platform/Files.h"
#include "../platform/Json.h"

#include <cstdint>
#include <mutex>
#include <string>
#include <vector>

namespace ghostdaw
{

// A plugin the scanner found: what a client may ask for by pluginId
struct KnownPlugin
{
    std::string pluginId, name, vendor, format, path;
    int64_t modified = 0; // the binary's modification time, to notice a new build
};

// A binary the scanner gave up on (it crashed, hung or could not be
// loaded), skipped until it changes
struct SkippedPlugin
{
    std::string path, reason;
    int64_t modified = 0;
};

// What GhostDAW knows about plugins, kept across launches in its data
// folder: plugins.json (the scanned list and the skipped binaries) and
// settings.json (the folders the user added, under "scanFolders").
// Clients never name a path: they load by pluginId from this list, and
// scans cover the platform's plugin folders plus the settings' folders.
//
// Any thread may call it (the scanner writes results from its own thread).
class PluginRegistry
{
public:
    explicit PluginRegistry (const fs::path& dataDir);

    std::vector<KnownPlugin> getPlugins() const;
    bool find (const std::string& pluginId, KnownPlugin& out) const;
    std::vector<SkippedPlugin> getSkipped() const;

    // After a scan: the new list, saved
    void replace (std::vector<KnownPlugin> plugins, std::vector<SkippedPlugin> skipped);

    // The dead man's pedal: the binary about to be scanned is written down
    // first, so a scan that takes GhostDAW itself down (not just its scan
    // worker) blocklists it at the next launch
    void markScanning (const fs::path& file);
    void clearScanning();

    // The folders a scan covers: the platform's own plugin folders and the
    // user's (settings.json), existing or not
    std::vector<fs::path> getScanFolders() const;
    std::vector<fs::path> getUserScanFolders() const;
    bool addUserScanFolder (const fs::path& folder); // saved; false if it is there already
    bool removeUserScanFolder (const fs::path& folder);
    static std::vector<fs::path> defaultScanFolders();

    // For AUDIO_CORE_STATE
    Json describePlugins() const;
    Json describeSkipped() const;
    Json describeScanFolders() const;

    fs::path getPluginsFile() const { return pluginsFile; }
    fs::path getSettingsFile() const { return settingsFile; }

    // The file's modification time in seconds of the file clock (its epoch
    // differs between C++ libraries: only a change in the value means
    // anything). 0 when the file can't be read.
    static int64_t modificationTime (const fs::path& file);

private:
    fs::path pluginsFile, settingsFile, scanningFile;
    mutable std::mutex lock;
    std::vector<KnownPlugin> plugins;
    std::vector<SkippedPlugin> skipped;
    std::vector<fs::path> userFolders;

    void load();
    void savePlugins() const;  // under the lock
    void saveSettings() const; // under the lock
};

} // namespace ghostdaw
