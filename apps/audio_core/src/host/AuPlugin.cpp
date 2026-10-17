#include "AuPlugin.h"

#if GHOSTDAW_MAC

#include "../platform/Log.h"
#include "../platform/Strings.h"
#include "Dsp.h"

#include <AudioToolbox/AudioToolbox.h>
#include <CoreFoundation/CoreFoundation.h>

#include <algorithm>
#include <atomic>
#include <cmath>
#include <cstdio>
#include <cstring>

namespace ghostdaw
{

namespace
{

std::string cfStringToUtf8 (CFStringRef text)
{
    if (text == nullptr)
        return {};
    if (auto* direct = CFStringGetCStringPtr (text, kCFStringEncodingUTF8))
        return direct;
    auto length = CFStringGetLength (text);
    auto capacity = CFStringGetMaximumSizeForEncoding (length, kCFStringEncodingUTF8) + 1;
    std::string out (static_cast<size_t> (capacity), '\0');
    if (! CFStringGetCString (text, out.data(), capacity, kCFStringEncodingUTF8))
        return {};
    out.resize (std::strlen (out.c_str()));
    return out;
}

// A four-character code as text, or 0x and 8 hex digits when it isn't printable
std::string codeToText (OSType code)
{
    std::string text;
    for (int shift = 24; shift >= 0; shift -= 8)
        text += static_cast<char> ((code >> shift) & 0xFF);
    for (auto c : text)
    {
        if (c < 0x21 || c > 0x7E || c == ':')
        {
            char hex[12];
            std::snprintf (hex, sizeof (hex), "0x%08X", static_cast<unsigned> (code));
            return hex;
        }
    }
    return text;
}

bool textToCode (const std::string& text, OSType& code)
{
    if (text.size() == 4)
    {
        code = 0;
        for (auto c : text)
            code = (code << 8) | static_cast<unsigned char> (c);
        return true;
    }
    if (text.size() == 10 && startsWith (text, "0x") && containsOnly (text.substr (2), "0123456789ABCDEFabcdef"))
    {
        code = static_cast<OSType> (std::stoul (text.substr (2), nullptr, 16));
        return true;
    }
    return false;
}

std::string pluginIdFor (const AudioComponentDescription& desc)
{
    return "au:" + codeToText (desc.componentType) + ":" + codeToText (desc.componentSubType) + ":" + codeToText (desc.componentManufacturer);
}

bool parsePluginId (const std::string& pluginId, AudioComponentDescription& desc)
{
    auto parts = split (pluginId, ':');
    if (parts.size() != 4 || parts[0] != "au")
        return false;
    desc = {};
    return textToCode (parts[1], desc.componentType) && textToCode (parts[2], desc.componentSubType) && textToCode (parts[3], desc.componentManufacturer);
}

// "Apple: AUDelay" -> vendor and name
void splitComponentName (const std::string& full, std::string& vendor, std::string& name)
{
    auto colon = full.find (": ");
    if (colon == std::string::npos)
    {
        vendor.clear();
        name = trim (full);
        return;
    }
    vendor = trim (full.substr (0, colon));
    name = trim (full.substr (colon + 2));
}

AuComponentInfo describe (AudioComponent component, const AudioComponentDescription& desc)
{
    AuComponentInfo info;
    info.pluginId = pluginIdFor (desc);
    CFStringRef cfName = nullptr;
    if (AudioComponentCopyName (component, &cfName) == noErr && cfName != nullptr)
    {
        splitComponentName (cfStringToUtf8 (cfName), info.vendor, info.name);
        CFRelease (cfName);
    }
    if (info.name.empty())
        info.name = info.pluginId;
    return info;
}

const char* unitSuffix (AudioUnitParameterUnit unit)
{
    switch (unit)
    {
        case kAudioUnitParameterUnit_Percent: return " %";
        case kAudioUnitParameterUnit_Seconds: return " s";
        case kAudioUnitParameterUnit_SampleFrames: return " samples";
        case kAudioUnitParameterUnit_Phase: return " °";
        case kAudioUnitParameterUnit_Hertz: return " Hz";
        case kAudioUnitParameterUnit_Cents: return " cents";
        case kAudioUnitParameterUnit_RelativeSemiTones: return " st";
        case kAudioUnitParameterUnit_Decibels: return " dB";
        case kAudioUnitParameterUnit_Degrees: return " °";
        case kAudioUnitParameterUnit_Meters: return " m";
        case kAudioUnitParameterUnit_AbsoluteCents: return " cents";
        case kAudioUnitParameterUnit_Octaves: return " oct";
        case kAudioUnitParameterUnit_BPM: return " bpm";
        case kAudioUnitParameterUnit_Beats: return " beats";
        case kAudioUnitParameterUnit_Milliseconds: return " ms";
        case kAudioUnitParameterUnit_Ratio: return ":1";
        default: return "";
    }
}

} // namespace

std::vector<AuComponentInfo> listAudioUnits()
{
    std::vector<AuComponentInfo> result;
    for (auto type : { kAudioUnitType_Effect, kAudioUnitType_MusicEffect })
    {
        AudioComponentDescription wanted = {};
        wanted.componentType = type;
        for (auto* component = AudioComponentFindNext (nullptr, &wanted); component != nullptr; component = AudioComponentFindNext (component, &wanted))
        {
            AudioComponentDescription desc = {};
            if (AudioComponentGetDescription (component, &desc) != noErr)
                continue;
            // Units that only instantiate asynchronously (out-of-process
            // version 3 extensions) are not hosted yet
            if ((desc.componentFlags & kAudioComponentFlag_RequiresAsyncInstantiation) != 0)
                continue;
            result.push_back (describe (component, desc));
        }
    }
    return result;
}

Json describeAudioUnits()
{
    auto plugins = Json::array();
    for (auto& unit : listAudioUnits())
        plugins.push (Json::object ({ { "pluginId", unit.pluginId }, { "name", unit.name }, { "vendor", unit.vendor }, { "format", "AU" } }));
    return Json::object ({ { "plugins", plugins } });
}

// ------------------------------------------------------------ the insert

struct AuInsert::Impl
{
    AudioComponentDescription desc = {};
    AudioUnit unit = nullptr;
    AuComponentInfo info;

