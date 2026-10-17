// Tests for the platform layer the new GhostDAW is built on (#134, step 1):
// JSON, the message loop, files, pairing, the single-instance lock, the
// crash handler, and the WebSocket server over real sockets: handshake,
// framing, masking, fragmentation, limits and the token.

#include "Check.h"
#include "TestWebSocketClient.h"
#include "platform/Base64.h"
#include "platform/DynamicLibrary.h"
#include "platform/Files.h"
#include "platform/Json.h"
#include "platform/Log.h"
#include "platform/Loop.h"
#include "platform/Pairing.h"
#include "platform/Platform.h"
#include "platform/Process.h"
#include "platform/Random.h"
#include "platform/Sha1.h"
#include "platform/Sockets.h"
#include "platform/Strings.h"
#include "platform/WebSocketServer.h"

#include <atomic>
#include <cstdlib>
#include <cstring>
#include <iostream>
#include <mutex>
#include <set>
#include <thread>

using namespace ghostdaw;


static fs::path tempDir (const char* name)
{
    auto dir = fs::temp_directory_path() / ("ghostdaw-tests-" + std::string (name) + "-" + secureRandomHex (4));
    createDirectories (dir);
    return dir;
}

static int runProcess (const std::string& commandLine)
{
   #if GHOSTDAW_WINDOWS
    // cmd.exe strips the outer quotes of a line that starts with one; a
    // second pair keeps the quoted paths intact
    auto status = std::system (("\"" + commandLine + "\"").c_str());
    return status;
   #else
    auto status = std::system (commandLine.c_str());
    return WIFEXITED (status) ? WEXITSTATUS (status) : -1;
   #endif
}

static bool waitFor (const std::function<bool()>& condition, int timeoutMs = 5000)
{
    auto end = monotonicMs() + timeoutMs;
    while (! condition())
    {
        if (monotonicMs() > end)
            return false;
        sleepMs (5);
    }
    return true;
}

static std::string quote (const fs::path& path)
{
    return "\"" + pathToUtf8 (path) + "\"";
}

// ------------------------------------------------------------------ tests

static void testJson()
{
    section ("JSON: build, read, missing keys read as null");
    auto message = Json::object ({ { "type", "LOAD_PLUGIN" }, { "bus", 7 }, { "index", 0.5 }, { "ok", true }, { "nothing", nullptr } });
    message.member ("list").push (1).push ("two").push (Json::object ({ { "deep", Json::array() } }));
    CHECK (message["type"].toString() == "LOAD_PLUGIN");
    CHECK (message["bus"].toInt() == 7 && message["bus"].toString() == "7");
    CHECK (message["index"].toDouble() == 0.5 && message["index"].toString() == "0.5");
    CHECK (message["ok"].toBool() && ! message["nothing"].toBool() && message["nothing"].isNull());
    CHECK (message["missing"].isNull() && message["missing"]["deeper"][3].isNull()); // reading creates nothing
    Json grown;
    grown.element (2) = "c";
    CHECK (grown.isArray() && grown.size() == 3 && grown[0].isNull() && grown[2].toString() == "c");
    CHECK (message["list"].size() == 3 && message["list"][1].toString() == "two" && message["list"][2]["deep"].isArray());
    CHECK (message.has ("bus") && ! message.has ("missing") && message.size() == 6);
    CHECK (message.get ("missing", 42).toInt() == 42 && message.get ("nothing", 42).toInt() == 42 && message.get ("bus", 42).toInt() == 7);
    CHECK (Json ("12").toInt() == 12 && Json ("x").toInt (-1) == -1 && Json().toInt (5) == 5);
    CHECK (Json (3.0).toString() == "3" && Json (1e21).dump() == "1e+21" && Json (-0.25f).toString() == "-0.25");
    CHECK (Json (0.1).dump() == "0.1" && Json (1.0 / 3.0).dump() == "0.3333333333333333");

    section ("JSON: dump and parse round trip, escapes, unicode");
    auto text = message.dump();
    CHECK (text == R"({"type":"LOAD_PLUGIN","bus":7,"index":0.5,"ok":true,"nothing":null,"list":[1,"two",{"deep":[]}]})");
    auto back = Json::parse (text);
    CHECK (back && *back == message);
    CHECK (message.dump (2).find ("\n  \"bus\": 7") != std::string::npos);

    auto tricky = Json (std::string ("quote\" back\\ nl\n tab\t ctl\x01 é 😀"));
    CHECK (tricky.dump() == "\"quote\\\" back\\\\ nl\\n tab\\t ctl\\u0001 é 😀\"");
    auto parsedTricky = Json::parse (tricky.dump());
    CHECK (parsedTricky && *parsedTricky == tricky);
    auto escaped = Json::parse (R"("\u00e9\ud83d\ude00\/")");
    CHECK (escaped && escaped->toString() == "é😀/");
    auto spaced = Json::parse (" {\n \"a\" : [ 1 , -2.5e3 , true , null ] , \"b\" : { } } \n");
    CHECK (spaced && (*spaced)["a"][1].toDouble() == -2500.0 && (*spaced)["b"].isObject() && (*spaced)["b"].size() == 0);
    auto numbers = Json::parse ("[0, -0, 1.5, 1E2, 12345678901234]");
    CHECK (numbers && (*numbers)[3].toInt() == 100 && (*numbers)[4].toInt64() == 12345678901234);

    section ("JSON: malformed input is refused");
    std::string error;
    for (auto* bad : { "", "{", "[1,]", "{\"a\":}", "{a:1}", "\"unterminated", "01", "1.", "-", "tru", "[1] x", "\"\\x\"", "\"\\ud800\"", "\"bad\x01ctl\"", "{\"a\":1,}" })
    {
        auto result = Json::parse (bad, &error);
        CHECK (! result);
    }
    std::string deep (200, '[');
    CHECK (! Json::parse (deep + std::string (200, ']'), &error) && error.find ("deep") != std::string::npos);
    CHECK (Json::parse ("\"a\"") && Json::parse ("7") && Json::parse ("null"));

    section ("JSON: objects keep key order; set and remove");
    Json o = Json::object();
    o.set ("z", 1).set ("a", 2).set ("z", 3);
    CHECK (o.dump() == R"({"z":3,"a":2})");
    CHECK (o.remove ("z") && ! o.remove ("z") && o.dump() == R"({"a":2})");
    CHECK (Json::object ({ { "a", 1 }, { "b", 2 } }) == Json::object ({ { "b", 2 }, { "a", 1 } })); // equal regardless of order
}

