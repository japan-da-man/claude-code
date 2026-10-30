// 見本のページの ?theme=dark か ?theme=light を data-theme にする（スクリーンショットと、ライトとダークの見比べのため）。
// 付けなければ、OS の設定（prefers-color-scheme）に従う。
const theme = new URLSearchParams(location.search).get('theme')
if (theme === 'dark' || theme === 'light') document.documentElement.dataset.theme = theme
