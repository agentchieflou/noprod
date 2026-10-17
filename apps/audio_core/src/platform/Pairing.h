#pragma once

#include "Files.h"

#include <atomic>
#include <mutex>
#include <string>

namespace ghostdaw
{

// Pairing the web app with this GhostDAW.
//
// The token is 32 random bytes, kept as hex in <dataDir>/pairing-token
// (owner-only), created on first launch and rotated on request. Every
// WebSocket connection presents it (?token=...).
//
// How the web app gets it: at each launch GhostDAW prints a pairing code
// (8 symbols, about 40 bits) to the console and the log. The web app's
// Audio Core panel asks the user for it, sends PAIR { code } on a
// tokenless control connection, and gets PAIRED { token } back. Five wrong
// codes lock pairing until GhostDAW restarts, so the code can't be
// guessed by a local page trying its luck.
class Pairing
{
public:
    static constexpr int maxAttempts = 5;

    // Loads the token, or creates one. Throws std::runtime_error if the
    // token can't be stored.
    explicit Pairing (const fs::path& dataDir);

    std::string getToken() const;
    fs::path getTokenPath() const { return tokenPath; }

    // A new token, saved; every paired browser must pair again
    std::string rotateToken();

    // This launch's code, "ABCD-EFGH"
    std::string getCode() const;

    // Checks a typed code (case and separators don't matter). Counts the
    // failures; once locked, nothing matches.
    bool tryCode (const std::string& typed);
    bool isLocked() const { return failures.load() >= maxAttempts; }
    int getFailures() const { return failures.load(); }

    // Constant-time comparison with the token
    bool checkToken (const std::string& presented) const;

    // The code's alphabet: no 0/O or 1/I to confuse
    static std::string makeCode();
    static std::string normaliseCode (const std::string& typed);

private:
    fs::path tokenPath;
    mutable std::mutex lock;
    std::string token;
    std::string code;
    std::atomic<int> failures { 0 };

    void save();
};

} // namespace ghostdaw