static void testEncodings()
{
    section ("Base64, hex and SHA-1");
    CHECK (base64Encode ("", 0).empty() && base64Encode ("f", 1) == "Zg==" && base64Encode ("fo", 2) == "Zm8=" && base64Encode ("foobar", 6) == "Zm9vYmFy");
    std::vector<uint8_t> bytes;
    CHECK (base64Decode ("Zm9vYmFy", bytes) && std::string (bytes.begin(), bytes.end()) == "foobar");
    CHECK (base64Decode ("Zg==", bytes) && bytes.size() == 1 && bytes[0] == 'f');
    CHECK (base64Decode ("dGhlIHNhbXBsZSBub25jZQ==", bytes) && bytes.size() == 16);
    CHECK (! base64Decode ("Zg=", bytes) && ! base64Decode ("Z===", bytes) && ! base64Decode ("Zg==Zg==", bytes) && ! base64Decode ("Z!==", bytes));
    CHECK (hexEncode ("\x01\xab", 2) == "01ab");
    CHECK (hexDecode ("01AB", bytes) && bytes.size() == 2 && bytes[1] == 0xAB && ! hexDecode ("0", bytes) && ! hexDecode ("zz", bytes));

    // RFC 6455's example: the key "dGhlIHNhbXBsZSBub25jZQ==" accepts as "s3pPLMBiTxaQ9kYGzzhZRbK+xOo="
    std::string material = "dGhlIHNhbXBsZSBub25jZQ==258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
    auto digest = sha1 (material.data(), material.size());
    CHECK (base64Encode (digest.data(), digest.size()) == "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=");
    auto abc = sha1 ("abc", 3);
    CHECK (hexEncode (abc.data(), abc.size()) == "a9993e364706816aba3e25717850c26c9cd0d89d");

    section ("Strings and UTF-8");
    CHECK (trim ("  a b \r\n") == "a b" && split ("a,,b", ',').size() == 3 && lowerCase ("AbC") == "abc");
    CHECK (equalsIgnoreCase ("WebSocket", "websocket") && startsWith ("abc", "ab") && endsWith ("abc", "bc") && containsOnly ("123", "0123456789"));
    CHECK (isValidUtf8 ("plain", 5) && isValidUtf8 ("é😀", 6));
    CHECK (! isValidUtf8 ("\xff", 1) && ! isValidUtf8 ("\xc0\x80", 2) && ! isValidUtf8 ("\xed\xa0\x80", 3) && ! isValidUtf8 ("\xe2\x82", 2));
}

