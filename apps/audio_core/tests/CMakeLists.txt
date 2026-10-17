# The tests (configure with -DGHOSTDAW_BUILD_TESTS=ON).
#
# ghostdaw_tests covers the new host: the platform layer (the WebSocket
# server over real sockets, JSON, the loop, pairing) and the host (the
# insert chains, the mixer, the hap engine, the audio device on the null
# backend, the watchdog). GhostDAWTests covers
# the JUCE host until the switch (#134). Both build their own test plugins:
# an LPI gain in three variants (good, wrong ABI major, no factory export),
# an LPI gain with an editor (and its polling and latency variants), and a
# JUCE VST3 gain bundle.


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
# never returns from it. The scanner's child process takes the hit.
foreach(variant IN ITEMS crash hang)
    add_library(lpi_test_${variant} MODULE plugins/lpi_test_bad.cpp)
    target_include_directories(lpi_test_${variant} PRIVATE "${LPI_INCLUDE_DIR}")
    set_target_properties(lpi_test_${variant} PROPERTIES
        PREFIX ""
        CXX_VISIBILITY_PRESET hidden
        LIBRARY_OUTPUT_DIRECTORY "${CMAKE_CURRENT_BINARY_DIR}/lpi/${variant}")
endforeach()
target_compile_definitions(lpi_test_crash PRIVATE LPI_TEST_CRASH=1)
target_compile_definitions(lpi_test_hang PRIVATE LPI_TEST_HANG=1)

set(GHOSTDAW_TEST_PLUGIN_DEFINITIONS
    LPI_TEST_FOLDER="${CMAKE_CURRENT_BINARY_DIR}/lpi"
    LPI_TEST_GAIN_PATH="$<TARGET_FILE:lpi_test_gain_good>"
    LPI_TEST_BAD_MAJOR_PATH="$<TARGET_FILE:lpi_test_gain_bad_major>"
    LPI_TEST_NO_EXPORT_PATH="$<TARGET_FILE:lpi_test_gain_no_export>"
    LPI_TEST_GUI_PATH="$<TARGET_FILE:lpi_test_gui>"
    LPI_TEST_GUI_POLLING_PATH="$<TARGET_FILE:lpi_test_gui_polling>"
    LPI_TEST_GUI_LATENCY_PATH="$<TARGET_FILE:lpi_test_gui_latency>"
    LPI_TEST_GUI_TRANSPORT_PATH="$<TARGET_FILE:lpi_test_gui_transport>"
    LPI_TEST_CRASH_PATH="$<TARGET_FILE:lpi_test_crash>"
    LPI_TEST_HANG_PATH="$<TARGET_FILE:lpi_test_hang>")
set(GHOSTDAW_TEST_PLUGIN_TARGETS lpi_test_gain_good lpi_test_gain_bad_major lpi_test_gain_no_export lpi_test_gui lpi_test_gui_polling lpi_test_gui_latency lpi_test_gui_transport lpi_test_crash lpi_test_hang)

add_executable(ghostdaw_tests main.cpp platform_tests.cpp host_tests.cpp plugin_tests.cpp)
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
