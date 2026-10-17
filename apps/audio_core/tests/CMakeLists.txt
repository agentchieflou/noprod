# The tests (configure with -DGHOSTDAW_BUILD_TESTS=ON).
#
# ghostdaw_tests covers the new host: the platform layer (the WebSocket
# server over real sockets, JSON, the loop, pairing) and the host (the
# insert chains, the mixer, the hap engine, the audio device on the null
# backend, the watchdog). GhostDAWTests covers
# the JUCE host until the switch (#134). Both build their own test plugins:
# an LPI gain in three variants (good, wrong ABI major, no factory export),
# an LPI gain with an editor (and its polling and latency variants), and a
# VST 3 gain bundle: written against the SDK's interfaces for
# ghostdaw_tests, built with JUCE for GhostDAWTests.


foreach(variant IN ITEMS good bad_major no_export)
    set(target lpi_test_gain_${variant})
    add_library(${target} MODULE plugins/lpi_test_gain.cpp)
    target_include_directories(${target} PRIVATE "${LPI_INCLUDE_DIR}")
    set_target_properties(${target} PROPERTIES
        PREFIX ""
        CXX_VISIBILITY_PRESET hidden
        LIBRARY_OUTPUT_DIRECTORY "${CMAKE_CURRENT_BINARY_DIR}/lpi/${variant}")
endforeach()
target_compile_definitions(lpi_test_gain_bad_major PRIVATE LPI_TEST_BAD_MAJOR=1)
target_compile_definitions(lpi_test_gain_no_export PRIVATE LPI_TEST_NO_EXPORT=1)

# An LPI gain with an off-screen editor (lpi.gui.offscreen.v1), as is and in
# three variants: without lpi.params.changes.v1, with 64 samples of latency,
# and taking lpi.transport.v1
foreach(variant IN ITEMS gui gui_polling gui_latency gui_transport)
    add_library(lpi_test_${variant} MODULE plugins/lpi_test_gui.cpp)
    target_include_directories(lpi_test_${variant} PRIVATE "${LPI_INCLUDE_DIR}")
    set_target_properties(lpi_test_${variant} PROPERTIES
        PREFIX ""
        CXX_VISIBILITY_PRESET hidden
        LIBRARY_OUTPUT_DIRECTORY "${CMAKE_CURRENT_BINARY_DIR}/lpi/${variant}")
endforeach()
target_compile_definitions(lpi_test_gui_polling PRIVATE LPI_TEST_GUI_POLLING=1)
target_compile_definitions(lpi_test_gui_latency PRIVATE LPI_TEST_GUI_LATENCY=64)
target_compile_definitions(lpi_test_gui_transport PRIVATE LPI_TEST_GUI_TRANSPORT=1)

# Binaries that misbehave when loaded: one crashes in lpi_get_factory, one
# never returns from it. The scanner's child process takes the hit. They
# live in a folder of their own, which the JUCE host's tests (it loads
# plugins in-process) don't scan.
foreach(variant IN ITEMS crash hang)
    add_library(lpi_test_${variant} MODULE plugins/lpi_test_bad.cpp)
    target_include_directories(lpi_test_${variant} PRIVATE "${LPI_INCLUDE_DIR}")
    set_target_properties(lpi_test_${variant} PROPERTIES
        PREFIX ""
        CXX_VISIBILITY_PRESET hidden
        LIBRARY_OUTPUT_DIRECTORY "${CMAKE_CURRENT_BINARY_DIR}/lpi_bad/${variant}")
endforeach()
target_compile_definitions(lpi_test_crash PRIVATE LPI_TEST_CRASH=1)
target_compile_definitions(lpi_test_hang PRIVATE LPI_TEST_HANG=1)

