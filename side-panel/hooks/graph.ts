// The "PC now" tab's load cards as one SVG: CPU, GPU, VRAM and RAM, each with its value and the last minutes' line.
import type { Snap } from '../types'

const FONT = 'font-family="Segoe UI, system-ui, -apple-system, sans-serif"'
const DIM = '#8b949e'
const FG = '#e6edf3'
const BAD = '#f85149'
const CARD = 'fill="#ffffff" fill-opacity="0.045" stroke="#ffffff" stroke-opacity="0.09"'
const COLORS = { cpu: '#58a6ff', gpu: '#a371f7', vram: '#f0883e', ram: '#3fb950' } as const

export type Hist = { cpu: number[]; gpu: number[]; vram: number[]; ram: number[] }

const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const r1 = (n: number): string => (Math.round(n * 10) / 10).toString()

function line(vals: number[], x: number, y: number, w: number, h: number, color: string, slots: number): string {
  if (vals.length < 2) return ''
  const step = w / Math.max(1, slots - 1)
  const x0 = x + w - (vals.length - 1) * step
  const pts = vals.map((v, i) => `${r1(x0 + i * step)},${r1(y + h - (Math.max(0, Math.min(100, v)) / 100) * h)}`)
  return (
    `<path d="M${r1(x0)},${y + h} L${pts.join(' L')} L${r1(x + w)},${y + h} Z" fill="${color}" fill-opacity="0.14"/>` +
    `<path d="M${pts.join(' L')}" fill="none" stroke="${color}" stroke-width="1.6" stroke-linejoin="round"/>`
  )
}

/** Two rows of two cards; `width` in CSS pixels. */
/** `w`: the unit words of the panel's language. */
export function cards(s: Snap, hist: Hist, width: number, slots: number, w: { gb: string; watt: string; noGpu: string }): string {
  const W = Math.max(240, Math.round(width))
  const gap = 8
  const cw = (W - gap) / 2
  const ch = 64
  const H = ch * 2 + gap
  const g = s.gpu
  const list = [
    { k: 'cpu', label: 'CPU', pct: s.cpu, sub: '', bad: false, vals: hist.cpu },
    {
      k: 'gpu',
      label: 'GPU',
      pct: g ? g.util : 0,
      sub: g ? `${g.temp}°C${g.power ? ` · ${Math.round(g.power)} ${w.watt}` : ''}` : w.noGpu,
      bad: false,
      vals: hist.gpu,
    },
    {
      k: 'vram',
      label: 'VRAM',
      pct: g ? g.vram_pct : 0,
      sub: g ? `${(g.vram_used / 1024).toFixed(1)} / ${(g.vram_total / 1024).toFixed(0)} ${w.gb}` : '',
      bad: g ? g.vram_pct > s.limits.vram_pct : false,
      vals: hist.vram,
    },
    {
      k: 'ram',
      label: 'RAM',
      pct: s.ram_pct,
      sub: `${s.ram_used_gb} / ${s.ram_total_gb} ${w.gb}`,
      bad: s.ram_pct > 90,
      vals: hist.ram,
    },
  ] as const
  let out = ''
  list.forEach((c, i) => {
    const x = (i % 2) * (cw + gap)
    const y = Math.floor(i / 2) * (ch + gap)
    const color = c.bad ? BAD : COLORS[c.k]
    out += `<rect x="${r1(x + 0.5)}" y="${r1(y + 0.5)}" width="${r1(cw - 1)}" height="${ch - 1}" rx="9" ${CARD}${c.bad ? ` stroke="${BAD}" stroke-opacity="0.9"` : ''}/>`
    out += line(c.vals, x + 1, y + 37, cw - 2, ch - 38, color, slots)
    out += `<text x="${r1(x + 10)}" y="${y + 18}" ${FONT} font-size="11" fill="${DIM}">${c.label}</text>`
    out += `<text x="${r1(x + cw - 10)}" y="${y + 21}" ${FONT} font-size="17" font-weight="600" text-anchor="end" fill="${c.bad ? BAD : FG}">${Math.round(c.pct)}%</text>`
    if (c.sub) out += `<text x="${r1(x + 10)}" y="${y + 32}" ${FONT} font-size="10" fill="${DIM}">${esc(c.sub)}</text>`
  })
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">${out}</svg>`
}
