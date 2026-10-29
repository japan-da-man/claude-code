import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { artifactDone, artifactStage, install, status, writeTokens } from '../scripts/cli.mjs'

const CLI = fileURLToPath(new URL('../scripts/cli.mjs', import.meta.url))
const CHECK = fileURLToPath(new URL('../scripts/check.mjs', import.meta.url))
const SHOOT = fileURLToPath(new URL('../scripts/shoot.mjs', import.meta.url))

function makeRepo() {
  const repo = mkdtempSync(join(tmpdir(), 'ds-cli-'))
  mkdirSync(join(repo, 'design-system'), { recursive: true })
  mkdirSync(join(repo, 'App'), { recursive: true })
  const config = {
    version: 1,
    platform: 'ios',
    docs: ['design-system/README.md', 'design-system/components.md', 'design-system/copy.md', 'design-system/patterns.md'],
    tokens: 'design-system/tokens.json',
    ios: { project: 'App.xcodeproj', scheme: 'App', bundle_id: 'com.example.App', device: 'iPhone 17', code: 'App/DesignSystem', sources: ['App'], catalog_pages: ['colors'] },
    protected_paths: ['design-system/**', 'App/DesignSystem/**'],
    check: { command: 'node design-system/check.mjs' },
  }
  writeFileSync(join(repo, 'design-system', 'design-system.json'), JSON.stringify(config, null, 2))
  return repo
}

test('install copies check.mjs, the starter tokens, the docs and the Swift parts, and generates Tokens.swift', () => {
  const repo = makeRepo()
  const r = install(repo)
  assert.equal(readFileSync(join(repo, 'design-system', 'check.mjs'), 'utf8'), readFileSync(CHECK, 'utf8'))
  for (const f of ['tokens.json', 'README.md', 'components.md', 'copy.md', 'patterns.md']) assert.ok(existsSync(join(repo, 'design-system', f)), f)
  for (const f of ['Tokens.swift', 'Components/DSButton.swift', 'Catalog/DesignSystemCatalog.swift']) assert.ok(existsSync(join(repo, 'App', 'DesignSystem', f)), f)
  assert.ok(r.copied.includes('App/DesignSystem/Components/DSButton.swift'))
  assert.deepEqual(r.errors, [])
})

test('install never overwrites what the app already has, except check.mjs', () => {
  const repo = makeRepo()
  writeFileSync(join(repo, 'design-system', 'README.md'), '# mine\n')
  writeFileSync(join(repo, 'design-system', 'check.mjs'), '// old\n')
  mkdirSync(join(repo, 'App', 'DesignSystem', 'Components'), { recursive: true })
  writeFileSync(join(repo, 'App', 'DesignSystem', 'Components', 'DSButton.swift'), '// mine\n')
  const r = install(repo)
  assert.equal(readFileSync(join(repo, 'design-system', 'README.md'), 'utf8'), '# mine\n')
  assert.equal(readFileSync(join(repo, 'App', 'DesignSystem', 'Components', 'DSButton.swift'), 'utf8'), '// mine\n')
  assert.ok(r.skipped.includes('App/DesignSystem/Components/DSButton.swift'))
  assert.equal(readFileSync(join(repo, 'design-system', 'check.mjs'), 'utf8'), readFileSync(CHECK, 'utf8'))
})

test('tokens writes Tokens.swift only when tokens.json is valid', () => {
  const repo = makeRepo()
  install(repo)
  const swift = join(repo, 'App', 'DesignSystem', 'Tokens.swift')
  writeFileSync(swift, '// old\n')
  assert.deepEqual(writeTokens(repo), { written: 'App/DesignSystem/Tokens.swift', errors: [] })
  assert.match(readFileSync(swift, 'utf8'), /enum DS/)
  writeFileSync(join(repo, 'design-system', 'tokens.json'), '{"color":{"tokens":[]},"type":{"groups":[]},"spacing":{"tokens":[]},"radius":{"tokens":[]}}')
  writeFileSync(swift, '// kept\n')
  const r = writeTokens(repo)
  assert.equal(r.written, null)
  assert.ok(r.errors.length > 0)
  assert.equal(readFileSync(swift, 'utf8'), '// kept\n')
})

