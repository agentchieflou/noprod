#pragma once

#include <JuceHeader.h>
#include <atomic>
#include <chrono>
#include <cstring>
#include <memory>
#include <vector>

#include "../HapWebSocketServer.h"

// Plugin editor streaming (#44 B6): a plugin's editor is rendered off-screen
// in the Audio Core, and its pixels are streamed to the browser over a
// WebSocket; mouse input comes back the same way. Built first as the B6a
// latency spike (tools/EditorStreamSpike.cpp drives it with a synthetic
// editor); B6c plugs a real editor in through FrameSource.
//
// Per connection, a dedicated (non-realtime) thread renders a frame at a
// fixed ambient rate, and immediately when input arrives, then encodes it
// (RGBA, raw or zlib-deflated) and sends one binary message:
//   uint32 magic 'NPF1', frameId, width, height, format (0 raw, 1 deflate), reserved
//   float64 sendWallMs     wall-clock ms when sent (same machine as the browser)
//   float64 renderMs, encodeMs
//   float64 inputClientMs  the browser's timestamp of the input this frame
//                          answers, or 0 for an ambient frame
//   (padding to 64 bytes), then the pixels.
// Text messages from the browser: START { fps?, compression?: 'none'|'deflate', level?, acks?, window?, editorId? },
// INPUT { kind: 'down'|'move'|'up', x, y, buttons, t }, ACK { frameId }, STOP.
// To the browser: CLOSED once the editor is gone (or START named none), after
// which no more frames come.
//
// Backpressure: with `acks`, the browser acknowledges each frame once it has
// decoded it, and no new frame is rendered while `window` frames are still
// unacknowledged. Input received meanwhile is answered by the frame rendered
// right after the next acknowledgement, so frames never queue behind a slow
// decoder or link; a window of 2 lets the next frame encode while the
// browser decodes the last one.

// What gets streamed: a plugin editor (LpiEditor.h), or the spike's synthetic one
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
    virtual void mouse (const juce::String& kind, float x, float y, int buttons) = 0;
    // Any thread: the editor has gone away for good
    virtual bool isClosed() const { return false; }
};

// For sources drawn with JUCE: ARGB (premultiplied, BGRA in memory) -> RGBA
inline void imageToRgba (const juce::Image& image, uint8_t* out)
{
    juce::Image::BitmapData pixels (image, juce::Image::BitmapData::readOnly);
    for (int y = 0; y < image.getHeight(); ++y)
    {
        auto* row = pixels.getLinePointer (y);
        for (int x = 0; x < image.getWidth(); ++x, row += pixels.pixelStride, out += 4)
        {
            auto a = row[3];
            if (a == 255 || a == 0)
            {
                out[0] = row[2]; out[1] = row[1]; out[2] = row[0];
            }
            else
            {
                out[0] = static_cast<uint8_t> (row[2] * 255 / a);
                out[1] = static_cast<uint8_t> (row[1] * 255 / a);
                out[2] = static_cast<uint8_t> (row[0] * 255 / a);
            }
            out[3] = a;
        }
    }
}

class EditorStreamer : private juce::Thread
{
public:
    static constexpr size_t headerBytes = 64;

    enum class Compression { none = 0, deflate = 1 };

    struct Settings
    {
        double fps = 20.0;
        Compression compression = Compression::deflate;
        int level = 1;      // zlib level: 1 is fastest
        bool acks = false;  // the browser acknowledges frames (backpressure)
        int window = 2;     // frames that may be unacknowledged at once
    };

    EditorStreamer (HapWebSocketServer::ConnectionPtr connectionToSendTo, std::unique_ptr<FrameSource> frameSource, Settings streamSettings)
        : juce::Thread ("EditorStreamer"), connection (std::move (connectionToSendTo)), source (std::move (frameSource)), settings (streamSettings)
    {
        startThread();
    }

    ~EditorStreamer() override
    {
        stopThread (2000);
    }

    // Connection thread: pass the input on and render right away
    void handleInput (const juce::var& message)
    {
        source->mouse (message["kind"].toString(), static_cast<float> (message["x"]), static_cast<float> (message["y"]),
                       static_cast<int> (message["buttons"]));
        pendingInputTime.store (static_cast<double> (message["t"]));
        notify();
    }

    // Connection thread: the browser has this frame on screen
    void acknowledge (int64_t acknowledgedFrame)
    {
        auto previous = lastAcknowledged.load();
        while (acknowledgedFrame > previous && ! lastAcknowledged.compare_exchange_weak (previous, acknowledgedFrame)) {}
        notify();
    }

