#pragma once

#include <filesystem>
#include <string>
#include <vector>

namespace ghostdaw
{

namespace fs = std::filesystem;

// Paths are UTF-8 strings at the API; std::filesystem does the OS encoding.
fs::path pathFromUtf8 (const std::string& utf8);
std::string pathToUtf8 (const fs::path& path);

// The user's app-data folder for GhostDAW: ~/.config/NoProd/GhostDAW on
// Linux, ~/Library/Application Support/NoProd/GhostDAW on macOS,
// %APPDATA%\NoProd\GhostDAW on Windows. Not created here.
fs::path defaultDataDir();

// The user's home folder (empty if unknown)
fs::path homeDir();

bool fileExists (const fs::path& path);
bool directoryExists (const fs::path& path);
bool createDirectories (const fs::path& path);

// Whole-file I/O. writeFile writes a temporary file beside the target and
// renames it over, so a crash mid-write never leaves a half file.
bool readFile (const fs::path& path, std::string& out);
bool writeFile (const fs::path& path, const std::string& contents);

// Owner read/write only (a no-op on Windows, where %APPDATA% is per user)
bool restrictToOwner (const fs::path& path);

bool removeFile (const fs::path& path);

// Files under `dir` (recursively, following no symlinks) whose extension
// (lower-cased, with the dot) is in `extensions`; `limit` caps the walk so
// a huge folder can't stall forever. Sorted.
std::vector<fs::path> listFiles (const fs::path& dir, const std::vector<std::string>& extensions, size_t limit = 10000);

// Directories under `dir` (in subfolders too, but not inside another
// bundle, and following no symlinks) whose name ends in `extension`, e.g.
// ".vst3" bundles. Sorted.
std::vector<fs::path> listBundles (const fs::path& dir, const std::string& extension, size_t limit = 10000);


} // namespace ghostdaw
