#pragma once

#include "../../platform/Deflate.h"
#include "../../platform/Json.h"
#include "../../platform/Platform.h"
#include "../../platform/WebSocketServer.h"

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cmath>
#include <condition_variable>
#include <cstring>
#include <memory>
#include <mutex>
#include <thread>
#include <vector>

namespace ghostdaw
{

// Plugin editor streaming: a plugin's editor is rendered off-screen in
// GhostDAW, and its pixels are streamed to the browser over a WebSocket;
// mouse and keyboard input come back the same way.
//
// Per connection, a dedicated (non-realtime) thread renders a frame at a
// fixed ambient rate, and immediately when input arrives. A frame identical
// to the last one sent is dropped there, so an editor nobody is touching
// costs nothing to encode, send or decode. Any other frame is encoded (RGBA,
// raw or zlib-deflated) and sent as one binary message:
//   uint32 magic 'NPF1', frameId, width, height, format (0 raw, 1 deflate), reserved
//   float64 sendWallMs     wall-clock ms when sent (same machine as the browser)
//   float64 renderMs, encodeMs
//   float64 inputClientMs  the browser's timestamp of the input this frame
//                          answers, or 0 for an ambient frame
//   (padding to 64 bytes), then the pixels.
// Text messages from the browser: START { fps?, compression?: 'none'|'deflate', level?, acks?, window?, editorId? },
// INPUT { kind: 'down'|'move'|'up', x, y, buttons, t },
// KEY { kind: 'down'|'up'|'char', key, modifiers, t }, FOCUS { focused },
// ACK { frameId }, STOP.
// To the browser: CLOSED once the editor is gone (or START named none), after
// which no more frames come.
//
// Backpressure: with `acks`, the browser acknowledges each frame once it has
// decoded it, and no new frame is rendered while `window` frames are still
// unacknowledged. Input received meanwhile is answered by the frame rendered
// right after the next acknowledgement, so frames never queue behind a slow
// decoder or link; a window of 2 lets the next frame encode while the
// browser decodes the last one.

// What gets streamed: a plugin editor (LpiEditor.h)
class FrameSource
{
public:
    virtual ~FrameSource() = default;
    // Frame size in pixels
    virtual int getWidth() const = 0;
    virtual int getHeight() const = 0;
    // Render thread: draw the current frame as tightly packed RGBA
    // (getWidth() * getHeight() * 4 bytes, top-left origin). False: no frame.
    virtual bool render (uint8_t* rgba) = 0;
    // Connection thread: input in frame pixels. Must be safe against render().
    virtual void mouse (const std::string& kind, float x, float y, int buttons) = 0;
    // Connection thread: a key ('down' | 'up' | 'char'; key and modifiers as
    // lpi.gui.keyboard.v1), and keyboard focus. Sources without keys ignore them.
    virtual void key (const std::string& /*kind*/, uint32_t /*key*/, uint32_t /*modifiers*/) {}
    virtual void focus (bool /*focused*/) {}
    // Any thread: the editor has gone away for good
    virtual bool isClosed() const { return false; }
};

class EditorStreamer
{
public:
    static constexpr size_t headerBytes = 64;

    enum class Compression { none = 0, deflate = 1 };

    struct Settings
    {
        double fps = 20.0;
        Compression compression = Compression::deflate;
        int level = 1;      // deflate effort: 1 is fastest
        bool acks = false;  // the browser acknowledges frames (backpressure)
        int window = 2;     // frames that may be unacknowledged at once
    };

    EditorStreamer (WebSocketServer::ConnectionPtr connectionToSendTo, std::unique_ptr<FrameSource> frameSource, Settings streamSettings)
        : connection (std::move (connectionToSendTo)), source (std::move (frameSource)), settings (streamSettings)
    {
        thread = std::thread ([this] { run(); });
    }

    ~EditorStreamer()
    {
        stopping.store (true);
        notify();
        if (thread.joinable())
            thread.join();
    }

