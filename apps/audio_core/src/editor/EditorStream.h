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
// Text messages from the browser: START { fps?, compression?: 'none'|'deflate', level? },
// INPUT { kind: 'down'|'move'|'up', x, y, buttons, t }, STOP.

// What gets streamed: a plugin editor (or, for the spike, a synthetic one)
class FrameSource
{
public:
    virtual ~FrameSource() = default;
    virtual int getWidth() const = 0;
    virtual int getHeight() const = 0;
    // Render thread: draw the current frame into an ARGB image of getWidth() x getHeight()
    virtual void render (juce::Image& target) = 0;
    // Connection thread: input in editor pixels. Must be safe against render().
    virtual void mouse (const juce::String& kind, float x, float y, int buttons) = 0;
};

class EditorStreamer : private juce::Thread
{
public:
    static constexpr size_t headerBytes = 64;

    enum class Compression { none = 0, deflate = 1 };

    struct Settings
    {
        double fps = 20.0;
        Compression compression = Compression::deflate;
        int level = 1; // zlib level: 1 is fastest
    };

    EditorStreamer (HapWebSocketServer::ConnectionPtr connectionToSendTo, std::unique_ptr<FrameSource> frameSource, Settings streamSettings)
        : juce::Thread ("EditorStreamer"), connection (std::move (connectionToSendTo)), source (std::move (frameSource)), settings (streamSettings),
          image (juce::Image::ARGB, source->getWidth(), source->getHeight(), true)
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
            auto now = juce::Time::getMillisecondCounterHiRes();
            if (now < nextAmbient && pendingInputTime.load() == 0.0)
                wait (static_cast<int> (std::ceil (nextAmbient - now))); // returns early on input
            if (threadShouldExit())
                break;

            auto ambient = juce::Time::getMillisecondCounterHiRes() >= nextAmbient;
            renderAndSend();
            // Ambient frames keep a fixed cadence; frames answering input don't move it
            if (ambient)
                nextAmbient = juce::jmax (nextAmbient + interval, juce::Time::getMillisecondCounterHiRes());
        }
    }

    void renderAndSend()
    {
        auto inputTime = pendingInputTime.exchange (0.0);

        auto t0 = juce::Time::getMillisecondCounterHiRes();
        source->render (image);
        auto t1 = juce::Time::getMillisecondCounterHiRes();

        // ARGB (premultiplied, BGRA in memory) -> RGBA as the browser's ImageData wants it
        auto width = image.getWidth(), height = image.getHeight();
        rgba.resize (static_cast<size_t> (width * height * 4));
        {
            juce::Image::BitmapData pixels (image, juce::Image::BitmapData::readOnly);
            auto* out = rgba.data();
            for (int y = 0; y < height; ++y)
            {
                auto* row = pixels.getLinePointer (y);
                for (int x = 0; x < width; ++x, row += pixels.pixelStride, out += 4)
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
    }

    HapWebSocketServer::ConnectionPtr connection;
    std::unique_ptr<FrameSource> source;
    Settings settings;
    juce::Image image;
    std::vector<uint8_t> rgba, message;
    uint32_t frameId = 0;
    std::atomic<double> pendingInputTime { 0.0 };
};

// Server handlers: START creates the connection's streamer around a fresh
// FrameSource from `makeSource`, INPUT goes to it, STOP or closing ends it.
inline HapWebSocketServer::Handlers makeEditorStreamHandlers (std::function<std::unique_ptr<FrameSource>()> makeSource)
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
            connection->context.reset(); // stop any previous streamer first
            connection->context = std::make_shared<EditorStreamer> (connection, makeSource(), settings);
        }
        else if (type == "INPUT")
        {
            if (auto streamer = std::static_pointer_cast<EditorStreamer> (connection->context))
                streamer->handleInput (message);
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
