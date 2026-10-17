// Binaries the plugin scanner must survive: with LPI_TEST_CRASH the
// factory export dereferences null; with LPI_TEST_HANG it never returns.
// Loading either in-process would take the host down, which is why scans
// run in a child process.

#include <lpi/lpi.h>

#include <chrono>
#include <thread>

extern "C"
#if defined(_WIN32)
__declspec (dllexport)
#else
__attribute__ ((visibility ("default")))
#endif
const lpi_plugin_factory* lpi_get_factory()
{
   #if defined(LPI_TEST_CRASH)
    volatile int* nowhere = nullptr;
    *nowhere = 1;
    return nullptr;
   #else
    for (;;)
        std::this_thread::sleep_for (std::chrono::seconds (1));
   #endif
}
