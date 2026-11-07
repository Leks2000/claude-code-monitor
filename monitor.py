"""Claude Code Monitor: a local dashboard for Claude Code sessions and PC load.

http://127.0.0.1:8770 (and from phones on the home network). Read-only: Claude Code session logs
(~/.claude/projects/*/*.jsonl), processes (psutil), nvidia-smi, Ollama API, an optional status command.
Session logs are read incrementally from the last offset (kept in cache.json); each file is read in full only once.

    python monitor.py            run the dashboard
    python monitor.py --demo     serve made-up data (for screenshots)
Settings: config.json next to this file (see config.example.json).
"""
import ipaddress
import json
import os
import re
import socket
import subprocess
import sys
import threading
import time
import traceback
import urllib.request
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import psutil

import projects

HERE = Path(__file__).resolve().parent
CACHE = HERE / "cache.json"
LOG = HERE / "monitor.log"
WIN = sys.platform == "win32"
SLOT = 300                  # tokens are summed in 5-minute buckets
KEEP_DAYS = 8
NO_WIN = 0x08000000 if WIN else 0   # CREATE_NO_WINDOW: no console flashes

DEFAULTS = {
    "port": 8770,
    "lan": True,                       # also listen on the home network (private IPs only)
    "lang": "auto",                    # "auto" | "en" | "ru"
    "projects_dir": str(Path.home() / ".claude" / "projects"),
    "disks": [],                       # [] = all fixed drives, or e.g. ["C:\\", "D:\\"]
    "active_minutes": 5,               # a session is active if its log changed this recently
    "fast_seconds": 1,                 # CPU/RAM/GPU refresh; processes and sessions stay at 5 s
    "limits": {"vram_pct": 90, "disk_gb": 20, "chats": 3},
    # a command line counts as a heavy render if the process name contains A and the command line contains B
    "heavy": [["blender", " -b"], ["blender", "--background"], ["ffmpeg", "nvenc"], ["ffmpeg", "libx264"],
              ["node", "remotion"]],
    "queue_script": "render_gate",     # python scripts with this name are shown as a render queue
    "project_markers": ["STATUS.md", "HANDOFF.md", "CLAUDE.md"],
    # optional: a command printing image-account status (gpt_bridge format), polled once a minute
    "bridge_cmd": [],
    "bridge_per_account": 3,
}


def load_config():
    cfg = json.loads(json.dumps(DEFAULTS))
    try:
        user = json.loads((HERE / "config.json").read_text(encoding="utf-8"))
        for k, v in user.items():
            if isinstance(v, dict) and isinstance(cfg.get(k), dict):
                cfg[k].update(v)
            else:
                cfg[k] = v
    except FileNotFoundError:
        pass
    return cfg


CFG = load_config()
PORT = CFG["port"]
PROJECTS = Path(os.path.expanduser(CFG["projects_dir"]))
ACTIVE_SEC = CFG["active_minutes"] * 60
HEAVY = [tuple(x) for x in CFG["heavy"]]
QUEUE = CFG["queue_script"].lower()
MARKERS = tuple(CFG["project_markers"])
LIMITS = CFG["limits"]


def log(msg):
    try:
        if LOG.exists() and LOG.stat().st_size > 1_000_000:
            LOG.write_text("", encoding="utf-8")
        with LOG.open("a", encoding="utf-8") as f:
            f.write(time.strftime("%d.%m %H:%M:%S ") + msg + "\n")
    except OSError:
        pass


def run(cmd, timeout=10):
    try:
        r = subprocess.run(cmd, capture_output=True, timeout=timeout, creationflags=NO_WIN)
        return r.stdout.decode("utf-8", "replace")
    except Exception as e:
        return "ERR " + str(e)


# ---------------------------------------------------------------- Claude Code sessions
TAG = re.compile(r"</?[a-zA-Z_][\w-]*(?:\s[^>]*)?>")
PATH_IN = re.compile(r"([A-Za-z]:\\[^\s\"'<>|*?,;]+)")


def ts_epoch(s):
    try:
        return datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp()
    except Exception:
        return None


def first_line(text):
    for ln in TAG.sub("\n", text).splitlines():
        ln = ln.strip()
        if ln and not ln.startswith("Caveat:"):
            return ln[:160]
    return ""


def msg_text(m):
    c = (m or {}).get("content")
    if isinstance(c, str):
        return c
    if isinstance(c, list):
        return "\n".join(b.get("text", "") for b in c if isinstance(b, dict) and b.get("type") == "text")
    return ""


