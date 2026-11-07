import type { ElementTable, EngineInterface, Register } from 'claude-code'

import type { Chat, Feed, Hist, Job, Proc, Snap } from '../types'
import { chart, line } from './svg'

// The band and the pane read the local Claude Code Monitor server (monitor.py) instead of polling processes
// themselves: one small local HTTP request a second, the heavy lifting stays in the Python server.
// Both settings come from the plugin's userConfig (plugin.json): server_url and start_command.
let WEB = 'http://127.0.0.1:8770'
let START = ''
const PANE = 'monitor-pane'
const TITLE = 'Монитор'
const EVERY_MS = 1000

// The last poll, kept in the session's state: a write redraws the band and the pane.
const FEED = { plugin: 'pc-monitor', key: 'feed' } as const
const BAND_OFF = { plugin: 'pc-monitor', key: 'bandOff' } as const
const EXPANDED = { plugin: 'pc-monitor', key: 'expanded' } as const
const HIST = { plugin: 'pc-monitor', key: 'hist' } as const
const EMPTY: Feed = { snap: null, error: null, at: 0 }
const HIST_LEN = 60
const NO_HIST: Hist = { cpu: [], gpu: [], vram: [], ram: [] }

const tok = (n: number): string =>
  n >= 1e9 ? (n / 1e9).toFixed(2) + 'B' : n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? Math.round(n / 1e3) + 'k' : String(n || 0)
const ago = (s: number): string =>
  s < 60 ? s + 'с' : s < 3600 ? Math.round(s / 60) + 'м' : s < 86400 ? Math.round(s / 3600) + 'ч' : Math.round(s / 86400) + 'д'
const gb = (mb: number): string => (mb >= 1024 ? (mb / 1024).toFixed(1) + 'Г' : mb + 'М')
const bar = (pct: number, cells = 10): string => {
  const full = Math.max(0, Math.min(cells, Math.round((pct / 100) * cells)))
  return '█'.repeat(full) + '░'.repeat(cells - full)
}
const cut = (s: string, n: number): string => (s.length > n ? s.slice(0, Math.max(1, n - 1)) + '…' : s)
const SPARK = '▁▂▃▄▅▆▇█'
/** The last `n` samples as a one-row graph, padded on the left while the history fills. */
const spark = (a: number[], n: number): string =>
  a
    .slice(-n)
    .map(v => SPARK[Math.max(0, Math.min(7, Math.round((v / 100) * 7)))])
    .join('')
    .padStart(n, ' ')

const MODES: Record<string, string> = {
  render: 'рендер',
  bg: 'фон',
  gui: 'окно',
  studio: 'Studio',
  nowin: 'без окна',
}

/** The /api answer, cut to what the pane draws. */
function trim(d: any): Snap {
  const s = d.sys
  const g = d.gpu && !d.gpu.error ? d.gpu : null
  const chat = (r: any): Chat => ({
    sid: r.sid,
    project: r.project,
    title: r.title ?? null,
    first: r.first ?? '',
    model: r.model ?? '',
    hour: r.hour,
    day: r.day,
    week: r.week,
    out_day: r.out_day,
    ago: r.ago,
    agents: r.agents ?? 0,
  })
  const proc = (p: any): Proc => ({ name: p.name, n: p.n, cpu: p.cpu, mem_mb: p.mem_mb })
  return {
    time: d.time,
    cpu: s.cpu,
    ram_pct: s.ram_pct,
    ram_used_gb: s.ram_used_gb,
    ram_total_gb: s.ram_total_gb,
    gpu: g
      ? {
          util: g.util,
          vram_pct: g.vram_pct,
          vram_used: g.vram_used,
          vram_total: g.vram_total,
          temp: g.temp,
          power: g.power ?? null,
          name: g.name,
        }
      : null,
    disks: s.disks.map((k: any) => ({ d: k.d, free_gb: k.free_gb, total_gb: k.total_gb })),
    limits: d.limits,
    active: d.chats.active.map(chat),
    top_day: d.chats.top_day.map(chat),
    total: d.chats.total,
    work: s.work.map(
      (w: any): Job => ({
        pid: w.pid,
        kind: w.kind,
        mode: w.mode,
        what: w.what ?? '',
        cpu: w.cpu,
        mem_mb: w.mem_mb,
        heavy: !!w.heavy,
        age: w.age,
        n: w.n ?? 1,
      }),
    ),
    gate: (s.gate ?? []).map((x: any) => ({ pid: x.pid, own: x.own ?? '', age: x.age })),
    rendering: (s.rendering ?? []).length,
    ollama: d.ollama?.on ? d.ollama.models.map((m: any) => ({ name: m.name, vram_mb: m.vram_mb })) : null,
    bridge: d.bridge && !d.bridge.error
      ? { ready: d.bridge.ready, total: d.bridge.total, frames: d.bridge.frames, next_free: d.bridge.next_free ?? null }
      : null,
    top_cpu: s.top_cpu.slice(0, 5).map(proc),
    top_mem: s.top_mem.slice(0, 5).map(proc),
    alerts: d.alerts ?? [],
  }
}