static void testLoop()
{
    section ("Message loop: tasks run in order on the loop thread; timers; callSync; stop");
    MessageLoop loop;
    std::vector<int> order;
    std::thread::id taskThread;
    loop.post ([&] { order.push_back (1); taskThread = std::this_thread::get_id(); });
    loop.post ([&] { order.push_back (2); });
    CHECK (loop.pendingTasks() == 2 && ! loop.onLoopThread());
    loop.runFor (10);
    CHECK (order.size() == 2 && order[0] == 1 && order[1] == 2 && taskThread == std::this_thread::get_id());

    // A timer repeats, no faster than its interval (how much slower depends
    // on the machine: a loaded CI runner wakes late), and stops when removed
    std::atomic<int> ticks { 0 };
    auto timer = loop.addTimer (20, [&] { ++ticks; });
    auto t0 = monotonicMs();
    CHECK (loop.runUntil ([&] { return ticks.load() >= 5; }, 5000));
    CHECK (monotonicMs() - t0 >= 80.0);
    loop.removeTimer (timer);
    auto before = ticks.load();
    loop.runFor (60);
    CHECK (ticks.load() == before);

    // A timer that removes itself while running
    MessageLoop::TimerId self = 0;
    int selfRuns = 0;
    self = loop.addTimer (5, [&] { ++selfRuns; loop.removeTimer (self); });
    loop.runFor (50);
    CHECK (selfRuns == 1);

    // callSync from another thread while this one runs the loop
    std::atomic<bool> synced { false };
    bool onLoop = false;
    std::thread other ([&]
    {
        onLoop = loop.callSync ([&] { synced = true; onLoop = loop.onLoopThread(); }, 5000);
    });
    loop.runUntil ([&] { return synced.load(); }, 5000);
    other.join();
    CHECK (synced.load() && onLoop);
    CHECK (! loop.callSync ([&] { onLoop = false; }, 50)); // nobody runs the loop: the wait times out
    loop.runFor (10);
    CHECK (! onLoop); // ...and the task ran once it did

    // stop() ends run() on its thread and drops what was queued
    std::thread runner ([&] { loop.run(); });
    std::atomic<bool> ran { false };
    loop.post ([&] { ran = true; });
    for (int i = 0; i < 500 && ! ran.load(); ++i)
        sleepMs (2);
    CHECK (ran.load());
    // A callSync with no timeout returns once the loop stops
    std::atomic<bool> syncReturned { false };
    bool syncResult = true;
    std::thread waiter ([&] { syncResult = loop.callSync ([] { sleepMs (300); }); syncReturned = true; });
    sleepMs (50); // the task is running; stop() drops the rest
    loop.stop();
    runner.join();
    CHECK (waitFor ([&] { return syncReturned.load(); }, 3000));
    waiter.join();
    CHECK (syncResult); // that one had already run
    CHECK (! loop.post ([] {}) && loop.isStopped());
    CHECK (! loop.callSync ([] {})); // and nothing runs after stop
}

static void testFiles()
{
    section ("Files: data folder, atomic writes, listing");
    CHECK (! defaultDataDir().empty() && pathToUtf8 (defaultDataDir()).find ("GhostDAW") != std::string::npos);
    auto dir = tempDir ("files");
    CHECK (directoryExists (dir) && createDirectories (dir / "sub" / "deeper"));
    CHECK (writeFile (dir / "a.txt", "hello") && fileExists (dir / "a.txt") && ! fileExists (dir / "a.txt.tmp"));
    std::string contents;
    CHECK (readFile (dir / "a.txt", contents) && contents == "hello");
    CHECK (writeFile (dir / "a.txt", "replaced") && readFile (dir / "a.txt", contents) && contents == "replaced");
    CHECK (! readFile (dir / "missing", contents));
    CHECK (writeFile (dir / "sub" / "p.so", "") && writeFile (dir / "sub" / "deeper" / "q.DLL", "") && writeFile (dir / "sub" / "r.txt", ""));
    auto found = listFiles (dir, { ".so", ".dll" });
    CHECK (found.size() == 2 && found[0].filename() == "q.DLL" && found[1].filename() == "p.so");
    CHECK (listFiles (dir, { ".so" }, 1).size() <= 1);
    CHECK (createDirectories (dir / "Thing.vst3") && createDirectories (dir / "Other.VST3") && listBundles (dir, ".vst3").size() == 2);
    // Bundles in a vendor's subfolder count; one inside another bundle doesn't
    CHECK (createDirectories (dir / "Vendor" / "Deep.vst3") && createDirectories (dir / "Thing.vst3" / "Contents" / "Inner.vst3"));
    auto bundles = listBundles (dir, ".vst3");
    CHECK (bundles.size() == 3 && bundles[2].filename() == "Deep.vst3");
    CHECK (listFiles (dir / "nope", { ".so" }).empty() && listBundles (dir / "nope", ".vst3").empty());
    // A symlink to a bundle is a bundle (the VST3 SDK installs plug-ins that
    // way); a symlink back up the tree is not followed, by either walk
    std::error_code linkError;
    fs::create_directory_symlink (dir / "Vendor" / "Deep.vst3", dir / "Linked.vst3", linkError);
    if (linkError) // (making links needs a privilege on some Windows setups)
        std::cout << "  (skipping the symlink checks: " << linkError.message() << ")" << std::endl;
    else
    {
        fs::create_directory_symlink (dir, dir / "Vendor" / "loop", linkError);
        CHECK (! linkError);
        bundles = listBundles (dir, ".vst3");
        CHECK (bundles.size() == 4 && bundles[0].filename() == "Linked.vst3");
        for (auto& b : bundles)
            CHECK (pathToUtf8 (b).find ("loop") == std::string::npos);
        CHECK (listFiles (dir, { ".so", ".dll" }).size() == 2);
    }
    CHECK (restrictToOwner (dir / "a.txt"));
   #if ! GHOSTDAW_WINDOWS
    CHECK ((fs::status (dir / "a.txt").permissions() & (fs::perms::group_all | fs::perms::others_all)) == fs::perms::none);
   #endif
    CHECK (removeFile (dir / "a.txt") && ! fileExists (dir / "a.txt"));
    fs::remove_all (dir);

    section ("Dynamic libraries: a missing file fails with a reason");
    DynamicLibrary library;
    std::string error;
    CHECK (! library.open (dir / "nope.so", error) && ! error.empty() && ! library.isOpen());
    CHECK (library.getFunction ("anything") == nullptr);

    section ("Random bytes");
    auto a = secureRandomHex (16), b = secureRandomHex (16);
    CHECK (a.size() == 32 && b.size() == 32 && a != b && containsOnly (a, "0123456789abcdef"));
    std::set<uint32_t> seen;
    for (int i = 0; i < 200; ++i)
        seen.insert (secureRandomBelow (32));
    CHECK (seen.size() > 20 && *seen.rbegin() < 32 && secureRandomBelow (1) == 0);

    section ("Log: levels and the file");
    auto logDir = tempDir ("log");
    auto logPath = logDir / "test.log";
    CHECK (Log::setFile (logPath));
    Log::setLevel (Log::Level::warn);
    Log::info ("not written");
    Log::warn ("written");
    Log::setLevel (Log::Level::info);
    Log::setFile ({});
    std::string log;
    CHECK (readFile (logPath, log) && log.find ("WARN written") != std::string::npos && log.find ("not written") == std::string::npos);
    CHECK (log.size() > 24 && log[4] == '-' && log[10] == ' ' && log[13] == ':'); // a timestamp first
    fs::remove_all (logDir);
}

