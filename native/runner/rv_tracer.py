"""
rv_tracer.py - native execution tracer for the Recursion Visualizer.

Runs INSIDE GDB:   gdb -nx -q -batch -x rv_tracer.py --args ./prog
Configuration comes from the JSON file named by $RV_TRACE_CONFIG.

What is recorded (and nothing else - every value comes from the stopped process):

  * A STEP is one stop of the compiled program, of one of these kinds
      call  - a traced function was entered; the frame is set up and the
              program is about to execute that invocation's first line.
      line  - the program reached the start of a line-table row of a traced
              function whose source line differs from the previous step of
              the same invocation (this is exactly GDB's `step` rule, so a
              line holding several operations is ONE step, and a loop header
              shows up once per iteration).
      ret   - a traced invocation returned (captured by a GDB
              FinishBreakpoint at the return address).  The caller is stopped
              in the MIDDLE of the line that made the call; the rest of that
              line has not executed yet.
      sig   - the program received a fatal signal.
  * Values attached to a step are read from memory at that stop, i.e. they
    are the state BEFORE the highlighted line executes.
  * Variables are bound to memory CELLS keyed by address+type.  A C++
    reference is bound to the cell it refers to, so two frames that share an
    object (p1 by reference) point at the same cell; a by-value local has its
    own cell in its own frame.
  * Values are stored as deltas: a step lists only the cells whose bytes
    changed since the previous step.  Large scalar arrays (memo tables) are
    diffed element by element.
"""

import gdb  # noqa: F401  (provided by GDB)
import bisect
import json
import os
import re
import signal
import struct
import threading
import time

CFG = json.load(open(os.environ["RV_TRACE_CONFIG"], "r", encoding="utf-8"))

MAX_STEPS = int(CFG.get("maxSteps", 25000))
MAX_SECONDS = float(CFG.get("maxSeconds", 60.0))
MAX_DEPTH = int(CFG.get("maxDepth", 3000))
RUN_SECONDS = float(CFG.get("runSeconds", 20.0))
RET_WINDOW = int(CFG.get("returnWindow", 8))
MAX_ARRAY = int(CFG.get("maxArrayElements", 1 << 20))
MAX_COMPOSITE = int(CFG.get("maxCompositeElements", 256))
MAX_TEXT = int(CFG.get("maxTextLength", 2000))
MAX_STRING = int(CFG.get("maxStringLength", 4096))
TRACE_FILES = [os.path.realpath(p) for p in CFG["traceFiles"]]
OUT_PATH = CFG["outPath"]

T0 = time.time()


def gx(cmd):
    return gdb.execute(cmd, to_string=True)


def progress(**kw):
    kw["t"] = round(time.time() - T0, 2)
    try:
        os.write(2, ("@@progress " + json.dumps(kw) + "\n").encode())
    except OSError:
        pass


def int_json(v):
    return v if -(1 << 53) < v < (1 << 53) else str(v)


# --------------------------------------------------------------------------
# Type names for display
# --------------------------------------------------------------------------

_ALLOC_RE = re.compile(r",\s*std::allocator<[^<>]*(?:<[^<>]*(?:<[^<>]*>[^<>]*)*>[^<>]*)*>\s*")


def pretty_type(name):
    s = str(name)
    s = re.sub(r"(?<![A-Za-z0-9_])(?:class|struct|union|enum)[ ]+(?=[A-Za-z_:])", "", s)
    prev = None
    while prev != s:
        prev = s
        s = _ALLOC_RE.sub("", s)
    s = s.replace("std::__cxx11::", "std::")
    s = re.sub(r"std::basic_string<char, std::char_traits<char>\s*>", "std::string", s)
    s = re.sub(r",\s*std::less<[^<>]*>\s*", "", s)
    s = re.sub(r",\s*std::hash<[^<>]*>, std::equal_to<[^<>]*>\s*", "", s)
    s = s.replace("std::", "")
    s = re.sub(r"\s+>", ">", s)
    s = re.sub(r"\s*&", "&", s)
    s = re.sub(r"\s*\*", "*", s)
    return s


def short_function_name(full):
    """Solution::backtrack(int, ...) -> backtrack ; lambdas -> lambda#1."""
    s = full
    depth = 0
    cut = len(s)
    for i in range(len(s) - 1, -1, -1):
        c = s[i]
        if c == ")":
            depth += 1
        elif c == "(":
            depth -= 1
            if depth == 0:
                cut = i
                break
    head = s[:cut]
    m = re.search(r"\{lambda\(([^)]*)\)#(\d+)\}::operator\(\)$", head)
    if m:
        return "lambda#%s" % m.group(2)
    depth = 0
    last = 0
    i = 0
    while i < len(head):
        c = head[i]
        if c in "<(":
            depth += 1
        elif c in ">)":
            depth -= 1
        elif depth == 0 and head.startswith("::", i):
            last = i + 2
            i += 1
        i += 1
    return head[last:] or head


# --------------------------------------------------------------------------
# Memory reads
# --------------------------------------------------------------------------

class ReadCtx(object):
    """Per-stop memory reader: one read for the traced stack span, cached
    reads for everything else."""

    def __init__(self, inf, lo, hi):
        self.inf = inf
        self.lo = lo
        self.hi = hi
        self.span = None
        self.cache = {}
        self.text = {}

    def read(self, addr, n):
        if n <= 0:
            return b""
        if self.lo <= addr and addr + n <= self.hi:
            if self.span is None:
                self.span = bytes(self.inf.read_memory(self.lo, self.hi - self.lo))
            o = addr - self.lo
            return self.span[o:o + n]
        key = (addr, n)
        b = self.cache.get(key)
        if b is None:
            b = bytes(self.inf.read_memory(addr, n))
            self.cache[key] = b
        return b


def u64(b, o=0):
    return struct.unpack_from("<Q", b, o)[0]


# --------------------------------------------------------------------------
# Codecs: decode raw bytes of a type into JSON values
# --------------------------------------------------------------------------

I_FMT = {1: "<b", 2: "<h", 4: "<i", 8: "<q"}
U_FMT = {1: "<B", 2: "<H", 4: "<I", 8: "<Q"}


class Codec(object):
    scalar = False
    indirect = False
    size = 0
    tname = "?"

    def sig(self, ctx, addr):
        return ctx.read(addr, self.size)

    def full(self, ctx, addr):
        raise NotImplementedError

    def change(self, ctx, cell, sig):
        return self.full(ctx, cell.addr)

    def index(self, ctx, addr, i):
        return None


class ScalarCodec(Codec):
    scalar = True

    def __init__(self, t, kind):
        self.t = t
        self.size = t.sizeof
        self.kind = kind  # int | char | bool | enum | float
        self.tname = pretty_type(t)
        self.signed = False
        if kind in ("int", "char", "enum"):
            try:
                self.signed = bool(t.is_signed)
            except Exception:
                self.signed = False
        self.enums = None
        if kind == "enum":
            self.enums = {}
            try:
                for f in t.fields():
                    self.enums[int(f.enumval)] = f.name
            except Exception:
                pass
        if kind == "float":
            self.fmt = {4: "<f", 8: "<d"}.get(self.size)
        elif kind in ("int", "char", "enum", "bool"):
            self.fmt = (I_FMT if self.signed else U_FMT).get(self.size)
        else:
            self.fmt = None

    def desc(self):
        d = {"t": {"int": "i", "char": "i", "enum": "e", "bool": "b", "float": "f"}[self.kind],
             "b": self.size * 8, "s": 1 if self.signed else 0}
        if self.kind == "char" and self.size == 1 and "signed" not in self.tname:
            d["c"] = 1
        if self.kind == "char" and self.size > 1:
            d["c"] = 1
        if self.enums is not None:
            d["en"] = {str(k): v for k, v in self.enums.items()}
        d["ty"] = self.tname
        return d

    def raw(self, b):
        if self.kind == "float":
            if self.fmt is None:
                return "?"
            v = struct.unpack(self.fmt, b)[0]
            if v != v:
                return "nan"
            if v in (float("inf"), float("-inf")):
                return "inf" if v > 0 else "-inf"
            return v
        if self.fmt is not None:
            v = struct.unpack(self.fmt, b)[0]
        else:
            v = int.from_bytes(b, "little", signed=self.signed)
        if self.kind == "bool":
            return v != 0 if v in (0, 1) else int(v)
        return int_json(v)

    def wrap(self, raw):
        d = self.desc()
        d["v"] = raw
        return d

    def full(self, ctx, addr):
        return self.wrap(self.raw(ctx.read(addr, self.size)))