    struct Parameter
    {
        AudioUnitParameterID id = 0;
        PluginParameterInfo info;
        AudioUnitParameterUnit unit = kAudioUnitParameterUnit_Generic;
        std::string customUnit;
        bool hasStrings = false; // kAudioUnitParameterFlag_ValuesHaveStrings
        float minValue = 0.0f, maxValue = 1.0f;
    };
    std::vector<Parameter> parameters;

    double sampleRate = 0.0;
    int maxBlockSize = 0;
    bool initialized = false;
    std::atomic<int> latency { 0 };
    std::atomic<bool> latencyMayHaveChanged { false };

    // The audio thread's view of the block being rendered
    static constexpr int channels = 2;
    AudioBuffer scratchIn { channels, 0 };
    std::vector<uint8_t> inputListStorage, outputListStorage;
    AudioBufferList* inputList = nullptr;
    AudioBufferList* outputList = nullptr;
    double sampleTime = 0.0; // frames rendered so far, the time stamp
    TransportInfo transport;
    bool transportKnown = false;
    bool wasPlaying = false;

    static AudioBufferList* makeList (std::vector<uint8_t>& storage)
    {
        storage.assign (sizeof (AudioBufferList) + static_cast<size_t> (channels) * sizeof (::AudioBuffer), 0);
        auto* list = reinterpret_cast<AudioBufferList*> (storage.data());
        list->mNumberBuffers = channels;
        return list;
    }

