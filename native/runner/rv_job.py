#!/usr/bin/env python3
"""
rv_job.py - one native C++ run for the Recursion Visualizer (runs on Linux / WSL).

Reads a job description (JSON) on stdin, writes the result (JSON) on stdout.
Progress lines ("@@progress {...}") go to stderr.

  1. writes the sources into a fresh work directory (your solution.cpp is
     written byte-for-byte, so line numbers in the trace are your line numbers)
  2. compiles the driver with g++/clang++ in C++20 mode, -g -O0
  3. runs the executable directly (no debugger) with the chosen stdin
  4. runs the same executable under GDB with rv_tracer.py, which records the
     calls, returns, executed lines and memory of the traced source file
"""

import json
import os
import re
import shlex
import shutil
import signal
import subprocess
import sys
import tempfile
import time

HERE = os.path.dirname(os.path.realpath(__file__))
TRACER = os.path.join(HERE, "rv_tracer.py")
INCLUDE = os.path.join(HERE, "include")

COMPILERS = {
    "g++": ["g++-12", "g++"],
    "clang++": ["clang++-15", "clang++-14", "clang++"],
}

MAX_OUTPUT = 256 * 1024


def progress(**kw):
    sys.stderr.write("@@progress " + json.dumps(kw) + "\n")
    sys.stderr.flush()


def which(names):
    for n in names:
        p = shutil.which(n)
        if p:
            return p
    return None


def version_of(exe):
    try:
        out = subprocess.run([exe, "--version"], capture_output=True, text=True, timeout=10).stdout
        return out.strip().splitlines()[0] if out.strip() else exe
    except Exception:  # noqa: BLE001
        return exe


def read_capped(path):
    try:
        with open(path, "rb") as fh:
            data = fh.read(MAX_OUTPUT + 1)
    except OSError:
        return "", False
    trunc = len(data) > MAX_OUTPUT
    return data[:MAX_OUTPUT].decode("utf-8", "replace"), trunc


def limit_preexec(mem_mb, cpu_s):
    def fn():
        try:
            import resource
            if mem_mb:
                b = mem_mb * 1024 * 1024
                resource.setrlimit(resource.RLIMIT_AS, (b, b))
            if cpu_s:
                resource.setrlimit(resource.RLIMIT_CPU, (cpu_s, cpu_s + 1))
            resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
        except Exception:  # noqa: BLE001
            pass
        os.setsid()
    return fn


def run_proc(cmd, cwd, stdin_path, stdout_path, stderr_path, timeout, env=None, mem_mb=None,
             cpu_s=None, on_stderr_line=None):
    t0 = time.time()
    with open(stdin_path, "rb") as fin, open(stdout_path, "wb") as fout:
        ferr = open(stderr_path, "wb") if on_stderr_line is None else subprocess.PIPE
        p = subprocess.Popen(cmd, cwd=cwd, stdin=fin, stdout=fout, stderr=ferr, env=env,
                             preexec_fn=limit_preexec(mem_mb, cpu_s))
        timed_out = False
        if on_stderr_line is not None:
            import selectors
            sel = selectors.DefaultSelector()
            sel.register(p.stderr, selectors.EVENT_READ)
            buf = b""
            with open(stderr_path, "wb") as errlog:
                while True:
                    remaining = timeout - (time.time() - t0)
                    if remaining <= 0:
                        timed_out = True
                        break
                    events = sel.select(timeout=min(0.5, remaining))
                    if events:
                        chunk = os.read(p.stderr.fileno(), 65536)
                        if not chunk:
                            break
                        buf += chunk
                        while b"\n" in buf:
                            line, buf = buf.split(b"\n", 1)
                            s = line.decode("utf-8", "replace")
                            if s.startswith("@@progress "):
                                on_stderr_line(s)
                            else:
                                errlog.write(line + b"\n")
                    elif p.poll() is not None:
                        break
            try:
                p.wait(timeout=max(0.1, timeout - (time.time() - t0)))
            except subprocess.TimeoutExpired:
                timed_out = True
        else:
            try:
                p.wait(timeout=timeout)
            except subprocess.TimeoutExpired:
                timed_out = True
            ferr.close()
        if timed_out:
            try:
                os.killpg(p.pid, signal.SIGKILL)
            except OSError:
                pass
            p.wait()
    rc = p.returncode
    res = {"exitCode": rc if rc is not None and rc >= 0 else None,
           "signal": signal.Signals(-rc).name if rc is not None and rc < 0 else None,
           "timedOut": timed_out, "seconds": round(time.time() - t0, 4)}
    return res


