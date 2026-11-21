#include <bit>

class Solution {
public:
    bool canIWin(int maxChoosableInteger, int desiredTotal) {
        if (maxChoosableInteger >= desiredTotal) {
            return true;
        }
        if ((maxChoosableInteger * (maxChoosableInteger + 1)) / 2 < desiredTotal) {
            return false;
        }
        unsigned int p1 = 0;
        unsigned int p2 = 0;
        // unordered_map<unsigned int, bool> memo;
        vector<signed char> memo(1u << maxChoosableInteger, -1);
        return backtrack(maxChoosableInteger, p1, p2, desiredTotal, 0, memo);
    }
    // true means Player 1 can force a win from this position.
    bool backtrack(int maxChoosableInteger, unsigned int& p1, unsigned int& p2,
                   int remainder, int playerSwitch, vector<signed char>& memo) {
        unsigned int available = ~(p1 | p2) & ((1u << maxChoosableInteger) - 1);
        if (memo[available] != -1) {
            return memo[available] == 1;
        }
        unsigned int highestBit = std::bit_floor(available);
        int highest = std::bit_width(highestBit);
        // The current player can win on this turn.
        if (highest >= remainder) {
            return playerSwitch == 0;
        }
        unsigned int candidates = available;
        int secondHighest = std::bit_width(available & ~highestBit);
        if (highest + secondHighest >= remainder) {
            int largestSafePick = remainder - highest - 1;
            candidates &= (1u << largestSafePick) - 1;
        }
        unsigned int savedP1 = p1;
        unsigned int savedP2 = p2;
        while (candidates != 0) {
            unsigned int position = std::bit_floor(candidates);
            int pick = std::bit_width(position);
            candidates &= ~position;
            if (playerSwitch == 0) {
                p1 |= position;
            } else {
                p2 |= position;
            }
            if (backtrack(maxChoosableInteger, p1, p2,
                          remainder - pick, playerSwitch ^ 1, memo)) {
                if (playerSwitch == 0) {
                    memo[available] = 1;
                    return true;
                }
            } else {
                if (playerSwitch == 1) {
                    memo[available] = 0;
                    return false;
                }
            }
            p1 = savedP1;
            p2 = savedP2;
        }
        memo[available] = (playerSwitch == 1);
        return playerSwitch == 1;
    }
};
