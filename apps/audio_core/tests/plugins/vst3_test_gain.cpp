// A VST 3 test plug-in written against the SDK's interfaces alone, for
// the host tests: a stereo gain ("Gain", id 0, normalized 0..1, default 1)
// that also reports the tempo its host's ProcessContext last carried in a
// read-only "Host tempo" parameter (id 1, normalized bpm / 1000), through
// its output parameter changes.
//
// Two builds: a single-component effect (the component is its own
// controller), and with TEST_VST3_SEPARATE_CONTROLLER a component and a
// separate controller class, connected the VST 3 way, so the host's
// handling of both is tested. State is the gain as one float.

#include "pluginterfaces/base/ibstream.h"
#include "pluginterfaces/base/ipluginbase.h"
#include "pluginterfaces/vst/ivstaudioprocessor.h"
#include "pluginterfaces/vst/ivstcomponent.h"
#include "pluginterfaces/vst/ivsteditcontroller.h"
#include "pluginterfaces/vst/ivsthostapplication.h"
#include "pluginterfaces/vst/ivstmessage.h"
#include "pluginterfaces/vst/ivstparameterchanges.h"
#include "pluginterfaces/vst/ivstprocesscontext.h"
#include "pluginterfaces/vst/vstspeaker.h"

#include <atomic>
#include <cstdio>
#include <cstring>
#include <string>
#include <thread>
#include <vector>

using namespace Steinberg;
using namespace Steinberg::Vst;

namespace
{

// The interface ids, defined here since the plug-in links nothing else
} // namespace

namespace Steinberg
{
DEF_CLASS_IID (FUnknown)
DEF_CLASS_IID (IPluginBase)
DEF_CLASS_IID (IPluginFactory)
DEF_CLASS_IID (IPluginFactory2)
DEF_CLASS_IID (IBStream)
namespace Vst
{
DEF_CLASS_IID (IComponent)
DEF_CLASS_IID (IAudioProcessor)
DEF_CLASS_IID (IEditController)
DEF_CLASS_IID (IConnectionPoint)
DEF_CLASS_IID (IHostApplication)
DEF_CLASS_IID (IMessage)
DEF_CLASS_IID (IAttributeList)
DEF_CLASS_IID (IParameterChanges)
DEF_CLASS_IID (IParamValueQueue)
} // namespace Vst
} // namespace Steinberg

int32 PLUGIN_API Steinberg::FUnknownPrivate::atomicAdd (int32& value, int32 amount)
{
    return reinterpret_cast<std::atomic<int32>&> (value).fetch_add (amount) + amount;
}

