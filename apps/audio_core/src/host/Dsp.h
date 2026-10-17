#pragma once

#include <algorithm>
#include <cmath>
#include <cstring>
#include <vector>

namespace ghostdaw
{

// A planar float buffer: channels of frames. Allocates only in setSize(),
// never on the audio thread.
class AudioBuffer
{
public:
    AudioBuffer() = default;
    AudioBuffer (int channels, int frames) { setSize (channels, frames); }

    // Reallocates and clears
    void setSize (int channels, int frames)
    {
        numChannels = std::max (0, channels);
        numFrames = std::max (0, frames);
        data.assign (static_cast<size_t> (numChannels) * static_cast<size_t> (numFrames), 0.0f);
        pointers.resize (static_cast<size_t> (numChannels));
        for (int ch = 0; ch < numChannels; ++ch)
            pointers[static_cast<size_t> (ch)] = data.data() + static_cast<size_t> (ch) * static_cast<size_t> (numFrames);
    }

    int getNumChannels() const { return numChannels; }
    int getNumSamples() const { return numFrames; }

    float* getWritePointer (int channel) { return pointers[static_cast<size_t> (channel)]; }
    const float* getReadPointer (int channel) const { return pointers[static_cast<size_t> (channel)]; }
    float* const* getArrayOfWritePointers() { return pointers.data(); }
    const float* const* getArrayOfReadPointers() const { return const_cast<const float* const*> (pointers.data()); }

    float getSample (int channel, int index) const { return pointers[static_cast<size_t> (channel)][index]; }
    void setSample (int channel, int index, float value) { pointers[static_cast<size_t> (channel)][index] = value; }
    void addSample (int channel, int index, float value) { pointers[static_cast<size_t> (channel)][index] += value; }

    void clear()
    {
        std::fill (data.begin(), data.end(), 0.0f);
    }

    void clear (int start, int count)
    {
        for (int ch = 0; ch < numChannels; ++ch)
            std::memset (pointers[static_cast<size_t> (ch)] + start, 0, static_cast<size_t> (count) * sizeof (float));
    }

    // The largest absolute sample over `count` frames from `start`
    float getMagnitude (int start, int count) const
    {
        float peak = 0.0f;
        for (int ch = 0; ch < numChannels; ++ch)
            for (int i = start; i < start + count; ++i)
                peak = std::max (peak, std::fabs (pointers[static_cast<size_t> (ch)][i]));
        return peak;
    }

private:
    int numChannels = 0, numFrames = 0;
    std::vector<float> data;
    std::vector<float*> pointers;
};

// Operations on sample runs (the compiler vectorises these loops)
namespace dsp
{
inline void copy (float* dest, const float* source, int count) noexcept
{
    std::memcpy (dest, source, static_cast<size_t> (count) * sizeof (float));
}

inline void clear (float* dest, int count) noexcept
{
    std::memset (dest, 0, static_cast<size_t> (count) * sizeof (float));
}

inline void add (float* dest, const float* source, int count) noexcept
{
    for (int i = 0; i < count; ++i)
        dest[i] += source[i];
}

inline void multiply (float* dest, float gain, int count) noexcept
{
    for (int i = 0; i < count; ++i)
        dest[i] *= gain;
}

inline void clip (float* dest, float low, float high, int count) noexcept
{
    for (int i = 0; i < count; ++i)
        dest[i] = std::min (high, std::max (low, dest[i]));
}

// The largest |sample|
inline float peak (const float* source, int count) noexcept
{
    float result = 0.0f;
    for (int i = 0; i < count; ++i)
        result = std::max (result, std::fabs (source[i]));
    return result;
}
} // namespace dsp

} // namespace ghostdaw
