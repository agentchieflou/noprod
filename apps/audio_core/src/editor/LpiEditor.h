#pragma once

#include <JuceHeader.h>
#include <atomic>
#include <cstring>
#include <functional>
#include <memory>
#include <vector>

#include "../LpiPlugin.h"
#include "EditorStream.h"

// An LPI plugin's editor (lpi.gui.offscreen.v1) streamed to the browser
// (#44 B6c).
//
// lpi.h requires every GUI call, and every parameter write, on one thread.
// In GhostDAW that is the message thread, where PluginHost runs. The editor
// stream renders on its own thread (EditorStream.h), so LpiEditorSource hands
// each frame and each mouse event over to the message thread and waits for
// the pixels.

// One open editor. Opened and closed on the message thread; stream threads
// only hold on to it and check isClosed().
class EditorSession
{
public:
    EditorSession (juce::String id, juce::String slot, LpiInsert& lpi, const lpi_gui_offscreen_info& info)
        : editorId (std::move (id)), slotId (std::move (slot)),
          width (static_cast<int> (info.physical_width)), height (static_cast<int> (info.physical_height)),
          scale (static_cast<float> (info.physical_width) / static_cast<float> (info.logical_width)),
          insert (&lpi)
    {
    }

    const juce::String editorId, slotId;
    const int width, height; // physical pixels: the size of every frame
    const float scale;       // physical / logical pixels

    bool isClosed() const { return closed.load(); }

    // ---------------------------------------------------- message thread only

    LpiInsert* getInsert() const { return insert; }

    // Closes the plugin's editor; streams then see isClosed()
    void close()
    {
        if (insert != nullptr)
        {
            insert->onEditorClosed = nullptr;
            insert->closeEditor();
        }
        markClosed();
    }

    // The plugin closed it already (LpiInsert::onEditorClosed)
    void markClosed()
    {
        insert = nullptr;
        closed.store (true);
    }

    bool render (std::vector<uint8_t>& rgba)
    {
        if (insert == nullptr)
            return false;

        rgba.resize (static_cast<size_t> (width) * static_cast<size_t> (height) * 4);
        auto ok = insert->renderEditor (rgba.data(), rgba.size());

        // Edits made in the editor go to the plugin directly: pass them on
        auto changed = insert->takeParameterChanges();
        if (! changed.empty() && onParametersChanged)
            onParametersChanged (changed);

        return ok;
    }

    // Coordinates in frame (physical) pixels
    void mouse (int type, float x, float y)
    {
        if (insert != nullptr)
            insert->editorMouse (type, x / scale, y / scale);
    }

    // Parameters the editor changed (their indices), found after a render
    std::function<void (const std::vector<int>&)> onParametersChanged;

private:
    LpiInsert* insert; // null once closed
    std::atomic<bool> closed { false };
};

// The stream's view of an open editor (one per stream connection)
class LpiEditorSource : public FrameSource
{
public:
    explicit LpiEditorSource (std::shared_ptr<EditorSession> s, int frameTimeoutMs = 500)
        : session (std::move (s)), timeoutMs (frameTimeoutMs)
    {
    }

    ~LpiEditorSource() override
    {
        // A drag cut short by the stream closing mustn't leave the button down
        if (leftDown)
            post (LPI_MOUSE_UP, lastX, lastY);
    }

    int getWidth() const override { return session->width; }
    int getHeight() const override { return session->height; }
    bool isClosed() const override { return session->isClosed(); }

    // Render thread: the message thread renders, this one waits for the pixels
    bool render (uint8_t* rgba) override
    {
        if (session->isClosed())
            return false;

        // One frame in flight: if the last one timed out (the message thread
        // is busy, say scanning plugins) and is still queued, skip this one
        // rather than queue more behind it
        if (job == nullptr)
            job = std::make_shared<Job>();
        else if (job.use_count() > 1)
            return false;
        job->done.reset(); // a timed-out frame may have signalled since

        auto posted = juce::MessageManager::callAsync ([j = job, s = session]
        {
            j->ok = s->render (j->pixels);
            j->done.signal();
        });

        auto bytes = static_cast<size_t> (session->width) * static_cast<size_t> (session->height) * 4;
        if (! posted || ! job->done.wait (timeoutMs) || ! job->ok || job->pixels.size() < bytes)
            return false;

        std::memcpy (rgba, job->pixels.data(), bytes);
        return true;
    }

    // Connection thread. LPI v1 only knows the left button.
    void mouse (const juce::String& kind, float x, float y, int buttons) override
    {
        lastX = x;
        lastY = y;

        if (kind == "down")
        {
            if ((buttons & 1) == 0 || leftDown)
                return;
            leftDown = true;
            post (LPI_MOUSE_DOWN, x, y);
        }
        else if (kind == "up")
        {
            if (! leftDown)
                return;
            leftDown = false;
            post (LPI_MOUSE_UP, x, y);
        }
        else if (kind == "move")
        {
            post (LPI_MOUSE_MOVE, x, y);
        }
    }

private:
    struct Job
    {
        juce::WaitableEvent done;
        std::vector<uint8_t> pixels;
        bool ok = false;
    };

    // Mouse events keep their order: the message queue is FIFO, and a
    // frame asked for after an event is rendered after it
    void post (int type, float x, float y)
    {
        juce::MessageManager::callAsync ([s = session, type, x, y] { s->mouse (type, x, y); });
    }

    std::shared_ptr<EditorSession> session;
    int timeoutMs;
    std::shared_ptr<Job> job;
    bool leftDown = false;
    float lastX = 0.0f, lastY = 0.0f;
};
