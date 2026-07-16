#pragma once

#include <JuceHeader.h>
#include <array>
#include <vector>

// Turns Strudel haps (as sent by the Sequencer's HAP_STREAM message) into
// audible sound. This is a deliberately simple synthesized engine, not a
// sample player or full JUCE Synthesiser voice architecture:
//   - Haps whose `note` parses as a pitch name (e.g. "c", "e4", "gs3") trigger
//     a short sine tone at that pitch.
//   - Anything else (e.g. "bd", "sd", "cp", "oh" -- common drum abbreviations)
//     triggers an enveloped noise burst, with a handful of recognized names
//     mapped to a distinct tone so a kick still sounds different from a hat.
//
// The wire format (HAP_STREAM) doesn't carry tempo, so hap `time`/`duration`
// (fractions of a cycle, per Strudel's queryArc) are scaled by an assumed
// fixed cycle length rather than the pattern's real cps/cpm. Precise tempo
// sync would require the Sequencer to also transmit the pattern's tempo.
class HapAudioEngine : public juce::AudioIODeviceCallback
{
public:
    // Schedules one cycle's worth of haps, in JSON form:
    // [{ "time": 0, "duration": 0.5, "note": "bd", ... }, ...]
    // Safe to call from any thread.
    void scheduleHaps (const juce::var& haps)
    {
        if (auto* array = haps.getArray())
        {
            const juce::ScopedLock sl (lock);

            for (auto& hap : *array)
            {
                auto time = static_cast<double> (hap.getProperty ("time", 0.0));
                auto duration = static_cast<double> (hap.getProperty ("duration", 0.25));
                auto noteName = hap.getProperty ("note", juce::var()).toString();

                bool isPitched = false;
                double freqHz = noteNameToFrequency (noteName, isPitched);

                PendingEvent event;
                event.triggerSample = currentSamplePosition + static_cast<juce::int64> (time * assumedCycleSeconds * sampleRate);
                event.durationSeconds = juce::jmax (0.02, duration * assumedCycleSeconds);
                event.freqHz = freqHz;
                event.percussive = ! isPitched;
                pendingEvents.push_back (event);
            }
        }
    }

    void audioDeviceAboutToStart (juce::AudioIODevice* device) override
    {
        sampleRate = device->getCurrentSampleRate() > 0 ? device->getCurrentSampleRate() : 44100.0;
        currentSamplePosition = 0;
    }

    void audioDeviceStopped() override
    {
    }

    void audioDeviceIOCallbackWithContext (const float* const*, int,
                                            float* const* outputChannelData, int numOutputChannels,
                                            int numSamples, const juce::AudioIODeviceCallbackContext&) override
    {
        for (int ch = 0; ch < numOutputChannels; ++ch)
            if (outputChannelData[ch] != nullptr)
                juce::FloatVectorOperations::clear (outputChannelData[ch], numSamples);

        const juce::ScopedLock sl (lock);

        for (int n = 0; n < numSamples; ++n)
        {
            auto sampleIndex = currentSamplePosition + n;

            for (size_t i = 0; i < pendingEvents.size();)
            {
                if (pendingEvents[i].triggerSample <= sampleIndex)
                {
                    activateVoice (pendingEvents[i]);
                    pendingEvents.erase (pendingEvents.begin() + static_cast<long> (i));
                }
                else
                {
                    ++i;
                }
            }

            float mixed = 0.0f;
            for (auto& voice : voices)
            {
                if (! voice.active)
                    continue;

                mixed += renderVoiceSample (voice);

                if (--voice.samplesRemaining <= 0)
                    voice.active = false;
            }

            mixed = juce::jlimit (-1.0f, 1.0f, mixed);

            for (int ch = 0; ch < numOutputChannels; ++ch)
                if (outputChannelData[ch] != nullptr)
                    outputChannelData[ch][n] = mixed;
        }

        currentSamplePosition += numSamples;
    }

private:
    struct Voice
    {
        bool active = false;
        double phase = 0.0;
        double phaseIncrement = 0.0;
        int samplesRemaining = 0;
        int totalSamples = 1;
        bool percussive = false;
        juce::Random random;
    };

