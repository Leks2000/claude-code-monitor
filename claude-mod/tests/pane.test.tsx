import { expect, test } from 'claude-code/testing'

import type { Feed } from '../types'

const RU = { options: { lang: 'ru' } } as const

const PANE = {
  plugin: 'pc-monitor',
  component: 'Pane',
  requestId: 'monitor-pane',
  props: {
    title: 'Монитор',
    isFocused: false,
    bodyColumns: 44,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

const chat = {
  sid: 's1', project: 'news-bot', title: 'Бот: очередь', first: 'Проект: бот', model: 'opus-5-5',
  hour: 4_600_000, day: 61_000_000, week: 200_000_000, out_day: 190_000, ago: 4, agents: 0,
}
const FEED: Feed = {
  error: null,
  at: 1,
  snap: {
    time: '12:00:00', cpu: 42, ram_pct: 64, ram_used_gb: 20.4, ram_total_gb: 31.8,
    gpu: { util: 20, vram_pct: 92, vram_used: 7500, vram_total: 8192, temp: 59, power: 120, name: 'RTX 3070 Ti' },
    disks: [{ d: 'C', free_gb: 126, total_gb: 894 }, { d: 'D', free_gb: 12, total_gb: 932 }],
    limits: { vram_pct: 90, disk_gb: 20, chats: 3 },
    active: [chat], top_day: [chat],
    total: { hour: 4_600_000, day: 61_000_000, week: 200_000_000, out_day: 190_000 },
    work: [{ pid: 1, kind: 'Blender', mode: 'render', what: 'intro.blend', cpu: 31, mem_mb: 3000, heavy: true, age: 60, n: 1 }],
    gate: [], rendering: 1, ollama: null,
    bridge: { ready: 5, total: 9, frames: 15, next_free: '04:18' },
    top_cpu: [{ name: 'blender.exe', n: 1, cpu: 31, mem_mb: 3000 }],
    top_mem: [{ name: 'claude.exe', n: 24, cpu: 6, mem_mb: 2900 }],
    alerts: [{ k: 'vram', v: 92 }, { k: 'disk', d: 'D', v: 12 }],
  },
}

test('the pane draws a snapshot on every surface', RU, async ($, on) => {
  on('state.get', () => ({ value: { value: FEED, version: 1 } }))

  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Text', text: /VRAM 92%/ }))?.text).toContain('диск D: 12 ГБ')
    expect((await ui.find({ type: 'Text', text: /news-bot/ }))?.text).toContain('news-bot')
    expect(await ui.find({ type: 'Text', text: /intro\.blend/ })).toBeTruthy()
    await ui.unmount()
  }
})

const BAND = {
  plugin: 'pc-monitor',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 6, bodyColumns: 120, scroll: { offset: 0, bodyRows: 6 }, view: {} },
} as const

const HIST = { cpu: [10, 50, 100], gpu: [0, 20, 40], vram: [90, 91, 92], ram: [60, 62, 64] }
const stateOf = (expanded: boolean, bandOff = false) => (_: unknown, e: { key: string }) => {
  const v: Record<string, unknown> = { feed: FEED, bandOff, expanded, hist: HIST }
  return { value: { value: v[e.key], version: 1 } }
}

test('terminal: the band is one text row with the toggle at its end', RU, async ($, on) => {
  on('state.get', stateOf(false))

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  const row = (await ui.find({ type: 'Text', text: /CPU 42%/ }))?.text ?? ''
  expect(row).toContain('VRAM 92%')
  expect(row).toContain('чаты 1')
  expect(row).toContain('intro.blend')
  expect(await ui.find({ type: 'Button', key: 'toggle' })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /ЧАТЫ 1/ })).toBeFalsy()
  await ui.unmount()
})

test('desktop: the band is one SVG row, the alert in its alt, the toggle beside it', RU, async ($, on) => {
  on('state.get', stateOf(false))

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  const svg = (await ui.find({ type: 'Svg' })) as unknown as { props?: { source?: string; alt?: string } } | undefined
  const src = String(svg?.props?.source ?? '')
  expect(src).toContain('<svg')
  expect(src).toContain('VRAM')
  expect(src).toContain('чаты')
  expect(src).toContain('Blender')
  expect(String(svg?.props?.alt ?? '')).toContain('VRAM 92%')
  expect(await ui.find({ type: 'Button', key: 'toggle' })).toBeTruthy()
  expect(await ui.find({ type: 'Button', key: 'more' })).toBeFalsy()
  await ui.unmount()
})

test('expanded: chart or text graphs, chats, jobs, processes, the toggle still in the top row', RU, async ($, on) => {
  on('state.get', stateOf(true))

  const term = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await term.find({ type: 'Text', text: /▂▅█/ }))?.text).toContain('▂▅█')
  await term.unmount()

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect(await ui.find({ type: 'Text', text: /ЧАТЫ 1/ })).toBeTruthy()
    expect((await ui.find({ type: 'Text', text: /Бот: очередь/ }))?.text).toContain('Бот: очередь')
    expect(await ui.find({ type: 'Text', text: /мост 5\/9/ })).toBeTruthy()
    expect(await ui.find({ type: 'Button', key: 'more' })).toBeTruthy()
    expect(await ui.find({ type: 'Button', key: 'toggle' })).toBeTruthy()
    await ui.unmount()
  }
})

test('the right pane has a close button', RU, async ($, on) => {
  on('state.get', stateOf(false))
  let closed = ''
  on('ui.close', (_, e) => {
    closed = e.id
    return { value: undefined }
  })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'close' })
  expect(closed).toBe('monitor-pane')
  await ui.unmount()
})

test('/monitor off hides the band', RU, async ($, on) => {
  on('state.get', stateOf(false, true))
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await ui.find({ type: 'Text' }))?.text).toBe('engine')
  await ui.unmount()
})

test('with no snapshot the pane offers to start the server', RU, async ($, on) => {
  on('state.get', () => ({ value: { value: { snap: null, error: 'HTTP 502', at: 1 }, version: 1 } }))

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /не отвечает/ }))?.text).toContain('HTTP 502')
  expect(await ui.find({ type: 'Button', key: 'start' })).toBeTruthy()
  await ui.unmount()
})

test('English by default: the line and the expanded view', async ($, on) => {
  on('state.get', stateOf(true))

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  const svg = (await ui.find({ type: 'Svg' })) as unknown as { props?: { source?: string } } | undefined
  const src = String(svg?.props?.source ?? '')
  expect(src).toContain('chats')
  expect(src).toContain('/h')
  expect(await ui.find({ type: 'Text', text: /CHATS 1/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /RUNNING/ })).toBeTruthy()
  const term = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await term.find({ type: 'Text', text: /CPU 42%/ }))?.text).toContain('chats 1')
  await term.unmount()
  await ui.unmount()
})
