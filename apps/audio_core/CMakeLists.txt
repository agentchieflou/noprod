cmake_minimum_required(VERSION 3.20)
project(GhostDAW VERSION 1.0.0)

# Add JUCE as a subdirectory (from the git submodule)
add_subdirectory(JUCE)

juce_add_console_app(GhostDAW
    PRODUCT_NAME "GhostDAW"
    VERSION "1.0.0")

juce_generate_juce_header(GhostDAW)

target_sources(GhostDAW PRIVATE
    src/main.cpp
)

target_compile_definitions(GhostDAW
    PUBLIC
        JUCE_WEB_BROWSER=0
        JUCE_USE_CURL=0
        JUCE_PLUGINHOST_VST3=1
        JUCE_PLUGINHOST_AU=1 # If on mac
)

target_link_libraries(GhostDAW
    PRIVATE
        juce::juce_core
        juce::juce_audio_basics
        juce::juce_audio_devices
        juce::juce_audio_formats
        juce::juce_audio_processors
        juce::juce_events
)