def main():
    job = json.load(sys.stdin)
    t_start = time.time()
    files = job.get("files") or {}
    main_file = job.get("main", "driver.cpp")
    trace_files = job.get("traceFiles") or ["solution.cpp"]
    stdin_text = job.get("stdin", "")
    limits = job.get("limits") or {}
    compiler_key = job.get("compiler", "g++")
    std = job.get("std", "c++20")
    extra_flags = [f for f in (job.get("extraFlags") or []) if isinstance(f, str)]

    for name in list(files) + [main_file] + trace_files:
        if not re.match(r"^[A-Za-z0-9_.\-]+$", name) or name.startswith("."):
            print(json.dumps({"ok": False, "stage": "input", "error": "bad file name: %r" % name}))
            return

    work = tempfile.mkdtemp(prefix="rv-native-")
    result = {"ok": False, "workDir": work}
    try:
        for name, text in files.items():
            with open(os.path.join(work, name), "w", encoding="utf-8", newline="") as fh:
                fh.write(text)
        stdin_path = os.path.join(work, "stdin.txt")
        with open(stdin_path, "w", encoding="utf-8", newline="") as fh:
            fh.write(stdin_text)

        # ---- toolchain -------------------------------------------------------
        cxx = which(COMPILERS.get(compiler_key, [compiler_key]))
        gdb = which(["gdb"])
        result["toolchain"] = {
            "compiler": cxx, "compilerVersion": version_of(cxx) if cxx else None,
            "gdb": gdb, "gdbVersion": version_of(gdb) if gdb else None,
            "platform": " ".join(os.uname()),
        }
        if not cxx:
            result.update(stage="compile", error="compiler %s not found" % compiler_key)
            return
        # ---- compile ---------------------------------------------------------
        progress(phase="compile")
        exe = os.path.join(work, "prog")
        flags = ["-std=" + std, "-g", "-O0", "-fno-omit-frame-pointer", "-fno-inline",
                 "-no-pie", "-fno-pie", "-Wall", "-Wextra", "-fdiagnostics-color=never"]
        if "clang" in os.path.basename(cxx):
            flags += ["-fstandalone-debug"]
        cmd = [cxx] + flags + extra_flags + ["-I", INCLUDE, "-o", exe, main_file]
        t0 = time.time()
        cp = subprocess.run(cmd, cwd=work, capture_output=True, text=True, timeout=120)
        result["compile"] = {
            "command": " ".join(shlex.quote(c if c != INCLUDE else "<runner>/include") for c in
                                [os.path.basename(cmd[0])] + cmd[1:]),
            "exitCode": cp.returncode, "stdout": cp.stdout[-MAX_OUTPUT:], "stderr": cp.stderr[-MAX_OUTPUT:],
            "seconds": round(time.time() - t0, 3), "ok": cp.returncode == 0,
        }
        if cp.returncode != 0:
            result.update(stage="compile", error="compilation failed")
            return

        mem_mb = int(limits.get("memoryMB", 2048))
        run_s = float(limits.get("runSeconds", 10))

        # ---- direct native run (no debugger) ------------------------------
        progress(phase="direct-run")
        d_out, d_err = os.path.join(work, "direct.out"), os.path.join(work, "direct.err")
        dr = run_proc([exe], work, stdin_path, d_out, d_err, run_s, mem_mb=mem_mb, cpu_s=int(run_s) + 1)
        dr["stdout"], dr["stdoutTruncated"] = read_capped(d_out)
        dr["stderr"], dr["stderrTruncated"] = read_capped(d_err)
        result["direct"] = dr

        # ---- traced run under GDB -------------------------------------------
        if not gdb:
            result.update(stage="trace", error="gdb not found")
            return
        progress(phase="trace", steps=0)
        t_out, t_err = os.path.join(work, "traced.out"), os.path.join(work, "traced.err")
        trace_path = os.path.join(work, "trace.json")
        cfg = {
            "traceFiles": [os.path.join(work, f) for f in trace_files],
            "stdinPath": stdin_path, "stdoutPath": t_out, "stderrPath": t_err,
            "outPath": trace_path,
            "maxSteps": int(limits.get("maxSteps", 25000)),
            "maxSeconds": float(limits.get("traceSeconds", 60)),
            "maxDepth": int(limits.get("maxDepth", 3000)),
            "runSeconds": run_s,
            "maxArrayElements": int(limits.get("maxArrayElements", 1 << 20)),
            "maxCompositeElements": int(limits.get("maxCompositeElements", 256)),
        }
        cfg_path = os.path.join(work, "trace-config.json")
        with open(cfg_path, "w") as fh:
            json.dump(cfg, fh)
        env = dict(os.environ, RV_TRACE_CONFIG=cfg_path, PYTHONDONTWRITEBYTECODE="1")
        gdb_cmd = [gdb, "-nx", "-q", "-batch", "-iex", "set auto-load safe-path /",
                   "-x", TRACER, "--args", exe]
        gdb_log_out, gdb_log_err = os.path.join(work, "gdb.out"), os.path.join(work, "gdb.err")
        devnull = os.path.join(work, "empty.txt")
        open(devnull, "w").close()

        def fwd(line):
            sys.stderr.write(line + "\n")
            sys.stderr.flush()

        budget = cfg["maxSeconds"] + run_s + 30
        gr = run_proc(gdb_cmd, work, devnull, gdb_log_out, gdb_log_err, budget, env=env,
                      on_stderr_line=fwd)
        result["gdbRun"] = gr
        gdb_err, _ = read_capped(gdb_log_err)
        result["gdbStderr"] = gdb_err[-8000:]
        trace = None
        if os.path.exists(trace_path):
            with open(trace_path, "r", encoding="utf-8") as fh:
                trace = json.load(fh)
        if trace is None:
            result.update(stage="trace", error="the tracer produced no trace (GDB failed); see gdbStderr")
            return
        if gr.get("timedOut"):
            trace.setdefault("end", {})["killedByJobTimeout"] = True
        traced = {}
        traced["stdout"], traced["stdoutTruncated"] = read_capped(t_out)
        traced["stderr"], traced["stderrTruncated"] = read_capped(t_err)
        result["traced"] = traced
        result["trace"] = trace
        result["ok"] = True
        result["stage"] = "done"
    finally:
        result["seconds"] = round(time.time() - t_start, 3)
        sys.stdout.write(json.dumps(result, separators=(",", ":")))
        sys.stdout.flush()
        if not os.environ.get("RV_KEEP_WORK"):
            shutil.rmtree(work, ignore_errors=True)


if __name__ == "__main__":
    main()
