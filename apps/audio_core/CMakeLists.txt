cmake_minimum_required(VERSION 3.20)
project(GhostDAW VERSION 1.0.0 LANGUAGES C CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

# LPI plugin ABI header (vendored from v-loudio-t; see third_party/lpi/README.md)
set(LPI_INCLUDE_DIR "${CMAKE_CURRENT_SOURCE_DIR}/third_party/lpi/include" CACHE PATH "Directory containing lpi/lpi.h")

option(GHOSTDAW_BUILD_TESTS "Build the tests and their test plugins" OFF)

# GhostDAW is built on its own code and permissively licensed sources alone
# (CLAUDE.md, "Dependencies: we own what we ship"): no framework.

# Our own platform layer: sockets and the WebSocket server, the message
# loop, files, dynamic libraries, logging, JSON, pairing.
add_library(ghostdaw_platform STATIC
    src/platform/Base64.cpp
    src/platform/ChildProcess.cpp
    src/platform/Deflate.cpp
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
# src/host), the audio device over miniaudio (third_party/miniaudio,
# public domain or MIT-0; see its README), VST 3 hosting over the SDK's
# interfaces (third_party/vst3/pluginterfaces, MIT; see its README) and,
# on macOS, Audio Units over AudioToolbox
add_library(ghostdaw_host STATIC
    src/host/AudioDevice.cpp
    src/host/AuPlugin.cpp
    src/host/PluginRegistry.cpp
    src/host/PluginScanner.cpp
    src/host/Vst3Iids.cpp
    src/host/Vst3Plugin.cpp
    third_party/miniaudio/miniaudio.c
    third_party/vst3/pluginterfaces/base/coreiids.cpp
    third_party/vst3/pluginterfaces/base/funknown.cpp)
target_include_directories(ghostdaw_host PUBLIC src third_party/miniaudio "${LPI_INCLUDE_DIR}")
target_include_directories(ghostdaw_host SYSTEM PUBLIC third_party/vst3)
target_link_libraries(ghostdaw_host PUBLIC ghostdaw_platform)
if(WIN32)
    # miniaudio links WASAPI and friends at run time
elseif(APPLE)
    # miniaudio links CoreAudio at run time; CoreFoundation for the device
    # names and the VST 3 bundles; AudioToolbox for the Audio Units
    target_link_libraries(ghostdaw_host PUBLIC "-framework CoreFoundation" "-framework AudioToolbox" "-framework CoreAudio")
else()
    target_link_libraries(ghostdaw_host PUBLIC m ${CMAKE_DL_LIBS})
endif()
set_source_files_properties(third_party/miniaudio/miniaudio.c third_party/vst3/pluginterfaces/base/coreiids.cpp third_party/vst3/pluginterfaces/base/funknown.cpp
    PROPERTIES COMPILE_OPTIONS "$<$<NOT:$<CXX_COMPILER_ID:MSVC>>:-w>")
target_compile_options(ghostdaw_host PRIVATE $<$<COMPILE_LANGUAGE:CXX>:$<IF:$<CXX_COMPILER_ID:MSVC>,/W4,-Wall;-Wextra;-Wshadow;-Wconversion;-Wno-sign-conversion>>)

add_executable(ghostdaw src/ghostdaw_main.cpp)
target_link_libraries(ghostdaw PRIVATE ghostdaw_host)
target_include_directories(ghostdaw PRIVATE "${LPI_INCLUDE_DIR}")
ghostdaw_warnings(ghostdaw)

if(GHOSTDAW_BUILD_TESTS)
    add_subdirectory(tests)
endif()