namespace
{

constexpr ParamID kGainId = 0, kHostTempoId = 1;
// A state with this gain (no parameter can set it: they are normalised)
// tells the single-class variant to edit the gain from its own thread
constexpr float kEditStormGain = -1.0f;
constexpr int kEditStormCount = 2000;

#if defined(TEST_VST3_SEPARATE_CONTROLLER)
DECLARE_UID (kComponentUid, 0x4E6F5072, 0x6F645465, 0x73744761, 0x696E5343) // "NoPrTestGainSC"
DECLARE_UID (kControllerUid, 0x4E6F5072, 0x6F645465, 0x73744761, 0x696E4343)
constexpr const char* kPluginName = "NoProd Test Gain (separate controller)";
#else
DECLARE_UID (kComponentUid, 0x4E6F5072, 0x6F645465, 0x73744761, 0x696E0001) // "NoPrTestGain"
constexpr const char* kPluginName = "NoProd Test Gain";
#endif

// The host's messages, as a plug-in would use them to talk to its
// controller: a string set then read back, and a buffer too small for a
// terminator (or none) refused rather than overrun. The component refuses
// to initialise with a host that gets this wrong, which a test sees.
bool hostMessagesWork (FUnknown* context)
{
    IHostApplication* host = nullptr;
    if (context == nullptr || context->queryInterface (IHostApplication::iid, reinterpret_cast<void**> (&host)) != kResultOk || host == nullptr)
        return false;
    IMessage* message = nullptr;
    TUID messageId;
    std::memcpy (messageId, IMessage::iid.toTUID(), sizeof (TUID));
    auto ok = host->createInstance (messageId, messageId, reinterpret_cast<void**> (&message)) == kResultOk && message != nullptr;
    host->release();
    if (! ok)
        return false;
    message->setMessageID ("probe");
    auto* attributes = message->getAttributes();
    TChar text[8] = {};
    const TChar hi[] = { 'h', 'i', 0 };
    ok = attributes != nullptr
      && attributes->setString ("text", hi) == kResultOk
      && attributes->getString ("text", text, 1) == kInvalidArgument
      && attributes->getString ("text", nullptr, sizeof (text)) == kInvalidArgument
      && attributes->getString ("text", text, sizeof (text)) == kResultOk && text[0] == 'h' && text[1] == 'i' && text[2] == 0
      && attributes->getString ("missing", text, sizeof (text)) == kResultFalse;
    message->release();
    return ok;
}

void copyString (String128 out, const char* text)
{
    size_t i = 0;
    for (; text[i] != 0 && i < 127; ++i)
        out[i] = static_cast<char16> (text[i]);
    out[i] = 0;
}

// Reference counting and queryInterface for the objects below
template <typename First, typename...>
struct FirstOf { using type = First; };

template <typename... Interfaces>
class Object : public Interfaces...
{
public:
    virtual ~Object() = default;
    uint32 PLUGIN_API addRef() override { return static_cast<uint32> (++refs); }
    uint32 PLUGIN_API release() override
    {
        auto left = --refs;
        if (left == 0)
            delete this;
        return static_cast<uint32> (left);
    }
    tresult PLUGIN_API queryInterface (const TUID _iid, void** obj) override
    {
        if (FUnknownPrivate::iidEqual (_iid, FUnknown::iid))
        {
            *obj = static_cast<FUnknown*> (first());
            addRef();
            return kResultOk;
        }
        for (auto& [id, pointer] : table)
            if (FUnknownPrivate::iidEqual (_iid, id->toTUID()))
            {
                *obj = pointer;
                addRef();
                return kResultOk;
            }
        *obj = nullptr;
        return kNoInterface;
    }

protected:
    template <typename I>
    void expose (I* self) { table.push_back ({ &I::iid, static_cast<void*> (self) }); }

private:
    std::atomic<int> refs { 1 };
    std::vector<std::pair<const FUID*, void*>> table; // (the ids' storage is static)
    FUnknown* first() { return static_cast<FUnknown*> (static_cast<typename FirstOf<Interfaces...>::type*> (this)); }
};

// The state both parts share: the gain, and what the processor saw
struct GainState
{
    std::atomic<double> gain { 1.0 };
    std::atomic<double> hostTempo { 0.0 };
};

// The controller's half: parameters and their text
class ControllerPart
{
public:
    GainState* state = nullptr;

    int32 parameterCount() { return 2; }

    tresult parameterInfo (int32 index, ParameterInfo& info)
    {
        if (index < 0 || index > 1)
            return kResultFalse;
        std::memset (&info, 0, sizeof (info));
        info.id = index == 0 ? kGainId : kHostTempoId;
        copyString (info.title, index == 0 ? "Gain" : "Host tempo");
        copyString (info.shortTitle, index == 0 ? "Gain" : "Tempo");
        copyString (info.units, index == 0 ? "" : "bpm");
        info.stepCount = 0;
        info.defaultNormalizedValue = index == 0 ? 1.0 : 0.0;
        info.unitId = 0;
        info.flags = index == 0 ? ParameterInfo::kCanAutomate : ParameterInfo::kIsReadOnly;
        return kResultOk;
    }

    tresult stringByValue (ParamID id, ParamValue normalized, String128 string)
    {
        char text[64];
        if (id == kGainId)
            std::snprintf (text, sizeof (text), "%.2f", normalized);
        else if (id == kHostTempoId)
            std::snprintf (text, sizeof (text), "%.1f", normalized * 1000.0);
        else
            return kResultFalse;
        copyString (string, text);
        return kResultOk;
    }

    ParamValue normalized (ParamID id) { return id == kGainId ? state->gain.load() : id == kHostTempoId ? state->hostTempo.load() : 0.0; }