    // The unit pulls its input from here, during AudioUnitRender
    static OSStatus inputProc (void* refCon, AudioUnitRenderActionFlags*, const AudioTimeStamp*, UInt32, UInt32 frames, AudioBufferList* ioData)
    {
        auto& self = *static_cast<Impl*> (refCon);
        if (ioData == nullptr)
            return noErr;
        auto count = std::min (static_cast<int> (frames), self.scratchIn.getNumSamples());
        for (UInt32 i = 0; i < ioData->mNumberBuffers; ++i)
        {
            auto& buffer = ioData->mBuffers[i];
            auto ch = std::min (static_cast<int> (i), channels - 1);
            auto* source = self.scratchIn.getReadPointer (ch);
            if (buffer.mData == nullptr)
            {
                buffer.mData = const_cast<float*> (source);
                buffer.mDataByteSize = static_cast<UInt32> (count) * sizeof (float);
            }
            else
            {
                auto bytes = std::min (buffer.mDataByteSize, static_cast<UInt32> (count) * static_cast<UInt32> (sizeof (float)));
                std::memcpy (buffer.mData, source, bytes);
            }
        }
        return noErr;
    }

    // The host callbacks: the transport, as the chain last set it
    static OSStatus beatAndTempo (void* userData, Float64* outBeat, Float64* outTempo)
    {
        auto& self = *static_cast<Impl*> (userData);
        if (! self.transportKnown)
            return kAudioUnitErr_CannotDoInCurrentContext;
        auto& t = self.transport;
        if (outBeat != nullptr)
        {
            if ((t.flags & TransportInfo::ppqValid) == 0)
                return kAudioUnitErr_CannotDoInCurrentContext;
            *outBeat = t.ppqPosition;
        }
        if (outTempo != nullptr)
        {
            if ((t.flags & TransportInfo::tempoValid) == 0)
                return kAudioUnitErr_CannotDoInCurrentContext;
            *outTempo = t.tempoBpm;
        }
        return noErr;
    }

    static OSStatus musicalTimeLocation (void* userData, UInt32* outDeltaSampleOffsetToNextBeat, Float32* outTimeSigNumerator, UInt32* outTimeSigDenominator, Float64* outCurrentMeasureDownBeat)
    {
        auto& self = *static_cast<Impl*> (userData);
        auto& t = self.transport;
        if (! self.transportKnown || (t.flags & TransportInfo::ppqValid) == 0)
            return kAudioUnitErr_CannotDoInCurrentContext;
        if (outTimeSigNumerator != nullptr)
            *outTimeSigNumerator = 4.0f; // the stream's transport carries no time signature yet
        if (outTimeSigDenominator != nullptr)
            *outTimeSigDenominator = 4;
        if (outCurrentMeasureDownBeat != nullptr)
            *outCurrentMeasureDownBeat = std::floor (t.ppqPosition / 4.0) * 4.0;
        if (outDeltaSampleOffsetToNextBeat != nullptr)
        {
            if ((t.flags & TransportInfo::tempoValid) == 0 || t.tempoBpm <= 0.0)
                return kAudioUnitErr_CannotDoInCurrentContext;
            auto samplesPerBeat = self.sampleRate * 60.0 / t.tempoBpm;
            auto fraction = t.ppqPosition - std::floor (t.ppqPosition);
            *outDeltaSampleOffsetToNextBeat = static_cast<UInt32> (std::lround ((1.0 - fraction) * samplesPerBeat));
        }
        return noErr;
    }

    static OSStatus transportState (void* userData, Boolean* outIsPlaying, Boolean* outTransportStateChanged, Float64* outCurrentSampleInTimeLine,
                                    Boolean* outIsCycling, Float64* outCycleStartBeat, Float64* outCycleEndBeat)
    {
        auto& self = *static_cast<Impl*> (userData);
        if (! self.transportKnown)
            return kAudioUnitErr_CannotDoInCurrentContext;
        auto& t = self.transport;
        auto playing = (t.flags & TransportInfo::playing) != 0;
        if (outIsPlaying != nullptr)
            *outIsPlaying = playing;
        if (outTransportStateChanged != nullptr)
            *outTransportStateChanged = playing != self.wasPlaying;
        self.wasPlaying = playing;
        if (outCurrentSampleInTimeLine != nullptr)
        {
            if ((t.flags & TransportInfo::ppqValid) != 0 && (t.flags & TransportInfo::tempoValid) != 0 && t.tempoBpm > 0.0)
                *outCurrentSampleInTimeLine = t.ppqPosition * 60.0 / t.tempoBpm * self.sampleRate;
            else
                *outCurrentSampleInTimeLine = self.sampleTime;
        }
        if (outIsCycling != nullptr)
            *outIsCycling = (t.flags & TransportInfo::looping) != 0;
        if (outCycleStartBeat != nullptr)
            *outCycleStartBeat = 0.0;
        if (outCycleEndBeat != nullptr)
            *outCycleEndBeat = 0.0;
        return noErr;
    }