function alertText(a: Snap['alerts'][number]): string {
  if (a.k === 'vram') return `VRAM ${a.v}%`
  if (a.k === 'disk') return `диск ${a.d}: ${a.v} ГБ`
  return `чатов ${a.v}`
}

/** One poll of the monitor's /api: the feed the band and the pane draw from. */
async function poll($: EngineInterface): Promise<void> {
  let f: Feed
  try {
    const r = await $.http.fetch(WEB + '/api')
    if (!r.ok) throw new Error('HTTP ' + r.status)
    const d = JSON.parse(r.text)
    if (!d.ok) throw new Error('монитор ещё собирает данные')
    f = { snap: trim(d), error: null, at: Date.now() }
  } catch (err) {
    const { value: old = EMPTY } = await $.state.get(FEED)
    f = { ...old, error: err instanceof Error ? err.message : String(err), at: Date.now() }
  }
  const s = f.snap
  if (s && !f.error) {
    const { value: past = NO_HIST } = await $.state.get(HIST)
    const push = (a: number[], v: number) => [...a, v].slice(-HIST_LEN)
    await $.state.set(HIST, {
      cpu: push(past.cpu, s.cpu),
      gpu: push(past.gpu, s.gpu?.util ?? 0),
      vram: push(past.vram, s.gpu?.vram_pct ?? 0),
      ram: push(past.ram, s.ram_pct),
    })
  }
  await $.state.set(FEED, f)
}

