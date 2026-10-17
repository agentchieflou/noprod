#pragma once

// The Audio Unit test effect (au_test_gain.cpp), registered in this
// process. macOS only.
void registerAuTestGain();
extern const char* const auTestGainPluginId; // "au:aufx:tgai:NoPr"
