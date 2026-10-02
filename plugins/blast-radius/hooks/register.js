// Copyright 2026 Anthropic PBC
// SPDX-License-Identifier: Apache-2.0
//
// Blast Radius: holds a risky Bash command and shows what it would change.
//
// tool.call (Bash): if the command is risky, work out its blast radius, open a
// pane with Proceed and Cancel, and hold the call until one is pressed.
// ui.render (Pane): draws the report. If the surface won't place the pane (a
// narrow terminal), the same report is drawn in the AbovePrompt band instead.
//
// Holding: a hook has 10 s of its own time, but time spent inside a `$` call is
// free. So the hold loop waits on a short `$.process.run(["sleep", ...])` until
// a button's onPress sets the decision.
//
// The host reads `on(...)` and `$.noun.method(...)` from source, so they are
// spelled literally, and helpers that take `$` are top-level functions.
//
// Based on mods/blast-radius in anthropics/claude-code-playground (Apache-2.0, see LICENSE).
//
// japan-da-man による変更:
// - コマンドをクォートを考慮して区切る（'a && b' のような引数の中の && で切らない）
// - bash -c / sh -c / zsh -c / eval の中身も同じルールで調べる
// - find -delete / find -exec rm（消える一覧は削除なしの find で下見）、xargs rm を捕まえる
// - git branch -D、git stash drop / clear、パスを指定した git checkout -- / git restore を捕まえる
// - rm の対象が変数のときや、ルート・ホーム・フォルダ全体のときは注意書きを出す
// - 答える人がいない（claude -p など）ときは待たずに止める
// - フック自体が失敗・時間切れになったときも止める（.catch）
// - /blast-radius で、最近止めたコマンドとその結果を一覧する

const PANE_ID = "blast-radius";
const POLL_SECONDS = "0.25";
const HOLD_LIMIT_MS = 10 * 60 * 1000;
const LIST_MAX = 10;
const HISTORY_MAX = 10;
const SHELLS = new Set(["bash", "sh", "zsh", "dash", "ksh"]);

// 最近捕まえたコマンド（新しい順）: { command, summary, outcome }
let history = [];

// The call being held, or null. One at a time: Bash calls in a turn run in order.
let held = null;

