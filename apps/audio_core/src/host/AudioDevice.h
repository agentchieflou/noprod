#pragma once

#include "../platform/Json.h"
#include "Mixer.h"
#include "Watchdog.h"

#include <functional>
#include <memory>
#include <string>

namespace ghostdaw
{

// The audio output device, through miniaudio (third_party/miniaudio):
// stereo float at the device's native rate, rendered by the Mixer on the
// device's thread. When no device can be opened (a headless machine, CI),
// miniaudio's null backend keeps the engine ticking in silence.
class AudioDevice
{
public:
    struct Options
    {
        bool nullBackend = false;     // force the silent backend
        int preferredBlockSize = 512; // frames per callback, if the backend agrees
    };

    AudioDevice (Mixer& mixerToDrive, Watchdog* watchdogToMark = nullptr);
    ~AudioDevice();
    AudioDevice (const AudioDevice&) = delete;
    AudioDevice& operator= (const AudioDevice&) = delete;

    // Opens and starts the device. False (with the reason) only when even
    // the null backend fails.
    bool open (const Options& options, std::string& error);
    void close();

    // Called with the device's format just before it starts (from open()
    // and restart(), on their caller's thread, never under a running
    // callback). Set it before open().
    std::function<void (double sampleRate, int blockSize)> onStarted;

    // The OS moved the output to another device (its rate may differ).
    // Called on a device thread: post a restart() to the control thread.
    std::function<void()> onRerouted;

    // Stops the device, re-prepares the mixer for its current format and
    // starts it again (the control thread, after a re-route)
    bool restart (std::string& error);

    bool isOpen() const;
    bool isNull() const;     // running on the silent backend
    double getSampleRate() const;
    int getBlockSize() const;
    std::string getName() const;
    std::string getBackendName() const;

    // { name, running, backend }, for AUDIO_CORE_STATE
    Json describe() const;

private:
    struct Impl;
    std::unique_ptr<Impl> impl;
};

} // namespace ghostdaw