    static double wallClockMs()
    {
        using namespace std::chrono;
        return static_cast<double> (duration_cast<microseconds> (system_clock::now().time_since_epoch()).count()) / 1000.0;
    }

private:
    void run() override
    {
        auto interval = 1000.0 / juce::jlimit (1.0, 120.0, settings.fps);
        auto nextAmbient = juce::Time::getMillisecondCounterHiRes();

        while (! threadShouldExit())
        {
            if (source->isClosed())
            {
                if (! closedSent)
                    connection->sendText (R"({"type":"CLOSED"})");
                closedSent = true;
                wait (200);
                continue;
            }

            auto now = juce::Time::getMillisecondCounterHiRes();
            auto inputPending = pendingInputTime.load() != 0.0;
            auto due = now >= nextAmbient;

            // Nothing to draw yet: sleep until the next ambient frame (input
            // and acknowledgements wake it early, then it re-checks)
            if (! inputPending && ! due)
            {
                wait (static_cast<int> (std::ceil (nextAmbient - now)));
                continue;
            }

            // Hold the next frame until the browser has shown the last one
            // (a lost acknowledgement only stalls for a second)
            if (settings.acks && static_cast<int64_t> (frameId) - 1 - lastAcknowledged.load() >= settings.window
                && now - lastSendTime < 1000.0)
            {
                wait (50);
                continue;
            }

            renderAndSend();
            // Ambient frames keep a fixed cadence; frames answering input don't move it
            if (due)
                nextAmbient = juce::jmax (nextAmbient + interval, juce::Time::getMillisecondCounterHiRes());
        }
    }

    void renderAndSend()
    {
        auto inputTime = pendingInputTime.exchange (0.0);

        auto width = source->getWidth(), height = source->getHeight();
        rgba.resize (static_cast<size_t> (width * height * 4));
        auto t0 = juce::Time::getMillisecondCounterHiRes();
        if (! source->render (rgba.data()))
            return;
        auto t1 = juce::Time::getMillisecondCounterHiRes();

        message.resize (headerBytes);
        if (settings.compression == Compression::deflate)
        {
            juce::MemoryOutputStream compressed (rgba.size() / 4 + 1024);
            {
                juce::GZIPCompressorOutputStream zlib (compressed, settings.level); // zlib format: the browser's DecompressionStream('deflate')
                zlib.write (rgba.data(), rgba.size());
            }
            message.insert (message.end(), static_cast<const uint8_t*> (compressed.getData()),
                            static_cast<const uint8_t*> (compressed.getData()) + compressed.getDataSize());
        }
        else
        {
            message.insert (message.end(), rgba.begin(), rgba.end());
        }
        auto t2 = juce::Time::getMillisecondCounterHiRes();

        uint32_t ints[6] { 0x3146504eu /* "NPF1" */, frameId++, static_cast<uint32_t> (width), static_cast<uint32_t> (height),
                           static_cast<uint32_t> (settings.compression), 0 };
        double doubles[4] { wallClockMs(), t1 - t0, t2 - t1, inputTime };
        std::memset (message.data(), 0, headerBytes);
        std::memcpy (message.data(), ints, sizeof (ints));
        std::memcpy (message.data() + sizeof (ints), doubles, sizeof (doubles));

        connection->sendBinary (message.data(), message.size());
        lastSendTime = juce::Time::getMillisecondCounterHiRes();
    }

    HapWebSocketServer::ConnectionPtr connection;
    std::unique_ptr<FrameSource> source;
    Settings settings;
    std::vector<uint8_t> rgba, message;
    uint32_t frameId = 0;
    double lastSendTime = 0.0;
    bool closedSent = false;
    std::atomic<double> pendingInputTime { 0.0 };
    std::atomic<int64_t> lastAcknowledged { -1 };
};

// Server handlers: START creates the connection's streamer around a fresh
// FrameSource from `makeSource` (given the START message; nullptr: there is
// no such editor), INPUT goes to it, STOP or closing ends it.
inline HapWebSocketServer::Handlers makeEditorStreamHandlers (std::function<std::unique_ptr<FrameSource> (const juce::var& start)> makeSource)
{
    using ConnectionPtr = HapWebSocketServer::ConnectionPtr;
    HapWebSocketServer::Handlers handlers;

    handlers.onText = [makeSource] (const ConnectionPtr& connection, const juce::var& message)
    {
        auto type = message["type"].toString();
        if (type == "START")
        {
            EditorStreamer::Settings settings;
            settings.fps = static_cast<double> (message.getProperty ("fps", 20.0));
            settings.compression = message["compression"].toString() == "none" ? EditorStreamer::Compression::none
                                                                                : EditorStreamer::Compression::deflate;
            settings.level = juce::jlimit (1, 9, static_cast<int> (message.getProperty ("level", 1)));
            settings.acks = static_cast<bool> (message.getProperty ("acks", false));
            // Measured best (docs/editor-streaming-latency.md): 2 frames ahead
            // for deflated frames, 1 for raw ones, which otherwise queue in the socket
            auto defaultWindow = settings.compression == EditorStreamer::Compression::none ? 1 : 2;
            settings.window = juce::jlimit (1, 8, static_cast<int> (message.getProperty ("window", defaultWindow)));
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
        else if (type == "ACK")
        {
            if (auto streamer = std::static_pointer_cast<EditorStreamer> (connection->context))
                streamer->acknowledge (static_cast<int64_t> (static_cast<double> (message["frameId"])));
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
