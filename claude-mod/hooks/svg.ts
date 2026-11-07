// Pure SVG builders for the desktop band: metric cards with live area graphs, and the big history chart.
import type { Hist, Snap } from '../types'

const FONT = "font-family=\"Segoe UI, system-ui, -apple-system, sans-serif\""
const DIM = '#8b949e'
const FG = '#e6edf3'
const BAD = '#f85149'
const CARD = 'fill="#ffffff" fill-opacity="0.045" stroke="#ffffff" stroke-opacity="0.09"'
export const COLORS = { cpu: '#58a6ff', gpu: '#a371f7', vram: '#f0883e', ram: '#3fb950' } as const

const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const r1 = (n: number): string => (Math.round(n * 10) / 10).toString()

/** An area graph of `vals` (0..100) inside the box x, y, w, h; the newest value at the right edge. */
function area(vals: number[], x: number, y: number, w: number, h: number, color: string, slots: number): string {
  if (vals.length < 2) return ''
  const v = vals.slice(-slots)
  const step = w / (slots - 1)
  const x0 = x + w - step * (v.length - 1)
  const pts = v.map((p, i) => `${r1(x0 + i * step)},${r1(y + h - (Math.max(0, Math.min(100, p)) / 100) * h)}`)
  const line = `M${pts.join(' L')}`
  const fill = `${line} L${r1(x + w)},${y + h} L${r1(x0)},${y + h} Z`
  return (
    `<path d="${fill}" fill="${color}" fill-opacity="0.22"/>` +
    `<path d="${line}" fill="none" stroke="${color}" stroke-width="1.6" stroke-linejoin="round"/>`
  )
}

type Card = { label: string; pct: number; sub: string; color: string; hist: number[]; bad: boolean }

/** The band's strip: one card per metric plus one for the disks, `W` wide in its own units. */
export function strip(s: Snap, hist: Hist): { source: string; width: number; height: number } {
  const L = s.limits
  const cards: Card[] = [{ label: 'CPU', pct: s.cpu, sub: '', color: COLORS.cpu, hist: hist.cpu, bad: false }]
  if (s.gpu) {
    const g = s.gpu
    cards.push({
      label: 'GPU',
      pct: g.util,
      sub: `${Math.round(g.temp)}°C${g.power ? ` · ${Math.round(g.power)} Вт` : ''}`,
      color: COLORS.gpu,
      hist: hist.gpu,
      bad: false,
    })
    const vb = g.vram_pct > L.vram_pct
    cards.push({
      label: 'VRAM',
      pct: g.vram_pct,
      sub: `${(g.vram_used / 1024).toFixed(1)} / ${(g.vram_total / 1024).toFixed(0)} ГБ`,
      color: vb ? BAD : COLORS.vram,
      hist: hist.vram,
      bad: vb,
    })
  }
  cards.push({
    label: 'RAM',
    pct: s.ram_pct,
    sub: `${s.ram_used_gb} / ${s.ram_total_gb} ГБ`,
    color: s.ram_pct > 90 ? BAD : COLORS.ram,
    hist: hist.ram,
    bad: s.ram_pct > 90,
  })

  const W = 1000
  const H = 62
  const GAP = 8
  const k = cards.length + 1
  const cw = (W - GAP * (k - 1)) / k
  let out = ''
  cards.forEach((c, i) => {
    const x = i * (cw + GAP)
    out += `<rect x="${r1(x + 0.5)}" y="0.5" width="${r1(cw - 1)}" height="${H - 1}" rx="9" ${CARD}${c.bad ? ` stroke="${BAD}" stroke-opacity="0.8"` : ''}/>`
    out += area(c.hist, x + 1, 22, cw - 2, H - 23, c.color, 60)
    out += `<text x="${r1(x + 11)}" y="17" font-size="11" fill="${DIM}" letter-spacing="0.6" ${FONT}>${c.label}</text>`
    out += `<text x="${r1(x + 11)}" y="45" font-size="22" font-weight="600" fill="${c.bad ? BAD : FG}" ${FONT}>${Math.round(c.pct)}<tspan font-size="13" fill="${DIM}">%</tspan></text>`
    if (c.sub) {
      out += `<text x="${r1(x + cw - 10)}" y="17" font-size="11" fill="${DIM}" text-anchor="end" ${FONT}>${esc(c.sub)}</text>`
    }
  })
  // disks: a row per drive, free space and a used bar
  const x = (k - 1) * (cw + GAP)
  out += `<rect x="${r1(x + 0.5)}" y="0.5" width="${r1(cw - 1)}" height="${H - 1}" rx="9" ${CARD}/>`
  const rows = s.disks.slice(0, 3)
  const rh = (H - 8) / Math.max(1, rows.length)
  rows.forEach((d, i) => {
    const y = 4 + rh * i + rh / 2
    const used = d.total_gb ? 1 - d.free_gb / d.total_gb : 0
    const low = d.free_gb < L.disk_gb
    const bx = x + 26
    const bw = cw - 26 - 64
    out += `<text x="${r1(x + 11)}" y="${r1(y + 4)}" font-size="11" fill="${DIM}" ${FONT}>${esc(d.d)}</text>`
    out += `<rect x="${r1(bx)}" y="${r1(y - 2.5)}" width="${r1(bw)}" height="5" rx="2.5" fill="#ffffff" fill-opacity="0.08"/>`
    out += `<rect x="${r1(bx)}" y="${r1(y - 2.5)}" width="${r1(bw * used)}" height="5" rx="2.5" fill="${low ? BAD : '#6e7681'}"/>`
    out += `<text x="${r1(x + cw - 10)}" y="${r1(y + 4)}" font-size="12" font-weight="600" fill="${low ? BAD : FG}" text-anchor="end" ${FONT}>${Math.round(d.free_gb)} ГБ</text>`
  })
  return {
    source: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">${out}</svg>`,
    width: W,
    height: H,
  }
}

