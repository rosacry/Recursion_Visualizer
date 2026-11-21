// Test driver. The harness compiles THIS file; it #includes your solution.cpp
// unchanged, so every line number in the trace is a line number of your paste.
// LeetCode provides headers and `using namespace std;` implicitly, so they go here.
#include <bits/stdc++.h>
using namespace std;

#include "lc.hpp"          // lc::read<T>(cin) parses 5, true, "s", [1,2], [[1],[2]] ; lc::str(x) prints them
#include "solution.cpp"    // your solution, compiled unchanged

int main() {
    auto n = lc::read<int>(cin);
    Solution solution;
    cout << lc::str(solution.climbStairs(n)) << '\n';
    return 0;
}
