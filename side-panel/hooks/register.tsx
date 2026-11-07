import { atom, read, update } from 'claude-code'
import type { ElementTable, EngineInterface, Register } from 'claude-code'

import type { Board, BoardFeed, Chat, Feed, Filter, Job, Project, Snap, Sub, Tab } from '../types'
import { cards } from './graph'
import type { Hist } from './graph'
import { LANGS } from './i18n'
import type { Words } from './i18n'

// The pane beside the chat: tab "Projects" (STATUS.md of every project, the plan, channels, ideas) and tab
// "PC now" (chats and tokens, load, who is busy with what). Both read the local monitor server (monitor.py):
// /api every 5 s and /api/projects every 30 s. The server does the heavy lifting; files are only read.
// Settings come from the plugin's userConfig (plugin.json): server_url, start_command, lang.
let BASE = 'http://127.0.0.1:8770'
let START = ''
let T: Words = LANGS.en!
const PANE = 'side-panel'
const PC_MS = 5000
const BOARD_MS = 30000
const HIST_LEN = 36 // 3 minutes of 5-second samples

const EMPTY: Feed = { snap: null, error: null, at: 0, fails: 0 }
const NO_BOARD: BoardFeed = { board: null, error: null, at: 0, fails: 0 }
const FEED = atom({ plugin: 'side-panel', key: 'feed' } as const, EMPTY, { shape: 'feed-2' })
const BOARD = atom({ plugin: 'side-panel', key: 'board' } as const, NO_BOARD, { shape: 'board-2' })
// A busy PC (a render at 100% CPU) makes the low-priority server answer late now and then: "no link" is said
// only after this many failed polls in a row.
const PC_FAILS = 3
const BOARD_FAILS = 2
const TAB = atom({ plugin: 'side-panel', key: 'tab' } as const, 'projects' as Tab)
const SUB = atom({ plugin: 'side-panel', key: 'sub' } as const, 'status' as Sub)
const OPEN = atom({ plugin: 'side-panel', key: 'open' } as const, '')
const FILTER = atom({ plugin: 'side-panel', key: 'filter' } as const, 'all' as Filter)


const tok = (n: number): string =>
  n >= 1e9 ? (n / 1e9).toFixed(2) + 'B' : n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? Math.round(n / 1e3) + 'k' : String(n || 0)
const ago = (s: number): string =>
  s < 60 ? T.ago(s, 's') : s < 3600 ? T.ago(Math.round(s / 60), 'm') : s < 86400 ? T.ago(Math.round(s / 3600), 'h') : T.ago(Math.round(s / 86400), 'd')
const gb = (mb: number): string => (mb >= 1024 ? (mb / 1024).toFixed(1) + ' ' + T.gb : Math.round(mb) + ' ' + T.mb)
const bar = (pct: number, cells = 10): string => {
  const full = Math.max(0, Math.min(cells, Math.round((pct / 100) * cells)))
  return '█'.repeat(full) + '░'.repeat(cells - full)
}
const cut = (s: string, n: number): string => (s.length > n ? s.slice(0, Math.max(1, n - 1)).trimEnd() + '…' : s)
const num = (v: unknown, d = 0): number => (typeof v === 'number' && isFinite(v) ? v : d)
const str = (v: unknown): string => (typeof v === 'string' ? v : '')

