declare module 'claude-code' {
  interface PluginState {
    'replay-theater': {
      // 直前のターンの編集。step は今ペインで見ている位置（0 始まり）
      replay: {
        edits: Array<{
          path: string
          tool: string
          lines: Array<{ kind: 'add' | 'del' | 'ctx' | 'gap'; text: string }>
          added: number
          removed: number
        }>
        step: number
      }
    }
  }
}
