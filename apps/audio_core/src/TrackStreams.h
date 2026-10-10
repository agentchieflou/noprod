#pragma once

#include <JuceHeader.h>
#include <cstring>
#include <functional>
#include <memory>

#include "HapWebSocketServer.h"
#include "InsertChain.h"

// Native plugins on the browser's own tracks (#26): each browser device that
// hosts a plugin opens a stream connection (ws://localhost:8083) and sends
// its track's audio through it in small blocks; GhostDAW runs the blocks
// through that stream's insert chain and sends them straight back.
//
// Text messages control the stream (OPEN first, then LOAD / SET_PARAM /
// GET_STATE / UNLOAD, see PluginHost::handleStreamCommand). Binary messages
// are audio, little-endian:
//   uint32 seq        echoed back unchanged (the sender's block position)
//   uint32 frames
//   uint32 channels   (<= InsertChain::maxChannels)
//   uint32 flags      reserved, 0
//   float32[channels][frames]   planar samples
// The reply is the same message with the samples processed in place.
//
// The connection's thread is the chain's audio thread: it is the only one
// that calls process(), and it never locks or allocates while doing so.
struct TrackStream
{
    static constexpr size_t headerBytes = 16;

    juce::String id;
    double sampleRate = 48000.0;
    int maxBlockSize = 512;
    InsertChain chain;
    // Sends a message to the stream's browser device unprompted (parameter
    // changes made in the plugin's editor); set when the stream opens
    std::function<void (const juce::var&)> sendToBrowser;

    // Processes one audio message in place. Returns false (leaving the data
    // untouched) if it is malformed.
    bool processFrame (uint8_t* data, size_t size) noexcept
    {
        if (size < headerBytes)
            return false;

        uint32_t header[4];
        std::memcpy (header, data, headerBytes);
        auto frames = header[1], channels = header[2];
        if (frames == 0 || channels == 0 || channels > InsertChain::maxChannels
            || size != headerBytes + static_cast<size_t> (frames) * channels * sizeof (float))
            return false;

        // The payload buffer comes from a std::vector<uint8_t>, so it is
        // aligned for floats, and the header keeps that alignment.
        auto* samples = reinterpret_cast<float*> (data + headerBytes);
        float* planes[InsertChain::maxChannels];
        for (uint32_t ch = 0; ch < channels; ++ch)
            planes[ch] = samples + static_cast<size_t> (ch) * frames;

        chain.process (planes, static_cast<int> (channels), static_cast<int> (frames));
        return true;
    }
};

// Wires a stream server's connections to the plugin host: OPEN creates the
// stream on the connection's thread, audio is processed there, and every
// other command runs on the message thread through `onCommand`, whose reply
// goes back to that connection.
template <typename Host>
HapWebSocketServer::Handlers makeTrackStreamHandlers (Host& host)
{
    using ConnectionPtr = HapWebSocketServer::ConnectionPtr;
    HapWebSocketServer::Handlers handlers;

    handlers.onText = [&host] (const ConnectionPtr& connection, const juce::var& message)
    {
        auto stream = std::static_pointer_cast<TrackStream> (connection->context);
        auto type = message["type"].toString();

        if (type == "OPEN")
        {
            if (stream == nullptr)
            {
                stream = std::make_shared<TrackStream>();
                stream->id = message["streamId"].toString();
                stream->sampleRate = juce::jlimit (8000.0, 384000.0, static_cast<double> (message.getProperty ("sampleRate", 48000.0)));
                stream->maxBlockSize = juce::jlimit (32, 8192, static_cast<int> (message.getProperty ("maxBlockSize", 512)));

                // Prepared here, before the message thread ever sees it
                juce::StringArray errors;
                stream->chain.prepare (stream->sampleRate, stream->maxBlockSize, errors);
                stream->chain.audioStarted (stream->sampleRate);
                stream->sendToBrowser = [weak = std::weak_ptr<HapWebSocketServer::Connection> (connection)] (const juce::var& m)
                {
                    if (auto c = weak.lock())
                        c->sendText (juce::JSON::toString (m, true));
                };
                connection->context = stream;

                juce::MessageManager::callAsync ([&host, stream] { host.registerStream (stream); });
            }
            connection->sendText (R"({"type":"STREAM_OPENED"})");
            return;
        }

        if (stream == nullptr)
        {
            connection->sendText (R"({"type":"STREAM_ERROR","message":"Send OPEN first"})");
            return;
        }

        juce::MessageManager::callAsync ([&host, stream, message, connection]
        {
            auto reply = host.handleStreamCommand (*stream, message);
            if (! reply.isVoid())
                connection->sendText (juce::JSON::toString (reply, true));
        });
    };

    handlers.onBinary = [] (const ConnectionPtr& connection, uint8_t* data, size_t size)
    {
        // Before OPEN (or for a malformed block) the audio goes back dry
        if (auto stream = std::static_pointer_cast<TrackStream> (connection->context))
            stream->processFrame (data, size);
        connection->sendBinary (data, size);
    };

    handlers.onClose = [&host] (const ConnectionPtr& connection)
    {
        if (auto stream = std::static_pointer_cast<TrackStream> (connection->context))
        {
            stream->chain.audioStopped(); // no more blocks: retired snapshots can go
            juce::MessageManager::callAsync ([&host, stream] { host.closeStream (stream); });
        }
    };

    return handlers;
}