export function register(on) {
  on("session.start", async ($, e, next) => {
    const result = await next(e);
    await $.command.register({ name: "blast-radius", description: "Blast Radius: commands it held recently, and what happened", immediate: true });
    return result;
  });

  on("command.run", { command: "blast-radius" }, async () => {
    if (history.length === 0) {
      return { text: "Blast Radius hasn't held any command in this session." };
    }
    return { text: history.map((h) => `${h.outcome.padEnd(9)} ${h.command}\n          ${h.summary}`).join("\n") };
  });

  on("tool.call", { tool: "Bash" }, async ($, e, next) => {
    const risk = classify(String(e.command ?? ""));
    if (risk === null) {
      return next(e);
    }
    // 答える人がいない（claude -p など）ときは、10 分待たずにすぐ止める
    if ((await $.session.surfaces()).length === 0) {
      remember(String(e.command), risk.label, "refused");
      return { deny: `Blast Radius held this command and did not run it: there is no one to answer (a non-interactive session). It is a risky command (${risk.label}). Do not retry it unless the user asks you to.` };
    }
    // One hold at a time. If another risky call is already held (a subagent's,
    // say), wait until it is answered. `held` is claimed with no await between
    // the check and the claim, so two waiting calls can't both get through.
    while (held !== null) {
      if (next.signal.aborted) {
        return { deny: "Blast Radius held this command and did not run it: the turn was interrupted. Do not retry it unless the user asks you to." };
      }
      await $.process.run(["sleep", POLL_SECONDS], { timeoutMs: 5000 });
    }
    const mine = { command: String(e.command), risk, report: null, decision: null, where: "pane" };
    held = mine;

    let opened = { isPlaced: false };
    let decision;
    let summary = risk.label;
    try {
      // Measure where the command will run: the session folder, moved by any
      // `cd dir &&` or `git -C dir` earlier in the same command line.
      const sessionCwd = await $.session.cwd();
      const cwd = risk.dir ? await resolveDir($, sessionCwd, risk.dir) : sessionCwd;
      mine.report = cwd === null
        ? { summary: `${risk.label} in ${risk.dir}`, lines: [], note: `Couldn't find the folder ${risk.dir}, so I couldn't measure what this would change.` }
        : await measure($, risk, cwd);
      summary = mine.report.summary;

      opened = await $.ui.open({ id: PANE_ID, title: "Blast Radius", focus: true, rows: paneRows(mine.report) });
      if (!opened.isPlaced) {
        mine.where = "band";
      }
      $.ui.invalidate("ui.render");

      const startedAt = await $.clock.now();
      while (mine.decision === null) {
        if (next.signal.aborted) {
          mine.decision = "interrupted";
          break;
        }
        if ((await $.clock.now()) - startedAt > HOLD_LIMIT_MS) {
          mine.decision = "timeout";
          break;
        }
        await $.process.run(["sleep", POLL_SECONDS], { timeoutMs: 5000 });
      }
    } catch {
      mine.decision = "error"; // anything unexpected refuses the command
    } finally {
      decision = mine.decision;
      // Close this call's pane before releasing the hold, so the next call's
      // pane can't be the one that gets closed.
      try {
        if (opened.isPlaced) {
          await $.ui.close({ id: PANE_ID });
        }
      } catch {
        // the pane is already gone
      }
      if (held === mine) {
        held = null;
      }
      $.ui.invalidate("ui.render");
    }

    remember(mine.command, summary, decision === "proceed" ? "ran" : decision);
    if (decision === "proceed") {
      $.ui.toast("Blast Radius: running it");
      return next(e);
    }
    const why = {
      cancel: "the user pressed Cancel",
      timeout: "no answer within 10 minutes",
      interrupted: "the turn was interrupted",
      error: "Blast Radius hit an error while holding it",
    }[decision] ?? "no answer was recorded";
    return {
      deny: `Blast Radius held this command and did not run it: ${why}. It would have: ${summary}. Do not retry it unless the user asks you to.`,
    };
  })
    // このフック自体が失敗したり 10 秒の持ち時間を超えたりすると、Claude Code はフックを飛ばしてコマンドを実行してしまう。
    // 安全装置なので、そのときも止める側に倒す
    .catch(($, e, next) => ({
      deny: next.called
        ? `Blast Radius failed after the command had started (${next.error.message}). The command may have run.`
        : `Blast Radius couldn't check this command (${next.error.message}), so it did not run it. Ask the user before retrying.`,
    }));

  on("ui.render", { component: "Pane" }, ($, e, next) => {
    if (e.requestId !== PANE_ID || held === null || held.report === null) {
      return next(e);
    }
    return draw($.ui.resolve(e), held);
  });

  on("ui.render", { component: "AbovePrompt" }, ($, e, next) => {
    if (held === null || held.report === null || held.where !== "band") {
      return next(e);
    }
    return draw($.ui.resolve(e), held);
  });
}

function remember(command, summary, outcome) {
  history = [{ command, summary, outcome }, ...history].slice(0, HISTORY_MAX);
}

// ---- What counts as risky -------------------------------------------------

// sudo options that take a value, so the value isn't read as the command.
const SUDO_VALUE_OPTIONS = new Set(["-u", "-g", "-C", "-D", "-h", "-p", "-r", "-t", "-T", "-U"]);
// Commands that only read, so a bare word "migrate" in them isn't a migration.
const READ_ONLY = new Set(["ls", "cat", "echo", "printf", "grep", "rg", "find", "less", "head", "tail", "cd", "git"]);

/** A folder a later `cd arg` moves to, given the folder so far (null = the session folder). */
function joinDir(dir, arg) {
  if (arg === undefined || arg === "~" || arg.startsWith("/") || arg.startsWith("~/")) {
    return arg ?? "~";
  }
  return dir ? `${dir}/${arg}` : arg;
}

/** Splits a command line on && || ; | & and newlines, outside quotes. Each segment keeps its own text. */
export function splitSegments(command) {
  const out = [];
  let cur = "";
  let quote = null;
  for (let i = 0; i < command.length; i += 1) {
    const c = command[i];
    if (quote) {
      cur += c;
      if (c === "\\" && quote === '"' && i + 1 < command.length) {
        cur += command[i + 1];
        i += 1;
      } else if (c === quote) {
        quote = null;
      }
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      cur += c;
    } else if (c === "\\" && i + 1 < command.length) {
      cur += c + command[i + 1];
      i += 1;
    } else if (c === ";" || c === "\n" || c === "|" || (c === "&" && command[i + 1] === "&")) {
      out.push(cur);
      cur = "";
      if ((c === "|" && command[i + 1] === "|") || c === "&") {
        i += 1;
      }
    } else {
      cur += c;
    }
  }
  out.push(cur);
  return out;
}

