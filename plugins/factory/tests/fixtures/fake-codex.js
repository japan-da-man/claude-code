#!/usr/bin/env node
// テスト用の偽 codex。引数と標準入力を FAKE_LOG に書き、-o のファイルに FAKE_RESULT を書く。
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'

const args = process.argv.slice(2)
const stdin = readFileSync(0, 'utf8')
appendFileSync(process.env.FAKE_LOG, JSON.stringify({ args, stdin, cwd: process.cwd() }) + '\n')

if (process.env.FAKE_MODE === 'limit') {
  process.stderr.write("ERROR: You've hit your usage limit. Try again later.\n")
  process.exit(1)
}
if (process.env.FAKE_MODE === 'crash') {
  process.stderr.write('ERROR: boom\n')
  process.exit(1)
}
writeFileSync(args[args.indexOf('-o') + 1], process.env.FAKE_RESULT || 'done')