class PtrCodec(Codec):
    def __init__(self, t, depth):
        self.t = t
        self.size = t.sizeof
        self.tname = pretty_type(t)
        self.target = None
        self.cstring = False
        try:
            tt = t.target().strip_typedefs()
        except Exception:
            tt = None
        if tt is not None and depth < 2:
            code = tt.code
            if code in (gdb.TYPE_CODE_INT, gdb.TYPE_CODE_CHAR) and tt.sizeof == 1 and "char" in str(tt):
                self.cstring = True
            elif code in (gdb.TYPE_CODE_INT, gdb.TYPE_CODE_CHAR, gdb.TYPE_CODE_BOOL,
                          gdb.TYPE_CODE_ENUM, gdb.TYPE_CODE_FLT):
                self.target = codec_for(tt, depth + 1)
            elif code == gdb.TYPE_CODE_STRUCT and tt.sizeof > 0:
                self.target = codec_for(tt, depth + 1, shallow=True)
        self.indirect = self.target is not None or self.cstring

    def _target_bytes(self, ctx, p):
        if self.cstring:
            out = b""
            for k in range(0, 256, 32):
                try:
                    chunk = ctx.read(p + k, 32)
                except gdb.MemoryError:
                    break
                z = chunk.find(b"\0")
                if z >= 0:
                    return out + chunk[:z]
                out += chunk
            return out
        return self.target.sig(ctx, p)

    def sig(self, ctx, addr):
        b = ctx.read(addr, self.size)
        if not self.indirect:
            return b
        p = u64(b)
        if p == 0:
            return b
        try:
            return b + self._target_bytes(ctx, p)
        except gdb.MemoryError:
            return b + b"!"

    def full(self, ctx, addr):
        p = u64(ctx.read(addr, self.size))
        out = {"t": "p", "v": "0x%x" % p, "ty": self.tname}
        if p == 0:
            out["null"] = 1
            return out
        if not self.indirect:
            return out
        try:
            if self.cstring:
                out["str"] = self._target_bytes(ctx, p).decode("utf-8", "replace")
            else:
                out["to"] = self.target.full(ctx, p)
        except gdb.MemoryError:
            out["bad"] = 1
        return out