    tresult setNormalized (ParamID id, ParamValue value)
    {
        if (id == kGainId) state->gain.store (value);
        else if (id == kHostTempoId) state->hostTempo.store (value);
        else return kResultFalse;
        return kResultOk;
    }
};

// The component and processor
class GainComponent : public Object<IComponent, IAudioProcessor
#if ! defined(TEST_VST3_SEPARATE_CONTROLLER)
                                    , IEditController
#endif
                                    , IConnectionPoint>
{
public:
    GainComponent()
    {
        expose<IComponent> (this);
        expose<IPluginBase> (static_cast<IComponent*> (this));
        expose<IAudioProcessor> (this);
        expose<IConnectionPoint> (this);
       #if ! defined(TEST_VST3_SEPARATE_CONTROLLER)
        expose<IEditController> (this);
        controller.state = &state;
       #endif
    }

    // IPluginBase
    tresult PLUGIN_API initialize (FUnknown* context) override { return hostMessagesWork (context) ? kResultOk : kResultFalse; }
    tresult PLUGIN_API terminate() override
    {
       #if ! defined(TEST_VST3_SEPARATE_CONTROLLER)
        stopEditStorm();
        componentHandler = nullptr;
       #endif
        return kResultOk;
    }

    // IComponent
    tresult PLUGIN_API getControllerClassId (TUID classId) override
    {
       #if defined(TEST_VST3_SEPARATE_CONTROLLER)
        std::memcpy (classId, kControllerUid, sizeof (TUID));
        return kResultOk;
       #else
        (void) classId;
        return kResultFalse;
       #endif
    }
    tresult PLUGIN_API setIoMode (IoMode) override { return kResultOk; }
    int32 PLUGIN_API getBusCount (MediaType type, BusDirection) override { return type == kAudio ? 1 : 0; }
    tresult PLUGIN_API getBusInfo (MediaType type, BusDirection dir, int32 index, BusInfo& bus) override
    {
        if (type != kAudio || index != 0)
            return kResultFalse;
        bus.mediaType = kAudio;
        bus.direction = dir;
        bus.channelCount = 2;
        copyString (bus.name, dir == kInput ? "Input" : "Output");
        bus.busType = kMain;
        bus.flags = BusInfo::kDefaultActive;
        return kResultOk;
    }
    tresult PLUGIN_API getRoutingInfo (RoutingInfo&, RoutingInfo&) override { return kResultFalse; }
    tresult PLUGIN_API activateBus (MediaType, BusDirection, int32, TBool) override { return kResultOk; }
    tresult PLUGIN_API setActive (TBool isActive) override { active = isActive != 0; return kResultOk; }
    // The component's state: the gain, then the preset name's bytes (what
    // no parameter sets)
    tresult PLUGIN_API setState (IBStream* stream) override
    {
        float gain = 1.0f;
        int32 read = 0;
        if (stream->read (&gain, sizeof (gain), &read) != kResultOk || read != sizeof (gain))
            return kResultFalse;
        char name[64] = {};
        read = 0;
        if (stream->read (name, sizeof (name) - 1, &read) == kResultOk && read > 0)
            presetName.assign (name, static_cast<size_t> (read));
        else
            presetName.clear();
       #if ! defined(TEST_VST3_SEPARATE_CONTROLLER)
        // A gain no parameter can set (they are normalised) is the tests'
        // cue: edit the gain from a thread of our own, as a plug-in's UI
        // would, through the host's handler
        if (gain == kEditStormGain)
        {
            stopEditStorm();
            editStorm = std::thread ([this]
            {
                for (int i = 0; i < kEditStormCount && componentHandler != nullptr; ++i)
                    componentHandler->performEdit (kGainId, (i % 100) / 100.0);
                state.hostTempo.store (1.0); // done
            });
            return kResultOk;
        }
       #endif
        state.gain.store (gain);
        return kResultOk;
    }
    tresult PLUGIN_API getState (IBStream* stream) override
    {
        auto gain = static_cast<float> (state.gain.load());
        if (stream->write (&gain, sizeof (gain), nullptr) != kResultOk)
            return kResultFalse;
        return presetName.empty() ? kResultOk : stream->write (presetName.data(), static_cast<int32> (presetName.size()), nullptr);
    }

    // IAudioProcessor
    tresult PLUGIN_API setBusArrangements (SpeakerArrangement* inputs, int32 numIns, SpeakerArrangement* outputs, int32 numOuts) override
    {
        return numIns == 1 && numOuts == 1 && inputs[0] == SpeakerArr::kStereo && outputs[0] == SpeakerArr::kStereo ? kResultTrue : kResultFalse;
    }
    tresult PLUGIN_API getBusArrangement (BusDirection, int32 index, SpeakerArrangement& arrangement) override
    {
        if (index != 0)
            return kResultFalse;
        arrangement = SpeakerArr::kStereo;
        return kResultOk;
    }
    tresult PLUGIN_API canProcessSampleSize (int32 symbolicSampleSize) override { return symbolicSampleSize == kSample32 ? kResultTrue : kResultFalse; }
    uint32 PLUGIN_API getLatencySamples() override { return 0; }
    tresult PLUGIN_API setupProcessing (ProcessSetup& setup) override { sampleRate = setup.sampleRate; return kResultOk; }
    tresult PLUGIN_API setProcessing (TBool) override { return kResultOk; }
    tresult PLUGIN_API process (ProcessData& data) override
    {
        // Parameter changes for this block: the last point wins
        if (data.inputParameterChanges != nullptr)
        {
            for (int32 i = 0; i < data.inputParameterChanges->getParameterCount(); ++i)
            {
                auto* queue = data.inputParameterChanges->getParameterData (i);
                if (queue == nullptr || queue->getPointCount() == 0)
                    continue;
                int32 offset;
                ParamValue value;
                if (queue->getPoint (queue->getPointCount() - 1, offset, value) == kResultOk && queue->getParameterId() == kGainId)
                    state.gain.store (value);
            }
        }

        // The host's tempo, reported back through the output changes
        if (data.processContext != nullptr && (data.processContext->state & ProcessContext::kTempoValid) != 0 && data.outputParameterChanges != nullptr)
        {
            int32 index;
            if (auto* queue = data.outputParameterChanges->addParameterData (kHostTempoId, index))
                queue->addPoint (0, data.processContext->tempo / 1000.0, index);
        }

        if (data.numInputs < 1 || data.numOutputs < 1)
            return kResultOk;
        auto gain = static_cast<float> (state.gain.load());
        auto channels = data.inputs[0].numChannels < data.outputs[0].numChannels ? data.inputs[0].numChannels : data.outputs[0].numChannels;
        for (int32 ch = 0; ch < channels; ++ch)
        {
            auto* in = data.inputs[0].channelBuffers32[ch];
            auto* out = data.outputs[0].channelBuffers32[ch];
            if (in == nullptr || out == nullptr)
                continue;
            for (int32 i = 0; i < data.numSamples; ++i)
                out[i] = in[i] * gain;
        }
        return kResultOk;
    }
    uint32 PLUGIN_API getTailSamples() override { return kNoTail; }

    // IConnectionPoint
    tresult PLUGIN_API connect (IConnectionPoint* other) override { peer = other; return kResultOk; }
    tresult PLUGIN_API disconnect (IConnectionPoint*) override { peer = nullptr; return kResultOk; }
    tresult PLUGIN_API notify (IMessage*) override { return kResultOk; }

   #if ! defined(TEST_VST3_SEPARATE_CONTROLLER)
    // IEditController (the single-component effect)
    tresult PLUGIN_API setComponentState (IBStream*) override { return kResultOk; }
    int32 PLUGIN_API getParameterCount() override { return controller.parameterCount(); }
    tresult PLUGIN_API getParameterInfo (int32 index, ParameterInfo& info) override { return controller.parameterInfo (index, info); }
    tresult PLUGIN_API getParamStringByValue (ParamID id, ParamValue value, String128 string) override { return controller.stringByValue (id, value, string); }
    tresult PLUGIN_API getParamValueByString (ParamID, TChar*, ParamValue&) override { return kResultFalse; }
    ParamValue PLUGIN_API normalizedParamToPlain (ParamID id, ParamValue value) override { return id == kHostTempoId ? value * 1000.0 : value; }
    ParamValue PLUGIN_API plainParamToNormalized (ParamID id, ParamValue value) override { return id == kHostTempoId ? value / 1000.0 : value; }
    ParamValue PLUGIN_API getParamNormalized (ParamID id) override { return controller.normalized (id); }
    tresult PLUGIN_API setParamNormalized (ParamID id, ParamValue value) override { return controller.setNormalized (id, value); }
    tresult PLUGIN_API setComponentHandler (IComponentHandler* handler) override { componentHandler = handler; return kResultOk; }
    IPlugView* PLUGIN_API createView (FIDString) override { return nullptr; }
   #endif

private:
    GainState state;
    ControllerPart controller;
    bool active = false;
    double sampleRate = 0.0;
    IConnectionPoint* peer = nullptr;
    std::string presetName;
   #if ! defined(TEST_VST3_SEPARATE_CONTROLLER)
    IComponentHandler* componentHandler = nullptr;
    std::thread editStorm;
    void stopEditStorm()
    {
        if (editStorm.joinable())
            editStorm.join();
    }
    ~GainComponent() override { stopEditStorm(); }
   #endif
};

#if defined(TEST_VST3_SEPARATE_CONTROLLER)
class GainController : public Object<IEditController, IConnectionPoint>
{
public:
    GainController()
    {
        expose<IEditController> (this);
        expose<IPluginBase> (static_cast<IEditController*> (this));
        expose<IConnectionPoint> (this);
        controller.state = &state;
    }

