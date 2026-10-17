#include "Vst3Plugin.h"

#include "../platform/DynamicLibrary.h"
#include "../platform/Log.h"
#include "../platform/Platform.h"
#include "../platform/Strings.h"
#include "Dsp.h"

#include "pluginterfaces/base/ibstream.h"
#include "pluginterfaces/base/ipluginbase.h"
#include "pluginterfaces/vst/ivstattributes.h"
#include "pluginterfaces/vst/ivstaudioprocessor.h"
#include "pluginterfaces/vst/ivstcomponent.h"
#include "pluginterfaces/vst/ivsteditcontroller.h"
#include "pluginterfaces/vst/ivsthostapplication.h"
#include "pluginterfaces/vst/ivstmessage.h"
#include "pluginterfaces/vst/ivstparameterchanges.h"
#include "pluginterfaces/vst/ivstpluginterfacesupport.h"
#include "pluginterfaces/vst/ivstprocesscontext.h"
#include "pluginterfaces/vst/vstspeaker.h"

#include <algorithm>
#include <atomic>
#include <cstring>
#include <map>
#include <mutex>

#if GHOSTDAW_MAC
 #include <CoreFoundation/CoreFoundation.h>
#endif

using namespace Steinberg;
using namespace Steinberg::Vst;

namespace ghostdaw
{

// ------------------------------------------------------------ UTF-16

std::string utf16ToUtf8 (const char16_t* text, size_t maxLength)
{
    std::string out;
    if (text == nullptr)
        return out;
    for (size_t i = 0; i < maxLength && text[i] != 0; ++i)
    {
        uint32_t cp = text[i];
        if (cp >= 0xD800 && cp <= 0xDBFF && i + 1 < maxLength && text[i + 1] >= 0xDC00 && text[i + 1] <= 0xDFFF)
        {
            cp = 0x10000 + ((cp - 0xD800) << 10) + (text[i + 1] - 0xDC00);
            ++i;
        }
        if (cp < 0x80)
            out += static_cast<char> (cp);
        else if (cp < 0x800)
        {
            out += static_cast<char> (0xC0 | (cp >> 6));
            out += static_cast<char> (0x80 | (cp & 0x3F));
        }
        else if (cp < 0x10000)
        {
            out += static_cast<char> (0xE0 | (cp >> 12));
            out += static_cast<char> (0x80 | ((cp >> 6) & 0x3F));
            out += static_cast<char> (0x80 | (cp & 0x3F));
        }
        else
        {
            out += static_cast<char> (0xF0 | (cp >> 18));
            out += static_cast<char> (0x80 | ((cp >> 12) & 0x3F));
            out += static_cast<char> (0x80 | ((cp >> 6) & 0x3F));
            out += static_cast<char> (0x80 | (cp & 0x3F));
        }
    }
    return out;
}

namespace
{

// ------------------------------------------------- host-side objects
// What a plug-in calls back into. Reference counting as FUnknown asks;
// queryInterface answers for the interfaces each object implements.

template <typename First, typename...>
struct FirstOf { using type = First; };

template <typename... Interfaces>
class HostObject : public Interfaces...
{
public:
    virtual ~HostObject() = default;

    tresult PLUGIN_API queryInterface (const TUID _iid, void** obj) override
    {
        if (obj == nullptr)
            return kInvalidArgument;
        if (FUnknownPrivate::iidEqual (_iid, FUnknown::iid))
        {
            *obj = static_cast<FUnknown*> (firstInterface());
            addRef();
            return kResultOk;
        }
        for (auto& [id, pointer] : interfaces)
        {
            if (FUnknownPrivate::iidEqual (_iid, id))
            {
                *obj = pointer;
                addRef();
                return kResultOk;
            }
        }
        *obj = nullptr;
        return kNoInterface;
    }

    uint32 PLUGIN_API addRef() override { return static_cast<uint32> (++refCount); }

    uint32 PLUGIN_API release() override
    {
        auto left = --refCount;
        if (left == 0)
            delete this;
        return static_cast<uint32> (left);
    }

protected:
    // Each object registers the interfaces it answers for
    template <typename Interface>
    void expose (Interface* self)
    {
        interfaces.push_back ({ Interface::iid, static_cast<void*> (self) });
    }

private:
    std::atomic<int> refCount { 1 };
    std::vector<std::pair<FUID, void*>> interfaces;

    FUnknown* firstInterface() { return static_cast<FUnknown*> (static_cast<typename FirstOf<Interfaces...>::type*> (this)); }
};

// A released-on-scope-exit pointer for interfaces a plug-in hands us
template <typename I>
struct Owned
{
    I* ptr = nullptr;
    Owned() = default;
    explicit Owned (I* p) : ptr (p) {}
    ~Owned() { reset(); }
    Owned (const Owned&) = delete;
    Owned& operator= (const Owned&) = delete;
    void reset (I* p = nullptr)
    {
        if (ptr != nullptr)
            ptr->release();
        ptr = p;
    }
    I* operator->() const { return ptr; }
    explicit operator bool() const { return ptr != nullptr; }
};

template <typename I>
I* queryFrom (FUnknown* object)
{
    if (object == nullptr)
        return nullptr;
    I* result = nullptr;
    if (object->queryInterface (I::iid.toTUID(), reinterpret_cast<void**> (&result)) != kResultOk)
        return nullptr;
    return result;
}

class HostAttributeList final : public HostObject<IAttributeList>
{
public:
    HostAttributeList() { expose<IAttributeList> (this); }