export const register: Register = (on, options) => {
  const url = typeof options.server_url === 'string' ? options.server_url.trim().replace(/\/+$/, '') : ''
  WEB = url || WEB
  START = typeof options.start_command === 'string' ? options.start_command.trim() : ''

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'monitor',
      description: 'Монитор ПК: /monitor — подробная панель, /monitor off|on — спрятать или вернуть полоску',
    })
    $.ui.status(undefined) // the band above the prompt replaced the old status line
    void $.ui.close({ id: PANE }) // the detailed pane opens only on demand now

    void poll($)
    $.clock.every(EVERY_MS, () => poll($))

    return next(e)
  })

  on('command.run', { command: 'monitor' }, async ($, e) => {
    const arg = (e.args ?? '').trim()
    if (arg === 'web') return { text: `Монитор в браузере: ${WEB}` }
    if (arg === 'off' || arg === 'on') {
      await $.state.set(BAND_OFF, arg === 'off')
      return { text: arg === 'off' ? 'Полоска монитора спрятана: /monitor on вернёт.' : 'Полоска монитора включена.' }
    }
    await $.ui.open({ id: PANE, title: TITLE })
    return { text: 'Подробная панель монитора открыта.' }
  })

  // The band: one row right above the prompt, refreshed every second. The ▾/▴ toggle stays at its right end;
  // the expanded view opens under that row.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const { value: off = false } = await $.state.get(BAND_OFF)
    if (e.props.hasSurvey || off) return next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    const { value: f = EMPTY } = await $.state.get(FEED)
    const { value: expanded = false } = await $.state.get(EXPANDED)
    const s = f.snap
    const openPane = () => {
      void $.ui.open({ id: PANE, title: TITLE })
    }
    const toggle = () => {
      void $.state.set(EXPANDED, !expanded)
    }
    const toggleBtn = <Button key="toggle" label={expanded ? '▴ Свернуть' : '▾ Ещё'} onPress={toggle} />
    if (!s) {
      return (
        <Box flexDirection="row" justifyContent="space-between" alignItems="center" gap={1}>
          <Text color="warning" wrap="truncate-end">
            🖥 монитор не отвечает{f.error ? `: ${f.error}` : ''}
          </Text>
          <Button key="more" label="Панель" onPress={openPane} />
        </Box>
      )
    }
    const L = s.limits
    const { value: hist = NO_HIST } = await $.state.get(HIST)
    // Desktop, the editor and the phone draw SVG; the terminal gets the same row as text.
    const Svg = e.surface === 'terminal' ? undefined : ($.ui.resolve(e) as Partial<ElementTable<'desktop'>>).Svg
    const g = s.gpu
    const heavy = s.work.filter(w => w.heavy)
    const job = heavy[0] ?? s.work.find(w => w.cpu >= 5)
    const jobText = job ? `${job.kind} ${[job.mode ? MODES[job.mode] ?? job.mode : '', job.what].filter(Boolean).join(' ')}` : ''
    const alt =
      `CPU ${Math.round(s.cpu)}%` +
      (g ? `, GPU ${Math.round(g.util)}%, VRAM ${Math.round(g.vram_pct)}%` : '') +
      `, RAM ${Math.round(s.ram_pct)}%, чатов ${s.active.length}, ${tok(s.total.hour)} токенов за час` +
      (s.alerts.length ? `. Внимание: ${s.alerts.map(alertText).join(', ')}` : '')

    const row = Svg ? (
      <Box flexGrow={1} flexShrink={1} minWidth={0}>
        <Svg
          source={line(s, hist, { chats: s.active.length, perHour: tok(s.total.hour), today: tok(s.total.day), job: jobText, jobHeavy: !!heavy.length, frames: s.bridge?.frames ?? null })}
          alt={alt}
        />
      </Box>
    ) : (
      <Text wrap="truncate-end">
        {`CPU ${Math.round(s.cpu)}%`}
        {g ? <Text color={g.vram_pct > L.vram_pct ? 'error' : undefined}>{`  GPU ${Math.round(g.util)}%  VRAM ${Math.round(g.vram_pct)}%`}</Text> : ''}
        {`  RAM ${Math.round(s.ram_pct)}%  `}
        <Text dimColor>{s.disks.map(k => `${k.d} ${Math.round(k.free_gb)}`).join(' ')} ГБ  </Text>
        <Text color={s.active.length > L.chats ? 'error' : undefined}>{`чаты ${s.active.length}`}</Text>
        <Text dimColor>{`  ${tok(s.total.hour)}/ч`}</Text>
        {jobText ? <Text color={heavy.length ? 'warning' : undefined}>{`  ${heavy.length ? '● ' : ''}${cut(jobText, 30)}`}</Text> : ''}
        {s.bridge ? <Text dimColor>{`  мост ${s.bridge.frames}`}</Text> : ''}
      </Text>
    )

    let details = null
    if (expanded) {
      const cols = e.props.bodyColumns ?? 100
      const half = Math.max(20, Math.floor(cols / 2) - 2)
      const head = (t: string, bad = false) => (
        <Text bold color={bad ? 'error' : 'subtle'}>
          {t}
        </Text>
      )
      const w = Math.max(10, Math.min(HIST_LEN, cols - 34))
      const textGraphs = (
        <Box flexDirection="column">
          {(
            [
              ['CPU', hist.cpu, s.cpu, false],
              ...(g ? [['GPU', hist.gpu, g.util, false], ['VRAM', hist.vram, g.vram_pct, g.vram_pct > L.vram_pct]] : []),
              ['RAM', hist.ram, s.ram_pct, s.ram_pct > 90],
            ] as [string, number[], number, boolean][]
          ).map(([label, a, pct, bad]) => (
            <Text tabular>
              <Text dimColor>{label.padEnd(5)}</Text>
              <Text mono color={bad ? 'error' : 'suggestion'}>
                {spark(a, w)}
              </Text>
              <Text bold color={bad ? 'error' : undefined}>{` ${Math.round(pct)}%`}</Text>
            </Text>
          ))}
        </Box>
      )
      details = (
        <Box flexDirection="column" gap={1}>
          {Svg ? <Svg source={chart(s, hist)} alt={`График за минуту: ${alt}`} /> : textGraphs}
          <Box flexDirection="row" flexWrap="wrap" columnGap={3} rowGap={1}>
            <Box flexDirection="column" flexGrow={1} minWidth={30}>
              {head(`ЧАТЫ ${s.active.length}`, s.active.length > L.chats)}
              {s.active.length === 0 && <Text dimColor>нет активных</Text>}
              {s.active.map(c => (
                <Box flexDirection="row" justifyContent="space-between" gap={1}>
                  <Text wrap="truncate-end">
                    <Text color="claude" bold>
                      {c.project}
                    </Text>
                    <Text dimColor> {cut(c.title || c.first, half)}</Text>
                  </Text>
                  <Text tabular dimColor>
                    {tok(c.hour)}/ч · {ago(c.ago)}
                  </Text>
                </Box>
              ))}
            </Box>
            <Box flexDirection="column" flexGrow={1} minWidth={30}>
              {head('ЗАНЯТО')}
              {s.work.length === 0 && <Text dimColor>ничего не запущено</Text>}
              {s.work.slice(0, 4).map(j => (
                <Box flexDirection="row" justifyContent="space-between" gap={1}>
                  <Text wrap="truncate-end" color={j.heavy ? 'warning' : undefined}>
                    {j.heavy ? '● ' : ''}
                    {j.kind}
                    <Text dimColor> {[j.mode ? MODES[j.mode] ?? j.mode : '', j.what].filter(Boolean).join(' ')}</Text>
                  </Text>
                  <Text tabular dimColor>
                    {j.cpu}% · {gb(j.mem_mb)}
                  </Text>
                </Box>
              ))}
              <Text dimColor wrap="truncate-end">
                {s.top_cpu
                  .slice(0, 3)
                  .map(p => `${p.name.replace(/\.exe$/i, '')} ${p.cpu}%`)
                  .join(' · ')}
                {' │ '}
                {s.top_mem
                  .slice(0, 3)
                  .map(p => `${p.name.replace(/\.exe$/i, '')} ${gb(p.mem_mb)}`)
                  .join(' · ')}
              </Text>
              <Text dimColor wrap="truncate-end">
                очередь {s.rendering ? `рендерит ${s.rendering}` : 'свободна'}
                {s.gate.length ? `, ждут ${s.gate.length}` : ''}
                {' · '}Ollama {s.ollama ? (s.ollama.length ? s.ollama.map(o => o.name).join(', ') : 'пусто') : 'выкл'}
                {s.bridge ? ` · мост ${s.bridge.ready}/${s.bridge.total}, ${s.bridge.frames} кадр.${s.bridge.next_free ? `, след. ${s.bridge.next_free}` : ''}` : ''}
              </Text>
            </Box>
          </Box>
          <Box flexDirection="row" justifyContent="flex-end">
            <Button key="more" label="Открыть панелью справа" onPress={openPane} />
          </Box>
        </Box>
      )
    }

    return (
      <Box flexDirection="column" gap={expanded ? 1 : 0}>
        <Box flexDirection="row" alignItems="center" gap={1}>
          {row}
          {f.error && <Text color="warning">нет связи</Text>}
          {toggleBtn}
        </Box>
        {details}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Link } = $.ui.resolve(e)
    const { value: f = EMPTY } = await $.state.get(FEED)
    const s = f.snap
    const cols = Math.max(30, e.props.bodyColumns ?? 48)
    const startServer = () => {
      if (!START) {
        $.ui.toast('Запустите monitor.py (или задайте start_command в настройках плагина)')
        return
      }
      void $.process.run(['cmd', '/c', START]).catch(() => undefined)
      $.ui.toast('Запускаю монитор…')
    }
    const close = () => {
      void $.ui.close({ id: PANE })
    }
    const closeBtn = <Button key="close" label="✕ Закрыть" onPress={close} />

    if (!s) {
      return (
        <Box flexDirection="column" gap={1}>
          <Text color="warning">Монитор не отвечает{f.error ? `: ${f.error}` : ''}.</Text>
          <Text dimColor>Сервер monitor.py должен работать на 127.0.0.1:8770.</Text>
          <Box flexDirection="row" gap={2}>
            <Button key="start" variant="primary" onPress={startServer}>
              Запустить сервер
            </Button>
            {closeBtn}
          </Box>
        </Box>
      )
    }

    const L = s.limits
    const stale = f.error ? ` · нет связи: ${f.error}` : ''
    const metric = (label: string, pct: number, tail: string, bad = false) => (
      <Box flexDirection="row" gap={1}>
        <Text tabular>{label.padEnd(5)}</Text>
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
            {c.agents ? ` +${c.agents}аг` : ''}
          </Text>
          <Text tabular dimColor>
            {right}
          </Text>
        </Box>
        <Text dimColor wrap="truncate-end">
          {cut(c.title || c.first, cols - 2)}
        </Text>
      </Box>
    )
    const job = (w: Job) => (
      <Box flexDirection="row" justifyContent="space-between" gap={1}>
        <Text wrap="truncate-end" color={w.heavy ? 'warning' : undefined}>
          {w.heavy ? '● ' : ''}
          {w.kind}
          {w.n > 1 ? ` ×${w.n}` : ''}
          <Text dimColor> {[w.mode ? MODES[w.mode] ?? w.mode : '', w.what].filter(Boolean).join(' · ')}</Text>
        </Text>
        <Text tabular dimColor>
          {w.cpu}% {gb(w.mem_mb)}
        </Text>
      </Box>
    )
    const procs = (list: Proc[], key: 'cpu' | 'mem') =>
      list.map(p => (
        <Box flexDirection="row" justifyContent="space-between" gap={1}>
          <Text wrap="truncate-end">
            {p.name}
            {p.n > 1 ? <Text dimColor> ×{p.n}</Text> : ''}
          </Text>
          <Text tabular>{key === 'cpu' ? `${p.cpu}%` : gb(p.mem_mb)}</Text>
        </Box>
      ))
    const head = (t: string, bad = false) => (
      <Text bold color={bad ? 'error' : 'subtle'}>
        {t}
      </Text>
    )
    const chatsBad = s.active.length > L.chats

    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="column">
          <Box flexDirection="row" justifyContent="space-between" alignItems="center" gap={1}>
            <Text dimColor>
              {s.time}
              {stale}
            </Text>
            {closeBtn}
          </Box>
          {s.alerts.length > 0 && (
            <Text color="error" bold>
              ⚠ {s.alerts.map(alertText).join(' · ')}
            </Text>
          )}
        </Box>

        <Box flexDirection="column">
          {metric('CPU', s.cpu, '')}
          {metric('RAM', s.ram_pct, `${s.ram_used_gb}/${s.ram_total_gb} ГБ`, s.ram_pct > 90)}
          {s.gpu && metric('GPU', s.gpu.util, `${s.gpu.temp}°C`)}
          {s.gpu &&
            metric(
              'VRAM',
              s.gpu.vram_pct,
              `${(s.gpu.vram_used / 1024).toFixed(1)}/${(s.gpu.vram_total / 1024).toFixed(0)} ГБ`,
              s.gpu.vram_pct > L.vram_pct,
            )}
          <Text tabular>
            {s.disks.map(k => (
              <Text color={k.free_gb < L.disk_gb ? 'error' : undefined}>
                {k.d}: {Math.round(k.free_gb)} ГБ{'  '}
              </Text>
            ))}
          </Text>
        </Box>

        <Box flexDirection="column">
          {head(`ЧАТЫ: ${s.active.length} активно`, chatsBad)}
          <Text dimColor>
            час {tok(s.total.hour)} · сегодня {tok(s.total.day)} · выход {tok(s.total.out_day)}
          </Text>
          {s.active.length === 0 && <Text dimColor>нет активных</Text>}
          {s.active.map(c => chatRow(c, `${tok(c.hour)}/ч ${tok(c.day)} · ${ago(c.ago)}`))}
        </Box>

        <Box flexDirection="column">
          {head('КТО ЧЕМ ЗАНЯТ')}
          {s.work.length === 0 && <Text dimColor>ничего тяжёлого не запущено</Text>}
          {s.work.slice(0, 8).map(job)}
          <Text dimColor>
            очередь: {s.rendering ? `рендерит ${s.rendering}` : 'свободно'}
            {s.gate.length ? ` · ждут ${s.gate.length}` : ''}
            {' · '}Ollama: {s.ollama ? (s.ollama.length ? s.ollama.map(m => `${m.name} ${gb(m.vram_mb)}`).join(', ') : 'пусто') : 'выкл'}
          </Text>
          {s.bridge && (
            <Text dimColor>
              мост ChatGPT: {s.bridge.ready}/{s.bridge.total} акк., кадров{' '}
              <Text color={s.bridge.frames ? 'success' : 'error'} bold>
                {s.bridge.frames}
              </Text>
              {s.bridge.next_free ? `, след. в ${s.bridge.next_free}` : ''}
            </Text>
          )}
        </Box>

        <Box flexDirection="column">
          {head('ТОП-5 СЕГОДНЯ')}
          {s.top_day.map(c => chatRow(c, `${tok(c.day)} · ${ago(c.ago)}`))}
        </Box>

        <Box flexDirection="column">
          {head('ПРОЦЕССЫ: CPU')}
          {procs(s.top_cpu, 'cpu')}
        </Box>
        <Box flexDirection="column">
          {head('ПРОЦЕССЫ: ПАМЯТЬ')}
          {procs(s.top_mem, 'mem')}
        </Box>

        <Link href={WEB} label="Полная версия в браузере" />
      </Box>
    )
  })
}
