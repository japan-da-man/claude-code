import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { artifactHash, checkSource, generateSwift, runCheck, stripCode } from '../scripts/check.mjs'

const rules = (src) => checkSource(src).violations.map((v) => `${v.line}:${v.rule}`)

test('comments and string contents are blanked but lines are kept', () => {
  const src = 'let a = "Color.red" // .padding(4)\n/* Button(\n */ let b = 1\nlet c = """\nToggle(\n"""\n'
  const out = stripCode(src)
  assert.equal(out.split('\n').length, src.split('\n').length)
  assert.doesNotMatch(out, /Color\.red|padding|Button|Toggle/)
  assert.match(out, /let b = 1/)
})

test('hard-coded colors are caught, tokens are not', () => {
  assert.deepEqual(rules('Text("a").foregroundStyle(.red)'), ['1:color'])
  assert.deepEqual(rules('Text("a")\n  .foregroundStyle(.secondary)'), ['2:color'])
  assert.deepEqual(rules('let c = Color.blue'), ['1:color'])
  assert.deepEqual(rules('let c = Color(red: 1, green: 0, blue: 0)'), ['1:color'])
  assert.deepEqual(rules('let c = Color("Brand")'), ['1:color'])
  assert.deepEqual(rules('let c = UIColor.systemRed'), ['1:color'])
  assert.deepEqual(rules('.background(.blue.opacity(0.2))'), ['1:color'])
  assert.deepEqual(rules('.tint(.orange)'), ['1:color'])
  assert.deepEqual(rules('Text("a").foregroundStyle(DS.Color.textSecondary)'), [])
  assert.deepEqual(rules('.background(DS.Color.surface)'), [])
  assert.deepEqual(rules('.background(Color.clear)'), [])
  assert.deepEqual(rules('DSButton("追加", kind: .primary) {}'), [])
})

test('fonts other than DS.Font are caught', () => {
  assert.deepEqual(rules('Text("a").font(.caption)'), ['1:font'])
  assert.deepEqual(rules('Text("a").font(.system(size: 13))'), ['1:font'])
  assert.deepEqual(rules('Text("a").fontWeight(.bold)'), ['1:font'])
  assert.deepEqual(rules('Text("a").bold()'), ['1:font'])
  assert.deepEqual(rules('let f = Font.title'), ['1:font'])
  assert.deepEqual(rules('let f = UIFont.preferredFont(forTextStyle: .body)'), ['1:font'])
  assert.deepEqual(rules('Text("a").font(DS.Font.caption)'), [])
  assert.deepEqual(rules('Text("a").font( DS.Font.caption )'), [])
  assert.equal(checkSource('Text("a").font(.caption)').violations[0].text, '.font(.caption')
})

test('numeric spacing and radius are caught, zero and tokens are not', () => {
  assert.deepEqual(rules('.padding(12)'), ['1:spacing'])
  assert.deepEqual(rules('.padding(.horizontal, 8)'), ['1:spacing'])
  assert.deepEqual(rules('VStack(spacing: 8) {}'), ['1:spacing'])
  assert.deepEqual(rules('.cornerRadius(10)'), ['1:spacing'])
  assert.deepEqual(rules('RoundedRectangle(cornerRadius: 12.5)'), ['1:spacing'])
  assert.deepEqual(rules('.padding(EdgeInsets(top: 4, leading: 0, bottom: 4, trailing: 0))'), ['1:spacing'])
  assert.deepEqual(rules('.lineSpacing(2)'), ['1:spacing'])
  assert.deepEqual(rules('VStack(spacing: 0) {}'), [])
  assert.deepEqual(rules('.padding()'), [])
  assert.deepEqual(rules('.padding(.horizontal, DS.Space.space4)'), [])
  assert.deepEqual(rules('RoundedRectangle(cornerRadius: DS.Radius.radiusMd)'), [])
})

test('raw controls are caught, design system parts are not', () => {
  assert.deepEqual(rules('Button("追加", action: add)'), ['1:control'])
  assert.deepEqual(rules('Button {\n} label: {}'), ['1:control'])
  assert.deepEqual(rules('TextField("メモ", text: $t)'), ['1:control'])
  assert.deepEqual(rules('SecureField("p", text: $t)'), ['1:control'])
  assert.deepEqual(rules('TextEditor(text: $t)'), ['1:control'])
  assert.deepEqual(rules('Toggle("x", isOn: $b)'), ['1:control'])
  assert.deepEqual(rules('Picker("x", selection: $s) {}'), ['1:control'])
  assert.deepEqual(rules('SwiftUI.Button("x") {}'), ['1:control'])
  assert.deepEqual(rules('DSButton("追加") {}\nDSTextField("メモ", text: $t)\nlet b: Button<Text>? = nil'), [])
})

test('an allow comment on the line or the line before lets it through and is counted', () => {
  const r = checkSource('// design-system: allow color 地図の線はブランドの色にしない\nlet c = Color.blue\n.padding(3) // design-system: allow spacing 微調整\n.padding(5)')
  assert.deepEqual(r.violations.map((v) => `${v.line}:${v.rule}`), ['4:spacing'])
  assert.equal(r.allowed, 2)
})

test('an allow comment only covers the rule it names', () => {
  assert.deepEqual(rules('// design-system: allow font x\nlet c = Color.blue'), ['2:color'])
})

