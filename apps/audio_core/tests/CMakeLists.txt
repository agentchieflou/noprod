# Plugin-hosting tests (configure with -DGHOSTDAW_BUILD_TESTS=ON, then run
# GhostDAWTests). Builds its own test plugins: an LPI gain in three variants
# (good, wrong ABI major, no factory export), an LPI gain with an editor (and
# its polling and latency variants), and a JUCE VST3 gain bundle.

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
# two variants: without lpi.params.changes.v1, and with 64 samples of latency
foreach(variant IN ITEMS gui gui_polling gui_latency)
    add_library(lpi_test_${variant} MODULE plugins/lpi_test_gui.cpp)
    target_include_directories(lpi_test_${variant} PRIVATE "${LPI_INCLUDE_DIR}")
    set_target_properties(lpi_test_${variant} PROPERTIES
        PREFIX ""
        CXX_VISIBILITY_PRESET hidden
        LIBRARY_OUTPUT_DIRECTORY "${CMAKE_CURRENT_BINARY_DIR}/lpi/${variant}")
endforeach()
target_compile_definitions(lpi_test_gui_polling PRIVATE LPI_TEST_GUI_POLLING=1)
target_compile_definitions(lpi_test_gui_latency PRIVATE LPI_TEST_GUI_LATENCY=64)

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
    LPI_TEST_GAIN_PATH="$<TARGET_FILE:lpi_test_gain_good>"
    LPI_TEST_BAD_MAJOR_PATH="$<TARGET_FILE:lpi_test_gain_bad_major>"
    LPI_TEST_NO_EXPORT_PATH="$<TARGET_FILE:lpi_test_gain_no_export>"
    LPI_TEST_GUI_PATH="$<TARGET_FILE:lpi_test_gui>"
    LPI_TEST_GUI_POLLING_PATH="$<TARGET_FILE:lpi_test_gui_polling>"
    LPI_TEST_GUI_LATENCY_PATH="$<TARGET_FILE:lpi_test_gui_latency>"
    TEST_VST3_PATH="$<GENEX_EVAL:$<TARGET_PROPERTY:TestGainVst3_VST3,JUCE_PLUGIN_ARTEFACT_FILE>>")
target_link_libraries(GhostDAWTests PRIVATE
    juce::juce_core
    juce::juce_audio_basics
    juce::juce_audio_devices
    juce::juce_audio_formats
    juce::juce_audio_processors
    juce::juce_events)
add_dependencies(GhostDAWTests lpi_test_gain_good lpi_test_gain_bad_major lpi_test_gain_no_export lpi_test_gui lpi_test_gui_polling lpi_test_gui_latency TestGainVst3_VST3)
