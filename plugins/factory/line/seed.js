// シナリオの前提のデータを、アプリに仕込む。
// アプリ側には DEBUG のときだけ動く口（起動引数 -FactorySeed <JSON を Base64 にしたもの> でデータを保存する）を /factory:init で用意し、
// データの形は .factory/seed.md に書く。シナリオは「前提」に ```json factory-seed のブロックでデータを書く。

// シナリオの factory-seed のブロックを読み、1 行の JSON にして返す。なければ null。
export function parseSeed(markdown, id = '') {
  const block = /```json[ \t]+factory-seed[ \t]*\n([\s\S]*?)```/.exec(markdown)?.[1]
  if (block === undefined) return null
  try {
    return JSON.stringify(JSON.parse(block))
  } catch (e) {
    throw new Error(`シナリオ ${id} の factory-seed の JSON が読めません: ${e.message}`)
  }
}

// 起動引数の値が { で始まると、iOS は文字列ではなく property list として読んでしまうので、Base64 にして渡す。
// アプリ側の口は Base64 を JSON に戻してから読む。
export function seedLaunchArgs({ udid, bundleId, seed }) {
  return ['simctl', 'launch', udid, bundleId, '-FactorySeed', Buffer.from(seed, 'utf8').toString('base64')]
}
