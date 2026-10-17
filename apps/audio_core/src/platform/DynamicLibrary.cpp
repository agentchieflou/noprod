#include "DynamicLibrary.h"

#include "Platform.h"

#if GHOSTDAW_WINDOWS
 #include <windows.h>
#else
 #include <dlfcn.h>
#endif

namespace ghostdaw
{

DynamicLibrary& DynamicLibrary::operator= (DynamicLibrary&& other) noexcept
{
    if (this != &other)
    {
        close();
        handle = other.handle;
        other.handle = nullptr;
    }
    return *this;
}

bool DynamicLibrary::open (const fs::path& path, std::string& error)
{
    close();
   #if GHOSTDAW_WINDOWS
    // Let the binary find DLLs beside it, as a plugin folder expects
    handle = LoadLibraryExW (path.c_str(), nullptr, LOAD_WITH_ALTERED_SEARCH_PATH);
    if (handle == nullptr)
    {
        error = "LoadLibrary failed with error " + std::to_string (GetLastError());
        return false;
    }
   #else
    handle = dlopen (path.c_str(), RTLD_NOW | RTLD_LOCAL);
    if (handle == nullptr)
    {
        auto* reason = dlerror();
        error = reason != nullptr ? reason : "dlopen failed";
        return false;
    }
   #endif
    return true;
}

void DynamicLibrary::close()
{
    if (handle == nullptr)
        return;
   #if GHOSTDAW_WINDOWS
    FreeLibrary (static_cast<HMODULE> (handle));
   #else
    dlclose (handle);
   #endif
    handle = nullptr;
}

void* DynamicLibrary::getFunction (const char* name) const
{
    if (handle == nullptr)
        return nullptr;
   #if GHOSTDAW_WINDOWS
    return reinterpret_cast<void*> (GetProcAddress (static_cast<HMODULE> (handle), name));
   #else
    return dlsym (handle, name);
   #endif
}

} // namespace ghostdaw
