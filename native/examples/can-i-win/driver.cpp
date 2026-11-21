// Test driver for LeetCode 464 "Can I Win".
// The harness compiles THIS file. It #includes your solution.cpp unchanged,
// so every line number in the trace is a line number in your pasted code.
#include <vector>
using std::vector;

#include "solution.cpp"

#include <iostream>

int main() {
    int maxChoosableInteger = 0;
    int desiredTotal = 0;
    if (!(std::cin >> maxChoosableInteger >> desiredTotal)) {
        std::cerr << "stdin must contain two integers: maxChoosableInteger desiredTotal\n";
        return 2;
    }
    Solution solution;
    bool result = solution.canIWin(maxChoosableInteger, desiredTotal);
    std::cout << std::boolalpha << result << '\n';
    return 0;
}
