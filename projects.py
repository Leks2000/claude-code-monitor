"""Project board for the monitor: every STATUS.md under the configured roots, the plan, the channels table and
IDEAS.md / BACKLOG.md files. Read-only: files are only read, never written.

A full walk of the roots runs every `walk_minutes` (default 10); in between, the files already found are only
stat-ed every 30 s and re-read when their modification time changes. Served as /api/projects by monitor.py.

    python projects.py        print what the board sees (for checking the parser)
"""
import json
import os
import re
import threading
import time
import traceback
from pathlib import Path

DEFAULTS = {
    "status_roots": [],                # e.g. ["E:\\Projects", "D:\\Video"]; empty = the board is off
    "status_depth": 3,                 # folder levels below a root; docs/STATUS.md counts for its parent folder
    "status_skip": ["node_modules", ".git", "venv", ".venv", "env", "__pycache__", "site-packages", "dist",
                    "build", ".next", ".cache", "Library", "Temp", "obj"],
    "stale_days": 7,
    "walk_minutes": 10,
    # [substring of the lowercased path, section]; first match wins
    "sections": [["\\games\\", "games"], ["/games/", "games"], ["bot", "bots"], ["site", "sites"],
                 ["mobile", "apps"], ["app", "apps"]],
    "section_default": "other",
    "plan_file": "",
    "plan_now": "now",                 # heading (start) of the plan's current section
    "plan_log": "journal",             # heading (start) of the log; its first sub-heading is the latest entry
    "channels_file": "",
    "channels_section": "layout",      # heading (start) of the section holding the channels table
    "ideas_names": ["IDEAS.md", "BACKLOG.md"],
    "ideas_files": [],                 # extra idea files outside the roots
    # a folder with one of these is a project (for the "no STATUS.md" list)
    "project_markers_any": ["CLAUDE.md", "HANDOFF.md", "README.md", "package.json", "pyproject.toml",
                            "requirements.txt", ".git", "default.project.json", "ProjectSettings", "pubspec.yaml"],
    "no_status_ignore": [],            # folder names never listed as projects
}

# A label (heading, table cell or "Label:" line) -> which field it fills. Checked in this order.
LABELS = [
    ("waits", re.compile(r"^жд[её]т\s+(владельца|решения|ответа)|^waiting\s+(on|for)\s+(the\s+)?owner")),
    ("broken", re.compile(r"не\s+работает|^ограничения|^риски|^проблемы|^открыто|^не\s+выполнено|^not\s+working"
                          r"|^known\s+issues|^broken|^issues")),
    ("next", re.compile(r"^следующ|^дальше|^что\s+дальше|^next")),
    ("works", re.compile(r"^(что\s+)?работает|^works|^working|^что\s+готово")),
]
WAITS_ANY = re.compile(r"жд[её]т\s+(владельца|его\s+вердикта|вердикта|решения\s+владельца|ответа\s+владельца)"
                       r"|waiting\s+(on|for)\s+(the\s+)?owner", re.I)
EMPTY = {"", "-", "—", "–", "нет", "ничего", "none", "n/a", "no"}
HEAD = re.compile(r"^(#{1,6})\s+(.*?)\s*#*\s*$")
ROW = re.compile(r"^\s*\|(.+)\|\s*$")
INLINE = re.compile(r"^\s*(?:[-*]\s+)?\**\s*([^:*|]{3,40}?)\s*\**\s*:\s*\**\s*(.+)$")
LINK = re.compile(r"\[([^\]]+)\]\([^)]+\)")


def load_config(cfg):
    out = json.loads(json.dumps(DEFAULTS))
    for k in DEFAULTS:
        if k in cfg:
            out[k] = cfg[k]
    return out


def plain(s):
    """Markdown inline to plain text: links to their words, no bold, code ticks or html."""
    s = LINK.sub(r"\1", s)
    s = s.replace("**", "").replace("__", "").replace("`", "")
    s = re.sub(r"<br\s*/?>", " · ", s)
    return re.sub(r"\s+", " ", s).strip()


def label_of(text):
    t = plain(text).lower().strip(" :.—-")
    t = re.sub(r"\s*\(.*?\)\s*", " ", t).strip()
    for key, rx in LABELS:
        if rx.search(t):
            return key
    return None