static void testPairing()
{
    section ("Pairing: the token is created once, owner-only, and rotates");
    auto dir = tempDir ("pairing");
    std::string first;
    {
        Pairing pairing (dir);
        first = pairing.getToken();
        CHECK (first.size() == 64 && containsOnly (first, "0123456789abcdef"));
        CHECK (fileExists (pairing.getTokenPath()));
       #if ! GHOSTDAW_WINDOWS
        CHECK ((fs::status (pairing.getTokenPath()).permissions() & (fs::perms::group_all | fs::perms::others_all)) == fs::perms::none);
       #endif
        CHECK (pairing.checkToken (first) && pairing.checkToken (lowerCase (first)) && ! pairing.checkToken (first.substr (1)) && ! pairing.checkToken ({}));
    }
    {
        Pairing again (dir);
        CHECK (again.getToken() == first); // kept across launches
        auto rotated = again.rotateToken();
        CHECK (rotated != first && again.checkToken (rotated) && ! again.checkToken (first));
        Pairing third (dir);
        CHECK (third.getToken() == rotated);
    }
    {
        // A damaged token file gets a fresh token
        writeFile (dir / "pairing-token", "garbage");
        Pairing fresh (dir);
        CHECK (fresh.getToken().size() == 64 && fresh.getToken() != first);
    }

    section ("Pairing: the code, and five wrong tries lock pairing");
    Pairing pairing (dir);
    auto code = pairing.getCode();
    CHECK (code.size() == 9 && code[4] == '-' && containsOnly (code, "ABCDEFGHJKLMNPQRSTUVWXYZ23456789-"));
    CHECK (Pairing::normaliseCode (" ab-cd ef GH ") == "ABCDEFGH");
    CHECK (pairing.tryCode (code) && pairing.tryCode (lowerCase (code)) && pairing.tryCode (Pairing::normaliseCode (code)));
    CHECK (! pairing.tryCode ("WRONG-CODE") && pairing.getFailures() == 1 && ! pairing.isLocked());
    CHECK (pairing.tryCode (code)); // a right code after a wrong one still works
    for (int i = 0; i < 4; ++i)
        pairing.tryCode ("ZZZZ-ZZZZ");
    CHECK (pairing.isLocked() && pairing.getFailures() == 5);
    CHECK (! pairing.tryCode (code)); // locked: even the right code fails now
    CHECK (Pairing::makeCode() != Pairing::makeCode());
    fs::remove_all (dir);
}

static void testInstanceLock()
{
    section ("One instance: a second lock on the same file fails");
    auto dir = tempDir ("lock");
    {
        InstanceLock first (dir / "ghostdaw.lock");
        CHECK (first.isHeld());
        InstanceLock second (dir / "ghostdaw.lock");
        CHECK (! second.isHeld());
        InstanceLock other (dir / "other.lock");
        CHECK (other.isHeld());
    }
    InstanceLock again (dir / "ghostdaw.lock");
    CHECK (again.isHeld()); // released when the first went away
    fs::remove_all (dir);
}

static void testCrashHandler (const std::string& self)
{
    section ("Crash handler: a crashing process leaves a line in the log");
    auto dir = tempDir ("crash");
    auto log = dir / "crash.log";
    runProcess (quote (self) + " --crash " + quote (log));
    std::string contents;
    CHECK (readFile (log, contents));
    CHECK (contents.find ("CRASH") != std::string::npos);
   #if ! GHOSTDAW_WINDOWS
    CHECK (contents.find ("SIGSEGV") != std::string::npos);
   #endif
    CHECK (contents.find (" UTC") != std::string::npos);
    fs::remove_all (dir);
}

