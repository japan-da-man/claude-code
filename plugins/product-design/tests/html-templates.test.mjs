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

// HTML の中の CSS（<style> と style 属性）。
const cssInHtml = (html) => [...html.matchAll(/<style>([\s\S]*?)<\/style>/g), ...html.matchAll(/style="([^"]*)"/g)].map((m) => m[1]).join('\n')
const declared = (css) => new Set([...css.matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]))

// 余白・角丸・文字に、数の直書きを使わない（線の太さの 1px・2px と、丸い端の 999px は許す）。
const SIZED = /(?:^|[;{\s])((?:margin|padding|inset)[\w-]*|gap|row-gap|column-gap|border-radius|font|font-size|letter-spacing|line-height)\s*:\s*([^;}]*)/g
const LITERAL = /(?<![\w.-])(?!0(?:px|rem|em)?\b)(?!(?:1|2|999)px\b)\d+(?:\.\d+)?(?:px|rem|em)\b/

function problems(css) {
  const out = []
  if (/#[0-9a-fA-F]{3,8}\b/.test(css)) out.push('色の直書き（#…）')
  if (/\b(?:rgba?|hsla?|oklch|oklab|lab|lch|color)\(/.test(css)) out.push('色の関数の直書き')
  for (const [, prop, value] of css.matchAll(SIZED)) if (LITERAL.test(value)) out.push(`${prop} の値の直書き（${value.trim()}）`)
  return out
}

for (const base of ['hig', 'shadcn']) {
  const files = pickForBase(HTML, base)
  const css = [...files].filter(([k]) => k.endsWith('.css'))
  const html = [...files].filter(([k]) => k.endsWith('.html'))
  const known = new Set([...declared(generateCss(tokensOf(base))), ...css.flatMap(([, f]) => [...declared(read(f))]), ...html.flatMap(([, f]) => [...declared(cssInHtml(read(f)))])])

  test(`${base}: every var() in the HTML templates is a token or a variable they declare`, () => {
    for (const [name, f] of [...css, ...html]) {
      const text = name.endsWith('.html') ? cssInHtml(read(f)) : read(f)
      for (const [, v] of text.matchAll(/var\((--[\w-]+)/g)) assert.ok(known.has(v), `${name}: ${v} は tokens.css にもひな形にもありません`)
    }
  })

  test(`${base}: the HTML templates write no colours or sizes by hand`, () => {
    for (const [name, f] of [...css, ...html]) {
      const text = name.endsWith('.html') ? cssInHtml(read(f)) : read(f).replace(/\/\*[\s\S]*?\*\//g, '')
      assert.deepEqual(problems(text), [], name)
    }
  })

  test(`${base}: HTML classes all start with ds- and the only script is theme.js`, () => {
    for (const [name, f] of html) {
      const text = read(f)
      for (const [, list] of text.matchAll(/class="([^"]*)"/g)) for (const c of list.split(/\s+/).filter(Boolean)) assert.match(c, /^ds-/, `${name}: クラス ${c}`)
      for (const [tag] of text.matchAll(/<script\b[^>]*>/g)) assert.match(tag, /^<script src="(?:\.\.\/)?theme\.js">$/, `${name}: ${tag}`)
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
