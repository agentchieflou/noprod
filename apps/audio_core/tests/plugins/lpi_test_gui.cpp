// LPI test plugin with an editor (lpi.gui.offscreen.v1), for the editor
// streaming tests (#44 B6c): a stereo gain whose editor draws the gain as a
// bar and changes it when dragged vertically.
//
// The editor writes the gain through the same atomic slot as
// set_parameter_value, the way lpi.h describes a GUI feeding the plugin's
// parameter queue. It is drawn in software, so it needs no GPU.
//
// It also checks the host against lpi.h's GUI threading rule: every GUI call
// and every set_parameter_value must come from one thread. Calls from any
// other thread are counted in the read-only "guiThreadViolations" parameter.
//
// It reports its editor's changes through lpi.params.changes.v1, with a
// gesture per drag. Build variants (compile definitions):
//   LPI_TEST_GUI_POLLING     without lpi.params.changes.v1 (the host polls)
//   LPI_TEST_GUI_LATENCY=n   delays its audio by n samples and reports it
//                            through lpi.latency.v1

#include <lpi/lpi.h>

#include <atomic>
#include <cmath>
#include <cstring>
#include <new>
#include <thread>
#include <vector>

namespace
{
enum { kGain = 0, kViolations = 1, kNumParams = 2 };

constexpr uint32_t kLogicalWidth = 200, kLogicalHeight = 150;
#ifdef LPI_TEST_GUI_LATENCY
constexpr uint32_t kLatency = LPI_TEST_GUI_LATENCY;
#else
constexpr uint32_t kLatency = 0;
#endif

std::atomic<bool> editorOpenInProcess { false }; // lpi.h v1: one editor per process

struct Instance
{
    std::atomic<float> gain { 1.0f };
    float appliedGain = 1.0f;
    std::atomic<int> violations { 0 };
    std::atomic<std::thread::id> guiThread {};

    // Editor state (GUI thread only)
    bool open = false;
    float scale = 1.0f;
    uint32_t width = 0, height = 0;
    std::vector<uint8_t> pixels;
    bool dragging = false;
    float lastX = -100.0f, lastY = -100.0f;

    // lpi.params.changes.v1: the gain's change since the host last asked
    bool dragChanged = false; // this drag has changed the gain already
    bool changePending = false;
    float changeValue = 0.0f;
    uint32_t changeFlags = 0;

    void queueChange (float value, uint32_t flags)
    {
        changePending = true;
        changeValue = value;
        changeFlags |= flags;
    }

    // Audio thread: the latency variant's delay line, frame-interleaved
    std::vector<float> delay = std::vector<float> (kLatency * 2, 0.0f);
    uint32_t delayPos = 0;

    // The first thread to touch the GUI or set a parameter is the GUI thread
    void checkThread()
    {
        auto expected = std::thread::id();
        auto self = std::this_thread::get_id();
        if (! guiThread.compare_exchange_strong (expected, self) && expected != self)
            ++violations;
    }
};

Instance* self (lpi_plugin* p) { return reinterpret_cast<Instance*> (p); }

lpi_plugin* create (double, uint32_t) { return reinterpret_cast<lpi_plugin*> (new (std::nothrow) Instance()); }

void destroy (lpi_plugin* p)
{
    if (self (p)->open)
        editorOpenInProcess = false;
    delete self (p);
}

bool activate (lpi_plugin* p) { return p != nullptr; }
void deactivate (lpi_plugin*) {}

void process (lpi_plugin* p, const lpi_process_data* data)
{
    auto* s = self (p);
    s->appliedGain = s->gain.load (std::memory_order_relaxed);
    auto channels = data->num_input_channels < data->num_output_channels ? data->num_input_channels : data->num_output_channels;
    if (channels > 2)
        channels = 2;

    if (kLatency == 0)
    {
        for (uint32_t ch = 0; ch < channels; ++ch)
            for (uint32_t i = 0; i < data->num_frames; ++i)
                data->outputs[ch][i] = data->inputs[ch][i] * s->appliedGain;
        return;
    }

    for (uint32_t i = 0; i < data->num_frames; ++i)
    {
        for (uint32_t ch = 0; ch < channels; ++ch)
        {
            auto& slot = s->delay[s->delayPos * 2 + ch];
            auto delayed = slot;
            slot = data->inputs[ch][i];
            data->outputs[ch][i] = delayed * s->appliedGain;
        }
        s->delayPos = (s->delayPos + 1) % (kLatency > 0 ? kLatency : 1);
    }
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
        info->id = "guiThreadViolations";
        info->name = "GUI thread violations";
        info->min_value = 0.0f;
        info->max_value = 1.0e9f;
        info->default_value = 0.0f;
        info->flags = LPI_PARAM_READONLY | LPI_PARAM_STEPPED;
    }
    return true;
}