    // Connection thread: pass the input on and render right away
    void handleInput (const Json& input)
    {
        source->mouse (input["kind"].toString(), static_cast<float> (input["x"].toDouble()), static_cast<float> (input["y"].toDouble()),
                       input["buttons"].toInt());
        pendingInputTime.store (input["t"].toDouble());
        notify();
    }

    // Connection thread: keys and focus, answered by a frame right away
    void handleKey (const Json& input)
    {
        source->key (input["kind"].toString(), static_cast<uint32_t> (input["key"].toInt64()), static_cast<uint32_t> (input["modifiers"].toInt64()));
        pendingInputTime.store (input["t"].toDouble());
        notify();
    }

    void handleFocus (bool focused)
    {
        source->focus (focused);
        pendingInputTime.store (wallClockMs());
        notify();
    }

    // Connection thread: the browser has this frame on screen
    void acknowledge (int64_t acknowledgedFrame)
    {
        auto previous = lastAcknowledged.load();
        while (acknowledgedFrame > previous && ! lastAcknowledged.compare_exchange_weak (previous, acknowledgedFrame)) {}
        notify();
    }

private:
    void notify()
    {
        {
            const std::lock_guard<std::mutex> guard (wakeLock);
            wakeFlag = true;
        }
        wake.notify_all();
    }

    // Sleeps up to `ms`, or until notify()
    void waitFor (int ms)
    {
        std::unique_lock<std::mutex> guard (wakeLock);
        wake.wait_for (guard, std::chrono::milliseconds (std::max (0, ms)), [this] { return wakeFlag || stopping.load(); });
        wakeFlag = false;
    }

    void run()
    {
        auto interval = 1000.0 / std::clamp (settings.fps, 1.0, 120.0);
        auto nextAmbient = monotonicMs();

        while (! stopping.load())
        {
            if (source->isClosed())
            {
                if (! closedSent)
                    connection->sendText (R"({"type":"CLOSED"})");
                closedSent = true;
                waitFor (200);
                continue;
            }

            auto now = monotonicMs();
            auto inputPending = pendingInputTime.load() != 0.0;
            auto due = now >= nextAmbient;

            // Nothing to draw yet: sleep until the next ambient frame (input
            // and acknowledgements wake it early, then it re-checks)
            if (! inputPending && ! due)
            {
                waitFor (static_cast<int> (std::ceil (nextAmbient - now)));
                continue;
            }

            // Hold the next frame until the browser has shown the last one
            // (a lost acknowledgement only stalls for a second)
            if (settings.acks && static_cast<int64_t> (frameId) - 1 - lastAcknowledged.load() >= settings.window
                && now - lastSendTime < 1000.0)
            {
                waitFor (50);
                continue;
            }

            renderAndSend();
            // Ambient frames keep a fixed cadence; frames answering input don't move it
            if (due)
                nextAmbient = std::max (nextAmbient + interval, monotonicMs());
        }
    }

    void renderAndSend()
    {
        auto inputTime = pendingInputTime.exchange (0.0);

        auto width = source->getWidth(), height = source->getHeight();
        rgba.resize (static_cast<size_t> (width) * static_cast<size_t> (height) * 4);
        auto t0 = monotonicMs();
        if (! source->render (rgba.data()))
            return;
        auto t1 = monotonicMs();

        if (rgba == lastSent)
            return;

        message.resize (headerBytes);
        if (settings.compression == Compression::deflate)
        {
            auto compressed = zlibCompress (rgba.data(), rgba.size(), settings.level); // zlib format: the browser's DecompressionStream('deflate')
            message.insert (message.end(), compressed.begin(), compressed.end());
        }
        else
        {
            message.insert (message.end(), rgba.begin(), rgba.end());
        }
        auto t2 = monotonicMs();

        uint32_t ints[6] { 0x3146504eu /* "NPF1" */, frameId++, static_cast<uint32_t> (width), static_cast<uint32_t> (height),
                           static_cast<uint32_t> (settings.compression), 0 };
        double doubles[4] { wallClockMs(), t1 - t0, t2 - t1, inputTime };
        std::memset (message.data(), 0, headerBytes);
        std::memcpy (message.data(), ints, sizeof (ints));
        std::memcpy (message.data() + sizeof (ints), doubles, sizeof (doubles));

        connection->sendBinary (message.data(), message.size());
        lastSendTime = monotonicMs();
        std::swap (rgba, lastSent); // the next render overwrites all of rgba
    }

