/**
 * WebSocket client to the Jetson server.
 *
 * ONE PERSISTENT CONNECTION, MANY DICTATIONS. This used to open a fresh socket
 * per dictation, which put a TCP connect, a WebSocket handshake, and an auth
 * round-trip in the hotkey path before the first audio byte could flow. No audio
 * was lost — audio captured before the socket opened was buffered and flushed —
 * but the ASR couldn't start incremental work until the socket was up, so it got
 * a burst instead of a stream. That erodes exactly the property Moonshine is
 * chosen for, and it hits short utterances hardest.
 *
 * Now: connect at app start, keep it warm, reconnect in the background with
 * backoff. Hotkey-down is just a control message on an already-open socket.
 *
 * Wire format: raw signed 16-bit little-endian PCM, 16kHz, mono, ~20ms per
 * binary frame, interleaved with JSON control messages. See
 * jetson-server/server.py's module docstring for the authoritative protocol.
 *
 * There used to be an Opus encode path behind a SEND_OPUS_OVER_WIRE flag, with a
 * matching EXPECT_RAW_PCM flag on the server, both hand-synced to raw PCM. It's
 * gone: it was never enabled, and it couldn't have worked as written — the chunks
 * handed to it were 2.6ms, and Opus only accepts 2.5/5/10/20/40/60ms frames, so
 * encode() would have thrown. Raw PCM is ~32KB/s, which needs no compression on a
 * LAN. If that ever changes, add it deliberately with correctly-sized frames.
 */

const WebSocket = require('ws');
const { EventEmitter } = require('events');

// Reconnect backoff. Starts fast because the common case is the Jetson rebooting
// or WiFi blipping, and caps low enough that the socket is reliably back before
// the next dictation.
const RECONNECT_BASE_MS = 500;
const RECONNECT_MAX_MS = 15000;

// Cap on audio buffered while the socket is down, in ~20ms frames. 1500 frames
// is about 30 seconds — long enough to cover a reconnect mid-utterance, bounded
// so a Jetson that stays down can't grow this without limit.
const MAX_PENDING_FRAMES = 1500;

class DictationConnection extends EventEmitter {
  /**
   * @param {string} url - e.g. ws://jetson.local:8765
   * @param {string|null} sharedSecret - must match jetson-server config.SHARED_SECRET
   */
  constructor(url, sharedSecret) {
    super();
    this._url = url;
    this._sharedSecret = sharedSecret;
    this._ws = null;
    this._isOpen = false;
    this._stopped = false;
    this._reconnectAttempts = 0;
    this._reconnectTimer = null;
    // Audio captured while the socket is down, flushed on open.
    this._pendingChunks = [];
    // Whether a dictation is currently in progress. Tracked so a reconnect
    // mid-utterance can reopen the utterance on the new socket rather than
    // silently dropping the rest of it.
    this._inUtterance = false;
    this._knownTerms = [];
  }

  get isConnected() {
    return this._isOpen;
  }

  /** Opens the connection and keeps it open until stop() is called. */
  start() {
    this._stopped = false;
    this._connect();
  }

  /** Closes permanently — no reconnect. Call on app quit. */
  stop() {
    this._stopped = true;
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    if (this._ws) {
      this._ws.close();
      this._ws = null;
    }
    this._isOpen = false;
  }

