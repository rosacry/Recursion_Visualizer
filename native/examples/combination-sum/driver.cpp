// Test driver for LeetCode 39 "Combination Sum".
// stdin:  candidates on the first line, target on the second, e.g.
//   [2,3,6,7]
//   7
#include <algorithm>
#include <iostream>
#include <vector>
using std::vector;

#include "lc.hpp"          // lc::read / lc::str for LeetCode-style input and output
#include "solution.cpp"    // your solution, compiled unchanged

int main() {
    auto candidates = lc::read<vector<int>>(std::cin);
    auto target = lc::read<int>(std::cin);
    Solution solution;
    auto answer = solution.combinationSum(candidates, target);
    std::cout << lc::str(answer) << '\n';
    return 0;
}
