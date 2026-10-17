#include "ChildProcess.h"

#include "Platform.h"

#include <cstring>

#if GHOSTDAW_WINDOWS
 #include <windows.h>
#else
 #include <cerrno>
 #include <csignal>
 #include <fcntl.h>
 #include <poll.h>
 #include <spawn.h>
 #include <sys/wait.h>
 #include <unistd.h>
 #if GHOSTDAW_MAC
  #include <mach-o/dyld.h>
 #endif
 extern char** environ;
#endif

namespace ghostdaw
{

#if GHOSTDAW_WINDOWS

// One argument quoted the way CommandLineToArgvW reads it back
static std::wstring quoteArgument (const std::wstring& argument)
{
    if (! argument.empty() && argument.find_first_of (L" \t\"") == std::wstring::npos)
        return argument;
    std::wstring out = L"\"";
    size_t backslashes = 0;
    for (auto c : argument)
    {
        if (c == L'\\')
        {
            ++backslashes;
            continue;
        }
        if (c == L'"')
        {
            out.append (backslashes * 2 + 1, L'\\');
            out += L'"';
        }
        else
        {
            out.append (backslashes, L'\\');
            out += c;
        }
        backslashes = 0;
    }
    out.append (backslashes * 2, L'\\');
    out += L'"';
    return out;
}

ChildProcessResult runChildProcess (const fs::path& program, const std::vector<std::string>& arguments, int timeoutMs)
{
    ChildProcessResult result;

    SECURITY_ATTRIBUTES inheritable { sizeof (SECURITY_ATTRIBUTES), nullptr, TRUE };
    HANDLE readEnd = nullptr, writeEnd = nullptr;
    if (! CreatePipe (&readEnd, &writeEnd, &inheritable, 0))
    {
        result.error = "CreatePipe failed";
        return result;
    }
    SetHandleInformation (readEnd, HANDLE_FLAG_INHERIT, 0);

    std::wstring commandLine = quoteArgument (program.wstring());
    for (auto& argument : arguments)
        commandLine += L" " + quoteArgument (pathFromUtf8 (argument).wstring());

    STARTUPINFOW startup {};
    startup.cb = sizeof (startup);
    startup.dwFlags = STARTF_USESTDHANDLES;
    startup.hStdInput = GetStdHandle (STD_INPUT_HANDLE);
    startup.hStdOutput = writeEnd;
    startup.hStdError = GetStdHandle (STD_ERROR_HANDLE);
    PROCESS_INFORMATION process {};
    std::vector<wchar_t> mutableLine (commandLine.begin(), commandLine.end());
    mutableLine.push_back (0);
    auto created = CreateProcessW (program.c_str(), mutableLine.data(), nullptr, nullptr, TRUE, CREATE_NO_WINDOW, nullptr, nullptr, &startup, &process);
    CloseHandle (writeEnd);
    if (! created)
    {
        result.error = "CreateProcess failed with error " + std::to_string (GetLastError());
        CloseHandle (readEnd);
        return result;
    }
    result.started = true;

    // Read until the pipe closes or time runs out (the child must be
    // killed first in that case, or the read never ends)
    auto deadline = monotonicMs() + timeoutMs;
    for (;;)
    {
        DWORD available = 0;
        if (! PeekNamedPipe (readEnd, nullptr, 0, nullptr, &available, nullptr))
            break; // the write end closed
        if (available > 0)
        {
            char buffer[4096];
            DWORD got = 0;
            if (! ReadFile (readEnd, buffer, sizeof (buffer), &got, nullptr) || got == 0)
                break;
            result.output.append (buffer, got);
            continue;
        }
        if (WaitForSingleObject (process.hProcess, 0) == WAIT_OBJECT_0)
        {
            // Exited: drain what's left
            if (PeekNamedPipe (readEnd, nullptr, 0, nullptr, &available, nullptr) && available > 0)
                continue;
            break;
        }
        if (monotonicMs() > deadline)
        {
            TerminateProcess (process.hProcess, 1);
            result.timedOut = true;
            break;
        }
        Sleep (5);
    }
    WaitForSingleObject (process.hProcess, result.timedOut ? 5000 : INFINITE);
    DWORD code = 0;
    GetExitCodeProcess (process.hProcess, &code);
    if (! result.timedOut)
    {
        // An exception code (0xC0000005 and the like) is a crash
        result.crashed = (code & 0xC0000000u) == 0xC0000000u;
        result.exitCode = result.crashed ? -1 : static_cast<int> (code);
    }
    CloseHandle (readEnd);
    CloseHandle (process.hThread);
    CloseHandle (process.hProcess);
    return result;
}

fs::path currentExecutablePath()
{
    wchar_t buffer[MAX_PATH * 4];
    auto length = GetModuleFileNameW (nullptr, buffer, static_cast<DWORD> (sizeof (buffer) / sizeof (buffer[0])));
    return length > 0 ? fs::path (std::wstring (buffer, length)) : fs::path();
}

#else

ChildProcessResult runChildProcess (const fs::path& program, const std::vector<std::string>& arguments, int timeoutMs)
{
    ChildProcessResult result;

    int pipeFds[2];
    if (::pipe (pipeFds) != 0)
    {
        result.error = "pipe() failed";
        return result;
    }
    fcntl (pipeFds[0], F_SETFD, FD_CLOEXEC);
    fcntl (pipeFds[1], F_SETFD, FD_CLOEXEC);

    std::vector<std::string> strings { pathToUtf8 (program) };
    strings.insert (strings.end(), arguments.begin(), arguments.end());
    std::vector<char*> argv;
    for (auto& s : strings)
        argv.push_back (const_cast<char*> (s.c_str()));
    argv.push_back (nullptr);

    posix_spawn_file_actions_t actions;
    posix_spawn_file_actions_init (&actions);
    posix_spawn_file_actions_adddup2 (&actions, pipeFds[1], STDOUT_FILENO);
    pid_t pid = 0;
    auto spawned = posix_spawn (&pid, strings[0].c_str(), &actions, nullptr, argv.data(), environ);
    posix_spawn_file_actions_destroy (&actions);
    ::close (pipeFds[1]);
    if (spawned != 0)
    {
        result.error = std::string ("posix_spawn: ") + std::strerror (spawned);
        ::close (pipeFds[0]);
        return result;
    }
    result.started = true;

    auto deadline = monotonicMs() + timeoutMs;
    for (;;)
    {
        auto remaining = static_cast<int> (deadline - monotonicMs());
        if (remaining <= 0)
        {
            ::kill (pid, SIGKILL);
            result.timedOut = true;
            break;
        }
        pollfd fd { pipeFds[0], POLLIN, 0 };
        auto ready = ::poll (&fd, 1, remaining);
        if (ready < 0 && errno == EINTR)
            continue;
        if (ready <= 0)
            continue; // the timeout check above
        char buffer[4096];
        auto got = ::read (pipeFds[0], buffer, sizeof (buffer));
        if (got < 0 && errno == EINTR)
            continue;
        if (got <= 0)
            break; // the child closed its stdout (it exited, usually)
        result.output.append (buffer, static_cast<size_t> (got));
    }
    ::close (pipeFds[0]);

    int status = 0;
    while (waitpid (pid, &status, 0) < 0 && errno == EINTR) {}
    if (! result.timedOut)
    {
        if (WIFEXITED (status))
            result.exitCode = WEXITSTATUS (status);
        else if (WIFSIGNALED (status))
            result.crashed = true;
    }
    return result;
}

fs::path currentExecutablePath()
{
   #if GHOSTDAW_MAC
    char buffer[4096];
    uint32_t size = sizeof (buffer);
    if (_NSGetExecutablePath (buffer, &size) == 0)
    {
        std::error_code ec;
        auto resolved = fs::canonical (fs::path (buffer), ec);
        return ec ? fs::path (buffer) : resolved;
    }
    return {};
   #else
    std::error_code ec;
    auto path = fs::read_symlink ("/proc/self/exe", ec);
    return ec ? fs::path() : path;
   #endif
}

#endif

} // namespace ghostdaw