/** The first risky segment of a shell command, or null. startDir: the folder an enclosing bash -c already moved to. */
export function classify(command, startDir = null) {
  let dir = startDir; // where a `cd` earlier on the line moved to; null means the session folder
  const scopes = []; // dir to restore when a ( subshell ) closes
  const pushed = []; // pushd stack, for popd
  for (const raw of splitSegments(command)) {
    const opens = (raw.match(/^\s*\(+/)?.[0].trim().length) ?? 0;
    // Trailing redirects and & don't hide a closing ) : `(cd sub && make) > log`.
    const tail = raw.replace(/(?:\s*(?:\d*>>?|&>>?|<)\s*\S+|\s*&)+\s*$/, "");
    const closes = (tail.match(/\)+\s*$/)?.[0].trim().length) ?? 0;
    for (let k = 0; k < opens; k += 1) {
      scopes.push(dir);
    }
    const risk = classifySegment(raw, dir, pushed);
    if (risk !== null && risk.cd === undefined) {
      return risk;
    }
    if (risk !== null) {
      dir = risk.cd; // a cd, pushd or popd moved the folder
    }
    for (let k = 0; k < closes && scopes.length > 0; k += 1) {
      dir = scopes.pop(); // a cd inside ( ... ) doesn't outlive it
    }
  }
  return null;
}

// Words that can come before the real command without changing what it does.
const PREFIXES = new Set(["command", "exec", "env", "nohup", "time", "then", "do", "else", "!"]);

/** One segment: a risk, { cd } for a folder change, or null. */
function classifySegment(segment, dir, pushed) {
  {
    const words = tokenize(segment.trim().replace(/^[({]+\s*/, "").replace(/\s*[)}]+$/, ""));
    while (words.length > 0 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0])) {
      words.shift(); // leading VAR=value
    }
    if (words[0] === "sudo") {
      words.shift();
      while (words.length > 0 && words[0].startsWith("-")) {
        const option = words.shift();
        if (SUDO_VALUE_OPTIONS.has(option)) {
          words.shift();
        }
      }
    }
    while (words.length > 0 && (PREFIXES.has(words[0]) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0]))) {
      words.shift();
    }
    if (words[0] === "nice") {
      words.shift();
      if (words[0] === "-n") {
        words.splice(0, 2);
      } else if (/^-\d+$/.test(words[0] ?? "")) {
        words.shift();
      }
    }
    const [first, ...args] = words;
    if (first === undefined) {
      return null;
    }
    const cmd = first.replace(/^\\/, ""); // \rm skips aliases; it's still rm
    if (cmd === "cd") {
      return { cd: args[0] === "-" ? "-" : joinDir(dir, args[0]) };
    }
    if (cmd === "pushd") {
      pushed.push(dir);
      return { cd: joinDir(dir, args[0]) };
    }
    if (cmd === "popd") {
      return { cd: pushed.length > 0 ? pushed.pop() : "-" };
    }
    // bash -c '...' と eval '...' は中身を同じルールで調べる
    if (SHELLS.has(cmd) || [...SHELLS].some((sh) => cmd.endsWith(`/${sh}`))) {
      const c = args.findIndex((a) => /^-[A-Za-z]*c[A-Za-z]*$/.test(a));
      return c !== -1 && args[c + 1] !== undefined ? classify(args[c + 1], dir) : null;
    }
    if (cmd === "eval") {
      return args.length > 0 ? classify(args.join(" "), dir) : null;
    }
    if (cmd === "find") {
      const found = parseFindDelete(args);
      if (found !== null) {
        return { kind: "find-delete", label: `find ${found.via}`, args: found.dryRun, isUnfiltered: found.isUnfiltered, dir };
      }
      return null;
    }
    if (cmd === "xargs") {
      let k = 0;
      while (k < args.length && args[k].startsWith("-")) {
        k += XARGS_OPTS_WITH_VALUE.has(args[k]) ? 2 : 1;
      }
      if ((args[k] ?? "").split("/").pop() === "rm") {
        return { kind: "xargs-rm", label: "xargs rm", dir };
      }
      return null;
    }
    if (cmd === "rm" || cmd.endsWith("/rm")) {
      const flags = args.filter((a) => a.startsWith("-"));
      const recursive = flags.some((f) => f === "--recursive" || (/^-[^-]/.test(f) && /[rR]/.test(f)));
      const force = flags.some((f) => f === "--force" || (/^-[^-]/.test(f) && f.includes("f")));
      if (recursive || force) {
        const targets = args.filter((a) => !a.startsWith("-") || a === "-");
        return { kind: "rm", label: `rm ${flags.join(" ")}`.trim(), targets, dir };
      }
    }
    if (cmd === "git") {
      // Git's own options come before the subcommand; -C moves where it runs.
      let gitDir = dir;
      let i = 0;
      while (i < args.length && args[i].startsWith("-")) {
        if (args[i] === "-C" && i + 1 < args.length) {
          gitDir = joinDir(gitDir, args[i + 1]);
          i += 2;
        } else if (args[i] === "-c" && i + 1 < args.length) {
          i += 2;
        } else {
          i += 1;
        }
      }
      const sub = args[i];
      const rest = args.slice(i + 1);
      if (sub === "reset" && rest.includes("--hard")) {
        return { kind: "git-reset", label: "git reset --hard", args: rest, dir: gitDir };
      }
      if (sub === "clean") {
        return { kind: "git-clean", label: "git clean", args: rest, dir: gitDir };
      }
      if (sub === "push" && rest.some((a) => a === "--force" || a === "-f" || a.startsWith("--force-with-lease") || /^\+/.test(a))) {
        return { kind: "git-push-force", label: "git push --force", args: rest, dir: gitDir };
      }
      const stagedOnly = sub === "restore" && rest.includes("--staged") && !rest.includes("--worktree") && !rest.includes("-W");
      // checkout は . か -- のあとのパス、restore はパスがあれば作業ツリーの変更を捨てる
      const dash = rest.indexOf("--");
      const paths = dash !== -1 ? rest.slice(dash + 1) : rest.filter((a) => !a.startsWith("-"));
      const discards = sub === "restore" ? paths.length > 0 : rest.includes(".") || (dash !== -1 && paths.length > 0);
      if ((sub === "checkout" || sub === "restore") && discards && !stagedOnly) {
        const label = paths.length === 1 && paths[0] === "." ? `git ${sub} -- .` : `git ${sub} -- ${paths.join(" ")}`;
        return { kind: "git-checkout", label, args: rest, paths, dir: gitDir };
      }
      if (sub === "branch" && (rest.includes("-D") || (rest.includes("--delete") && rest.includes("--force")))) {
        const branches = rest.filter((a) => !a.startsWith("-"));
        if (branches.length > 0) {
          return { kind: "git-branch-delete", label: `git branch -D ${branches.join(" ")}`, branches, dir: gitDir };
        }
      }
      if (sub === "stash" && (rest[0] === "drop" || rest[0] === "clear")) {
        return { kind: "git-stash", label: `git stash ${rest[0]}`, action: rest[0], ref: rest[1] ?? null, dir: gitDir };
      }
    }
    const joined = words.join(" ");
    if (/\balembic\s+upgrade\b/.test(joined)) {
      return { kind: "migrate", tool: "alembic", label: "alembic upgrade", dir };
    }
    if (/\bdb:migrate(?!:status\b)/.test(joined)) {
      return { kind: "migrate", tool: "rails", label: "db:migrate", dir };
    }
    if (/\bprisma\s+migrate\b/.test(joined)) {
      return { kind: "migrate", tool: "prisma", label: "prisma migrate", dir };
    }
    if (/\bmanage\.py\s+migrate\b/.test(joined)) {
      return { kind: "migrate", tool: "django", label: "manage.py migrate", dir };
    }
    if (!READ_ONLY.has(cmd) && args.includes("migrate")) {
      return { kind: "migrate", tool: "unknown", label: "migrate", dir };
    }
  }
  return null;
}

