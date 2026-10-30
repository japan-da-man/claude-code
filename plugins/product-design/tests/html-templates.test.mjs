// HTML の出力のひな形の決まり。値は tokens.css の変数だけを使い、クラスは ds- だけ、スクリプトは theme.js だけ。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { generateCss, parseFrontMatter } from '../scripts/check.mjs'
import { componentTemplates, pickForBase } from '../scripts/cli.mjs'

const HTML = fileURLToPath(new URL('../templates/html', import.meta.url))
const read = (f) => readFileSync(f, 'utf8')
const tokensOf = (base) => JSON.parse(read(new URL(`../templates/tokens/${base}.json`, import.meta.url)))

// HTML の中の CSS（<style> の中と style 属性。属性は { } で包んで宣言として読めるようにする）。
const cssInHtml = (html) =>
  [...[...html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1]), ...[...html.matchAll(/\bstyle\s*=\s*(["'])([\s\S]*?)\1/gi)].map((m) => `{${m[2]}}`)].join('\n')
const declared = (css) => new Set([...css.matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]))
const usedVars = (css) => [...css.matchAll(/var\(\s*(--[\w-]+)/g)].map((m) => m[1])

// CSS の宣言（{ } の中の「性質: 値」）。@media の中も拾う。
const declarations = (css) =>
  [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/\{([^{}]*)\}/g)]
    .flatMap((m) => m[1].split(';'))
    .map((d) => /^\s*([\w-]+)\s*:\s*([\s\S]*?)\s*$/.exec(d))
    .filter(Boolean)
    .map(([, prop, value]) => [prop.toLowerCase(), value])

// 余白・角丸・文字の値に、0 以外の数を直に書かない（丸い端の 999px と円の 50% だけは角丸に許す）。
const SIZED = /^(?:(?:margin|padding|inset)(?:-[\w-]+)?|gap|row-gap|column-gap|border(?:-[\w-]+)?-radius|font|font-size|letter-spacing|line-height)$/
const NUMBER = /(?<![\w#.-])-?(?:\d+(?:\.\d+)?|\.\d+)(?:[a-z]+|%)?/gi
const NAMED_COLORS = /\b(?:red|white|black|blue|green|gray|grey|orange|yellow|purple|pink|brown|cyan|magenta|navy|teal|silver|gold|lime|maroon|olive|aqua|fuchsia|indigo|violet)\b/i

function problems(css) {
  const out = []
  for (const [prop, raw] of declarations(css)) {
    const value = raw.replace(/var\(\s*--[\w-]+\s*\)/g, ' ')
    if (/#[0-9a-f]{3,8}\b/i.test(value)) out.push(`${prop} の色の直書き（${raw}）`)
    if (/\b(?:rgba?|hsla?|hwb|oklch|oklab|lab|lch|color)\(/i.test(value)) out.push(`${prop} の色の関数の直書き（${raw}）`)
    if (NAMED_COLORS.test(value)) out.push(`${prop} の色の名前の直書き（${raw}）`)
    if (!SIZED.test(prop)) continue
    const allowed = /radius$/.test(prop) ? ['999px', '50%'] : []
    for (const [n] of value.matchAll(NUMBER)) if (!/^-?0+(?:\.0+)?(?:[a-z]+|%)?$/i.test(n) && !allowed.includes(n.toLowerCase())) out.push(`${prop} の値の直書き（${raw}）`)
  }
  return out
}

test('the checks catch hand-written colours and sizes, including the forms that slipped through before', () => {
  for (const css of ['.a { font-size: 0.875rem }', '.a { padding: .5rem }', '.a { margin: -8px }', '.a { letter-spacing: 0.5px }', '.a { font-size: 14pt }', '.a { line-height: 1.5 }', '.a { padding: 2px }', '.a { gap: 1PX }', '.a { border-radius: 2px }', '.a { color: red }', '.a { background: white }', '.a { color: hwb(0 0% 0%) }', '.a { background: color-mix(in srgb, red 50%, var(--x)) }', '@media (x) { .a { margin-top: 3px } }', '.a { color: #fff }']) {
    assert.notDeepEqual(problems(css), [], css)
  }
  for (const css of ['.a { padding: 0 var(--space-2) }', '.a { border-radius: 999px }', '.a { border-radius: 50% }', '.a { padding-right: calc(var(--space-8) + var(--space-3)) }', '.a { background: color-mix(in srgb, var(--tint) 15%, transparent) }', '.a { white-space: nowrap; min-height: 44px; font: var(--font-body) }']) {
    assert.deepEqual(problems(css), [], css)
  }
  assert.match(cssInHtml(`<style media="all">.a { color: red }</style><p style='margin: 3px'>`), /color: red[\s\S]*margin: 3px/)
  assert.deepEqual(usedVars('.a { color: var( --nope) }'), ['--nope'])
})

for (const base of ['hig', 'shadcn']) {
  const files = pickForBase(HTML, base)
  const css = [...files].filter(([k]) => k.endsWith('.css'))
  const html = [...files].filter(([k]) => k.endsWith('.html'))
  const known = new Set([...declared(generateCss(tokensOf(base))), ...css.flatMap(([, f]) => [...declared(read(f))]), ...html.flatMap(([, f]) => [...declared(cssInHtml(read(f)))])])

  test(`${base}: every var() in the HTML templates is a token or a variable they declare`, () => {
    for (const [name, f] of [...css, ...html]) {
      const text = name.endsWith('.html') ? cssInHtml(read(f)) : read(f)
      for (const v of usedVars(text)) assert.ok(known.has(v), `${name}: ${v} は tokens.css にもひな形にもありません`)
    }
  })

  test(`${base}: the HTML templates write no colours or sizes by hand`, () => {
    for (const [name, f] of [...css, ...html]) {
      const text = name.endsWith('.html') ? cssInHtml(read(f)) : read(f)
      assert.deepEqual(problems(text), [], name)
    }
  })

  test(`${base}: HTML classes all start with ds- and the only script is theme.js`, () => {
    for (const [name, f] of html) {
      const text = read(f)
      for (const [, list] of text.matchAll(/class="([^"]*)"/g)) for (const c of list.split(/\s+/).filter(Boolean)) assert.match(c, /^ds-/, `${name}: クラス ${c}`)
      for (const [tag] of text.matchAll(/<script\b[^>]*>/gi)) assert.match(tag, /^<script src="(?:\.\.\/)?theme\.js">$/, `${name}: ${tag}`)
      assert.doesNotMatch(text, /\son[a-z]+\s*=/i, `${name}: on… の属性でスクリプトを書かない`)
      assert.doesNotMatch(text, /javascript:/i, `${name}: javascript: を書かない`)
    }
  })

  test(`${base}: each component page has its stylesheet, a card group and a test id`, () => {
    for (const [name, f] of html.filter(([k]) => k.startsWith('components/'))) {
      const stem = name.slice('components/'.length, -'.html'.length)
      assert.ok(files.has(`components/${stem}.css`), `${stem}.css がありません`)
      const text = read(f)
      for (const href of ['../tokens.css', '../base.css', `${stem}.css`]) assert.ok(text.includes(`<link rel="stylesheet" href="${href}">`), `${name}: ${href}`)
      assert.match(text, /<main class="ds-page" data-group="[^"]+" data-height="\d+">/, `${name}: <main> の data-group と data-height`)
      assert.match(text, /data-testid="[^"]+"/, `${name}: 識別子の例`)
    }
  })
}

for (const base of ['hig', 'shadcn']) {
  test(`${base}: every component spec has its HTML page, and every page has a spec`, () => {
    const files = pickForBase(HTML, base)
    const named = [...componentTemplates(base).values()].map((f) => parseFrontMatter(read(f)).data.outputs.html).sort()
    const pages = [...files.keys()].filter((k) => /^components\/[^/]+\.html$/.test(k)).map((k) => k.slice(11, -5)).sort()
    assert.deepEqual(pages, named)
    for (const name of named) assert.ok(read(files.get('index.html')).includes(`href="components/${name}.html"`), `index.html に ${name} がありません`)
  })
}

test('a base-specific template replaces the shared one under the shared name', () => {
  assert.match(pickForBase(HTML, 'hig').get('base.css'), /base\.hig\.css$/)
  assert.match(pickForBase(HTML, 'shadcn').get('base.css'), /base\.shadcn\.css$/)
  assert.equal(pickForBase(HTML, 'hig').has('base.hig.css'), false)
})
