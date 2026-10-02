declare module 'claude-code' {
  interface PluginState {
    'replay-theater': {
      // 直前に編集があったターンの編集（1 件 = 1 ステップ）と、ペインで見ている位置（0 始まり）
      replay: {
        steps: Array<{
          tool: string
          file: string
          note: string
          diff: Array<{ op: string; t: string }>
        }>
        index: number
      }
    }
  }
}
