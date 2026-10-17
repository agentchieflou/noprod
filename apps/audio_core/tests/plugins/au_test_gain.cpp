// An Audio Unit test effect for the host tests, registered in the test
// process with AudioComponentRegister (so no bundle has to be installed):
// a stereo gain ("Gain", id 0, 0..1, default 1) that also reports the
// tempo the host's beatAndTempo callback last gave in a read-only
// "Host tempo" parameter (id 1, 0..1000 bpm, so the normalized value is
// bpm / 1000). State is the gain, in the "data" of its class info.
//
// Written against AudioToolbox's component API alone: the plug-in
// interface is the Open/Close/Lookup table and the selectors' procs.

#include "platform/Platform.h"

#if GHOSTDAW_MAC

#include "au_test_gain.h"

#include <AudioToolbox/AudioToolbox.h>
#include <CoreFoundation/CoreFoundation.h>

#include <algorithm>
#include <cstring>
#include <vector>

namespace
{

constexpr AudioUnitParameterID kGainId = 0, kHostTempoId = 1;

constexpr OSType fourCC (const char (&text)[5])
{
    return (static_cast<OSType> (static_cast<unsigned char> (text[0])) << 24) | (static_cast<OSType> (static_cast<unsigned char> (text[1])) << 16)
         | (static_cast<OSType> (static_cast<unsigned char> (text[2])) << 8) | static_cast<OSType> (static_cast<unsigned char> (text[3]));
}

struct TestGainUnit
{
    AudioComponentPlugInInterface plugInInterface; // first, so `self` is the unit
    AudioComponentInstance instance = nullptr;
    AudioStreamBasicDescription inputFormat = {}, outputFormat = {};
    UInt32 maxFrames = 1156;
    bool initialized = false;
    AURenderCallbackStruct input = {};
    HostCallbackInfo hostCallbacks = {};
    float gain = 1.0f, hostTempo = 0.0f;
    std::vector<float> scratch[2];
    std::vector<uint8_t> inputListStorage;

    AudioBufferList* inputList() { return reinterpret_cast<AudioBufferList*> (inputListStorage.data()); }

