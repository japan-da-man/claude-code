// harness-note の引数の読み方。ガード（guard-harness.mjs）も同じ読み方で --session を確かめるので、ここに 1 つだけ置く。
export class UsageError extends Error {}

export const BOOLEAN_FLAGS = new Set(['json', 'keep-cause', 'help'])

// --name value と --name=value を読む。BOOLEAN_FLAGS は値を取らない。同じオプションは重ねられる。
export function parseArgs(argv) {
  const positional = []
  const flags = {}
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg.startsWith('--') && arg.length > 2) {
      let name = arg.slice(2)
      let value
      const eq = name.indexOf('=')
      if (eq >= 0) {
        value = name.slice(eq + 1)
        name = name.slice(0, eq)
      } else if (BOOLEAN_FLAGS.has(name)) {
        value = true
      } else {
        value = argv[++i]
        if (value === undefined) throw new UsageError(`--${name} の値がありません`)
      }
      ;(flags[name] ??= []).push(value)
    } else {
      positional.push(arg)
    }
  }
  return { positional, flags }
}