test('each violation says what to use instead', () => {
  const [v] = checkSource('Text("a").foregroundStyle(.red)').violations
  assert.equal(v.text, '.foregroundStyle(.red')
  assert.match(v.hint, /DS\.Color/)
})

const starter = readFileSync(new URL('../templates/tokens.json', import.meta.url), 'utf8')

function makeRepo() {
  const repo = mkdtempSync(join(tmpdir(), 'ds-check-'))
  mkdirSync(join(repo, 'design-system', 'screenshots'), { recursive: true })
  mkdirSync(join(repo, 'App', 'DesignSystem'), { recursive: true })
  mkdirSync(join(repo, 'AppTests'), { recursive: true })
  const config = {
    version: 1,
    platform: 'ios',
    docs: ['design-system/README.md'],
    tokens: 'design-system/tokens.json',
    ios: { code: 'App/DesignSystem', sources: ['App', 'AppTests'] },
    protected_paths: ['design-system/**', 'App/DesignSystem/**'],
    check: { command: 'node design-system/check.mjs' },
  }
  writeFileSync(join(repo, 'design-system', 'design-system.json'), JSON.stringify(config, null, 2))
  writeFileSync(join(repo, 'design-system', 'tokens.json'), starter)
  writeFileSync(join(repo, 'design-system', 'README.md'), '# App\n')
  writeFileSync(join(repo, 'App', 'DesignSystem', 'Tokens.swift'), generateSwift(JSON.parse(starter)))
  writeFileSync(join(repo, 'App', 'DesignSystem', 'DSButton.swift'), 'Button(title) {}.foregroundStyle(.red)\n')
  writeFileSync(join(repo, 'AppTests', 'AppTests.swift'), 'let c = Color.red\n')
  writeFileSync(join(repo, 'App', 'ContentView.swift'), 'DSButton("追加") {}\n')
  return repo
}

test('a clean repo passes; the design system folder and tests are not checked', () => {
  const r = runCheck(makeRepo())
  assert.equal(r.ok, true)
  assert.deepEqual(r.violations, [])
  assert.deepEqual(r.stale, [])
})

test('violations carry the path relative to the repo', () => {
  const repo = makeRepo()
  writeFileSync(join(repo, 'App', 'ContentView.swift'), 'DSButton("追加") {}\nText("a").font(.caption)\n')
  const r = runCheck(repo)
  assert.equal(r.ok, false)
  assert.deepEqual(r.violations.map((v) => `${v.file}:${v.line}:${v.rule}`), ['App/ContentView.swift:2:font'])
})

test('Tokens.swift that no longer matches tokens.json fails, and bad tokens fail', () => {
  const repo = makeRepo()
  writeFileSync(join(repo, 'App', 'DesignSystem', 'Tokens.swift'), '// old\n')
  const r = runCheck(repo)
  assert.equal(r.ok, false)
  assert.match(r.violations[0].hint, /Tokens\.swift/)
  writeFileSync(join(repo, 'design-system', 'tokens.json'), '{"name":"x"}')
  assert.equal(runCheck(repo).violations.some((v) => v.rule === 'tokens'), true)
})

test('an Artifact copied from older files is reported as stale but does not fail', () => {
  const repo = makeRepo()
  const file = join(repo, 'design-system', 'design-system.json')
  const config = JSON.parse(readFileSync(file, 'utf8'))
  config.artifact = { url: 'https://claude.ai/artifact/x', hash: artifactHash(repo, config) }
  writeFileSync(file, JSON.stringify(config))
  assert.deepEqual(runCheck(repo).stale, [])
  writeFileSync(join(repo, 'design-system', 'README.md'), '# App 2\n')
  const r = runCheck(repo)
  assert.equal(r.ok, true)
  assert.match(r.stale.join('\n'), /Artifact/)
})

test('the hash covers tokens, docs and screenshots but not the config itself', () => {
  const repo = makeRepo()
  const config = JSON.parse(readFileSync(join(repo, 'design-system', 'design-system.json'), 'utf8'))
  const before = artifactHash(repo, config)
  writeFileSync(join(repo, 'design-system', 'design-system.json'), '{}')
  assert.equal(artifactHash(repo, config), before)
  writeFileSync(join(repo, 'design-system', 'screenshots', 'colors-light.png'), 'png')
  assert.notEqual(artifactHash(repo, config), before)
})

test('the copied check.mjs runs on its own from the repo and exits 1 on violations', () => {
  const repo = makeRepo()
  copyFileSync(fileURLToPath(new URL('../scripts/check.mjs', import.meta.url)), join(repo, 'design-system', 'check.mjs'))
  const ok = spawnSync(process.execPath, ['design-system/check.mjs'], { cwd: repo, encoding: 'utf8' })
  assert.equal(ok.status, 0, ok.stderr)
  writeFileSync(join(repo, 'App', 'ContentView.swift'), 'Button("x") {}\n')
  const ng = spawnSync(process.execPath, [join(repo, 'design-system', 'check.mjs'), '--json'], { cwd: tmpdir(), encoding: 'utf8' })
  assert.equal(ng.status, 1)
  assert.equal(JSON.parse(ng.stdout).violations[0].file, 'App/ContentView.swift')
  const text = spawnSync(process.execPath, ['design-system/check.mjs'], { cwd: repo, encoding: 'utf8' })
  assert.match(text.stdout, /App\/ContentView\.swift:1 control/)
})
