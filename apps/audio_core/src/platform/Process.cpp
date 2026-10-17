#include "Process.h"

#include "Platform.h"

#include <atomic>
#include <csignal>
#include <cstring>
#include <ctime>
#include <vector>

#if GHOSTDAW_WINDOWS
 #include <windows.h>
 #include <io.h>
#else
 #include <fcntl.h>
 #include <sys/file.h>
 #include <unistd.h>
 #if GHOSTDAW_LINUX || GHOSTDAW_MAC
  #include <execinfo.h>
 #endif
#endif

namespace ghostdaw
{

// ---------------------------------------------------------- instance lock

InstanceLock::InstanceLock (const fs::path& lockFile) : path (lockFile)
{
   #if GHOSTDAW_WINDOWS
    // A named mutex, local to this session; the file name keys it so two
    // data folders may each have a GhostDAW
    auto name = L"Local\\NoProd.GhostDAW." + std::to_wstring (std::hash<std::wstring> {} (lockFile.wstring()));
    auto mutex = CreateMutexW (nullptr, TRUE, name.c_str());
    if (mutex == nullptr)
        return;
    if (GetLastError() == ERROR_ALREADY_EXISTS)
    {
        CloseHandle (mutex);
        return;
    }
    handle = reinterpret_cast<intptr_t> (mutex);
    held = true;
   #else
    auto fd = ::open (lockFile.c_str(), O_RDWR | O_CREAT | O_CLOEXEC, 0600);
    if (fd < 0)
        return;
    if (flock (fd, LOCK_EX | LOCK_NB) != 0)
    {
        ::close (fd);
        return;
    }
    handle = fd;
    held = true;
   #endif
}

InstanceLock::~InstanceLock()
{
    if (! held)
        return;
   #if GHOSTDAW_WINDOWS
    ReleaseMutex (reinterpret_cast<HANDLE> (handle));
    CloseHandle (reinterpret_cast<HANDLE> (handle));
   #else
    flock (static_cast<int> (handle), LOCK_UN);
    ::close (static_cast<int> (handle));
   #endif
}

// ---------------------------------------------------------- crash handler

namespace
{

// Everything a signal handler uses is set up beforehand; the handler
// itself only calls async-signal-safe functions (write, time, the
// backtrace functions, which are safe in practice).
#if GHOSTDAW_WINDOWS
HANDLE crashLog = INVALID_HANDLE_VALUE;
#else
int crashLog = -1;
#endif

void crashWrite (const char* text)
{
    auto length = std::strlen (text);
   #if GHOSTDAW_WINDOWS
    if (crashLog != INVALID_HANDLE_VALUE)
    {
        DWORD written = 0;
        WriteFile (crashLog, text, static_cast<DWORD> (length), &written, nullptr);
    }
    DWORD written = 0;
    WriteFile (GetStdHandle (STD_ERROR_HANDLE), text, static_cast<DWORD> (length), &written, nullptr);
   #else
    if (crashLog >= 0)
    {
        auto ignored = ::write (crashLog, text, length);
        (void) ignored;
    }
    auto ignored = ::write (2, text, length);
    (void) ignored;
   #endif
}

// Decimal without the C library (printf isn't async-signal-safe)
void crashWriteNumber (uint64_t value, int minimumDigits = 1)
{
    char digits[24];
    int count = 0;
    do
    {
        digits[count++] = static_cast<char> ('0' + value % 10);
        value /= 10;
    }
    while (value > 0 || count < minimumDigits);
    char out[25];
    for (int i = 0; i < count; ++i)
        out[i] = digits[count - 1 - i];
    out[count] = 0;
    crashWrite (out);
}

// The log's timestamp, UTC, from time() alone (civil-from-days, as in
// Howard Hinnant's date algorithms)
void crashWriteTimestamp()
{
    auto seconds = static_cast<int64_t> (std::time (nullptr));
    auto days = seconds / 86400;
    auto remainder = seconds % 86400;
    auto z = days + 719468;
    auto era = (z >= 0 ? z : z - 146096) / 146097;
    auto doe = static_cast<uint64_t> (z - era * 146097);
    auto yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    auto year = static_cast<int64_t> (yoe) + era * 400;
    auto doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    auto mp = (5 * doy + 2) / 153;
    auto day = doy - (153 * mp + 2) / 5 + 1;
    auto month = mp < 10 ? mp + 3 : mp - 9;
    if (month <= 2)
        ++year;

    crashWriteNumber (static_cast<uint64_t> (year), 4);
    crashWrite ("-");
    crashWriteNumber (month, 2);
    crashWrite ("-");
    crashWriteNumber (day, 2);
    crashWrite (" ");
    crashWriteNumber (static_cast<uint64_t> (remainder / 3600), 2);
    crashWrite (":");
    crashWriteNumber (static_cast<uint64_t> (remainder % 3600 / 60), 2);
    crashWrite (":");
    crashWriteNumber (static_cast<uint64_t> (remainder % 60), 2);
    crashWrite (" UTC");
}

#if ! GHOSTDAW_WINDOWS
const char* signalName (int signal)
{
    switch (signal)
    {
        case SIGSEGV: return "SIGSEGV (segmentation fault)";
        case SIGBUS: return "SIGBUS (bus error)";
        case SIGFPE: return "SIGFPE (arithmetic error)";
        case SIGILL: return "SIGILL (illegal instruction)";
        case SIGABRT: return "SIGABRT (abort)";
        default: return "signal";
    }
}

void onFatalSignal (int signal, siginfo_t* info, void*)
{
    crashWrite ("\n");
    crashWriteTimestamp();
    crashWrite (" CRASH ");
    crashWrite (signalName (signal));
    if (signal == SIGSEGV || signal == SIGBUS)
    {
        crashWrite (" at address 0x");
        auto address = reinterpret_cast<uint64_t> (info != nullptr ? info->si_addr : nullptr);
        char hex[17];
        for (int i = 15; i >= 0; --i)
        {
            hex[i] = "0123456789abcdef"[address & 0xF];
            address >>= 4;
        }
        hex[16] = 0;
        crashWrite (hex);
    }
    crashWrite ("\n");
   #if GHOSTDAW_LINUX || GHOSTDAW_MAC
    void* frames[64];
    auto count = backtrace (frames, 64);
    if (crashLog >= 0)
        backtrace_symbols_fd (frames, count, crashLog);
    backtrace_symbols_fd (frames, count, 2);
   #endif
    crashWrite ("\n");

    // The handler was installed with SA_RESETHAND: raising again runs the
    // default action, so the process dies (and dumps core where enabled)
    raise (signal);
}
#else
LONG WINAPI onUnhandledException (EXCEPTION_POINTERS* pointers)
{
    crashWrite ("\r\n");
    crashWriteTimestamp();
    crashWrite (" CRASH unhandled exception, code 0x");
    auto code = pointers != nullptr && pointers->ExceptionRecord != nullptr ? pointers->ExceptionRecord->ExceptionCode : 0u;
    char hex[9];
    for (int i = 7; i >= 0; --i)
    {
        hex[i] = "0123456789abcdef"[code & 0xF];
        code >>= 4;
    }
    hex[8] = 0;
    crashWrite (hex);
    crashWrite ("\r\n");
    return EXCEPTION_CONTINUE_SEARCH; // the process still dies
}

void onAbort (int)
{
    crashWrite ("\r\n");
    crashWriteTimestamp();
    crashWrite (" CRASH abort()\r\n");
}
#endif

std::function<void()> terminationHandler;
std::atomic<bool> terminationSeen { false };

#if GHOSTDAW_WINDOWS
BOOL WINAPI onConsoleEvent (DWORD)
{
    if (! terminationSeen.exchange (true) && terminationHandler)
        terminationHandler();
    return TRUE;
}
#else
void onTerminationSignal (int)
{
    if (! terminationSeen.exchange (true) && terminationHandler)
        terminationHandler();
}
#endif

} // namespace

void installCrashHandler (const fs::path& logFile)
{
   #if GHOSTDAW_WINDOWS
    crashLog = CreateFileW (logFile.c_str(), FILE_APPEND_DATA, FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr, OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
    SetUnhandledExceptionFilter (onUnhandledException);
    std::signal (SIGABRT, onAbort);
   #else
    crashLog = ::open (logFile.c_str(), O_WRONLY | O_APPEND | O_CREAT | O_CLOEXEC, 0600);

    // An alternate stack, so a stack overflow can still be reported
    static std::vector<char> alternateStack (64 * 1024);
    stack_t stack {};
    stack.ss_sp = alternateStack.data();
    stack.ss_size = alternateStack.size();
    stack.ss_flags = 0;
    sigaltstack (&stack, nullptr);

   #if GHOSTDAW_LINUX || GHOSTDAW_MAC
    // backtrace() loads libgcc the first time it runs, which allocates;
    // run it once here so the handler never does
    void* warmUp[4];
    backtrace (warmUp, 4);
   #endif

    struct sigaction action {};
    action.sa_sigaction = onFatalSignal;
    action.sa_flags = SA_SIGINFO | SA_RESETHAND | SA_NODEFER | SA_ONSTACK;
    sigemptyset (&action.sa_mask);
    for (auto signal : { SIGSEGV, SIGBUS, SIGFPE, SIGILL, SIGABRT })
        sigaction (signal, &action, nullptr);
   #endif
}

void onTerminationRequest (std::function<void()> handler)
{
    terminationHandler = std::move (handler);
   #if GHOSTDAW_WINDOWS
    SetConsoleCtrlHandler (onConsoleEvent, TRUE);
   #else
    struct sigaction action {};
    action.sa_handler = onTerminationSignal;
    sigemptyset (&action.sa_mask);
    sigaction (SIGINT, &action, nullptr);
    sigaction (SIGTERM, &action, nullptr);
   #endif
}

void ignoreSigpipe()
{
   #if ! GHOSTDAW_WINDOWS
    std::signal (SIGPIPE, SIG_IGN);
   #endif
}

} // namespace ghostdaw
