declare module 'claude-code' {
  interface PluginState {
    'token-weather': {
      // 直近ターンの使用率（%）、最新の計測値、直前のターンでの増減
      weather: {
        history: number[]
        context: { tokens: number; window: number; percent: number } | null
        delta: number | null
      }
    }
  }
}