    tresult PLUGIN_API setInt (AttrID id, int64 value) override { ints[id] = value; return kResultOk; }
    tresult PLUGIN_API getInt (AttrID id, int64& value) override
    {
        auto it = ints.find (id);
        if (it == ints.end()) return kResultFalse;
        value = it->second;
        return kResultOk;
    }
    tresult PLUGIN_API setFloat (AttrID id, double value) override { floats[id] = value; return kResultOk; }
    tresult PLUGIN_API getFloat (AttrID id, double& value) override
    {
        auto it = floats.find (id);
        if (it == floats.end()) return kResultFalse;
        value = it->second;
        return kResultOk;
    }
    tresult PLUGIN_API setString (AttrID id, const TChar* string) override
    {
        std::u16string s;
        for (size_t i = 0; string != nullptr && string[i] != 0; ++i)
            s += string[i];
        strings[id] = s;
        return kResultOk;
    }
    tresult PLUGIN_API getString (AttrID id, TChar* string, uint32 sizeInBytes) override
    {
        if (string == nullptr || sizeInBytes < sizeof (TChar)) return kInvalidArgument;
        auto it = strings.find (id);
        if (it == strings.end()) return kResultFalse;
        auto count = std::min<size_t> (it->second.size(), sizeInBytes / sizeof (TChar) - 1);
        std::memcpy (string, it->second.data(), count * sizeof (TChar));
        string[count] = 0;
        return kResultOk;
    }
    tresult PLUGIN_API setBinary (AttrID id, const void* data, uint32 sizeInBytes) override
    {
        auto* bytes = static_cast<const uint8_t*> (data);
        binaries[id].assign (bytes, bytes + sizeInBytes);
        return kResultOk;
    }
    tresult PLUGIN_API getBinary (AttrID id, const void*& data, uint32& sizeInBytes) override
    {
        auto it = binaries.find (id);
        if (it == binaries.end()) return kResultFalse;
        data = it->second.data();
        sizeInBytes = static_cast<uint32> (it->second.size());
        return kResultOk;
    }

private:
    std::map<std::string, int64> ints;
    std::map<std::string, double> floats;
    std::map<std::string, std::u16string> strings;
    std::map<std::string, std::vector<uint8_t>> binaries;
};

class HostMessage final : public HostObject<IMessage>
{
public:
    HostMessage() { expose<IMessage> (this); }
    ~HostMessage() override { attributes->release(); }

    FIDString PLUGIN_API getMessageID() override { return id.c_str(); }
    void PLUGIN_API setMessageID (FIDString newId) override { id = newId != nullptr ? newId : ""; }
    IAttributeList* PLUGIN_API getAttributes() override { return attributes; }

private:
    std::string id;
    HostAttributeList* attributes = new HostAttributeList();
};

// The context every plug-in class is initialised with
class HostApplication final : public HostObject<IHostApplication, IPlugInterfaceSupport>
{
public:
    HostApplication()
    {
        expose<IHostApplication> (this);
        expose<IPlugInterfaceSupport> (this);
    }

    tresult PLUGIN_API getName (String128 name) override
    {
        static const char16_t text[] = u"GhostDAW";
        std::memcpy (name, text, sizeof (text));
        return kResultOk;
    }

    tresult PLUGIN_API createInstance (TUID cid, TUID _iid, void** obj) override
    {
        if (FUnknownPrivate::iidEqual (cid, IMessage::iid) && FUnknownPrivate::iidEqual (_iid, IMessage::iid))
        {
            *obj = static_cast<IMessage*> (new HostMessage());
            return kResultOk;
        }
        if (FUnknownPrivate::iidEqual (cid, IAttributeList::iid) && FUnknownPrivate::iidEqual (_iid, IAttributeList::iid))
        {
            *obj = static_cast<IAttributeList*> (new HostAttributeList());
            return kResultOk;
        }
        *obj = nullptr;
        return kResultFalse;
    }

    tresult PLUGIN_API isPlugInterfaceSupported (const TUID _iid) override
    {
        for (auto* supported : { &IComponent::iid, &IAudioProcessor::iid, &IEditController::iid, &IConnectionPoint::iid })
            if (FUnknownPrivate::iidEqual (_iid, *supported))
                return kResultTrue;
        return kResultFalse;
    }
};

// A growable in-memory IBStream (component and controller state)
class MemoryStream final : public HostObject<IBStream, ISizeableStream>
{
public:
    MemoryStream()
    {
        expose<IBStream> (this);
        expose<ISizeableStream> (this);
    }
    explicit MemoryStream (const std::vector<uint8_t>& initial) : MemoryStream() { data = initial; }

    tresult PLUGIN_API read (void* buffer, int32 numBytes, int32* numBytesRead) override
    {
        auto available = position < data.size() ? data.size() - position : 0;
        auto count = static_cast<size_t> (std::max (0, numBytes));
        count = std::min (count, available);
        if (count > 0)
            std::memcpy (buffer, data.data() + position, count);
        position += count;
        if (numBytesRead != nullptr)
            *numBytesRead = static_cast<int32> (count);
        return kResultOk;
    }

    tresult PLUGIN_API write (void* buffer, int32 numBytes, int32* numBytesWritten) override
    {
        auto count = static_cast<size_t> (std::max (0, numBytes));
        if (position + count > data.size())
            data.resize (position + count);
        if (count > 0)
            std::memcpy (data.data() + position, buffer, count);
        position += count;
        if (numBytesWritten != nullptr)
            *numBytesWritten = static_cast<int32> (count);
        return kResultOk;
    }