static void testSockets()
{
    section ("Sockets: loopback only, a taken port fails, data goes both ways");
    TcpListener listener;
    std::string error;
    CHECK (listener.listen (0, error) && listener.getPort() != 0);

    TcpListener taken;
    CHECK (! taken.listen (listener.getPort(), error) && ! error.empty());

    auto other = firstNonLoopbackIpv4();
    if (other.empty())
    {
        std::cout << "  (no non-loopback interface here; skipping the reachability check)" << std::endl;
    }
    else
    {
        TcpSocket outside;
        CHECK (! outside.connectTo (other, listener.getPort(), 1000)); // not reachable through the machine's address
    }

    TcpSocket client;
    CHECK (client.connect (listener.getPort()));
    auto accepted = listener.accept (2000);
    CHECK (accepted != nullptr);
    if (accepted == nullptr)
        return;
    CHECK (startsWith (accepted->peerName(), "127.0.0.1:"));
    CHECK (client.writeAll ("ping", 4));
    char buffer[8] = {};
    CHECK (accepted->readExact (buffer, 4, 1000) && std::memcmp (buffer, "ping", 4) == 0);
    CHECK (accepted->read (buffer, 8, 50) == -2); // nothing more: a timeout, not an error
    CHECK (accepted->writeAll ("pong!", 5) && client.readExact (buffer, 5, 1000) && std::memcmp (buffer, "pong!", 5) == 0);

    // shutdown() from another thread ends a blocked read
    std::atomic<int> result { 99 };
    std::thread reader ([&] { result = client.read (buffer, 8, 5000); });
    sleepMs (50);
    client.shutdown();
    reader.join();
    CHECK (result.load() <= 0 && ! client.isOpen());
    CHECK (listener.accept (10) == nullptr);
    listener.close();
    CHECK (! listener.isListening());
}

struct Received
{
    std::mutex lock;
    std::vector<std::string> texts;
    std::vector<std::vector<uint8_t>> binaries;
    std::atomic<int> closes { 0 };
    std::atomic<int> opens { 0 };
    size_t textCount() { const std::lock_guard<std::mutex> guard (lock); return texts.size(); }
    std::string lastText() { const std::lock_guard<std::mutex> guard (lock); return texts.empty() ? std::string() : texts.back(); }
};

static WebSocketServer::Handlers echoHandlers (Received& received)
{
    WebSocketServer::Handlers handlers;
    handlers.onText = [&received] (const WebSocketServer::ConnectionPtr& c, const std::string& text)
    {
        {
            const std::lock_guard<std::mutex> guard (received.lock);
            received.texts.push_back (text);
        }
        c->sendText ("echo:" + text);
    };
    handlers.onBinary = [&received] (const WebSocketServer::ConnectionPtr& c, uint8_t* data, size_t size)
    {
        {
            const std::lock_guard<std::mutex> guard (received.lock);
            received.binaries.emplace_back (data, data + size);
        }
        for (size_t i = 0; i < size; ++i)
            data[i] = static_cast<uint8_t> (data[i] + 1); // processed in place, sent back
        c->sendBinary (data, size);
    };
    handlers.onClose = [&received] (const WebSocketServer::ConnectionPtr&) { ++received.closes; };
    return handlers;
}

static void testWebSocketHandshake()
{
    section ("WebSocket: handshake, origin policy, a taken port");
    Received received;
    WebSocketServer::Options options;
    options.name = "test";
    options.extraOrigins = { "https://extra.example" };
    WebSocketServer server (options, echoHandlers (received));
    std::string error;
    CHECK (server.start (error));
    auto port = server.getPort();
    CHECK (port != 0);

    WebSocketServer busy (options, {});
    options.port = port;
    WebSocketServer samePort (options, {});
    CHECK (! samePort.start (error) && error.find ("bind") != std::string::npos);

    TestWebSocketClient plain;
    CHECK (plain.connect (port) == 101);
    CHECK (plain.responseHeader ("Sec-WebSocket-Accept") == "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=");
    CHECK (equalsIgnoreCase (plain.responseHeader ("Upgrade"), "websocket"));
    CHECK (waitFor ([&] { return server.getConnectionCount() == 1; }));

    TestWebSocketClient local, ipv6, extra, hosted, evil, lookalike, nullOrigin, noUpgrade, badKey, post;
    CHECK (local.connect (port, "/", "http://localhost:5173") == 101);
    CHECK (ipv6.connect (port, "/", "https://[::1]:4173") == 101);
    CHECK (extra.connect (port, "/", "https://extra.example") == 101);
    CHECK (hosted.connect (port, "/", WebSocketServer::hostedOrigin) == 101); // the web app on GitHub Pages
    CHECK (evil.connect (port, "/", "https://evil.example") == 403);
    CHECK (lookalike.connect (port, "/", "http://localhost.evil.example") == 403);
    CHECK (nullOrigin.connect (port, "/", "null") == 403);
    CHECK (noUpgrade.connect (port, "/", "", "", "dGhlIHNhbXBsZSBub25jZQ==", false) == 400);
    CHECK (badKey.connect (port, "/", "", "", "tooshort") == 400);
    CHECK (evil.waitForClose() && noUpgrade.waitForClose());
    CHECK (waitFor ([&] { return server.getConnectionCount() == 5; }));

    CHECK (WebSocketServer::isAllowedOrigin ({}) && WebSocketServer::isAllowedOrigin ("http://127.0.0.1"));
    CHECK (WebSocketServer::isAllowedOrigin ("https://agentchieflou.github.io") && ! WebSocketServer::isAllowedOrigin ("https://evil.github.io")
           && ! WebSocketServer::isAllowedOrigin ("http://agentchieflou.github.io") && ! WebSocketServer::isAllowedOrigin ("https://agentchieflou.github.io.evil.example"));
    CHECK (! WebSocketServer::isAllowedOrigin ("http://localhost:80@evil.example") && ! WebSocketServer::isAllowedOrigin ("http://localhost:") && ! WebSocketServer::isAllowedOrigin ("file://"));

    section ("WebSocket: text and binary messages, pings, the close handshake");
    CHECK (plain.sendText ("hello") );
    std::string reply;
    CHECK (plain.readText (reply) && reply == "echo:hello");
    CHECK (waitFor ([&] { return received.textCount() == 1; }) && received.lastText() == "hello");

    std::vector<uint8_t> bytes { 1, 2, 3 };
    CHECK (plain.sendBinary (bytes));
    TestWebSocketClient::Frame frame;
    CHECK (plain.readFrame (frame) && frame.opcode == 0x2 && (frame.payload == std::vector<uint8_t> { 2, 3, 4 }));

    CHECK (plain.sendPing ("are you there"));
    CHECK (plain.readFrame (frame) && frame.opcode == 0xA && frame.text() == "are you there");

    // A long message (16-bit and 64-bit lengths)
    std::string medium (70000, 'm');
    CHECK (plain.sendText (medium) && plain.readText (reply) && reply == "echo:" + medium);
    std::string big (200, 'b');
    CHECK (plain.sendFrame (0x1, big.data(), big.size(), true, true) && plain.readText (reply) && reply == "echo:" + big);

    // Server broadcast reaches every open connection
    server.broadcastText ("all");
    CHECK (plain.readText (reply) && reply == "all");
    CHECK (local.readText (reply) && reply == "all");

    CHECK (plain.sendClose (1000, "bye"));
    CHECK (plain.readFrame (frame) && frame.opcode == 0x8 && frame.closeCode() == 1000);
    CHECK (plain.waitForClose());
    CHECK (waitFor ([&] { return received.closes.load() == 1 && server.getConnectionCount() == 4; }));

    // Closing from the server side
    server.stop();
    CHECK (local.readFrame (frame) && frame.opcode == 0x8 && frame.closeCode() == 1001);
    CHECK (local.waitForClose() && ipv6.waitForClose() && extra.waitForClose() && hosted.waitForClose());
    CHECK (received.closes.load() == 5 && server.getConnectionCount() == 0);
}

