/**
 * The controller popover.
 *
 * Three states: pair (no config yet), the session list, and one open session.
 * Everything talks to RelayClient directly -- there is no main process, no IPC
 * and no Jotai store behind this, which is the whole point of the standalone
 * shape.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { projectRawMessagesToViewMessages } from '@nimbalyst/runtime/ai/server/transcript/projectRawMessages';
import type { RawMessage } from '@nimbalyst/runtime/ai/server/transcript/TranscriptTransformer';
import type { TranscriptViewMessage } from '@nimbalyst/runtime/ai/server/transcript/TranscriptProjector';

import { deriveEncryptionKey, INSECURE_CONTEXT_MESSAGE, isCryptoAvailable } from './relay/crypto';
import { groupByProject } from './projectGroups';
import { RelayClient, type RelayMessage, type RelaySession, type SessionHandle } from './relay/relayClient';
import {
  clearConfig,
  loadConfig,
  parsePairingPayload,
  peekRelayUrl,
  saveConfig,
  type ControllerConfig,
} from './config';
import {
  applyReplyStyle,
  loadReplyStyle,
  nextReplyStyle,
  REPLY_STYLE_LABELS,
  saveReplyStyle,
  type ReplyStyle,
} from './replyStyle';
import { NotesPanel } from '@nimbalyst/runtime/notes/NotesPanel';
import { createLocalStoragePersistence } from './notes/storage';

/** Turn relay messages into the raw shape the host's own projector expects. */
function toRawMessages(messages: RelayMessage[], sessionId: string): RawMessage[] {
  // The host flags its own bookkeeping rows hidden; they are not transcript.
  return messages
    .filter((m) => !m.hidden)
    .map((m, i) => ({
      id: Number.isFinite(Number(m.id)) ? Number(m.id) : i + 1,
      sessionId,
      source: m.source,
      direction: m.direction,
      content: m.content ?? '',
      createdAt: m.createdAt ? new Date(m.createdAt) : new Date(0),
      metadata: undefined,
      hidden: false,
    })) as RawMessage[];
}

function PairScreen({ onPaired }: { onPaired: (c: ControllerConfig) => void }) {
  const [text, setText] = useState('');
  const [relayUrl, setRelayUrl] = useState('');
  const [relayEdited, setRelayEdited] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Prefill from the payload, but never clobber a hand-typed value -- overriding
  // what the host advertised is the entire point of the field.
  useEffect(() => {
    if (relayEdited) return;
    const advertised = peekRelayUrl(text);
    if (advertised) setRelayUrl(advertised);
  }, [text, relayEdited]);

  const submit = () => {
    if (!isCryptoAvailable()) {
      setError(INSECURE_CONTEXT_MESSAGE);
      return;
    }
    try {
      const config = parsePairingPayload(text, { relayUrl });
      saveConfig(config);
      onPaired(config);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="controller-pair">
      <h1 className="controller-pair-title">Pair with your host</h1>
      <p className="controller-pair-hint">
        On the host: Settings → Sync → QR pairing → <strong>Copy payload</strong>, then paste here.
      </p>
      <textarea
        className="controller-pair-input"
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          setError(null);
        }}
        placeholder='{"version":5,"serverUrl":"wss://…","encryptionKeySeed":"…"}'
        spellCheck={false}
        autoFocus
      />
      <label className="controller-pair-relay-label" htmlFor="controller-relay-url">
        Relay URL
      </label>
      <input
        id="controller-relay-url"
        className="controller-pair-relay-input"
        value={relayUrl}
        onChange={(e) => {
          setRelayEdited(true);
          setRelayUrl(e.target.value);
          setError(null);
        }}
        placeholder="wss://…"
        spellCheck={false}
      />
      <p className="controller-pair-hint">
        Prefilled from the payload. A host running against a self-hosted relay still advertises the
        production URL, which rejects the controller — correct it here.
      </p>
      {error && <div className="controller-pair-error">{error}</div>}
      <button className="controller-pair-submit" onClick={submit} disabled={!text.trim()}>
        Pair
      </button>
    </div>
  );
}

