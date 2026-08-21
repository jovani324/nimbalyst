# Controller Mode — Runbook (work laptop)

Discreet controller popover driving your **own** real Nimbalyst sessions, all on
one machine, over a **local** relay (no network needed). Fork branch:
`controller-mode`.

Topology tomorrow:
- **relay** — `private-sync-relay`, `ws://localhost:8790` (localhost only)
- **host** — `npm run dev`, default profile = your real data (hide this window)
- **controller** — `npm run dev:user2`, isolated profile = the discreet popover

One launcher runs all three: `packages/electron/scripts/controller-stack.sh`.

---

## THE ONE HARD RULE
**Quit the normal Nimbalyst app before starting the fork host.** They share the
same data folder and the DB lock is exclusive — running both at once risks
corruption. Back up first (below) and you're fully safe.

---

## TONIGHT — one-time prep (~20 min)

### 0. Prereqs
```
node --version        # must be >= 24
```

### 1. Get the code
```
# if the fork isn't cloned yet:
git clone -b controller-mode https://github.com/jovani324/nimbalyst.git
cd nimbalyst
npm install
npm run build --prefix packages/extension-sdk     # REQUIRED prebuild

# the relay lives beside the fork as a sibling folder ../private-sync-relay
# (clone/copy it there if missing), then:
cd ../private-sync-relay && npm install && cd ../nimbalyst
```

### 2. Back up your data  (safety + this IS your portable-host seed)
Quit the normal Nimbalyst app first, then in nushell:
```
du -sh $"($env.HOME)/Library/Application Support/@nimbalyst/electron"                       # how big
tar -czf ~/nimbalyst-host-seed.tgz -C $"($env.HOME)/Library/Application Support/@nimbalyst" electron
```
Copy `~/nimbalyst-host-seed.tgz` to an external drive / cloud.
Restore later = extract it back into `.../@nimbalyst/` on any fork Mac → a host
with all your data.

### 3. First launch + pair the controller (do once — all UI, no devtools)
```
bash packages/electron/scripts/controller-stack.sh start
```
Two windows come up (host + controller popover; Alt+Space toggles the popover).

> **Run this from a terminal on the machine's own desktop — never over SSH.**
> Electron started over SSH has no GUI session, so macOS denies Keychain access
> and `safeStorage` cannot decrypt the stored Stytch credentials: both instances
> come up silently signed out, with no sync provider and an empty session list.
> The launcher refuses an SSH start for this reason.

**a. Host** — should already be signed in (same data as the normal app).
   - Settings → Sync → enable **personal sync**, tick the **projects** you want
     the controller to see (only synced projects show up).
   - Click **Pair Device** → in that dialog click **Copy** to copy the pairing
     code to your clipboard.

**b. Controller** — sign in with the **same account** → Settings → Sync →
   **"Have a pairing code from another desktop? Import it"** → paste the code →
   **Import**. It says "Paired — restart to finish."

**c. Restart the stack to apply pairing:**
   ```
   bash packages/electron/scripts/controller-stack.sh stop
   bash packages/electron/scripts/controller-stack.sh start
   ```

> This is a **one-time** step per controller profile. Daily use never touches
> pairing again.

### 4. Verify + set discreet defaults
- Alt+Space → the popover lists your synced sessions. Open one: you should read
  the transcript, send a reply, and approve a tool prompt.
- In the popover: pick a **disguise theme**, turn on **auto-blur on unfocus** and
  **secret redaction** (⚙ menu). Set the **boss-key** if you want a different one.
- Also in ⚙: **font**, **text size**, **reset the popover size**, **titles as file
  paths** and **transcript as source until hovered** — the last two make an idle
  popover read as an open editor rather than a blurred chat.
- The **◌ pin** in the header keeps the popover on screen when you click away
  (normally it hides on blur, which gives the disguise nothing to do) and stops it
  floating above every other window. The boss-key still hides it instantly. The pin
  survives a restart.

### 4a. File references
A path in a reply (`packages/electron/src/main/index.ts:42`) is tappable: the
host reads that file and the popover shows it with line numbers, scrolled to the
line. `←` goes back to the transcript. Reads are confined to the session's own
folder — its worktree for worktree sessions — and a symlink pointing out of it is
refused, so a reference cannot be used to browse the rest of the host's disk.

