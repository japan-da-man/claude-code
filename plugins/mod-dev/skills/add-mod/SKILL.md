---
name: add-mod
description: Build a new Claude Code mod (a plugin with a hooks module that draws a pane, a band above the prompt, a status line, or adds a command or tool hook) with tests. Use when asked to make, add or build a mod. Inside a plugin marketplace repository it also registers the mod there; elsewhere it creates a standalone mod to load with --plugin-dir.
---

# Add a mod

A mod is a Claude Code plugin whose `hooks/hooks.json` names a hooks module. This skill covers the layout, the tests and the registration around the module. For the mods API itself (events, `$` methods, elements, render sites), load the built-in `plugin-authoring` skill and read the type declarations it points to. Trust those types over memory: they match the running Claude Code.

## 0. Find out where you are

Look for `.claude-plugin/marketplace.json` in the working directory or its git root.

- **Found: marketplace mode.** Read it and one existing plugin in it, and follow that repository's conventions where they differ from the defaults below: where plugins live (the `source` paths, often `plugins/<name>`), whether `plugin.json` sets `version`, the `author` and `repository` fields, the comment language, the test style. Check whether one plugin is a bundle (a `plugin.json` with only `dependencies`): if so, the new mod joins it. Check the README for a plugin table.
- **Not found: standalone mode.** Create the mod in a new `<name>/` folder in the working directory (or where the person says), and skip step 4.

Ask the person only for what you cannot infer: what the mod should do, and its name if they have not given one.

## 1. Pick the name

- kebab-case and permanent: users install it as `<name>@<marketplace>`
- must not start with `claude-` (validation refuses names that look like Anthropic's)
- must not clash with a built-in slash command, for any command it registers; type `/` in a session to see them

## 2. Create the plugin

```
<plugin dir>/
├── .claude-plugin/plugin.json
├── hooks/hooks.json
├── hooks/register.js
└── tests/<name>.test.ts
```

`plugin.json`:

```json
{
  "name": "<name>",
  "description": "<one line>"
}
```

Add `author`, `repository` and `version` the way the marketplace's other plugins do. Without `version`, a git-hosted marketplace treats every commit as a new version; with it, it must be raised on every release or users never get the update.

`hooks/hooks.json`:

```json
{
  "description": "<name> hooks module",
  "modules": ["./register.js"]
}
```

`hooks/register.js`:

- Plain ES module, `export function register(on)`. `.ts`, `.tsx` or `.jsx` also load directly, with no build step.
- Export the pure helpers (formatting, aggregation) next to `register` so tests can import them.
- Register slash commands last in `session.start` (a refused name throws and skips the rest of the hook), with `immediate: true` when they only open a pane or toggle something.
- A pane: the command calls `$.ui.open({ id, title, focus: true, closeOnEscape: true })` and returns `{}`; a `ui.render` hook on `{ component: 'Pane' }` checks `e.requestId`.
- The band above the prompt: a `ui.render` hook on `{ component: 'AbovePrompt' }`. Return `next(e)` when there is nothing to show, and keep other mods' band by putting `await next(e)` in a column `Box` under your line.
- Anything that must survive restarts goes in `$.store`. It is shared by every session on the machine: give each item its own key and read again right before writing.
- Call `$.ui.invalidate('ui.render')` after the data a drawing reads changes.
- Draw only elements both the terminal and the desktop app have (`Box`, `Text`, `Button`, `Input`, `Select`, `Markdown`, `Link`, `Code`) unless you check `e.surface`: `Raster` and `Image` are terminal only, `Svg` desktop only.
- Write every `$` call in full (`$.store.get(...)`, never `const s = $.store`), event names as string literals, and pass `$` only to top-level functions in the same file. `claude plugin validate` reads the source and refuses anything else.

## 3. Write tests

`claude plugin test`, run from the plugin directory, runs `tests/*.test.ts`. The test kit has no engine underneath, so stub every mods API call and event the mod reaches. Mods API calls answer with `{ value }`; events answer with their own result shape:

```ts
import { expect, test } from 'claude-code/testing'

function stubEngine(on) {
  const store = new Map()
  on('store.get', async ($, e) => ({ value: store.get(e.key) }))
  on('store.set', async ($, e) => (store.set(e.key, e.value), { value: undefined }))
  on('store.keys', async () => ({ value: [...store.keys()] }))
  on('command.register', async () => ({ value: undefined }))
  on('ui.open', async () => ({ value: { isPlaced: true } }))
  on('session.start', async ($, e) => ({ cwd: e.cwd }))
  // Only for a mod that calls next(e) at a render site: the engine's own empty drawing
  on('ui.render', async ($, e) => $.ui.resolve(e).Box({ children: [] }))
}
```

When a test fails with `no implementation for <event>`, add a stub for that event. Cover the pure helpers directly, then mount each drawing on both surfaces and find what it shows:

```ts
for (const surface of ['terminal', 'desktop'] as const) {
  test('draws on ' + surface, async ($, on) => {
    stubEngine(on)
    await $.session.start({ cwd: '/tmp' })
    const ui = await $.ui.mount({ plugin: '<name>', surface, component: 'Pane', requestId: '<pane id>', props: { title: '', isFocused: true, bodyColumns: 90, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} } })
    expect(await ui.find({ type: 'Text', text: '<something it shows>' })).toBeDefined()
  })
}
```

For the band, mount `component: 'AbovePrompt'` with props `{ hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 120, scroll: { offset: 0, bodyRows: 10 }, view: {} }`. A failing mount names the element or prop the surface refused: fix the tree, not the test.

## 4. Register it (marketplace mode)

1. Add an entry to `.claude-plugin/marketplace.json` `plugins`, with the same `name` as `plugin.json`, its description, and the `source` path in the repository's style.
2. If there is a bundle plugin, add the name to its `dependencies` and to its description if that lists the mods.
3. If the README has a plugin table, add a row in the README's language saying how to use the mod.

## 5. Check

```bash
claude plugin validate <plugin dir>
claude plugin test <plugin dir>
```

In marketplace mode, also `claude plugin validate .` at the repository root. A missing `version` is the only warning to leave, and only where the repository omits versions on purpose.

Loading a plugin writes `.claude-plugin/types/` and a `tsconfig.json` into it. Make sure `.gitignore` excludes them, and add the lines if it does not:

```
.claude-plugin/types/
plugins/*/.claude-plugin/types/
plugins/*/tsconfig.json
```

To see the mod in a real session: `claude --plugin-dir <plugin dir>`, which hot-reloads on save. An installed plugin of the same name conflicts with it, so say so if the person has it installed.

## 6. Hand over

Commit with a message that says what the mod does. Pushing and updating installed copies are the person's call: ask first. After a push, `claude plugin marketplace update <marketplace>` refreshes the catalog. `claude plugin update <bundle>@<marketplace>` does not install a dependency the bundle gained, and the bundle then fails to load (`claude plugin list` shows `failed to load`), so install the new mod itself with `claude plugin install <name>@<marketplace>` and update the others. Sessions started afterwards pick it up; the current one does not.