/** The /api answer, cut to what the tab draws; every field defaulted, so a server change draws gaps, not errors. */
function trim(d: any): Snap {
  const s = d.sys ?? {}
  const g = d.gpu && !d.gpu.error && typeof d.gpu.util === 'number' ? d.gpu : null
  const chat = (r: any): Chat => ({
    sid: str(r.sid),
    project: str(r.project) || '?',
    title: r.title ? str(r.title) : null,
    first: str(r.first),
    model: str(r.model),
    hour: num(r.hour),
    day: num(r.day),
    week: num(r.week),
    ago: num(r.ago),
    agents: num(r.agents),
  })
  const proc = (p: any) => ({ name: str(p.name), n: num(p.n, 1), cpu: num(p.cpu), mem_mb: num(p.mem_mb) })
  const br = d.bridge
  const ch = d.chats ?? {}
  return {
    time: str(d.time),
    cpu: num(s.cpu),
    ram_pct: num(s.ram_pct),
    ram_used_gb: num(s.ram_used_gb),
    ram_total_gb: num(s.ram_total_gb),
    gpu: g
      ? {
          util: num(g.util),
          vram_pct: num(g.vram_pct),
          vram_used: num(g.vram_used),
          vram_total: num(g.vram_total),
          temp: num(g.temp),
          power: num(g.power),
          name: str(g.name),
        }
      : null,
    gpuError: d.gpu?.error ? str(d.gpu.error) : '',
    disks: (s.disks ?? []).map((k: any) => ({ d: str(k.d), free_gb: num(k.free_gb), total_gb: num(k.total_gb) })),
    limits: {
      vram_pct: num(d.limits?.vram_pct, 90),
      disk_gb: num(d.limits?.disk_gb, 20),
      chats: num(d.limits?.chats, 3),
    },
    active: (ch.active ?? []).map(chat),
    top_day: (ch.top_day ?? []).slice(0, 5).map(chat),
    top_week: (ch.top_week ?? []).slice(0, 5).map(chat),
    total: { hour: num(ch.total?.hour), day: num(ch.total?.day), week: num(ch.total?.week) },
    work: (s.work ?? []).map(
      (w: any): Job => ({
        pid: num(w.pid),
        kind: str(w.kind),
        mode: str(w.mode),
        what: str(w.what),
        cpu: num(w.cpu),
        mem_mb: num(w.mem_mb),
        heavy: !!w.heavy,
        age: num(w.age),
        n: num(w.n, 1),
      }),
    ),
    gate: (s.gate ?? []).map((x: any) => ({ pid: num(x.pid), own: str(x.own), age: num(x.age) })),
    rendering: (s.rendering ?? []).length,
    ollama: d.ollama?.on
      ? (d.ollama.models ?? []).map((m: any) => ({ name: str(m.name), vram_mb: num(m.vram_mb) }))
      : null,
    bridge: br
      ? {
          ready: num(br.ready),
          total: num(br.total),
          frames: num(br.frames),
          next_free: str(br.next_free),
          all_free: str(br.all_free),
          at: str(br.t),
          error: str(br.error),
        }
      : null,
    top_cpu: (s.top_cpu ?? []).slice(0, 8).map(proc),
    top_mem: (s.top_mem ?? []).slice(0, 8).map(proc),
    alerts: (d.alerts ?? []).map((a: any) => ({ k: str(a.k), v: num(a.v), d: str(a.d) })),
  }
}

function alertText(a: Snap['alerts'][number]): string {
  if (a.k === 'vram') return T.alertVram(Math.round(a.v))
  if (a.k === 'disk') return T.alertDisk(a.d, Math.round(a.v))
  if (a.k === 'chats') return T.alertChats(a.v)
  return `${a.k} ${a.v}`
}

const errText = (err: unknown): string => {
  const m = err instanceof Error ? err.message : String(err)
  if (/ECONNREFUSED|refused/i.test(m)) return T.notRunning
  if (/timed? ?out|abort|connect|fetch failed|socket/i.test(m)) return T.notAnswering
  return m
}

// The load history lives in the module: a reload starts the graph over, nothing else is lost.
let hist: Hist = { cpu: [], gpu: [], vram: [], ram: [] }

async function pollPc($: EngineInterface): Promise<void> {
  let f: Feed
  try {
    const r = await $.http.fetch(BASE + '/api')
    if (!r.ok) throw new Error('HTTP ' + r.status)
    const d = JSON.parse(r.text)
    if (!d.ok) throw new Error(T.stillCollecting)
    const s = trim(d)
    const push = (a: number[], v: number) => [...a, v].slice(-HIST_LEN)
    hist = {
      cpu: push(hist.cpu, s.cpu),
      gpu: push(hist.gpu, s.gpu?.util ?? 0),
      vram: push(hist.vram, s.gpu?.vram_pct ?? 0),
      ram: push(hist.ram, s.ram_pct),
    }
    f = { snap: s, error: null, at: Date.now(), fails: 0 }
  } catch (err) {
    const old = await read($, FEED)
    f = { ...old, error: errText(err), fails: (old.fails ?? 0) + 1 }
    // a single late answer changes nothing on screen
    if (old.snap && f.fails < PC_FAILS) return
  }
  await update($, FEED, () => f)
}

