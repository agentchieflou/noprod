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

# LPI plugin ABI header (vendored from v-loudio-t; see third_party/lpi/README.md)
set(LPI_INCLUDE_DIR "${CMAKE_CURRENT_SOURCE_DIR}/third_party/lpi/include" CACHE PATH "Directory containing lpi/lpi.h")
target_include_directories(GhostDAW PRIVATE "${LPI_INCLUDE_DIR}")

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

option(GHOSTDAW_BUILD_TOOLS "Build development tools (the editor streaming latency spike)" OFF)
if(GHOSTDAW_BUILD_TOOLS)
    juce_add_console_app(EditorStreamSpike PRODUCT_NAME "EditorStreamSpike")
    juce_generate_juce_header(EditorStreamSpike)
    target_sources(EditorStreamSpike PRIVATE tools/EditorStreamSpike.cpp)
    target_include_directories(EditorStreamSpike PRIVATE src)
    target_compile_definitions(EditorStreamSpike PRIVATE JUCE_WEB_BROWSER=0 JUCE_USE_CURL=0)
    target_link_libraries(EditorStreamSpike PRIVATE juce::juce_core juce::juce_events juce::juce_graphics juce::juce_gui_basics)
endif()

option(GHOSTDAW_BUILD_TESTS "Build the plugin-hosting tests and their test plugins" OFF)
if(GHOSTDAW_BUILD_TESTS)
    add_subdirectory(tests)
endif()
