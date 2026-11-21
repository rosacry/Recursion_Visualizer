// lc.hpp — small helpers for LeetCode-style test drivers (never traced).
//
//   auto nums   = lc::read<std::vector<int>>(std::cin);      // [2,3,6,7]
//   auto target = lc::read<int>(std::cin);                   // 7
//   auto grid   = lc::read<std::vector<std::vector<char>>>(std::cin);  // [["1","0"],["0","1"]]
//   std::cout << lc::str(answer) << '\n';                     // [[2,2,3],[7]]
//
// Values may be separated by whitespace, commas or newlines.  Strings and chars
// are written in double quotes, booleans as true/false.
#pragma once
#include <cctype>
#include <istream>
#include <sstream>
#include <stdexcept>
#include <string>
#include <type_traits>
#include <vector>

namespace lc {

namespace detail {
inline void skip(std::istream& in) {
    while (true) {
        int c = in.peek();
        if (c == EOF) return;
        if (std::isspace(c) || c == ',') { in.get(); continue; }
        return;
    }
}
inline void expect(std::istream& in, char want) {
    skip(in);
    int c = in.get();
    if (c != want) throw std::runtime_error(std::string("lc::read: expected '") + want + "'");
}
inline std::string quoted(std::istream& in) {
    skip(in);
    if (in.peek() != '"') {  // bare word
        std::string s;
        while (in.peek() != EOF && !std::isspace(in.peek()) && in.peek() != ',' && in.peek() != ']') s += char(in.get());
        return s;
    }
    in.get();
    std::string s;
    for (int c = in.get(); c != EOF && c != '"'; c = in.get()) {
        if (c == '\\') c = in.get();
        s += char(c);
    }
    return s;
}
template <class T> struct is_vector : std::false_type {};
template <class T, class A> struct is_vector<std::vector<T, A>> : std::true_type {};
}  // namespace detail

template <class T>
T read(std::istream& in) {
    using detail::skip;
    if constexpr (detail::is_vector<T>::value) {
        T out;
        detail::expect(in, '[');
        skip(in);
        while (in.peek() != ']') {
            if (in.peek() == EOF) throw std::runtime_error("lc::read: unterminated list");
            out.push_back(read<typename T::value_type>(in));
            skip(in);
        }
        in.get();
        return out;
    } else if constexpr (std::is_same_v<T, std::string>) {
        return detail::quoted(in);
    } else if constexpr (std::is_same_v<T, char>) {
        std::string s = detail::quoted(in);
        return s.empty() ? '\0' : s[0];
    } else if constexpr (std::is_same_v<T, bool>) {
        std::string s = detail::quoted(in);
        return s == "true" || s == "1";
    } else {
        skip(in);
        T v{};
        if (!(in >> v)) throw std::runtime_error("lc::read: could not parse a number");
        return v;
    }
}

template <class T>
std::string str(const T& v) {
    std::ostringstream os;
    if constexpr (detail::is_vector<T>::value) {
        os << '[';
        for (std::size_t i = 0; i < v.size(); ++i) os << (i ? "," : "") << str(v[i]);
        os << ']';
    } else if constexpr (std::is_same_v<T, std::string>) {
        os << '"' << v << '"';
    } else if constexpr (std::is_same_v<T, char>) {
        os << '"' << v << '"';
    } else if constexpr (std::is_same_v<T, bool>) {
        os << (v ? "true" : "false");
    } else {
        os << v;
    }
    return os.str();
}

}  // namespace lc