    tresult PLUGIN_API initialize (FUnknown* context) override { return context != nullptr ? kResultOk : kResultFalse; }
    tresult PLUGIN_API terminate() override { return kResultOk; }

    // The component's state comes in as the host loads it: the gain
    tresult PLUGIN_API setComponentState (IBStream* stream) override
    {
        float gain = 1.0f;
        int32 read = 0;
        if (stream->read (&gain, sizeof (gain), &read) == kResultOk && read == sizeof (gain))
            state.gain.store (gain);
        return kResultOk;
    }
    // The controller's own state: a note (a view setting, say) the
    // component never sees
    tresult PLUGIN_API setState (IBStream* stream) override
    {
        char text[64] = {};
        int32 read = 0;
        note = stream->read (text, sizeof (text) - 1, &read) == kResultOk && read > 0 ? std::string (text, static_cast<size_t> (read)) : std::string();
        return kResultOk;
    }
    tresult PLUGIN_API getState (IBStream* stream) override
    {
        return note.empty() ? kResultOk : stream->write (note.data(), static_cast<int32> (note.size()), nullptr);
    }
    int32 PLUGIN_API getParameterCount() override { return controller.parameterCount(); }
    tresult PLUGIN_API getParameterInfo (int32 index, ParameterInfo& info) override { return controller.parameterInfo (index, info); }
    tresult PLUGIN_API getParamStringByValue (ParamID id, ParamValue value, String128 string) override { return controller.stringByValue (id, value, string); }
    tresult PLUGIN_API getParamValueByString (ParamID, TChar*, ParamValue&) override { return kResultFalse; }
    ParamValue PLUGIN_API normalizedParamToPlain (ParamID id, ParamValue value) override { return id == kHostTempoId ? value * 1000.0 : value; }
    ParamValue PLUGIN_API plainParamToNormalized (ParamID id, ParamValue value) override { return id == kHostTempoId ? value / 1000.0 : value; }
    ParamValue PLUGIN_API getParamNormalized (ParamID id) override { return controller.normalized (id); }
    tresult PLUGIN_API setParamNormalized (ParamID id, ParamValue value) override { return controller.setNormalized (id, value); }
    tresult PLUGIN_API setComponentHandler (IComponentHandler* handler) override { componentHandler = handler; return kResultOk; }
    IPlugView* PLUGIN_API createView (FIDString) override { return nullptr; }

