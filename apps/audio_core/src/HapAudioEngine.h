#pragma once

#include <JuceHeader.h>
#include <array>
#include <atomic>
#include <mutex>
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
// Each hap plays on a track (its `trackIndex`, which the Sequencer takes from
// Strudel's .orbit()), rendered into that track's own stereo buffer so the
// Mixer can run per-track inserts before summing.
//
// The wire format (HAP_STREAM) doesn't carry tempo, so hap `time`/`duration`
// (fractions of a cycle, per Strudel's queryArc) are scaled by an assumed
// fixed cycle length rather than the pattern's real cps/cpm. Precise tempo
// sync would require the Sequencer to also transmit the pattern's tempo.
//
// Threading: scheduleHaps may be called from any thread; it hands events to
// the audio thread through a lock-free FIFO, so render() never blocks.
class HapAudioEngine
{
public:
    static constexpr int maxTracks = 16;

    HapAudioEngine()
    {
        pendingEvents.reserve (fifoCapacity);
        for (auto& buffer : trackBuffers)
            buffer.setSize (2, 512);
    }

    // Schedules one cycle's worth of haps, in JSON form, starting now:
    // [{ "time": 0, "duration": 0.5, "note": "bd", "trackIndex": 1 }, ...]
    void scheduleHaps (const juce::var& haps)
    {
        auto* array = haps.getArray();
        if (array == nullptr)
            return;

        std::lock_guard<std::mutex> producer (producerLock); // producers only; the audio thread never takes it

        for (auto& hap : *array)
        {
            auto noteName = hap.getProperty ("note", juce::var()).toString();
            bool isPitched = false;

            Event event;
            event.offsetSeconds = static_cast<double> (hap.getProperty ("time", 0.0)) * assumedCycleSeconds;
            event.durationSeconds = juce::jmax (0.02, static_cast<double> (hap.getProperty ("duration", 0.25)) * assumedCycleSeconds);
            event.freqHz = noteNameToFrequency (noteName, isPitched);
            event.percussive = ! isPitched;
            event.track = juce::jlimit (0, maxTracks - 1, static_cast<int> (hap.getProperty ("trackIndex", 0)));

            const auto scope = fifo.write (1);
            if (scope.blockSize1 + scope.blockSize2 == 0)
            {
                ++droppedEvents;
                continue;
            }
            fifoData[static_cast<size_t> (scope.blockSize1 > 0 ? scope.startIndex1 : scope.startIndex2)] = event;
        }
    }

    // Called before audio starts (or when the device changes).
    void prepare (double newSampleRate, int maxBlockSize)
    {
        sampleRate = newSampleRate > 0 ? newSampleRate : 44100.0;
        blockSize = juce::jmax (1, maxBlockSize);
        for (auto& buffer : trackBuffers)
            buffer.setSize (2, blockSize);
        currentSamplePosition = 0;
        for (auto& voice : voices)
            voice.active = false;
        pendingEvents.clear();
    }

    int getMaxBlockSize() const { return blockSize; }
    int getDroppedEvents() const { return droppedEvents.load(); }

    // Audio thread: renders numSamples (<= getMaxBlockSize()) into the
    // per-track buffers.
    void render (int numSamples) noexcept
    {
        drainFifo();

        for (int t = 0; t < maxTracks; ++t)
        {
            trackBuffers[static_cast<size_t> (t)].clear (0, numSamples);
            trackActive[static_cast<size_t> (t)] = false;
        }

        for (int n = 0; n < numSamples; ++n)
        {
            auto sampleIndex = currentSamplePosition + n;

            for (size_t i = 0; i < pendingEvents.size();)
            {
                if (pendingEvents[i].triggerSample <= sampleIndex)
                {
                    activateVoice (pendingEvents[i]);
                    pendingEvents[i] = pendingEvents.back(); // order doesn't matter; no allocation
                    pendingEvents.pop_back();
                }
                else
                {
                    ++i;
                }
            }

            for (auto& voice : voices)
            {
                if (! voice.active)
                    continue;

                auto sample = renderVoiceSample (voice);
                auto& buffer = trackBuffers[static_cast<size_t> (voice.track)];
                buffer.addSample (0, n, sample);
                buffer.addSample (1, n, sample);
                trackActive[static_cast<size_t> (voice.track)] = true;

                if (--voice.samplesRemaining <= 0)
                    voice.active = false;
            }
        }

        currentSamplePosition += numSamples;
    }

    float* const* getTrackChannels (int track) { return trackBuffers[static_cast<size_t> (track)].getArrayOfWritePointers(); }

    // Whether the track made any sound in the last render()
    bool isTrackActive (int track) const { return trackActive[static_cast<size_t> (track)]; }

private:
    struct Voice
    {
        bool active = false;
        double phase = 0.0;
        double phaseIncrement = 0.0;
        int samplesRemaining = 0;
        int totalSamples = 1;
        bool percussive = false;
        int track = 0;
        juce::Random random;
    };

    struct Event
    {
        double offsetSeconds = 0.0;   // from when the audio thread picks it up
        double durationSeconds = 0.1;
        double freqHz = 440.0;
        bool percussive = false;
        int track = 0;
        juce::int64 triggerSample = 0; // set by the audio thread
    };

    static constexpr int maxVoices = 16;
    static constexpr int fifoCapacity = 4096;
    static constexpr double assumedCycleSeconds = 2.0;

    std::array<Voice, maxVoices> voices;

    juce::AbstractFifo fifo { fifoCapacity };
    std::array<Event, fifoCapacity> fifoData;
    std::mutex producerLock;
    std::atomic<int> droppedEvents { 0 };

    std::vector<Event> pendingEvents; // audio thread only, capacity reserved up front
    std::array<juce::AudioBuffer<float>, maxTracks> trackBuffers;
    std::array<bool, maxTracks> trackActive {};

    double sampleRate = 44100.0;
    int blockSize = 512;
    juce::int64 currentSamplePosition = 0;

    // Moves newly scheduled haps onto the audio thread's pending list, timed
    // from the current sample position.
    void drainFifo() noexcept
    {
        const auto scope = fifo.read (fifo.getNumReady());
        auto take = [this] (int start, int count)
        {
            for (int i = start; i < start + count; ++i)
            {
                auto event = fifoData[static_cast<size_t> (i)];
                if (pendingEvents.size() == pendingEvents.capacity())
                {
                    ++droppedEvents;
                    continue;
                }
                event.triggerSample = currentSamplePosition + static_cast<juce::int64> (event.offsetSeconds * sampleRate);
                pendingEvents.push_back (event);
            }
        };
        take (scope.startIndex1, scope.blockSize1);
        take (scope.startIndex2, scope.blockSize2);
    }

    void activateVoice (const Event& event)
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
        voice.track = event.track;
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