const EXEC_ACTIONS = new Set(["-exec", "-execdir", "-ok", "-okdir"]);
// 引数を 1 つとる find のグローバルオプションと、引数なしのもの。ファイルに書き出す動作は下見では外す
const FIND_GLOBAL_OPTS = new Set(["-maxdepth", "-mindepth"]);
const FIND_GLOBAL_FLAGS = new Set(["-depth", "-d", "-xdev", "-mount", "-follow", "-noleaf"]);
const FIND_WRITE_ACTIONS = new Set(["-fprint", "-fprint0", "-fls", "-fprintf"]);
// xargs のオプションのうち、引数を 1 つとるもの
const XARGS_OPTS_WITH_VALUE = new Set(["-n", "-I", "-L", "-P", "-d", "-s", "-E", "-a"]);

/** find の引数から -delete / -exec rm を見つけ、消えるものを下見する引数を作る。削除しない find は null */
export function parseFindDelete(args) {
  const del = args.indexOf("-delete");
  const execRm = args.findIndex((a, i) => EXEC_ACTIONS.has(a) && (args[i + 1] ?? "").split("/").pop() === "rm");
  if (del === -1 && execRm === -1) {
    return null;
  }
  const dryRun = [];
  for (let k = 0; k < args.length; k += 1) {
    const a = args[k];
    if (a === "-delete") {
      continue;
    }
    if (EXEC_ACTIONS.has(a)) {
      while (k < args.length && args[k] !== ";" && args[k] !== "+") {
        k += 1;
      }
      continue;
    }
    if (FIND_WRITE_ACTIONS.has(a)) {
      k += a === "-fprintf" ? 2 : 1;
      continue;
    }
    dryRun.push(a);
  }
  // -delete より前に絞り込みの条件がない（find . -delete -name x など）と、たどったものが全部消える
  let isUnfiltered = false;
  if (del !== -1) {
    let k = args.findIndex((a) => a.startsWith("-") || a === "(" || a === "!");
    isUnfiltered = true;
    while (k !== -1 && k < del) {
      if (FIND_GLOBAL_OPTS.has(args[k])) {
        k += 2;
      } else if (FIND_GLOBAL_FLAGS.has(args[k])) {
        k += 1;
      } else {
        isUnfiltered = false;
        break;
      }
    }
  }
  return { dryRun, isUnfiltered, via: del !== -1 ? "-delete" : "-exec rm" };
}

