<div align="center">

# 🔄 Recursion Visualizer

**Watch recursion come alive — one call at a time.**

[![Status](https://img.shields.io/badge/Status-Active-brightgreen?style=for-the-badge)](https://github.com/yuvnex/Recursion_Visualizer)
[![React](https://img.shields.io/badge/React-18-61DAFB?style=for-the-badge&logo=react&logoColor=black)](https://react.dev)
[![Vite](https://img.shields.io/badge/Vite-Ready-646CFF?style=for-the-badge&logo=vite&logoColor=white)](https://vitejs.dev)
[![License](https://img.shields.io/badge/License-MIT-yellow?style=for-the-badge)](./LICENSE)
[![PRs Welcome](https://img.shields.io/badge/PRs-Welcome-ff69b4?style=for-the-badge)](./CONTRIBUTING.md)

An interactive, browser-based tool that transforms abstract recursive algorithms into stunning visual experiences. Watch the call tree build in real-time, see the call stack grow and shrink, and finally *get* recursion.

[**Live Demo**](https://github.com/yuvnex/Recursion_Visualizer) · [**Report a Bug**](https://github.com/yuvnex/Recursion_Visualizer/issues) · [**Request a Feature**](https://github.com/yuvnex/Recursion_Visualizer/issues)

</div>

---

## 📸 Gallery

| Factorial | Fibonacci |
|:---------:|:---------:|
| ![Factorial Visualization](./public/hr-reference-factorial.png) | ![Fibonacci Visualization](./public/hr-reference-fibonacci.png) |
| *Linear recursion with a single call chain* | *Exponential branching with overlapping subproblems* |

---

## ✨ Features

| Feature | Description |
|---|---|
| 🌳 **Dynamic Call Tree** | Nodes reveal parent-child relationships and execution phases in real-time |
| 📚 **Live Call Stack** | Tracks active frames, parameters, and return values as execution unfolds |
| ▶️ **Step-by-Step Playback** | Pause, rewind, and replay any point in the execution |
| 🧩 **Built-in Examples** | Factorial, Fibonacci, Binary Search, Merge Sort, Quick Sort — ready to go |
| ✏️ **Custom Code Editor** | Write your own recursive function and visualize it instantly |
| 🌐 **Multi-Language Support** | JavaScript, Python, Java, and C/C++ (transpiled locally) |
| 🔒 **100% Offline** | All execution and analysis happen in your browser — no server, no API keys |
| 🎨 **Professional UI** | Responsive layouts, smooth animations, and a clean modern design |

---

## 🧪 Native C++20 mode (compiled, executed and traced with GDB)

The **Native C++20** tab (the default page) does not interpret or transpile anything.
Your C++ is compiled with `g++`/`clang++ -std=c++20 -g -O0`, executed, and recorded by
GDB through a small local service. The browser only replays what the debugger recorded.

```powershell
npm install
npm run native          # UI on http://localhost:5173 + trace service on 127.0.0.1:5180
npm run native:verify   # end-to-end checks against the reference programs
```

**Toolchain.** On Windows the compiler and debugger run inside WSL (Ubuntu); on Linux they run
directly. Needed there: `g++` (12 recommended) or `clang++`, `gdb` (with Python, the Ubuntu
package has it) and `python3`, e.g. `sudo apt install g++-12 gdb`. Set `RV_WSL_DISTRO` to pick a
WSL distro, `RV_NATIVE_PORT` to move the service.

**Workflow.** Paste your LeetCode solution into `solution.cpp` (it is compiled byte-for-byte, so
trace line numbers are your line numbers). `driver.cpp` holds `main()`, the headers and `using`
declarations LeetCode normally supplies, and `#include "solution.cpp"`. Input comes from stdin;
`#include "lc.hpp"` gives `lc::read<T>(std::cin)` / `lc::str(x)` for LeetCode-style values such as
`[2,3,6,7]` or `[["a","b"]]`. Workspaces are kept in your browser (localStorage).

**What one step is.** A *call* step: a function of `solution.cpp` was entered (parameters bound,
first line about to run). A *line* step: execution reached a new source line in the same
invocation — GDB's own `step` rule, so a line with several operations is one step and a loop
header appears once per iteration. A *return* step: the callee returned (value captured at the
return address); the caller is stopped in the middle of the calling line. Values are read from
memory at the stop, i.e. **before** the highlighted line runs. Stepping backward shows the values
recorded at that step, including earlier contents of shared objects.

**What you see.** Every invocation has its own id (`#7 backtrack`). The stack shows which frame is
active and which are waiting (and where); on a return the parent that resumes is highlighted and
"changed while #N ran" lists what its callee changed. Variables are bound to memory addresses, so
references (`unsigned int& p1`) show as one shared object across frames while by-value locals are
each frame's own copy. Element accesses on the current line (`memo[available]`) are shown with the
index (binary and decimal) and the stored value. Unsigned integers default to binary (`1000₂ = 8`,
set bits `{4}`), signed ones to decimal; click any value to switch. Labels: *not initialized yet*,
*out of scope*, *unavailable*, and a banner when a trace limit is reached.

**Limits.** Only `solution.cpp` is traced (the driver and the standard library run natively and
are not stepped into). Default limit 25 000 recorded steps (~0.4 ms per step); after the limit the
program keeps running untraced and the page reports whether it finished, its output and the root
call's return value. Scalar arrays/vectors are tracked element by element (up to 2²⁰ elements);
other containers (`map`, `unordered_map`, `set`, `deque`, …) are shown with GDB's printers as text;
structs one level deep through pointers. Single-threaded programs; x86-64 only. The service runs
the code you paste on your machine (inside WSL as your user), listens on 127.0.0.1 only and rejects
requests from other origins.

How it works: `native/server.mjs` (Node, no dependencies) → `native/runner/rv_job.py` (compile,
direct run, GDB run) → `native/runner/rv_tracer.py` (GDB Python: breakpoints on every line-table
row of the traced file, return-site breakpoints / `FinishBreakpoint`s for return values, memory
snapshots diffed per step). The React UI is in `src/components/native` and
`src/lib/native/traceModel.js`.

---

## 🚀 Quick Start

### Prerequisites

- [Node.js](https://nodejs.org/) v16 or higher
- npm or yarn

### Installation

```bash
# 1. Clone the repository
git clone https://github.com/yuvnex/Recursion_Visualizer.git

# 2. Navigate into the project
cd Recursion_Visualizer

# 3. Install dependencies
npm install

# 4. Start the development server
npm run dev
```

Open your browser to **[http://localhost:5173](http://localhost:5173)** and start visualizing!

### Production Build

```bash
npm run build    # Compile and optimize for production
npm run preview  # Preview the production build locally
```

---

## 💡 How to Use

### Option 1 — Built-in Examples

Select any pre-loaded algorithm from the sidebar (Fibonacci, Quick Sort, Binary Search, etc.) to immediately see its full execution tree rendered step by step.

### Option 2 — Custom Code

1. Switch to **"Custom Code"** mode in the sidebar.
2. Choose your preferred language from the dropdown.
3. Write or paste your recursive function. Make sure it includes:
   - A **base case** to terminate execution
   - At least one **recursive call**
   - A **function invocation** at the end of the snippet
4. Click **"Analyze & Visualize"** and watch it unfold.

**Example — Factorial in JavaScript:**

```javascript
function factorial(n) {
  if (n <= 1) {
    return 1; // Base case
  }
  return n * factorial(n - 1); // Recursive call
}

factorial(5); // Invoke at the end!
```

### Reading the Visualization

The recursion tree uses color-coded nodes to show exactly where execution is at any given moment:

| Color | Phase | Meaning |
|:-----:|-------|---------|
| 🟠 **Amber** | Calling | Currently executing this frame |
| 🟣 **Purple** | Returning | Unwinding — returning a value |
| 🟢 **Green** | Base Case | Recursion terminates here |
| ⚫ **Gray** | Complete | Frame fully resolved |

> **Tip:** The **Code Editor** panel highlights the active line in sync with each step — green for base cases, blue for recursive calls.

---

## 🛠️ Architecture

```
src/
├── api/
│   └── llmClient.js          # Unified analysis interface (delegates to local engine)
├── components/
│   └── recursion/
│       └── ExampleSelector.jsx   # Built-in algorithm examples registry
└── lib/
    ├── codeRunner.js         # Transpilation engine + sandboxed JS execution + tracing
    └── recursionTreeBuilder.js   # Tree structure computation + execution timeline
```

### Tech Stack

| Layer | Technology |
|---|---|
| **Framework** | React 18 + Vite |
| **Styling** | Tailwind CSS + Radix UI |
| **Animations** | Framer Motion |
| **Execution** | Custom JS sandbox transpiler (no external runtime) |

---

## ⚠️ Known Limitations

These safeguards exist to ensure smooth performance in the browser:

- **Max recursion depth** is capped at **500 calls** to prevent stack overflows.
- **Single function tracing** — the engine traces one primary recursive function per run.
- **Simple recursion only** — complex cross-function mutual recursion may not trace correctly.
- **Parameter rendering** — best suited for primitives and basic arrays; deeply nested objects may render partially.

---

## 🤝 Contributing

Contributions are warmly welcome! Here are two common ways to get involved:

### ➕ Add a New Built-in Example

Open `src/components/recursion/ExampleSelector.jsx` and add an entry to the `EXAMPLES` array:

```javascript
{
  id: "your-algorithm",
  name: "Your Algorithm",
  difficulty: "Medium",       // "Easy" | "Medium" | "Hard"
  description: "Brief description of what this algorithm does.",
  input: 6,
  code: `function yourAlgorithm(n) { ... }\nyourAlgorithm(6);`
}
```

### 🌐 Extend Language Support

Open `src/lib/codeRunner.js` and update the `transpileToJS()` switch statement with a new case for your language, including detection patterns and transpilation logic.

---

