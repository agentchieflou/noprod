#include "AudioDevice.h"

#include "../platform/Log.h"

#include <miniaudio.h>

#include <algorithm>
#include <atomic>

namespace ghostdaw
{

struct AudioDevice::Impl
{
    Mixer& mixer;
    Watchdog* watchdog;
    AudioDevice& owner;
    ma_context context {};
    ma_device device {};
    bool contextOpen = false, deviceOpen = false, usingNull = false;
    std::atomic<double> sampleRate { 0.0 };
    std::atomic<int> blockSize { 0 };
    std::atomic<bool> running { false };

    Impl (Mixer& m, Watchdog* w, AudioDevice& o) : mixer (m), watchdog (w), owner (o) {}

    static void dataCallback (ma_device* device, void* output, const void*, ma_uint32 frameCount)
    {
        auto* self = static_cast<Impl*> (device->pUserData);
        if (self->watchdog != nullptr)
            self->watchdog->callbackBegan();
        self->mixer.renderInterleaved (static_cast<float*> (output), static_cast<int> (device->playback.channels), static_cast<int> (frameCount));
        if (self->watchdog != nullptr)
            self->watchdog->callbackEnded();
    }

    static void notificationCallback (const ma_device_notification* notification)
    {
        auto* self = static_cast<Impl*> (notification->pDevice->pUserData);
        switch (notification->type)
        {
            case ma_device_notification_type_rerouted:
                // Another output, maybe at another rate: the owner restarts
                // the device from its control thread (the mixer can't be
                // re-prepared under a running callback)
                Log::info ("audio device re-routed to " + self->owner.getName());
                if (self->owner.onRerouted)
                    self->owner.onRerouted();
                break;
            case ma_device_notification_type_stopped:
                self->running.store (false);
                self->mixer.stop();
                Log::warn ("audio device stopped");
                break;
            case ma_device_notification_type_started:
                self->running.store (true);
                break;
            default:
                break;
        }
    }

    // Before the device runs (or runs again): the mixer takes the format,
    // then the owner hears about it. Never while a callback can run.
    void prepareMixer()
    {
        auto rate = device.sampleRate > 0 ? static_cast<double> (device.sampleRate) : 48000.0;
        auto block = static_cast<int> (device.playback.internalPeriodSizeInFrames);
        if (block <= 0)
            block = 512;
        sampleRate.store (rate);
        blockSize.store (block);
        mixer.prepareScratch (2, std::max (block, 8192));
        mixer.start (rate, block);
        if (owner.onStarted)
            owner.onStarted (rate, block);
    }

    bool start (std::string& error)
    {
        prepareMixer();
        auto result = ma_device_start (&device);
        if (result != MA_SUCCESS)
        {
            error = std::string ("audio start: ") + ma_result_description (result);
            return false;
        }
        running.store (true);
        return true;
    }

    bool tryOpen (bool nullBackend, const Options& options, std::string& error)
    {
        ma_backend nullOnly[] = { ma_backend_null };
        auto contextConfig = ma_context_config_init();
        auto result = ma_context_init (nullBackend ? nullOnly : nullptr, nullBackend ? 1u : 0u, &contextConfig, &context);
        if (result != MA_SUCCESS)
        {
            error = std::string ("audio context: ") + ma_result_description (result);
            return false;
        }
        contextOpen = true;

        auto config = ma_device_config_init (ma_device_type_playback);
        config.playback.format = ma_format_f32;
        config.playback.channels = 2;
        config.sampleRate = 0; // the device's own rate
        config.periodSizeInFrames = static_cast<ma_uint32> (std::clamp (options.preferredBlockSize, 32, 8192));
        config.dataCallback = dataCallback;
        config.notificationCallback = notificationCallback;
        config.pUserData = this;
        result = ma_device_init (&context, &config, &device);
        if (result != MA_SUCCESS)
        {
            error = std::string ("audio device: ") + ma_result_description (result);
            ma_context_uninit (&context);
            contextOpen = false;
            return false;
        }
        deviceOpen = true;
        usingNull = context.backend == ma_backend_null;
        return true;
    }
};

AudioDevice::AudioDevice (Mixer& mixerToDrive, Watchdog* watchdogToMark)
    : impl (std::make_unique<Impl> (mixerToDrive, watchdogToMark, *this))
{
}

AudioDevice::~AudioDevice()
{
    close();
}

bool AudioDevice::open (const Options& options, std::string& error)
{
    close();

    if (! impl->tryOpen (options.nullBackend, options, error))
    {
        if (options.nullBackend)
            return false;
        Log::warn ("no audio output could be opened (" + error + "); running silent on the null backend");
        if (! impl->tryOpen (true, options, error))
            return false;
    }

    if (! impl->start (error))
    {
        close();
        return false;
    }
    Log::info ("audio: " + getName() + " through " + getBackendName() + " at " + std::to_string (static_cast<int> (getSampleRate()))
               + " Hz, " + std::to_string (getBlockSize()) + " frames per callback");
    return true;
}

bool AudioDevice::restart (std::string& error)
{
    if (! impl->deviceOpen)
    {
        error = "no device";
        return false;
    }
    ma_device_stop (&impl->device); // waits for the callback to finish
    impl->running.store (false);
    impl->mixer.stop();
    if (! impl->start (error))
        return false;
    Log::info ("audio restarted: " + getName() + " at " + std::to_string (static_cast<int> (getSampleRate())) + " Hz");
    return true;
}

void AudioDevice::close()
{
    if (impl->deviceOpen)
    {
        ma_device_uninit (&impl->device); // stops it, waits for the callback
        impl->deviceOpen = false;
        impl->running.store (false);
        impl->mixer.stop();
    }
    if (impl->contextOpen)
    {
        ma_context_uninit (&impl->context);
        impl->contextOpen = false;
    }
    impl->usingNull = false;
}

bool AudioDevice::isOpen() const { return impl->deviceOpen; }
bool AudioDevice::isNull() const { return impl->deviceOpen && impl->usingNull; }
double AudioDevice::getSampleRate() const { return impl->sampleRate.load(); }
int AudioDevice::getBlockSize() const { return impl->blockSize.load(); }

std::string AudioDevice::getName() const
{
    if (! impl->deviceOpen)
        return {};
    char name[256] = {};
    if (ma_device_get_name (&impl->device, ma_device_type_playback, name, sizeof (name), nullptr) != MA_SUCCESS)
        return {};
    return name;
}

std::string AudioDevice::getBackendName() const
{
    return impl->contextOpen ? ma_get_backend_name (impl->context.backend) : "";
}

Json AudioDevice::describe() const
{
    return Json::object ({ { "name", getName() }, { "running", impl->deviceOpen && impl->running.load() }, { "backend", getBackendName() } });
}

} // namespace ghostdaw
