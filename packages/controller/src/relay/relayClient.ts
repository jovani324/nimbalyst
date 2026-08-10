/**
 * Client for Nimbalyst's personal sync lane.
 *
 * Talks to the relay the way the iOS app does, so the host on the other end can
 * be a stock Nimbalyst or the forked one -- neither can tell the difference.
 *
 * Depends on nothing but global WebSocket / crypto.subtle / crypto.randomUUID,
 * which exist in Node >= 22, every browser, and a Tauri webview. Proven against
 * the live relay (69 real sessions listed) before this package existed.
 *
 * Topology note: the INDEX room carries the session list *and* the control lane
 * (drive/cancel/approve). Each SESSION room carries only that session's
 * transcript. So driving a session needs the index connection open, not the
 * session one.
 */
import { decrypt } from './crypto';

/** A transcript message after decryption. `content` is raw provider JSON. */
export interface RelayMessage {
  id: string;
  sequence: number;
  createdAt: number;
  source: string;
  direction: string;
  content: string | null;
  /** True when a key was supplied but AES-GCM authentication failed. */
  undecryptable: boolean;
}

export interface RelaySession {
  sessionId: string;
  title: string | null;
  provider: string | null;
  messageCount: number;
  updatedAt: number | null;
}

/**
 * The relay decodes this and never verifies the signature -- it only requires
 * sub === the room's userId (and org match when the claim is present). So a
 * structurally valid token is enough; there is no Stytch round-trip. That is a
 * property of the self-hosted relay, NOT something to rely on against a signing
 * server.
 */
