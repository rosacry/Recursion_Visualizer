class Solution {
public:
    vector<vector<int>> combinationSum(vector<int>& candidates, int target) {
        std::ranges::sort(candidates);
        vector<vector<int>> result;
        vector<int> path;
        dfs(candidates, 0, target, path, result);
        return result;
    }

private:
    void dfs(const vector<int>& candidates, int start, int remaining,
             vector<int>& path, vector<vector<int>>& result) {
        if (remaining == 0) {
            result.push_back(path);
            return;
        }
        for (int i = start; i < (int)candidates.size(); ++i) {
            if (candidates[i] > remaining) {
                break;
            }
            path.push_back(candidates[i]);
            dfs(candidates, i, remaining - candidates[i], path, result);
            path.pop_back();
        }
    }
};