float getParameterValue (lpi_plugin* p, uint32_t index)
{
    if (index == kGain)
        return self (p)->gain.load();
    if (index == kViolations)
        return static_cast<float> (self (p)->violations.load());
    return 0.0f;
}

bool setParameterValue (lpi_plugin* p, uint32_t index, float value)
{
    self (p)->checkThread();
    if (index != kGain)
        return false;
    self (p)->gain.store (value);
    return true;
}

size_t getState (lpi_plugin* p, void* buffer, size_t size)
{
    auto gain = self (p)->gain.load();
    if (buffer == nullptr)
        return sizeof (gain);
    if (size < sizeof (gain))
        return 0;
    std::memcpy (buffer, &gain, sizeof (gain));
    return sizeof (gain);
}

bool setState (lpi_plugin* p, const void* data, size_t size)
{
    float gain;
    if (data == nullptr || size < sizeof (gain))
        return false;
    std::memcpy (&gain, data, sizeof (gain));
    self (p)->gain.store (gain);
    return true;
}

// ------------------------------------------------------------------ editor

bool guiOpen (lpi_plugin* p, float dpiScale, lpi_gui_offscreen_info* info)
{
    auto* s = self (p);
    s->checkThread();
    if (s->open || editorOpenInProcess.exchange (true))
        return false;

    s->open = true;
    s->scale = dpiScale > 0.0f ? dpiScale : 1.0f;
    s->width = static_cast<uint32_t> (std::lround (kLogicalWidth * s->scale));
    s->height = static_cast<uint32_t> (std::lround (kLogicalHeight * s->scale));
    s->pixels.assign (static_cast<size_t> (s->width) * s->height * 4, 0);
    if (info != nullptr)
        *info = { kLogicalWidth, kLogicalHeight, s->width, s->height };
    return true;
}

void guiClose (lpi_plugin* p)
{
    auto* s = self (p);
    s->checkThread();
    if (! s->open)
        return;
    if (s->dragging && s->dragChanged)
        s->queueChange (s->gain.load(), LPI_PARAM_CHANGE_GESTURE_END); // closed mid-drag
    s->open = false;
    s->dragging = false;
    editorOpenInProcess = false;
}

void fill (Instance& s, int x0, int y0, int x1, int y1, uint8_t r, uint8_t g, uint8_t b)
{
    auto w = static_cast<int> (s.width), h = static_cast<int> (s.height);
    for (int y = y0 < 0 ? 0 : y0; y < (y1 > h ? h : y1); ++y)
        for (int x = x0 < 0 ? 0 : x0; x < (x1 > w ? w : x1); ++x)
        {
            auto* px = &s.pixels[(static_cast<size_t> (y) * s.width + static_cast<size_t> (x)) * 4];
            px[0] = r; px[1] = g; px[2] = b; px[3] = 255;
        }
}

// Background, a bar as tall as the gain (full height at 2.0), and a white
// square where the mouse last was
bool guiRender (lpi_plugin* p)
{
    auto* s = self (p);
    s->checkThread();
    if (! s->open)
        return false;

    auto w = static_cast<int> (s->width), h = static_cast<int> (s->height);
    fill (*s, 0, 0, w, h, 24, 28, 40);
    auto barHeight = static_cast<int> (std::lround (s->gain.load() / 2.0f * static_cast<float> (h)));
    fill (*s, w / 4, h - barHeight, w * 3 / 4, h, 59, 130, 246);
    auto mx = static_cast<int> (s->lastX * s->scale), my = static_cast<int> (s->lastY * s->scale);
    fill (*s, mx - 2, my - 2, mx + 3, my + 3, 255, 255, 255);
    return true;
}

