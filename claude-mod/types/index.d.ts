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
  out_day: number
  ago: number
  agents: number
}

export type Proc = { name: string; n: number; cpu: number; mem_mb: number }

export type Job = {
  pid: number
  kind: string
  mode?: string
  what: string
  cpu: number
  mem_mb: number
  heavy: boolean
  age: number
  n: number
}

export type Alert = { k: 'vram' | 'disk' | 'chats'; v: number; d?: string }

/** The trimmed /api answer the pane draws. */
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
    power: number | null
    name: string
  } | null
  disks: { d: string; free_gb: number; total_gb: number }[]
  limits: { vram_pct: number; disk_gb: number; chats: number }
  active: Chat[]
  top_day: Chat[]
  total: { hour: number; day: number; week: number; out_day: number }
  work: Job[]
  gate: { pid: number; own: string; age: number }[]
  rendering: number
  ollama: { name: string; vram_mb: number }[] | null
  bridge: { ready: number; total: number; frames: number; next_free: string | null } | null
  top_cpu: Proc[]
  top_mem: Proc[]
  alerts: Alert[]
}

/** Last poll: the snapshot, or why there is none. */
export type Feed = { snap: Snap | null; error: string | null; at: number }

/** The last ~40 one-second samples, oldest first, for the band's graphs. */
export type Hist = { cpu: number[]; gpu: number[]; vram: number[]; ram: number[] }

declare module 'claude-code' {
  interface PluginState {
    'pc-monitor': { feed: Feed; bandOff: boolean; expanded: boolean; hist: Hist }
  }
}
