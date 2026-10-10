#pragma once

#include <JuceHeader.h>
#include <memory>

#include "InsertProcessor.h"

// A VST3 (or AU) plugin hosted through JUCE's AudioPluginInstance, as an
// insert. Parameters are exposed normalized (0..1), with the plugin's own
// text for display. The chain's transport reaches the plugin through its
// AudioPlayHead.
class JucePluginInsert : public InsertProcessor
{
public:
    JucePluginInsert (std::unique_ptr<juce::AudioPluginInstance> pluginInstance, juce::String pluginPath)
        : instance (std::move (pluginInstance)), path (std::move (pluginPath))
    {
        instance->setPlayHead (&playHead);
    }

    ~JucePluginInsert() override
    {
        if (prepared)
            instance->releaseResources();
        instance->setPlayHead (nullptr);
    }

    juce::String getName() const override { return instance->getName(); }
    juce::String getFormat() const override { return instance->getPluginDescription().pluginFormatName; }
    juce::String getPath() const override { return path; }
    int getLatencySamples() const override { return instance->getLatencySamples(); }

    bool prepare (double sampleRate, int maxBlockSize, juce::String&) override
    {
        if (prepared && sampleRate == preparedRate && maxBlockSize == preparedBlockSize)
            return true;

        if (prepared)
            instance->releaseResources();

        instance->enableAllBuses();
        instance->setRateAndBufferSizeDetails (sampleRate, maxBlockSize);
        instance->prepareToPlay (sampleRate, maxBlockSize);

        auto channels = juce::jmax (2, instance->getTotalNumInputChannels(), instance->getTotalNumOutputChannels());
        buffer.setSize (channels, maxBlockSize);
        midi.ensureSize (256);

        prepared = true;
        preparedRate = sampleRate;
        preparedBlockSize = maxBlockSize;
        return true;
    }

    // Audio thread, before process(): what the play head reports during it
    void setTransport (const TransportInfo& t) noexcept override
    {
        playHead.transport = t;
        playHead.known = true;
    }

    void process (const float* const* inputs, float* const* outputs, int numChannels, int numSamples) noexcept override
    {
        auto channels = juce::jmin (numChannels, buffer.getNumChannels());

        // Process in a buffer the plugin owns: it may have more channels than
        // the bus, and processBlock works in place.
        for (int ch = 0; ch < buffer.getNumChannels(); ++ch)
        {
            if (ch < channels)
                juce::FloatVectorOperations::copy (buffer.getWritePointer (ch), inputs[ch], numSamples);
            else
                juce::FloatVectorOperations::clear (buffer.getWritePointer (ch), numSamples);
        }

        juce::AudioBuffer<float> block (buffer.getArrayOfWritePointers(), buffer.getNumChannels(), numSamples);
        midi.clear();
        instance->processBlock (block, midi);

        auto outputChannels = juce::jmin (channels, instance->getTotalNumOutputChannels());
        for (int ch = 0; ch < outputChannels; ++ch)
            juce::FloatVectorOperations::copy (outputs[ch], block.getReadPointer (ch), numSamples);
    }

    std::vector<PluginParameterInfo> getParameters() override
    {
        std::vector<PluginParameterInfo> result;
        auto& params = instance->getParameters();

        for (int i = 0; i < params.size(); ++i)
        {
            auto* param = params[i];
            PluginParameterInfo p;
            p.index = i;
            if (auto* hosted = dynamic_cast<juce::HostedAudioProcessorParameter*> (param))
                p.id = hosted->getParameterID();
            p.name = param->getName (64);
            p.minValue = 0.0f;
            p.maxValue = 1.0f;
            p.defaultValue = param->getDefaultValue();
            p.boolean = param->isBoolean();
            p.stepped = param->isDiscrete() || param->getNumSteps() < juce::AudioProcessor::getDefaultNumParameterSteps();
            result.push_back (p);
        }

        return result;
    }

    float getParameterValue (int index) override
    {
        auto* param = parameter (index);
        return param != nullptr ? param->getValue() : 0.0f;
    }

    juce::String getParameterText (int index) override
    {
        auto* param = parameter (index);
        if (param == nullptr)
            return {};
        auto text = param->getCurrentValueAsText();
        auto label = param->getLabel();
        return label.isNotEmpty() ? text + " " + label : text;
    }

    bool setParameterValue (int index, float value) override
    {
        auto* param = parameter (index);
        if (param == nullptr)
            return false;
        param->setValueNotifyingHost (juce::jlimit (0.0f, 1.0f, value));
        return true;
    }

    juce::AudioPluginInstance& getInstance() { return *instance; }

private:
    juce::AudioProcessorParameter* parameter (int index)
    {
        auto& params = instance->getParameters();
        return juce::isPositiveAndBelow (index, params.size()) ? params[index] : nullptr;
    }

    std::unique_ptr<juce::AudioPluginInstance> instance;
    juce::String path;
    juce::AudioBuffer<float> buffer;
    juce::MidiBuffer midi;
    // Read by the plugin on the audio thread, during processBlock: the same
    // thread that sets it, so no locking
    struct PlayHead : public juce::AudioPlayHead
    {
        juce::Optional<PositionInfo> getPosition() const override
        {
            if (! known)
                return {};
            PositionInfo info;
            if ((transport.flags & TransportInfo::tempoValid) != 0)
                info.setBpm (transport.tempoBpm);
            if ((transport.flags & TransportInfo::ppqValid) != 0)
                info.setPpqPosition (transport.ppqPosition);
            info.setIsPlaying ((transport.flags & TransportInfo::playing) != 0);
            info.setIsLooping ((transport.flags & TransportInfo::looping) != 0);
            return info;
        }

        TransportInfo transport;
        bool known = false;
    };

    bool prepared = false;
    double preparedRate = 0.0;
    int preparedBlockSize = 0;
    PlayHead playHead;
};