bool guiReadPixels (lpi_plugin* p, uint8_t* out, size_t size)
{
    auto* s = self (p);
    s->checkThread();
    if (! s->open || out == nullptr || size < s->pixels.size())
        return false;
    std::memcpy (out, s->pixels.data(), s->pixels.size());
    return true;
}

// Dragging up raises the gain: 0.02 per logical pixel
void guiMouse (lpi_plugin* p, int type, float x, float y)
{
    auto* s = self (p);
    s->checkThread();
    if (! s->open)
        return;

    if (type == LPI_MOUSE_DOWN)
    {
        s->dragging = true;
        s->dragChanged = false;
    }
    else if (type == LPI_MOUSE_UP)
    {
        if (s->dragging && s->dragChanged)
            s->queueChange (s->gain.load(), LPI_PARAM_CHANGE_GESTURE_END);
        s->dragging = false;
    }
    else if (type == LPI_MOUSE_MOVE && s->dragging)
    {
        auto gain = s->gain.load() + (s->lastY - y) * 0.02f;
        gain = gain < 0.0f ? 0.0f : gain > 2.0f ? 2.0f : gain;
        if (gain != s->gain.load())
        {
            s->gain.store (gain);
            s->queueChange (gain, s->dragChanged ? 0u : static_cast<uint32_t> (LPI_PARAM_CHANGE_GESTURE_BEGIN));
            s->dragChanged = true;
        }
    }
    s->lastX = x;
    s->lastY = y;
}

const lpi_gui_offscreen_v1 gui { guiOpen, guiClose, guiRender, guiReadPixels, guiMouse };

// lpi.params.changes.v1 (GUI thread): only the gain ever changes by itself
uint32_t getParameterChanges (lpi_plugin* p, lpi_param_change* out, uint32_t max)
{
    auto* s = self (p);
    s->checkThread();
    if (! s->changePending || max == 0 || out == nullptr)
        return 0;
    out[0] = { kGain, s->changeValue, s->changeFlags };
    s->changePending = false;
    s->changeFlags = 0;
    return 1;
}

const lpi_param_changes_v1 paramChanges { getParameterChanges };

uint32_t getLatency (lpi_plugin* p)
{
    self (p)->checkThread();
    return kLatency;
}

const lpi_latency_v1 latency { getLatency };

void* getExtension (lpi_plugin*, const char* id)
{
    if (id == nullptr)
        return nullptr;
    if (std::strcmp (id, LPI_EXT_GUI_OFFSCREEN_V1) == 0)
        return const_cast<lpi_gui_offscreen_v1*> (&gui);
   #ifndef LPI_TEST_GUI_POLLING
    if (std::strcmp (id, LPI_EXT_PARAM_CHANGES_V1) == 0)
        return const_cast<lpi_param_changes_v1*> (&paramChanges);
   #endif
    if (kLatency > 0 && std::strcmp (id, LPI_EXT_LATENCY_V1) == 0)
        return const_cast<lpi_latency_v1*> (&latency);
    return nullptr;
}

const lpi_plugin_api api {
    create, destroy, activate, deactivate, process,
    getParameterCount, getParameterInfo, getParameterValue, setParameterValue,
    getState, setState, getExtension
};

#if defined(LPI_TEST_GUI_POLLING)
const lpi_plugin_info info { "com.noprod.test.gui.polling", "NoProd Test GUI (polling)", "NoProd", 2, 2 };
#elif defined(LPI_TEST_GUI_LATENCY)
const lpi_plugin_info info { "com.noprod.test.gui.latency", "NoProd Test GUI (latency)", "NoProd", 2, 2 };
#else
const lpi_plugin_info info { "com.noprod.test.gui", "NoProd Test GUI", "NoProd", 2, 2 };
#endif

const lpi_plugin_info* getInfo() { return &info; }
const lpi_plugin_api* getApi() { return &api; }

const lpi_plugin_factory factory { { LPI_ABI_VERSION_MAJOR, LPI_ABI_VERSION_MINOR }, getInfo, getApi };
} // namespace

#if defined(_WIN32)
extern "C" __declspec (dllexport) const lpi_plugin_factory* lpi_get_factory() { return &factory; }
#else
extern "C" __attribute__ ((visibility ("default"))) const lpi_plugin_factory* lpi_get_factory() { return &factory; }
#endif