export type LineInfo = {
  chats: number
  perHour: string
  today: string
  job: string
  jobHeavy: boolean
  frames: number | null
}

/** Rough text width in the SVG's units (the drawing is an image: no layout engine to ask). */
const tw = (t: string, size: number, bold = false): number => {
  let w = 0
  for (const ch of t) {
    w += ch === ' ' ? 0.28 : ch === '.' || ch === '·' ? 0.3 : /[A-ZА-Я%0-9]/.test(ch) ? 0.64 : /[●…]/.test(ch) ? 0.7 : 0.53
  }
  return w * size * (bold ? 1.06 : 1)
}

/**
 * The band's single row, `W` wide: each metric as label, value and a small area graph; the disks; then the
 * chats, tokens, the busiest job and the image bridge, dropped from the right when the row runs out of room.
 */
export function line(s: Snap, hist: Hist, info: LineInfo): string {
  const W = 1000
  const H = 30
  const mid = 20
  const L = s.limits
  let x = 2
  let out = ''
  const text = (t: string, size: number, fill: string, bold = false): void => {
    out += `<text x="${r1(x)}" y="${mid}" font-size="${size}"${bold ? ' font-weight="600"' : ''} fill="${fill}" ${FONT}>${esc(t)}</text>`
    x += tw(t, size, bold)
  }
  const metric = (label: string, pct: number, vals: number[], color: string, bad: boolean, extra = ''): void => {
    text(label, 12, DIM)
    x += 5
    text(`${Math.round(pct)}%`, 16, bad ? BAD : FG, true)
    x += 6
    out += `<rect x="${r1(x)}" y="5" width="46" height="20" rx="4" fill="#ffffff" fill-opacity="0.05"/>`
    out += area(vals, x, 6, 46, 18, bad ? BAD : color, 30)
    x += 50
    if (extra) {
      text(extra, 12, DIM)
    }
    x += 14
  }
  metric('CPU', s.cpu, hist.cpu, COLORS.cpu, false)
  if (s.gpu) {
    metric('GPU', s.gpu.util, hist.gpu, COLORS.gpu, false, `${Math.round(s.gpu.temp)}°`)
    metric('VRAM', s.gpu.vram_pct, hist.vram, COLORS.vram, s.gpu.vram_pct > L.vram_pct)
  }
  metric('RAM', s.ram_pct, hist.ram, COLORS.ram, s.ram_pct > 90)
  s.disks.forEach((d, i) => {
    if (i) x += 8
    text(d.d, 12, DIM)
    x += 4
    text(String(Math.round(d.free_gb)), 14, d.free_gb < L.disk_gb ? BAD : FG, true)
  })
  x += 4
  text('ГБ', 12, DIM)
  x += 12
  out += `<line x1="${r1(x)}" y1="7" x2="${r1(x)}" y2="23" stroke="#ffffff" stroke-opacity="0.15"/>`
  x += 12
  const chatsBad = info.chats > L.chats
  text('чаты', 12, chatsBad ? BAD : DIM)
  x += 5
  text(String(info.chats), 16, chatsBad ? BAD : FG, true)
  x += 12
  text(info.perHour, 14, FG, true)
  x += 2
  text('/ч', 12, DIM)
  x += 14
  const bridgeW = info.frames !== null ? 70 : 0
  // the job gets what is left; it goes first when the row is short, then "today"
  const todayT = `сегодня ${info.today}`
  if (W - x - bridgeW - tw(todayT, 12) > 120) {
    text(todayT, 12, DIM)
    x += 14
  }
  const room = W - x - bridgeW - 4
  if (info.job && room > 90) {
    let t = (info.jobHeavy ? '● ' : '') + info.job
    while (t.length > 4 && tw(t, 13) > room) t = t.slice(0, -2) + '…'
    text(t, 13, info.jobHeavy ? '#d29922' : FG)
    x += 14
  }
  if (info.frames !== null && W - x >= 60) {
    text('мост', 12, DIM)
    x += 5
    text(String(info.frames), 14, info.frames ? '#3fb950' : BAD, true)
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">${out}</svg>`
}

/** The expanded view's chart: the four lines over the last minute, with a legend and a time axis. */
export function chart(s: Snap, hist: Hist): string {
  const W = 1200
  const H = 120
  const pad = { l: 34, r: 10, t: 26, b: 18 }
  const w = W - pad.l - pad.r
  const h = H - pad.t - pad.b
  let out = `<rect x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" rx="10" ${CARD}/>`
  for (const p of [0, 50, 100]) {
    const y = r1(pad.t + h - (p / 100) * h)
    out += `<line x1="${pad.l}" y1="${y}" x2="${W - pad.r}" y2="${y}" stroke="#ffffff" stroke-opacity="${p === 0 ? 0.15 : 0.06}"/>`
    out += `<text x="${pad.l - 6}" y="${r1(Number(y) + 4)}" font-size="10" fill="${DIM}" text-anchor="end" ${FONT}>${p}</text>`
  }
  const series: [keyof Hist, string, string, number | null][] = [
    ['cpu', 'CPU', COLORS.cpu, s.cpu],
    ['gpu', 'GPU', COLORS.gpu, s.gpu ? s.gpu.util : null],
    ['vram', 'VRAM', COLORS.vram, s.gpu ? s.gpu.vram_pct : null],
    ['ram', 'RAM', COLORS.ram, s.ram_pct],
  ]
  let lx = pad.l
  for (const [key, label, color, now] of series) {
    if (now === null) continue
    const v = hist[key].slice(-60)
    if (v.length > 1) {
      const step = w / 59
      const x0 = pad.l + w - step * (v.length - 1)
      const pts = v.map((p, i) => `${r1(x0 + i * step)},${r1(pad.t + h - (Math.max(0, Math.min(100, p)) / 100) * h)}`)
      out += `<path d="M${pts.join(' L')}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round"/>`
    }
    out += `<circle cx="${lx + 5}" cy="13" r="4" fill="${color}"/>`
    out += `<text x="${lx + 14}" y="17" font-size="12" fill="${FG}" ${FONT}>${label} <tspan font-weight="600">${Math.round(now)}%</tspan></text>`
    lx += 110
  }
  out += `<text x="${pad.l}" y="${H - 4}" font-size="10" fill="${DIM}" ${FONT}>60 с назад</text>`
  out += `<text x="${W - pad.r}" y="${H - 4}" font-size="10" fill="${DIM}" text-anchor="end" ${FONT}>сейчас</text>`
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">${out}</svg>`
}