    tresult PLUGIN_API seek (int64 pos, int32 mode, int64* result) override
    {
        int64 base = mode == kIBSeekSet ? 0 : mode == kIBSeekCur ? static_cast<int64> (position) : static_cast<int64> (data.size());
        auto target = base + pos;
        if (target < 0)
            return kInvalidArgument;
        position = static_cast<size_t> (target);
        if (result != nullptr)
            *result = target;
        return kResultOk;
    }

    tresult PLUGIN_API tell (int64* pos) override
    {
        if (pos != nullptr)
            *pos = static_cast<int64> (position);
        return kResultOk;
    }

    tresult PLUGIN_API getStreamSize (int64& size) override { size = static_cast<int64> (data.size()); return kResultOk; }
    tresult PLUGIN_API setStreamSize (int64 size) override { data.resize (static_cast<size_t> (std::max<int64> (0, size))); return kResultOk; }

    std::vector<uint8_t> data;
    size_t position = 0;
};

// Parameter changes for one block, preallocated: nothing is allocated on
// the audio thread
class ParamValueQueue final : public IParamValueQueue
{
public:
    static constexpr int maxPoints = 8;

    tresult PLUGIN_API queryInterface (const TUID _iid, void** obj) override
    {
        if (FUnknownPrivate::iidEqual (_iid, IParamValueQueue::iid) || FUnknownPrivate::iidEqual (_iid, FUnknown::iid))
        {
            *obj = this;
            return kResultOk;
        }
        *obj = nullptr;
        return kNoInterface;
    }
    uint32 PLUGIN_API addRef() override { return 1; }   // owned by its ParameterChanges
    uint32 PLUGIN_API release() override { return 1; }

    ParamID PLUGIN_API getParameterId() override { return id; }
    int32 PLUGIN_API getPointCount() override { return count; }
    tresult PLUGIN_API getPoint (int32 index, int32& sampleOffset, ParamValue& value) override
    {
        if (index < 0 || index >= count)
            return kResultFalse;
        sampleOffset = points[index].offset;
        value = points[index].value;
        return kResultOk;
    }
    tresult PLUGIN_API addPoint (int32 sampleOffset, ParamValue value, int32& index) override
    {
        if (count >= maxPoints)
            points[maxPoints - 1] = { sampleOffset, value }; // the latest wins
        else
            points[count++] = { sampleOffset, value };
        index = count - 1;
        return kResultOk;
    }

    ParamID id = 0;
    int32 count = 0;
    struct Point { int32 offset; ParamValue value; };
    Point points[maxPoints] {};
};

class ParameterChanges final : public IParameterChanges
{
public:
    static constexpr int maxQueues = 64;

    tresult PLUGIN_API queryInterface (const TUID _iid, void** obj) override
    {
        if (FUnknownPrivate::iidEqual (_iid, IParameterChanges::iid) || FUnknownPrivate::iidEqual (_iid, FUnknown::iid))
        {
            *obj = this;
            return kResultOk;
        }
        *obj = nullptr;
        return kNoInterface;
    }
    uint32 PLUGIN_API addRef() override { return 1; } // owned by the insert
    uint32 PLUGIN_API release() override { return 1; }

    int32 PLUGIN_API getParameterCount() override { return count; }
    IParamValueQueue* PLUGIN_API getParameterData (int32 index) override
    {
        return index >= 0 && index < count ? &queues[index] : nullptr;
    }
    IParamValueQueue* PLUGIN_API addParameterData (const ParamID& id, int32& index) override
    {
        for (int32 i = 0; i < count; ++i)
        {
            if (queues[i].id == id)
            {
                index = i;
                return &queues[i];
            }
        }
        if (count >= maxQueues)
        {
            index = maxQueues - 1; // full: the last queue takes it
            return &queues[maxQueues - 1];
        }
        queues[count].id = id;
        queues[count].count = 0;
        index = count;
        return &queues[count++];
    }

    void clear() { count = 0; }

    ParamValueQueue queues[maxQueues];
    int32 count = 0;
};

// One parameter change crossing threads
struct Change
{
    ParamID id;
    double value;
};

// A lock-free single-producer, single-consumer ring of changes
class ChangeRing
{
public:
    static constexpr int capacity = 1024;

    bool push (Change change)
    {
        auto write = writeIndex.load (std::memory_order_relaxed);
        auto next = (write + 1) % capacity;
        if (next == readIndex.load (std::memory_order_acquire))
            return false;
        slots[static_cast<size_t> (write)] = change;
        writeIndex.store (next, std::memory_order_release);
        return true;
    }