/** /api/projects; the state is written only when the board changed (its `rev`) or the error did. */
async function pollBoard($: EngineInterface): Promise<void> {
  const old = await read($, BOARD)
  try {
    const r = await $.http.fetch(BASE + '/api/projects')
    if (!r.ok) throw new Error('HTTP ' + r.status)
    const d = JSON.parse(r.text)
    if (!d.on) throw new Error(T.noRoots)
    if (!d.ok) throw new Error(T.stillReading)
    if (old.board && old.board.rev === d.rev && !old.error && !old.fails) return
    const board: Board = {
      rev: num(d.rev),
      time: str(d.time),
      walked: str(d.walked),
      stale_days: num(d.stale_days, 7),
      projects: d.projects ?? [],
      plan: d.plan ?? null,
      channels: d.channels ?? null,
      ideas: d.ideas ?? [],
      bare: d.bare ?? [],
    }
    await update($, BOARD, () => ({ board, error: null, at: Date.now(), fails: 0 }))
  } catch (err) {
    const e = errText(err)
    const fails = (old.fails ?? 0) + 1
    if (old.board && fails < BOARD_FAILS) {
      await update($, BOARD, b => ({ ...b, fails }))
      return
    }
    if (old.error === e && old.fails >= BOARD_FAILS) return
    await update($, BOARD, b => ({ ...b, error: e, fails }))
  }
}

/** Opens the pane; answers what the engine said (the `panel` tool shows it). */
async function openAndNote($: EngineInterface, why: string): Promise<unknown> {
  const opened = await $.ui.open({ id: PANE, title: T.title }).catch(err => ({ error: String(err) }))
  const panes = await $.ui.panes().catch(() => [])
  return { at: new Date(await $.clock.now()).toISOString(), why, opened, panes }
}

async function openPane($: EngineInterface, tab?: Tab): Promise<unknown> {
  if (tab) {
    await update($, TAB, () => tab)
    await $.store.set('tab', tab)
  }
  return openAndNote($, 'asked')
}

/** Runs the start_command setting: a .bat / .cmd through cmd, anything else through the shell. */
function startServer($: EngineInterface): boolean {
  if (!START) return false
  const argv = /\.(bat|cmd)(\s|$)|^[a-z]:\\/i.test(START) ? ['cmd', '/c', START] : ['sh', '-c', START]
  void $.process.run(argv).catch(() => undefined)
  return true
}

