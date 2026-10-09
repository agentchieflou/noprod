// VST3 test plugin for the audio_core host tests: stereo gain, one
// parameter ("gain", 0..1, default 1). Built with JUCE so the tests can host
// a real VST3 bundle on any platform.

#include <JuceHeader.h>

class TestGainProcessor : public juce::AudioProcessor
{
public:
    TestGainProcessor()
        : AudioProcessor (BusesProperties()
                              .withInput ("Input", juce::AudioChannelSet::stereo(), true)
                              .withOutput ("Output", juce::AudioChannelSet::stereo(), true))
    {
        addParameter (gain = new juce::AudioParameterFloat (juce::ParameterID { "gain", 1 }, "Gain",
                                                            juce::NormalisableRange<float> (0.0f, 1.0f), 1.0f));
    }

    const juce::String getName() const override { return "NoProd Test Gain VST3"; }
    void prepareToPlay (double, int) override {}
    void releaseResources() override {}

    void processBlock (juce::AudioBuffer<float>& buffer, juce::MidiBuffer&) override
    {
        buffer.applyGain (gain->get());
    }

    bool isBusesLayoutSupported (const BusesLayout& layouts) const override
    {
        return layouts.getMainOutputChannelSet() == juce::AudioChannelSet::stereo()
            && layouts.getMainInputChannelSet() == layouts.getMainOutputChannelSet();
    }

    juce::AudioProcessorEditor* createEditor() override { return nullptr; }
    bool hasEditor() const override { return false; }
    bool acceptsMidi() const override { return false; }
    bool producesMidi() const override { return false; }
    double getTailLengthSeconds() const override { return 0.0; }
    int getNumPrograms() override { return 1; }
    int getCurrentProgram() override { return 0; }
    void setCurrentProgram (int) override {}
    const juce::String getProgramName (int) override { return {}; }
    void changeProgramName (int, const juce::String&) override {}

    void getStateInformation (juce::MemoryBlock& dest) override
    {
        juce::MemoryOutputStream (dest, true).writeFloat (gain->get());
    }

    void setStateInformation (const void* data, int size) override
    {
        if (size >= 4)
            *gain = juce::MemoryInputStream (data, static_cast<size_t> (size), false).readFloat();
    }

private:
    juce::AudioParameterFloat* gain;
};

juce::AudioProcessor* JUCE_CALLTYPE createPluginFilter()
{
    return new TestGainProcessor();
}