    WebSocketServer::ConnectionPtr connection;
    std::unique_ptr<FrameSource> source;
    Settings settings;
    std::vector<uint8_t> rgba, lastSent, message;
    uint32_t frameId = 0;
    double lastSendTime = 0.0;
    bool closedSent = false;
    std::atomic<double> pendingInputTime { 0.0 };
    std::atomic<int64_t> lastAcknowledged { -1 };
    std::atomic<bool> stopping { false };
    std::mutex wakeLock;
    std::condition_variable wake;
    bool wakeFlag = false;
    std::thread thread;
};

// Server handlers: START creates the connection's streamer around a fresh
// FrameSource from `makeSource` (given the START message; nullptr: there is
// no such editor), INPUT goes to it, STOP or closing ends it.
inline WebSocketServer::Handlers makeEditorStreamHandlers (std::function<std::unique_ptr<FrameSource> (const Json& start)> makeSource)
{
    using ConnectionPtr = WebSocketServer::ConnectionPtr;
    WebSocketServer::Handlers handlers;

    handlers.onText = [makeSource] (const ConnectionPtr& connection, const std::string& text)
    {
        auto parsed = Json::parse (text);
        if (! parsed || ! parsed->isObject())
            return;
        auto& message = *parsed;
        auto type = message["type"].toString();
        if (type == "START")
        {
            EditorStreamer::Settings settings;
            settings.fps = message.get ("fps", 20.0).toDouble();
            settings.compression = message["compression"].toString() == "none" ? EditorStreamer::Compression::none
                                                                                : EditorStreamer::Compression::deflate;
            settings.level = std::clamp (message.get ("level", 1).toInt(), 1, 9);
            settings.acks = message.get ("acks", false).toBool();
            // Measured best (docs/editor-streaming-latency.md): 2 frames ahead
            // for deflated frames, 1 for raw ones, which otherwise queue in the socket
            auto defaultWindow = settings.compression == EditorStreamer::Compression::none ? 1 : 2;
            settings.window = std::clamp (message.get ("window", defaultWindow).toInt(), 1, 8);
            connection->context.reset(); // stop any previous streamer first
            auto source = makeSource (message);
            if (source == nullptr)
            {
                connection->sendText (R"({"type":"CLOSED"})");
                return;
            }
            connection->context = std::make_shared<EditorStreamer> (connection, std::move (source), settings);
        }
        else if (type == "INPUT")
        {
            if (auto streamer = std::static_pointer_cast<EditorStreamer> (connection->context))
                streamer->handleInput (message);
        }
        else if (type == "KEY" || type == "FOCUS")
        {
            if (auto streamer = std::static_pointer_cast<EditorStreamer> (connection->context))
            {
                if (type == "KEY")
                    streamer->handleKey (message);
                else
                    streamer->handleFocus (message["focused"].toBool());
            }
        }
        else if (type == "ACK")
        {
            if (auto streamer = std::static_pointer_cast<EditorStreamer> (connection->context))
                streamer->acknowledge (message["frameId"].toInt64());
        }
        else if (type == "STOP")
        {
            connection->context.reset();
        }
    };

    handlers.onClose = [] (const ConnectionPtr& connection)
    {
        connection->context.reset(); // joins the render thread
    };

    return handlers;
}

} // namespace ghostdaw
