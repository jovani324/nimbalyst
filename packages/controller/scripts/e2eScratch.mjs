/**
 * End-to-end proof for the controller, against a live relay.
 *
 * Publishes one encrypted session to a throwaway room (never a personal room,
 * never anyone's real seed), then drives the actual UI: paste payload, override
 * the relay URL, pair, list, open, read the transcript. That last step is the
 * only thing that proves the host's projection pipeline survives the browser --
 * typecheck and build were both green while `path.resolve` was still crashing it.
 *
 * The publishing half runs inside the page rather than in Node because Node's
 * TLS handshake to the tailnet relay stalls on this machine while Chromium's
 * succeeds. Same wire protocol either way.
 *
 * Usage (dev server must be up on 5275):
 *   node packages/controller/scripts/e2eScratch.mjs [relayUrl]
 */
import { chromium } from '@playwright/test';

const RELAY = process.argv[2] ?? 'wss://relay.moasfar.app';
const CONTROLLER = 'http://localhost:5275/';
const ORG = 'org-controller-e2e';
const USER = 'user-controller-e2e';
const SESSION_ID = '0f9c1d22-6d5e-4d2c-9f1a-7b3e5c8a4d61';
const TITLE = 'Controller end-to-end scratch session';

const browser = await chromium.launch();
const page = await browser.newPage();
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
await page.goto(CONTROLLER, { waitUntil: 'networkidle' });

// ---- publish, as a host would ----------------------------------------------
const payload = await page.evaluate(
  async ([relay, org, user, sessionId, title]) => {
    const enc = new TextEncoder();
    const b64 = (u8) => btoa(String.fromCharCode(...u8));

    const seed = b64(crypto.getRandomValues(new Uint8Array(32)));
    const km = await crypto.subtle.importKey('raw', enc.encode(seed), 'PBKDF2', false, ['deriveKey']);
    const key = await crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt: enc.encode(`nimbalyst:${user}`), iterations: 100000, hash: 'SHA-256' },
      km,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );
    const encField = async (text) => {
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(text));
      return { encrypted: b64(new Uint8Array(ct)), iv: b64(iv) };
    };

    const token = `x.${btoa(JSON.stringify({ sub: user, organization_id: org }))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '')}.x`;
    const open = (room) =>
      new Promise((resolve, reject) => {
        const ws = new WebSocket(
          `${relay}/sync/${room}?token=${encodeURIComponent(token)}&platform=desktop&version=1`
        );
        const t = setTimeout(() => reject(new Error(`timed out opening ${room}`)), 12000);
        ws.onopen = () => {
          clearTimeout(t);
          resolve(ws);
        };
        ws.onerror = () => {
          clearTimeout(t);
          reject(new Error(`could not open ${room}`));
        };
      });

    // A tool call is in here on purpose: it forces the real parser path rather
    // than letting plain strings pass straight through the projector.
    const transcript = [
      { source: 'user', direction: 'input', content: 'What does the path shim do?' },
      { source: 'assistant', direction: 'output', content: 'Let me read it.' },
      {
        source: 'assistant',
        direction: 'output',
        content: JSON.stringify({
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [
              {
                type: 'tool_use',
                id: 'toolu_scratch_1',
                name: 'Read',
                input: { file_path: 'packages/controller/src/shims/path.ts' },
              },
            ],
          },
        }),
      },
      {
        source: 'assistant',
        direction: 'output',
        content:
          'It roots relative paths so path.resolve never reaches process.cwd() in a browser.',
      },
    ];

    const sessionWs = await open(`org:${org}:user:${user}:session:${sessionId}`);
    let sequence = 1;
    for (const entry of transcript) {
      const { encrypted, iv } = await encField(entry.content);
      sessionWs.send(
        JSON.stringify({
          type: 'appendMessage',
          message: {
            id: `scratch-${sequence}`,
            sequence,
            createdAt: 1786000000000 + sequence * 1000,
            source: entry.source,
            direction: entry.direction,
            encryptedContent: encrypted,
            iv,
            metadata: { content_length: entry.content.length },
          },
        })
      );
      sequence += 1;
    }

    const encTitle = await encField(title);
    sessionWs.send(
      JSON.stringify({
        type: 'updateMetadata',
        metadata: {
          encryptedTitle: encTitle.encrypted,
          titleIv: encTitle.iv,
          provider: 'claude-code',
        },
      })
    );

    const indexWs = await open(`org:${org}:user:${user}:index`);
    const encProject = await encField('/scratch/controller-e2e');
    indexWs.send(
      JSON.stringify({
        type: 'indexUpdate',
        session: {
          sessionId,
          encryptedProjectId: encProject.encrypted,
          projectIdIv: encProject.iv,
          encryptedTitle: encTitle.encrypted,
          titleIv: encTitle.iv,
          provider: 'claude-code',
          messageCount: transcript.length,
          updatedAt: 1786000010000,
        },
      })
    );

    await new Promise((r) => setTimeout(r, 1500));
    sessionWs.close();
    indexWs.close();

    // Deliberately advertise production, the way a self-hosted host really does.
    // The override field is what has to rescue it.
    return {
      version: 5,
      serverUrl: 'wss://sync.nimbalyst.com',
      encryptionKeySeed: seed,
      personalOrgId: org,
      personalUserId: user,
    };
  },
  [RELAY, ORG, USER, SESSION_ID, TITLE]
);

console.log('seeded scratch room; payload advertises', payload.serverUrl);

// ---- drive the UI ----------------------------------------------------------
await page.goto(CONTROLLER, { waitUntil: 'networkidle' });
await page.evaluate(() => localStorage.clear());
await page.reload({ waitUntil: 'networkidle' });

await page.locator('.controller-pair-input').fill(JSON.stringify(payload));

const prefilled = await page.locator('.controller-pair-relay-input').inputValue();
console.log('relay field prefilled from payload:', prefilled);
if (prefilled !== 'wss://sync.nimbalyst.com') {
  throw new Error(`expected the advertised URL to prefill, got "${prefilled}"`);
}

await page.locator('.controller-pair-relay-input').fill(RELAY);
await page.locator('.controller-pair-submit').click();

await page.waitForSelector('.controller-list', { timeout: 20000 });
await page.waitForFunction(
  (t) => document.body.innerText.includes(t),
  TITLE,
  { timeout: 20000 }
);
console.log('session list shows the decrypted title');

await page.getByText(TITLE).first().click();
await page.waitForFunction(
  () => /process\.cwd|path shim|shims\/path/.test(document.body.innerText),
  undefined,
  { timeout: 20000 }
);

const transcriptText = await page.evaluate(() => document.body.innerText);
const checks = {
  'user turn': transcriptText.includes('What does the path shim do?'),
  'assistant turn': transcriptText.includes('process.cwd()'),
  'tool call rendered': /Read|shims\/path\.ts/.test(transcriptText),
  'nothing undecryptable': !/undecryptable/i.test(transcriptText),
};

console.log('\n--- transcript assertions ---');
for (const [name, ok] of Object.entries(checks)) console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
if (pageErrors.length) console.log('\npage errors:\n' + pageErrors.join('\n'));

await browser.close();

const failed = Object.entries(checks).filter(([, ok]) => !ok);
if (failed.length || pageErrors.length) process.exit(1);
console.log('\nend-to-end OK: paired over an overridden relay, decrypted, projected, rendered.');