export function makeRelayToken(userId: string, orgId: string): string {
  const b64url = (o: unknown) =>
    btoa(JSON.stringify(o)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `x.${b64url({ sub: userId, organization_id: orgId })}.x`;
}

export const indexRoomId = (orgId: string, userId: string) => `org:${orgId}:user:${userId}:index`;
export const sessionRoomId = (orgId: string, userId: string, sessionId: string) =>
  `org:${orgId}:user:${userId}:session:${sessionId}`;

/** Control verbs the host's MobileSessionControlHandler understands. */
export const CONTROL = {
  PROMPT: 'prompt',
  CANCEL: 'cancel',
  PROMPT_RESPONSE: 'prompt_response',
  ARCHIVE: 'archive',
} as const;

function parseFrame(event: MessageEvent): any | null {
  try {
    return JSON.parse(typeof event.data === 'string' ? event.data : String(event.data));
  } catch {
    return null;
  }
}

/** One session's transcript: a decrypted backlog plus a live subscription. */
export class SessionHandle {
  readonly sessionId: string;
  messages: RelayMessage[] = [];
  metadata: Record<string, any> | null = null;

  private readonly ws: WebSocket;
  private readonly key: CryptoKey | null;
  private readonly listeners = new Set<(m: RelayMessage) => void>();

  constructor(ws: WebSocket, key: CryptoKey | null, sessionId: string) {
    this.ws = ws;
    this.key = key;
    this.sessionId = sessionId;
    ws.addEventListener('message', (event) => {
      const frame = parseFrame(event);
      if (frame?.type !== 'messageBroadcast' || !frame.message) return;
      void this.ingest(frame.message).then((m) => {
        if (m) this.listeners.forEach((cb) => cb(m));
      });
    });
  }

  /** Decrypt one wire message and append it. Also used for the backlog. */
  async ingest(raw: any): Promise<RelayMessage> {
    // Ciphertext is relayed verbatim; the relay holds no key and cannot read it.
    let content: string | null = null;
    if (this.key && raw.encryptedContent && raw.iv) {
      try {
        content = await decrypt(raw.encryptedContent, raw.iv, this.key);
      } catch {
        // Wrong seed/user -> AES-GCM authentication failure. Keep the envelope
        // so a partial key mismatch is visible instead of looking like an empty
        // session.
        content = null;
      }
    }
    const message: RelayMessage = {
      id: raw.id,
      sequence: raw.sequence,
      createdAt: raw.createdAt,
      source: raw.source,
      direction: raw.direction,
      content,
      undecryptable: Boolean(this.key && raw.encryptedContent && content === null),
    };
    this.messages.push(message);
    return message;
  }

  /** @returns an unsubscribe function */
  onMessage(cb: (m: RelayMessage) => void): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  close(): void {
    this.listeners.clear();
    try {
      this.ws.close();
    } catch {
      /* already closing */
    }
  }
}

export interface RelayClientOptions {
  relayUrl: string;
  orgId: string;
  userId: string;
  token?: string;
  deviceName?: string;
}

export class RelayClient {
  private readonly relayUrl: string;
  private readonly orgId: string;
  private readonly userId: string;
  private readonly token: string;
  private readonly deviceName: string;
  private indexWs: WebSocket | null = null;

  constructor({
    relayUrl,
    orgId,
    userId,
    token,
    deviceName = 'Standalone Controller',
  }: RelayClientOptions) {
    this.relayUrl = relayUrl.replace(/\/$/, '');
    this.orgId = orgId;
    this.userId = userId;
    this.token = token ?? makeRelayToken(userId, orgId);
    this.deviceName = deviceName;
  }

  /** Room ids carry colons and must NOT be percent-encoded -- the relay slices the raw path. */
  private url(roomId: string): string {
    return `${this.relayUrl}/sync/${roomId}?token=${encodeURIComponent(this.token)}&platform=standalone&version=1`;
  }

  private open(roomId: string, timeoutMs = 10000): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url(roomId));
      const timer = setTimeout(() => {
        try {
          ws.close();
        } catch {
          /* already dead */
        }
        reject(new Error(`timed out opening ${roomId}`));
      }, timeoutMs);
      ws.onopen = () => {
        clearTimeout(timer);
        resolve(ws);
      };
      // A rejected upgrade surfaces here with no detail -- the relay destroys
      // the socket rather than replying. Distinguish "auth refused" from
      // "unreachable" via the relay log, not this event.
      ws.onerror = () => {
        clearTimeout(timer);
        reject(new Error(`relay refused or unreachable: ${roomId}`));
      };
    });
  }

  private awaitFrame(ws: WebSocket, type: string, timeoutMs = 10000): Promise<any> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out waiting for ${type}`)), timeoutMs);
      const onMessage = (event: MessageEvent) => {
        const frame = parseFrame(event);
        if (frame?.type !== type) return;
        clearTimeout(timer);
        ws.removeEventListener('message', onMessage);
        resolve(frame);
      };
      ws.addEventListener('message', onMessage);
    });
  }

  /**
   * Open the index connection and announce as `mobile`. The host gates
   * remote-drive on device type, so the controller presents itself as a phone --
   * the same masquerade the fork uses.
   */
  async connect(): Promise<WebSocket> {
    if (this.indexWs) return this.indexWs;
    const ws = await this.open(indexRoomId(this.orgId, this.userId));
    const now = Date.now();
    ws.send(
      JSON.stringify({
        type: 'deviceAnnounce',
        device: {
          deviceId: 'standalone-controller',
          name: this.deviceName,
          type: 'mobile',
          platform: 'standalone',
          connectedAt: now,
          lastActiveAt: now,
        },
      })
    );
    this.indexWs = ws;
    return ws;
  }

  /**
   * Session list with titles decrypted. `key` may be omitted to prove
   * connectivity before you have the seed -- titles then stay null.
   */
  async listSessions(
    key: CryptoKey | null
  ): Promise<{ sessions: RelaySession[]; projects: any[] }> {
    const ws = await this.connect();
    const pending = this.awaitFrame(ws, 'indexSyncResponse');
    ws.send(JSON.stringify({ type: 'indexSyncRequest' }));
    const snapshot = await pending;

    const sessions: RelaySession[] = [];
    for (const entry of snapshot.sessions ?? []) {
      let title: string | null = null;
      if (key && entry.encryptedTitle && entry.titleIv) {
        try {
          title = await decrypt(entry.encryptedTitle, entry.titleIv, key);
        } catch {
          title = null;
        }
      }
      sessions.push({
        sessionId: entry.sessionId,
        title,
        provider: entry.provider ?? null,
        messageCount: entry.messageCount ?? 0,
        updatedAt: entry.updatedAt ?? null,
      });
    }
    return { sessions, projects: snapshot.projects ?? [] };
  }

  /** Join a session room and return its decrypted backlog + a live feed. */
  async openSession(sessionId: string, key: CryptoKey | null): Promise<SessionHandle> {
    const ws = await this.open(sessionRoomId(this.orgId, this.userId, sessionId));
    const handle = new SessionHandle(ws, key, sessionId);
    const pending = this.awaitFrame(ws, 'syncResponse');
    ws.send(JSON.stringify({ type: 'syncRequest' }));
    const response = await pending;

    // Sequential rather than Promise.all: transcript order is the whole point,
    // and ingest() appends as it resolves.
    for (const raw of response.messages ?? []) {
      await handle.ingest(raw);
    }

    if (key && response.metadata?.encryptedTitle && response.metadata?.titleIv) {
      try {
        response.metadata.title = await decrypt(
          response.metadata.encryptedTitle,
          response.metadata.titleIv,
          key
        );
      } catch {
        response.metadata.title = null;
      }
    }
    handle.metadata = response.metadata ?? null;
    return handle;
  }

  /**
   * Send a control message. These travel the INDEX room, and note the payload
   * is NOT encrypted -- the host reads payload.prompt verbatim. Transcripts are
   * E2E-encrypted; control payloads are not. Acceptable only because the relay
   * is tailnet-only.
   */
  async sendControl(sessionId: string, messageType: string, payload?: unknown): Promise<void> {
    const ws = await this.connect();
    ws.send(
      JSON.stringify({
        type: 'sessionControl',
        message: { sessionId, messageType, payload, timestamp: Date.now(), sentBy: 'mobile' },
      })
    );
  }

  /**
   * Drive a session. The id must be a UUID: the host skips anything prefixed
   * `local-`, treating it as its own echo.
   */
  async sendPrompt(sessionId: string, prompt: string): Promise<string> {
    const promptId = crypto.randomUUID();
    await this.sendControl(sessionId, CONTROL.PROMPT, { promptId, prompt });
    return promptId;
  }

  async cancel(sessionId: string): Promise<void> {
    await this.sendControl(sessionId, CONTROL.CANCEL);
  }

  /** Answer an interactive prompt -- this is how tool permissions get approved. */
  async respondToPrompt(sessionId: string, payload: unknown): Promise<void> {
    await this.sendControl(sessionId, CONTROL.PROMPT_RESPONSE, payload);
  }

  async setArchived(sessionId: string, isArchived: boolean): Promise<void> {
    await this.sendControl(sessionId, CONTROL.ARCHIVE, { isArchived });
  }

  close(): void {
    try {
      this.indexWs?.close();
    } catch {
      /* already closing */
    }
    this.indexWs = null;
  }
}
