# @nimbalyst/controller

A standalone Alt+Space popover that drives an always-on host's agent sessions
over a self-hosted relay. It is not a second Nimbalyst — it is a client that
looks like a phone.

## Why it lives here and not in a separate repo

The controller needs Nimbalyst's transcript projection: the relay carries **raw
provider messages**, so anything rendering them must run the same pipeline the
host does — `projectRawMessagesToViewMessages` plus six provider parsers, about
5,400 lines. Vendoring that into a separate repo would mean maintaining a
divergent copy of the most churn-prone code in the tree.

Living in the monorepo makes that an import instead. And because this is a
**new directory**, it adds no merge surface: the fork's merge pain comes from
controller code spliced into `main/index.ts`, `AIService.ts`, `App.tsx` and
`renderer/index.css` — upstream's hottest files. Nothing here touches them.

This mirrors `packages/ios`, which solved the same problem the same way: iOS
does not reimplement the parsers in Swift, it ships the web transcript app in a
WKWebView.

## What it talks to

The wire protocol is entirely upstream — `MobileSessionControlHandler`,
`sessionControlBroadcast`, `CollabV3Sync` — because the iOS app already uses it.
So the host on the other end can be a **stock Nimbalyst or the forked one**, and
neither can tell the difference. The controller announces itself as
`type: 'mobile'`, which is what gates remote drive.

The one thing a stock host cannot do is point at a private relay: upstream
hardcodes `wss://sync.nimbalyst.com` or `ws://localhost:8790`. The fork's
`NIMBALYST_SYNC_URL` override exists for exactly that, and it is the only
host-side change the controller depends on.

## Topology

The **index room** carries the session list *and* the control lane
(drive/cancel/approve). Each **session room** carries only that session's
transcript. Driving a session therefore needs the index connection open, not the
session one.

## Pairing

The controller pairs the way a phone does — by consuming the host's pairing
payload. On the host: Settings → Sync → QR pairing → **Copy payload**, then
paste it into the controller's first-run screen.

`config.ts` rejects a bad payload up front rather than letting it degrade into a
confusing empty state. A truncated seed (console copy-paste loses characters), a
pre-v5 payload with no `personalOrgId`/`personalUserId`, or a stale clipboard all
otherwise present identically: *connected, but no sessions* — which sends you
debugging the relay instead of the input.

## Security

Two properties inherited from the relay, worth knowing before this is exposed to
anything wider than a tailnet.

**The relay does not verify JWT signatures.** It decodes the token and requires
only that `sub` matches the room's user id. That is *why* a non-Nimbalyst client
can connect — and it means anyone who can reach the relay and knows the user id
can mint a token.

**Control payloads are not encrypted.** Transcripts, titles and project ids are
AES-GCM. Control messages are not: the host reads `payload.prompt` verbatim. So a
prompt crosses the relay in the clear while the reply comes back encrypted.

## Layout

| Path | What |
| --- | --- |
| `src/relay/crypto.ts` | PBKDF2 → AES-GCM, mirroring the host's derivation exactly |
| `src/relay/relayClient.ts` | index + session rooms, mobile masquerade, control lane |
| `src/config.ts` | pairing payload parsing and local storage |
| `src/App.tsx` | pair → session list → session |

## Develop

```bash
npm run dev --workspace=@nimbalyst/controller        # vite on :5275
npm run typecheck --workspace=@nimbalyst/controller
```
