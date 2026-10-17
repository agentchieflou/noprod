#pragma once

#include "Files.h"

#include <string>

namespace ghostdaw
{

// A shared library loaded at run time (a plugin binary). Unloaded when
// destroyed; move-only.
class DynamicLibrary
{
public:
    DynamicLibrary() = default;
    ~DynamicLibrary() { close(); }
    DynamicLibrary (DynamicLibrary&& other) noexcept : handle (other.handle) { other.handle = nullptr; }
    DynamicLibrary& operator= (DynamicLibrary&& other) noexcept;
    DynamicLibrary (const DynamicLibrary&) = delete;
    DynamicLibrary& operator= (const DynamicLibrary&) = delete;

    // Fills `error` (the OS's reason) when it fails
    bool open (const fs::path& path, std::string& error);
    void close();
    bool isOpen() const { return handle != nullptr; }

    void* getFunction (const char* name) const;

private:
    void* handle = nullptr;
};

} // namespace ghostdaw
