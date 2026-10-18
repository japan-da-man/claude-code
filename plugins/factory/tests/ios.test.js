import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { commands, findApp, resolveDevice } from '../line/adapters/ios.js'

const simctl = {
  devices: {
    'com.apple.CoreSimulator.SimRuntime.iOS-26-2': [
      { name: 'iPhone 17', udid: 'OLD', isAvailable: true },
      { name: 'iPhone Air', udid: 'AIR', isAvailable: true },
    ],
    'com.apple.CoreSimulator.SimRuntime.iOS-26-5': [{ name: 'iPhone 17', udid: 'NEW', isAvailable: true }],
    'com.apple.CoreSimulator.SimRuntime.iOS-26-10': [{ name: 'iPhone 17', udid: 'BROKEN', isAvailable: false }],
  },
}

test('the newest available runtime wins when names repeat', () => {
  assert.equal(resolveDevice(simctl, 'iPhone 17'), 'NEW')
  assert.equal(resolveDevice(simctl, 'iPhone Air'), 'AIR')
  assert.throws(() => resolveDevice(simctl, 'iPhone 99'), /iPhone 99/)
})

const config = { ios: { project: 'App.xcodeproj', scheme: 'App', prebuild: null } }

test('build and test target the simulator by udid and keep derived data outside the repo', () => {
  const repo = mkdtempSync(join(tmpdir(), 'factory-ios-'))
  const c = commands({ config, repo, udid: 'NEW', derived: '/tmp/d' })
  assert.equal(c.prebuild, null)
  assert.equal(c.build, "xcodebuild build -project 'App.xcodeproj' -scheme 'App' -destination 'platform=iOS Simulator,id=NEW' -derivedDataPath '/tmp/d'")
  assert.equal(c.test, c.build.replace('xcodebuild build', 'xcodebuild test'))
})

test('a project.yml means the project is generated with xcodegen first', () => {
  const repo = mkdtempSync(join(tmpdir(), 'factory-ios-'))
  writeFileSync(join(repo, 'project.yml'), 'name: App\n')
  assert.equal(commands({ config, repo, udid: 'U', derived: '/tmp/d' }).prebuild, 'xcodegen generate')
  assert.equal(commands({ config: { ios: { ...config.ios, prebuild: 'make gen' } }, repo, udid: 'U', derived: '/tmp/d' }).prebuild, 'make gen')
})

test('the built app is found under the derived data products', () => {
  const derived = mkdtempSync(join(tmpdir(), 'factory-derived-'))
  const products = join(derived, 'Build', 'Products', 'Debug-iphonesimulator')
  mkdirSync(join(products, 'App.app'), { recursive: true })
  mkdirSync(join(products, 'AppTests.xctest'), { recursive: true })
  assert.equal(findApp(derived), join(products, 'App.app'))
  assert.throws(() => findApp(mkdtempSync(join(tmpdir(), 'factory-derived-'))), /\.app/)
})