    tresult PLUGIN_API connect (IConnectionPoint* other) override { peer = other; return kResultOk; }
    tresult PLUGIN_API disconnect (IConnectionPoint*) override { peer = nullptr; return kResultOk; }
    tresult PLUGIN_API notify (IMessage*) override { return kResultOk; }

private:
    GainState state;
    ControllerPart controller;
    std::string note;
    IComponentHandler* componentHandler = nullptr;
    IConnectionPoint* peer = nullptr;
};
#endif

class Factory : public Object<IPluginFactory2>
{
public:
    Factory()
    {
        expose<IPluginFactory2> (this);
        expose<IPluginFactory> (static_cast<IPluginFactory*> (this));
    }

    tresult PLUGIN_API getFactoryInfo (PFactoryInfo* info) override
    {
        *info = PFactoryInfo ("NoProd", "https://github.com/agentchieflou/noprod", "", PFactoryInfo::kUnicode);
        return kResultOk;
    }
    int32 PLUGIN_API countClasses() override
    {
       #if defined(TEST_VST3_SEPARATE_CONTROLLER)
        return 2;
       #else
        return 1;
       #endif
    }
    tresult PLUGIN_API getClassInfo (int32 index, PClassInfo* info) override
    {
        PClassInfo2 info2;
        if (getClassInfo2 (index, &info2) != kResultOk)
            return kResultFalse;
        *info = PClassInfo (info2.cid, info2.cardinality, info2.category, info2.name);
        return kResultOk;
    }
    tresult PLUGIN_API getClassInfo2 (int32 index, PClassInfo2* info) override
    {
        if (index == 0)
        {
            *info = PClassInfo2 (kComponentUid, PClassInfo::kManyInstances, kVstAudioEffectClass, kPluginName, kSimpleModeSupported,
                                 PlugType::kFxTools, "NoProd", "1.0.0", kVstVersionString);
            return kResultOk;
        }
       #if defined(TEST_VST3_SEPARATE_CONTROLLER)
        if (index == 1)
        {
            *info = PClassInfo2 (kControllerUid, PClassInfo::kManyInstances, kVstComponentControllerClass, "NoProd Test Gain Controller", 0,
                                 "", "NoProd", "1.0.0", kVstVersionString);
            return kResultOk;
        }
       #endif
        return kResultFalse;
    }
    tresult PLUGIN_API createInstance (FIDString cid, FIDString _iid, void** obj) override
    {
        if (FUnknownPrivate::iidEqual (cid, kComponentUid))
        {
            auto* component = new GainComponent();
            auto result = component->queryInterface (_iid, obj);
            component->release();
            return result;
        }
       #if defined(TEST_VST3_SEPARATE_CONTROLLER)
        if (FUnknownPrivate::iidEqual (cid, kControllerUid))
        {
            auto* controller = new GainController();
            auto result = controller->queryInterface (_iid, obj);
            controller->release();
            return result;
        }
       #endif
        *obj = nullptr;
        return kNoInterface;
    }
};

} // namespace

// The module's exports: the entry and exit functions each platform's
// bundle format names, and the factory. The module keeps its one factory
// from the first GetPluginFactory until its exit function, when the host
// is done with it.
Factory* moduleFactory = nullptr;

bool moduleExit()
{
    if (moduleFactory != nullptr)
        moduleFactory->release();
    moduleFactory = nullptr;
    return true;
}

extern "C"
{
#if defined(_WIN32)
__declspec (dllexport) bool InitDll() { return true; }
__declspec (dllexport) bool ExitDll() { return moduleExit(); }
#elif defined(__APPLE__)
__attribute__ ((visibility ("default"))) bool bundleEntry (void*) { return true; }
__attribute__ ((visibility ("default"))) bool bundleExit() { return moduleExit(); }
#else
__attribute__ ((visibility ("default"))) bool ModuleEntry (void*) { return true; }
__attribute__ ((visibility ("default"))) bool ModuleExit() { return moduleExit(); }
#endif

SMTG_EXPORT_SYMBOL IPluginFactory* PLUGIN_API GetPluginFactory()
{
    if (moduleFactory == nullptr)
        moduleFactory = new Factory(); // the module's own reference
    moduleFactory->addRef();
    return moduleFactory;
}
}