def items(lines, limit=6):
    """Section lines to short items: bullets kept apart, wrapped paragraph lines joined."""
    out, cur = [], ""
    for ln in lines:
        s = ln.rstrip()
        if not s.strip():
            if cur:
                out.append(cur)
                cur = ""
            continue
        if ROW.match(s):
            cells = [plain(c) for c in ROW.match(s).group(1).split("|")]
            if all(re.fullmatch(r":?-{2,}:?", c.replace(" ", "")) or not c for c in cells):
                continue
            s = " — ".join(c for c in cells if c)
            if cur:
                out.append(cur)
            cur = ""
            out.append(s)
            continue
        m = re.match(r"^\s*(?:[-*+]|\d+[.)])\s+(.*)", s)
        if m:
            if cur:
                out.append(cur)
            cur = plain(m.group(1))
        else:
            cur = (cur + " " + plain(s)).strip()
    if cur:
        out.append(cur)
    out = [x for x in out if x and x.lower().strip(" .") not in EMPTY]
    return out[:limit]


def parse_status(text):
    """STATUS.md -> {title, works, broken, next, waits, summary}: headings, two-column tables and 'Label: text' lines."""
    lines = text.splitlines()
    got = {}
    title = ""
    # headings: the first section of each kind
    heads = [(i, len(m.group(1)), m.group(2)) for i, ln in enumerate(lines) if (m := HEAD.match(ln))]
    for n, (i, level, name) in enumerate(heads):
        if level == 1 and not title:
            title = plain(name)
        key = label_of(name)
        if not key or key in got:
            continue
        end = next((j for j, lv, _ in heads[n + 1:] if lv <= level), len(lines))
        val = items(lines[i + 1:end])
        if val:
            got[key] = val
        elif key == "broken":
            got[key] = []
    # table rows "| Label | value |" and lines "Label: value"
    for ln in lines[:400]:
        m = ROW.match(ln)
        if m:
            cells = [c.strip() for c in m.group(1).split("|")]
            if len(cells) >= 2:
                key = label_of(cells[0])
                if key and key not in got:
                    val = plain(" · ".join(c for c in cells[1:] if c.strip()))
                    got[key] = [] if val.lower().strip(" .") in EMPTY else [val]
            continue
        m = INLINE.match(ln)
        if m and not HEAD.match(ln):
            key = label_of(m.group(1))
            if key and key not in got:
                val = plain(m.group(2))
                got[key] = [] if val.lower().strip(" .") in EMPTY else [val]
    # the current part of the file (before a second top-level heading) is searched for "waits on the owner"
    tops = [i for i, lv, _ in heads if lv == 1]
    cur = "\n".join(lines[:tops[1]] if len(tops) > 1 else lines[:120])
    waits = got.get("waits") or []
    if not waits:
        hits = []
        for ln in cur.splitlines():
            if WAITS_ANY.search(ln) and not HEAD.match(ln):
                hits.append(plain(re.sub(r"^\s*(?:[-*+]|\d+[.)]|\|)\s*", "", ln)).strip(" |"))
        waits = hits[:2]
    summary = ""
    if not any(got.get(k) for k in ("works", "broken", "next")):
        body = [ln for ln in lines[1:60] if ln.strip() and not HEAD.match(ln) and not re.match(r"^\s*\|?\s*:?-{3}", ln)]
        summary = " ".join(plain(x.strip("| ")) for x in body[:3])[:400]
    return {"title": title, "works": got.get("works", []), "broken": got.get("broken", []),
            "next": got.get("next", []), "waits": waits, "summary": summary}


def section_text(text, start, sub_first=False):
    """The markdown of the first section whose heading starts with `start` (case-insensitive).
    With `sub_first`, only its first sub-section (the latest log entry)."""
    lines = text.splitlines()
    heads = [(i, len(m.group(1)), m.group(2)) for i, ln in enumerate(lines) if (m := HEAD.match(ln))]
    for n, (i, level, name) in enumerate(heads):
        if not plain(name).lower().startswith(start.lower()):
            continue
        end = next((j for j, lv, _ in heads[n + 1:] if lv <= level), len(lines))
        if sub_first:
            subs = [(j, lv, nm) for j, lv, nm in heads[n + 1:] if j < end and lv > level]
            if not subs:
                return None
            j0, lv0, nm0 = subs[0]
            j1 = next((j for j, lv, _ in heads if j > j0 and lv <= lv0), end)
            return {"title": plain(name), "head": plain(nm0), "md": "\n".join(lines[j0 + 1:j1]).strip()}
        return {"title": plain(name), "md": "\n".join(lines[i + 1:end]).strip()}
    return None


def idea_items(text):
    """IDEAS.md / BACKLOG.md -> [{t: heading, md: its text}] for every level-2 heading (level 3 when there are none)."""
    lines = text.splitlines()
    heads = [(i, len(m.group(1)), m.group(2)) for i, ln in enumerate(lines) if (m := HEAD.match(ln))]
    level = 2 if any(lv == 2 for _, lv, _ in heads) else 3
    out = []
    for n, (i, lv, name) in enumerate(heads):
        if lv != level:
            continue
        end = next((j for j, l2, _ in heads[n + 1:] if l2 <= lv), len(lines))
        out.append({"t": plain(name), "md": "\n".join(lines[i + 1:end]).strip()[:4000]})
    if not out:     # a plain list of bullets
        out = [{"t": x, "md": ""} for x in items(lines, limit=60)]
    return out


