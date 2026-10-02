// TODO パネル: /todo で開き、チェックを入れたタスクを Claude に依頼する
const PANE = 'todo'

// { id, text, done } の配列。$.store に保存して次のセッションでも残す
let todos = []

export function register(on) {
  // セッション開始時（とリロード時）: 保存済みの TODO を読み込み、/todo を登録
  on('session.start', async ($, e, next) => {
    const saved = await $.store.get('todos')
    if (Array.isArray(saved)) todos = saved
    // コマンド登録は最後に（失敗するとフックの残りが動かないため）
    await $.command.register({ name: 'todo', description: 'TODO パネルを開く', immediate: true })
    return next(e)
  })

  // /todo: パネルを開くだけで、トランスクリプトには何も出さない
  on('command.run', { command: 'todo' }, async ($) => {
    await $.ui.open({ id: PANE, title: 'TODO', focus: true, closeOnEscape: true })
    return {}
  })

  // パネルの中身を描く
  on('ui.render', { component: 'Pane' }, async ($, e, next) => {
    if (e.requestId !== PANE) return next(e)
    const { Box, Text, Button, Input } = $.ui.resolve(e)

    // 状態を変えたら再描画して保存する
    const save = async () => {
      $.ui.invalidate('ui.render')
      await $.store.set('todos', todos)
    }

    const rows = todos.map((t) =>
      Box({
        flexDirection: 'row',
        columnGap: 1,
        children: [
          // チェックボックス代わりのボタン
          Button({
            key: 'check-' + t.id,
            label: t.done ? '[x]' : '[ ]',
            plain: true,
            onPress: async () => {
              const wasDone = t.done
              todos = todos.map((x) => (x.id === t.id ? { ...x, done: !x.done } : x))
              await save()
              if (!wasDone) {
                $.ui.toast('Claude に依頼: ' + t.text)
                // await しない: Claude が作業中だとターンが終わるまで解決しないため
                $.prompt.submit({ text: '次の TODO を実行してください: ' + t.text })
              }
            },
          }),
          Text({ children: [t.text], dimColor: t.done }),
          // 削除ボタン
          Button({
            key: 'delete-' + t.id,
            label: '×',
            plain: true,
            onPress: async () => {
              todos = todos.filter((x) => x.id !== t.id)
              await save()
            },
          }),
        ],
      }),
    )

    return Box({
      flexDirection: 'column',
      children: [
        Input({
          key: 'new-todo',
          label: 'TODO',
          placeholder: 'タスクを入力して Enter',
          value: '',
          submitLabel: '追加',
          autoFocus: true,
          onSubmit: async (value) => {
            const text = value.trim()
            if (!text) return
            todos = [...todos, { id: String(Date.now()), text, done: false }]
            await save()
          },
        }),
        ...(rows.length ? rows : [Text({ dimColor: true, children: ['まだ TODO はありません'] })]),
        Text({ dimColor: true, children: ['Tab で移動 · Enter でチェック → Claude が実行 · Esc で閉じる'] }),
      ],
    })
  })
}
