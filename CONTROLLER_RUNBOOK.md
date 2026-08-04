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
git clone https://github.com/elasfarc/nimbalyst.git
cd nimbalyst
git checkout controller-mode
git pull
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

### 3. First launch + pair the controller (do once)
```
bash packages/electron/scripts/controller-stack.sh start
```
Two windows come up (host + controller popover; Alt+Space toggles the popover).

**a. Host** — should already be signed in (same data as the normal app).
   - Settings → enable **personal sync**, and tick the **projects** you want the
     controller to see. (Only synced projects show up.)
   - Open host devtools (Cmd+Opt+I) and copy a pairing payload:
     ```
     JSON.stringify(await window.electronAPI.credentials.generateQRPayload('ws://localhost:8790'))
     ```
     Copy the whole JSON string it prints.

**b. Controller** — sign in with the **same account**, then open its devtools
   (Cmd+Opt+I) and paste:
   ```
   await window.electronAPI.credentials.importPairingPayload('<PASTE THE JSON HERE>')
   ```
   It returns `requiresRestart: true`.

**c. Restart just the stack to apply pairing:**
   ```
   bash packages/electron/scripts/controller-stack.sh stop
   bash packages/electron/scripts/controller-stack.sh start
   ```

### 4. Verify + set discreet defaults
- Alt+Space → the popover lists your synced sessions. Open one: you should read
  the transcript, send a reply, and approve a tool prompt.
- In the popover: pick a **disguise theme**, turn on **auto-blur on unfocus** and
  **secret redaction** (⚙ menu). Set the **boss-key** if you want a different one.

### 5. Shut down for the night
```
bash packages/electron/scripts/controller-stack.sh stop
```

---

## TOMORROW — daily use

**Start (normal Nimbalyst app must be quit):**
```
bash packages/electron/scripts/controller-stack.sh start
```
- **Alt+Space** → discreet popover. Hide the host window.
- Read / reply / approve from the popover. Shift+Enter sends. New sessions
  self-heal into their project group automatically.

**Check / watch:**
```
bash packages/electron/scripts/controller-stack.sh status
bash packages/electron/scripts/controller-stack.sh logs      # Ctrl+C to stop tailing
```

**End of day:**
```
bash packages/electron/scripts/controller-stack.sh stop
```

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