class StructCodec(Codec):
    def __init__(self, t, depth, shallow=False):
        self.t = t
        self.size = t.sizeof
        self.tname = pretty_type(t)
        self.fields = []
        self._collect(t, 0, depth, shallow)
        self.indirect = any(c.indirect for (_, _, c) in self.fields)

    def _collect(self, t, base, depth, shallow):
        for f in t.fields():
            if not hasattr(f, "bitpos"):
                continue  # static member
            if f.is_base_class:
                self._collect(f.type.strip_typedefs(), base + f.bitpos // 8, depth, shallow)
                continue
            if f.artificial or (f.name or "").startswith("_vptr"):
                continue
            if f.bitsize:
                continue
            ft = f.type.strip_typedefs()
            if shallow and ft.code == gdb.TYPE_CODE_PTR:
                c = PtrCodec(ft, 99)
            elif shallow and ft.code == gdb.TYPE_CODE_STRUCT:
                c = TextCodec(ft)
            else:
                c = codec_for(ft, depth + 1)
            self.fields.append((f.name or "?", base + f.bitpos // 8, c))

    def sig(self, ctx, addr):
        if not self.indirect:
            return ctx.read(addr, self.size)
        parts = [ctx.read(addr, self.size)]
        for (_, off, c) in self.fields:
            if c.indirect:
                try:
                    parts.append(c.sig(ctx, addr + off))
                except gdb.MemoryError:
                    parts.append(b"!")
        return b"\x1e".join(parts)

    def full(self, ctx, addr):
        out = []
        for (name, off, c) in self.fields:
            try:
                out.append([name, c.full(ctx, addr + off)])
            except gdb.MemoryError:
                out.append([name, {"t": "na", "v": "cannot read memory"}])
        return {"t": "s", "ty": self.tname, "f": out}


def encode_scalar_run(codec, buf, n):
    """Scalar array -> {'e': [...]} or RLE {'r': [[v, count], ...]}"""
    es = codec.size
    fmt = codec.fmt
    if fmt is not None and codec.kind != "float":
        vals = list(struct.unpack("<%d%s" % (n, fmt[1]), buf[:n * es]))
        if codec.kind == "bool":
            vals = [v != 0 if v in (0, 1) else v for v in vals]
        elif es == 8:
            vals = [int_json(v) for v in vals]
    else:
        vals = [codec.raw(buf[i * es:(i + 1) * es]) for i in range(n)]
    runs = []
    for v in vals:
        if runs and runs[-1][0] == v:
            runs[-1][1] += 1
        else:
            runs.append([v, 1])
    if len(runs) * 2 < len(vals):
        return {"r": runs}
    return {"e": vals}


def diff_elements(old, new, es):
    """Indices of elements that differ between two equally long byte strings."""
    out = []
    n = len(new)
    mo, mn = memoryview(old), memoryview(new)
    big = 4096
    small = 256
    for off in range(0, n, big):
        end = min(n, off + big)
        if mo[off:end] == mn[off:end]:
            continue
        for s in range(off, end, small):
            se = min(end, s + small)
            if mo[s:se] == mn[s:se]:
                continue
            for e in range(s, se, es):
                if mo[e:e + es] != mn[e:e + es]:
                    out.append(e // es)
                    if len(out) > 4096:
                        return None
    return out


class SeqMixin(object):
    """Shared logic for C arrays, std::array and std::vector."""

    def seq_full(self, ctx, start, n, extra):
        out = {"t": "a", "ty": self.tname, "n": n}
        out.update(extra)
        ec = self.elem
        if ec.scalar:
            m = min(n, MAX_ARRAY)
            out["et"] = ec.desc()
            if m:
                out.update(encode_scalar_run(ec, ctx.read(start, m * ec.size), m))
            else:
                out["e"] = []
            if m < n:
                out["trunc"] = m
        else:
            m = min(n, MAX_COMPOSITE)
            els = []
            for i in range(m):
                try:
                    els.append(ec.full(ctx, start + i * ec.size))
                except gdb.MemoryError:
                    els.append({"t": "na", "v": "cannot read memory"})
            out["e"] = els
            if m < n:
                out["trunc"] = m
        return out

    def seq_sig(self, ctx, start, n):
        ec = self.elem
        if ec.scalar:
            m = min(n, MAX_ARRAY)
            return ctx.read(start, m * ec.size) if m else b""
        m = min(n, MAX_COMPOSITE)
        if not ec.indirect:
            return ctx.read(start, m * ec.size) if m else b""
        parts = []
        for i in range(m):
            try:
                parts.append(ec.sig(ctx, start + i * ec.size))
            except gdb.MemoryError:
                parts.append(b"!")
        return b"\x1f".join(parts)

    def seq_patch(self, ctx, old_body, new_body, start, n_old, n_new):
        """Element-level patch for scalar sequences; None if a full value is better."""
        ec = self.elem
        if not ec.scalar:
            return None
        es = ec.size
        common = min(len(old_body), len(new_body)) // es * es
        idx = diff_elements(old_body[:common], new_body[:common], es)
        if idx is None:
            return None
        m_new = min(n_new, MAX_ARRAY)
        idx.extend(range(common // es, m_new))
        if len(idx) > 64 and len(idx) * 4 > m_new:
            return None
        sets = [[i, ec.raw(new_body[i * es:(i + 1) * es])] for i in idx]
        p = {"t": "patch", "set": sets}
        if n_new != n_old:
            p["n"] = n_new
        return p


class ArrayCodec(Codec, SeqMixin):
    def __init__(self, t, depth, elem_type=None, count=None, inner_off=0):
        self.t = t
        self.size = t.sizeof
        self.tname = pretty_type(t)
        if elem_type is None:
            elem_type = t.target().strip_typedefs()
            lo, hi = t.range()
            count = hi - lo + 1
        self.elem = codec_for(elem_type, depth + 1)
        self.count = max(0, count)
        self.inner_off = inner_off
        self.indirect = self.elem.indirect

    def sig(self, ctx, addr):
        return self.seq_sig(ctx, addr + self.inner_off, self.count)

    def full(self, ctx, addr):
        return self.seq_full(ctx, addr + self.inner_off, self.count, {})

    def change(self, ctx, cell, sig):
        if cell.last_sig is not None and self.elem.scalar:
            p = self.seq_patch(ctx, cell.last_sig, sig, addr_of(cell) + self.inner_off,
                               self.count, self.count)
            if p is not None:
                return p
        return self.full(ctx, cell.addr)

    def index(self, ctx, addr, i):
        if 0 <= i < self.count:
            return (self.elem, addr + self.inner_off + i * self.elem.size, self.count)
        return (None, None, self.count)


def addr_of(cell):
    return cell.addr


def find_field_offset(t, name, base=0):
    for f in t.strip_typedefs().fields():
        if not hasattr(f, "bitpos"):
            continue
        if f.name == name:
            return base + f.bitpos // 8
        ft = f.type.strip_typedefs()
        if ft.code == gdb.TYPE_CODE_STRUCT:
            r = find_field_offset(ft, name, base + f.bitpos // 8)
            if r is not None:
                return r
    return None


class VectorCodec(Codec, SeqMixin):
    indirect = True

    def __init__(self, t, depth):
        self.t = t
        self.size = t.sizeof
        self.tname = pretty_type(t)
        et = t.template_argument(0).strip_typedefs()
        self.elem = codec_for(et, depth + 1)
        self.o_start = find_field_offset(t, "_M_start")
        self.o_finish = find_field_offset(t, "_M_finish")
        self.o_eos = find_field_offset(t, "_M_end_of_storage")
        if None in (self.o_start, self.o_finish, self.o_eos):
            raise ValueError("unknown vector layout")

    def hdr(self, b):
        start = u64(b, self.o_start)
        finish = u64(b, self.o_finish)
        eos = u64(b, self.o_eos)
        es = self.elem.size or 1
        if finish < start or eos < finish or (finish - start) % es or (finish - start) > (1 << 31):
            return None
        return start, (finish - start) // es, (eos - start) // es

    def sig(self, ctx, addr):
        b = ctx.read(addr, self.size)
        h = self.hdr(b)
        if h is None:
            return b + b"?"
        return b + b"\x1d" + self.seq_sig(ctx, h[0], h[1])

    def full(self, ctx, addr):
        b = ctx.read(addr, self.size)
        h = self.hdr(b)
        if h is None:
            return {"t": "na", "v": "vector header is not valid (uninitialized?)", "ty": self.tname}
        return self.seq_full(ctx, h[0], h[1], {"cap": h[2], "data": "0x%x" % h[0]})

    def change(self, ctx, cell, sig):
        old = cell.last_sig
        if old is not None and self.elem.scalar:
            ob, nb = old[:self.size], sig[:self.size]
            oh, nh = self.hdr(ob), self.hdr(nb)
            if oh and nh and oh[0] == nh[0]:
                p = self.seq_patch(ctx, old[self.size + 1:], sig[self.size + 1:], nh[0], oh[1], nh[1])
                if p is not None:
                    if oh[2] != nh[2]:
                        p["cap"] = nh[2]
                    return p
        return self.full(ctx, cell.addr)

    def index(self, ctx, addr, i):
        h = self.hdr(ctx.read(addr, self.size))
        if h is None:
            return (None, None, None)
        if 0 <= i < h[1]:
            return (self.elem, h[0] + i * self.elem.size, h[1])
        return (None, None, h[1])


class StringCodec(Codec):
    indirect = True

    def __init__(self, t):
        self.t = t
        self.size = t.sizeof
        self.tname = "string"
        self.o_p = find_field_offset(t, "_M_p")
        self.o_n = find_field_offset(t, "_M_string_length")
        if self.o_p is None or self.o_n is None:
            raise ValueError("unknown string layout")

    def _parts(self, ctx, addr):
        b = ctx.read(addr, self.size)
        p = u64(b, self.o_p)
        n = u64(b, self.o_n)
        if n > (1 << 30):
            return b, None, n
        return b, ctx.read(p, min(n, MAX_STRING)), n

    def sig(self, ctx, addr):
        b, body, n = self._parts(ctx, addr)
        return b + b"\x1d" + (body if body is not None else b"?")

    def full(self, ctx, addr):
        b, body, n = self._parts(ctx, addr)
        if body is None:
            return {"t": "na", "v": "string header is not valid (uninitialized?)", "ty": "string"}
        out = {"t": "str", "v": body.decode("utf-8", "replace"), "n": n}
        if n > MAX_STRING:
            out["trunc"] = MAX_STRING
        return out

    def index(self, ctx, addr, i):
        b = ctx.read(addr, self.size)
        p = u64(b, self.o_p)
        n = u64(b, self.o_n)
        if 0 <= i < n:
            return (CHAR_CODEC[0], p + i, n)
        return (None, None, n)


CHAR_CODEC = [None]


class TextCodec(Codec):
    """Fallback: GDB's own printer (libstdc++ pretty printers for map, set,
    unordered_map, deque, ...).  Compared as text every step."""
    indirect = True

    def __init__(self, t):
        self.t = t
        self.size = t.sizeof
        self.tname = pretty_type(t)

    def text(self, ctx, addr):
        s = ctx.text.get((addr, self.tname))
        if s is None:
            try:
                v = gdb.Value(addr).cast(self.t.pointer()).dereference()
                s = v.format_string(max_elements=64, max_depth=3, repeat_threshold=10)
            except Exception as e:  # noqa: BLE001
                s = "<unavailable: %s>" % e
            if len(s) > MAX_TEXT:
                s = s[:MAX_TEXT] + " ...(truncated)"
            ctx.text[(addr, self.tname)] = s
        return s

    def sig(self, ctx, addr):
        return self.text(ctx, addr).encode("utf-8", "replace")

    def full(self, ctx, addr):
        return {"t": "x", "v": self.text(ctx, addr), "ty": self.tname}


_CODECS = {}


def codec_for(t, depth=0, shallow=False):
    t = t.strip_typedefs().unqualified()
    key = (str(t), min(depth, 3), shallow)
    c = _CODECS.get(key)
    if c is not None:
        return c
    c = _make_codec(t, depth, shallow)
    _CODECS[key] = c
    return c


def _make_codec(t, depth, shallow):
    code = t.code
    name = str(t)
    try:
        if code == gdb.TYPE_CODE_BOOL:
            return ScalarCodec(t, "bool")
        if code == gdb.TYPE_CODE_CHAR:
            return ScalarCodec(t, "char")
        if code == gdb.TYPE_CODE_INT:
            kind = "char" if name in ("char", "wchar_t", "char8_t", "char16_t", "char32_t") else "int"
            return ScalarCodec(t, kind)
        if code == gdb.TYPE_CODE_ENUM:
            return ScalarCodec(t, "enum")
        if code == gdb.TYPE_CODE_FLT:
            if t.sizeof in (4, 8):
                return ScalarCodec(t, "float")
            return TextCodec(t)
        if code == gdb.TYPE_CODE_PTR:
            return PtrCodec(t, depth)
        if code == gdb.TYPE_CODE_ARRAY:
            return ArrayCodec(t, depth)
        if code in (gdb.TYPE_CODE_STRUCT, gdb.TYPE_CODE_UNION):
            if code == gdb.TYPE_CODE_UNION:
                return TextCodec(t)
            if name.startswith("std::vector<") and not name.startswith("std::vector<bool"):
                return VectorCodec(t, depth)
            if re.match(r"std::(__cxx11::)?basic_string<char,", name):
                return StringCodec(t)
            if name.startswith("std::array<"):
                off = find_field_offset(t, "_M_elems")
                et = t.template_argument(0).strip_typedefs()
                n = int(t.template_argument(1))
                return ArrayCodec(t, depth, elem_type=et, count=n, inner_off=off or 0)
            if name.startswith("std::") and not name.startswith("std::pair<"):
                return TextCodec(t)
            if depth > 3:
                return TextCodec(t)
            return StructCodec(t, depth, shallow)
    except Exception:  # noqa: BLE001 - unknown layout: fall back to GDB's printer
        return TextCodec(t)
    return TextCodec(t)


def encode_value(v):
    """Encode a gdb.Value that may not live in memory (return values)."""
    if v is None:
        return {"t": "void"}
    try:
        t = v.type.strip_typedefs()
        code = t.code
        if code in (gdb.TYPE_CODE_REF, gdb.TYPE_CODE_RVALUE_REF):
            v = v.referenced_value()
            t = v.type.strip_typedefs()
            code = t.code
        if code == gdb.TYPE_CODE_BOOL:
            return {"t": "b", "v": bool(v), "b": 8, "s": 0, "ty": "bool"}
        c = codec_for(t)
        if isinstance(c, ScalarCodec):
            if c.kind == "float":
                f = float(v)
                raw = "nan" if f != f else ("inf" if f == float("inf") else ("-inf" if f == float("-inf") else f))
                return c.wrap(raw)
            return c.wrap(int_json(int(v)))
        if code == gdb.TYPE_CODE_PTR:
            return {"t": "p", "v": "0x%x" % int(v), "ty": pretty_type(t)}
        if v.address is not None:
            ctx = ReadCtx(gdb.selected_inferior(), 0, 0)
            return c.full(ctx, int(v.address))
        s = v.format_string(max_elements=64, max_depth=3)
        return {"t": "x", "v": s[:MAX_TEXT], "ty": pretty_type(t)}
    except Exception as e:  # noqa: BLE001
        return {"t": "na", "v": "return value unavailable: %s" % e}


# --------------------------------------------------------------------------
# Source-line subscript accesses:  memo[available], grid[i][j], this->dp[x]
# --------------------------------------------------------------------------

_KEYWORDS = set("""alignas alignof and and_eq asm auto bitand bitor bool break case catch char
char8_t char16_t char32_t class compl concept const consteval constexpr constinit const_cast
continue co_await co_return co_yield decltype default delete do double dynamic_cast else enum
explicit export extern false float for friend goto if inline int long mutable namespace new
noexcept not not_eq nullptr operator or or_eq private protected public register
reinterpret_cast requires return short signed sizeof static static_assert static_cast struct
switch template this thread_local throw true try typedef typeid typename union unsigned using
virtual void volatile wchar_t while xor xor_eq""".split())

_SAFE_INDEX = re.compile(r"^[\w\s+\-*/%&|^~<>!=().:\[\]]*$")


def _strip_line(text):
    text = re.sub(r"//.*$", "", text)
    text = re.sub(r'"(?:\\.|[^"\\])*"', '""', text)
    text = re.sub(r"'(?:\\.|[^'\\])*'", "' '", text)
    return text


def _match_bracket(s, i):
    depth = 0
    for j in range(i, len(s)):
        if s[j] == "[":
            depth += 1
        elif s[j] == "]":
            depth -= 1
            if depth == 0:
                return j
    return -1


def _safe_expr(e):
    if not e.strip() or not _SAFE_INDEX.match(e):
        return False
    if "++" in e or "--" in e:
        return False
    if re.search(r"(?<![=!<>])=(?!=)", e):
        return False
    if re.search(r"\b[A-Za-z_]\w*\s*\(", e) and not re.search(r"\b(?:%s)\s*\(" % "|".join(["sizeof"]), e):
        return False
    return True


def find_subscripts(text):
    """[(full_text, base_expr, [index_exprs])] for side-effect-free subscripts."""
    s = _strip_line(text)
    out = []
    for m in re.finditer(r"((?:\bthis\s*->\s*)?(?:[A-Za-z_]\w*)(?:\s*(?:\.|->)\s*[A-Za-z_]\w*)*)\s*\[", s):
        base = m.group(1)
        first = re.match(r"(?:this\s*->\s*)?([A-Za-z_]\w*)", base).group(1)
        if first in _KEYWORDS and not base.startswith("this"):
            continue
        if m.start() > 0 and s[:m.start()].rstrip().endswith(("operator", "delete", "new")):
            continue
        i = m.end() - 1
        idxs = []
        while i < len(s) and s[i] == "[":
            j = _match_bracket(s, i)
            if j < 0:
                break
            idxs.append(s[i + 1:j].strip())
            i = j + 1
            while i < len(s) and s[i] == " ":
                i += 1
        if not idxs or not all(_safe_expr(x) for x in idxs) or not _safe_expr(base.replace("->", ".")):
            continue
        full = s[m.start():i].strip()
        if not any(o[0] == full for o in out):
            out.append((full, re.sub(r"\s+", "", base), idxs))
    return out


# --------------------------------------------------------------------------
# Tracer state
# --------------------------------------------------------------------------

class Fn(object):
    def __init__(self, fid, name, line, start, end, symbol):
        self.id = fid
        self.name = name
        self.short = short_function_name(name)
        self.line = line
        self.start = start
        self.end = end
        self.symbol = symbol
        self.vars = []          # [{n,l,arg,ty,ref,sym,member,...}]
        self.var_index = {}
        self.this_members = []  # [(name, offset, gdb.Type)]
        self.file = None
        self.ret_kind, self.ret_type = classify_return(symbol)


class Inv(object):
    __slots__ = ("id", "fn", "rbp", "cfa", "sp", "parent", "depth", "call_step", "ret_step",
                 "ret", "status", "last_line", "fresh", "bindings", "retbp", "scope_key",
                 "active", "special", "special_added", "local_refs", "caller", "call_line", "this_addr",
                 "ret_addr")

    def __init__(self, iid, fn, rbp, cfa, sp, parent, depth):
        self.id = iid
        self.fn = fn
        self.rbp = rbp
        self.cfa = cfa
        self.sp = sp
        self.parent = parent
        self.depth = depth
        self.call_step = None
        self.ret_step = None
        self.ret = None
        self.status = "live"
        self.last_line = None
        self.fresh = True
        self.bindings = {}    # var index -> Binding
        self.retbp = None
        self.scope_key = None
        self.active = []      # cells of bindings in the current scope
        self.special = []     # active cells that can change while this frame waits
        self.special_added = None
        self.ret_addr = None
        self.local_refs = []  # bindings of local references (may re-bind)
        self.caller = None
        self.call_line = None
        self.this_addr = None


class Binding(object):
    __slots__ = ("id", "inv", "var", "cell", "na", "since")

    def __init__(self, bid, inv, var, cell, na, since):
        self.id = bid
        self.inv = inv
        self.var = var
        self.cell = cell
        self.na = na
        self.since = since


class Cell(object):
    __slots__ = ("id", "addr", "codec", "ty", "last_sig", "stack", "owner")

    def __init__(self, cid, addr, codec, ty, stack, owner):
        self.id = cid
        self.addr = addr
        self.codec = codec
        self.ty = ty
        self.last_sig = None
        self.stack = stack
        self.owner = owner


class RetBP(gdb.FinishBreakpoint):
    def __init__(self, frame, inv, tracer):
        super(RetBP, self).__init__(frame, internal=True)
        self.silent = True
        self.inv = inv
        self.tracer = tracer

    def stop(self):
        try:
            rv = encode_value(self.return_value)
        except Exception as e:  # noqa: BLE001
            rv = {"t": "na", "v": "return value unavailable: %s" % e}
        self.tracer.pending_returns.append((self.inv, rv))
        return True

    def out_of_scope(self):
        self.tracer.out_of_scope.append(self.inv)


class RetSiteBP(gdb.Breakpoint):
    """Permanent breakpoint at a return address (the instruction after a call
    of a traced function).  A hit is a return of the shadow-stack top exactly
    when the stack pointer equals that invocation's CFA."""

    def __init__(self, pc, tracer):
        super(RetSiteBP, self).__init__("*0x%x" % pc, type=gdb.BP_BREAKPOINT, internal=True)
        self.silent = True
        self.pc = pc
        self.tracer = tracer

    def stop(self):
        return self.tracer.on_ret_site(self)


class FakeCtx(ReadCtx):
    """ReadCtx that serves one synthetic address from register bytes."""
    ADDR = 0x10

    def __init__(self, inf, raw):
        ReadCtx.__init__(self, inf, 0, 0)
        self.raw = raw

    def read(self, addr, n):
        if addr == self.ADDR:
            return self.raw[:n]
        return ReadCtx.read(self, addr, n)


def classify_return(sym):
    """How the x86-64 SysV ABI returns this function's value:
    void | int (rax) | float (xmm0) | ref / mem (rax holds an address) |
    slow (small class types: let GDB's FinishBreakpoint decode them)."""
    try:
        rt = sym.type.strip_typedefs().target()
    except Exception:  # noqa: BLE001
        return "slow", None
    if rt is None:
        return "void", None
    rt = rt.strip_typedefs()
    code = rt.code
    if code == gdb.TYPE_CODE_VOID:
        return "void", None
    if code in (gdb.TYPE_CODE_INT, gdb.TYPE_CODE_BOOL, gdb.TYPE_CODE_CHAR, gdb.TYPE_CODE_ENUM) and rt.sizeof <= 8:
        return "int", rt
    if code == gdb.TYPE_CODE_PTR:
        return "int", rt
    if code == gdb.TYPE_CODE_FLT and rt.sizeof in (4, 8):
        return "float", rt
    if code in (gdb.TYPE_CODE_REF, gdb.TYPE_CODE_RVALUE_REF):
        return "ref", rt
    if code in (gdb.TYPE_CODE_STRUCT, gdb.TYPE_CODE_UNION) and rt.sizeof > 16:
        return "mem", rt
    return "slow", rt


class LineBP(gdb.Breakpoint):
    def __init__(self, pc, fn, line, is_entry, tracer):
        super(LineBP, self).__init__("*0x%x" % pc, type=gdb.BP_BREAKPOINT, internal=True)
        self.silent = True
        self.pc = pc
        self.fn = fn
        self.line = line
        self.is_entry = is_entry
        self.tracer = tracer

    def stop(self):
        return self.tracer.on_line_bp(self)


class Tracer(object):
    def __init__(self):
        self.inf = None
        self.fns = []
        self.fn_starts = []
        self.bp_at = {}
        self.line_bps = []
        self.shadow = []
        self.invs = []
        self.bindings = []
        self.cells = {}
        self.cell_list = []
        self.scopes = []
        self.scope_ids = {}
        self.scope_cache = {}
        self.steps = []
        self.pending_returns = []
        self.out_of_scope = []
        self.halting = None
        self.phase = "trace"
        self.timed_out = False
        self.end = {}
        self.late_returns = []
        self.source_lines = {}
        self.sub_cache = {}
        self.stack_range = (0, 0)
        self.globals_ = []
        self.global_vars = []
        self.global_bindings = []
        self.last_progress = 0
        self.exit_code = None
        self.signal = None
        self.files = {}
        self.stats = {"lineStops": 0, "skippedSameLine": 0, "topStops": 0}
        self._wait_block = None
        self._wait_bounds = None
        self._wait_special = {}
        self.ret_sites = {}
        self.in_callback = False
        self.need_window = False

    # ---------------- setup ----------------

    def setup(self):
        for c in ("set pagination off", "set confirm off", "set width 0", "set height 0",
                  "set print pretty off", "set breakpoint pending off", "set print elements 200",
                  "set auto-load safe-path /", "set breakpoint always-inserted on"):
            try:
                gx(c)
            except gdb.error:
                pass
        gdb.events.stop.connect(self._on_stop_event)
        gdb.events.exited.connect(self._on_exit_event)
        self._last_signal = None
        gx("starti < %s > %s 2> %s" % (CFG["stdinPath"], CFG["stdoutPath"], CFG["stderrPath"]))
        self.inf = gdb.selected_inferior()
        self._read_stack_range()
        try:
            gx("catch catch")   # a frame unwound by an exception is reconciled at the handler
        except gdb.error:
            pass
        n_entries = 0
        for path in TRACE_FILES:
            st = None
            try:
                sals = gdb.decode_line("%s:1" % path)[1] or []
                for s in sals:
                    if s.symtab is not None:
                        st = s.symtab
                        break
            except gdb.error:
                st = None
            if st is None:
                self.files[os.path.basename(path)] = {"path": path, "functions": 0}
                continue
            try:
                with open(path, "r", encoding="utf-8", errors="replace") as fh:
                    self.source_lines[os.path.basename(path)] = fh.read().split("\n")
            except OSError:
                pass
            n = self._index_symtab(st, path)
            n_entries += n
            self.files[os.path.basename(path)] = {"path": path, "breakpoints": n}
            self._collect_globals(st, path)
        self.fns.sort(key=lambda f: f.start)
        self.fn_starts = [f.start for f in self.fns]
        CHAR_CODEC[0] = codec_for(gdb.lookup_type("char"))
        for sym in self.globals_:
            try:
                v = sym.value()
                if v.address is None:
                    continue
                vi = len(self.global_vars)
                self.global_vars.append({"n": sym.name, "l": sym.line, "k": "global", "ty": pretty_type(sym.type),
                                         "ref": False, "file": os.path.basename(sym.symtab.filename)})
                cell = self.cell_for(int(v.address), v.type, None)
                b = Binding(len(self.bindings), None, vi, cell, None, 0)
                self.bindings.append(b)
                self.global_bindings.append(b)
            except Exception:  # noqa: BLE001
                continue
        progress(phase="trace", steps=0, functions=len(self.fns), breakpoints=len(self.line_bps))
        if not self.fns:
            self.end["note"] = "No functions with line information were found in the traced file(s)."

    def _read_stack_range(self):
        try:
            with open("/proc/%d/maps" % self.inf.pid) as fh:
                for ln in fh:
                    if ln.rstrip().endswith("[stack]"):
                        a, b = ln.split()[0].split("-")
                        self.stack_range = (int(a, 16) - (64 << 20), int(b, 16))
        except OSError:
            self.stack_range = (0x7ff000000000, 0x800000000000)

    def _index_symtab(self, st, path):
        base = os.path.basename(path)
        ents = [e for e in st.linetable() if e.line > 0]
        ents.sort(key=lambda e: e.pc)
        by_pc = {}
        for e in ents:
            by_pc[e.pc] = e.line  # the last row at an address wins (as in GDB)
        groups = {}
        for pc in sorted(by_pc):
            b = gdb.block_for_pc(pc)
            fb = b
            while fb is not None and fb.function is None:
                fb = fb.superblock
            if fb is None or fb.function is None:
                continue
            key = fb.start
            g = groups.get(key)
            if g is None:
                fn = Fn(len(self.fns), fb.function.name, fb.function.line, fb.start, fb.end, fb.function)
                fn.file = base
                self.fns.append(fn)
                g = groups[key] = (fn, [], set())
            g[1].append((pc, by_pc[pc]))
            # collect lexical blocks for the variable list
            bb = b
            while bb is not None:
                bkey = (bb.start, bb.end)
                if bkey in g[2]:
                    break
                g[2].add(bkey)
                self._collect_block_vars(g[0], bb)
                if bb.function is not None:
                    break
                bb = bb.superblock
        count = 0
        for (fn, rows, _) in groups.values():
            rows.sort()
            self._finish_vars(fn)
            prev_line = None
            post = None
            for k, (pc, line) in enumerate(rows):
                if pc == fn.start:
                    prev_line = line
                    continue
                if post is None:
                    post = pc
                    self._add_bp(pc, fn, line, True)
                    count += 1
                elif line != prev_line:
                    self._add_bp(pc, fn, line, False)
                    count += 1
                prev_line = line
        return count

    def _add_bp(self, pc, fn, line, is_entry):
        if pc in self.bp_at:
            return
        bp = LineBP(pc, fn, line, is_entry, self)
        self.bp_at[pc] = bp
        self.line_bps.append(bp)

    def _collect_block_vars(self, fn, block):
        for sym in block:
            if not (sym.is_argument or sym.is_variable):
                continue
            if sym.addr_class == gdb.SYMBOL_LOC_STATIC and not sym.is_argument:
                kind = "static"
            else:
                kind = "arg" if sym.is_argument else "local"
            key = (sym.name, sym.line, kind)
            if key in fn.var_index:
                continue
            st = sym.type
            ref = st.code in (gdb.TYPE_CODE_REF, gdb.TYPE_CODE_RVALUE_REF)
            fn.var_index[key] = len(fn.vars)
            fn.vars.append({"n": sym.name, "l": sym.line, "k": kind, "ty": pretty_type(st),
                            "ref": ref, "sym": sym, "blk": (block.start, block.end)})

    def _finish_vars(self, fn):
        # order: arguments (as declared), then locals by declaration line
        args = [v for v in fn.vars if v["k"] == "arg"]
        rest = sorted([v for v in fn.vars if v["k"] != "arg"], key=lambda v: (v["l"], v["n"]))
        fn.vars = args + rest
        fn.var_index = {(v["n"], v["l"], v["k"]): i for i, v in enumerate(fn.vars)}
        # members of *this, shown as shared cells
        for v in args:
            if v["n"] == "this":
                try:
                    ct = v["sym"].type.strip_typedefs().target().strip_typedefs()
                    for f in ct.fields():
                        if not hasattr(f, "bitpos") or f.is_base_class or f.artificial or f.bitsize:
                            continue
                        if (f.name or "").startswith("_vptr"):
                            continue
                        fn.this_members.append((f.name, f.bitpos // 8, f.type))
                except Exception:  # noqa: BLE001
                    pass
        for (name, off, ft) in fn.this_members:
            fn.var_index[("this->" + name, 0, "member")] = len(fn.vars)
            fn.vars.append({"n": "this->" + name, "l": 0, "k": "member", "ty": pretty_type(ft),
                            "ref": False, "sym": None, "off": off, "ftype": ft})

    def _collect_globals(self, st, path):
        seen = set()
        for blk in (st.global_block(), st.static_block()):
            for sym in blk:
                try:
                    if not sym.is_variable or sym.symtab is None:
                        continue
                    if os.path.realpath(sym.symtab.fullname()) != os.path.realpath(path):
                        continue
                    if sym.name in seen:
                        continue
                    seen.add(sym.name)
                    self.globals_.append(sym)
                except Exception:  # noqa: BLE001
                    continue

    # ---------------- events ----------------

    def _on_stop_event(self, ev):
        if isinstance(ev, gdb.SignalEvent):
            self._last_signal = ev.stop_signal

    def _on_exit_event(self, ev):
        if hasattr(ev, "exit_code"):
            self.exit_code = ev.exit_code

    # ---------------- helpers ----------------

    def fn_of_pc(self, pc):
        i = bisect.bisect_right(self.fn_starts, pc) - 1
        if i >= 0:
            f = self.fns[i]
            if f.start <= pc < f.end:
                return f
        return None

    def top(self):
        return self.shadow[-1] if self.shadow else None

    def line_text(self, fn, line):
        lines = self.source_lines.get(fn.file)
        if lines and 0 < line <= len(lines):
            return lines[line - 1]
        return ""

    def maybe_progress(self):
        now = time.time()
        if now - self.last_progress > 0.3:
            self.last_progress = now
            progress(phase=self.phase, steps=len(self.steps), depth=len(self.shadow),
                     invocations=len(self.invs))

    def check_limits(self):
        if self.halting:
            return
        if len(self.steps) >= MAX_STEPS:
            self.halting = "step-limit"
        elif time.time() - T0 > MAX_SECONDS:
            self.halting = "time-limit"
        elif len(self.shadow) > MAX_DEPTH:
            self.halting = "depth-limit"

    # ---------------- fast path: a line breakpoint was hit ----------------

    def on_line_bp(self, bp):
        try:
            if self.phase != "trace" or self.halting:
                return True
            self.stats["lineStops"] += 1
            if self.pending_returns or self.need_window:
                return True
            top = self.top()
            frame = None
            if bp.is_entry or self.stats["lineStops"] % 64 == 0:
                # entries need the frame identity; other stops are re-verified periodically
                frame = gdb.newest_frame()
                rbp = int(frame.read_register("rbp"))
                if bp.is_entry and (top is None or top.rbp != rbp or top.fn is not bp.fn):
                    return self.fast_call(bp, frame, rbp)
                if top is None or top.rbp != rbp:
                    return True
            if top is None or top.fn is not bp.fn or top.fresh:
                return True  # unwind / unexpected frame: handled at top level
            if bp.line == top.last_line:
                self.stats["skippedSameLine"] += 1
                return False
            self.record("line", top, bp.line, frame, pc=bp.pc)
            self.check_limits()
            self.maybe_progress()
            return bool(self.halting)
        except Exception as e:  # noqa: BLE001
            self.end.setdefault("internalErrors", []).append("line stop: %r" % (e,))
            return True

    def fast_call(self, bp, frame, rbp):
        """A traced function was entered: push it inside the breakpoint callback
        when its return can be caught by an existing return-site breakpoint."""
        fn = bp.fn
        if fn.ret_kind == "slow":
            return True
        try:
            older = frame.older()
            cfa = int(older.read_register("rsp"))
            ret = u64(bytes(self.inf.read_memory(cfa - 8, 8)))
        except gdb.error:
            return True
        if ret not in self.ret_sites or not self.quick_push(fn, rbp, frame, dry_run=True):
            return True
        inv = self.push(fn, rbp, frame)
        self.record("call", inv, bp.line, frame, pc=bp.pc)
        inv.call_step = len(self.steps) - 1
        self.check_limits()
        self.maybe_progress()
        return bool(self.halting) or self.need_window

    def fast_return(self, fn, frame):
        k = fn.ret_kind
        if k == "void":
            return {"t": "void"}
        rt = fn.ret_type
        try:
            if k == "int":
                raw = (int(frame.read_register("rax")) & 0xFFFFFFFFFFFFFFFF).to_bytes(8, "little")[:rt.sizeof]
                c = codec_for(rt)
                if isinstance(c, ScalarCodec):
                    return c.wrap(c.raw(raw))
                return c.full(FakeCtx(self.inf, raw), FakeCtx.ADDR)
            if k == "float":
                x = frame.read_register("xmm0")
                f = float(x["v2_double"][0]) if rt.sizeof == 8 else float(x["v4_float"][0])
                if f != f:
                    raw = "nan"
                elif f in (float("inf"), float("-inf")):
                    raw = "inf" if f > 0 else "-inf"
                else:
                    raw = f
                return codec_for(rt).wrap(raw)
            addr = int(frame.read_register("rax")) & 0xFFFFFFFFFFFFFFFF
            target = rt.target() if k == "ref" else rt
            return codec_for(target).full(ReadCtx(self.inf, 0, 0), addr)
        except Exception as e:  # noqa: BLE001
            return {"t": "na", "v": "return value unavailable: %s" % e}

    def on_ret_site(self, bp):
        try:
            frame = gdb.newest_frame()
            rsp = int(frame.read_register("rsp"))
            if self.phase == "untraced":
                for inv in self.shadow:
                    late = (inv.parent is None and inv.ret is None and inv.fn.ret_kind != "slow"
                            and inv.cfa == rsp and inv.ret_addr == bp.pc)
                    if late:
                        rv = self.fast_return(inv.fn, frame)
                        inv.ret = rv
                        inv.status = "returned (after trace stopped)"
                        self.late_returns.append({"inv": inv.id, "v": rv})
                return False
            if self.phase != "trace" or self.halting:
                return False
            top = self.top()
            if top is None or top.fn.ret_kind == "slow" or top.cfa != rsp or top.ret_addr != bp.pc:
                return False
            rv = self.fast_return(top.fn, frame)
            self.in_callback = True
            try:
                self.do_return(top, rv)
            finally:
                self.in_callback = False
            self.check_limits()
            self.maybe_progress()
            return bool(self.halting) or self.need_window
        except Exception as e:  # noqa: BLE001
            self.end.setdefault("internalErrors", []).append("return stop: %r" % (e,))
            return True

    # ---------------- top level ----------------

    def on_top_stop(self):
        self.stats["topStops"] += 1
        sig = self._last_signal
        self._last_signal = None
        if sig is not None and sig not in ("SIGTRAP", "0"):
            if sig == "SIGINT" and self.timed_out:
                if self.phase == "trace":
                    self.halting = self.halting or "time-limit"
                else:
                    self.end["programTimedOut"] = True
                    self.finished = True
                    return
            else:
                self.on_signal(sig)
                return
        if self.phase == "untraced":
            for (inv, rv) in self.pending_returns:
                self.late_returns.append({"inv": inv.id, "v": rv})
                inv.status = "returned (after trace stopped)"
                inv.ret = rv
            self.pending_returns = []
            return
        while self.pending_returns:
            inv, rv = self.pending_returns.pop(0)
            self.do_return(inv, rv)
        if self.need_window:
            self.need_window = False
            self.ensure_window()
        if self.halting:
            self.truncate(self.halting)
            return
        frame = gdb.newest_frame()
        pc = int(frame.pc())
        fn = self.fn_of_pc(pc)
        if fn is None:
            self.reconcile(frame)
            return
        rbp = int(frame.read_register("rbp"))
        top = self.top()
        bp = self.bp_at.get(pc)
        if top is None or top.rbp != rbp or top.fn is not fn:
            if not (bp is not None and bp.is_entry and self.quick_push(fn, rbp, frame)):
                self.reconcile(frame)
            top = self.top()
        if bp is not None and top is not None and top.rbp == rbp and top.fn is fn:
            if top.fresh:
                self.record("call", top, bp.line, frame, pc=pc)
                top.call_step = len(self.steps) - 1
            elif bp.line != top.last_line:
                self.record("line", top, bp.line, frame, pc=pc)
        self.check_limits()
        self.maybe_progress()
        if self.halting:
            self.truncate(self.halting)

    def user_frames(self, frame):
        """Traced frames, oldest first: [(fn, rbp, frame)]."""
        out = []
        f = frame
        n = 0
        while f is not None and n < MAX_DEPTH + 64:
            try:
                pc = int(f.pc())
                fn = self.fn_of_pc(pc if f.level() == 0 else pc - 1)
                if fn is not None:
                    out.append((fn, int(f.read_register("rbp")), f))
                f = f.older()
            except gdb.error:
                break
            n += 1
        out.reverse()
        return out

    def quick_push(self, fn, rbp, frame, dry_run=False):
        """New invocation whose nearest traced ancestor is the shadow top:
        push it without unwinding the whole stack (keeps deep recursion O(1))."""
        top = self.top()
        f = frame.older()
        n = 0
        while f is not None and n < 256:
            try:
                ffn = self.fn_of_pc(int(f.pc()) - 1)
                if ffn is not None:
                    if top is not None and ffn is top.fn and int(f.read_register("rbp")) == top.rbp:
                        if not dry_run:
                            self.push(fn, rbp, frame)
                        return True
                    return False
                f = f.older()
            except gdb.error:
                return False
            n += 1
        if top is None and f is None:
            if not dry_run:
                self.push(fn, rbp, frame)
            return True
        return False

    def reconcile(self, frame):
        actual = self.user_frames(frame)
        k = 0
        while (k < len(actual) and k < len(self.shadow)
               and actual[k][0] is self.shadow[k].fn and actual[k][1] == self.shadow[k].rbp):
            k += 1
        while len(self.shadow) > k:
            inv = self.shadow.pop()
            inv.status = "unwound"
            inv.ret_step = len(self.steps)
            self.steps.append({"k": "unwind", "i": self.shadow[-1].id if self.shadow else None,
                               "from": inv.id, "d": len(self.shadow),
                               "ln": self.shadow[-1].last_line if self.shadow else None})
            if inv.retbp is not None and inv.retbp.is_valid():
                try:
                    inv.retbp.delete()
                except Exception:  # noqa: BLE001
                    pass
        for (fn, rbp, f) in actual[k:]:
            self.push(fn, rbp, f)
        self.ensure_window()
        self._wait_rebuild()

    # GDB re-checks every FinishBreakpoint against the whole frame chain at each
    # stop, so only the newest RET_WINDOW traced frames carry one.  A frame gets
    # its breakpoint back as soon as it re-enters the window (when a callee
    # returns), long before it can return itself, so every return is captured.
    def _frame_of(self, inv):
        f = gdb.newest_frame()
        n = 0
        while f is not None and n < MAX_DEPTH + 4096:
            try:
                pc = int(f.pc())
                if int(f.read_register("rbp")) == inv.rbp and self.fn_of_pc(pc if f.level() == 0 else pc - 1) is inv.fn:
                    return f
                f = f.older()
            except gdb.error:
                return None
            n += 1
        return None

    def _make_retbp(self, inv, frame=None):
        if inv.retbp is not None and inv.retbp.is_valid():
            return
        inv.retbp = None
        frame = frame or self._frame_of(inv)
        if frame is None:
            self.end.setdefault("internalErrors", []).append("no frame for #%d's return breakpoint" % inv.id)
            return
        try:
            inv.retbp = RetBP(frame, inv, self)
        except Exception as e:  # noqa: BLE001
            self.end.setdefault("internalErrors", []).append("finish breakpoint: %s" % e)

    def _drop_retbp(self, inv):
        if inv.retbp is not None:
            try:
                if inv.retbp.is_valid():
                    inv.retbp.delete()
            except Exception:  # noqa: BLE001
                pass
            inv.retbp = None

    def _wait_add(self, inv):
        inv.special_added = list(inv.special)
        for c in inv.special_added:
            ent = self._wait_special.get(c.id)
            if ent is None:
                self._wait_special[c.id] = [c, 1]
            else:
                ent[1] += 1

    def _wait_remove(self, inv):
        for c in inv.special_added or []:
            ent = self._wait_special.get(c.id)
            if ent is not None:
                ent[1] -= 1
                if ent[1] <= 0:
                    del self._wait_special[c.id]
        inv.special_added = None

    def _wait_rebuild(self):
        self._wait_special = {}
        for inv in self.shadow[:-1]:
            self._wait_add(inv)
        if self.shadow:
            self.shadow[-1].special_added = None

    def ensure_window(self):
        n = len(self.shadow)
        for k, inv in enumerate(self.shadow):
            if inv.fn.ret_kind != "slow":
                continue
            if k < n - RET_WINDOW and inv.parent is not None:
                self._drop_retbp(inv)
            else:
                self._make_retbp(inv)

    def push(self, fn, rbp, frame):
        parent = self.top()
        try:
            older = frame.older()
            cfa = int(older.read_register("rsp")) if older is not None else rbp + 16
        except gdb.error:
            older = None
            cfa = rbp + 16
        try:
            sp = int(frame.read_register("rsp"))
        except gdb.error:
            sp = rbp
        inv = Inv(len(self.invs) + 1, fn, rbp, cfa, sp, parent, len(self.shadow))
        if parent is not None:
            self._wait_add(parent)   # the caller starts waiting
        try:
            if older is not None:
                inv.caller = older.name()
                cal = gdb.find_pc_line(int(older.pc()) - 1)
                inv.call_line = cal.line if cal and cal.symtab else None
        except Exception:  # noqa: BLE001
            pass
        try:
            inv.ret_addr = u64(bytes(self.inf.read_memory(cfa - 8, 8)))
        except gdb.error:
            inv.ret_addr = None
        self.invs.append(inv)
        self.shadow.append(inv)
        if fn.ret_kind == "slow" or inv.ret_addr is None:
            if self.in_callback:
                self.need_window = True
            else:
                self._make_retbp(inv, frame)
        elif inv.ret_addr not in self.ret_sites:
            # only reached at top level: fast_call() requires an existing site
            self.ret_sites[inv.ret_addr] = RetSiteBP(inv.ret_addr, self)
        n = len(self.shadow)
        if n > RET_WINDOW and self.shadow[n - RET_WINDOW - 1].retbp is not None:
            if self.in_callback:
                self.need_window = True
            else:
                self._drop_retbp(self.shadow[n - RET_WINDOW - 1])
        return inv

    def do_return(self, inv, rv):
        if inv not in self.shadow:
            return
        irregular = False
        while self.shadow and self.shadow[-1] is not inv:
            gone = self.shadow.pop()
            gone.status = "unwound"
            gone.ret_step = len(self.steps)
            irregular = True
        self.shadow.pop()
        inv.retbp = None
        if irregular:
            self._wait_rebuild()
        elif self.shadow:
            self._wait_remove(self.shadow[-1])   # the caller resumes
        inv.status = "returned"
        inv.ret = rv
        n = len(self.shadow)
        if n >= RET_WINDOW:
            cand = self.shadow[n - RET_WINDOW]
            if cand.fn.ret_kind == "slow" and (cand.retbp is None or not cand.retbp.is_valid()):
                if self.in_callback:
                    self.need_window = True
                else:
                    self._make_retbp(cand)
        parent = self.top()
        frame = gdb.newest_frame()
        line = None
        resumed_in_parent = False
        if parent is not None:
            try:
                pc = int(frame.pc())
                rbp = int(frame.read_register("rbp"))
                if self.fn_of_pc(pc) is parent.fn and rbp == parent.rbp:
                    sal = gdb.find_pc_line(pc - 1)
                    line = sal.line if sal and sal.symtab else parent.last_line
                    resumed_in_parent = True
                else:
                    line = parent.last_line
            except gdb.error:
                line = parent.last_line
        extra = {"from": inv.id, "v": rv}
        if parent is not None and not resumed_in_parent:
            extra["via"] = frame.name() or "?"
        self.record("ret", parent, line, frame, extra=extra)
        inv.ret_step = len(self.steps) - 1
        if parent is not None and resumed_in_parent:
            parent.last_line = line

    def on_signal(self, sig):
        frame = gdb.newest_frame()
        top = self.top()
        line = None
        try:
            sal = frame.find_sal()
            line = sal.line if sal and sal.symtab else None
            where = "%s:%s" % (os.path.basename(sal.symtab.filename), sal.line) if sal and sal.symtab else frame.name()
        except Exception:  # noqa: BLE001
            where = "?"
        self.signal = sig
        if self.phase == "trace":
            self.record("sig", top, line if top and self.fn_of_pc(int(frame.pc())) is top.fn else (top.last_line if top else None),
                        frame, extra={"sig": sig, "where": where})
        self.end["signal"] = sig
        self.end["signalWhere"] = where
        try:
            gx("kill")
        except gdb.error:
            pass
        self.finished = True

    # ---------------- recording ----------------

    def record(self, kind, inv, line, frame, extra=None, pc=None):
        st = {"k": kind, "i": inv.id if inv is not None else None, "ln": line, "d": len(self.shadow)}
        rb = None
        if inv is not None and kind in ("call", "line"):
            if pc is None:
                frame = frame or gdb.newest_frame()
                pc = int(frame.pc())
            sc, rb = self.update_scope(inv, frame, pc, line)
            st["sc"] = sc
            acc = self.accesses(inv, frame, line)
            if acc:
                st["acc"] = acc
            inv.fresh = False
            inv.last_line = line
        if rb:
            st["rb"] = rb
        ch = self.collect_changes()
        if ch:
            st["ch"] = ch
        if extra:
            st.update(extra)
        self.steps.append(st)
        return st

    def update_scope(self, inv, frame, pc, line):
        fn = inv.fn
        key = (pc, line)
        ent = self.scope_cache.get(key)
        if ent is None:
            block = gdb.block_for_pc(pc)
            active = []
            names = set()
            b = block
            while b is not None:
                for sym in b:
                    if not (sym.is_argument or sym.is_variable):
                        continue
                    if sym.name in names:
                        continue  # shadowed by an inner declaration
                    names.add(sym.name)
                    kind = "static" if (sym.addr_class == gdb.SYMBOL_LOC_STATIC and not sym.is_argument) \
                        else ("arg" if sym.is_argument else "local")
                    vi = fn.var_index.get((sym.name, sym.line, kind))
                    if vi is None:
                        continue
                    status = 0
                    if kind == "local" and sym.line >= line:
                        status = 1  # declared on this line or later: not initialized yet
                    active.append([vi, status])
                if b.function is not None:
                    break
                b = b.superblock
            for (name, off, ft) in fn.this_members:
                vi = fn.var_index.get(("this->" + name, 0, "member"))
                if vi is not None:
                    active.append([vi, 0])
            active.sort()
            sig = json.dumps(active)
            sid = self.scope_ids.get(sig)
            if sid is None:
                sid = len(self.scopes)
                self.scope_ids[sig] = sid
                self.scopes.append(active)
            ent = (sid, active)
            self.scope_cache[key] = ent
        sid, active = ent
        rebinds = []
        if inv.scope_key != sid:
            inv.scope_key = sid
            cells = []
            for (vi, status) in active:
                b = inv.bindings.get(vi)
                if b is None:
                    b = self.make_binding(inv, vi, frame, status)
                    if b.cell is not None:
                        rebinds.append([b.id, b.cell.id])
                elif b.cell is None and b.na is None and status == 0:
                    self.bind_cell(inv, b, frame)
                    if b.cell is not None:
                        rebinds.append([b.id, b.cell.id])
                if b.cell is not None:
                    cells.append(b.cell)
            inv.active = cells
            inv.special = [c for c in cells if c.codec.indirect or not (inv.sp <= c.addr < inv.cfa)]
        # local references may be re-seated each time their declaration runs
        for b in inv.local_refs:
            if any(vi == b.var and status == 0 for (vi, status) in active):
                old = b.cell
                self.bind_cell(inv, b, frame)
                if b.cell is not old and b.cell is not None:
                    rebinds.append([b.id, b.cell.id])
                    inv.active = [c for c in inv.active if c is not old] + [b.cell]
                    inv.special = [c for c in inv.active if c.codec.indirect or not (inv.sp <= c.addr < inv.cfa)]
        return sid, rebinds

    def make_binding(self, inv, vi, frame, status):
        frame = frame or gdb.newest_frame()
        var = inv.fn.vars[vi]
        b = Binding(len(self.bindings), inv, vi, None, None, len(self.steps))
        self.bindings.append(b)
        inv.bindings[vi] = b
        if var["k"] == "local" and var["ref"]:
            inv.local_refs.append(b)
        if var["ref"] and status != 0:
            return b  # a reference declared later: bind when initialized
        self.bind_cell(inv, b, frame)
        return b

    def bind_cell(self, inv, b, frame):
        frame = frame or gdb.newest_frame()
        var = inv.fn.vars[b.var]
        try:
            if var["k"] == "member":
                if inv.this_addr is None:
                    tv = frame.read_var("this")
                    inv.this_addr = int(tv)
                ft = var["ftype"]
                b.cell = self.cell_for(inv.this_addr + var["off"], ft, inv)
                return
            v = var["sym"].value(frame)
            t = v.type.strip_typedefs()
            if t.code in (gdb.TYPE_CODE_REF, gdb.TYPE_CODE_RVALUE_REF):
                tv = v.referenced_value()
                if tv.address is None:
                    b.na = "reference target is not in memory"
                    return
                b.cell = self.cell_for(int(tv.address), tv.type, inv)
            else:
                if v.is_optimized_out:
                    b.na = "optimized out"
                    return
                if v.address is None:
                    b.na = "not stored in memory (register)"
                    return
                if var["n"] == "this":
                    # the pointer itself is not shown; members get their own cells
                    inv.this_addr = int(v)
                    b.na = "this pointer (members are listed separately)"
                    return
                b.cell = self.cell_for(int(v.address), v.type, inv)
        except gdb.MemoryError:
            b.na = "cannot read memory"
        except Exception as e:  # noqa: BLE001
            b.na = "unavailable: %s" % e

    def cell_for(self, addr, t, inv):
        t = t.strip_typedefs().unqualified()
        tn = str(t)
        key = (addr, tn)
        c = self.cells.get(key)
        if c is None:
            codec = codec_for(t)
            stack = self.stack_range[0] <= addr < self.stack_range[1]
            owner = None
            if stack:
                for s in self.shadow:
                    if s.sp - 512 <= addr < s.cfa:
                        owner = s.id
            c = Cell(len(self.cell_list), addr, codec, pretty_type(t), stack, owner)
            self.cells[key] = c
            self.cell_list.append(c)
        return c

    def collect_changes(self):
        live = [b.cell for b in self.global_bindings]
        seen = set(c.id for c in live)
        lo, hi = None, None
        # Waiting frames only change through aliasing.  If the bytes of all
        # waiting frames are identical to the previous stop, their by-value
        # cells cannot have changed: skip them (exact, keeps deep recursion
        # O(1) per step).  References / containers / pointers are always checked.
        shadow = self.shadow

        def add_all(cells):
            nonlocal lo, hi
            for c in cells:
                if c.id in seen:
                    continue
                seen.add(c.id)
                live.append(c)
                if c.stack:
                    a, z = c.addr, c.addr + c.codec.size
                    lo = a if lo is None or a < lo else lo
                    hi = z if hi is None or z > hi else hi

        add_all(live[:])
        if shadow:
            add_all(shadow[-1].active)
        waiting = shadow[:-1]
        if waiting:
            lo_w, hi_w = waiting[-1].sp, waiting[0].cfa
            block = None
            if 0 < hi_w - lo_w <= (8 << 20):
                try:
                    block = bytes(self.inf.read_memory(lo_w, hi_w - lo_w))
                except gdb.MemoryError:
                    block = None
            old = self._wait_block
            olo, ohi = self._wait_bounds or (0, 0)
            ilo, ihi = max(lo_w, olo), min(hi_w, ohi)
            comparable = block is not None and old is not None and ilo < ihi
            whole_same = comparable and block[ilo - lo_w:ihi - lo_w] == old[ilo - olo:ihi - olo]
            for inv in reversed(waiting):  # newest waiting frame first
                inside = comparable and ilo <= inv.sp and inv.cfa <= ihi
                if inside and whole_same:
                    break  # this frame and every older one: stack bytes unchanged
                if inside and block[inv.sp - lo_w:inv.cfa - lo_w] == old[inv.sp - olo:inv.cfa - olo]:
                    continue
                add_all(inv.active)
            # cells reachable from waiting frames that can change behind their back
            add_all(v[0] for v in self._wait_special.values())
            self._wait_block = block
            self._wait_bounds = (lo_w, hi_w)
        else:
            self._wait_block = None
            self._wait_bounds = None
        if lo is None or hi - lo > (1 << 20):
            lo = hi = 0
        ctx = ReadCtx(self.inf, lo, hi)
        changes = []
        for c in live:
            try:
                sig = c.codec.sig(ctx, c.addr)
            except gdb.MemoryError:
                sig = b"\x00<unreadable>"
            if sig == c.last_sig:
                continue
            try:
                if sig.startswith(b"\x00<unreadable>"):
                    val = {"t": "na", "v": "cannot read memory"}
                else:
                    val = c.codec.change(ctx, c, sig)
            except gdb.MemoryError:
                val = {"t": "na", "v": "cannot read memory"}
            except Exception as e:  # noqa: BLE001
                val = {"t": "na", "v": "decode error: %s" % e}
            c.last_sig = sig
            changes.append([c.id, val])
        return changes

    def accesses(self, inv, frame, line):
        text = self.line_text(inv.fn, line)
        if "[" not in text:
            return None
        subs = self.sub_cache.get((inv.fn.file, line))
        if subs is None:
            subs = find_subscripts(text)
            self.sub_cache[(inv.fn.file, line)] = subs
        if not subs:
            return None
        out = []
        ctx = ReadCtx(self.inf, 0, 0)
        for (full, base, idxs) in subs:
            rec = {"e": full}
            try:
                bv = gdb.parse_and_eval(base)
                bt = bv.type.strip_typedefs()
                if bt.code in (gdb.TYPE_CODE_REF, gdb.TYPE_CODE_RVALUE_REF):
                    bv = bv.referenced_value()
                    bt = bv.type.strip_typedefs()
                if bv.address is None:
                    continue
                codec = codec_for(bt)
                addr = int(bv.address)
                ix = []
                cur = codec
                for e in idxs:
                    i = int(gdb.parse_and_eval(e))
                    ix.append(i)
                    if cur is None:
                        break
                    r = cur.index(ctx, addr, i)
                    if r is None:
                        cur = None
                        break
                    ec, ea, n = r
                    if ec is None:
                        rec["oob"] = n
                        cur = None
                        break
                    cur, addr = ec, ea
                rec["ix"] = ix
                if cur is not None and "oob" not in rec and len(ix) == len(idxs):
                    rec["v"] = cur.full(ctx, addr)
                    rec["a"] = "0x%x" % addr
                key = re.match(r"(?:this->)?([A-Za-z_]\w*)", base).group(1)
                mem = ("this->" + key) if base.startswith("this->") else None
                for vi, var in enumerate(inv.fn.vars):
                    if var["n"] == (mem or key) or (mem is None and var["n"] == "this->" + key):
                        if vi in inv.bindings:
                            rec["b"] = inv.bindings[vi].id
                        break
            except gdb.MemoryError:
                rec["na"] = "cannot read memory"
            except Exception as e:  # noqa: BLE001
                rec["na"] = str(e)[:200]
            out.append(rec)
        return out

    # ---------------- truncation / end ----------------

    def truncate(self, reason):
        if self.phase != "trace":
            return
        self.phase = "untraced"
        self.end["reason"] = reason
        self.end["truncatedAtStep"] = len(self.steps)
        self.end["stackAtTruncation"] = [i.id for i in self.shadow]
        for inv in self.shadow:
            inv.status = "live when trace stopped"
        for bp in self.line_bps:
            try:
                if bp.is_valid():
                    bp.delete()
            except Exception:  # noqa: BLE001
                pass
        roots = [i for i in self.shadow if i.parent is None]
        keep_sites = set(i.ret_addr for i in roots if i.fn.ret_kind != "slow")
        for addr, rbp_ in list(self.ret_sites.items()):
            if addr not in keep_sites:
                try:
                    if rbp_.is_valid():
                        rbp_.delete()
                except Exception:  # noqa: BLE001
                    pass
                del self.ret_sites[addr]
        for inv in roots:
            if inv.fn.ret_kind == "slow":
                self._make_retbp(inv)   # to capture the root's return value later
        for inv in self.shadow:
            if inv not in roots and inv.retbp is not None:
                try:
                    if inv.retbp.is_valid():
                        inv.retbp.delete()
                except Exception:  # noqa: BLE001
                    pass
        self.end["programFinished"] = None
        self.write()   # in case the remainder never finishes
        self.arm_watchdog(RUN_SECONDS)
        progress(phase="untraced", steps=len(self.steps))

    def arm_watchdog(self, seconds):
        self.timed_out = False
        gen = object()
        self._wd_gen = gen

        def fire():
            if getattr(self, "_wd_gen", None) is not gen:
                return
            self.timed_out = True
            try:
                if self.inf is not None and self.inf.pid:
                    os.kill(self.inf.pid, signal.SIGINT)
            except OSError:
                pass

        t = threading.Timer(seconds, fire)
        t.daemon = True
        t.start()

    def on_exit(self):
        self.end["programFinished"] = True
        self.end["exitCode"] = self.exit_code
        if self.phase == "trace":
            self.end.setdefault("reason", "exited")
            if self.steps:
                self.steps.append({"k": "exit", "i": None, "ln": None, "d": 0, "code": self.exit_code})
        for inv in self.shadow:
            if inv.status == "live":
                inv.status = "live at exit"

    # ---------------- output ----------------

    def write(self):
        fns = []
        for f in self.fns:
            fns.append({"id": f.id, "name": f.name, "short": f.short, "file": f.file, "line": f.line,
                        "vars": [{"n": v["n"], "l": v["l"], "k": v["k"], "ty": v["ty"], "ref": v["ref"]}
                                 for v in f.vars]})
        invs = []
        for i in self.invs:
            d = {"id": i.id, "fn": i.fn.id, "parent": i.parent.id if i.parent else None, "depth": i.depth,
                 "call": i.call_step, "ret": i.ret_step, "status": i.status, "cfa": "0x%x" % i.cfa}
            if i.ret is not None:
                d["v"] = i.ret
            if i.caller:
                d["caller"] = i.caller
            if i.call_line:
                d["callLine"] = i.call_line
            invs.append(d)
        cells = [{"id": c.id, "addr": "0x%x" % c.addr, "ty": c.ty, "stack": 1 if c.stack else 0,
                  "owner": c.owner} for c in self.cell_list]
        bindings = [{"id": b.id, "inv": b.inv.id if b.inv is not None else None, "v": b.var, "c": b.cell.id if b.cell else None,
                     "na": b.na, "since": b.since} for b in self.bindings]
        out = {
            "schema": "rv-native-trace/1",
            "files": self.files,
            "functions": fns,
            "globals": self.global_vars,
            "invocations": invs,
            "bindings": bindings,
            "cells": cells,
            "scopes": self.scopes,
            "steps": self.steps,
            "end": self.end,
            "lateReturns": self.late_returns,
            "limits": {"maxSteps": MAX_STEPS, "maxSeconds": MAX_SECONDS, "maxDepth": MAX_DEPTH,
                       "maxArrayElements": MAX_ARRAY, "maxCompositeElements": MAX_COMPOSITE},
            "stats": dict(self.stats, seconds=round(time.time() - T0, 3), breakpoints=len(self.line_bps),
                          invocations=len(self.invs), cells=len(self.cell_list)),
        }
        tmp = OUT_PATH + ".tmp"
        text = json.dumps(out, separators=(",", ":"))
        with open(tmp, "w", encoding="utf-8") as fh:
            fh.write(text)
        os.replace(tmp, OUT_PATH)


def main():
    tr = Tracer()
    tr.finished = False
    try:
        tr.setup()
    except gdb.error as e:
        tr.end["reason"] = "setup-failed"
        tr.end["error"] = str(e)
        tr.write()
        return
    tr.arm_watchdog(MAX_SECONDS)
    while not tr.finished:
        try:
            gx("continue")
        except gdb.error as e:
            msg = str(e)
            if "not being run" in msg or "No process" in msg:
                break
            tr.end.setdefault("internalErrors", []).append("continue: %s" % msg)
            break
        if tr.inf.pid == 0:
            tr.on_exit()
            break
        try:
            tr.on_top_stop()
        except Exception as e:  # noqa: BLE001
            tr.end.setdefault("internalErrors", []).append("top stop: %r" % (e,))
            tr.truncate("internal-error")
    if tr.end.get("programTimedOut"):
        try:
            gx("kill")
        except gdb.error:
            pass
        tr.end["programFinished"] = False
    tr.write()
    progress(phase="done", steps=len(tr.steps))


if os.environ.get("RV_PROFILE"):
    import cProfile
    import pstats
    _prof = cProfile.Profile()
    _prof.runcall(main)
    with open(os.environ["RV_PROFILE"], "w") as _fh:
        pstats.Stats(_prof, stream=_fh).sort_stats("cumulative").print_stats(30)
else:
    main()