static void testWebSocketFraming()
{
    section ("WebSocket: masking is enforced, fragments are reassembled, protocol errors close");
    Received received;
    WebSocketServer::Options options;
    options.name = "framing";
    options.maxMessageBytes = 1000;
    WebSocketServer server (options, echoHandlers (received));
    std::string error;
    CHECK (server.start (error));
    auto port = server.getPort();
    TestWebSocketClient::Frame frame;
    std::string reply;

    auto expectClose = [&] (TestWebSocketClient& client, uint16_t code)
    {
        TestWebSocketClient::Frame f;
        bool got = client.readFrame (f);
        CHECK (got && f.opcode == 0x8 && f.closeCode() == code);
        CHECK (client.waitForClose());
    };

    TestWebSocketClient unmasked;
    CHECK (unmasked.connect (port) == 101 && unmasked.sendText ("x", true, false));
    expectClose (unmasked, 1002);

    // A client that answers the server's close is let go at once; one that
    // keeps sending is ignored until the drain is up
    TestWebSocketClient answering, chatty;
    CHECK (answering.connect (port) == 101 && answering.sendFrame (0x3, "x", 1));
    CHECK (answering.readFrame (frame) && frame.opcode == 0x8 && answering.sendClose (1002));
    auto t0 = monotonicMs();
    CHECK (answering.waitForClose() && monotonicMs() - t0 < 800);
    CHECK (chatty.connect (port) == 101 && chatty.sendFrame (0x3, "x", 1));
    CHECK (chatty.readFrame (frame) && frame.opcode == 0x8);
    CHECK (chatty.sendText ("still here") && chatty.sendPing ("hello?"));
    t0 = monotonicMs();
    CHECK (chatty.waitForClose (3000)); // the half-close's end of stream, at once
    CHECK (waitFor ([&] { return server.getConnectionCount() == 0; }, 3000) && monotonicMs() - t0 >= 500); // the server held on through the drain
    CHECK (received.textCount() == 0); // "still here" was never dispatched

    TestWebSocketClient fragmented;
    CHECK (fragmented.connect (port) == 101);
    CHECK (fragmented.sendText ("one ", false) && fragmented.sendPing ("mid") && fragmented.sendContinuation ("two ", false) && fragmented.sendContinuation ("three", true));
    CHECK (fragmented.readFrame (frame) && frame.opcode == 0xA && frame.text() == "mid"); // the ping answered between the fragments
    CHECK (fragmented.readText (reply) && reply == "echo:one two three");
    CHECK (fragmented.sendContinuation ("orphan", true));
    expectClose (fragmented, 1002);

    TestWebSocketClient interleaved;
    CHECK (interleaved.connect (port) == 101 && interleaved.sendText ("start", false) && interleaved.sendText ("another", true));
    expectClose (interleaved, 1002);

    TestWebSocketClient tooBig;
    CHECK (tooBig.connect (port) == 101 && tooBig.sendText (std::string (1001, 'x')));
    expectClose (tooBig, 1009);

    TestWebSocketClient tooBigInPieces;
    CHECK (tooBigInPieces.connect (port) == 101 && tooBigInPieces.sendText (std::string (600, 'x'), false) && tooBigInPieces.sendContinuation (std::string (600, 'y'), true));
    expectClose (tooBigInPieces, 1009);

    TestWebSocketClient justFits;
    CHECK (justFits.connect (port) == 101 && justFits.sendText (std::string (1000, 'x')) && justFits.readText (reply) && reply.size() == 1005);
    CHECK (justFits.sendClose (1000) && justFits.waitForClose());

    TestWebSocketClient badUtf8;
    CHECK (badUtf8.connect (port) == 101 && badUtf8.sendText ("\xff\xfe"));
    expectClose (badUtf8, 1007);

    TestWebSocketClient rsv;
    CHECK (rsv.connect (port) == 101 && rsv.sendFrame (0x1, "x", 1, true, true, 0x4));
    expectClose (rsv, 1002);

    TestWebSocketClient badOpcode;
    CHECK (badOpcode.connect (port) == 101 && badOpcode.sendFrame (0x3, "x", 1));
    expectClose (badOpcode, 1002);

    TestWebSocketClient fragmentedControl;
    CHECK (fragmentedControl.connect (port) == 101 && fragmentedControl.sendFrame (0x9, "p", 1, false));
    expectClose (fragmentedControl, 1002);

    TestWebSocketClient badCloseCode;
    CHECK (badCloseCode.connect (port) == 101 && badCloseCode.sendClose (1005));
    expectClose (badCloseCode, 1002);

    TestWebSocketClient reasonClose;
    CHECK (reasonClose.connect (port) == 101 && reasonClose.sendClose (3001, "custom"));
    expectClose (reasonClose, 3001);

    CHECK (waitFor ([&] { return server.getConnectionCount() == 0; }));
    CHECK (received.closes.load() == 14);
    server.stop();
}