    bool pop (Change& change)
    {
        auto read = readIndex.load (std::memory_order_relaxed);
        if (read == writeIndex.load (std::memory_order_acquire))
            return false;
        change = slots[static_cast<size_t> (read)];
        readIndex.store ((read + 1) % capacity, std::memory_order_release);
        return true;
    }

private:
    std::array<Change, capacity> slots {};
    std::atomic<int> readIndex { 0 }, writeIndex { 0 };
};

} // namespace

// ------------------------------------------------------------ module

struct Vst3Module::Impl
{
    DynamicLibrary library;
    IPluginFactory* factory = nullptr;
    std::string factoryVendor;
    bool (*exitFunction)() = nullptr;
   #if GHOSTDAW_MAC
    CFBundleRef bundle = nullptr;
   #endif
};

fs::path Vst3Module::binaryPathFor (const fs::path& bundle)
{
   #if GHOSTDAW_WINDOWS
    #if defined(_M_ARM64EC)
     const char* arch = "arm64ec-win";
    #elif defined(_M_ARM64)
     const char* arch = "arm64-win";
    #elif defined(_M_X64)
     const char* arch = "x86_64-win";
    #else
     const char* arch = "x86-win";
    #endif
    auto name = bundle.filename(); // X.vst3 inside too
    return bundle / "Contents" / arch / name;
   #elif GHOSTDAW_MAC
    auto name = bundle.stem();
    return bundle / "Contents" / "MacOS" / name;
   #else
    #if defined(__x86_64__)
     const char* arch = "x86_64-linux";
    #elif defined(__aarch64__)
     const char* arch = "aarch64-linux";
    #elif defined(__i386__)
     const char* arch = "i386-linux";
    #elif defined(__arm__)
     const char* arch = "arm-linux";
    #else
     const char* arch = "unknown-linux";
    #endif
    auto name = bundle.stem();
    name += ".so";
    return bundle / "Contents" / arch / name;
   #endif
}

std::shared_ptr<Vst3Module> Vst3Module::open (const fs::path& path, std::string& error)
{
    auto module = std::shared_ptr<Vst3Module> (new Vst3Module());
    module->path = path;
    module->impl = std::make_unique<Impl>();
    auto& impl = *module->impl;
    auto displayName = pathToUtf8 (path.filename());

    fs::path binary = directoryExists (path) ? binaryPathFor (path) : path;
    if (! fileExists (binary))
    {
        error = displayName + ": no binary for this platform at " + pathToUtf8 (binary);
        return nullptr;
    }

    std::string reason;
    if (! impl.library.open (binary, reason))
    {
        error = displayName + ": could not load " + pathToUtf8 (binary.filename()) + " (" + reason + ")";
        return nullptr;
    }

    // The module's entry function (the VST 3 module format per platform)
   #if GHOSTDAW_WINDOWS
    if (auto initDll = reinterpret_cast<bool (*)()> (impl.library.getFunction ("InitDll")))
        if (! initDll())
        {
            error = displayName + ": InitDll failed";
            return nullptr;
        }
    impl.exitFunction = reinterpret_cast<bool (*)()> (impl.library.getFunction ("ExitDll"));
   #elif GHOSTDAW_MAC
    if (directoryExists (path))
    {
        auto url = CFURLCreateFromFileSystemRepresentation (kCFAllocatorDefault, reinterpret_cast<const UInt8*> (path.c_str()),
                                                            static_cast<CFIndex> (std::strlen (path.c_str())), true);
        if (url != nullptr)
        {
            impl.bundle = CFBundleCreate (kCFAllocatorDefault, url);
            CFRelease (url);
        }
    }
    if (auto bundleEntry = reinterpret_cast<bool (*)(CFBundleRef)> (impl.library.getFunction ("bundleEntry")))
        if (! bundleEntry (impl.bundle))
        {
            error = displayName + ": bundleEntry failed";
            return nullptr;
        }
    impl.exitFunction = reinterpret_cast<bool (*)()> (impl.library.getFunction ("bundleExit"));
   #else
    if (auto moduleEntry = reinterpret_cast<bool (*)(void*)> (impl.library.getFunction ("ModuleEntry")))
        if (! moduleEntry (nullptr))
        {
            error = displayName + ": ModuleEntry failed";
            return nullptr;
        }
    impl.exitFunction = reinterpret_cast<bool (*)()> (impl.library.getFunction ("ModuleExit"));
   #endif

    auto getFactory = reinterpret_cast<IPluginFactory* (PLUGIN_API*)()> (impl.library.getFunction ("GetPluginFactory"));
    if (getFactory == nullptr)
    {
        error = displayName + " is not a VST 3 module (no GetPluginFactory export)";
        return nullptr;
    }
    impl.factory = getFactory();
    if (impl.factory == nullptr)
    {
        error = displayName + ": GetPluginFactory returned null";
        return nullptr;
    }

    PFactoryInfo factoryInfo;
    if (impl.factory->getFactoryInfo (&factoryInfo) == kResultOk)
        impl.factoryVendor = factoryInfo.vendor;

    Owned<IPluginFactory2> factory2 (queryFrom<IPluginFactory2> (impl.factory));
    for (int32 i = 0; i < impl.factory->countClasses(); ++i)
    {
        PClassInfo info;
        if (impl.factory->getClassInfo (i, &info) != kResultOk)
            continue;
        if (std::strcmp (info.category, kVstAudioEffectClass) != 0)
            continue;

        Vst3ClassInfo effect;
        char8 hex[33] = {};
        FUID::fromTUID (info.cid).toString (hex);
        effect.classId = hex;
        effect.name = info.name;
        effect.vendor = impl.factoryVendor;
        if (factory2)
        {
            PClassInfo2 info2;
            if (factory2->getClassInfo2 (i, &info2) == kResultOk)
            {
                if (info2.vendor[0] != 0)
                    effect.vendor = info2.vendor;
                effect.version = info2.version;
                effect.subCategories = info2.subCategories;
            }
        }
        module->effects.push_back (effect);
    }

    if (module->effects.empty())
    {
        error = displayName + " has no audio effect class";
        return nullptr;
    }
    return module;
}

Vst3Module::~Vst3Module()
{
    if (impl == nullptr)
        return;
    if (impl->factory != nullptr)
        impl->factory->release();
    if (impl->exitFunction != nullptr)
        impl->exitFunction();
   #if GHOSTDAW_MAC
    if (impl->bundle != nullptr)
        CFRelease (impl->bundle);
   #endif
}

// ------------------------------------------------------------ insert

struct Vst3Insert::Impl
{
    std::shared_ptr<Vst3Module> module;
    Vst3ClassInfo info;
    HostApplication* host = nullptr;
    IComponent* component = nullptr;
    IAudioProcessor* processor = nullptr;
    IEditController* controller = nullptr;
    IConnectionPoint* componentConnection = nullptr;
    IConnectionPoint* controllerConnection = nullptr;
    bool separateController = false;

