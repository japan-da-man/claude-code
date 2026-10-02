---
name: add-mod
description: Add a new mod (Claude Code plugin with a hooks module) to this japan-da-man marketplace repository. Use when asked to make, add or build a mod, pane, band, status line or command here, so the plugin, marketplace entry, bundle dependency, README row and tests are all created in this repo's layout.
---

# Add a mod to this repository

This repository is the `japan-da-man` plugin marketplace. Every mod lives in `plugins/<name>/` and is listed in `.claude-plugin/marketplace.json`. The `japan-da-man-mods` plugin is a bundle that depends on every mod, so one install brings them all.

For the mods API itself (events, `$` methods, elements, render sites), load the built-in `plugin-authoring` skill and read the type declarations it points to. Trust those types over memory: they match the running Claude Code.

## 1. Pick the name

- kebab-case, permanent (users install it as `<name>@japan-da-man`)
- must not start with `claude-`
- must not clash with a built-in slash command; type `/` in a session to check

## 2. Create the plugin

```
plugins/<name>/
├── .claude-plugin/plugin.json
├── hooks/hooks.json
├── hooks/register.js
└── tests/<name>.test.ts
```

`plugin.json`, with no `version` so every commit counts as a new version:

```json
{
  "name": "<name>",
  "description": "<one line, English>",
  "author": { "name": "japan-da-man" },
  "repository": "https://github.com/japan-da-man/claude-code"
}
```

`hooks/hooks.json`:

```json
{
  "description": "<name> hooks module",
  "modules": ["./register.js"]
}
```

`hooks/register.js` conventions used across this repo:

- Plain ES module JavaScript, `export function register(on)`. Comments in Japanese.
- Export the pure helpers (formatting, aggregation) next to `register` so tests can import them.
- Register slash commands last in `session.start`, with `immediate: true` when they only open a pane or toggle something.
- A pane: `/command` calls `$.ui.open({ id, title, focus: true, closeOnEscape: true })` and returns `{}`; a `ui.render` hook on `{ component: 'Pane' }` checks `e.requestId`.
- The band above the prompt: a `ui.render` hook on `{ component: 'AbovePrompt' }`. Return `next(e)` when there is nothing to show, and keep other mods' band by putting `await next(e)` in a column `Box` under your line.
- Keep anything that must survive restarts in `$.store`. It is shared by every session on the machine: give each item its own key and read again right before writing.
- Call `$.ui.invalidate('ui.render')` after data changes.
- Draw only elements both surfaces have (`Box`, `Text`, `Button`, `Input`, `Select`, `Markdown`, `Link`, `Code`) unless you check `e.surface`. `Raster` and `Image` are terminal only, `Svg` desktop only.

## 3. Write tests

Run with `claude plugin test` from `plugins/<name>`. The test kit has no engine underneath, so stub what the mod calls. Mods API calls answer with `{ value }`; events answer with their own result shape:

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
  // Only for a mod that calls next(e) in the band: the engine's own empty band
  on('ui.render', async ($, e) => $.ui.resolve(e).Box({ children: [] }))
}
```

Cover the pure helpers directly, then mount each drawing on both surfaces and find what it shows:

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

A failing mount names the element or prop the surface refused; fix the tree, not the test.

## 4. Register it

1. Add an entry to `.claude-plugin/marketplace.json` `plugins`, with the same `name` and `description` as `plugin.json` and `"source": "./plugins/<name>"`.
2. Add the name to `dependencies` in `plugins/japan-da-man-mods/.claude-plugin/plugin.json`, and update that plugin's description list.
3. Add a row to the plugin table in `README.md` (Japanese, say how to use it, e.g. the slash command).

## 5. Check

From the repo root:

```bash
claude plugin validate .
claude plugin validate ./plugins/<name>
```

From `plugins/<name>`:

```bash
claude plugin test
```

The only acceptable warning is the missing `version`. Loading the plugin writes `.claude-plugin/types/` and `tsconfig.json` into it; `.gitignore` already excludes them, so do not commit them.

To see it in a real session, start one with `claude --plugin-dir ./plugins/<name>` (hot-reloads on save). A plugin with the same name that is already installed conflicts with it, so mention that if the person has the bundle installed.

## 6. Hand over

Commit with a message that says what the mod does. Pushing and updating the installed copy are the person's call: ask, then run `git push`, `claude plugin marketplace update japan-da-man` and `claude plugin install japan-da-man-mods@japan-da-man` (re-installing the bundle installs any new dependency). New sessions pick it up; tell the person the current session does not.
