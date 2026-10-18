#!/usr/bin/env node
// テスト用の偽 claude。受け取った引数と標準入力を FAKE_LOG に書き、FAKE_MODE に応じた結果を返す。
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'

const stdin = readFileSync(0, 'utf8')
appendFileSync(process.env.FAKE_LOG, JSON.stringify({ args: process.argv.slice(2), stdin, cwd: process.cwd() }) + '\n')

const counter = process.env.FAKE_COUNTER
let n = 0
if (counter) {
  try {
    n = Number(readFileSync(counter, 'utf8'))
  } catch {}
  writeFileSync(counter, String(n + 1))
}

const mode = (process.env.FAKE_MODE || 'ok').split(',')[Math.min(n, (process.env.FAKE_MODE || 'ok').split(',').length - 1)]
if (mode === 'limit') {
  process.stdout.write(JSON.stringify({ type: 'result', is_error: true, result: `Claude AI usage limit reached|${process.env.FAKE_RESET}` }))
} else if (mode === 'crash') {
  process.stderr.write('boom')
  process.exit(1)
} else {
  process.stdout.write(JSON.stringify({ type: 'result', is_error: false, result: process.env.FAKE_RESULT || 'done' }))
}