static void testWebSocketLimits()
{
    section ("WebSocket: connection cap and handshake timeout");
    Received received;
    WebSocketServer::Options options;
    options.name = "limits";
    options.maxConnections = 2;
    options.handshakeTimeoutMs = 300;
    WebSocketServer server (options, echoHandlers (received));
    std::string error;
    CHECK (server.start (error));
    auto port = server.getPort();

    TestWebSocketClient first, second, third;
    CHECK (first.connect (port) == 101 && second.connect (port) == 101);
    CHECK (waitFor ([&] { return server.getConnectionCount() == 2; }));
    auto status = third.connect (port);
    CHECK (status == 503 || status == 0); // refused: a 503, or dropped before it could read one
    CHECK (third.waitForClose());

    // A slot frees up when a connection ends
    first.sendClose (1000);
    CHECK (first.waitForClose());
    CHECK (waitFor ([&] { return server.getConnectionCount() == 1; }));
    TestWebSocketClient fourth;
    CHECK (fourth.connect (port) == 101);
    second.sendClose (1000);
    fourth.sendClose (1000);
    CHECK (second.waitForClose() && fourth.waitForClose());
    CHECK (waitFor ([&] { return server.getConnectionCount() == 0; }));

    // Connected but silent: dropped after the handshake timeout
    TcpSocket silent;
    CHECK (silent.connect (port));
    auto start = monotonicMs();
    char c;
    auto got = silent.read (&c, 1, 3000);
    CHECK (got <= 0 && got != -2);
    CHECK (monotonicMs() - start >= 250 && monotonicMs() - start < 2500);

    // A half-sent request is dropped too
    TcpSocket partial;
    CHECK (partial.connect (port) && partial.writeAll ("GET / HTTP/1.1\r\nHost: x\r\n", 25));
    got = partial.read (&c, 1, 3000);
    CHECK (got <= 0 && got != -2);
    server.stop();

    section ("WebSocket: idle sockets can't fill the cap (the handshaking cap)");
    WebSocketServer::Options pending;
    pending.name = "pending";
    pending.maxConnections = 8;
    pending.maxHandshaking = 2;
    pending.handshakeTimeoutMs = 300;
    WebSocketServer server2 (pending, echoHandlers (received));
    CHECK (server2.start (error));
    auto port2 = server2.getPort();
    TcpSocket idleA, idleB;
    CHECK (idleA.connect (port2) && idleB.connect (port2));
    CHECK (waitFor ([&] { return server2.getConnectionCount() == 2; }));
    TestWebSocketClient refused;
    status = refused.connect (port2);
    CHECK (status == 503 || status == 0); // room under maxConnections, but two are still handshaking
    CHECK (refused.waitForClose());
    // Once they time out, a real client gets in
    CHECK (waitFor ([&] { return server2.getConnectionCount() == 0; }, 3000));
    TestWebSocketClient real;
    CHECK (real.connect (port2) == 101);
    real.sendClose (1000);
    CHECK (real.waitForClose());
    server2.stop();
}

