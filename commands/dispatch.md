---
description: Dispatch a brief to Codex in the background (verbatim transport, returns a job handle)
argument-hint: '<brief-file-or-inline-text> [--role <stem>] [--cd <dir>] [--model <m>] [--effort <e>] [--write] [--force]'
disable-model-invocation: true
allowed-tools: Bash(node:*), Write, Read
---

Dispatch a background Codex job from the user's arguments: `$ARGUMENTS`

1. Determine the brief file:
   - If the first non-flag argument is a path to an existing file, that file IS the brief. Use it as-is — do not read, edit, or reformat it.
   - Otherwise the non-flag text is an inline brief. Resolve the real OS temp directory first — `node -e "console.log(require('node:os').tmpdir())"`, which is shell-independent and agrees with `$env:TEMP` in PowerShell and `${TMPDIR:-/tmp}` in Git Bash — then write the text VERBATIM (every byte, no reframing, no additions) to `<temp-dir>/codex-dispatch-brief-<epoch>.md`. Never write a brief under `${CLAUDE_PLUGIN_ROOT}` or next to it: that is the plugin's install tree inside the marketplace directory, not scratch space. Inline text always goes through a file, never a command line.
2. Run (passing through any `--role`, `--cd`, `--model`, `--effort`, `--write`, `--force` flags the user gave):

   `node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-dispatch.mjs" dispatch --brief "<brief file>" <flags>`

3. Show the user the command output unchanged — it contains the job id and the literal `out:` path. That `out:` path is the fallback delivery channel; never omit it.

Do not wait for the job. It runs minutes to half an hour; the user checks it with `/codex-dispatch:status` and collects it with `/codex-dispatch:result`.
