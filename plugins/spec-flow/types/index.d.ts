declare module 'claude-code' {
  interface PluginState {
    'spec-flow': {
      // docs/specs/*/progress.json の要約（更新の新しい順）
      specs: Array<{
        id: string
        title: string
        updatedAt: string
        chosen: string | null
        steps: Array<{ id: string; label: string; status: string; file: string }>
      }>
    }
  }
}
