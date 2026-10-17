#include "Files.h"

#include "Platform.h"
#include "Strings.h"

#include <algorithm>
#include <cstdio>
#include <cstdlib>
#include <fstream>
#include <system_error>

#if GHOSTDAW_WINDOWS
 #include <windows.h>
 #include <shlobj.h>
#else
 #include <sys/stat.h>
 #include <unistd.h>
#endif

namespace ghostdaw
{

fs::path pathFromUtf8 (const std::string& utf8)
{
    return fs::u8path (utf8);
}

std::string pathToUtf8 (const fs::path& path)
{
    auto u8 = path.u8string();
    return std::string (u8.begin(), u8.end());
}

fs::path homeDir()
{
   #if GHOSTDAW_WINDOWS
    if (auto* profile = std::getenv ("USERPROFILE"))
        return fs::path (profile);
    return {};
   #else
    if (auto* home = std::getenv ("HOME"))
        return fs::path (home);
    return {};
   #endif
}

fs::path defaultDataDir()
{
   #if GHOSTDAW_WINDOWS
    PWSTR folder = nullptr;
    fs::path base;
    if (SHGetKnownFolderPath (FOLDERID_RoamingAppData, 0, nullptr, &folder) == S_OK)
        base = fs::path (folder);
    if (folder != nullptr)
        CoTaskMemFree (folder);
    if (base.empty())
        if (auto* appData = std::getenv ("APPDATA"))
            base = fs::path (appData);
    return base / "NoProd" / "GhostDAW";
   #elif GHOSTDAW_MAC
    return homeDir() / "Library" / "Application Support" / "NoProd" / "GhostDAW";
   #else
    if (auto* xdg = std::getenv ("XDG_CONFIG_HOME"); xdg != nullptr && *xdg != 0)
        return fs::path (xdg) / "NoProd" / "GhostDAW";
    return homeDir() / ".config" / "NoProd" / "GhostDAW";
   #endif
}

bool fileExists (const fs::path& path)
{
    std::error_code ec;
    return fs::is_regular_file (path, ec);
}

bool directoryExists (const fs::path& path)
{
    std::error_code ec;
    return fs::is_directory (path, ec);
}

bool createDirectories (const fs::path& path)
{
    std::error_code ec;
    fs::create_directories (path, ec);
    return directoryExists (path);
}

bool readFile (const fs::path& path, std::string& out)
{
    std::ifstream in (path, std::ios::binary);
    if (! in)
        return false;
    out.assign (std::istreambuf_iterator<char> (in), std::istreambuf_iterator<char>());
    return ! in.bad();
}

bool writeFile (const fs::path& path, const std::string& contents)
{
    auto temporary = path;
    temporary += ".tmp";
    {
        std::ofstream out (temporary, std::ios::binary | std::ios::trunc);
        if (! out)
            return false;
        out.write (contents.data(), static_cast<std::streamsize> (contents.size()));
        if (! out)
            return false;
    }
    std::error_code ec;
    fs::rename (temporary, path, ec);
    if (ec)
    {
        fs::remove (temporary, ec);
        return false;
    }
    return true;
}

bool restrictToOwner (const fs::path& path)
{
   #if GHOSTDAW_WINDOWS
    (void) path;
    return true;
   #else
    return ::chmod (path.c_str(), S_IRUSR | S_IWUSR) == 0;
   #endif
}

bool removeFile (const fs::path& path)
{
    std::error_code ec;
    return fs::remove (path, ec);
}

std::vector<fs::path> listFiles (const fs::path& dir, const std::vector<std::string>& extensions, size_t limit)
{
    std::vector<fs::path> result;
    std::error_code ec;
    if (! fs::is_directory (dir, ec))
        return result;

    size_t visited = 0;
    fs::recursive_directory_iterator it (dir, fs::directory_options::skip_permission_denied, ec), end;
    for (; ! ec && it != end && visited < limit; it.increment (ec))
    {
        ++visited;
        auto& entry = *it;
        if (entry.is_symlink (ec))
        {
            if (entry.is_directory (ec))
                it.disable_recursion_pending();
            continue;
        }
        if (! entry.is_regular_file (ec))
            continue;
        auto extension = lowerCase (pathToUtf8 (entry.path().extension()));
        if (std::find (extensions.begin(), extensions.end(), extension) != extensions.end())
            result.push_back (entry.path());
    }
    std::sort (result.begin(), result.end());
    return result;
}

std::vector<fs::path> listBundles (const fs::path& dir, const std::string& extension, size_t limit)
{
    std::vector<fs::path> result;
    std::error_code ec;
    if (! fs::is_directory (dir, ec))
        return result;

    size_t visited = 0;
    auto wanted = lowerCase (extension);
    for (fs::recursive_directory_iterator it (dir, fs::directory_options::skip_permission_denied, ec), end; ! ec && it != end && visited < limit; it.increment (ec))
    {
        ++visited;
        if (! it->is_directory (ec))
            continue;
        auto name = lowerCase (pathToUtf8 (it->path().filename()));
        auto isBundle = name.size() > wanted.size() && name.compare (name.size() - wanted.size(), wanted.size(), wanted) == 0;
        // The walk follows no symlinked folder (a link back up would loop),
        // but a symlink to a bundle is a bundle: the VST3 SDK links each
        // plug-in it builds into the user's folder that way
        if (isBundle)
            result.push_back (it->path());
        if (isBundle || it->is_symlink (ec))
            it.disable_recursion_pending(); // what a bundle holds is its own
    }
    std::sort (result.begin(), result.end());
    return result;
}

} // namespace ghostdaw