    struct PendingEvent
    {
        juce::int64 triggerSample = 0;
        double durationSeconds = 0.1;
        double freqHz = 440.0;
        bool percussive = false;
    };

    static constexpr int maxVoices = 16;
    static constexpr double assumedCycleSeconds = 2.0;

    std::array<Voice, maxVoices> voices;
    std::vector<PendingEvent> pendingEvents;
    juce::CriticalSection lock;
    double sampleRate = 44100.0;
    juce::int64 currentSamplePosition = 0;

    void activateVoice (const PendingEvent& event)
    {
        // Steal the oldest-triggered voice (lowest samplesRemaining) if all are busy.
        size_t slot = 0;
        for (size_t i = 0; i < voices.size(); ++i)
        {
            if (! voices[i].active) { slot = i; break; }
            if (voices[i].samplesRemaining < voices[slot].samplesRemaining) slot = i;
        }

        auto& voice = voices[slot];
        voice.active = true;
        voice.phase = 0.0;
        voice.phaseIncrement = juce::MathConstants<double>::twoPi * event.freqHz / sampleRate;
        voice.totalSamples = juce::jmax (1, static_cast<int> (event.durationSeconds * sampleRate));
        voice.samplesRemaining = voice.totalSamples;
        voice.percussive = event.percussive;
    }

    static float renderVoiceSample (Voice& voice)
    {
        auto envelope = static_cast<float> (voice.samplesRemaining) / static_cast<float> (voice.totalSamples);

        float raw;
        if (voice.percussive)
        {
            raw = voice.random.nextFloat() * 2.0f - 1.0f;
            envelope *= envelope; // steeper decay reads as more percussive
        }
        else
        {
            raw = static_cast<float> (std::sin (voice.phase));
        }

        voice.phase += voice.phaseIncrement;
        return raw * envelope * 0.4f;
    }

    // Parses Strudel-style note names (e.g. "c", "cs3", "ef4"). Returns the
    // frequency in Hz and sets isNote=true if it parsed as a pitch; otherwise
    // returns a fixed, recognizable frequency for common drum abbreviations
    // (or a generic click frequency for anything unrecognized) with
    // isNote=false.
    static double noteNameToFrequency (const juce::String& name, bool& isNote)
    {
        auto lower = name.trim().toLowerCase();

        if (lower.isNotEmpty())
        {
            auto letter = lower[0];
            if (letter >= 'a' && letter <= 'g')
            {
                static const int semitoneFromC[] = { 9, 11, 0, 2, 4, 5, 7 }; // a..g
                int semitone = semitoneFromC[letter - 'a'];

                int i = 1;
                if (i < lower.length() && (lower[i] == 's' || lower[i] == '#')) { semitone += 1; ++i; }
                else if (i < lower.length() && lower[i] == 'f')                 { semitone -= 1; ++i; }

                // Only treat this as a pitch if there's nothing left over but an
                // optional octave number -- otherwise a drum abbreviation that
                // happens to start with a note letter (e.g. "bd", "cp", "ch")
                // would be misread as that note.
                auto remainder = lower.substring (i);
                bool hasValidOctave = remainder.isEmpty() || remainder.containsOnly ("0123456789");

                if (hasValidOctave)
                {
                    int octave = remainder.isEmpty() ? 5 : remainder.getIntValue();
                    int midiNote = (octave + 1) * 12 + semitone;
                    isNote = true;
                    return 440.0 * std::pow (2.0, (midiNote - 69) / 12.0);
                }
            }
        }

        isNote = false;
        if (lower == "bd" || lower == "kick")            return 60.0;
        if (lower == "sd" || lower == "sn" || lower == "snare") return 200.0;
        if (lower == "cp" || lower == "clap")            return 1200.0;
        if (lower == "oh" || lower == "openhat")         return 3000.0;
        if (lower == "hh" || lower == "ch" || lower == "closedhat") return 3500.0;
        if (lower == "rim")                              return 900.0;
        return 800.0;
    }
};