function SessionList({
  sessions,
  loading,
  error,
  onOpen,
  onReload,
  onUnpair,
}: {
  sessions: RelaySession[];
  loading: boolean;
  error: string | null;
  onOpen: (s: RelaySession) => void;
  onReload: () => void;
  onUnpair: () => void;
}) {
  const [query, setQuery] = useState('');
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return sessions;
    return sessions.filter((s) =>
      `${s.title ?? s.sessionId} ${s.projectPath ?? ''}`.toLowerCase().includes(q)
    );
  }, [sessions, query]);

  // Every enabled project shares one index room, so without this the list reads
  // as a single flat workspace no matter how many projects are syncing.
  const groups = useMemo(() => groupByProject(filtered), [filtered]);

  return (
    <div className="controller-list">
      <div className="controller-list-header">
        <input
          className="controller-list-search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search sessions"
          autoFocus
        />
        <button className="controller-list-reload" onClick={onReload} title="Reload">
          ↻
        </button>
      </div>

      {error && <div className="controller-error">{error}</div>}
      {loading && <div className="controller-muted">Connecting…</div>}
      {!loading && !error && filtered.length === 0 && (
        <div className="controller-muted">
          {sessions.length === 0 ? 'No sessions on the relay yet.' : 'Nothing matches.'}
        </div>
      )}

      {groups.map((group) => {
        const isCollapsed = collapsed.has(group.key);
        return (
          <section className="controller-project-group" key={group.key}>
            <button
              className="controller-project-header"
              onClick={() =>
                setCollapsed((prev) => {
                  const next = new Set(prev);
                  if (!next.delete(group.key)) next.add(group.key);
                  return next;
                })
              }
              aria-expanded={!isCollapsed}
            >
              <span className="controller-project-caret">{isCollapsed ? '▸' : '▾'}</span>
              <span className="controller-project-name" title={group.path ?? undefined}>
                {group.label}
              </span>
              <span className="controller-project-count">{group.sessions.length}</span>
            </button>
            {!isCollapsed && (
              <ul className="controller-list-items">
                {group.sessions.map((s) => (
                  <li key={s.sessionId}>
                    <button className="controller-list-item" onClick={() => onOpen(s)}>
                      <span className="controller-list-item-title">
                        {s.title ?? <em>untitled — check the seed</em>}
                      </span>
                      <span className="controller-list-item-meta">{s.provider ?? 'unknown'}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        );
      })}

      <button className="controller-unpair" onClick={onUnpair}>
        Unpair
      </button>
    </div>
  );
}

function SessionView({
  client,
  session,
  encryptionKey,
  onBack,
}: {
  client: RelayClient;
  session: RelaySession;
  encryptionKey: CryptoKey;
  onBack: () => void;
}) {
  const [view, setView] = useState<TranscriptViewMessage[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [prompt, setPrompt] = useState('');
  const [sending, setSending] = useState(false);
  const [replyStyle, setReplyStyle] = useState<ReplyStyle>(() => loadReplyStyle());
  const [compacting, setCompacting] = useState(false);
  const [tab, setTab] = useState<'session' | 'notes'>('session');
  const notesStore = useMemo(() => createLocalStoragePersistence(), []);
  const notesInitial = useMemo(() => notesStore.load(), [notesStore]);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const handleRef = useRef<SessionHandle | null>(null);
  // Guards against an out-of-order projection overwriting a newer one.
  const projectionToken = useRef(0);

  const reproject = useCallback(
    (messages: RelayMessage[]) => {
      const token = ++projectionToken.current;
      if (messages.length === 0) {
        setView([]);
        return;
      }
      void projectRawMessagesToViewMessages(
        toRawMessages(messages, session.sessionId),
        session.provider ?? 'claude-code'
      )
        .then((projected) => {
          if (projectionToken.current === token) setView(projected);
        })
        .catch(() => {
          /* a projection failure leaves the last good render in place */
        });
    },
    [session.sessionId, session.provider]
  );

  useEffect(() => {
    let disposed = false;
    let unsubscribe: (() => void) | undefined;

    void client
      .openSession(session.sessionId, encryptionKey)
      .then((handle) => {
        if (disposed) {
          handle.close();
          return;
        }
        handleRef.current = handle;
        reproject(handle.messages);
        unsubscribe = handle.onMessage(() => reproject(handle.messages));
      })
      .catch((err) => {
        if (!disposed) setError(err instanceof Error ? err.message : String(err));
      });

    return () => {
      disposed = true;
      unsubscribe?.();
      handleRef.current?.close();
      handleRef.current = null;
    };
  }, [client, session.sessionId, encryptionKey, reproject]);

  const send = async () => {
    const text = prompt.trim();
    if (!text) return;
    setSending(true);
    try {
      await client.sendPrompt(session.sessionId, applyReplyStyle(text, replyStyle));
      setPrompt('');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSending(false);
    }
  };

  /**
   * Hand the draft to the host for a terse rewrite. The result lands back in
   * the composer for editing -- compaction never sends.
   */
  const compact = async () => {
    const text = prompt.trim();
    if (!text || compacting) return;
    setCompacting(true);
    setError(null);
    try {
      setPrompt(await client.requestCompactedPrompt(session.sessionId, text));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setCompacting(false);
    }
  };

  // The host's last reply, offered to the notes pane for a one-click clip.
  const clipText = useMemo(() => {
    for (let i = view.length - 1; i >= 0; i--) {
      const m = view[i];
      if (!m.toolCall && m.type !== 'user_message' && m.text?.trim()) return m.text;
    }
    return null;
  }, [view]);

  // Note -> session: land the text in the composer, never auto-send, then flip
  // back so the user can review and press Send.
  const sendToComposer = useCallback((text: string) => {
    if (!text) return;
    setPrompt((p) => (p.trim() ? `${p.trimEnd()}\n${text}` : text));
    setTab('session');
    // The composer only exists after the tab flips; wait a tick to focus it.
    setTimeout(() => composerRef.current?.focus(), 0);
  }, []);

  // ⌥N flips between the transcript and the notes pad from anywhere.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.altKey && (e.code === 'KeyN' || e.key.toLowerCase() === 'n')) {
        e.preventDefault();
        setTab((t) => (t === 'notes' ? 'session' : 'notes'));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className="controller-session">
      <div className="controller-session-header">
        <button className="controller-back" onClick={onBack}>
          ←
        </button>
        <span className="controller-session-title">{session.title ?? session.sessionId}</span>
        <button
          className="controller-cancel"
          onClick={() => void client.cancel(session.sessionId)}
          title="Interrupt the agent"
        >
          Stop
        </button>
      </div>

      {error && <div className="controller-error">{error}</div>}

      <div className={`controller-notes-wrap${tab === 'notes' ? '' : ' controller-hidden'}`}>
        <NotesPanel
          initialState={notesInitial}
          onPersist={notesStore.save}
          onSendToComposer={sendToComposer}
          clipText={clipText}
          onExit={() => setTab('session')}
        />
      </div>
      <div className={`controller-session-main${tab === 'session' ? '' : ' controller-hidden'}`}>
      <div className="controller-transcript">
        {view.length === 0 && !error && <div className="controller-muted">No messages yet.</div>}
        {view.map((m) => (
          <div key={`${m.id}-${m.sequence}`} className={`controller-msg controller-msg-${m.type}`}>
            {m.toolCall ? (
              <span className="controller-msg-tool">
                {m.toolCall.toolDisplayName}
                {m.toolCall.description ? ` — ${m.toolCall.description}` : ''}
              </span>
            ) : (
              <span className="controller-msg-text">{m.text}</span>
            )}
          </div>
        ))}
      </div>

      <div className="controller-composer">
        <textarea
          ref={composerRef}
          className="controller-composer-input"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void send();
          }}
          placeholder="Send a prompt…  (Cmd+Enter)"
          rows={2}
        />
        <button
          className="controller-composer-compact"
          onClick={() => void compact()}
          disabled={compacting || sending || !prompt.trim()}
          title="Rewrite this draft into terse shorthand on the host. Does not send it."
        >
          {compacting ? '…' : 'Compact'}
        </button>
        <button
          className="controller-composer-style"
          onClick={() => {
            const next = nextReplyStyle(replyStyle);
            setReplyStyle(next);
            saveReplyStyle(next);
          }}
          title="How terse the agent should answer. Cycles Normal, Terse, Ultra."
        >
          {REPLY_STYLE_LABELS[replyStyle]}
        </button>
        <button className="controller-composer-send" onClick={() => void send()} disabled={sending || !prompt.trim()}>
          {sending ? '…' : 'Send'}
        </button>
      </div>
      </div>

      <div className="controller-tabbar" role="tablist">
        <button
          role="tab"
          aria-selected={tab === 'session'}
          aria-label="Session transcript"
          title="Session transcript (⌥N)"
          className={`controller-tabbar-btn${tab === 'session' ? ' is-active' : ''}`}
          onClick={() => setTab('session')}
        >
          {'≡'}
        </button>
        <button
          role="tab"
          aria-selected={tab === 'notes'}
          aria-label="Notes"
          title="Notes (⌥N)"
          className={`controller-tabbar-btn${tab === 'notes' ? ' is-active' : ''}`}
          onClick={() => setTab('notes')}
        >
          {'✎'}
        </button>
      </div>
    </div>
  );
}

export function App() {
  const [config, setConfig] = useState<ControllerConfig | null>(() => loadConfig());
  const [encryptionKey, setEncryptionKey] = useState<CryptoKey | null>(null);
  const [sessions, setSessions] = useState<RelaySession[]>([]);
  const [open, setOpen] = useState<RelaySession | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const client = useMemo(
    () =>
      config
        ? new RelayClient({ relayUrl: config.relayUrl, orgId: config.orgId, userId: config.userId })
        : null,
    [config]
  );

  const refresh = useCallback(async () => {
    if (!client || !config) return;
    if (!isCryptoAvailable()) {
      setError(INSECURE_CONTEXT_MESSAGE);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const key = await deriveEncryptionKey(config.seed, config.userId);
      setEncryptionKey(key);
      const { sessions: list } = await client.listSessions(key);
      setSessions(list);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [client, config]);

  useEffect(() => {
    void refresh();
    return () => client?.close();
  }, [refresh, client]);

  if (!config) return <PairScreen onPaired={setConfig} />;

  if (open && client && encryptionKey) {
    return (
      <SessionView
        client={client}
        session={open}
        encryptionKey={encryptionKey}
        onBack={() => setOpen(null)}
      />
    );
  }

  return (
    <SessionList
      sessions={sessions}
      loading={loading}
      error={error}
      onOpen={setOpen}
      onReload={() => void refresh()}
      onUnpair={() => {
        clearConfig();
        client?.close();
        setConfig(null);
        setSessions([]);
      }}
    />
  );
}