    static void latencyChanged (void* userData, AudioUnit, AudioUnitPropertyID, AudioUnitScope, AudioUnitElement)
    {
        static_cast<Impl*> (userData)->latencyMayHaveChanged.store (true);
    }

    int readLatency() const
    {
        Float64 seconds = 0.0;
        UInt32 size = sizeof (seconds);
        if (AudioUnitGetProperty (unit, kAudioUnitProperty_Latency, kAudioUnitScope_Global, 0, &seconds, &size) != noErr || ! (seconds > 0.0))
            return 0;
        return static_cast<int> (std::lround (seconds * sampleRate));
    }

    bool readParameters (std::string& error)
    {
        parameters.clear();
        UInt32 size = 0;
        Boolean writable = false;
        auto status = AudioUnitGetPropertyInfo (unit, kAudioUnitProperty_ParameterList, kAudioUnitScope_Global, 0, &size, &writable);
        if (status != noErr && status != kAudioUnitErr_InvalidProperty)
        {
            error = "its parameter list could not be read (" + std::to_string (status) + ")";
            return false;
        }
        std::vector<AudioUnitParameterID> ids (size / sizeof (AudioUnitParameterID));
        if (! ids.empty() && AudioUnitGetProperty (unit, kAudioUnitProperty_ParameterList, kAudioUnitScope_Global, 0, ids.data(), &size) != noErr)
        {
            error = "its parameter list could not be read";
            return false;
        }
        ids.resize (size / sizeof (AudioUnitParameterID));

        for (auto id : ids)
        {
            AudioUnitParameterInfo info = {};
            UInt32 infoSize = sizeof (info);
            if (AudioUnitGetProperty (unit, kAudioUnitProperty_ParameterInfo, kAudioUnitScope_Global, id, &info, &infoSize) != noErr)
                continue;
            Parameter p;
            p.id = id;
            p.info.index = static_cast<int> (parameters.size());
            p.info.id = std::to_string (id);
            if ((info.flags & kAudioUnitParameterFlag_HasCFNameString) != 0 && info.cfNameString != nullptr)
            {
                p.info.name = cfStringToUtf8 (info.cfNameString);
                if ((info.flags & kAudioUnitParameterFlag_CFNameRelease) != 0)
                    CFRelease (info.cfNameString);
            }
            if (p.info.name.empty())
                p.info.name = std::string (info.name, strnlen (info.name, sizeof (info.name)));
            if (p.info.name.empty())
                p.info.name = "Parameter " + std::to_string (id);
            p.unit = info.unit;
            if (info.unit == kAudioUnitParameterUnit_CustomUnit && info.unitName != nullptr)
                p.customUnit = " " + cfStringToUtf8 (info.unitName);
            p.hasStrings = (info.flags & kAudioUnitParameterFlag_ValuesHaveStrings) != 0;
            p.minValue = info.minValue;
            p.maxValue = info.maxValue > info.minValue ? info.maxValue : info.minValue + 1.0f;
            p.info.minValue = 0.0f;
            p.info.maxValue = 1.0f;
            p.info.defaultValue = normalize (p, info.defaultValue);
            p.info.stepped = info.unit == kAudioUnitParameterUnit_Indexed || info.unit == kAudioUnitParameterUnit_Boolean;
            p.info.boolean = info.unit == kAudioUnitParameterUnit_Boolean;
            p.info.readOnly = (info.flags & kAudioUnitParameterFlag_IsWritable) == 0;
            parameters.push_back (std::move (p));
        }
        return true;
    }

    static float normalize (const Parameter& p, float value)
    {
        return std::clamp ((value - p.minValue) / (p.maxValue - p.minValue), 0.0f, 1.0f);
    }

    static float denormalize (const Parameter& p, float normalized)
    {
        return p.minValue + std::clamp (normalized, 0.0f, 1.0f) * (p.maxValue - p.minValue);
    }

