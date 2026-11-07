/** One Claude Code session as the monitor's /api reports it. */
export type Chat = {
  sid: string
  project: string
  title: string | null
  first: string
  model: string
  hour: number
  day: number
  week: number
  ago: number
  agents: number
}

export type Proc = { name: string; n: number; cpu: number; mem_mb: number }

export type Job = {
  pid: number
  kind: string
  mode: string
  what: string
  cpu: number
  mem_mb: number
  heavy: boolean
  age: number
  n: number
}

export type Alert = { k: string; v: number; d: string }

/** The /api answer, cut to what the "PC now" tab draws. */
export type Snap = {
  time: string
  cpu: number
  ram_pct: number
  ram_used_gb: number
  ram_total_gb: number
  gpu: {
    util: number
    vram_pct: number
    vram_used: number
    vram_total: number
    temp: number
    power: number
    name: string
  } | null
  gpuError: string
  disks: { d: string; free_gb: number; total_gb: number }[]
  limits: { vram_pct: number; disk_gb: number; chats: number }
  active: Chat[]
  top_day: Chat[]
  top_week: Chat[]
  total: { hour: number; day: number; week: number }
  work: Job[]
  gate: { pid: number; own: string; age: number }[]
  rendering: number
  ollama: { name: string; vram_mb: number }[] | null
  bridge: {
    ready: number
    total: number
    frames: number
    next_free: string
    all_free: string
    at: string
    error: string
  } | null
  top_cpu: Proc[]
  top_mem: Proc[]
  alerts: Alert[]
}

/** Last poll of /api: the last good snapshot, the last error and how many polls in a row failed. */
export type Feed = { snap: Snap | null; error: string | null; at: number; fails: number }

/** One STATUS.md as /api/projects reports it. */
export type Project = {
  name: string
  parent: string
  path: string
  section: string
  date: string
  age_days: number
  stale: boolean
  warn: boolean
  title: string
  works: string[]
  broken: string[]
  next: string[]
  waits: string[]
  summary: string
}

export type MdPart = { title: string; head: string; md: string } | null

export type IdeaFile = {
  name: string
  where: string
  path: string
  date: string
  items: { t: string; md: string }[]
}

export type Bare = { name: string; parent: string; path: string; section: string; date: string; mtime: number }

/** The /api/projects answer. */
export type Board = {
  rev: number
  time: string
  walked: string
  stale_days: number
  projects: Project[]
  plan: { now: MdPart; last: MdPart } | null
  channels: MdPart
  ideas: IdeaFile[]
  bare: Bare[]
}

export type BoardFeed = { board: Board | null; error: string | null; at: number; fails: number }

export type Tab = 'projects' | 'pc'
export type Sub = 'status' | 'plan' | 'ideas' | 'bare'
/** Which project cards the status list shows. */
export type Filter = 'all' | 'waits' | 'broken' | 'stale'

declare module 'claude-code' {
  interface PluginState {
    'side-panel': {
      feed: Shaped<Feed>
      board: Shaped<BoardFeed>
      tab: Tab
      sub: Sub
      filter: Filter
      /** The expanded card or idea, by its path (and `#n` for an idea), or "" for none. */
      open: string
    }
  }
}
