/**
 * End-to-end proof against a stub relay on localhost.
 *
 * The sibling e2eScratch.mjs needs the live relay; this one needs nothing but
 * the dev server, so it runs anywhere and is deterministic. It speaks the same
 * wire protocol and encrypts with the same derivation, so it exercises the real
 * decrypt -> project -> render path -- and, unlike the live relay, it can serve
 * several workspaces at once, which is what the project grouping needs.
 *
 * Usage (dev server up on 5275): node packages/controller/scripts/e2eLocal.mjs
 */
import { WebSocketServer } from 'ws';
import { webcrypto as crypto } from 'node:crypto';
import { chromium } from '@playwright/test';

const CONTROLLER = 'http://localhost:5275/';
const ORG = 'org-local-e2e';
const USER = 'user-local-e2e';

const enc = new TextEncoder();
const b64 = (u8) => Buffer.from(u8).toString('base64');
const seed = b64(crypto.getRandomValues(new Uint8Array(32)));

const km = await crypto.subtle.importKey('raw', enc.encode(seed), 'PBKDF2', false, ['deriveKey']);
const key = await crypto.subtle.deriveKey(
  { name: 'PBKDF2', salt: enc.encode(`nimbalyst:${USER}`), iterations: 100000, hash: 'SHA-256' },
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

// Three workspaces, deliberately uneven, plus one entry the client cannot
// attribute -- the ordering rule says that one sinks to the bottom.
const FIXTURE = [
  { id: 'aaaaaaa1-0000-4000-8000-000000000001', title: 'Fix the posting modal', project: '/Users/x/p3-backend' },
  { id: 'aaaaaaa2-0000-4000-8000-000000000002', title: 'NGL cost detail', project: '/Users/x/p3-backend' },
  { id: 'aaaaaaa3-0000-4000-8000-000000000003', title: 'Snapshot export columns', project: '/Users/x/p3-backend' },
  { id: 'bbbbbbb1-0000-4000-8000-000000000004', title: 'Controller pairing', project: '/Users/x/nimbalyst' },
  { id: 'ccccccc1-0000-4000-8000-000000000005', title: 'Weekly dashboard tiles', project: '/Users/x/kb' },
];

const TRANSCRIPT = [
  { source: 'user', direction: 'input', content: 'What does the path shim do?' },
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
            id: 'toolu_local_1',
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
    content: 'It roots relative paths so path.resolve never reaches process.cwd() in a browser.',
  },
];

const sessions = [];
for (const entry of FIXTURE) {
  const title = await encField(entry.title);
  const project = await encField(entry.project);
  sessions.push({
    sessionId: entry.id,
    encryptedTitle: title.encrypted,
    titleIv: title.iv,
    encryptedProjectId: project.encrypted,
    projectIdIv: project.iv,
    provider: 'claude-code',
    messageCount: TRANSCRIPT.length,
    updatedAt: 1786000000000,
  });
}
// Encrypted under a different key, so the client fails to decrypt it exactly as
// it would for a stale entry.
const strayKey = await crypto.subtle.deriveKey(
  { name: 'PBKDF2', salt: enc.encode('nimbalyst:someone-else'), iterations: 100000, hash: 'SHA-256' },
  await crypto.subtle.importKey('raw', enc.encode('other-seed'), 'PBKDF2', false, ['deriveKey']),
  { name: 'AES-GCM', length: 256 },
  false,
  ['encrypt', 'decrypt']
);
{
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, strayKey, enc.encode('/Users/x/other'));
  const title = await encField('Stray session');
  sessions.push({
    sessionId: 'ddddddd1-0000-4000-8000-000000000006',
    encryptedTitle: title.encrypted,
    titleIv: title.iv,
    encryptedProjectId: b64(new Uint8Array(ct)),
    projectIdIv: b64(iv),
    provider: 'claude-code',
    messageCount: 0,
    updatedAt: 1785000000000,
  });
}

const messages = [];
let sequence = 1;
for (const entry of TRANSCRIPT) {
  const { encrypted, iv } = await encField(entry.content);
  messages.push({
    id: `local-${sequence}`,
    sequence,
    createdAt: 1786000000000 + sequence * 1000,
    source: entry.source,
    direction: entry.direction,
    encryptedContent: encrypted,
    iv,
    metadata: {},
  });
  sequence += 1;
}

const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
wss.on('connection', (ws) => {
  ws.on('message', (raw) => {
    let frame;
    try {
      frame = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (frame.type === 'indexSyncRequest') {
      ws.send(JSON.stringify({ type: 'indexSyncResponse', sessions, projects: [] }));
    } else if (frame.type === 'syncRequest') {
      ws.send(JSON.stringify({ type: 'syncResponse', messages, metadata: null, hasMore: false, cursor: null }));
    }
  });
});
await new Promise((r) => wss.on('listening', r));
const relayUrl = `ws://localhost:${wss.address().port}`;

const browser = await chromium.launch();
const page = await browser.newPage();
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
await page.goto(CONTROLLER, { waitUntil: 'networkidle' });
await page.evaluate(() => localStorage.clear());
await page.reload({ waitUntil: 'networkidle' });

await page.locator('.controller-pair-input').fill(
  JSON.stringify({
    version: 5,
    serverUrl: 'wss://sync.nimbalyst.com',
    encryptionKeySeed: seed,
    personalOrgId: ORG,
    personalUserId: USER,
  })
);
await page.locator('.controller-pair-relay-input').fill(relayUrl);
await page.locator('.controller-pair-submit').click();

await page.waitForSelector('.controller-project-group', { timeout: 20000 });
const rendered = await page.$$eval('.controller-project-group', (nodes) =>
  nodes.map((n) => ({
    label: n.querySelector('.controller-project-name')?.textContent?.trim(),
    count: Number(n.querySelector('.controller-project-count')?.textContent?.trim()),
    items: n.querySelectorAll('.controller-list-item').length,
  }))
);
console.log('groups:', JSON.stringify(rendered));

// Busiest first; equal counts fall back to alphabetical; unattributable last.
const expected = [
  { label: 'p3-backend', count: 3 },
  { label: 'kb', count: 1 },
  { label: 'nimbalyst', count: 1 },
  { label: 'Unknown project', count: 1 },
];
const groupsOk =
  rendered.length === expected.length &&
  expected.every((e, i) => rendered[i].label === e.label && rendered[i].count === e.count);

// Collapsing must hide the sessions but keep the header and its count.
await page.locator('.controller-project-header').first().click();
const afterCollapse = await page.$$eval(
  '.controller-project-group',
  (nodes) => nodes[0].querySelectorAll('.controller-list-item').length
);

await page.getByText('Controller pairing').first().click();
await page.waitForFunction(() => /process\.cwd/.test(document.body.innerText), undefined, {
  timeout: 20000,
});
const transcript = await page.evaluate(() => document.body.innerText);

const checks = {
  'groups render in the expected order and counts': groupsOk,
  'collapsing hides the sessions': afterCollapse === 0,
  'user turn rendered': transcript.includes('What does the path shim do?'),
  'assistant turn rendered': transcript.includes('process.cwd()'),
  'tool call rendered': /Read|shims\/path\.ts/.test(transcript),
  'no page errors': pageErrors.length === 0,
};

console.log('\n--- assertions ---');
for (const [name, ok] of Object.entries(checks)) console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
if (pageErrors.length) console.log('\npage errors:\n' + pageErrors.join('\n'));

await browser.close();
wss.close();

if (Object.values(checks).some((ok) => !ok)) process.exit(1);
console.log('\nlocal end-to-end OK: paired, decrypted, grouped by workspace, rendered.');
