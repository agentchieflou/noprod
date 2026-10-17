// The new GhostDAW's tests (#134). Exits non-zero on failure.
//
//   ghostdaw_tests              runs everything
//   ghostdaw_tests --crash LOG  (used by the crash handler test) crashes

#include "Check.h"
#include "platform/Files.h"
#include "platform/Log.h"
#include "platform/Platform.h"
#include "platform/Process.h"

#if GHOSTDAW_WINDOWS
 #include <windows.h>
#endif

#include <string>

int checks = 0, failures = 0;

int main (int argc, char** argv)
{
    if (argc == 3 && std::string (argv[1]) == "--crash")
    {
       #if GHOSTDAW_WINDOWS
        SetErrorMode (SEM_NOGPFAULTERRORBOX | SEM_FAILCRITICALERRORS); // no dialog in CI
       #endif
        ghostdaw::installCrashHandler (ghostdaw::pathFromUtf8 (argv[2]));
        volatile int* nowhere = nullptr;
        *nowhere = 1; // the crash
        return 0;
    }

    ghostdaw::Log::setLevel (ghostdaw::Log::Level::error); // the tests provoke plenty of warnings on purpose

    platformTests (argv[0]);
    hostTests();
    pluginTests();

    std::cout << (failures == 0 ? "PASS" : "FAIL") << ": " << (checks - failures) << "/" << checks << " checks" << std::endl;
    return failures == 0 ? 0 : 1;
}
