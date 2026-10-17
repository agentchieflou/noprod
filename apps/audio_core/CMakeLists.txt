cmake_minimum_required(VERSION 3.20)
project(GhostDAW VERSION 1.0.0 LANGUAGES C CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

# LPI plugin ABI header (vendored from v-loudio-t; see third_party/lpi/README.md)
set(LPI_INCLUDE_DIR "${CMAKE_CURRENT_SOURCE_DIR}/third_party/lpi/include" CACHE PATH "Directory containing lpi/lpi.h")

option(GHOSTDAW_BUILD_TESTS "Build the tests and their test plugins" OFF)
option(GHOSTDAW_BUILD_TOOLS "Build development tools (the editor streaming latency spike)" OFF)

# GhostDAW is being rebuilt without JUCE (#134). The JUCE host below keeps
# building until the switch; -DGHOSTDAW_JUCE_HOST=OFF builds only the new
# targets, with no submodule needed.
option(GHOSTDAW_JUCE_HOST "Build the JUCE host (being replaced)" ON)

# ------------------------------------------------------------ the new host
# Our own platform layer: sockets and the WebSocket server, the message
# loop, files, dynamic libraries, logging, JSON, pairing.
add_library(ghostdaw_platform STATIC
    src/platform/Base64.cpp
    src/platform/DynamicLibrary.cpp
    src/platform/Files.cpp
    src/platform/Json.cpp
    src/platform/Log.cpp
    src/platform/Loop.cpp
    src/platform/Pairing.cpp
    src/platform/Platform.cpp
    src/platform/Process.cpp
    src/platform/Random.cpp
    src/platform/Sha1.cpp
    src/platform/Sockets.cpp
    src/platform/Strings.cpp
    src/platform/WebSocketServer.cpp)
target_include_directories(ghostdaw_platform PUBLIC src)
find_package(Threads REQUIRED)
target_link_libraries(ghostdaw_platform PUBLIC Threads::Threads)
if(WIN32)
    target_link_libraries(ghostdaw_platform PUBLIC ws2_32 iphlpapi bcrypt shell32 ole32)
    target_compile_definitions(ghostdaw_platform PUBLIC _CRT_SECURE_NO_WARNINGS NOMINMAX WIN32_LEAN_AND_MEAN)
elseif(NOT APPLE)
    target_link_libraries(ghostdaw_platform PUBLIC ${CMAKE_DL_LIBS})
endif()

# The warnings every new target builds with
function(ghostdaw_warnings target)
    if(MSVC)
        target_compile_options(${target} PRIVATE /W4 /permissive- /utf-8)
    else()
        target_compile_options(${target} PRIVATE -Wall -Wextra -Wshadow -Wconversion -Wno-sign-conversion)
    endif()
endfunction()
ghostdaw_warnings(ghostdaw_platform)

# The host: the mixer, the insert chains, the hap engine (headers in
# src/host) and the audio device over miniaudio (third_party/miniaudio,
# public domain or MIT-0; see its README)
add_library(ghostdaw_host STATIC
    src/host/AudioDevice.cpp
    third_party/miniaudio/miniaudio.c)
target_include_directories(ghostdaw_host PUBLIC src third_party/miniaudio)
target_link_libraries(ghostdaw_host PUBLIC ghostdaw_platform)
if(WIN32)
    # miniaudio links WASAPI and friends at run time
elseif(APPLE)
    # miniaudio links CoreAudio at run time; CoreFoundation for the device names
    target_link_libraries(ghostdaw_host PUBLIC "-framework CoreFoundation")
else()
    target_link_libraries(ghostdaw_host PUBLIC m ${CMAKE_DL_LIBS})
endif()
set_source_files_properties(third_party/miniaudio/miniaudio.c PROPERTIES COMPILE_OPTIONS "$<$<NOT:$<CXX_COMPILER_ID:MSVC>>:-w>")
target_compile_options(ghostdaw_host PRIVATE $<$<COMPILE_LANGUAGE:CXX>:$<IF:$<CXX_COMPILER_ID:MSVC>,/W4,-Wall;-Wextra;-Wshadow;-Wconversion;-Wno-sign-conversion>>)

add_executable(ghostdaw src/ghostdaw_main.cpp)
target_link_libraries(ghostdaw PRIVATE ghostdaw_host)
target_include_directories(ghostdaw PRIVATE "${LPI_INCLUDE_DIR}")
ghostdaw_warnings(ghostdaw)

# ----------------------------------------------------------- the JUCE host
if(GHOSTDAW_JUCE_HOST)
    add_subdirectory(JUCE)

    juce_add_console_app(GhostDAW
        PRODUCT_NAME "GhostDAW"
        VERSION "1.0.0")
    juce_generate_juce_header(GhostDAW)
    target_sources(GhostDAW PRIVATE src/main.cpp)
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

    if(GHOSTDAW_BUILD_TOOLS)
        juce_add_console_app(EditorStreamSpike PRODUCT_NAME "EditorStreamSpike")
        juce_generate_juce_header(EditorStreamSpike)
        target_sources(EditorStreamSpike PRIVATE tools/EditorStreamSpike.cpp)
        target_include_directories(EditorStreamSpike PRIVATE src)
        target_compile_definitions(EditorStreamSpike PRIVATE JUCE_WEB_BROWSER=0 JUCE_USE_CURL=0)
        target_link_libraries(EditorStreamSpike PRIVATE juce::juce_core juce::juce_events juce::juce_graphics juce::juce_gui_basics)
    endif()
endif()

if(GHOSTDAW_BUILD_TESTS)
    add_subdirectory(tests)
endif()