// Resolves a `cd` target to an absolute folder, or null if it doesn't exist.
// The target is passed as an argument, never as source.
const CD_SCRIPT = `unset CDPATH; d="$1"; case "$d" in "~") d="$HOME";; "~/"*) d="$HOME/\${d#\\~/}";; esac; cd -- "$d" 2>/dev/null && pwd -P`;

async function resolveDir($, sessionCwd, dir) {
  if (dir === "-") {
    return null; // `cd -` depends on the shell's history
  }
  const run = await $.process.run(["bash", "-c", CD_SCRIPT, "blast-radius", dir], { cwd: sessionCwd, timeoutMs: 5000 });
  const out = run.stdout.trim();
  return run.exitCode === 0 && out !== "" ? out : null;
}

/** Splits one segment into words, honouring quotes. Good enough to read flags and paths. */
function tokenize(text) {
  const words = [];
  const re = /"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    words.push(m[1] ?? m[2] ?? m[3]);
  }
  return words;
}

// ---- Measuring the blast radius -------------------------------------------

/** { summary, lines, note } for the pane. Never throws: a failed read is said, not hidden. */
async function measure($, risk, cwd) {
  try {
    if (risk.kind === "rm") {
      return await measureRm($, risk, cwd);
    }
    if (risk.kind === "migrate") {
      return await measureMigrations($, risk, cwd);
    }
    if (risk.kind === "find-delete") {
      return await measureFind($, risk, cwd);
    }
    if (risk.kind === "xargs-rm") {
      return { summary: "delete the files piped into it", lines: [], note: "xargs gets its file list when the command runs, so I can't list them beforehand." };
    }
    return await measureGit($, risk, cwd);
  } catch (error) {
    return { summary: `${risk.label} (could not measure it)`, lines: [], note: `Could not measure: ${String(error?.message ?? error).slice(0, 200)}` };
  }
}

// The paths are passed to bash as arguments, never as source, so nothing in
// them runs. compgen -G expands a glob without command substitution.
const RM_SCRIPT = `
shopt -s nullglob dotglob
paths=()
for p in "$@"; do
  case "$p" in "~"|"~/"*) p="$HOME\${p#\\~}";; esac
  if [[ "$p" == *[*?[]* ]]; then
    while IFS= read -r m; do paths+=("$m"); done < <(compgen -G "$p")
  elif [[ -e "$p" || -L "$p" ]]; then
    paths+=("$p")
  fi
done
if (( \${#paths[@]} == 0 )); then echo "0 0 0"; exit 0; fi
# A relative path gets ./ in front, so find never reads a name like -delete as an action.
for i in "\${!paths[@]}"; do case "\${paths[$i]}" in /*) ;; *) paths[$i]="./\${paths[$i]}";; esac; done
files=$(find "\${paths[@]}" \\( -type f -o -type l \\) 2>/dev/null | wc -l | tr -d ' ')
kb=$(du -skc "\${paths[@]}" 2>/dev/null | tail -n1 | cut -f1)
echo "$files $(( \${kb:-0} * 1024 )) \${#paths[@]}"
find "\${paths[@]}" \\( -type f -o -type l \\) 2>/dev/null | head -n ${LIST_MAX}
`;

const WHOLE_TREES = new Set(["/", "/*", "~", "~/", "~/*", ".", "./", "./*", "..", "../", "*"]);