    // The host's component handler: edits the plug-in makes by itself,
    // and its restart requests
    class Handler final : public HostObject<IComponentHandler, IComponentHandler2>
    {
    public:
        explicit Handler (Impl& owner) : impl (owner)
        {
            expose<IComponentHandler> (this);
            expose<IComponentHandler2> (this);
        }
        tresult PLUGIN_API beginEdit (ParamID) override { return kResultOk; }
        tresult PLUGIN_API performEdit (ParamID id, ParamValue value) override
        {
            impl.toProcessor.push ({ id, value }); // the controller already has it
            return kResultOk;
        }
        tresult PLUGIN_API endEdit (ParamID) override { return kResultOk; }
        tresult PLUGIN_API restartComponent (int32 flags) override
        {
            if ((flags & kLatencyChanged) != 0)
                impl.latencyMayHaveChanged.store (true);
            if ((flags & kIoChanged) != 0)
                Log::warn (impl.info.name + " asked for an I/O change, which GhostDAW does not do while it is in a chain");
            return kResultOk;
        }
        tresult PLUGIN_API setDirty (TBool) override { return kResultOk; }
        tresult PLUGIN_API requestOpenEditor (FIDString) override { return kResultOk; }
        tresult PLUGIN_API startGroupEdit() override { return kResultOk; }
        tresult PLUGIN_API finishGroupEdit() override { return kResultOk; }

    private:
        Impl& impl;
    };
    Handler* handler = nullptr;

    // Parameters, as the controller lists them (hidden ones left out)
    struct Parameter
    {
        ParamID id;
        PluginParameterInfo info;
        std::string units;
    };
    std::vector<Parameter> parameters;

    // Buses
    int inputBuses = 0, outputBuses = 0;
    std::vector<int> inputChannels, outputChannels; // per bus
    int mainInputChannels = 0, mainOutputChannels = 0;

    // Processing state
    bool active = false, processing = false;
    double sampleRate = 0.0;
    int maxBlockSize = 0;
    std::atomic<int> latency { 0 };
    std::atomic<bool> latencyMayHaveChanged { false };

    // Audio-thread buffers: the main buses' samples and every bus's
    // channel-pointer array (null pointers for the inactive aux buses)
    AudioBuffer mainIn, mainOut;
    std::vector<std::vector<float*>> inputPointers, outputPointers;
    std::vector<AudioBusBuffers> inputBuffers, outputBuffers;
    ParameterChanges inputChanges, outputChanges;
    ChangeRing toProcessor, fromProcessor;
    ProcessContext context {};
    bool contextKnown = false;

    // The processor's own changes (outputParameterChanges) reach the
    // controller from the control thread
    void pumpFromProcessor()
    {
        Change change;
        while (fromProcessor.pop (change))
            if (controller != nullptr)
                controller->setParamNormalized (change.id, change.value);
    }

    void teardown()
    {
        if (processor != nullptr && processing)
            processor->setProcessing (false);
        processing = false;
        if (component != nullptr && active)
            component->setActive (false);
        active = false;
        if (componentConnection != nullptr && controllerConnection != nullptr)
        {
            componentConnection->disconnect (controllerConnection);
            controllerConnection->disconnect (componentConnection);
        }
        if (controller != nullptr)
            controller->setComponentHandler (nullptr);
        if (controller != nullptr && separateController)
            controller->terminate();
        if (component != nullptr)
            component->terminate();
        for (auto** p : { &componentConnection, &controllerConnection })
            if (*p != nullptr)
            {
                (*p)->release();
                *p = nullptr;
            }
        if (controller != nullptr)
            controller->release();
        controller = nullptr;
        if (processor != nullptr)
            processor->release();
        processor = nullptr;
        if (component != nullptr)
            component->release();
        component = nullptr;
        if (handler != nullptr)
            handler->release();
        handler = nullptr;
        if (host != nullptr)
            host->release();
        host = nullptr;
        module.reset(); // last: the binary may unload now
    }

