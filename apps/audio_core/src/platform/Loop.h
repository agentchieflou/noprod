#pragma once

#include <atomic>
#include <condition_variable>
#include <cstdint>
#include <deque>
#include <functional>
#include <mutex>
#include <thread>
#include <vector>

namespace ghostdaw
{

// The message loop: one thread that runs posted functions in order, plus
// repeating timers. GhostDAW runs its control thread on one (every plugin
// call but process(), as lpi.h requires one control thread), and the
// servers' threads post to it.
//
// Nothing is run until a thread calls run() (or runFor() in tests); that
// thread is then the loop thread.
class MessageLoop
{
public:
    using Task = std::function<void()>;
    using TimerId = uint64_t;

    MessageLoop() = default;
    ~MessageLoop();
    MessageLoop (const MessageLoop&) = delete;
    MessageLoop& operator= (const MessageLoop&) = delete;

    // Any thread: queues `task` for the loop thread. After stop(), tasks
    // are dropped (returns false).
    bool post (Task task);

    // Any thread: runs `task` on the loop thread and waits for it, up to
    // `timeoutMs` (0: forever). On the loop thread itself it runs inline.
    // False if the wait timed out (the task may still run later) or the
    // loop stopped before starting it (then it never runs).
    bool callSync (Task task, int timeoutMs = 0);

    // Any thread: runs `task` every `intervalMs` on the loop thread, from
    // now, until removed
    TimerId addTimer (int intervalMs, Task task);
    void removeTimer (TimerId id);

    // The loop thread: runs until stop()
    void run();

    // Runs what is due for about `ms` milliseconds, then returns (tests,
    // and the old host's runDispatchLoopUntil)
    void runFor (int ms);

    // Runs until `done()` is true or `timeoutMs` passed. True if it was.
    bool runUntil (const std::function<bool()>& done, int timeoutMs);

    // Any thread: makes run() return once the current task finishes. Tasks
    // queued after this are dropped.
    void stop();
    bool isStopped() const { return stopped.load(); }

    // True on the thread that is running the loop
    bool onLoopThread() const;

    size_t pendingTasks();

private:
    struct Timer
    {
        TimerId id;
        int intervalMs;
        double nextDueMs;
        Task task;
    };

    std::mutex lock;
    std::condition_variable wake;
    std::deque<Task> tasks;
    std::vector<Timer> timers;
    TimerId nextTimerId = 1;
    std::atomic<bool> stopped { false };
    std::atomic<bool> running { false };
    std::atomic<std::thread::id> loopThread {};

    // Runs one task or one due timer; waits up to `maxWaitMs` for either.
    // Returns false when there was nothing to do within the wait.
    bool runOne (int maxWaitMs);
};

} // namespace ghostdaw