def read(path):
    try:
        return Path(path).read_text(encoding="utf-8", errors="replace")
    except OSError:
        return None


class Board:
    """Keeps the parsed board; `data` is what /api/projects answers."""

    def __init__(self, cfg):
        self.cfg = load_config(cfg)
        self.on = bool(self.cfg["status_roots"])
        self.files = {}          # path -> (mtime, parsed)
        self.status = []         # STATUS.md paths found by the last walk
        self.ideas = []          # idea file paths
        self.bare = []           # project folders without STATUS.md
        self.walk_t = 0
        self.walk_ms = 0
        self.rev = 0
        self.data = {"ok": False, "on": self.on, "rev": 0}
        self.lock = threading.Lock()

    # ------------------------------------------------------------ walk
    def walk(self):
        c = self.cfg
        skip = {s.lower() for s in c["status_skip"]}
        ignore = {s.lower() for s in c["no_status_ignore"]}
        idea_names = {s.lower() for s in c["ideas_names"]}
        markers = {s.lower() for s in c["project_markers_any"]}
        status, ideas, cand = [], [], []
        for root in c["status_roots"]:
            root = os.path.normpath(root)
            base = root.count(os.sep)
            for dp, dns, fns in os.walk(root):
                depth = dp.count(os.sep) - base
                low = {f.lower() for f in fns} | {d.lower() for d in dns}
                keep = [d for d in dns if d.lower() not in skip and not d.startswith(".")]
                # docs/STATUS.md one level deeper than the limit still belongs to its project
                dns[:] = keep if depth < c["status_depth"] else [d for d in keep if d.lower() == "docs"]
                is_docs_extra = depth > c["status_depth"]
                for f in fns:
                    fl = f.lower()
                    if fl == "status.md":
                        status.append(os.path.join(dp, f))
                    elif fl in idea_names and not is_docs_extra:
                        ideas.append(os.path.join(dp, f))
                if 1 <= depth <= c["status_depth"] and not is_docs_extra and low & markers \
                        and os.path.basename(dp).lower() not in ignore:
                    cand.append(dp)
        for f in c["ideas_files"]:
            if os.path.isfile(f) and f not in ideas:
                ideas.append(f)
        # folders that own a STATUS.md: its folder, or the folder above docs/
        owners = {self.owner(p) for p in status}
        bare = []
        for d in sorted(cand, key=lambda x: (x.count(os.sep), x.lower())):
            dl = d.lower() + os.sep
            if any(o.lower() == d.lower() or o.lower().startswith(dl) or dl.startswith(o.lower() + os.sep)
                   for o in owners):
                continue                       # has a STATUS.md, is inside such a project, or holds one
            if any(dl.startswith(b.lower() + os.sep) for b in bare):
                continue                       # a sub-folder of a project already listed
            bare.append(d)
        with self.lock:
            self.status, self.ideas, self.bare = status, ideas, bare

    @staticmethod
    def owner(path):
        d = os.path.dirname(path)
        return os.path.dirname(d) if os.path.basename(d).lower() == "docs" else d

    def root_of(self, d):
        for r in self.cfg["status_roots"]:
            r = os.path.normpath(r)
            if d.lower().startswith(r.lower() + os.sep) or d.lower() == r.lower():
                return r
        return None

    def section(self, d):
        low = d.lower().replace("/", "\\") + "\\"
        for sub, name in self.cfg["sections"]:
            if sub.lower() in low:
                return name
        return self.cfg["section_default"]

    # ------------------------------------------------------------ files
    def parsed(self, path, fn):
        """Parse `path` with `fn`, again only when its mtime changed."""
        try:
            mt = os.path.getmtime(path)
        except OSError:
            self.files.pop(path, None)
            return None, None
        old = self.files.get(path)
        if old and old[0] == mt:
            return mt, old[1]
        text = read(path)
        if text is None:
            return mt, None
        try:
            val = fn(text)
        except Exception:
            val = None
        self.files[path] = (mt, val)
        return mt, val

    def refresh(self):
        """Re-read what changed and rebuild `data`; a new `rev` only when something did."""
        c = self.cfg
        now = time.time()
        if now - self.walk_t > c["walk_minutes"] * 60:
            t0 = time.time()
            self.walk()
            self.walk_t = time.time()
            self.walk_ms = round((self.walk_t - t0) * 1000)
        with self.lock:
            status, ideas, bare = list(self.status), list(self.ideas), list(self.bare)
        projects = []
        for p in status:
            mt, st = self.parsed(p, parse_status)
            if st is None:
                continue
            d = self.owner(p)
            root = self.root_of(d) or os.path.dirname(d)
            rel = os.path.relpath(d, root)
            parts = rel.split(os.sep)
            age_d = (now - mt) / 86400
            broken = bool(st["broken"])
            projects.append({
                "name": parts[-1], "parent": " / ".join(parts[:-1]), "path": p, "section": self.section(d),
                "mtime": round(mt), "date": time.strftime("%d.%m", time.localtime(mt)), "age_days": round(age_d, 1),
                "stale": age_d > c["stale_days"], "warn": broken or bool(st["waits"]), **st})
        order = [s for _, s in c["sections"]]
        projects.sort(key=lambda x: (order.index(x["section"]) if x["section"] in order else 99, -x["mtime"]))
        plan = chans = None
        if c["plan_file"]:
            _, plan = self.parsed(c["plan_file"], lambda t: {
                "now": section_text(t, c["plan_now"]), "last": section_text(t, c["plan_log"], sub_first=True)})
        if c["channels_file"]:
            _, chans = self.parsed(c["channels_file"], lambda t: section_text(t, c["channels_section"]))
        idea_list = []
        for p in ideas:
            mt, heads = self.parsed(p, idea_items)
            if heads is None:
                continue
            d = os.path.dirname(p)
            root = self.root_of(d)
            idea_list.append({"name": os.path.basename(p), "where": os.path.relpath(d, root) if root else d,
                              "path": p, "date": time.strftime("%d.%m", time.localtime(mt)), "items": heads[:40]})
        bare_list = []
        for d in bare:
            root = self.root_of(d) or os.path.dirname(d)
            try:
                mt = max((e.stat().st_mtime for e in os.scandir(d)), default=os.path.getmtime(d))
            except OSError:
                continue
            parts = os.path.relpath(d, root).split(os.sep)
            bare_list.append({"name": parts[-1], "parent": " / ".join(parts[:-1]), "path": d,
                              "section": self.section(d), "date": time.strftime("%d.%m", time.localtime(mt)),
                              "mtime": round(mt)})
        bare_list.sort(key=lambda x: -x["mtime"])
        body = {"projects": projects, "plan": plan, "channels": chans, "ideas": idea_list, "bare": bare_list,
                "stale_days": c["stale_days"]}
        sig = json.dumps(body, ensure_ascii=False, sort_keys=True)
        old = self.data.get("_sig")
        if sig != old:
            self.rev += 1
        self.data = {"ok": True, "on": True, "rev": self.rev, "time": time.strftime("%H:%M:%S"),
                     "walk_ms": self.walk_ms, "walked": time.strftime("%H:%M", time.localtime(self.walk_t)),
                     **body, "_sig": sig}

    def public(self):
        return {k: v for k, v in self.data.items() if k != "_sig"}

    def loop(self, log=print):
        if not self.on:
            return
        while True:
            try:
                self.refresh()
            except Exception:
                log(traceback.format_exc())
            time.sleep(30)