static void testWebSocketToken()
{
    section ("WebSocket: the pairing token");
    auto dir = tempDir ("token");
    Pairing pairing (dir);
    Received received;
    WebSocketServer::Options options;
    options.name = "token";
    options.checkToken = [&pairing] (const std::string& token) { return pairing.checkToken (token); };
    WebSocketServer strict (options, echoHandlers (received));
    options.name = "control";
    options.allowUnauthenticated = true;
    std::atomic<int> unauthenticatedTexts { 0 };
    auto handlers = echoHandlers (received);
    auto inner = handlers.onText;
    handlers.onText = [&, inner] (const WebSocketServer::ConnectionPtr& c, const std::string& text)
    {
        if (! c->isAuthenticated())
        {
            ++unauthenticatedTexts;
            if (text == "PAIR")
                c->markAuthenticated();
            return;
        }
        inner (c, text);
    };
    WebSocketServer control (options, handlers);
    std::string error;
    CHECK (strict.start (error) && control.start (error));

    TestWebSocketClient none, wrong, upper, right, encoded, otherParam;
    CHECK (none.connect (strict.getPort()) == 403);
    CHECK (wrong.connect (strict.getPort(), "/?token=" + std::string (64, '0')) == 403);
    CHECK (right.connect (strict.getPort(), "/?token=" + pairing.getToken()) == 101);
    CHECK (upper.connect (strict.getPort(), "/?x=1&token=" + lowerCase (pairing.getToken()) + "&y=2", "http://localhost:5173") == 101);
    CHECK (encoded.connect (strict.getPort(), "/?token=" + pairing.getToken().substr (0, 2) + "%" + pairing.getToken().substr (2)) == 403);
    CHECK (otherParam.connect (strict.getPort(), "/?tokens=" + pairing.getToken()) == 403);
    CHECK (none.waitForClose() && wrong.waitForClose());
    std::string reply;
    CHECK (right.sendText ("hi") && right.readText (reply) && reply == "echo:hi");

    // The control server admits a tokenless client, but it isn't authenticated
    // until it pairs, and broadcasts skip it
    TestWebSocketClient pairing1, paired;
    CHECK (pairing1.connect (control.getPort()) == 101);
    CHECK (paired.connect (control.getPort(), "/?token=" + pairing.getToken()) == 101);
    CHECK (waitFor ([&] { return control.getConnectionCount() == 2; }));
    CHECK (pairing1.sendText ("hello"));
    CHECK (waitFor ([&] { return unauthenticatedTexts.load() == 1; }));
    control.broadcastText ("secret");
    CHECK (paired.readText (reply) && reply == "secret");
    CHECK (pairing1.sendText ("PAIR"));
    CHECK (waitFor ([&] { return unauthenticatedTexts.load() == 2; }));
    control.broadcastText ("now you too");
    CHECK (pairing1.readText (reply) && reply == "now you too");
    CHECK (paired.readText (reply) && reply == "now you too");
    CHECK (pairing1.sendText ("echo me") && pairing1.readText (reply) && reply == "echo:echo me");

    // Rotating the token: the old one no longer opens a connection
    auto old = pairing.getToken();
    pairing.rotateToken();
    TestWebSocketClient stale, fresh;
    CHECK (stale.connect (strict.getPort(), "/?token=" + old) == 403);
    CHECK (fresh.connect (strict.getPort(), "/?token=" + pairing.getToken()) == 101);

    strict.stop();
    control.stop();
    fs::remove_all (dir);
}

static void testExecutable (const fs::path& exe)
{
    section ("ghostdaw: --version; a taken port exits 1; a second instance exits 2");
    if (! fileExists (exe))
    {
        std::cout << "  (no ghostdaw executable at " << pathToUtf8 (exe) << ")" << std::endl;
        CHECK (false);
        return;
    }
    CHECK (runProcess (quote (exe) + " --version") == 0);
    CHECK (runProcess (quote (exe) + " --bogus") == 1);

    auto dir = tempDir ("exe");
    TcpListener taken;
    std::string error;
    CHECK (taken.listen (0, error));
    auto ports = " --port " + std::to_string (taken.getPort()) + " --stream-port " + std::to_string (taken.getPort())
               + " --editor-port " + std::to_string (taken.getPort());
    CHECK (runProcess (quote (exe) + " --data-dir " + quote (dir) + ports) == 1);
    std::string log;
    CHECK (readFile (dir / "ghostdaw.log", log) && log.find ("bind 127.0.0.1:") != std::string::npos);
    CHECK (fileExists (dir / "pairing-token"));

    {
        InstanceLock held (dir / "ghostdaw.lock");
        CHECK (held.isHeld());
        CHECK (runProcess (quote (exe) + " --data-dir " + quote (dir) + ports) == 2);
    }
    fs::remove_all (dir);
}

void platformTests (const char* self)
{
    testJson();
    testEncodings();
    testLoop();
    testFiles();
    testPairing();
    testInstanceLock();
    testCrashHandler (self);
    testSockets();
    testWebSocketHandshake();
    testWebSocketFraming();
    testWebSocketLimits();
    testWebSocketToken();
   #ifdef GHOSTDAW_EXE_PATH
    testExecutable (pathFromUtf8 (GHOSTDAW_EXE_PATH));
   #endif
}
