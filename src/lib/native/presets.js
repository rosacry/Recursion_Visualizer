/** Built-in native C++20 workspaces. Sources live in native/examples so the
 *  browser and the command-line verification (native/test) use the same files. */
import canIWinSolution from '../../../native/examples/can-i-win/solution.cpp?raw'
import canIWinDriver from '../../../native/examples/can-i-win/driver.cpp?raw'
import comboSolution from '../../../native/examples/combination-sum/solution.cpp?raw'
import comboDriver from '../../../native/examples/combination-sum/driver.cpp?raw'
import blankSolution from '../../../native/examples/blank/solution.cpp?raw'
import blankDriver from '../../../native/examples/blank/driver.cpp?raw'

export const PRESETS = [
  {
    id: 'can-i-win',
    title: 'LeetCode 464 · Can I Win (reference)',
    solution: canIWinSolution,
    driver: canIWinDriver,
    inputs: [
      { label: 'canIWin(4, 9)', stdin: '4 9\n' },
      { label: 'canIWin(18, 79)', stdin: '18 79\n' },
    ],
  },
  {
    id: 'combination-sum',
    title: 'LeetCode 39 · Combination Sum',
    solution: comboSolution,
    driver: comboDriver,
    inputs: [
      { label: 'combinationSum([2,3,6,7], 7)', stdin: '[2,3,6,7]\n7\n' },
      { label: 'combinationSum([2,3,5], 8)', stdin: '[2,3,5]\n8\n' },
    ],
  },
  {
    id: 'blank',
    title: 'New problem (LeetCode-style template)',
    solution: blankSolution,
    driver: blankDriver,
    inputs: [{ label: 'n = 5', stdin: '5\n' }],
  },
]

export const DEFAULT_PRESET = PRESETS[0]

export function presetById(id) {
  return PRESETS.find((p) => p.id === id) || null
}