if __name__ == "__main__":
    import sys
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    here = Path(__file__).resolve().parent
    try:
        cfg = json.loads((here / "config.json").read_text(encoding="utf-8"))
    except FileNotFoundError:
        cfg = {}
    b = Board(cfg)
    if not b.on:
        print("status_roots is empty in config.json: the board is off")
        raise SystemExit
    b.refresh()
    d = b.public()
    print(f"walk {d['walk_ms']} ms, {len(d['projects'])} projects, {len(d['bare'])} without STATUS.md, "
          f"{len(d['ideas'])} idea files")
    for p in d["projects"]:
        flag = "!" if p["warn"] else ("~" if p["stale"] else " ")
        print(f"{flag} [{p['section']}] {p['parent'] + ' / ' if p['parent'] else ''}{p['name']}  {p['date']}")
        for k in ("works", "broken", "waits", "next"):
            if p[k]:
                print(f"     {k}: {p[k][0][:150]}" + (f"  (+{len(p[k]) - 1})" if len(p[k]) > 1 else ""))
        if p["summary"]:
            print(f"     summary: {p['summary'][:150]}")
    print("-- without STATUS.md:", ", ".join(f"{x['parent'] + '/' if x['parent'] else ''}{x['name']}" for x in d["bare"]))
    for i in d["ideas"]:
        print(f"-- ideas {i['where']}\\{i['name']} {i['date']}: {len(i['items'])} items")
    if d["plan"]:
        print("-- plan now:", (d["plan"]["now"] or {}).get("title"), "| last:", (d["plan"]["last"] or {}).get("head"))
    if d["channels"]:
        print("-- channels:", d["channels"]["title"], len(d["channels"]["md"]), "chars")