    float plainValue (const Parameter& p) const
    {
        AudioUnitParameterValue value = 0.0f;
        if (AudioUnitGetParameter (unit, p.id, kAudioUnitScope_Global, 0, &value) != noErr)
            return p.minValue;
        return value;
    }

    bool setFormat (AudioUnitScope scope)
    {
        AudioStreamBasicDescription format = {};
        format.mSampleRate = sampleRate;
        format.mFormatID = kAudioFormatLinearPCM;
        format.mFormatFlags = kAudioFormatFlagsNativeFloatPacked | kAudioFormatFlagIsNonInterleaved;
        format.mBytesPerPacket = sizeof (float);
        format.mFramesPerPacket = 1;
        format.mBytesPerFrame = sizeof (float);
        format.mChannelsPerFrame = channels;
        format.mBitsPerChannel = 32;
        return AudioUnitSetProperty (unit, kAudioUnitProperty_StreamFormat, scope, 0, &format, sizeof (format)) == noErr;
    }

    void teardown()
    {
        if (unit != nullptr)
        {
            AudioUnitRemovePropertyListenerWithUserData (unit, kAudioUnitProperty_Latency, latencyChanged, this);
            if (initialized)
                AudioUnitUninitialize (unit);
            AudioComponentInstanceDispose (unit);
        }
        unit = nullptr;
        initialized = false;
    }
};

std::unique_ptr<AuInsert> AuInsert::create (const std::string& pluginId, std::string& error)
{
    AudioComponentDescription desc = {};
    if (! parsePluginId (pluginId, desc))
    {
        error = "'" + pluginId + "' is not an Audio Unit id (au:<type>:<subtype>:<manufacturer>)";
        return nullptr;
    }
    auto* component = AudioComponentFindNext (nullptr, &desc);
    if (component == nullptr)
    {
        error = "No Audio Unit " + pluginId + " on this system";
        return nullptr;
    }

    auto insert = std::unique_ptr<AuInsert> (new AuInsert());
    insert->instance = std::make_unique<Impl>();
    auto& impl = *insert->instance;
    impl.desc = desc;
    impl.info = describe (component, desc);

    auto status = AudioComponentInstanceNew (component, &impl.unit);
    if (status != noErr || impl.unit == nullptr)
    {
        error = impl.info.name + ": the unit could not be created (" + std::to_string (status) + ")";
        impl.teardown();
        return nullptr;
    }
    if (! impl.readParameters (error))
    {
        error = impl.info.name + ": " + error;
        impl.teardown();
        return nullptr;
    }
    AudioUnitAddPropertyListener (impl.unit, kAudioUnitProperty_Latency, Impl::latencyChanged, &impl);
    return insert;
}

AuInsert::~AuInsert()
{
    if (instance != nullptr)
        instance->teardown();
}

std::string AuInsert::getName() const { return instance->info.name; }
std::string AuInsert::getPath() const { return instance->info.pluginId; }
std::string AuInsert::getPluginId() const { return instance->info.pluginId; }
int AuInsert::getLatencySamples() const { return instance->latency.load(); }

bool AuInsert::prepare (double sampleRate, int maxBlockSize, std::string& error)
{
    auto& impl = *instance;
    if (impl.initialized && sampleRate == impl.sampleRate && maxBlockSize == impl.maxBlockSize)
        return true;
    if (impl.initialized)
        AudioUnitUninitialize (impl.unit);
    impl.initialized = false;
    impl.sampleRate = sampleRate;
    impl.maxBlockSize = maxBlockSize;

    if (! impl.setFormat (kAudioUnitScope_Input) || ! impl.setFormat (kAudioUnitScope_Output))
    {
        error = impl.info.name + " does not take stereo 32-bit float audio";
        return false;
    }
    auto maxFrames = static_cast<UInt32> (maxBlockSize);
    AudioUnitSetProperty (impl.unit, kAudioUnitProperty_MaximumFramesPerSlice, kAudioUnitScope_Global, 0, &maxFrames, sizeof (maxFrames));

    AURenderCallbackStruct input = { Impl::inputProc, &impl };
    if (AudioUnitSetProperty (impl.unit, kAudioUnitProperty_SetRenderCallback, kAudioUnitScope_Input, 0, &input, sizeof (input)) != noErr)
    {
        error = impl.info.name + " takes no input callback";
        return false;
    }
    HostCallbackInfo callbacks = { &impl, Impl::beatAndTempo, Impl::musicalTimeLocation, Impl::transportState, nullptr };
    AudioUnitSetProperty (impl.unit, kAudioUnitProperty_HostCallbacks, kAudioUnitScope_Global, 0, &callbacks, sizeof (callbacks));

    impl.scratchIn.setSize (Impl::channels, maxBlockSize);
    impl.inputList = Impl::makeList (impl.inputListStorage);
    impl.outputList = Impl::makeList (impl.outputListStorage);

    auto status = AudioUnitInitialize (impl.unit);
    if (status != noErr)
    {
        error = impl.info.name + ": AudioUnitInitialize failed (" + std::to_string (status) + ")";
        return false;
    }
    impl.initialized = true;
    impl.sampleTime = 0.0;
    impl.latency.store (impl.readLatency());
    impl.latencyMayHaveChanged.store (false);
    return true;
}

void AuInsert::setTransport (const TransportInfo& transport) noexcept
{
    instance->transport = transport;
    instance->transportKnown = true;
}

void AuInsert::process (const float* const* inputs, float* const* outputs, int numChannels, int numSamples) noexcept
{
    auto& impl = *instance;
    if (! impl.initialized || numSamples > impl.maxBlockSize || numChannels < 1)
        return; // outputs already hold the dry signal

    auto inChannels = std::min (numChannels, Impl::channels);
    for (int ch = 0; ch < Impl::channels; ++ch)
        dsp::copy (impl.scratchIn.getWritePointer (ch), inputs[std::min (ch, inChannels - 1)], numSamples);

    // Rendered straight into the chain's output buffers (a mono chain gets
    // the left channel; the unit picks its own buffer for the other)
    float* targets[Impl::channels];
    for (int ch = 0; ch < Impl::channels; ++ch)
    {
        auto& buffer = impl.outputList->mBuffers[ch];
        buffer.mNumberChannels = 1;
        buffer.mDataByteSize = static_cast<UInt32> (numSamples) * sizeof (float);
        targets[ch] = ch < numChannels ? outputs[ch] : nullptr;
        buffer.mData = targets[ch];
    }

    AudioTimeStamp stamp = {};
    stamp.mSampleTime = impl.sampleTime;
    stamp.mFlags = kAudioTimeStampSampleTimeValid;
    AudioUnitRenderActionFlags flags = 0;
    auto status = AudioUnitRender (impl.unit, &flags, &stamp, 0, static_cast<UInt32> (numSamples), impl.outputList);
    impl.sampleTime += numSamples;
    if (status != noErr)
    {
        for (int ch = 0; ch < inChannels; ++ch)
            dsp::copy (outputs[ch], inputs[ch], numSamples); // the unit refused the block: dry
        return;
    }
    // A unit may render into its own buffers instead of ours
    for (int ch = 0; ch < Impl::channels; ++ch)
    {
        auto& buffer = impl.outputList->mBuffers[ch];
        if (targets[ch] != nullptr && buffer.mData != nullptr && buffer.mData != targets[ch])
            std::memcpy (targets[ch], buffer.mData, std::min (buffer.mDataByteSize, static_cast<UInt32> (numSamples) * static_cast<UInt32> (sizeof (float))));
    }
}

std::vector<PluginParameterInfo> AuInsert::getParameters()
{
    std::vector<PluginParameterInfo> result;
    for (auto& p : instance->parameters)
        result.push_back (p.info);
    return result;
}

float AuInsert::getParameterValue (int index)
{
    auto& impl = *instance;
    if (index < 0 || static_cast<size_t> (index) >= impl.parameters.size())
        return 0.0f;
    auto& p = impl.parameters[static_cast<size_t> (index)];
    return Impl::normalize (p, impl.plainValue (p));
}

std::string AuInsert::getParameterText (int index)
{
    auto& impl = *instance;
    if (index < 0 || static_cast<size_t> (index) >= impl.parameters.size())
        return {};
    auto& p = impl.parameters[static_cast<size_t> (index)];
    auto value = impl.plainValue (p);

    if (p.hasStrings)
    {
        AudioUnitParameterStringFromValue request = { p.id, &value, nullptr };
        UInt32 size = sizeof (request);
        if (AudioUnitGetProperty (impl.unit, kAudioUnitProperty_ParameterStringFromValue, kAudioUnitScope_Global, 0, &request, &size) == noErr && request.outString != nullptr)
        {
            auto text = cfStringToUtf8 (request.outString);
            CFRelease (request.outString);
            return text;
        }
    }
    if (p.unit == kAudioUnitParameterUnit_Indexed)
    {
        CFArrayRef strings = nullptr;
        UInt32 size = sizeof (strings);
        if (AudioUnitGetProperty (impl.unit, kAudioUnitProperty_ParameterValueStrings, kAudioUnitScope_Global, p.id, &strings, &size) == noErr && strings != nullptr)
        {
            auto index2 = static_cast<CFIndex> (std::lround (value - p.minValue));
            std::string text;
            if (index2 >= 0 && index2 < CFArrayGetCount (strings))
                text = cfStringToUtf8 (static_cast<CFStringRef> (CFArrayGetValueAtIndex (strings, index2)));
            CFRelease (strings);
            if (! text.empty())
                return text;
        }
    }
    if (p.unit == kAudioUnitParameterUnit_Boolean)
        return value >= 0.5f ? "On" : "Off";

    char text[64];
    std::snprintf (text, sizeof (text), "%.3g", static_cast<double> (value));
    return std::string (text) + (p.customUnit.empty() ? unitSuffix (p.unit) : p.customUnit.c_str());
}

bool AuInsert::setParameterValue (int index, float value)
{
    auto& impl = *instance;
    if (index < 0 || static_cast<size_t> (index) >= impl.parameters.size())
        return false;
    auto& p = impl.parameters[static_cast<size_t> (index)];
    if (p.info.readOnly)
        return false;
    return AudioUnitSetParameter (impl.unit, p.id, kAudioUnitScope_Global, 0, Impl::denormalize (p, value), 0) == noErr;
}

bool AuInsert::refreshLatency()
{
    auto& impl = *instance;
    if (! impl.initialized)
        return false;
    impl.latencyMayHaveChanged.store (false);
    auto now = impl.readLatency();
    if (now == impl.latency.load())
        return false;
    impl.latency.store (now);
    return true;
}

bool AuInsert::getState (std::vector<uint8_t>& out)
{
    auto& impl = *instance;
    CFPropertyListRef plist = nullptr;
    UInt32 size = sizeof (plist);
    if (AudioUnitGetProperty (impl.unit, kAudioUnitProperty_ClassInfo, kAudioUnitScope_Global, 0, &plist, &size) != noErr || plist == nullptr)
        return false;
    auto* data = CFPropertyListCreateData (kCFAllocatorDefault, plist, kCFPropertyListBinaryFormat_v1_0, 0, nullptr);
    CFRelease (plist);
    if (data == nullptr)
        return false;
    auto length = CFDataGetLength (data);
    out.assign (CFDataGetBytePtr (data), CFDataGetBytePtr (data) + length);
    CFRelease (data);
    return true;
}

bool AuInsert::setState (const std::vector<uint8_t>& bytes)
{
    auto& impl = *instance;
    auto* data = CFDataCreate (kCFAllocatorDefault, bytes.data(), static_cast<CFIndex> (bytes.size()));
    if (data == nullptr)
        return false;
    auto plist = CFPropertyListCreateWithData (kCFAllocatorDefault, data, kCFPropertyListImmutable, nullptr, nullptr);
    CFRelease (data);
    if (plist == nullptr)
        return false;
    auto ok = AudioUnitSetProperty (impl.unit, kAudioUnitProperty_ClassInfo, kAudioUnitScope_Global, 0, &plist, sizeof (plist)) == noErr;
    CFRelease (plist);
    return ok;
}

} // namespace ghostdaw

#endif