    static bool formatOk (const AudioStreamBasicDescription& f)
    {
        return f.mFormatID == kAudioFormatLinearPCM && (f.mFormatFlags & kAudioFormatFlagIsFloat) != 0
            && (f.mFormatFlags & kAudioFormatFlagIsNonInterleaved) != 0 && f.mChannelsPerFrame == 2 && f.mBitsPerChannel == 32;
    }
};

TestGainUnit& unitOf (void* self) { return *static_cast<TestGainUnit*> (self); }

OSStatus open (void* self, AudioComponentInstance instance)
{
    unitOf (self).instance = instance;
    return noErr;
}

OSStatus close (void* self)
{
    delete &unitOf (self);
    return noErr;
}

OSStatus initialize (void* self)
{
    auto& unit = unitOf (self);
    if (! TestGainUnit::formatOk (unit.inputFormat) || ! TestGainUnit::formatOk (unit.outputFormat))
        return kAudioUnitErr_FormatNotSupported;
    for (auto& channel : unit.scratch)
        channel.assign (unit.maxFrames, 0.0f);
    unit.inputListStorage.assign (sizeof (AudioBufferList) + 2 * sizeof (AudioBuffer), 0);
    unit.inputList()->mNumberBuffers = 2;
    unit.initialized = true;
    return noErr;
}

OSStatus uninitialize (void* self)
{
    unitOf (self).initialized = false;
    return noErr;
}

OSStatus getPropertyInfo (void* self, AudioUnitPropertyID id, AudioUnitScope scope, AudioUnitElement element, UInt32* outSize, Boolean* outWritable)
{
    auto& unit = unitOf (self);
    UInt32 size = 0;
    Boolean writable = false;
    switch (id)
    {
        case kAudioUnitProperty_StreamFormat:
            if (scope != kAudioUnitScope_Input && scope != kAudioUnitScope_Output) return kAudioUnitErr_InvalidScope;
            if (element != 0) return kAudioUnitErr_InvalidElement;
            size = sizeof (AudioStreamBasicDescription);
            writable = ! unit.initialized;
            break;
        case kAudioUnitProperty_ElementCount:
            size = sizeof (UInt32);
            break;
        case kAudioUnitProperty_MaximumFramesPerSlice:
            size = sizeof (UInt32);
            writable = ! unit.initialized;
            break;
        case kAudioUnitProperty_SetRenderCallback:
            if (scope != kAudioUnitScope_Input) return kAudioUnitErr_InvalidScope;
            size = sizeof (AURenderCallbackStruct);
            writable = true;
            break;
        case kAudioUnitProperty_HostCallbacks:
            size = sizeof (HostCallbackInfo);
            writable = true;
            break;
        case kAudioUnitProperty_ParameterList:
            if (scope != kAudioUnitScope_Global) return kAudioUnitErr_InvalidScope;
            size = 2 * sizeof (AudioUnitParameterID);
            break;
        case kAudioUnitProperty_ParameterInfo:
            if (scope != kAudioUnitScope_Global) return kAudioUnitErr_InvalidScope;
            if (element > kHostTempoId) return kAudioUnitErr_InvalidParameter;
            size = sizeof (AudioUnitParameterInfo);
            break;
        case kAudioUnitProperty_ParameterStringFromValue:
            size = sizeof (AudioUnitParameterStringFromValue);
            break;
        case kAudioUnitProperty_Latency:
            size = sizeof (Float64);
            break;
        case kAudioUnitProperty_ClassInfo:
            size = sizeof (CFPropertyListRef);
            writable = true;
            break;
        default:
            return kAudioUnitErr_InvalidProperty;
    }
    if (outSize != nullptr)
        *outSize = size;
    if (outWritable != nullptr)
        *outWritable = writable;
    return noErr;
}

CFDictionaryRef makeClassInfo (const TestGainUnit& unit)
{
    auto* dict = CFDictionaryCreateMutable (kCFAllocatorDefault, 0, &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks);
    SInt32 version = 0;
    auto* versionNumber = CFNumberCreate (kCFAllocatorDefault, kCFNumberSInt32Type, &version);
    CFDictionarySetValue (dict, CFSTR (kAUPresetVersionKey), versionNumber);
    CFRelease (versionNumber);
    CFDictionarySetValue (dict, CFSTR (kAUPresetNameKey), CFSTR ("gain"));
    auto* data = CFDataCreate (kCFAllocatorDefault, reinterpret_cast<const UInt8*> (&unit.gain), sizeof (unit.gain));
    CFDictionarySetValue (dict, CFSTR (kAUPresetDataKey), data);
    CFRelease (data);
    return dict;
}

OSStatus getProperty (void* self, AudioUnitPropertyID id, AudioUnitScope scope, AudioUnitElement element, void* outData, UInt32* ioSize)
{
    auto& unit = unitOf (self);
    UInt32 size = 0;
    if (auto status = getPropertyInfo (self, id, scope, element, &size, nullptr))
        return status;
    if (outData == nullptr || ioSize == nullptr || *ioSize < size)
        return kAudioUnitErr_InvalidPropertyValue;
    *ioSize = size;
    switch (id)
    {
        case kAudioUnitProperty_StreamFormat:
            *static_cast<AudioStreamBasicDescription*> (outData) = scope == kAudioUnitScope_Input ? unit.inputFormat : unit.outputFormat;
            return noErr;
        case kAudioUnitProperty_ElementCount:
            *static_cast<UInt32*> (outData) = 1;
            return noErr;
        case kAudioUnitProperty_MaximumFramesPerSlice:
            *static_cast<UInt32*> (outData) = unit.maxFrames;
            return noErr;
        case kAudioUnitProperty_SetRenderCallback:
            *static_cast<AURenderCallbackStruct*> (outData) = unit.input;
            return noErr;
        case kAudioUnitProperty_HostCallbacks:
            *static_cast<HostCallbackInfo*> (outData) = unit.hostCallbacks;
            return noErr;
        case kAudioUnitProperty_ParameterList:
        {
            auto* ids = static_cast<AudioUnitParameterID*> (outData);
            ids[0] = kGainId;
            ids[1] = kHostTempoId;
            return noErr;
        }
        case kAudioUnitProperty_ParameterInfo:
        {
            auto& info = *static_cast<AudioUnitParameterInfo*> (outData);
            info = {};
            info.flags = kAudioUnitParameterFlag_IsReadable | kAudioUnitParameterFlag_HasCFNameString;
            if (element == kGainId)
            {
                info.cfNameString = CFSTR ("Gain");
                info.unit = kAudioUnitParameterUnit_LinearGain;
                info.minValue = 0.0f;
                info.maxValue = 1.0f;
                info.defaultValue = 1.0f;
                info.flags |= kAudioUnitParameterFlag_IsWritable | kAudioUnitParameterFlag_ValuesHaveStrings; // (the "%.2f x" below)
            }
            else
            {
                info.cfNameString = CFSTR ("Host tempo");
                info.unit = kAudioUnitParameterUnit_BPM;
                info.minValue = 0.0f;
                info.maxValue = 1000.0f;
                info.defaultValue = 0.0f;
            }
            return noErr;
        }
        case kAudioUnitProperty_ParameterStringFromValue:
        {
            auto& request = *static_cast<AudioUnitParameterStringFromValue*> (outData);
            if (request.inParamID != kGainId)
                return kAudioUnitErr_InvalidParameter;
            auto value = request.inValue != nullptr ? *request.inValue : unit.gain;
            request.outString = CFStringCreateWithFormat (kCFAllocatorDefault, nullptr, CFSTR ("%.2f x"), static_cast<double> (value));
            return noErr;
        }
        case kAudioUnitProperty_Latency:
            *static_cast<Float64*> (outData) = 0.0;
            return noErr;
        case kAudioUnitProperty_ClassInfo:
            *static_cast<CFPropertyListRef*> (outData) = makeClassInfo (unit);
            return noErr;
        default:
            return kAudioUnitErr_InvalidProperty;
    }
}

OSStatus setProperty (void* self, AudioUnitPropertyID id, AudioUnitScope scope, AudioUnitElement element, const void* inData, UInt32 inSize)
{
    auto& unit = unitOf (self);
    UInt32 size = 0;
    Boolean writable = false;
    if (auto status = getPropertyInfo (self, id, scope, element, &size, &writable))
        return status;
    if (! writable)
        return kAudioUnitErr_PropertyNotWritable;
    if (inData == nullptr || inSize < size)
        return kAudioUnitErr_InvalidPropertyValue;
    switch (id)
    {
        case kAudioUnitProperty_StreamFormat:
        {
            auto& format = *static_cast<const AudioStreamBasicDescription*> (inData);
            if (! TestGainUnit::formatOk (format))
                return kAudioUnitErr_FormatNotSupported;
            (scope == kAudioUnitScope_Input ? unit.inputFormat : unit.outputFormat) = format;
            return noErr;
        }
        case kAudioUnitProperty_MaximumFramesPerSlice:
            unit.maxFrames = *static_cast<const UInt32*> (inData);
            return noErr;
        case kAudioUnitProperty_SetRenderCallback:
            unit.input = *static_cast<const AURenderCallbackStruct*> (inData);
            return noErr;
        case kAudioUnitProperty_HostCallbacks:
            unit.hostCallbacks = *static_cast<const HostCallbackInfo*> (inData);
            return noErr;
        case kAudioUnitProperty_ClassInfo:
        {
            auto plist = *static_cast<const CFPropertyListRef*> (inData);
            if (plist == nullptr || CFGetTypeID (plist) != CFDictionaryGetTypeID())
                return kAudioUnitErr_InvalidPropertyValue;
            auto data = static_cast<CFDataRef> (CFDictionaryGetValue (static_cast<CFDictionaryRef> (plist), CFSTR (kAUPresetDataKey)));
            if (data == nullptr || CFGetTypeID (data) != CFDataGetTypeID() || CFDataGetLength (data) != static_cast<CFIndex> (sizeof (float)))
                return kAudioUnitErr_InvalidPropertyValue;
            std::memcpy (&unit.gain, CFDataGetBytePtr (data), sizeof (float));
            return noErr;
        }
        default:
            return kAudioUnitErr_InvalidProperty;
    }
}

OSStatus addPropertyListener (void*, AudioUnitPropertyID, AudioUnitPropertyListenerProc, void*) { return noErr; }
OSStatus removePropertyListener (void*, AudioUnitPropertyID, AudioUnitPropertyListenerProc) { return noErr; }
OSStatus removePropertyListenerWithUserData (void*, AudioUnitPropertyID, AudioUnitPropertyListenerProc, void*) { return noErr; }
OSStatus addRenderNotify (void*, AURenderCallback, void*) { return noErr; }
OSStatus removeRenderNotify (void*, AURenderCallback, void*) { return noErr; }
OSStatus reset (void*, AudioUnitScope, AudioUnitElement) { return noErr; }

OSStatus getParameter (void* self, AudioUnitParameterID id, AudioUnitScope scope, AudioUnitElement, AudioUnitParameterValue* outValue)
{
    auto& unit = unitOf (self);
    if (scope != kAudioUnitScope_Global || outValue == nullptr)
        return kAudioUnitErr_InvalidScope;
    if (id == kGainId) *outValue = unit.gain;
    else if (id == kHostTempoId) *outValue = unit.hostTempo;
    else return kAudioUnitErr_InvalidParameter;
    return noErr;
}

OSStatus setParameter (void* self, AudioUnitParameterID id, AudioUnitScope scope, AudioUnitElement, AudioUnitParameterValue value, UInt32)
{
    auto& unit = unitOf (self);
    if (scope != kAudioUnitScope_Global)
        return kAudioUnitErr_InvalidScope;
    if (id != kGainId)
        return kAudioUnitErr_InvalidParameter; // the host tempo is read-only
    unit.gain = std::clamp (value, 0.0f, 1.0f);
    return noErr;
}

OSStatus scheduleParameters (void* self, const AudioUnitParameterEvent* events, UInt32 count)
{
    for (UInt32 i = 0; i < count; ++i)
        if (events[i].eventType == kParameterEvent_Immediate)
            setParameter (self, events[i].parameter, events[i].scope, events[i].element, events[i].eventValues.immediate.value, 0);
    return noErr;
}

OSStatus render (void* self, AudioUnitRenderActionFlags* ioFlags, const AudioTimeStamp* stamp, UInt32 bus, UInt32 frames, AudioBufferList* ioData)
{
    auto& unit = unitOf (self);
    if (! unit.initialized)
        return kAudioUnitErr_Uninitialized;
    if (bus != 0 || ioData == nullptr || ioData->mNumberBuffers < 2)
        return kAudioUnitErr_InvalidElement;
    if (frames > unit.maxFrames)
        return kAudioUnitErr_TooManyFramesToProcess;
    if (unit.input.inputProc == nullptr)
        return kAudioUnitErr_NoConnection;

    // The input, pulled from the host
    auto* list = unit.inputList();
    for (int ch = 0; ch < 2; ++ch)
    {
        list->mBuffers[ch].mNumberChannels = 1;
        list->mBuffers[ch].mDataByteSize = frames * static_cast<UInt32> (sizeof (float));
        list->mBuffers[ch].mData = unit.scratch[ch].data();
    }
    AudioUnitRenderActionFlags flags = ioFlags != nullptr ? *ioFlags : 0;
    if (auto status = unit.input.inputProc (unit.input.inputProcRefCon, &flags, stamp, 0, frames, list))
        return status;

    // What the host says about the tempo, reported through a parameter
    if (unit.hostCallbacks.beatAndTempoProc != nullptr)
    {
        Float64 tempo = 0.0;
        if (unit.hostCallbacks.beatAndTempoProc (unit.hostCallbacks.hostUserData, nullptr, &tempo) == noErr)
            unit.hostTempo = static_cast<float> (tempo);
    }

    for (int ch = 0; ch < 2; ++ch)
    {
        auto& out = ioData->mBuffers[ch];
        if (out.mData == nullptr)
            out.mData = unit.scratch[ch].data(); // ours, then
        out.mDataByteSize = frames * static_cast<UInt32> (sizeof (float));
        auto* source = static_cast<const float*> (list->mBuffers[ch].mData);
        auto* target = static_cast<float*> (out.mData);
        for (UInt32 i = 0; i < frames; ++i)
            target[i] = source[i] * unit.gain;
    }
    return noErr;
}

AudioComponentMethod lookup (SInt16 selector)
{
    switch (selector)
    {
        case kAudioUnitInitializeSelect: return reinterpret_cast<AudioComponentMethod> (initialize);
        case kAudioUnitUninitializeSelect: return reinterpret_cast<AudioComponentMethod> (uninitialize);
        case kAudioUnitGetPropertyInfoSelect: return reinterpret_cast<AudioComponentMethod> (getPropertyInfo);
        case kAudioUnitGetPropertySelect: return reinterpret_cast<AudioComponentMethod> (getProperty);
        case kAudioUnitSetPropertySelect: return reinterpret_cast<AudioComponentMethod> (setProperty);
        case kAudioUnitAddPropertyListenerSelect: return reinterpret_cast<AudioComponentMethod> (addPropertyListener);
        case kAudioUnitRemovePropertyListenerSelect: return reinterpret_cast<AudioComponentMethod> (removePropertyListener);
        case kAudioUnitRemovePropertyListenerWithUserDataSelect: return reinterpret_cast<AudioComponentMethod> (removePropertyListenerWithUserData);
        case kAudioUnitAddRenderNotifySelect: return reinterpret_cast<AudioComponentMethod> (addRenderNotify);
        case kAudioUnitRemoveRenderNotifySelect: return reinterpret_cast<AudioComponentMethod> (removeRenderNotify);
        case kAudioUnitGetParameterSelect: return reinterpret_cast<AudioComponentMethod> (getParameter);
        case kAudioUnitSetParameterSelect: return reinterpret_cast<AudioComponentMethod> (setParameter);
        case kAudioUnitScheduleParametersSelect: return reinterpret_cast<AudioComponentMethod> (scheduleParameters);
        case kAudioUnitRenderSelect: return reinterpret_cast<AudioComponentMethod> (render);
        case kAudioUnitResetSelect: return reinterpret_cast<AudioComponentMethod> (reset);
        default: return nullptr;
    }
}

AudioComponentPlugInInterface* factory (const AudioComponentDescription*)
{
    auto* unit = new TestGainUnit();
    unit->plugInInterface.Open = open;
    unit->plugInInterface.Close = close;
    unit->plugInInterface.Lookup = lookup;
    unit->plugInInterface.reserved = nullptr;
    return &unit->plugInInterface;
}

} // namespace

const char* const auTestGainPluginId = "au:aufx:tgai:NoPr";

void registerAuTestGain()
{
    static bool registered = false;
    if (registered)
        return;
    AudioComponentDescription desc = {};
    desc.componentType = kAudioUnitType_Effect;
    desc.componentSubType = fourCC ("tgai");
    desc.componentManufacturer = fourCC ("NoPr");
    AudioComponentRegister (&desc, CFSTR ("NoProd: Test Gain"), 0x00010000, factory);
    registered = true;
}

#endif
