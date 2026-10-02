declare module 'claude-code' {
  interface PluginState {
    'token-weather': {
      // 直近のターンの計測値（古い順）
      readings: Array<{ tokens: number; window: number; percent: number }>
    }
  }
}