class Chats:
    def __init__(self):
        self.files = {}     # path -> state
        self.seen = {}      # message id -> [path, slot]
        self.lock = threading.Lock()
        self.indexing = None
        self.load()

    def load(self):
        try:
            d = json.loads(CACHE.read_text(encoding="utf-8"))
            if d.get("v") == 2:
                self.files, self.seen = d["files"], d["seen"]
        except Exception:
            pass

    def save(self):
        with self.lock:
            data = json.dumps({"v": 2, "files": self.files, "seen": self.seen}, ensure_ascii=False)
        tmp = CACHE.with_suffix(".tmp")
        tmp.write_text(data, encoding="utf-8")
        os.replace(tmp, CACHE)

    @staticmethod
    def list_files():
        out = []
        for proj in os.scandir(PROJECTS):
            if not proj.is_dir():
                continue
            for e in os.scandir(proj.path):
                if e.name.endswith(".jsonl") and e.is_file():
                    out.append((e.path, proj.name, e.name[:-6], e.stat()))
                elif e.is_dir():
                    sub = os.path.join(e.path, "subagents")
                    if os.path.isdir(sub):
                        for s in os.scandir(sub):
                            if s.name.endswith(".jsonl"):
                                out.append((s.path, proj.name, e.name, s.stat()))
        return out

    def scan(self):
        now = time.time()
        cutoff = now - KEEP_DAYS * 86400
        files = self.list_files()
        todo = []
        for path, proj, sid, st in files:
            f = self.files.get(path)
            if f is None:
                f = {"sid": sid, "dir": proj, "off": 0, "size": 0, "mtime": 0, "b": {}, "last": None,
                     "cwd": None, "title": None, "first": None, "model": None, "head": False}
                if st.st_mtime < cutoff:       # old file: its tokens are outside the window, skip it
                    f["off"] = st.st_size
                with self.lock:
                    self.files[path] = f
            f["mtime"] = st.st_mtime
            if st.st_size < f["off"]:        # file was rewritten
                f.update(off=0, b={}, last=None)
            if st.st_size > f["off"]:
                todo.append((path, st.st_size))
        big = sum(s - self.files[p]["off"] for p, s in todo)
        done = 0
        for path, size in todo:
            if big > 50_000_000:
                self.indexing = [done // 1_000_000, big // 1_000_000]
            done += self.read_tail(path, size)
        self.indexing = None
        # drop old buckets
        old_slot = int(cutoff // SLOT)
        with self.lock:
            live = {p for p, *_ in files}
            for p in list(self.files):
                if p not in live:
                    del self.files[p]
            for f in self.files.values():
                for k in [k for k in f["b"] if int(k) < old_slot]:
                    del f["b"][k]
            for k in [k for k, v in self.seen.items() if v[1] < old_slot]:
                del self.seen[k]
        return bool(todo)

    def read_tail(self, path, size):
        f = self.files[path]
        start = f["off"]
        with open(path, "rb") as fh:
            fh.seek(start)
            pos = start
            rest = b""
            while pos < size:
                chunk = fh.read(min(8_000_000, size - pos))
                if not chunk:
                    break
                pos += len(chunk)
                buf = rest + chunk
                cut = buf.rfind(b"\n")
                if cut < 0:
                    rest = buf
                    continue
                rest = buf[cut + 1:]
                for line in buf[:cut].split(b"\n"):
                    self.parse(path, f, line)
            f["off"] = pos - len(rest)
        return size - start

    def parse(self, path, f, line):
        if b'"usage"' in line and b'"type":"assistant"' in line:
            try:
                d = json.loads(line)
            except ValueError:
                return
            m = d.get("message") or {}
            u = m.get("usage") or {}
            mid = m.get("id") or d.get("requestId")
            t = ts_epoch(d.get("timestamp", ""))
            if not mid or t is None:
                return
            tot = (u.get("input_tokens") or 0) + (u.get("cache_creation_input_tokens") or 0) + \
                (u.get("cache_read_input_tokens") or 0) + (u.get("output_tokens") or 0)
            out = u.get("output_tokens") or 0
            slot = int(t // SLOT)
            with self.lock:
                owner = self.seen.get(mid)
                if owner and owner[0] != path:
                    return                       # same message in a copied history (fork/resume)
                if owner:
                    last = f["last"]
                    if not last or last[0] != mid:
                        return
                    b = f["b"].setdefault(str(last[1]), [0, 0])   # one reply split into blocks: replace
                    b[0] -= last[2]
                    b[1] -= last[3]
                self.seen[mid] = [path, slot]
                b = f["b"].setdefault(str(slot), [0, 0])
                b[0] += tot
                b[1] += out
                f["last"] = [mid, slot, tot, out]
                if m.get("model") and not m["model"].startswith("<"):
                    f["model"] = m["model"]
            if not f["cwd"] and d.get("cwd"):
                f["cwd"] = d["cwd"]
        elif b'"custom-title"' in line[:40]:
            try:
                f["title"] = json.loads(line).get("customTitle")
            except ValueError:
                pass
        elif not f["first"] and line.startswith(b'{"type":"queue-operation"') and b'"enqueue"' in line[:80]:
            try:
                d = json.loads(line)
                f["first"] = first_line(d.get("content") or "") or None
            except ValueError:
                pass
        elif (not f["first"] or not f["cwd"]) and b'"type":"user"' in line:
            try:
                d = json.loads(line)
            except ValueError:
                return
            if not f["cwd"] and d.get("cwd"):
                f["cwd"] = d["cwd"]
            if not f["first"] and not d.get("isMeta") and not d.get("isSidechain"):
                f["first"] = first_line(msg_text(d.get("message"))) or None

    def read_head(self, path, f):
        """For old files whose start was skipped: first prompt and folder."""
        f["head"] = True
        try:
            with open(path, "rb") as fh:
                data = fh.read(1_500_000)
        except OSError:
            return
        keep_b, keep_last = f["b"], f["last"]
        for line in data.split(b"\n")[:-1]:
            if b'"usage"' in line:
                if not f["cwd"] and b'"cwd"' in line:
                    try:
                        f["cwd"] = json.loads(line).get("cwd")
                    except ValueError:
                        pass
                continue
            self.parse(path, f, line)
            if f["first"] and f["cwd"]:
                break
        f["b"], f["last"] = keep_b, keep_last

    _proj = {}

    @classmethod
    def project(cls, f):
        cwd = (f.get("cwd") or "").rstrip("\\/")
        if "scratch-workspaces" in f["dir"] or "scratch" in cwd.lower():
            return "scratch"
        key = (cwd, f.get("first"))
        if key not in cls._proj:
            cls._proj[key] = cls._project(cwd, f.get("first") or "") or os.path.basename(cwd) or f["dir"]
        return cls._proj[key]

    @staticmethod
    def _project(cwd, first):
        """Session opened in a container folder (e.g. C:\\Projects): take the project folder named in the first prompt."""
        is_proj = lambda d: any(os.path.exists(os.path.join(d, m)) for m in MARKERS)
        if not cwd or is_proj(cwd):
            return None
        for p in PATH_IN.findall(first):
            p = p.rstrip(".:)»")
            if not p.lower().startswith(cwd.lower() + "\\"):
                continue
            parts = p[len(cwd) + 1:].split("\\")
            d, found = cwd, []
            for part in parts[:4]:
                d = os.path.join(d, part)
                if not part or not os.path.isdir(d):
                    break
                found.append(part)
                if is_proj(d):
                    return part
            if found:
                return "/".join(found[:2])
        return None

    def summary(self):
        now = time.time()
        lt = time.localtime(now)
        midnight = time.mktime((lt.tm_year, lt.tm_mon, lt.tm_mday, 0, 0, 0, 0, 0, -1))
        s_hour, s_day, s_week = (now - 3600) // SLOT, midnight // SLOT, (now - 7 * 86400) // SLOT
        sess = {}
        with self.lock:
            items = [(p, f, list(f["b"].items())) for p, f in self.files.items()]
        for path, f, buckets in items:
            main = not path.replace("\\", "/").split("/")[-2] == "subagents"
            s = sess.setdefault(f["sid"], {"sid": f["sid"], "hour": 0, "day": 0, "week": 0, "out_day": 0,
                                           "mtime": 0, "main": None, "agents": 0})
            for k, (tot, out) in buckets:
                k = int(k)
                if k >= s_week:
                    s["week"] += tot
                if k >= s_day:
                    s["day"] += tot
                    s["out_day"] += out
                if k >= s_hour:
                    s["hour"] += tot
            s["mtime"] = max(s["mtime"], f["mtime"])
            if main:
                s["main"] = (path, f)
            else:
                s["agents"] += 1 if now - f["mtime"] < ACTIVE_SEC else 0
        rows = []
        for s in sess.values():
            if not s["main"]:
                continue
            path, f = s.pop("main")
            if now - s["mtime"] > 7 * 86400 and not s["week"]:
                continue
            if (not f["first"] or not f["cwd"]) and not f["head"]:
                self.read_head(path, f)
            s.update(project=self.project(f), title=f.get("title"), first=f.get("first") or "",
                     model=(f.get("model") or "").replace("claude-", ""), ago=int(now - s["mtime"]),
                     active=now - s["mtime"] < ACTIVE_SEC)
            rows.append(s)
        active = sorted([r for r in rows if r["active"]], key=lambda r: r["ago"])
        top_day = sorted([r for r in rows if r["day"]], key=lambda r: -r["day"])[:5]
        top_week = sorted([r for r in rows if r["week"]], key=lambda r: -r["week"])[:5]
        tot = {k: sum(r[k] for r in rows) for k in ("hour", "day", "week", "out_day")}
        return {"active": active, "top_day": top_day, "top_week": top_week, "total": tot,
                "indexing": self.indexing}


# ---------------------------------------------------------------- window titles (Blender file, Studio place), Windows only
if WIN:
    import ctypes
    import ctypes.wintypes as wt
    user32 = ctypes.windll.user32
    EnumProc = ctypes.WINFUNCTYPE(wt.BOOL, wt.HWND, wt.LPARAM)


def window_titles(pids):
    res = {}
    if not WIN:
        return res

    def cb(hwnd, _):
        if not user32.IsWindowVisible(hwnd):
            return True
        pid = wt.DWORD()
        user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
        if pid.value in pids:
            n = user32.GetWindowTextLengthW(hwnd)
            if n:
                buf = ctypes.create_unicode_buffer(n + 1)
                user32.GetWindowTextW(hwnd, buf, n + 1)
                if len(buf.value) > len(res.get(pid.value, "")):
                    res[pid.value] = buf.value
        return True
    user32.EnumWindows(EnumProc(cb), 0)
    return res


_JOB = None


def tie_to_me(proc):
    """Windows: put a child into a job that is killed when this process exits (nvidia-smi -lms never ends)."""
    global _JOB
    if not WIN:
        return
    try:
        k32 = ctypes.windll.kernel32
        if _JOB is None:
            class IO(ctypes.Structure):
                _fields_ = [(n, ctypes.c_ulonglong) for n in ("r", "w", "o", "rb", "wb", "ob")]

            class Basic(ctypes.Structure):
                _fields_ = [("a", ctypes.c_longlong), ("b", ctypes.c_longlong), ("LimitFlags", wt.DWORD),
                            ("c", ctypes.c_size_t), ("d", ctypes.c_size_t), ("e", wt.DWORD),
                            ("f", ctypes.c_size_t), ("g", wt.DWORD), ("h", wt.DWORD)]

            class Ext(ctypes.Structure):
                _fields_ = [("basic", Basic), ("io", IO), ("pm", ctypes.c_size_t), ("jm", ctypes.c_size_t),
                            ("ppm", ctypes.c_size_t), ("pjm", ctypes.c_size_t)]
            k32.CreateJobObjectW.restype = wt.HANDLE
            job = k32.CreateJobObjectW(None, None)
            info = Ext()
            info.basic.LimitFlags = 0x2000                    # JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
            k32.SetInformationJobObject(wt.HANDLE(job), 9, ctypes.byref(info), ctypes.sizeof(info))
            _JOB = job
        k32.AssignProcessToJobObject(wt.HANDLE(_JOB), wt.HANDLE(int(proc._handle)))
    except Exception as e:
        log("job object: " + str(e))


# ---------------------------------------------------------------- system
WATCH = ("blender", "ffmpeg", "node", "python", "pythonw", "robloxstudio", "ollama")


class System:
    def __init__(self):
        self.cmd = {}           # (pid, create) -> cmdline
        self.uss = {}           # pid -> bytes
        self.uss_t = 0
        self.ncpu = psutil.cpu_count() or 1
        psutil.cpu_percent(None)
        self.me = os.getpid()
        self.ollama_on = False
        self.disks = CFG["disks"] or [p.mountpoint for p in psutil.disk_partitions(all=False)
                                      if "cdrom" not in p.opts and p.fstype and
                                      not p.mountpoint.startswith(("/boot", "/snap", "/System/Volumes"))]

        self.gpu_last = {"error": "nvidia-smi: no data yet"}
        threading.Thread(target=self.gpu_stream, daemon=True).start()

    @staticmethod
    def parse_gpu(line):
        n, u, mu, mt, t, p = [x.strip() for x in line.split(",")][:6]
        mu, mt = float(mu), float(mt)
        return {"name": n.replace("NVIDIA GeForce ", ""), "util": float(u), "vram_used": mu, "vram_total": mt,
                "vram_pct": round(mu / mt * 100, 1), "temp": float(t), "power": float(p) if p[:1].isdigit() else None}

    def gpu_stream(self):
        """One long-running nvidia-smi printing a line every second: cheaper than starting it every second."""
        q = ["nvidia-smi", "--query-gpu=name,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw",
             "--format=csv,noheader,nounits", f"-lms={int(CFG['fast_seconds'] * 1000)}"]
        while True:
            try:
                p = subprocess.Popen(q, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, creationflags=NO_WIN,
                                     text=True, encoding="utf-8", errors="replace")
                tie_to_me(p)
                for line in p.stdout:
                    try:
                        self.gpu_last = self.parse_gpu(line)   # first GPU only: a line per GPU would alternate
                    except Exception:
                        pass
                p.wait()
                self.gpu_last = {"error": "nvidia-smi exited"}
            except FileNotFoundError:
                self.gpu_last = {"error": "nvidia-smi not found"}
                return
            except Exception as e:
                self.gpu_last = {"error": str(e)[:200]}
            time.sleep(10)

    def gpu(self):
        return self.gpu_last

    def fast(self, s):
        """The cheap numbers, every second: CPU, RAM."""
        vm = psutil.virtual_memory()
        return {**s, "cpu": psutil.cpu_percent(None), "ram_used_gb": round((vm.total - vm.available) / 2**30, 1),
                "ram_total_gb": round(vm.total / 2**30, 1), "ram_pct": vm.percent}

    def cmdline(self, p):
        key = (p.pid, p.info.get("create_time"))
        if key not in self.cmd:
            try:
                self.cmd[key] = subprocess.list2cmdline(p.cmdline())
            except Exception:
                self.cmd[key] = ""
        return self.cmd[key]

    def sample(self):
        now = time.time()
        procs = []
        for p in psutil.process_iter(["name", "memory_info", "cpu_percent", "create_time"]):
            if p.pid in (0, 4):
                continue
            procs.append(p)
        alive = {(p.pid, p.info.get("create_time")) for p in procs}
        self.cmd = {k: v for k, v in self.cmd.items() if k in alive}
        # private working set (the Task Manager "Memory" column) is costly: only for the biggest groups, every 30 s
        groups = {}
        for p in procs:
            mi = p.info.get("memory_info")
            g = groups.setdefault((p.info.get("name") or "?"), {"name": p.info.get("name") or "?", "cpu": 0.0, "rss": 0,
                                                                  "n": 0, "pids": []})
            g["cpu"] += (p.info.get("cpu_percent") or 0) / self.ncpu
            g["rss"] += mi.rss if mi else 0
            g["n"] += 1
            g["pids"].append(p)
        by_rss = sorted(groups.values(), key=lambda g: -g["rss"])[:12]
        if now - self.uss_t > 30:
            self.uss_t = now
            new = {}
            for g in by_rss:
                for p in g["pids"][:40]:
                    try:
                        new[p.pid] = p.memory_full_info().uss
                    except Exception:
                        pass
            self.uss = new
        for g in groups.values():
            vals = [self.uss.get(p.pid) for p in g["pids"]]
            g["mem"] = sum(v for v in vals if v) if any(vals) else None
        top_cpu = sorted(groups.values(), key=lambda g: -g["cpu"])[:8]
        top_mem = sorted(by_rss, key=lambda g: -(g["mem"] if g["mem"] is not None else g["rss"]))[:8]
        fmt = lambda g: {"name": g["name"], "n": g["n"], "cpu": round(g["cpu"], 1),
                         "mem_mb": round((g["mem"] if g["mem"] is not None else g["rss"]) / 2**20),
                         "ws_mb": round(g["rss"] / 2**20)}
        vm = psutil.virtual_memory()
        disks = []
        for d in self.disks:
            try:
                u = psutil.disk_usage(d)
                disks.append({"d": d.rstrip("\\:") if WIN else d, "free_gb": round(u.free / 2**30, 1), "total_gb": round(u.total / 2**30),
                              "pct": u.percent})
            except Exception:
                pass
        jobs = self.jobs([p for p in procs if any(w in (p.info.get("name") or "").lower() for w in WATCH)])
        return {"cpu": psutil.cpu_percent(None), "ram_used_gb": round((vm.total - vm.available) / 2**30, 1),
                "ram_total_gb": round(vm.total / 2**30, 1), "ram_pct": vm.percent, "disks": disks,
                "top_cpu": [fmt(g) for g in top_cpu], "top_mem": [fmt(g) for g in top_mem], **jobs}

    def jobs(self, procs):
        self.ollama_on = False
        work, gate = [], []
        gui = {}
        for p in procs:
            if p.pid == self.me:
                continue
            n = (p.info.get("name") or "").lower()
            c = self.cmdline(p)
            cl = c.lower()
            heavy = any(a in n and b in cl for a, b in HEAVY) and not (QUEUE and QUEUE in cl) and \
                not ("remotion" in cl and " studio" in cl)
            item = {"pid": p.pid, "cpu": round((p.info.get("cpu_percent") or 0) / self.ncpu, 1),
                    "mem_mb": round(p.info["memory_info"].rss / 2**20) if p.info.get("memory_info") else 0,
                    "heavy": heavy, "age": int(time.time() - (p.info.get("create_time") or time.time()))}
            if "blender" in n:
                blend = next((x for t in re.findall(r'"([^"]+\.blend)"|(\S+\.blend)\b', c) for x in t if x), "")
                bg = " -b" in cl or "--background" in cl
                render = bg and (re.search(r"\s(-a|-f|--render-anim|--render-frame)\b", c) or "render" in cl)
                scr = re.search(r'(?:-P|--python)\s+"?([^"]+?\.py)', c)
                what = os.path.basename(blend)
                if bg:
                    mode = "render" if render else "bg"
                    if scr:
                        what = (what + " · " if what else "") + os.path.basename(scr.group(1))
                else:
                    mode = "gui"
                    gui[p.pid] = item
                work.append({**item, "kind": "Blender", "mode": mode, "what": what})
            elif "ffmpeg" in n:
                args = re.findall(r'"[^"]*"|\S+', c)
                outs = [a.strip('"') for a in args[1:] if not a.startswith("-")]
                ins = [args[i + 1].strip('"') for i, a in enumerate(args[:-1]) if a == "-i"]
                o = next((a for a in reversed(outs) if a not in ins), "")
                work.append({**item, "kind": "ffmpeg", "what": o[-90:] or c[-90:],
                             "path": os.path.dirname(o)[-60:]})
            elif n.startswith("node"):
                if "remotion" not in cl:
                    continue
                if "chrome-headless" in cl or "compositor" in cl:
                    continue
                m = re.search(r"([A-Za-z]:[\\/][^\"]*?|/[^\"]*?)[\\/]node_modules", c)
                work.append({**item, "kind": "Remotion", "mode": "studio" if " studio" in cl else "render",
                             "what": os.path.basename(m.group(1)) if m else ""})
            elif n.startswith("python"):
                args = re.findall(r'"[^"]*"|\S+', c)
                args = [a.strip('"') for a in args]
                scr = next((a for a in args[1:] if a.lower().endswith(".py")), None)
                mod = args[args.index("-m") + 1] if "-m" in args and args.index("-m") + 1 < len(args) else None
                if not scr and not mod:
                    continue
                name = os.path.basename(scr) if scr else "-m " + mod
                low = (scr or mod or "").lower()
                if "comfyui" in cl and os.path.basename(low) == "main.py":
                    kind = "ComfyUI"
                elif QUEUE and QUEUE in low and scr:
                    i = args.index(scr)
                    own = next((a for a in args[i + 1:] if not a.startswith("--")), "")
                    gate.append({**item, "own": own, "low": "--low" in args})
                    continue
                else:
                    kind = "python"
                folder = os.path.basename(os.path.dirname(scr)) if scr else ""
                rest = " ".join(a for a in args[args.index(scr) + 1:][:3]) if scr else ""
                work.append({**item, "kind": kind, "what": (f"{folder}/{name}" if folder else name) +
                             (" " + rest[:60] if rest else "")})
            elif "robloxstudio" in n:
                gui[p.pid] = item
                work.append({**item, "kind": "Roblox Studio", "mode": "nowin", "what": ""})
            elif n.startswith("ollama"):
                self.ollama_on = True
        if gui:
            titles = window_titles(set(gui))
            for w in work:
                t = titles.get(w["pid"])
                if t and w["pid"] in gui:
                    t = re.sub(r"^Blender\s*", "", t).strip(" -[]") if w["kind"] == "Blender" else \
                        re.sub(r"\s*-\s*Roblox Studio$", "", t)
                    w["what"] = t[:100] or w["what"]
                    if w["kind"] == "Roblox Studio":
                        w["mode"] = "gui"
        # identical rows (venv python launcher + its child, Studio copies) become one row
        merged = {}
        for w in work:
            k = (w["kind"], w["what"])
            if k in merged:
                m = merged[k]
                m["cpu"] = round(m["cpu"] + w["cpu"], 1)
                m["mem_mb"] += w["mem_mb"]
                m["n"] += 1
                m["heavy"] |= w["heavy"]
                m["age"] = max(m["age"], w["age"])
            else:
                merged[k] = {**w, "n": 1}
        work = sorted(merged.values(), key=lambda w: (not w["heavy"], -w["cpu"]))
        return {"work": work, "gate": gate, "rendering": [w for w in work if w["heavy"]]}


def ollama():
    try:
        with urllib.request.urlopen("http://127.0.0.1:11434/api/ps", timeout=1.5) as r:
            d = json.load(r)
        return {"on": True, "models": [{"name": m.get("name"), "vram_mb": round((m.get("size_vram") or 0) / 2**20),
                                        "until": (m.get("expires_at") or "")[11:16]} for m in d.get("models", [])]}
    except Exception:
        return {"on": False, "models": []}


def bridge_status():
    cmd = [sys.executable.replace("pythonw.exe", "python.exe") if a == "python" else a for a in CFG["bridge_cmd"]]
    out = run(cmd, 20)
    accs = []
    for ln in out.splitlines()[1:]:
        m = re.match(r"(\S+)( \*)?\s+(\d+)\s+(.+)$", ln)
        if not m or ln.startswith("*"):
            continue
        name, cur, used, st = m.group(1), bool(m.group(2)), int(m.group(3)), m.group(4).strip()
        if name == "(first)":
            continue
        until = re.search(r"limit until (\d\d\.\d\d \d\d:\d\d)", st)
        accs.append({"acc": mask(name), "current": cur, "used": used,
                     "ready": st == "ready", "until": until.group(1)[6:] if until else None,
                     "until_full": until.group(1) if until else None, "state": st})
    ready = [a for a in accs if a["ready"]]
    frames = sum(max(0, CFG["bridge_per_account"] - a["used"]) for a in ready)
    for a in accs:
        a["left"] = max(0, CFG["bridge_per_account"] - a["used"])
    waits = sorted(a["until_full"] for a in accs if a["until_full"])
    return {"t": time.strftime("%H:%M"), "accounts": accs, "ready": len(ready), "total": len(accs), "frames": frames,
            "next_free": waits[0][6:] if waits else None, "all_free": waits[-1][6:] if waits else None,
            "error": None if accs else out.strip()[:300]}


def mask(email):
    u, _, d = email.partition("@")
    return (u[:6] + "…" if len(u) > 7 else u) + ("@" + d.split(".")[0] if d else "")


# ---------------------------------------------------------------- collector
class Collector:
    def __init__(self):
        self.chats = Chats()
        self.sys = System()
        self.board = projects.Board(CFG)
        self.data = {"ok": False}
        self.last = None
        self.bridge = {"t": None, "accounts": [], "error": "not polled yet"}
        self.bridge_t = 0
        self.save_t = time.time()

    def loop(self):
        """Processes and sessions every 5 s, CPU/RAM/GPU every `fast_seconds`."""
        threading.Thread(target=self.chat_loop, daemon=True).start()
        threading.Thread(target=self.board.loop, args=(log,), daemon=True).start()
        fast, slow_t = CFG["fast_seconds"], 0
        while True:
            t0 = time.time()
            try:
                if t0 - slow_t >= 5 - fast / 2:
                    slow_t = t0
                    self.tick()
                elif self.last:
                    s, ch, oll, br = self.last
                    s = self.sys.fast(s)
                    self.last = (s, ch, oll, br)
                    self.data = build(s, self.sys.gpu(), ch, oll, br, t0)
            except Exception:
                log(traceback.format_exc())
            time.sleep(max(0.2, fast - (time.time() - t0)))

    def chat_loop(self):
        while True:
            try:
                self.chats.scan()
                if time.time() - self.save_t > 60:
                    self.chats.save()
                    self.save_t = time.time()
            except Exception:
                log(traceback.format_exc())
            time.sleep(5)

    def tick(self):
        t0 = time.time()
        if CFG["bridge_cmd"] and t0 - self.bridge_t > 60:
            self.bridge_t = t0
            threading.Thread(target=self.poll_bridge, daemon=True).start()
        s = self.sys.sample()
        ch = self.chats.summary()
        oll = ollama() if self.sys.ollama_on else {"on": False, "models": []}
        br = self.bridge if CFG["bridge_cmd"] else None
        self.last = (s, ch, oll, br)
        self.data = build(s, self.sys.gpu(), ch, oll, br, t0)

    def poll_bridge(self):
        try:
            self.bridge = bridge_status()
        except Exception as e:
            self.bridge = {"t": time.strftime("%H:%M"), "accounts": [], "error": str(e)}


def build(s, g, ch, oll, bridge, t0):
    alerts = []
    if g.get("vram_pct", 0) > LIMITS["vram_pct"]:
        alerts.append({"k": "vram", "v": g["vram_pct"]})
    for d in s["disks"]:
        if d["free_gb"] < LIMITS["disk_gb"]:
            alerts.append({"k": "disk", "d": d["d"], "v": d["free_gb"]})
    if len(ch["active"]) > LIMITS["chats"]:
        alerts.append({"k": "chats", "v": len(ch["active"])})
    return {"ok": True, "time": time.strftime("%H:%M:%S"), "host": socket.gethostname(), "lang": CFG["lang"],
            "sys": s, "gpu": g, "chats": ch, "ollama": oll, "bridge": bridge, "alerts": alerts, "limits": LIMITS,
            "queue": bool(QUEUE), "per_account": CFG["bridge_per_account"], "cost_ms": round((time.time() - t0) * 1000)}


# ---------------------------------------------------------------- demo data (for screenshots, --demo)
def demo():
    now = time.time()
    rnd = lambda a, b: a + (b - a) * ((now * 7.3) % 1)
    chat = lambda p, t, f, m, h, d, w, ago, ag=0: {"sid": t, "project": p, "title": t, "first": f, "model": m,
                                                    "hour": h, "day": d, "week": w, "out_day": d // 160, "ago": ago,
                                                    "active": ago < 300, "agents": ag}
    rows = [chat("landing-site", "Landing page redesign", "Rebuild the hero section and pricing table, keep Lighthouse 95+",
                 "opus-5-5", 18_400_000, 41_200_000, 160_000_000, 4),
            chat("telegram-bot", "News bot: approval queue", "Add an approval queue before posts go to the channel",
                 "sonnet-5-5", 6_100_000, 22_700_000, 98_000_000, 38),
            chat("game-prototype", "Enemy AI and wave spawner", "Waves get harder every 2 minutes, add a boss on wave 5",
                 "opus-5-5", 9_800_000, 12_300_000, 74_000_000, 95, 2),
            chat("video-pipeline", "Shorts render pipeline", "Render 9:16 shorts from the script with captions",
                 "sonnet-5-5", 0, 8_900_000, 121_000_000, 3 * 3600),
            chat("api-server", "Rate limiter and tests", "Add a token-bucket rate limiter, cover with tests",
                 "haiku-5-5", 0, 2_100_000, 45_000_000, 26 * 3600)]
    active = [r for r in rows if r["active"]]
    ch = {"active": active, "top_day": sorted(rows, key=lambda r: -r["day"]),
          "top_week": sorted(rows, key=lambda r: -r["week"]), "indexing": None,
          "total": {"hour": 34_300_000, "day": 87_200_000, "week": 498_000_000, "out_day": 545_000}}
    p = lambda name, n, cpu, mem: {"name": name, "n": n, "cpu": cpu, "mem_mb": mem, "ws_mb": mem}
    s = {"cpu": round(rnd(38, 52), 1), "ram_used_gb": 19.4, "ram_total_gb": 31.8, "ram_pct": 61.0,
         "disks": [{"d": "C", "free_gb": 126.0, "total_gb": 894, "pct": 85.9},
                   {"d": "D", "free_gb": 17.6, "total_gb": 932, "pct": 98.1},
                   {"d": "E", "free_gb": 317.0, "total_gb": 932, "pct": 66.0}],
         "top_cpu": [p("blender.exe", 1, 31.4, 3120), p("ffmpeg.exe", 1, 9.8, 410), p("claude.exe", 24, 6.2, 2950),
                     p("node.exe", 6, 3.1, 880), p("chrome.exe", 31, 2.4, 2640), p("python.exe", 3, 1.9, 1610),
                     p("dwm.exe", 1, 1.1, 80), p("Code.exe", 12, 0.9, 1210)],
         "top_mem": [p("blender.exe", 1, 31.4, 3120), p("claude.exe", 24, 6.2, 2950), p("chrome.exe", 31, 2.4, 2640),
                     p("python.exe", 3, 1.9, 1610), p("Code.exe", 12, 0.9, 1210), p("node.exe", 6, 3.1, 880),
                     p("ffmpeg.exe", 1, 9.8, 410), p("Telegram.exe", 1, 0.2, 380)],
         "work": [{"pid": 4120, "kind": "Blender", "mode": "render", "what": "intro_scene.blend · render_shots.py",
                   "cpu": 31.4, "mem_mb": 3120, "heavy": True, "age": 840, "n": 1},
                  {"pid": 5532, "kind": "ffmpeg", "what": "D:\\videos\\out\\short_012.mp4", "cpu": 9.8, "mem_mb": 410,
                   "heavy": True, "age": 95, "n": 1},
                  {"pid": 6610, "kind": "ComfyUI", "what": "ComfyUI/main.py --lowvram", "cpu": 0.4, "mem_mb": 1450,
                   "heavy": False, "age": 7200, "n": 1},
                  {"pid": 7712, "kind": "Remotion", "mode": "studio", "what": "video-pipeline", "cpu": 1.2,
                   "mem_mb": 520, "heavy": False, "age": 3100, "n": 1}],
         "gate": [{"pid": 8840, "own": "D:\\videos\\shorts", "low": False, "age": 210, "cpu": 0, "mem_mb": 12}]}
    s["rendering"] = [w for w in s["work"] if w["heavy"]]
    g = {"name": "RTX 3070 Ti", "util": round(rnd(85, 97)), "vram_used": 7520, "vram_total": 8192, "vram_pct": 91.8,
         "temp": 71, "power": 238}
    oll = {"on": True, "models": [{"name": "qwen3:8b", "vram_mb": 5600, "until": "14:35"}]}
    accs = [{"acc": f"acc{i}@mail", "current": i == 2, "used": u, "left": 3 - u if r else 0, "ready": r,
             "until": None if r else t, "state": "ready" if r else "limit"}
            for i, (u, r, t) in enumerate([(3, False, "15:10"), (1, True, None), (0, True, None),
                                           (0, True, None), (3, False, "16:42")], 1)]
    br = {"t": time.strftime("%H:%M"), "accounts": accs, "ready": 3, "total": 5, "frames": 8, "next_free": "15:10",
          "all_free": "16:42", "error": None}
    d = build(s, g, ch, oll, br, now)
    d["host"] = "DEMO-PC"
    return d


# ---------------------------------------------------------------- HTTP
def allowed(ip):
    try:
        a = ipaddress.ip_address(ip)
        return a.is_loopback or a.is_private or a.is_link_local
    except ValueError:
        return False


_API_CACHE = (None, b"")


def api_bytes():
    """/api body, serialized once per data update: every chat's band asks every second."""
    global _API_CACHE
    if DEMO:
        return json.dumps(demo(), ensure_ascii=False).encode()
    data = COL.data
    if _API_CACHE[0] is not data:
        _API_CACHE = (data, json.dumps(data, ensure_ascii=False).encode())
    return _API_CACHE[1]


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def send(self, code, body, ctype):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if not allowed(self.client_address[0]):
            return self.send(403, b"only home network", "text/plain")
        path = self.path.split("?", 1)[0]
        if path == "/api":
            return self.send(200, api_bytes(), "application/json; charset=utf-8")
        if path == "/api/projects":
            data = {"ok": False, "on": False, "rev": 0} if DEMO else COL.board.public()
            return self.send(200, json.dumps(data, ensure_ascii=False).encode(), "application/json; charset=utf-8")
        if path in ("/", "/index.html"):
            return self.send(200, (HERE / "index.html").read_bytes(), "text/html; charset=utf-8")
        self.send(404, b"", "text/plain")


def lan_ip():
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("10.255.255.255", 1))
        return s.getsockname()[0]
    except OSError:
        return "?"


COL = None
DEMO = "--demo" in sys.argv


def main():
    global COL, PORT
    if "--port" in sys.argv:
        PORT = int(sys.argv[sys.argv.index("--port") + 1])
    try:
        psutil.Process().nice(psutil.BELOW_NORMAL_PRIORITY_CLASS if WIN else 10)
    except Exception:
        pass
    try:
        srv = ThreadingHTTPServer(("0.0.0.0" if CFG["lan"] else "127.0.0.1", PORT), Handler)
    except OSError:
        print(f"port {PORT} is busy: the monitor is probably running already")
        return
    if not DEMO:
        COL = Collector()
        threading.Thread(target=COL.loop, daemon=True).start()
    log(f"start http://127.0.0.1:{PORT}  lan http://{lan_ip()}:{PORT}{'  DEMO' if DEMO else ''}")
    print(f"http://127.0.0.1:{PORT}" + (f"   phone: http://{lan_ip()}:{PORT}" if CFG["lan"] else ""), flush=True)
    try:
        srv.serve_forever()
    finally:
        if COL:
            COL.chats.save()


if __name__ == "__main__":
    main()
