#pragma once

#include <cstdint>
#include <initializer_list>
#include <optional>
#include <string>
#include <utility>
#include <vector>

namespace ghostdaw
{

// A JSON value (RFC 8259): the protocol's messages, the settings and the
// saved state. Objects keep their keys in insertion order, so what goes out
// is deterministic. Reading a missing key or index gives a null value, so
// message["buses"][0]["inserts"] is safe on anything.
class Json
{
public:
    enum class Type { null, boolean, number, string, array, object };

    using Array = std::vector<Json>;
    using Object = std::vector<std::pair<std::string, Json>>;

    Json() = default;
    Json (std::nullptr_t) {}
    Json (bool b) : type_ (Type::boolean), bool_ (b) {}
    Json (int n) : type_ (Type::number), number_ (n) {}
    Json (unsigned n) : type_ (Type::number), number_ (n) {}
    Json (int64_t n) : type_ (Type::number), number_ (static_cast<double> (n)) {}
    Json (uint64_t n) : type_ (Type::number), number_ (static_cast<double> (n)) {}
    Json (double d) : type_ (Type::number), number_ (d) {}
    Json (float f) : type_ (Type::number), number_ (f) {}
    Json (const char* s) : type_ (Type::string), string_ (s) {}
    Json (std::string s) : type_ (Type::string), string_ (std::move (s)) {}
    Json (Array a) : type_ (Type::array), array_ (std::move (a)) {}
    Json (Object o) : type_ (Type::object), object_ (std::move (o)) {}

    static Json array() { return Json (Array {}); }
    static Json object() { return Json (Object {}); }
    // Json::object ({ { "type", "PAIR" }, { "code", code } })
    static Json object (std::initializer_list<std::pair<const char*, Json>> items);

    Type type() const { return type_; }
    bool isNull() const { return type_ == Type::null; }
    bool isBool() const { return type_ == Type::boolean; }
    bool isNumber() const { return type_ == Type::number; }
    bool isString() const { return type_ == Type::string; }
    bool isArray() const { return type_ == Type::array; }
    bool isObject() const { return type_ == Type::object; }

    // Conversions, with a fallback for the wrong type. A string that reads
    // as a number converts; a number converts to its shortest text.
    bool toBool (bool fallback = false) const;
    double toDouble (double fallback = 0.0) const;
    int toInt (int fallback = 0) const;
    int64_t toInt64 (int64_t fallback = 0) const;
    std::string toString (const std::string& fallback = {}) const;

    // Objects: a missing key reads as null (reading never creates it)
    const Json& operator[] (const char* key) const;
    const Json& operator[] (const std::string& key) const { return (*this)[key.c_str()]; }
    // The member to write to, created (null) if missing; a non-object
    // becomes an object
    Json& member (const char* key);
    Json& member (const std::string& key) { return member (key.c_str()); }
    bool has (const char* key) const;
    bool has (const std::string& key) const { return has (key.c_str()); }
    // The value under `key`, or `fallback` when it is missing or null
    const Json& get (const char* key, const Json& fallback) const;
    Json& set (const char* key, Json value); // returns *this, for chaining
    bool remove (const char* key);

    // Arrays: out of range reads as null
    const Json& operator[] (size_t index) const;
    const Json& operator[] (int index) const { return index < 0 ? (*this)[static_cast<size_t> (-1)] : (*this)[static_cast<size_t> (index)]; }
    // The element to write to, growing the array as needed
    Json& element (size_t index);
    Json& push (Json value); // returns *this; a non-array becomes an array

    // Array length or object key count (0 for anything else)
    size_t size() const;

    const Array& elements() const { return array_; }
    Array& elements() { return array_; }
    const Object& items() const { return object_; }
    Object& items() { return object_; }

    bool operator== (const Json& other) const;
    bool operator!= (const Json& other) const { return ! (*this == other); }

    // Serialises to one line of JSON (`indent` > 0: pretty-printed)
    std::string dump (int indent = 0) const;

    // Parses text; nullopt (and `error`, when given) on malformed input.
    // Nesting is limited to 128 levels.
    static std::optional<Json> parse (const std::string& text, std::string* error = nullptr);

private:
    Type type_ = Type::null;
    bool bool_ = false;
    double number_ = 0.0;
    std::string string_;
    Array array_;
    Object object_;

    void dumpTo (std::string& out, int indent, int depth) const;
};

} // namespace ghostdaw