  _connect() {
    if (this._stopped) return;

    this._ws = new WebSocket(this._url);

    this._ws.on('open', () => {
      this._isOpen = true;
      this._reconnectAttempts = 0;

      // 'hello' authenticates the connection without opening an utterance. An
      // older server treats only 'start' as valid, so it will reject this — see
      // the 'close' handler, which reports that rather than silently retrying
      // forever.
      this._send({
        type: 'hello',
        secret: this._sharedSecret || undefined,
      });

      // If the socket dropped mid-dictation, reopen the utterance so the rest of
      // what the user is saying still lands.
      if (this._inUtterance) {
        this._send({ type: 'start_utterance', known_terms: this._knownTerms });
      }

      this._flushPending();
      this.emit('open');
    });

    this._ws.on('message', (data) => {
      let parsed;
      try {
        parsed = JSON.parse(data.toString());
      } catch (err) {
        this.emit('error', new Error(`Malformed message from server: ${data}`));
        return;
      }

      switch (parsed.type) {
        case 'partial':
          // `text` is per-line and restarts at every speech pause;
          // `session_text` is cumulative across the whole dictation. Callers
          // injecting at a cursor want session_text — see main.js. Absent on
          // older servers, hence the null.
          this.emit('partial', {
            text: parsed.text,
            isFinal: parsed.is_final,
            lineIndex: parsed.line_index ?? null,
            sessionText: parsed.session_text ?? null,
          });
          break;

        case 'polished': {
          // The utterance is over once this arrives.
          this._inUtterance = false;

          // Server-measured stage durations, mapped to the camelCase shape
          // lib/timing.js merges into the trace.
          //
          // touchup_ms is the current name for what used to be gemma_ms, back
          // when the touch-up was an LLM call. The server still emits gemma_ms
          // as a deprecated alias; prefer touchup_ms and fall back, so this works
          // against a server on either side of that change.
          const t = parsed.timings || {};
          const touchupMs = t.touchup_ms ?? t.gemma_ms ?? null;
          this.emit('polished', {
            rawText: parsed.raw_text,
            polishedText: parsed.polished_text,
            timings: {
              asrFinalizeMs: t.asr_finalize_ms ?? null,
              touchupMs,
              gemmaMs: touchupMs, // deprecated alias, kept for the metrics schema
            },
          });
          break;
        }

        case 'pong':
          this.emit('pong');
          break;

        case 'error':
          this.emit('server-error', parsed.message);
          break;

        default:
          this.emit('error', new Error(`Unknown message type from server: ${parsed.type}`));
      }
    });

    this._ws.on('close', (code, reason) => {
      this._isOpen = false;
      this.emit('close', { code, reason: reason?.toString() });

      // 4003 is an auth rejection and 4002 a protocol mismatch — retrying won't
      // fix either, so surface them instead of looping.
      if (code === 4003) {
        this.emit(
          'error',
          new Error('Jetson rejected the shared secret — check YAPFLOW_SECRET on both sides')
        );
        this._stopped = true;
        return;
      }
      if (code === 4002) {
        this.emit(
          'error',
          new Error(
            'Jetson rejected the handshake — it may be running a version that predates ' +
              'the persistent-connection protocol. Update jetson-server.'
          )
        );
        this._stopped = true;
        return;
      }

      this._scheduleReconnect();
    });

    this._ws.on('error', (err) => {
      // Don't crash on an unreachable Jetson. The 'close' handler that follows
      // schedules the retry; main.js leaves any already-injected partial text in
      // place rather than losing it.
      this.emit('error', err);
    });
  }

  _scheduleReconnect() {
    if (this._stopped || this._reconnectTimer) return;

    const delay = Math.min(
      RECONNECT_BASE_MS * 2 ** this._reconnectAttempts,
      RECONNECT_MAX_MS
    );
    this._reconnectAttempts++;

    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      this._connect();
    }, delay);
  }

  _send(obj) {
    if (this._isOpen && this._ws) {
      this._ws.send(JSON.stringify(obj));
      return true;
    }
    return false;
  }

  _flushPending() {
    if (!this._isOpen || this._pendingChunks.length === 0) return;
    for (const chunk of this._pendingChunks) {
      this._ws.send(chunk);
    }
    this._pendingChunks = [];
  }

  /**
   * Call on hotkey-down. Opens an utterance on the existing socket — no connect,
   * no handshake.
   *
   * @param {string[]} knownTerms - personal dictionary for this dictation (see
   *   lib/corrections.js getLearnedTerms). Sent per utterance because the
   *   dictionary grows as the user corrects things.
   */
  beginUtterance(knownTerms = []) {
    this._knownTerms = knownTerms;
    this._inUtterance = true;
    this._pendingChunks = [];
    this._send({ type: 'start_utterance', known_terms: knownTerms });
  }

  /** Feed a chunk of int16 PCM audio (Buffer or ArrayBuffer) in, as-is. */
  sendAudioChunk(int16Buffer) {
    const outgoing = Buffer.isBuffer(int16Buffer) ? int16Buffer : Buffer.from(int16Buffer);

    if (this._isOpen) {
      this._ws.send(outgoing);
      return;
    }

    // Socket is down. Buffer so a reconnect mid-utterance doesn't cost the
    // dictation, but bounded — drop the oldest rather than growing without limit
    // if the Jetson stays unreachable.
    if (this._pendingChunks.length >= MAX_PENDING_FRAMES) {
      this._pendingChunks.shift();
    }
    this._pendingChunks.push(outgoing);
  }

  /** Call on hotkey-release. */
  endUtterance() {
    if (!this._inUtterance) return;

    const sent = this._send({ type: 'end_of_utterance' });

    // Either way the utterance is over from this side. Clearing the flag on the
    // SENT path too matters: if the socket drops between end_of_utterance and the
    // 'polished' reply, leaving it set made the reconnect handler open a phantom
    // utterance that nothing would ever end — and the next real dictation's
    // start_utterance would then land inside it.
    this._inUtterance = false;

    if (!sent) {
      // Socket is down, so no transcript is coming. Drop the buffered audio for an
      // utterance that can never be finalized.
      this._pendingChunks = [];
      this.emit('error', new Error('Jetson unreachable at end of dictation'));
    }
  }

  /** Liveness check that doesn't require dictating. Resolves on 'pong'. */
  ping() {
    return this._send({ type: 'ping' });
  }
}

module.exports = { DictationConnection };
