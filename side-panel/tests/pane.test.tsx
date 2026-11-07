import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

const RU = { options: { lang: 'ru' } } as const

const PANE = {
  plugin: 'side-panel',
  component: 'Pane',
  requestId: 'side-panel',
  props: {
    title: 'Panel',
    isFocused: false,
    bodyColumns: 52,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 60 },
    view: {},
  },
} as const

const chat = {
  sid: 's1', project: 'mine-game', title: 'Mine game: meteor event', first: 'Add a meteor every 20 minutes',
  model: 'opus-5-5', hour: 4_600_000, day: 61_000_000, week: 200_000_000, ago: 4, agents: 1,
}
const API = {
  ok: true, time: '03:50:00',
  sys: {
    cpu: 42.5, ram_pct: 64, ram_used_gb: 20.4, ram_total_gb: 31.8,
    disks: [{ d: 'C', free_gb: 126, total_gb: 894 }, { d: 'D', free_gb: 12, total_gb: 932 }],
    work: [{ pid: 1, kind: 'Blender', mode: 'render', what: 'intro.blend', cpu: 31, mem_mb: 3000, heavy: true, age: 60, n: 1 }],
    gate: [{ pid: 9, own: 'D:\\video', age: 30 }], rendering: [{ pid: 1 }],
    top_cpu: [{ name: 'blender.exe', n: 1, cpu: 31, mem_mb: 3000 }, { name: 'claude.exe', n: 24, cpu: 6, mem_mb: 2900 }],
    top_mem: [{ name: 'claude.exe', n: 24, cpu: 6, mem_mb: 2900 }],
  },
  gpu: { util: 20, vram_pct: 92, vram_used: 7500, vram_total: 8192, temp: 59, power: 120, name: 'RTX 3070 Ti' },
  chats: { active: [chat, chat, chat, chat], top_day: [chat], top_week: [chat], total: { hour: 4_600_000, day: 61_000_000, week: 200_000_000 } },
  ollama: { on: false, models: [] },
  bridge: { t: '03:49', ready: 5, total: 9, frames: 15, next_free: '04:18', all_free: '06:02', error: null },
  alerts: [{ k: 'vram', v: 92 }, { k: 'disk', d: 'D', v: 12 }, { k: 'chats', v: 4 }],
  limits: { vram_pct: 90, disk_gb: 20, chats: 3 },
}
const project = (name: string, extra: object) => ({
  name, parent: 'games', path: `C:\\work\\${name}\\STATUS.md`, section: 'games', date: '07.11', age_days: 0.2,
  stale: false, warn: false, title: name, works: ['mine, trucks, factory'], broken: [], next: ['a live playtest'], waits: [],
  summary: '', ...extra,
})
const BOARD = {
  ok: true, on: true, rev: 3, time: '03:50:10', walked: '03:40', stale_days: 7,
  projects: [
    project('mine-game', { warn: true, waits: ['the group id for Config.Social.GroupId'] }),
    project('old-game', { stale: true, age_days: 36, date: '02.10' }),
  ],
  plan: { now: { title: 'Now', head: '', md: '**In progress**\n- mine-game' }, last: { title: 'Log', head: '07.11, plan', md: '- clips' } },
  channels: { title: 'Layout', head: '', md: '| Channel | What |\n|---|---|\n| main | shorts |' },
  ideas: [{ name: 'IDEAS.md', where: 'games', path: 'C:\\work\\IDEAS.md', date: '27.10', items: [{ t: '1. Endless stairs', md: 'Climb higher than everyone' }] }],
  bare: [{ name: 'heist-game', parent: 'games', path: 'C:\\work\\heist', section: 'games', date: '05.11', mtime: 1 }],
}

function world(on: On, isUp = true, onOpen = () => {}) {
  mock.clock(on, { now: 1_000 })
  mock.store(on)
  on('command.register', () => ({ value: { command: 'panel' } }))
  on('tool.register', () => ({ value: { tool: 'mcp__side-panel__panel' } }))
  on('ui.open', () => {
    onOpen()
    return { value: { isPlaced: true } }
  })
  on('ui.panes', () => ({ value: [] }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('prompt.submit', (_, e) => ({ text: e.text }))
  on('http.fetch', (_, e) => {
    if (!isUp) return { value: { status: 503, ok: false, headers: {}, text: '' } }
    const body = e.url.endsWith('/api/projects') ? BOARD : API
    return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify(body) } }
  })
}

test('the projects tab draws cards, filters, plan, ideas and the bare list, on every surface', RU, async ($, on) => {
  world(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Text', text: /mine-game/ }))?.text).toContain('mine-game')
    expect(await ui.find({ type: 'Text', text: /Config\.Social\.GroupId/ })).toBeDefined()
    await ui.press({ key: 'filter-waits' })
    expect(await ui.find({ type: 'Text', text: /old-game/ })).toBeUndefined()
    await ui.press({ key: 'filter-all' })
    expect(await ui.find({ type: 'Text', text: /old-game/ })).toBeDefined()
    await ui.press({ key: 'sub-plan' })
    expect(await ui.find({ type: 'Text', text: /ЖУРНАЛ · 07.11/ })).toBeDefined()
    await ui.press({ key: 'sub-ideas' })
    await ui.press({ key: 'C:\\work\\IDEAS.md#0' })
    expect(await ui.find({ text: /Climb higher than everyone/ })).toBeDefined()
    await ui.press({ key: 'sub-bare' })
    expect(await ui.find({ type: 'Text', text: /heist-game/ })).toBeDefined()
    await ui.press({ key: 'sub-status' })
    await ui.unmount()
  }
})

test('the words follow the lang setting: English by default', async ($, on) => {
  world(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ key: 'filter-waits' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /waits/ })).toBeDefined()
  await ui.press({ key: 'tab-pc' })
  expect(await ui.find({ type: 'Text', text: /CLAUDE CHATS: 4 active/ })).toBeDefined()
  await ui.unmount()
})

test('the PC tab draws chats, load, jobs, the bridge and the alerts, on every surface', RU, async ($, on) => {
  world(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    await ui.press({ key: 'tab-pc' })
    expect(await ui.find({ type: 'Text', text: /ЧАТЫ CLAUDE: 4 активно/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /VRAM 92% · диск D: 12 ГБ · чатов 4/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /кадров сейчас/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /рендерит 1/ })).toBeDefined()
    await ui.press({ key: 'tab-projects' })
    await ui.unmount()
  }
})

test('the panel opens on /panel only: neither the start nor a prompt opens it', async ($, on) => {
  let opens = 0
  world(on, true, () => {
    opens += 1
  })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.prompt.submit({ text: 'hello', wait: false, origin: { kind: 'composer' } })
  expect(opens).toBe(0)
})

test('with the server down the pane says so and offers to start it', RU, async ($, on) => {
  world(on, false)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /Нет данных/ }))?.text).toContain('HTTP 503')
  expect(await ui.find({ key: 'start' })).toBeDefined()
  await ui.unmount()
})