export const register: Register = (on, options) => {
  const url = typeof options.server_url === 'string' ? options.server_url.trim().replace(/\/+$/, '') : ''
  BASE = url || BASE
  START = typeof options.start_command === 'string' ? options.start_command.trim() : ''
  T = LANGS[typeof options.lang === 'string' ? options.lang.trim().toLowerCase() : ''] ?? LANGS.en!

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'panel', description: T.cmdDesc })
    const tab = await $.store.get('tab')
    if (tab === 'projects' || tab === 'pc') await update($, TAB, () => tab)
    void pollPc($)
    void pollBoard($)
    $.clock.every(PC_MS, () => pollPc($))
    $.clock.every(BOARD_MS, () => pollBoard($))
    // The panel opens on demand only (/panel): nothing is opened at the start of a chat.
    await $.tool.register({
      name: 'panel',
      description: T.toolDesc,
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['open', 'close', 'status'] },
          tab: { type: 'string', enum: ['projects', 'pc'] },
        },
        required: ['action'],
      },
    }).catch(() => undefined)

    return next(e)
  })

  on('tool.call', { tool: 'mcp__side-panel__panel' }, async ($, e) => {
    const input = e as unknown as { action?: string; tab?: string }
    const say = (v: unknown) => ({ result: JSON.stringify(v, null, 1) })
    if (input.action === 'close') {
      await $.ui.close({ id: PANE })
      return say({ closed: true, panes: await $.ui.panes() })
    }
    if (input.action === 'open') {
      const tab = input.tab === 'pc' || input.tab === 'projects' ? input.tab : undefined
      return say(await openPane($, tab))
    }
    return say({ panes: await $.ui.panes() })
  })

  on('command.run', { command: 'panel' }, async ($, e) => {
    const arg = (e.args ?? '').trim().toLowerCase()
    if (arg === 'close' || arg === 'off') {
      await $.ui.close({ id: PANE })
      return { text: T.closed }
    }
    const tab: Tab | undefined = arg === 'pc' || arg === 'пк' ? 'pc' : arg.startsWith('proj') || arg === 'проекты' ? 'projects' : undefined
    await openPane($, tab)
    void pollBoard($)
    return { text: T.opened }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const ui = $.ui.resolve(e)
    const { Box, Text, Button, Markdown } = ui
    const Svg = e.surface === 'terminal' ? undefined : (ui as Partial<ElementTable<'desktop'>>).Svg
    const cols = Math.max(28, e.props.bodyColumns ?? 48)
    const tab = await read($, TAB)
    const { snap } = await read($, FEED)
    const alerts = snap?.alerts ?? []

    const setTab = (t: Tab) => () => {
      void update($, TAB, () => t)
      void $.store.set('tab', t)
    }
    const close = () => {
      void $.ui.close({ id: PANE })
    }
    const onStart = () => {
      if (!startServer($)) {
        $.ui.toast(T.startHint)
        return
      }
      $.ui.toast(T.starting)
      void $.clock.after(5000, () => {
        void pollPc($)
        void pollBoard($)
      })
    }
    const head = (t: string, bad = false) => (
      <Text bold color={bad ? 'error' : 'subtle'}>
        {t}
      </Text>
    )
    const noServer = (why: string | null) => (
      <Box flexDirection="column" gap={1}>
        <Text color="warning">{T.noData(why ?? T.firstAnswer)}</Text>
        <Text dimColor>{T.serverAt(BASE)}</Text>
        <Button key="start" variant="primary" label={T.startServer} onPress={onStart} />
      </Box>
    )

    // The surface draws its own close mark on the pane, so the tabs row holds the two tabs alone; the terminal
    // gets a close button of the mod's, its close key being less known.
    const tabs = (
      <Box flexDirection="row" justifyContent="space-between" alignItems="center" gap={1}>
        <Box flexDirection="row" gap={1}>
          <Button key="tab-projects" variant={tab === 'projects' ? 'primary' : 'secondary'} label={T.tabProjects} onPress={setTab('projects')} />
          <Button
            key="tab-pc"
            variant={tab === 'pc' ? 'primary' : 'secondary'}
            label={alerts.length ? T.tabPc + ' ⚠' : T.tabPc}
            onPress={setTab('pc')}
          />
        </Box>
        {e.surface === 'terminal' && <Button key="close" label="✕" onPress={close} />}
      </Box>
    )

    // ------------------------------------------------------------------ PC now
    if (tab === 'pc') {
      const f = await read($, FEED)
      const s = f.snap
      if (!s) return <Box flexDirection="column" gap={1}>{tabs}{noServer(f.error)}</Box>
      const L = s.limits
      const chatsBad = s.active.length > L.chats
      const metric = (label: string, pct: number, tail: string, bad = false) => (
        <Box flexDirection="row" gap={1}>
          <Text tabular>{label.padEnd(4)}</Text>
          <Text color={bad ? 'error' : 'suggestion'} mono>
            {bar(pct)}
          </Text>
          <Text tabular bold={bad} color={bad ? 'error' : undefined}>
            {String(Math.round(pct)).padStart(3)}%
          </Text>
          <Text dimColor wrap="truncate-end">
            {tail}
          </Text>
        </Box>
      )
      const chatRow = (c: Chat, right: string) => (
        <Box flexDirection="column">
          <Box flexDirection="row" justifyContent="space-between" gap={1}>
            <Text color="claude" bold wrap="truncate-end">
              {c.project}
              {c.agents ? <Text dimColor>{T.agents(c.agents)}</Text> : ''}
            </Text>
            <Text tabular dimColor>
              {right}
            </Text>
          </Box>
          <Text dimColor wrap="truncate-end">
            {cut(c.first || c.title || '', cols * 2)}
          </Text>
        </Box>
      )
      // Two rows: what runs and its numbers, then its file, cut from the left so the file name stays.
      const job = (w: Job) => (
        <Box flexDirection="column">
          <Box flexDirection="row" justifyContent="space-between" gap={1}>
            <Text wrap="truncate-end" color={w.heavy ? 'warning' : undefined} bold={w.heavy}>
              {w.heavy ? '● ' : ''}
              {w.kind}
              {w.n > 1 ? ` ×${w.n}` : ''}
              {w.mode ? <Text dimColor> · {T.modes[w.mode] ?? w.mode}</Text> : ''}
            </Text>
            <Text tabular dimColor>
              {Math.round(w.cpu)}% · {gb(w.mem_mb)} · {ago(w.age)}
            </Text>
          </Box>
          {w.what && (
            <Text dimColor wrap="truncate-start">
              {w.what}
            </Text>
          )}
        </Box>
      )
      const g = s.gpu
      const br = s.bridge
      return (
        <Box flexDirection="column" gap={1}>
          {tabs}
          <Box flexDirection="column">
            <Text dimColor>
              {T.updated(s.time)}
              {f.error ? T.offline(f.error) : ''}
            </Text>
            {alerts.length > 0 && (
              <Text color="error" bold>
                ⚠ {alerts.map(alertText).join(' · ')}
              </Text>
            )}
          </Box>

          <Box flexDirection="column">
            {head(T.chatsHead(s.active.length), chatsBad)}
            <Text dimColor>
              {T.tokens(tok(s.total.hour), tok(s.total.day), tok(s.total.week))}
            </Text>
            {s.active.length === 0 && <Text dimColor>{T.noActive}</Text>}
            {s.active.map(c => chatRow(c, T.perHour(tok(c.hour), tok(c.day))))}
          </Box>

          <Box flexDirection="column">
            {head(T.load)}
            {Svg ? (
              <Svg
                source={cards(s, hist, Math.min(560, cols * 7.6), HIST_LEN, T)}
                alt={`CPU ${Math.round(s.cpu)}%, GPU ${Math.round(g?.util ?? 0)}%, VRAM ${Math.round(g?.vram_pct ?? 0)}%, RAM ${Math.round(s.ram_pct)}%`}
              />
            ) : (
              <Box flexDirection="column">
                {metric('CPU', s.cpu, '')}
                {g && metric('GPU', g.util, `${g.temp}°C`)}
                {g && metric('VRAM', g.vram_pct, `${(g.vram_used / 1024).toFixed(1)}/${(g.vram_total / 1024).toFixed(0)} ${T.gb}`, g.vram_pct > L.vram_pct)}
                {metric('RAM', s.ram_pct, `${s.ram_used_gb}/${s.ram_total_gb} ${T.gb}`, s.ram_pct > 90)}
              </Box>
            )}
            {!g && <Text color="warning">{T.gpuMissing(s.gpuError)}</Text>}
            <Text tabular>
              <Text dimColor>{T.free}</Text>
              {s.disks.map((k, i) => (
                <Text color={k.free_gb < L.disk_gb ? 'error' : undefined} bold={k.free_gb < L.disk_gb}>
                  {i ? ' · ' : ''}
                  {k.d}: {Math.round(k.free_gb)} {T.gb}
                </Text>
              ))}
            </Text>
          </Box>

          <Box flexDirection="column">
            {head(T.top8)}
            {s.top_cpu.map(p => (
              <Box flexDirection="row" justifyContent="space-between" gap={1}>
                <Text wrap="truncate-end">
                  {p.name.replace(/\.exe$/i, '')}
                  {p.n > 1 ? <Text dimColor> ×{p.n}</Text> : ''}
                </Text>
                <Text tabular>
                  {String(Math.round(p.cpu)).padStart(3)}% <Text dimColor>· {gb(p.mem_mb)}</Text>
                </Text>
              </Box>
            ))}
            <Text dimColor wrap="wrap">
              {T.mostMemory}
              {s.top_mem
                .slice(0, 4)
                .map(p => `${p.name.replace(/\.exe$/i, '')} ${gb(p.mem_mb)}`)
                .join(' · ')}
            </Text>
          </Box>

          <Box flexDirection="column">
            {head(T.busy)}
            {s.work.length === 0 && <Text dimColor>{T.nothingRunning}</Text>}
            {s.work.slice(0, 10).map(job)}
            <Text dimColor wrap="wrap">
              {T.queue}
              {s.rendering ? T.rendering(s.rendering) : T.queueFree}
              {s.gate.length ? T.waiting(s.gate.length) : ''}
            </Text>
            {s.gate.map(x => (
              <Text dimColor wrap="truncate-start">
                {'  '}⏳ {ago(x.age)} · {x.own || 'pid ' + x.pid}
              </Text>
            ))}
            <Text dimColor>
              {T.ollama}
              {s.ollama ? (s.ollama.length ? s.ollama.map(m => `${m.name} ${gb(m.vram_mb)}`).join(', ') : T.ollamaIdle) : T.ollamaOff}
            </Text>
          </Box>

          <Box flexDirection="column">
            {head(T.bridgeHead)}
            {!br && <Text dimColor>{T.bridgeOff}</Text>}
            {br && br.total === 0 && <Text color="warning">{br.error ? cut(br.error, 160) : T.bridgeNotYet}</Text>}
            {br && br.total > 0 && (
              <Text>
                {T.bridgeReady(br.ready, br.total)}
                <Text bold color={br.frames ? 'success' : 'error'}>
                  {br.frames}
                </Text>
              </Text>
            )}
            {br && br.total > 0 && (
              <Text dimColor>
                {br.next_free ? T.bridgeNext(br.next_free) : T.bridgeAllFree}
                {br.all_free && br.all_free !== br.next_free ? T.bridgeAll(br.all_free) : ''}
                {br.at ? T.bridgePolled(br.at) : ''}
              </Text>
            )}
          </Box>

          <Box flexDirection="column">
            {head(T.topDay)}
            {s.top_day.map(c => chatRow(c, `${tok(c.day)} · ${T.agoTail(ago(c.ago))}`))}
          </Box>
          <Box flexDirection="column">
            {head(T.topWeek)}
            {s.top_week.map(c => chatRow(c, `${tok(c.week)} · ${T.agoTail(ago(c.ago))}`))}
          </Box>
        </Box>
      )
    }

    // ------------------------------------------------------------------ Projects
    const bf = await read($, BOARD)
    const b = bf.board
    if (!b) return <Box flexDirection="column" gap={1}>{tabs}{noServer(bf.error)}</Box>
    const sub = await read($, SUB)
    const open = await read($, OPEN)
    const toggle = (id: string) => () => {
      void update($, OPEN, cur => (cur === id ? '' : id))
    }
    const setSub = (k: Sub) => () => {
      void update($, SUB, () => k)
      void update($, OPEN, () => '')
    }
    const subBtn = (k: Sub, label: string) => (
      <Button key={'sub-' + k} plain={sub === k ? undefined : true} variant={sub === k ? 'primary' : undefined} label={label} onPress={setSub(k)} />
    )
    const subs = (
      <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
        {subBtn('status', T.subStatus(b.projects.length))}
        {subBtn('plan', T.subPlan)}
        {subBtn('ideas', T.subIdeas(b.ideas.reduce((n, i) => n + i.items.length, 0)))}
        {subBtn('bare', T.subBare(b.bare.length))}
      </Box>
    )
    const stamp = (
      <Text dimColor>
        {T.checked(b.time)}
        {bf.error ? T.offline(bf.error) : ''}
      </Text>
    )

    // A project is a small framed card: a colored dot, the name and the date, then its one line that matters most
    // (what waits for the owner, else what is broken, else the next step); ▾ shows everything.
    type Kind = 'waits' | 'broken' | 'next' | 'works'
    const KINDS: { k: Kind; label: string; color: 'warning' | 'error' | 'suggestion' | 'success' }[] = [
      { k: 'waits', label: T.kWaits, color: 'warning' },
      { k: 'broken', label: T.kBroken, color: 'error' },
      { k: 'next', label: T.kNext, color: 'suggestion' },
      { k: 'works', label: T.kWorks, color: 'success' },
    ]
    // The card's main line may take two rows; the next step, when it is not the main line, gets one row under it.
    const room = Math.max(40, Math.round((cols - 14) * 1.9))
    const line = (x: (typeof KINDS)[number], t: string, dim: boolean, rows: 1 | 2) => (
      <Box flexDirection="row" gap={1}>
        <Box width={7} flexShrink={0}>
          <Text color={dim ? undefined : x.color} dimColor={dim}>
            {x.label}
          </Text>
        </Box>
        <Text wrap={rows === 1 ? 'truncate-end' : 'wrap'} dimColor={dim}>
          {rows === 1 ? t : cut(t, room)}
        </Text>
      </Box>
    )
    const card = (p: Project) => {
      const isOpen = open === p.path
      const dim = p.stale && !p.warn
      const dot = p.warn ? 'warning' : p.stale ? 'inactive' : 'success'
      const main = KINDS.find(x => p[x.k].length > 0)
      const after = main && main.k !== 'next' && main.k !== 'works' ? KINDS.find(x => x.k === 'next' && p.next.length > 0) : undefined
      return (
        <Box
          flexDirection="column"
          borderStyle="round"
          borderColor={p.warn ? 'warning' : 'subtle'}
          borderDimColor={!p.warn}
          paddingX={2}
          paddingY={1}
          gap={0}
        >
          {/* The desktop draws a Button's text in its own color, so the colored name is a Text beside it. */}
          <Box flexDirection="row" justifyContent="space-between" alignItems="center" gap={1}>
            <Text wrap="truncate-end">
              <Text color={dot}>● </Text>
              <Text bold dimColor={dim}>
                {p.name}
              </Text>
            </Text>
            <Box flexDirection="row" alignItems="center" gap={1}>
              <Text dimColor tabular>
                {p.stale ? T.days(Math.round(p.age_days)) : p.date}
              </Text>
              <Button key={p.path} plain label={isOpen ? '▴' : '▾'} onPress={toggle(p.path)} />
            </Box>
          </Box>
          {!isOpen && main && line(main, p[main.k][0] ?? '', dim, 2)}
          {!isOpen && after && line(after, p.next[0] ?? '', dim, 1)}
          {!isOpen && !main && (
            <Text wrap="wrap" dimColor>
              {cut(p.summary || T.noSections, room)}
            </Text>
          )}
          {isOpen && (
            <Box flexDirection="column" gap={1} marginTop={1}>
              {KINDS.filter(x => p[x.k].length > 0).map(x => (
                <Box flexDirection="column">
                  <Text bold color={x.color}>
                    {x.label}
                  </Text>
                  {p[x.k].map(t => (
                    <Text wrap="wrap">· {t}</Text>
                  ))}
                </Box>
              ))}
              {!main && <Text wrap="wrap">{p.summary}</Text>}
              <Text dimColor wrap="truncate-start">
                {p.parent ? p.parent + ' · ' : ''}
                {p.path}
              </Text>
            </Box>
          )}
        </Box>
      )
    }

    let body
    if (sub === 'status') {
      const groups: { name: string; list: Project[] }[] = []
      for (const p of b.projects) {
        const g = groups.find(x => x.name === p.section)
        if (g) g.list.push(p)
        else groups.push({ name: p.section, list: [p] })
      }
      // within a section: what needs the owner first, then the fresh ones, the old ones last
      const rank = (p: Project) => (p.warn ? 0 : p.stale ? 2 : 1)
      for (const g of groups) g.list.sort((x, y) => rank(x) - rank(y) || x.age_days - y.age_days)
      // Filters with their counts: one press leaves what waits for the owner, what is broken, or the old ones.
      const filter = await read($, FILTER)
      const FILTERS: { k: Filter; label: string; keep: (p: Project) => boolean }[] = [
        { k: 'all', label: T.fAll, keep: () => true },
        { k: 'waits', label: T.fWaits, keep: p => p.waits.length > 0 },
        { k: 'broken', label: T.fBroken, keep: p => p.broken.length > 0 },
        { k: 'stale', label: T.fStale, keep: p => p.stale },
      ]
      const active = FILTERS.find(x => x.k === filter) ?? FILTERS[0]!
      const shown = groups.map(g => ({ ...g, list: g.list.filter(active.keep) })).filter(g => g.list.length > 0)
      const chip = (x: (typeof FILTERS)[number]) => (
        <Button
          key={'filter-' + x.k}
          plain={x.k === active.k ? undefined : true}
          variant={x.k === active.k ? 'primary' : undefined}
          label={`${x.label} ${b.projects.filter(x.keep).length}`}
          onPress={() => {
            void update($, FILTER, () => x.k)
            void update($, OPEN, () => '')
          }}
        />
      )
      body = (
        <Box flexDirection="column" gap={1}>
          <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
            {FILTERS.map(chip)}
          </Box>
          {shown.length === 0 && <Text dimColor>{T.noneLikeThat}</Text>}
          {shown.map(g => (
            <Box flexDirection="column" gap={1}>
              {head(`${g.name.toUpperCase()} · ${g.list.length}`)}
              {g.list.map(card)}
            </Box>
          ))}
        </Box>
      )
    } else if (sub === 'plan') {
      const now = b.plan?.now
      const last = b.plan?.last
      const ch = b.channels
      body = (
        <Box flexDirection="column" gap={1}>
          {head(T.planHead(now?.title ?? T.planMissing))}
          {now && <Markdown text={now.md} />}
          {head(T.logHead(last?.head ?? T.logMissing))}
          {last && <Markdown text={last.md} />}
          {head(T.channelsHead(ch?.title ?? T.channelsMissing))}
          {ch && <Markdown text={ch.md} />}
        </Box>
      )
    } else if (sub === 'ideas') {
      body = (
        <Box flexDirection="column" gap={1}>
          {b.ideas.length === 0 && <Text dimColor>{T.noIdeas}</Text>}
          {b.ideas.map(file => (
            <Box flexDirection="column">
              {head(`${file.where.replace(/\\/g, ' / ')} / ${file.name} · ${file.date}`)}
              {file.items.map((it, i) => {
                const id = `${file.path}#${i}`
                const isOpen = open === id
                return (
                  <Box flexDirection="column">
                    <Button key={id} plain onPress={toggle(id)}>
                      <Text dimColor>{isOpen ? '▾ ' : '▸ '}</Text>
                      {it.t}
                    </Button>
                    {isOpen && it.md && <Markdown text={it.md} />}
                  </Box>
                )
              })}
            </Box>
          ))}
        </Box>
      )
    } else {
      body = (
        <Box flexDirection="column">
          <Text dimColor wrap="wrap">
            {T.bareHint}
          </Text>
          {b.bare.map(x => (
            <Box flexDirection="row" justifyContent="space-between" gap={1}>
              <Text wrap="truncate-end">
                {x.name}
                <Text dimColor> · {x.parent ? x.parent + ' · ' : ''}{x.section}</Text>
              </Text>
              <Text tabular dimColor>
                {x.date}
              </Text>
            </Box>
          ))}
        </Box>
      )
    }

    return (
      <Box flexDirection="column" gap={1}>
        {tabs}
        <Box flexDirection="column">
          {subs}
          {stamp}
        </Box>
        {body}
      </Box>
    )
  })
}
