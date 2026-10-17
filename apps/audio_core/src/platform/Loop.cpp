#include "Loop.h"

#include "Platform.h"

#include <algorithm>
#include <chrono>
#include <memory>

namespace ghostdaw
{

MessageLoop::~MessageLoop()
{
    stop();
}

bool MessageLoop::post (Task task)
{
    {
        const std::lock_guard<std::mutex> guard (lock);
        if (stopped.load())
            return false;
        tasks.push_back (std::move (task));
    }
    wake.notify_all();
    return true;
}

bool MessageLoop::callSync (Task task, int timeoutMs)
{
    if (onLoopThread())
    {
        task();
        return true;
    }

    struct Shared
    {
        std::mutex lock;
        std::condition_variable done;
        std::atomic<bool> started { false };
        bool finished = false;
    };
    auto shared = std::make_shared<Shared>();

    auto posted = post ([shared, task = std::move (task)]
    {
        shared->started.store (true);
        task();
        {
            const std::lock_guard<std::mutex> guard (shared->lock);
            shared->finished = true;
        }
        shared->done.notify_all();
    });
    if (! posted)
        return false;

    // A stopped loop drops the tasks it hadn't started, so a wait with no
    // timeout re-checks for that now and then (stop() can't reach this
    // condition variable); a task already running still finishes
    std::unique_lock<std::mutex> guard (shared->lock);
    auto deadline = std::chrono::steady_clock::now() + std::chrono::milliseconds (timeoutMs > 0 ? timeoutMs : 0);
    while (! shared->finished)
    {
        if (stopped.load() && ! shared->started.load())
            return false;
        if (timeoutMs > 0)
        {
            if (shared->done.wait_until (guard, deadline, [&] { return shared->finished; }))
                break;
            if (std::chrono::steady_clock::now() >= deadline)
                return shared->finished;
        }
        else
        {
            shared->done.wait_for (guard, std::chrono::milliseconds (100), [&] { return shared->finished; });
        }
    }
    return shared->finished;
}

MessageLoop::TimerId MessageLoop::addTimer (int intervalMs, Task task)
{
    TimerId id;
    {
        const std::lock_guard<std::mutex> guard (lock);
        id = nextTimerId++;
        timers.push_back ({ id, std::max (1, intervalMs), monotonicMs() + std::max (1, intervalMs), std::move (task) });
    }
    wake.notify_all();
    return id;
}

void MessageLoop::removeTimer (TimerId id)
{
    const std::lock_guard<std::mutex> guard (lock);
    timers.erase (std::remove_if (timers.begin(), timers.end(), [id] (const Timer& t) { return t.id == id; }), timers.end());
}

bool MessageLoop::onLoopThread() const
{
    return running.load() && loopThread.load() == std::this_thread::get_id();
}

size_t MessageLoop::pendingTasks()
{
    const std::lock_guard<std::mutex> guard (lock);
    return tasks.size();
}

bool MessageLoop::runOne (int maxWaitMs)
{
    Task task;
    {
        std::unique_lock<std::mutex> guard (lock);
        auto deadline = std::chrono::steady_clock::now() + std::chrono::milliseconds (std::max (0, maxWaitMs));

        for (;;)
        {
            if (! tasks.empty())
            {
                task = std::move (tasks.front());
                tasks.pop_front();
                break;
            }

            // The earliest timer
            Timer* due = nullptr;
            for (auto& t : timers)
                if (due == nullptr || t.nextDueMs < due->nextDueMs)
                    due = &t;

            auto now = monotonicMs();
            if (due != nullptr && due->nextDueMs <= now)
            {
                due->nextDueMs = now + due->intervalMs;
                task = due->task; // a copy: the timer may remove itself while running
                break;
            }

            if (stopped.load())
                return false;

            auto waitUntil = deadline;
            if (due != nullptr)
            {
                auto timerAt = std::chrono::steady_clock::now() + std::chrono::milliseconds (static_cast<int64_t> (due->nextDueMs - now) + 1);
                waitUntil = std::min (waitUntil, timerAt);
            }
            if (wake.wait_until (guard, waitUntil) == std::cv_status::timeout && std::chrono::steady_clock::now() >= deadline)
            {
                if (tasks.empty() && (due == nullptr || due->nextDueMs > monotonicMs()))
                    return false;
            }
        }
    }

    if (task)
        task();
    return true;
}

void MessageLoop::run()
{
    loopThread.store (std::this_thread::get_id());
    running.store (true);
    while (! stopped.load())
        runOne (1000);
    running.store (false);
}

void MessageLoop::runFor (int ms)
{
    auto previousThread = loopThread.load();
    auto wasRunning = running.load();
    loopThread.store (std::this_thread::get_id());
    running.store (true);

    auto end = monotonicMs() + ms;
    do
    {
        auto remaining = static_cast<int> (end - monotonicMs());
        if (remaining < 0)
            break;
        runOne (remaining);
    }
    while (monotonicMs() < end);

    running.store (wasRunning);
    loopThread.store (previousThread);
}

bool MessageLoop::runUntil (const std::function<bool()>& done, int timeoutMs)
{
    auto end = monotonicMs() + timeoutMs;
    while (! done())
    {
        if (monotonicMs() >= end)
            return false;
        runFor (5);
    }
    return true;
}

void MessageLoop::stop()
{
    {
        const std::lock_guard<std::mutex> guard (lock);
        stopped.store (true);
        tasks.clear();
    }
    wake.notify_all();
}

} // namespace ghostdaw
