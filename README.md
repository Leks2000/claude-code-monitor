# Claude Code Monitor: live token usage and PC load dashboard

[![Python 3.9+](https://img.shields.io/badge/python-3.9%2B-3776AB?logo=python&logoColor=white)](https://www.python.org/)
[![Dependencies: psutil](https://img.shields.io/badge/dependencies-psutil%20only-2ea44f)](requirements.txt)
[![Platform: Windows](https://img.shields.io/badge/platform-Windows%2010%2F11-0078D6?logo=windows&logoColor=white)](#install)
[![License: MIT](https://img.shields.io/badge/license-MIT-yellow)](LICENSE)

**Claude Code Monitor** is a tiny local web dashboard that shows how many **Claude Code** sessions are running right now, how many **tokens** each session burned in the last hour, today and this week, and what your PC is doing: **CPU, RAM, GPU, VRAM, disks**, and which **Blender, ffmpeg, Remotion, ComfyUI or Ollama** jobs are running. One Python file plus one HTML page: CPU, GPU and RAM refresh every second, processes and sessions every 5 seconds, and the page opens on your phone.

![Claude Code Monitor dashboard: active Claude Code sessions with token usage, GPU and VRAM load, Blender and ffmpeg render jobs](docs/dashboard-en.png)

If you run several Claude Code chats in parallel and keep hitting the weekly limit, or you render video and 3D on the same machine, this page answers "who is eating my tokens and my GPU right now" at a glance.

## Features

**Claude Code sessions**
- Active sessions: a session counts as active when its log changed in the last 5 minutes.
- For each session: project folder, session title, the first line of the task, model, tokens in the last hour and today, and how many subagents are running.
- Top 5 sessions by tokens today and over the last 7 days.
- Token totals for the last hour, today and the week. Output tokens are shown separately.
- Duplicate messages are counted once. That covers a reply split into several log lines and history copied into a forked or resumed session.

**PC load**
- CPU, RAM, GPU utilization, VRAM, GPU temperature and power (`nvidia-smi`), free space on every drive.
- Top 8 processes by CPU and by memory, grouped by name like Task Manager. Memory is the private working set, the same number as the Task Manager "Memory" column.

**What is running**
- **Blender**: which `.blend` file, and whether it is a background render, a background script or an open window.
- **ffmpeg**: the output file.
- **Remotion**: a render, or Studio only.
- **Python**: which script is running (ComfyUI, your own pipelines).
- **Roblox Studio**: the place name, taken from the window title.
- **Ollama**: the loaded model and its VRAM use (`/api/ps`).
- **Render queue**: which heavy jobs run now and which `render_gate` scripts are waiting. The rules are in the config.

**Alerts** (red): VRAM above 90%, a drive with less than 20 GB free, more than 3 active Claude Code sessions. All thresholds can be changed.

**Light on resources**: about 0.4% CPU and 40 MB RAM on a 16-thread desktop at the 1-second refresh. Session logs are read incrementally from the last byte offset. The offsets live in `cache.json`, so after a restart the monitor does not read the logs again.

## Install

You need Python 3.9 or newer.

```bash
git clone https://github.com/Leks2000/claude-code-monitor.git
cd claude-code-monitor
pip install -r requirements.txt
python monitor.py
```

Open **http://127.0.0.1:8770**. The first start indexes the last 7 days of Claude Code logs, about a minute per 3 GB. After that it only reads new lines.

### Windows: run in the background and start with Windows

```powershell
powershell -ExecutionPolicy Bypass -File install_autostart.ps1
```

This puts a shortcut into your Startup folder, with no admin rights and no system settings changed, plus a **Claude Code Monitor** shortcut on the Desktop. `start_monitor.bat` starts the server with `pythonw`, so no console window stays open, and opens the page. To remove the autostart, press Win+R, type `shell:startup` and delete the shortcut.

### Open it on your phone

The server also listens on your home network. Open `http://<your-PC-IP>:8770` on a phone connected to the same Wi-Fi; the address is printed at start. Requests from public IP addresses get `403`. On the first start Windows may ask whether Python can accept connections: allow it for **private** networks only. To keep the dashboard local only, set `"lan": false`.

### Linux and macOS

The core works with psutil and nvidia-smi, but only Windows 10 was tested. Window titles (Blender file, Roblox Studio place) are read only on Windows.

## Configuration

Copy `config.example.json` to `config.json` and change what you need. Every key is optional.

| Key | Default | What it does |
|---|---|---|
| `port` | `8770` | HTTP port |
| `lan` | `true` | listen on the home network too (private IPs only) |
| `lang` | `"auto"` | `"en"`, `"ru"` or `"auto"` (browser language). The page also has an EN/RU switch |
| `projects_dir` | `~/.claude/projects` | where Claude Code keeps its session logs |
| `disks` | all fixed drives | for example `["C:\\", "D:\\"]` |
| `active_minutes` | `5` | a session is active if its log changed within this many minutes |
| `fast_seconds` | `1` | how often CPU, RAM and GPU refresh (processes and sessions stay at 5 s) |
| `limits` | `vram_pct 90, disk_gb 20, chats 3` | alert thresholds |
| `heavy` | Blender `-b`, ffmpeg encode, Remotion | `[process name, text in its command line]` pairs that count as a heavy render |
| `queue_script` | `"render_gate"` | Python scripts with this name are shown as the render queue |
| `project_markers` | `STATUS.md`, `HANDOFF.md`, `CLAUDE.md` | how to spot a project folder when a session runs in a parent folder |
| `bridge_cmd` | off | an optional status command polled once a minute (image-account limits) |

## How token counting works

Claude Code writes every session to `~/.claude/projects/<folder>/<session-id>.jsonl`, and every assistant message there has a `usage` block. The monitor adds up `input_tokens + cache_creation_input_tokens + cache_read_input_tokens + output_tokens` for each message ID into 5-minute buckets. Subagent logs (`<session-id>/subagents/*.jsonl`) are added to their parent session.

The total includes cache reads, so it gets large quickly: a 150k-token context read 300 times in an hour is 45M tokens. To see how much text the model actually wrote, look at the **Output** column.

## JSON API

`GET /api` returns everything the page shows, as JSON. Scripts and other agents can use it, for example to check VRAM before starting a render:

```bash
curl -s http://127.0.0.1:8770/api | python -c "import json,sys; d=json.load(sys.stdin); print(d['gpu']['vram_pct'], len(d['chats']['active']))"
```

`python monitor.py --demo --port 8771` serves made-up data. All screenshots here come from demo mode.

## Privacy

- Read only. The monitor never writes to Claude Code files and never sends anything to the internet.
- The page shows the first line of each prompt and the command lines of processes. Do not set `lan: true` on a network you do not trust.
- `cache.json` contains session titles and first prompt lines. It is in `.gitignore`.

## FAQ

**How do I see Claude Code token usage per session?**
Run the monitor and open the page. The sessions table shows tokens for the last hour and today for each session. The top 5 table ranks sessions over today and over the last 7 days.

**How is this different from ccusage?**
[ccusage](https://github.com/ryoppippi/ccusage) is a command-line tool that prints daily and monthly usage and cost reports. Claude Code Monitor is a live page, refreshed every second, that puts the sessions active right now next to GPU, VRAM, CPU and the render jobs on the same machine, and it opens on a phone.

**Can I watch it inside the Claude desktop app?**
Yes. Open `http://127.0.0.1:8770` in the app's built-in browser pane and keep it next to your chat.

**Does it work without an NVIDIA GPU?**
Yes. The GPU tile shows "—" and everything else works.

**Does it slow down renders?**
No. It runs at below-normal priority. GPU numbers come from one long-running `nvidia-smi` instead of a new process every second. Processes are polled every 5 seconds and the expensive memory numbers every 30 seconds.

## По-русски

Локальная панель: сколько чатов Claude Code активно, сколько токенов каждый потратил за час, сегодня и неделю, загрузка CPU, RAM, GPU, VRAM и дисков. Показывает, кто сейчас рендерит: Blender, ffmpeg, Remotion, ComfyUI, Ollama. Открывается с телефона. Запуск: `pip install -r requirements.txt`, затем `python monitor.py`, потом откройте http://127.0.0.1:8770. Чтобы монитор запускался вместе с Windows, выполните `install_autostart.ps1`. Язык переключается кнопкой EN/RU в шапке.

![Панель на русском](docs/dashboard-ru.png)

## License

[MIT](LICENSE)
