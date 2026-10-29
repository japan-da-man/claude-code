// テストで使う、必ずある役割がそろった最小のトークンとアプリのリポジトリ。
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { NS, REQUIRED } from '../scripts/check.mjs'

export const hex = (h, alpha) => {
  const c = [1, 3, 5].map((i) => Number((parseInt(h.slice(i, i + 2), 16) / 255).toFixed(4)))
  return { colorSpace: 'srgb', components: c, ...(alpha === undefined ? {} : { alpha }), hex: h }
}

const px = (value) => ({ value, unit: 'px' })

// base の必ずある役割を、すべて同じ値で埋めたトークン。色は白い背景に黒い文字。
export function minimalTokens(base = 'hig', { from = ['D1'] } = {}) {
  const r = REQUIRED[base]
  const meta = { $extensions: { [NS]: { from } } }
  const color = { $type: 'color', ...meta }
  for (const name of r.color) color[name] = { $value: hex(/background|^card$|^popover$|^muted$|^secondary$|^accent$|^primary$|^input$|^border$|^ring$|^fill|^separator$|^tint$/.test(name) ? '#ffffff' : '#000000') }
  const font = { $type: 'typography', ...meta }
  for (const name of r.font) font[name] = { $value: { fontFamily: 'system-ui', fontSize: px(17), fontWeight: 400, lineHeight: 1.3, letterSpacing: px(0) }, $extensions: { [NS]: { textStyle: name } } }
  const group = (type, names, value) => ({ $type: type, ...meta, ...Object.fromEntries(names.map((n) => [n, { $value: value }])) })
  return {
    primitive: { space: { $type: 'dimension', 4: { $value: px(4) } } },
    color,
    font,
    space: { $type: 'dimension', ...meta, ...Object.fromEntries(r.space.map((n) => [n, { $value: '{primitive.space.4}' }])) },
    radius: group('dimension', r.radius, px(8)),
    shadow: group('shadow', r.shadow, { color: hex('#000000', 0.1), offsetX: px(0), offsetY: px(1), blur: px(2), spread: px(0) }),
    duration: group('duration', r.duration, { value: 150, unit: 'ms' }),
    easing: group('cubicBezier', r.easing, [0.2, 0, 0, 1]),
  }
}

export function tempRepo(files) {
  const repo = mkdtempSync(join(tmpdir(), 'product-design-'))
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(repo, path)), { recursive: true })
    writeFileSync(join(repo, path), typeof content === 'string' ? content : JSON.stringify(content, null, 2))
  }
  return repo
}

export const config = (extra = {}) => ({
  version: 2,
  ds_version: '1.0.0',
  base: 'hig',
  stages: { product: 'approved', design: 'approved', foundations: 'approved', components: 'approved', outputs: 'pending' },
  product_principles: 'docs/product/principles.md',
  docs: ['design-system/README.md', 'design-system/principles.md', 'design-system/foundations.md', 'design-system/patterns.md', 'design-system/copy.md'],
  components: 'design-system/components',
  tokens: 'design-system/tokens.json',
  candidates: 'docs/design-candidates',
  outputs: { html: { code: 'design-system/html' } },
  protected_paths: ['design-system/**', 'docs/product/principles.md'],
  check: { command: 'node design-system/check.mjs', exclude: [] },
  ...extra,
})

// 根拠がすべてつながった、通るリポジトリの中身。
export function validRepoFiles(base = 'hig') {
  const rule = '## 色\n根拠: D1\n\n本文。\n'
  return {
    'design-system/design-system.json': config({ base }),
    'design-system/tokens.json': minimalTokens(base),
    'docs/product/principles.md': '# プロダクトの原則\n\n### P1 速さを優先する\n\n本文。\n',
    'design-system/principles.md': '# デザインの原則\n\n### D1 1 画面に目的は 1 つ\n根拠: P1\n\nだから、…\n',
    'design-system/foundations.md': `# 基礎\n\n${rule}`,
    'design-system/patterns.md': `# パターン\n\n${rule}`,
    'design-system/copy.md': `# 文言\n\n${rule}`,
    'design-system/components/button.md': '---\nname: button\nstatus: stable\nfrom: [D1]\noutputs: { swiftui: DSButton, expo: Button, html: button }\n---\n\n# ボタン\n',
  }
}