    static int channelsIn (SpeakerArrangement arrangement)
    {
        int count = 0;
        for (; arrangement != 0; arrangement >>= 1)
            count += static_cast<int> (arrangement & 1);
        return count;
    }
};

std::unique_ptr<Vst3Insert> Vst3Insert::create (std::shared_ptr<Vst3Module> module, const std::string& classId, std::string& error)
{
    const Vst3ClassInfo* found = nullptr;
    for (auto& effect : module->getAudioEffects())
        if (equalsIgnoreCase (effect.classId, classId))
            found = &effect;
    if (found == nullptr)
    {
        error = "No audio effect with class id " + classId + " in " + pathToUtf8 (module->getPath().filename());
        return nullptr;
    }

    auto insert = std::unique_ptr<Vst3Insert> (new Vst3Insert());
    insert->instance = std::make_unique<Impl>();
    auto& impl = *insert->instance;
    impl.module = module;
    impl.info = *found;
    impl.host = new HostApplication();
    impl.handler = new Impl::Handler (impl);
    auto& name = impl.info.name;

    auto fail = [&] (const std::string& why)
    {
        error = name + ": " + why;
        impl.teardown();
        return std::unique_ptr<Vst3Insert>();
    };

    TUID cid;
    FUID classUid;
    classUid.fromString (found->classId.c_str());
    classUid.toTUID (cid);
    auto* factory = module->getImpl().factory;
    if (factory->createInstance (cid, IComponent::iid.toTUID(), reinterpret_cast<void**> (&impl.component)) != kResultOk || impl.component == nullptr)
        return fail ("the factory could not create its component");
    impl.component->setIoMode (kSimple);
    if (impl.component->initialize (static_cast<IHostApplication*> (impl.host)) != kResultOk)
        return fail ("the component failed to initialize");

    impl.processor = queryFrom<IAudioProcessor> (impl.component);
    if (impl.processor == nullptr)
        return fail ("the component has no audio processor");
    if (impl.processor->canProcessSampleSize (kSample32) != kResultTrue)
        return fail ("the processor can't process 32-bit samples");

    // The controller: a separate class the component names, or the
    // component itself
    TUID controllerCid;
    if (impl.component->getControllerClassId (controllerCid) == kResultOk)
    {
        if (factory->createInstance (controllerCid, IEditController::iid.toTUID(), reinterpret_cast<void**> (&impl.controller)) != kResultOk || impl.controller == nullptr)
            return fail ("the factory could not create its controller");
        impl.separateController = true;
        if (impl.controller->initialize (static_cast<IHostApplication*> (impl.host)) != kResultOk)
            return fail ("the controller failed to initialize");
    }
    else
    {
        impl.controller = queryFrom<IEditController> (impl.component);
        if (impl.controller == nullptr)
            return fail ("the component has no controller");
    }
    impl.controller->setComponentHandler (impl.handler);

    if (impl.separateController)
    {
        impl.componentConnection = queryFrom<IConnectionPoint> (impl.component);
        impl.controllerConnection = queryFrom<IConnectionPoint> (impl.controller);
        if (impl.componentConnection != nullptr && impl.controllerConnection != nullptr)
        {
            impl.componentConnection->connect (impl.controllerConnection);
            impl.controllerConnection->connect (impl.componentConnection);
        }

        // The controller starts from the component's state
        auto* stream = new MemoryStream();
        if (impl.component->getState (stream) == kResultOk)
        {
            stream->seek (0, IBStream::kIBSeekSet, nullptr);
            impl.controller->setComponentState (stream);
        }
        stream->release();
    }

    // Parameters
    for (int32 i = 0; i < impl.controller->getParameterCount(); ++i)
    {
        ParameterInfo info;
        if (impl.controller->getParameterInfo (i, info) != kResultOk)
            continue;
        if ((info.flags & ParameterInfo::kIsHidden) != 0)
            continue;
        Impl::Parameter p;
        p.id = info.id;
        p.info.index = static_cast<int> (impl.parameters.size());
        p.info.id = std::to_string (info.id);
        p.info.name = utf16ToUtf8 (info.title);
        p.info.minValue = 0.0f;
        p.info.maxValue = 1.0f;
        p.info.defaultValue = static_cast<float> (info.defaultNormalizedValue);
        p.info.stepped = info.stepCount > 0;
        p.info.boolean = info.stepCount == kStepCountToggle;
        p.info.readOnly = (info.flags & ParameterInfo::kIsReadOnly) != 0;
        p.units = utf16ToUtf8 (info.units);
        impl.parameters.push_back (p);
    }

    // Buses: the main ones stereo (or whatever the plug-in insists on),
    // the aux ones left as they are and inactive
    impl.inputBuses = std::max (0, impl.component->getBusCount (kAudio, kInput));
    impl.outputBuses = std::max (0, impl.component->getBusCount (kAudio, kOutput));
    std::vector<SpeakerArrangement> inputs (static_cast<size_t> (impl.inputBuses)), outputs (static_cast<size_t> (impl.outputBuses));
    for (int32 i = 0; i < impl.inputBuses; ++i)
        impl.processor->getBusArrangement (kInput, i, inputs[static_cast<size_t> (i)]);
    for (int32 i = 0; i < impl.outputBuses; ++i)
        impl.processor->getBusArrangement (kOutput, i, outputs[static_cast<size_t> (i)]);
    if (impl.inputBuses > 0)
        inputs[0] = SpeakerArr::kStereo;
    if (impl.outputBuses > 0)
        outputs[0] = SpeakerArr::kStereo;
    impl.processor->setBusArrangements (inputs.data(), impl.inputBuses, outputs.data(), impl.outputBuses);
    for (int32 i = 0; i < impl.inputBuses; ++i)
    {
        SpeakerArrangement arrangement = 0;
        impl.processor->getBusArrangement (kInput, i, arrangement);
        impl.inputChannels.push_back (Impl::channelsIn (arrangement));
    }
    for (int32 i = 0; i < impl.outputBuses; ++i)
    {
        SpeakerArrangement arrangement = 0;
        impl.processor->getBusArrangement (kOutput, i, arrangement);
        impl.outputChannels.push_back (Impl::channelsIn (arrangement));
    }
    impl.mainInputChannels = impl.inputBuses > 0 ? impl.inputChannels[0] : 0;
    impl.mainOutputChannels = impl.outputBuses > 0 ? impl.outputChannels[0] : 0;
    if (impl.mainOutputChannels == 0)
        return fail ("the plug-in has no main audio output");
    if (impl.inputBuses > 0)
        impl.component->activateBus (kAudio, kInput, 0, true);
    impl.component->activateBus (kAudio, kOutput, 0, true);

    impl.inputPointers.resize (static_cast<size_t> (impl.inputBuses));
    impl.outputPointers.resize (static_cast<size_t> (impl.outputBuses));
    impl.inputBuffers.resize (static_cast<size_t> (impl.inputBuses));
    impl.outputBuffers.resize (static_cast<size_t> (impl.outputBuses));

    return insert;
}

Vst3Insert::~Vst3Insert()
{
    if (instance != nullptr)
        instance->teardown();
}

std::string Vst3Insert::getName() const { return instance->info.name; }
std::string Vst3Insert::getPath() const { return pathToUtf8 (instance->module->getPath()); }
std::string Vst3Insert::getPluginId() const { return instance->info.classId; }
int Vst3Insert::getLatencySamples() const { return instance->latency.load(); }

bool Vst3Insert::prepare (double sampleRate, int maxBlockSize, std::string& error)
{
    auto& impl = *instance;
    if (impl.active && sampleRate == impl.sampleRate && maxBlockSize == impl.maxBlockSize)
        return true;

    if (impl.processing)
        impl.processor->setProcessing (false);
    impl.processing = false;
    if (impl.active)
        impl.component->setActive (false);
    impl.active = false;

    ProcessSetup setup;
    setup.processMode = kRealtime;
    setup.symbolicSampleSize = kSample32;
    setup.maxSamplesPerBlock = maxBlockSize;
    setup.sampleRate = sampleRate;
    if (impl.processor->setupProcessing (setup) != kResultOk)
    {
        error = impl.info.name + ": setupProcessing failed";
        return false;
    }
    impl.sampleRate = sampleRate;
    impl.maxBlockSize = maxBlockSize;

    // Buffers for the main buses, and each bus's channel pointers
    impl.mainIn.setSize (std::max (1, impl.mainInputChannels), maxBlockSize);
    impl.mainOut.setSize (std::max (1, impl.mainOutputChannels), maxBlockSize);
    for (int bus = 0; bus < impl.inputBuses; ++bus)
    {
        auto& pointers = impl.inputPointers[static_cast<size_t> (bus)];
        pointers.assign (static_cast<size_t> (std::max (1, impl.inputChannels[static_cast<size_t> (bus)])), nullptr);
        if (bus == 0)
            for (int ch = 0; ch < impl.mainInputChannels; ++ch)
                pointers[static_cast<size_t> (ch)] = impl.mainIn.getWritePointer (ch);
        auto& buffers = impl.inputBuffers[static_cast<size_t> (bus)];
        buffers.numChannels = impl.inputChannels[static_cast<size_t> (bus)];
        buffers.silenceFlags = 0;
        buffers.channelBuffers32 = pointers.data();
    }
    for (int bus = 0; bus < impl.outputBuses; ++bus)
    {
        auto& pointers = impl.outputPointers[static_cast<size_t> (bus)];
        pointers.assign (static_cast<size_t> (std::max (1, impl.outputChannels[static_cast<size_t> (bus)])), nullptr);
        if (bus == 0)
            for (int ch = 0; ch < impl.mainOutputChannels; ++ch)
                pointers[static_cast<size_t> (ch)] = impl.mainOut.getWritePointer (ch);
        auto& buffers = impl.outputBuffers[static_cast<size_t> (bus)];
        buffers.numChannels = impl.outputChannels[static_cast<size_t> (bus)];
        buffers.silenceFlags = 0;
        buffers.channelBuffers32 = pointers.data();
    }

    if (impl.component->setActive (true) != kResultOk)
    {
        error = impl.info.name + ": setActive failed";
        return false;
    }
    impl.active = true;
    impl.processor->setProcessing (true);
    impl.processing = true;
    impl.latency.store (static_cast<int> (impl.processor->getLatencySamples()));
    impl.context.sampleRate = sampleRate;
    return true;
}

void Vst3Insert::setTransport (const TransportInfo& t) noexcept
{
    auto& impl = *instance;
    auto& context = impl.context;
    context.state = 0;
    if ((t.flags & TransportInfo::playing) != 0)
        context.state |= ProcessContext::kPlaying;
    if ((t.flags & TransportInfo::looping) != 0)
        context.state |= ProcessContext::kCycleActive;
    if ((t.flags & TransportInfo::tempoValid) != 0)
    {
        context.state |= ProcessContext::kTempoValid;
        context.tempo = t.tempoBpm;
    }
    if ((t.flags & TransportInfo::ppqValid) != 0)
    {
        context.state |= ProcessContext::kProjectTimeMusicValid;
        context.projectTimeMusic = t.ppqPosition;
        if ((t.flags & TransportInfo::tempoValid) != 0 && t.tempoBpm > 0.0)
            context.projectTimeSamples = static_cast<TSamples> (t.ppqPosition / t.tempoBpm * 60.0 * impl.sampleRate);
    }
    impl.contextKnown = true;
}

void Vst3Insert::process (const float* const* inputs, float* const* outputs, int numChannels, int numSamples) noexcept
{
    auto& impl = *instance;
    if (! impl.processing || numSamples > impl.maxBlockSize)
        return; // outputs already hold the dry signal

    // This block's parameter changes
    impl.inputChanges.clear();
    impl.outputChanges.clear();
    Change change;
    while (impl.toProcessor.pop (change))
    {
        int32 index;
        if (auto* queue = impl.inputChanges.addParameterData (change.id, index))
            queue->addPoint (0, change.value, index);
    }

    auto inChannels = std::min (numChannels, impl.mainInputChannels);
    for (int ch = 0; ch < impl.mainInputChannels; ++ch)
    {
        if (ch < inChannels)
            dsp::copy (impl.mainIn.getWritePointer (ch), inputs[ch], numSamples);
        else
            dsp::clear (impl.mainIn.getWritePointer (ch), numSamples);
    }
    for (int ch = 0; ch < impl.mainOutputChannels; ++ch)
        dsp::clear (impl.mainOut.getWritePointer (ch), numSamples);

    ProcessData data;
    data.processMode = kRealtime;
    data.symbolicSampleSize = kSample32;
    data.numSamples = numSamples;
    data.numInputs = impl.inputBuses;
    data.numOutputs = impl.outputBuses;
    data.inputs = impl.inputBuses > 0 ? impl.inputBuffers.data() : nullptr;
    data.outputs = impl.outputBuffers.data();
    data.inputParameterChanges = &impl.inputChanges;
    data.outputParameterChanges = &impl.outputChanges;
    data.processContext = impl.contextKnown ? &impl.context : nullptr;
    impl.processor->process (data);

    auto outChannels = std::min (numChannels, impl.mainOutputChannels);
    for (int ch = 0; ch < outChannels; ++ch)
        dsp::copy (outputs[ch], impl.mainOut.getReadPointer (ch), numSamples);

    // What the processor changed by itself, for the controller
    for (int32 i = 0; i < impl.outputChanges.getParameterCount(); ++i)
    {
        auto* queue = impl.outputChanges.getParameterData (i);
        int32 offset;
        ParamValue value;
        if (queue != nullptr && queue->getPointCount() > 0 && queue->getPoint (queue->getPointCount() - 1, offset, value) == kResultOk)
            impl.fromProcessor.push ({ queue->getParameterId(), value });
    }
    if (impl.contextKnown)
        impl.context.projectTimeSamples += numSamples;
}

std::vector<PluginParameterInfo> Vst3Insert::getParameters()
{
    instance->pumpFromProcessor();
    std::vector<PluginParameterInfo> result;
    for (auto& p : instance->parameters)
        result.push_back (p.info);
    return result;
}

float Vst3Insert::getParameterValue (int index)
{
    auto& impl = *instance;
    impl.pumpFromProcessor();
    if (index < 0 || static_cast<size_t> (index) >= impl.parameters.size())
        return 0.0f;
    return static_cast<float> (impl.controller->getParamNormalized (impl.parameters[static_cast<size_t> (index)].id));
}

std::string Vst3Insert::getParameterText (int index)
{
    auto& impl = *instance;
    impl.pumpFromProcessor();
    if (index < 0 || static_cast<size_t> (index) >= impl.parameters.size())
        return {};
    auto& p = impl.parameters[static_cast<size_t> (index)];
    String128 text = {};
    if (impl.controller->getParamStringByValue (p.id, impl.controller->getParamNormalized (p.id), text) != kResultOk)
        return {};
    auto out = utf16ToUtf8 (text);
    return p.units.empty() ? out : out + " " + p.units;
}

bool Vst3Insert::setParameterValue (int index, float value)
{
    auto& impl = *instance;
    if (index < 0 || static_cast<size_t> (index) >= impl.parameters.size())
        return false;
    auto& p = impl.parameters[static_cast<size_t> (index)];
    if (p.info.readOnly)
        return false;
    auto normalized = std::clamp (static_cast<double> (value), 0.0, 1.0);
    if (impl.controller->setParamNormalized (p.id, normalized) != kResultOk)
        return false;
    impl.toProcessor.push ({ p.id, normalized });
    return true;
}

bool Vst3Insert::refreshLatency()
{
    auto& impl = *instance;
    impl.pumpFromProcessor();
    if (! impl.active)
        return false;
    impl.latencyMayHaveChanged.store (false);
    auto now = static_cast<int> (impl.processor->getLatencySamples());
    if (now == impl.latency.load())
        return false;
    impl.latency.store (now);
    return true;
}

bool Vst3Insert::getState (std::vector<uint8_t>& out)
{
    auto* stream = new MemoryStream();
    auto ok = instance->component->getState (stream) == kResultOk;
    out = stream->data;
    stream->release();
    return ok;
}

bool Vst3Insert::setState (const std::vector<uint8_t>& data)
{
    auto* stream = new MemoryStream (data);
    auto ok = instance->component->setState (stream) == kResultOk;
    if (ok && instance->separateController)
    {
        stream->seek (0, IBStream::kIBSeekSet, nullptr);
        instance->controller->setComponentState (stream);
    }
    stream->release();
    return ok;
}

} // namespace ghostdaw
