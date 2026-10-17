#include "PluginRegistry.h"

#include "../platform/Log.h"
#include "../platform/Platform.h"

#include <algorithm>
#include <chrono>
#include <cstdlib>

namespace ghostdaw
{

PluginRegistry::PluginRegistry (const fs::path& dataDir)
    : pluginsFile (dataDir / "plugins.json"), settingsFile (dataDir / "settings.json"), scanningFile (dataDir / "scanning.json")
{
    createDirectories (dataDir);
    load();
}

int64_t PluginRegistry::modificationTime (const fs::path& file)
{
    std::error_code ec;
    auto time = fs::last_write_time (file, ec);
    if (ec)
        return 0;
    return static_cast<int64_t> (std::chrono::duration_cast<std::chrono::seconds> (time.time_since_epoch()).count());
}

void PluginRegistry::load()
{
    const std::lock_guard<std::mutex> guard (lock);
    std::string text;

    if (readFile (pluginsFile, text))
    {
        if (auto json = Json::parse (text))
        {
            for (auto& p : (*json)["plugins"].elements())
                if (! p["pluginId"].toString().empty() && ! p["path"].toString().empty())
                    plugins.push_back ({ p["pluginId"].toString(), p["name"].toString(), p["vendor"].toString(), p["format"].toString(),
                                         p["path"].toString(), p["modified"].toInt64() });
            for (auto& s : (*json)["skipped"].elements())
                if (! s["path"].toString().empty())
                    skipped.push_back ({ s["path"].toString(), s["reason"].toString(), s["modified"].toInt64() });
        }
        else
        {
            Log::warn ("ignoring the unreadable plugin list " + pathToUtf8 (pluginsFile));
        }
    }

    if (readFile (settingsFile, text))
    {
        if (auto json = Json::parse (text))
        {
            for (auto& f : (*json)["scanFolders"].elements())
                if (! f.toString().empty())
                    userFolders.push_back (pathFromUtf8 (f.toString()));
        }
        else
        {
            Log::warn ("ignoring the unreadable settings " + pathToUtf8 (settingsFile));
        }
    }

    // A scan that never finished: the binary it was on took GhostDAW down
    if (readFile (scanningFile, text))
    {
        if (auto json = Json::parse (text); json && ! (*json)["path"].toString().empty())
        {
            auto path = (*json)["path"].toString();
            Log::error ("the last scan did not survive " + path + ": skipping it from now on");
            skipped.erase (std::remove_if (skipped.begin(), skipped.end(), [&] (const SkippedPlugin& s) { return s.path == path; }), skipped.end());
            skipped.push_back ({ path, "GhostDAW did not survive scanning it", (*json)["modified"].toInt64() });
            savePlugins();
        }
        removeFile (scanningFile);
    }
}

void PluginRegistry::savePlugins() const
{
    Json root = Json::object();
    root.member ("plugins") = describePlugins();
    root.member ("skipped") = describeSkipped();
    if (! writeFile (pluginsFile, root.dump (2) + "\n"))
        Log::warn ("could not save the plugin list to " + pathToUtf8 (pluginsFile));
}

void PluginRegistry::saveSettings() const
{
    Json root = Json::object();
    auto& folders = root.member ("scanFolders");
    folders = Json::array();
    for (auto& f : userFolders)
        folders.push (pathToUtf8 (f));
    if (! writeFile (settingsFile, root.dump (2) + "\n"))
        Log::warn ("could not save the settings to " + pathToUtf8 (settingsFile));
}

std::vector<KnownPlugin> PluginRegistry::getPlugins() const
{
    const std::lock_guard<std::mutex> guard (lock);
    return plugins;
}

bool PluginRegistry::find (const std::string& pluginId, KnownPlugin& out) const
{
    const std::lock_guard<std::mutex> guard (lock);
    for (auto& p : plugins)
    {
        if (p.pluginId == pluginId)
        {
            out = p;
            return true;
        }
    }
    return false;
}

std::vector<SkippedPlugin> PluginRegistry::getSkipped() const
{
    const std::lock_guard<std::mutex> guard (lock);
    return skipped;
}

void PluginRegistry::replace (std::vector<KnownPlugin> newPlugins, std::vector<SkippedPlugin> newSkipped)
{
    const std::lock_guard<std::mutex> guard (lock);
    plugins = std::move (newPlugins);
    skipped = std::move (newSkipped);
    savePlugins();
}

void PluginRegistry::markScanning (const fs::path& file)
{
    writeFile (scanningFile, Json::object ({ { "path", pathToUtf8 (file) }, { "modified", modificationTime (file) } }).dump() + "\n");
}

void PluginRegistry::clearScanning()
{
    removeFile (scanningFile);
}

std::vector<fs::path> PluginRegistry::defaultScanFolders()
{
    std::vector<fs::path> folders;
   #if GHOSTDAW_WINDOWS
    if (auto* common = std::getenv ("COMMONPROGRAMFILES"))
        folders.push_back (fs::path (common) / "VST3");
    if (auto* local = std::getenv ("LOCALAPPDATA"))
        folders.push_back (fs::path (local) / "Programs" / "Common" / "VST3");
   #elif GHOSTDAW_MAC
    folders.push_back (homeDir() / "Library" / "Audio" / "Plug-Ins" / "VST3");
    folders.push_back ("/Library/Audio/Plug-Ins/VST3");
   #else
    folders.push_back (homeDir() / ".vst3");
    folders.push_back ("/usr/lib/vst3");
    folders.push_back ("/usr/local/lib/vst3");
   #endif
    return folders;
}

std::vector<fs::path> PluginRegistry::getUserScanFolders() const
{
    const std::lock_guard<std::mutex> guard (lock);
    return userFolders;
}

std::vector<fs::path> PluginRegistry::getScanFolders() const
{
    auto folders = defaultScanFolders();
    for (auto& f : getUserScanFolders())
        if (std::find (folders.begin(), folders.end(), f) == folders.end())
            folders.push_back (f);
    return folders;
}

bool PluginRegistry::addUserScanFolder (const fs::path& folder)
{
    const std::lock_guard<std::mutex> guard (lock);
    if (std::find (userFolders.begin(), userFolders.end(), folder) != userFolders.end())
        return false;
    userFolders.push_back (folder);
    saveSettings();
    return true;
}

bool PluginRegistry::removeUserScanFolder (const fs::path& folder)
{
    const std::lock_guard<std::mutex> guard (lock);
    auto it = std::find (userFolders.begin(), userFolders.end(), folder);
    if (it == userFolders.end())
        return false;
    userFolders.erase (it);
    saveSettings();
    return true;
}

Json PluginRegistry::describePlugins() const
{
    // (callers hold the lock, or it is the registry's own save)
    auto list = Json::array();
    for (auto& p : plugins)
        list.push (Json::object ({ { "name", p.name }, { "vendor", p.vendor }, { "format", p.format }, { "path", p.path },
                                   { "pluginId", p.pluginId }, { "modified", p.modified } }));
    return list;
}

Json PluginRegistry::describeSkipped() const
{
    auto list = Json::array();
    for (auto& s : skipped)
        list.push (Json::object ({ { "path", s.path }, { "reason", s.reason }, { "modified", s.modified } }));
    return list;
}

Json PluginRegistry::describeScanFolders() const
{
    auto list = Json::array();
    for (auto& f : getScanFolders())
        list.push (pathToUtf8 (f));
    return list;
}

} // namespace ghostdaw