### 4b. The remote shell
The `>_` button in a session's header opens a **real shell on the host**, in that
session's working directory (its worktree, for worktree sessions). It runs there,
not here — the popover only relays keystrokes and prints the output with escape
codes stripped, so full-screen programs (vim, htop) will look like noise.

The shell dies when you close the pane, and after 30 minutes with no input. This
is on by default because a paired controller can already drive agents that run
commands; to refuse it outright, set `sessionSync.remoteTerminalEnabled` to
`false` in the **host's** app settings.

### 5. Shut down for the night
```
bash packages/electron/scripts/controller-stack.sh stop
```

---

## TOMORROW — daily use (pick one plan)

> First: **quit the normal packaged Nimbalyst app** if it's open — the host uses
> the same data folder and the DB lock is exclusive.

### Plan 1 — one command (recommended)
```
bash packages/electron/scripts/controller-stack.sh start     # relay + host + controller
#   Alt+Space = discreet popover · Shift+Enter = send · hide the host window
bash packages/electron/scripts/controller-stack.sh status    # / logs
bash packages/electron/scripts/controller-stack.sh stop      # end of day
```
Read / reply / approve from the popover; new sessions self-heal into their project.

**On a machine with no `../private-sync-relay` checkout**, point it at the
always-on hosted relay instead — nothing local to start, and the launcher no
longer asks for the folder:
```
SYNC_URL=wss://relay.moasfar.app bash packages/electron/scripts/controller-stack.sh start
SYNC_URL=wss://relay.moasfar.app bash packages/electron/scripts/controller-stack.sh stop
```
Needs Tailscale up — the relay is tailnet-only. Naming `relay` explicitly with a
remote `SYNC_URL` is refused rather than silently starting a second one. A
target can be narrowed (`start host`) or combined (`start host controller`), and
`DRY_RUN=1` prints what would launch without launching it.

### Plan 2 — manual, if the launcher misbehaves (3 terminals)
```
cd private-sync-relay ; node server.mjs                                   # 1: local relay
cd packages/electron ; NIMBALYST_SYNC_URL=ws://localhost:8790 npm run dev # 2: host (hide it)
cd packages/electron ; npm run dev:user2:relay                            # 3: controller
```
(`dev:user2:relay` bakes the relay URL, so nushell's env quirk can't bite.)

### Plan 3 — packaged host app (installed at /Applications/Nimbalyst.app)
A real double-clickable host is now installed. It's the **fork build (0.69.1, x64)**
with the environment baked in, so it opens your existing data
(`@nimbalyst/electron`) and syncs to `wss://relay.moasfar.app` — not the cloud.

1. **Quit any `npm run dev` host first** (same data folder, exclusive DB lock).
2. **Double-click `Nimbalyst.app`.** First launch: it's ad-hoc signed, so
   right-click → **Open** once to get past Gatekeeper.
3. **Sanity-check on first launch:** it should show *your* sessions/projects (not
   an empty app). If it's empty, the baked env didn't apply — fall back to Plan 1.
4. Start the controller separately (the packaged app is only the HOST):
   ```
   cd packages/electron ; npm run dev:user2:relay
   ```

Notes:
- Needs the hosted relay reachable (Tailscale up). For a fully-local/offline day,
  use **Plan 1** (localhost relay) instead.
- The old 0.71.3 app was moved to `~/Nimbalyst-0.71.3.prev.app` (restore it there
  if you ever want it back).
- Plan 1 remains the safe default; Plan 3 is the convenience of a Dock/Finder icon.

---

## If something breaks (quick fixes)
- **Popover empty / no sessions** → click the refresh in the **list header**
  (next to "New"), not the transcript ⟳. Check `... status` shows all three up.
- **"Unknown project" group** → harmless; the list-header refresh regroups them
  (new sessions now self-heal on their own).
- **Port 8790 in use** → something else grabbed it; `... stop`, then start again,
  or set `SYNC_URL` / relay `PORT` to another port.
- **Controller can't sync** → confirm the relay is up (`... status`) and the host
  has sync enabled with the project ticked.
- **Want the normal app back exactly as it was** → quit the fork, restore
  `~/nimbalyst-host-seed.tgz`.
- **Nushell env prefix ignored** → don't set `NIMBALYST_SYNC_URL` by hand; the
  launcher exports it for you.