test('status adds an outdated check.mjs to what is stale', () => {
  const repo = makeRepo()
  install(repo)
  assert.deepEqual(status(repo).stale, [])
  writeFileSync(join(repo, 'design-system', 'check.mjs'), '// old\n')
  assert.match(status(repo).stale.join('\n'), /check\.mjs/)
})

test('install also vendors shoot.mjs, and status reports it when outdated', () => {
  const repo = makeRepo()
  assert.equal(install(repo).shoot, 'design-system/shoot.mjs')
  assert.equal(readFileSync(join(repo, 'design-system', 'shoot.mjs'), 'utf8'), readFileSync(SHOOT, 'utf8'))
  writeFileSync(join(repo, 'design-system', 'shoot.mjs'), '// old\n')
  assert.match(status(repo).stale.join('\n'), /shoot\.mjs/)
})

test('artifact-stage lays out the files under project/ and lists the screenshots to upload', () => {
  const repo = makeRepo()
  install(repo)
  mkdirSync(join(repo, 'design-system', 'screenshots'))
  writeFileSync(join(repo, 'design-system', 'screenshots', 'colors-light.png'), 'png')
  const dir = mkdtempSync(join(tmpdir(), 'ds-stage-'))
  const r = artifactStage(repo, dir)
  assert.deepEqual(Object.keys(r.files).sort(), ['project/README.md', 'project/components.md', 'project/copy.md', 'project/patterns.md', 'project/tokens.json'])
  assert.equal(readFileSync(join(dir, 'project', 'tokens.json'), 'utf8'), readFileSync(join(repo, 'design-system', 'tokens.json'), 'utf8'))
  // アップロードできるよう、画像も並べたフォルダ（スクラッチ）に写す
  assert.deepEqual(r.screenshots, [{ name: 'colors-light.png', path: join(dir, 'screenshots', 'colors-light.png'), size: 3 }])
  assert.equal(readFileSync(join(dir, 'screenshots', 'colors-light.png'), 'utf8'), 'png')
  assert.match(r.hash, /^[0-9a-f]{64}$/)
})

test('artifact-done records the url and the hash, so status stays clean until the files change', () => {
  const repo = makeRepo()
  install(repo)
  artifactDone(repo, 'https://claude.ai/artifact/abc')
  const config = JSON.parse(readFileSync(join(repo, 'design-system', 'design-system.json'), 'utf8'))
  assert.equal(config.artifact.url, 'https://claude.ai/artifact/abc')
  assert.deepEqual(status(repo).stale, [])
  writeFileSync(join(repo, 'design-system', 'copy.md'), '# changed\n')
  assert.match(status(repo).stale.join('\n'), /Artifact/)
})

test('the CLI prints JSON and exits 1 on a bad command', () => {
  const repo = makeRepo()
  const ok = spawnSync(process.execPath, [CLI, 'install', repo], { encoding: 'utf8' })
  assert.equal(ok.status, 0, ok.stderr)
  assert.ok(JSON.parse(ok.stdout).copied.length > 0)
  const st = spawnSync(process.execPath, [CLI, 'status', repo], { encoding: 'utf8' })
  assert.equal(JSON.parse(st.stdout).ok, true)
  const bad = spawnSync(process.execPath, [CLI, 'nope'], { encoding: 'utf8' })
  assert.equal(bad.status, 1)
  assert.match(bad.stderr, /install/)
})

test('a v2 config (product-design) is refused with exit code 2 and nothing is written', () => {
  const repo = makeRepo()
  const file = join(repo, 'design-system', 'design-system.json')
  const v2 = JSON.stringify({ version: 2, base: 'hig', tokens: 'design-system/tokens.json' })
  writeFileSync(file, v2)
  for (const command of ['install', 'tokens', 'status', 'screenshot', 'artifact-stage', 'artifact-done']) {
    const r = spawnSync(process.execPath, [CLI, command, repo, join(repo, 'out')], { encoding: 'utf8' })
    assert.equal(r.status, 2, command)
    assert.match(r.stderr, /product-design/)
  }
  assert.equal(existsSync(join(repo, 'design-system', 'check.mjs')), false)
  assert.equal(existsSync(join(repo, 'design-system', 'tokens.json')), false)
  assert.equal(readFileSync(file, 'utf8'), v2)
})
