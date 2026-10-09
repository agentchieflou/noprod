// LPI test plugin for the audio_core host tests: stereo gain with a "mute"
// switch. Written in C++ (std::atomic) so it builds with any compiler; the
// exported surface is the plain C LPI ABI.
//
// Parameter changes follow lpi.h's RT contract: set_parameter_value stores
// into an atomic slot, process() picks it up at the top of the next block.
//
// Build variants (compile definitions) exercise the host's error paths:
//   LPI_TEST_BAD_MAJOR  reports an incompatible ABI major version
//   LPI_TEST_NO_EXPORT  doesn't export lpi_get_factory at all

#include <lpi/lpi.h>

#include <atomic>
#include <cstring>
#include <new>

namespace
{
enum { kGain = 0, kMute = 1, kNumParams = 2 };

struct Instance
{
    double sampleRate = 0.0;
    uint32_t maxBlockSize = 0;
    std::atomic<float> requested[kNumParams] { { 1.0f }, { 0.0f } };
    float applied[kNumParams] { 1.0f, 0.0f };
};

Instance* self (lpi_plugin* p) { return reinterpret_cast<Instance*> (p); }

lpi_plugin* create (double sampleRate, uint32_t maxBlockSize)
{
    auto* instance = new (std::nothrow) Instance();
    if (instance == nullptr)
        return nullptr;
    instance->sampleRate = sampleRate;
    instance->maxBlockSize = maxBlockSize;
    return reinterpret_cast<lpi_plugin*> (instance);
}

void destroy (lpi_plugin* p) { delete self (p); }
bool activate (lpi_plugin* p) { return p != nullptr; }
void deactivate (lpi_plugin*) {}

void process (lpi_plugin* p, const lpi_process_data* data)
{
    auto* s = self (p);
    for (int i = 0; i < kNumParams; ++i)
        s->applied[i] = s->requested[i].load (std::memory_order_relaxed);

    auto gain = s->applied[kMute] >= 0.5f ? 0.0f : s->applied[kGain];
    auto channels = data->num_input_channels < data->num_output_channels ? data->num_input_channels : data->num_output_channels;

    for (uint32_t ch = 0; ch < channels; ++ch)
        for (uint32_t i = 0; i < data->num_frames; ++i)
            data->outputs[ch][i] = data->inputs[ch][i] * gain;
}

uint32_t getParameterCount (lpi_plugin*) { return kNumParams; }

bool getParameterInfo (lpi_plugin*, uint32_t index, lpi_parameter_info* info)
{
    if (info == nullptr || index >= kNumParams)
        return false;

    info->index = index;
    if (index == kGain)
    {
        info->id = "gain";
        info->name = "Gain";
        info->min_value = 0.0f;
        info->max_value = 2.0f;
        info->default_value = 1.0f;
        info->flags = 0;
    }
    else
    {
        info->id = "mute";
        info->name = "Mute";
        info->min_value = 0.0f;
        info->max_value = 1.0f;
        info->default_value = 0.0f;
        info->flags = LPI_PARAM_BOOLEAN | LPI_PARAM_STEPPED;
    }
    return true;
}

float getParameterValue (lpi_plugin* p, uint32_t index)
{
    return index < kNumParams ? self (p)->requested[index].load() : 0.0f;
}

bool setParameterValue (lpi_plugin* p, uint32_t index, float value)
{
    if (index >= kNumParams)
        return false;
    self (p)->requested[index].store (value);
    return true;
}

size_t getState (lpi_plugin* p, void* buffer, size_t size)
{
    float values[kNumParams] { self (p)->requested[kGain].load(), self (p)->requested[kMute].load() };
    if (buffer == nullptr)
        return sizeof (values);
    if (size < sizeof (values))
        return 0;
    std::memcpy (buffer, values, sizeof (values));
    return sizeof (values);
}

bool setState (lpi_plugin* p, const void* data, size_t size)
{
    float values[kNumParams];
    if (data == nullptr || size < sizeof (values))
        return false;
    std::memcpy (values, data, sizeof (values));
    for (int i = 0; i < kNumParams; ++i)
        self (p)->requested[i].store (values[i]);
    return true;
}

void* getExtension (lpi_plugin*, const char*) { return nullptr; }

const lpi_plugin_api api {
    create, destroy, activate, deactivate, process,
    getParameterCount, getParameterInfo, getParameterValue, setParameterValue,
    getState, setState, getExtension
};

const lpi_plugin_info info { "com.noprod.test.gain", "NoProd Test Gain", "NoProd", 2, 2 };

const lpi_plugin_info* getInfo() { return &info; }
const lpi_plugin_api* getApi() { return &api; }

#ifdef LPI_TEST_BAD_MAJOR
const lpi_plugin_factory factory { { 99, 0 }, getInfo, getApi };
#else
const lpi_plugin_factory factory { { LPI_ABI_VERSION_MAJOR, LPI_ABI_VERSION_MINOR }, getInfo, getApi };
#endif
} // namespace

#ifndef LPI_TEST_NO_EXPORT
#if defined(_WIN32)
extern "C" __declspec (dllexport) const lpi_plugin_factory* lpi_get_factory() { return &factory; }
#else
extern "C" __attribute__ ((visibility ("default"))) const lpi_plugin_factory* lpi_get_factory() { return &factory; }
#endif
#else
extern "C" const lpi_plugin_factory* lpi_test_not_the_factory() { return &factory; }
#endif