# The VST 3 test plug-in, laid out as a bundle the way a VST 3 host finds
# it (Contents/<arch>/<name>.so, Contents/MacOS/<name> with an Info.plist,
# Contents/<arch>/<name>.vst3), in two builds: the component as its own
# controller, and a separate controller class
function(ghostdaw_vst3_test_bundle target name)
    add_library(${target} MODULE plugins/vst3_test_gain.cpp)
    target_include_directories(${target} SYSTEM PRIVATE ../third_party/vst3)
    set(bundle "${CMAKE_CURRENT_BINARY_DIR}/vst3/${name}.vst3")
    if(WIN32)
        if(CMAKE_SYSTEM_PROCESSOR MATCHES "ARM64|aarch64")
            set(arch arm64-win)
        elseif(CMAKE_SIZEOF_VOID_P EQUAL 8)
            set(arch x86_64-win)
        else()
            set(arch x86-win)
        endif()
        set(binaryDir "${bundle}/Contents/${arch}")
        set(suffix ".vst3")
    elseif(APPLE)
        set(binaryDir "${bundle}/Contents/MacOS")
        set(suffix "")
        file(WRITE "${bundle}/Contents/Info.plist"
"<?xml version=\"1.0\" encoding=\"UTF-8\"?>
<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">
<plist version=\"1.0\"><dict>
<key>CFBundleExecutable</key><string>${name}</string>
<key>CFBundleIdentifier</key><string>com.noprod.test.${target}</string>
<key>CFBundleName</key><string>${name}</string>
<key>CFBundlePackageType</key><string>BNDL</string>
<key>CFBundleVersion</key><string>1.0.0</string>
</dict></plist>
")
    else()
        if(CMAKE_SYSTEM_PROCESSOR MATCHES "aarch64|arm64")
            set(arch aarch64-linux)
        elseif(CMAKE_SYSTEM_PROCESSOR MATCHES "^arm")
            set(arch arm-linux)
        elseif(CMAKE_SYSTEM_PROCESSOR MATCHES "i[3-6]86")
            set(arch i386-linux)
        else()
            set(arch x86_64-linux)
        endif()
        set(binaryDir "${bundle}/Contents/${arch}")
        set(suffix ".so")
    endif()
    # ($<1:...> keeps multi-config generators from adding Release/ to it)
    set_target_properties(${target} PROPERTIES
        PREFIX ""
        SUFFIX "${suffix}"
        OUTPUT_NAME "${name}"
        CXX_VISIBILITY_PRESET hidden
        LIBRARY_OUTPUT_DIRECTORY "$<1:${binaryDir}>")
    set(${target}_BUNDLE "${bundle}" PARENT_SCOPE)
endfunction()
ghostdaw_vst3_test_bundle(vst3_test_gain "NoProd Test Gain")
ghostdaw_vst3_test_bundle(vst3_test_gain_separate "NoProd Test Gain Separate")
target_compile_definitions(vst3_test_gain_separate PRIVATE TEST_VST3_SEPARATE_CONTROLLER=1)

set(GHOSTDAW_TEST_PLUGIN_DEFINITIONS
    LPI_TEST_FOLDER="${CMAKE_CURRENT_BINARY_DIR}/lpi"
    LPI_TEST_BAD_FOLDER="${CMAKE_CURRENT_BINARY_DIR}/lpi_bad"
    VST3_TEST_GAIN_PATH="${vst3_test_gain_BUNDLE}"
    VST3_TEST_GAIN_SEPARATE_PATH="${vst3_test_gain_separate_BUNDLE}"
    LPI_TEST_GAIN_PATH="$<TARGET_FILE:lpi_test_gain_good>"
    LPI_TEST_BAD_MAJOR_PATH="$<TARGET_FILE:lpi_test_gain_bad_major>"
    LPI_TEST_NO_EXPORT_PATH="$<TARGET_FILE:lpi_test_gain_no_export>"
    LPI_TEST_GUI_PATH="$<TARGET_FILE:lpi_test_gui>"
    LPI_TEST_GUI_POLLING_PATH="$<TARGET_FILE:lpi_test_gui_polling>"
    LPI_TEST_GUI_LATENCY_PATH="$<TARGET_FILE:lpi_test_gui_latency>"
    LPI_TEST_GUI_TRANSPORT_PATH="$<TARGET_FILE:lpi_test_gui_transport>"
    LPI_TEST_CRASH_PATH="$<TARGET_FILE:lpi_test_crash>"
    LPI_TEST_HANG_PATH="$<TARGET_FILE:lpi_test_hang>")
set(GHOSTDAW_TEST_PLUGIN_TARGETS vst3_test_gain vst3_test_gain_separate lpi_test_gain_good lpi_test_gain_bad_major lpi_test_gain_no_export lpi_test_gui lpi_test_gui_polling lpi_test_gui_latency lpi_test_gui_transport lpi_test_crash lpi_test_hang)

# (plugins/au_test_gain.cpp is the Audio Unit test effect, registered in
# the test process on macOS; empty elsewhere)
add_executable(ghostdaw_tests main.cpp platform_tests.cpp host_tests.cpp plugin_tests.cpp plugins/au_test_gain.cpp)
target_link_libraries(ghostdaw_tests PRIVATE ghostdaw_host)
target_include_directories(ghostdaw_tests PRIVATE "${LPI_INCLUDE_DIR}")
target_compile_definitions(ghostdaw_tests PRIVATE GHOSTDAW_EXE_PATH="$<TARGET_FILE:ghostdaw>" ${GHOSTDAW_TEST_PLUGIN_DEFINITIONS})
add_dependencies(ghostdaw_tests ghostdaw ${GHOSTDAW_TEST_PLUGIN_TARGETS})
ghostdaw_warnings(ghostdaw_tests)
add_test(NAME ghostdaw_tests COMMAND ghostdaw_tests)

if(NOT GHOSTDAW_JUCE_HOST)
    return()
endif()
juce_add_plugin(TestGainVst3
    PRODUCT_NAME "NoProd Test Gain"
    COMPANY_NAME "NoProd"
    PLUGIN_MANUFACTURER_CODE Nopr
    PLUGIN_CODE Tgvn
    FORMATS VST3
    IS_SYNTH FALSE
    NEEDS_MIDI_INPUT FALSE
    COPY_PLUGIN_AFTER_BUILD FALSE)
juce_generate_juce_header(TestGainVst3)
target_sources(TestGainVst3 PRIVATE plugins/TestGainVst3.cpp)
target_compile_definitions(TestGainVst3 PUBLIC JUCE_WEB_BROWSER=0 JUCE_USE_CURL=0 JUCE_VST3_CAN_REPLACE_VST2=0)
target_link_libraries(TestGainVst3 PRIVATE juce::juce_audio_utils)

juce_add_console_app(GhostDAWTests PRODUCT_NAME "GhostDAWTests")
juce_generate_juce_header(GhostDAWTests)
target_sources(GhostDAWTests PRIVATE PluginHostTests.cpp)
target_include_directories(GhostDAWTests PRIVATE "${LPI_INCLUDE_DIR}" ../src)
target_compile_definitions(GhostDAWTests PRIVATE
    JUCE_WEB_BROWSER=0
    JUCE_USE_CURL=0
    JUCE_PLUGINHOST_VST3=1
    JUCE_PLUGINHOST_AU=1
    JUCE_MODAL_LOOPS_PERMITTED=1 # runDispatchLoopUntil, for the editor tests
    ${GHOSTDAW_TEST_PLUGIN_DEFINITIONS}
    TEST_VST3_PATH="$<GENEX_EVAL:$<TARGET_PROPERTY:TestGainVst3_VST3,JUCE_PLUGIN_ARTEFACT_FILE>>")
target_link_libraries(GhostDAWTests PRIVATE
    juce::juce_core
    juce::juce_audio_basics
    juce::juce_audio_devices
    juce::juce_audio_formats
    juce::juce_audio_processors
    juce::juce_events)
add_dependencies(GhostDAWTests lpi_test_gain_good lpi_test_gain_bad_major lpi_test_gain_no_export lpi_test_gui lpi_test_gui_polling lpi_test_gui_latency lpi_test_gui_transport TestGainVst3_VST3)