async function measureRm($, risk, cwd) {
  const report = await measureRmPaths($, risk, cwd);
  const warnings = [];
  const variables = risk.targets.filter((t) => /[$`]/.test(t));
  if (variables.length > 0) {
    warnings.push(`${variables.join(" ")} ${variables.length === 1 ? "is a variable" : "are variables"}: what ${variables.length === 1 ? "it holds" : "they hold"} is only known when the command runs, so ${variables.length === 1 ? "it isn't" : "they aren't"} counted.`);
  }
  const wide = risk.targets.filter((t) => WHOLE_TREES.has(t));
  if (wide.length > 0) {
    warnings.push(`⚠ ${wide.join(" ")} is a whole folder tree.`);
  }
  if (warnings.length === 0) {
    return report;
  }
  return { ...report, note: [...warnings, report.note].filter(Boolean).join(" ") };
}

async function measureRmPaths($, risk, cwd) {
  if (risk.targets.length === 0) {
    return { summary: "rm with no paths", lines: [], note: "No paths to expand." };
  }
  const run = await $.process.run(["bash", "-c", RM_SCRIPT, "blast-radius", ...risk.targets], { cwd, timeoutMs: 15000 });
  const [head, ...rest] = run.stdout.split("\n").filter((l) => l !== "");
  const [files, bytes, found] = (head ?? "0 0 0").split(" ").map(Number);
  if (!found) {
    return { summary: `delete nothing: no file matches ${risk.targets.join(" ")}`, lines: [], note: "The paths don't exist, so rm has nothing to remove." };
  }
  if (!files) {
    return { summary: `delete ${found} ${found === 1 ? "path" : "paths"} with no files in ${found === 1 ? "it" : "them"}`, lines: [], note: `Paths: ${risk.targets.join(" ")}` };
  }
  return {
    summary: `delete ${files} ${files === 1 ? "file" : "files"} (about ${size(bytes)})`,
    lines: rest.map((l) => l.replace(/^\.\//, "")),
    more: Math.max(0, files - rest.length),
    note: `Paths: ${risk.targets.join(" ")}`,
  };
}

async function measureGit($, risk, cwd) {
  if (risk.kind === "git-push-force") {
    return await measurePush($, risk, cwd);
  }
  if (risk.kind === "git-branch-delete") {
    const lines = [];
    let total = 0;
    for (const branch of risk.branches) {
      const log = await $.process.run(["git", "log", "--oneline", "--no-decorate", `HEAD..${branch}`], { cwd, timeoutMs: 15000 });
      const commits = log.exitCode === 0 ? log.stdout.split("\n").filter((l) => l !== "") : [];
      total += commits.length;
      lines.push(`${branch}: ${log.exitCode !== 0 ? "no such branch" : commits.length === 0 ? "merged into HEAD" : `${commits.length} unmerged ${commits.length === 1 ? "commit" : "commits"}`}`);
      lines.push(...commits.slice(0, LIST_MAX).map((c) => `  ${c}`));
    }
    return {
      summary: total === 0 ? "delete branches with no unmerged commits" : `delete ${total} ${total === 1 ? "commit" : "commits"} that are not in HEAD`,
      lines: lines.slice(0, LIST_MAX),
      more: Math.max(0, lines.length - LIST_MAX),
      note: "From git log HEAD..branch. Unmerged commits can be hard to find again once the branch is gone.",
    };
  }
  if (risk.kind === "git-stash") {
    const list = await $.process.run(["git", "stash", "list"], { cwd, timeoutMs: 15000 });
    const all = list.stdout.split("\n").filter((l) => l !== "");
    const gone = risk.action === "clear" ? all : all.filter((l) => l.startsWith(`${risk.ref ?? "stash@{0}"}:`));
    return {
      summary: gone.length === 0 ? "drop no stash entries" : `drop ${gone.length} stash ${gone.length === 1 ? "entry" : "entries"}`,
      lines: gone.slice(0, LIST_MAX),
      more: Math.max(0, gone.length - LIST_MAX),
      note: "From git stash list. A dropped stash is hard to get back.",
    };
  }
  if (risk.kind === "git-clean") {
    const flags = [];
    const paths = [];
    for (let i = 0; i < risk.args.length; i += 1) {
      const a = risk.args[i];
      if (a === "--") {
        paths.push(...risk.args.slice(i + 1));
        break;
      }
      if (a === "-e" || a === "--exclude") {
        flags.push(a, risk.args[i + 1] ?? "");
        i += 1;
      } else if (a.startsWith("--exclude=") || /^-e./.test(a)) {
        flags.push(a);
      } else if (/^-[a-zA-Z]+$/.test(a)) {
        const kept = a.replace(/[finq]/g, ""); // -n is added below; -f, -i and -q would change the dry run
        if (kept !== "-") {
          flags.push(kept);
        }
      } else if (!a.startsWith("-")) {
        paths.push(a);
      }
    }
    const run = await $.process.run(["git", "clean", "-n", ...flags, "--", ...paths], { cwd, timeoutMs: 15000 });
    if (run.exitCode !== 0) {
      return { summary: "git clean (could not dry-run it)", lines: [], note: run.stderr.trim().slice(0, 200) };
    }
    const gone = run.stdout.split("\n").filter((l) => l.startsWith("Would remove ")).map((l) => l.slice(13));
    return {
      summary: gone.length === 0 ? "remove nothing: no untracked files match" : `remove ${gone.length} untracked ${gone.length === 1 ? "path" : "paths"}`,
      lines: gone.slice(0, LIST_MAX),
      more: Math.max(0, gone.length - LIST_MAX),
      note: "From git clean -n. Untracked files are not in git, so they can't be recovered.",
    };
  }
  const scope = risk.kind === "git-checkout" && risk.paths?.length ? ["--", ...risk.paths] : [];
  const status = await $.process.run(["git", "status", "--porcelain", ...scope], { cwd, timeoutMs: 15000 });
  if (status.exitCode !== 0) {
    return { summary: `${risk.label} (not a git repo here?)`, lines: [], note: status.stderr.trim().slice(0, 200) };
  }
  const rows = status.stdout.split("\n").filter((l) => l.length > 3 && !l.startsWith("??"));
  // reset --hard drops staged and unstaged changes; checkout -- . drops unstaged ones.
  const lost = risk.kind === "git-reset" ? rows : rows.filter((l) => l[1] !== " ");
  const stat = await $.process.run(["git", "diff", "--shortstat", risk.kind === "git-reset" ? "HEAD" : "--"], { cwd, timeoutMs: 15000 });
  return {
    summary: lost.length === 0 ? "discard nothing: no uncommitted changes" : `discard uncommitted changes in ${lost.length} ${lost.length === 1 ? "file" : "files"}`,
    lines: lost.slice(0, LIST_MAX).map((l) => `${l.slice(0, 2)} ${l.slice(3)}`),
    more: Math.max(0, lost.length - LIST_MAX),
    note: stat.stdout.trim() !== "" ? `${stat.stdout.trim()}. Uncommitted changes can't be recovered.` : "From git status --porcelain.",
  };
}

// 削除の動作を外した find を、引数のまま（シェルを通さずに）実行して一覧にする
async function measureFind($, risk, cwd) {
  const run = await $.process.run(["find", ...risk.args], { cwd, timeoutMs: 15000 });
  const found = run.stdout.split("\n").filter((l) => l !== "").map((l) => l.replace(/^\.\//, ""));
  const note = risk.isUnfiltered
    ? "⚠ -delete comes before any test, so everything find walks is deleted. From the same find without -delete."
    : "From the same find without -delete or -exec rm.";
  return {
    summary: found.length === 0 ? "delete nothing: find matches no files" : `delete ${found.length} ${found.length === 1 ? "path" : "paths"}`,
    lines: found.slice(0, LIST_MAX),
    more: Math.max(0, found.length - LIST_MAX),
    note,
  };
}

async function measurePush($, risk, cwd) {
  const positional = risk.args.filter((a) => !a.startsWith("-"));
  const remote = positional[0] ?? "origin";
  // A refspec is src:dst. With no colon, the local branch of the same name is pushed.
  const spec = (positional[1] ?? "").replace(/^\+/, "");
  let [source, branch] = spec.includes(":") ? spec.split(":") : [spec, spec];
  branch = (branch ?? "").replace(/^refs\/heads\//, "");
  if (!branch) {
    const head = await $.process.run(["git", "rev-parse", "--abbrev-ref", "HEAD"], { cwd, timeoutMs: 10000 });
    branch = head.stdout.trim();
    source = "HEAD";
  } else if (branch === "HEAD") {
    // `git push origin HEAD` pushes the current branch to its namesake.
    const head = await $.process.run(["git", "rev-parse", "--abbrev-ref", "HEAD"], { cwd, timeoutMs: 10000 });
    branch = head.stdout.trim();
    source = "HEAD";
  }
  source = source || "HEAD";
  const ref = `${remote}/${branch}`;
  const known = await $.process.run(["git", "rev-parse", "--verify", "--quiet", ref], { cwd, timeoutMs: 10000 });
  if (known.exitCode !== 0) {
    return { summary: `force-push to ${ref}`, lines: [], note: `No local copy of ${ref}, so I can't tell which commits the push would drop. Run git fetch first.` };
  }
  const log = await $.process.run(["git", "log", "--oneline", "--no-decorate", `${source}..${ref}`], { cwd, timeoutMs: 15000 });
  const dropped = log.stdout.split("\n").filter((l) => l !== "");
  return {
    summary: dropped.length === 0 ? `force-push to ${ref}: drops no commits` : `force-push to ${ref}: drops ${dropped.length} ${dropped.length === 1 ? "commit" : "commits"}`,
    lines: dropped.slice(0, LIST_MAX),
    more: Math.max(0, dropped.length - LIST_MAX),
    note: `Commits on ${ref} that ${source} doesn't have, as of the last fetch.`,
  };
}

const MIGRATION_LISTERS = {
  django: { argv: ["python3", "manage.py", "showmigrations", "--plan"], pending: (l) => l.startsWith("[ ]"), strip: (l) => l.slice(4) },
  alembic: { argv: ["alembic", "history", "-r", "current:head"], pending: (l) => l.includes("->"), strip: (l) => l },
  rails: { argv: ["bin/rails", "db:migrate:status"], pending: (l) => /^\s*down\b/.test(l), strip: (l) => l.trim() },
  prisma: { argv: ["npx", "--no-install", "prisma", "migrate", "status"], pending: (l) => /^\s{2}\S/.test(l), strip: (l) => l.trim() },
};

async function measureMigrations($, risk, cwd) {
  const lister = MIGRATION_LISTERS[risk.tool];
  if (lister === undefined) {
    return { summary: "run migrations", lines: [], note: "I can't list the pending migrations for this tool, so the list is not shown." };
  }
  let run;
  try {
    run = await $.process.run(lister.argv, { cwd, timeoutMs: 20000 });
  } catch (error) {
    run = { exitCode: -1, stdout: "", stderr: String(error?.message ?? error) };
  }
  if (run.exitCode !== 0) {
    return { summary: `run ${risk.label}`, lines: [], note: `Couldn't list pending migrations (${lister.argv.join(" ")} failed).` };
  }
  const pending = run.stdout.split("\n").filter(lister.pending).map(lister.strip);
  return {
    summary: pending.length === 0 ? `run ${risk.label}: nothing pending` : `apply ${pending.length} pending ${pending.length === 1 ? "migration" : "migrations"}`,
    lines: pending.slice(0, LIST_MAX),
    more: Math.max(0, pending.length - LIST_MAX),
    note: `From ${lister.argv.join(" ")}.`,
  };
}

function size(bytes) {
  if (!Number.isFinite(bytes) || bytes < 1024) {
    return `${bytes || 0} B`;
  }
  const units = ["KB", "MB", "GB", "TB"];
  let n = bytes;
  let i = -1;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i += 1;
  }
  return `${n.toFixed(n < 10 ? 1 : 0)} ${units[i]}`;
}

// ---- Drawing --------------------------------------------------------------

function paneRows(report) {
  return Math.min(24, 9 + report.lines.length + (report.more ? 1 : 0));
}

function draw(t, state) {
  const { Box, Text, Button } = t;
  const { report } = state;
  const list = report.lines.map((line, i) => Text({ key: `l${i}`, children: `  ${line}`, wrap: "truncate-end" }));
  if (report.more) {
    list.push(Text({ key: "more", dimColor: true, children: `  + ${report.more} more` }));
  }
  // The buttons answer the call this pane was drawn for, never whichever one is held now.
  const decide = (choice) => () => {
    if (state.decision === null) {
      state.decision = choice;
    }
  };
  return Box({
    flexDirection: "column",
    borderStyle: "round",
    borderColor: "yellow",
    paddingX: 1,
    children: [
      Text({ key: "title", bold: true, color: "yellow", children: `⚠ Blast Radius · ${state.risk.label}` }),
      Text({ key: "cmd", children: [Text({ dimColor: true, children: "Command  " }), Text({ bold: true, children: state.command })], wrap: "truncate-end" }),
      Text({ key: "sum", children: [Text({ dimColor: true, children: "Would    " }), Text({ color: "red", bold: true, children: report.summary })] }),
      Box({ key: "list", flexDirection: "column", marginTop: 1, children: list }),
      report.note ? Text({ key: "note", dimColor: true, italic: true, children: report.note, wrap: "wrap" }) : null,
      Box({
        key: "buttons",
        marginTop: 1,
        gap: 2,
        children: [
          Button({ key: "proceed", label: "Proceed", hotkey: "1", plain: true, onPress: decide("proceed") }),
          Button({ key: "cancel", label: "Cancel", hotkey: "2", plain: true, autoFocus: true, onPress: decide("cancel") }),
          Text({ key: "hint", dimColor: true, children: "Claude is waiting on your answer" }),
        ],
      }),
    ],
  });
}
