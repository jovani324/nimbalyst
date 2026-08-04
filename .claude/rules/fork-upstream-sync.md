# This checkout is a FORK — keep it synced with upstream

This repo is a fork of `nimbalyst/nimbalyst`. Two remotes:

- `origin` → `nimbalyst/nimbalyst` (upstream, the parent — read-only for us)
- `fork` → `jovani324/nimbalyst` (ours, where branches are pushed)

`controller-mode` is a long-lived feature branch carrying Controller Mode (a
second desktop that drives the host's sessions over a self-hosted relay).

## The rule that matters most

**Refresh `main` from `origin` immediately before cutting any branch, and merge
`origin/main` into a long-lived branch at the start of every working session.**

This exists because of a real incident. `controller-mode` was cut on 2026-07-17
from a `main` that had not been pulled in days, then worked on 2026-07-28 →
08-04. By the time anyone looked it was **329 commits behind** — most of it
inherited at branch time, not accumulated. Resolving it cost an afternoon and
nine conflicted files. Merged weekly it is one or two files.

Drift is not proportional to how much you wrote. It is proportional to how long
you went without pulling.

## Workflow

`main` is a mirror, never a workspace — never commit to it:

```
git fetch origin
git checkout main && git merge --ff-only origin/main
```

If `--ff-only` fails, something was committed to `main` that should not have been.

Then merge into the working branch:

```
git checkout controller-mode && git merge main
```

**Merge, never rebase.** `controller-mode` is already pushed and is checked out
on a second machine (`op4`). Rebasing means force-pushing published history and
hard-resetting the other machine.

Measure before you commit to it — this touches nothing:

```
git merge-tree --write-tree --name-only origin/main controller-mode
```

It prints the conflicting files up front, so the work is known before starting.

## After any upstream merge

1. `npm install` — 300+ commits move dependencies.
2. Confirm the `"peer": true` flags in `package-lock.json` survived (`grep -c '"peer": true'` before and after). Some npm configs strip them and break CI.
3. `npm run typecheck` — a fork-only union member (e.g. `ContentMode`'s `'remote-sessions'`) will fail any `Record<…>` map upstream added.
4. `npx vitest run`.

## Files that conflict every time

`controller-mode` edits three of upstream's hottest files, so expect these:

`main/index.ts` · `services/SyncManager.ts` · `services/ai/AIService.ts` ·
`window/WindowManager.ts` · `renderer/App.tsx` · `renderer/index.css` ·
`GlobalSettings/panels/SyncPanel.tsx` · `packages/electron/package.json`

Most are additive (imports, listener registration, CSS blocks) — keep both sides.
Where upstream has *rewritten* a subsystem our fork patched, prefer upstream's
version and delete ours rather than maintaining a divergent copy: on 2026-08-04
upstream's `queueWindowResolver` (#962) replaced a controller-mode fallback in
`AIService` and did the job better. Check for orphaned imports afterward.

## Do not "clean up" these fork-only files

`CONTROLLER_RUNBOOK.md`, `packages/electron/scripts/controller-stack.sh` and its
tests, and the `dev:relay` / `dev:user2:relay` npm scripts do not exist upstream.
They are intentional, not leftovers.

## Prefer new rules here, not in CLAUDE.md

`CLAUDE.md` is maintained upstream. Fork-specific guidance added there becomes a
merge conflict on every sync. Put it in a new file under `.claude/rules/` —
those are loaded into agent context automatically and never collide.

## Pushing

The pre-push hook runs lockfile validation, override-sync, a full typecheck and
the unit suite — several minutes, so run it in the background rather than under a
short foreground timeout. Timing-sensitive tests (`claudeCliLauncherSingleton`,
DiffPlugin performance cases) time out at 20s under full-suite CPU contention and
pass in isolation. **Re-run a failure alone before treating it as real** — and do
not reach for `--no-verify`, which is what would have hidden a genuinely red
branch on 2026-08-04.
