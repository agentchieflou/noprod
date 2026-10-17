#pragma once

// The tests' one assertion. Every file counts into the same totals, and
// main() prints PASS or FAIL with them.

#include <iostream>

extern int checks, failures;

#define CHECK(cond)                                                                          \
    do {                                                                                     \
        ++checks;                                                                            \
        if (! (cond)) {                                                                      \
            ++failures;                                                                      \
            std::cerr << "  FAILED " << __FILE__ << ":" << __LINE__ << ": " #cond << std::endl; \
        }                                                                                    \
    } while (0)

#define CHECK_NEAR(a, b, eps) CHECK (std::abs ((a) - (b)) <= (eps))

inline void section (const char* name) { std::cout << "- " << name << std::endl; }

// Each file's tests (`self` is the test executable's path)
void platformTests (const char* self);
void hostTests();
