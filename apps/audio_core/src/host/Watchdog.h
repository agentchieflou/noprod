#pragma once

#include "../platform/Platform.h"

#include <atomic>
#include <functional>
#include <string>
#include <thread>

namespace ghostdaw
{

// Notices when the audio callback or the control thread stops making
// progress, and says so instead of letting the host freeze in silence.
//
// The audio thread marks the start and end of every callback; the control
// thread beats every few hundred milliseconds from a timer. A thread of
// its own checks both, and reports (once per stall, and once more when it
// ends) through `onReport`, which runs on the watchdog's thread and must
// not block. A stuck plugin can't be unstuck from outside, but every other
// client keeps getting answered, and the log says which insert it was.
class Watchdog
{
public:
    struct Report
    {
        std::string what;      // "audio", "control"
        bool stalled = false;  // true when it began, false when it recovered
        double seconds = 0.0;  // how long so far (or in total)
        int bus = -2, slot = -1; // where the audio callback was (see Mixer)
    };

    Watchdog (std::function<void (const Report&)> onReport, double audioStallSeconds = 2.0, double controlStallSeconds = 5.0)
        : report (std::move (onReport)), audioLimit (audioStallSeconds), controlLimit (controlStallSeconds)
    {
        controlBeat.store (monotonicMs());
        thread = std::thread ([this] { run(); });
    }

    ~Watchdog()
    {
        stopping.store (true);
        if (thread.joinable())
            thread.join();
    }

    // Audio thread
    void callbackBegan() noexcept
    {
        callbackStart.store (monotonicMs(), std::memory_order_relaxed);
        inCallback.store (true, std::memory_order_release);
    }

    void callbackEnded() noexcept
    {
        inCallback.store (false, std::memory_order_release);
    }

    // Where the callback is, so a stall can be named (set by the audio
    // thread, through the mixer and chain, before each insert)
    std::function<int()> getBus;
    std::function<int()> getSlot;

    // Control thread, from a timer
    void beat() noexcept { controlBeat.store (monotonicMs(), std::memory_order_relaxed); }

    bool isAudioStalled() const { return audioStalled.load(); }
    bool isControlStalled() const { return controlStalled.load(); }

private:
    std::function<void (const Report&)> report;
    double audioLimit, controlLimit;
    std::thread thread;
    std::atomic<bool> stopping { false };
    std::atomic<bool> inCallback { false };
    std::atomic<double> callbackStart { 0.0 };
    std::atomic<double> controlBeat { 0.0 };
    std::atomic<bool> audioStalled { false }, controlStalled { false };

    void run()
    {
        while (! stopping.load())
        {
            sleepMs (100);
            auto now = monotonicMs();

            auto audioSeconds = inCallback.load (std::memory_order_acquire) ? (now - callbackStart.load()) / 1000.0 : 0.0;
            if (! audioStalled.load() && audioSeconds > audioLimit)
            {
                audioStalled.store (true);
                Report r { "audio", true, audioSeconds, getBus ? getBus() : -2, getSlot ? getSlot() : -1 };
                report (r);
            }
            else if (audioStalled.load() && audioSeconds <= audioLimit)
            {
                audioStalled.store (false);
                report (Report { "audio", false, 0.0, -2, -1 });
            }

            auto controlSeconds = (now - controlBeat.load()) / 1000.0;
            if (! controlStalled.load() && controlSeconds > controlLimit)
            {
                controlStalled.store (true);
                report (Report { "control", true, controlSeconds, -2, -1 });
            }
            else if (controlStalled.load() && controlSeconds <= controlLimit)
            {
                controlStalled.store (false);
                report (Report { "control", false, 0.0, -2, -1 });
            }
        }
    }
};

} // namespace ghostdaw
