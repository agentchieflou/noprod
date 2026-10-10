// #44 B6a: latency spike for streaming a plugin editor to the browser.
// Serves a synthetic plugin editor through EditorStreamer on
// ws://localhost:8084 (size from --size WxH, default 800x600). The browser
// side is apps/frontend/editor-spike.html, which measures every stage of
// render -> encode -> send -> decode -> paint and the input round trip.

#include <JuceHeader.h>
#include <atomic>
#include <iostream>
#if JUCE_LINUX || JUCE_MAC || JUCE_BSD
 #include <csignal>
#endif

#include "HapWebSocketServer.h"
#include "editor/EditorStream.h"

// Stands in for a plugin editor: a reverb-like panel with knobs, a meter and
// a waveform that animate on their own, and a knob that follows mouse drags.
class SyntheticEditor : public FrameSource
{
public:
    SyntheticEditor (int w, int h) : width (w), height (h), image (juce::Image::ARGB, w, h, true, juce::SoftwareImageType()) {}

    int getWidth() const override { return width; }
    int getHeight() const override { return height; }

    void mouse (const juce::String& kind, float x, float y, int) override
    {
        if (kind == "down")
            dragFromY = y;
        else if (kind == "move" && dragFromY.load() >= 0.0f)
            dragValue.store (juce::jlimit (0.0f, 1.0f, dragValue.load() + (dragFromY.load() - y) / 200.0f)), dragFromY.store (y);
        else if (kind == "up")
            dragFromY = -1.0f;
        mouseX = x;
        mouseY = y;
    }

    bool render (uint8_t* rgba) override
    {
        draw();
        imageToRgba (image, rgba);
        return true;
    }

private:
    void draw()
    {
        juce::Graphics g (image);
        auto bounds = image.getBounds().toFloat();
        auto t = juce::Time::getMillisecondCounterHiRes() / 1000.0;

        g.setGradientFill (juce::ColourGradient (juce::Colour (0xff1d2330), 0, 0, juce::Colour (0xff0d1017), 0, bounds.getHeight(), false));
        g.fillAll();

        g.setColour (juce::Colours::white);
        g.setFont (juce::FontOptions (bounds.getHeight() * 0.06f, juce::Font::bold));
        g.drawText ("Loudio Reverb", bounds.removeFromTop (bounds.getHeight() * 0.14f).reduced (16, 0), juce::Justification::centredLeft);

        // Knobs: the first follows the mouse, the rest drift
        auto knobArea = bounds.removeFromTop (bounds.getHeight() * 0.55f).reduced (12);
        const char* names[] = { "Size", "Decay", "Damping", "Pre-delay", "Width", "Mix" };
        auto knobWidth = knobArea.getWidth() / 6.0f;
        for (int i = 0; i < 6; ++i)
        {
            auto cell = knobArea.withX (knobArea.getX() + i * knobWidth).withWidth (knobWidth).reduced (8);
            auto value = i == 0 ? dragValue.load() : static_cast<float> (0.5 + 0.4 * std::sin (t * (0.3 + i * 0.17)));
            auto knob = cell.withSizeKeepingCentre (juce::jmin (cell.getWidth(), cell.getHeight() * 0.75f), juce::jmin (cell.getWidth(), cell.getHeight() * 0.75f));
            auto start = juce::MathConstants<float>::pi * 1.25f, end = start + juce::MathConstants<float>::pi * 1.5f;
            juce::Path track, fill;
            track.addCentredArc (knob.getCentreX(), knob.getCentreY(), knob.getWidth() * 0.42f, knob.getWidth() * 0.42f, 0, start, end, true);
            fill.addCentredArc (knob.getCentreX(), knob.getCentreY(), knob.getWidth() * 0.42f, knob.getWidth() * 0.42f, 0, start, start + (end - start) * value, true);
            g.setColour (juce::Colour (0xff384152));
            g.strokePath (track, juce::PathStrokeType (knob.getWidth() * 0.08f, juce::PathStrokeType::curved, juce::PathStrokeType::rounded));
            g.setColour (juce::Colour (0xff3b82f6));
            g.strokePath (fill, juce::PathStrokeType (knob.getWidth() * 0.08f, juce::PathStrokeType::curved, juce::PathStrokeType::rounded));
            g.setColour (juce::Colours::lightgrey);
            g.setFont (juce::FontOptions (juce::jmax (10.0f, cell.getHeight() * 0.1f)));
            g.drawText (names[i], cell.removeFromBottom (cell.getHeight() * 0.2f), juce::Justification::centred);
        }

        // Waveform and meter
        auto scope = bounds.reduced (16);
        auto meter = scope.removeFromRight (scope.getWidth() * 0.06f);
        juce::Path wave;
        for (int x = 0; x < static_cast<int> (scope.getWidth()); x += 2)
        {
            auto phase = x / scope.getWidth() * 12.0 + t * 3.0;
            auto y = scope.getCentreY() + scope.getHeight() * 0.4f * static_cast<float> (std::sin (phase) * std::exp (-std::fmod (phase, 6.28) * 0.2));
            x == 0 ? wave.startNewSubPath (scope.getX() + x, y) : wave.lineTo (scope.getX() + x, y);
        }
        g.setColour (juce::Colour (0xff22c55e));
        g.strokePath (wave, juce::PathStrokeType (2.0f));
        auto level = static_cast<float> (0.5 + 0.45 * std::sin (t * 4.0));
        g.setColour (juce::Colour (0xff384152));
        g.fillRect (meter.reduced (4, 0));
        g.setColour (juce::Colour (0xffeab308));
        g.fillRect (meter.reduced (4, 0).removeFromBottom (meter.getHeight() * level));

        // Cursor
        g.setColour (juce::Colours::white.withAlpha (0.8f));
        g.drawEllipse (mouseX.load() - 6, mouseY.load() - 6, 12, 12, 2.0f);
    }

    int width, height;
    juce::Image image;
    std::atomic<float> dragValue { 0.3f }, dragFromY { -1.0f }, mouseX { -20.0f }, mouseY { -20.0f };
};

class EditorStreamSpikeApp : public juce::JUCEApplication
{
public:
    const juce::String getApplicationName() override { return "EditorStreamSpike"; }
    const juce::String getApplicationVersion() override { return "1.0.0"; }

    void initialise (const juce::String& commandLine) override
    {
       #if JUCE_LINUX || JUCE_MAC || JUCE_BSD
        std::signal (SIGPIPE, SIG_IGN);
       #endif
        auto args = juce::StringArray::fromTokens (commandLine, true);
        auto sizeArg = args.indexOf ("--size");
        int w = 800, h = 600;
        if (sizeArg >= 0 && sizeArg + 1 < args.size())
        {
            w = args[sizeArg + 1].upToFirstOccurrenceOf ("x", false, false).getIntValue();
            h = args[sizeArg + 1].fromFirstOccurrenceOf ("x", false, false).getIntValue();
        }
        w = juce::jlimit (64, 4096, w);
        h = juce::jlimit (64, 4096, h);

        server = std::make_unique<HapWebSocketServer> (8084, makeEditorStreamHandlers ([w, h] (const juce::var&) { return std::make_unique<SyntheticEditor> (w, h); }));
        server->startThread();
        std::cout << "Editor stream spike: " << w << "x" << h << " on ws://localhost:8084" << std::endl;
    }

    void shutdown() override { server.reset(); }

private:
    std::unique_ptr<HapWebSocketServer> server;
};

START_JUCE_APPLICATION (EditorStreamSpikeApp)
