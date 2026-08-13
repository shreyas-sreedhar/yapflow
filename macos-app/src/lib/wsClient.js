/**
 * WebSocket client to the Jetson server. Opens one fresh connection per
 * dictation (hotkey-down to hotkey-up), per the protocol documented in
 * jetson-server/server.py's module docstring.
 *
 * Wire format: raw signed 16-bit little-endian PCM, 16kHz, mono, in binary
 * frames, interleaved with JSON control messages.
 *
 * There used to be an Opus encode path here behind a SEND_OPUS_OVER_WIRE flag,
 * with a matching EXPECT_RAW_PCM flag on the server, both hand-synced to the
 * raw-PCM setting. It's gone, for three reasons: it was never enabled, it
 * couldn't have worked as written (the chunks handed to it were 2.6ms, and Opus
 * only accepts 2.5/5/10/20/40/60ms frames, so encode() would have thrown), and
 * raw 16kHz mono PCM is ~32KB/s — nothing worth compressing on a home LAN. If
 * bandwidth ever does matter, add it deliberately with correctly-sized frames
 * rather than reviving a flag.
 */

const WebSocket = require('ws');
const { EventEmitter } = require('events');

class DictationConnection extends EventEmitter {
  /**
   * @param {string} url - e.g. ws://jetson.local:8765
   * @param {string|null} sharedSecret
   * @param {string[]} [knownTerms] - locally-learned personal dictionary
   *   terms (see lib/corrections.js getLearnedTerms), sent to the Jetson in the
   *   'start' message, where the touch-up step uses them for whole-word
   *   substitution.
   */
  constructor(url, sharedSecret, knownTerms = []) {
    super();
    this._url = url;
    this._sharedSecret = sharedSecret;
    this._knownTerms = knownTerms;
    this._ws = null;
    this._isOpen = false;
    this._pendingChunks = [];
  }

  connect() {
    this._ws = new WebSocket(this._url);

    this._ws.on('open', () => {
      this._isOpen = true;
      this._ws.send(
        JSON.stringify({
          type: 'start',
          secret: this._sharedSecret || undefined,
          known_terms: this._knownTerms,
        })
      );
      // Flush anything captured between hotkey-down and socket-open.
      for (const chunk of this._pendingChunks) {
        this._ws.send(chunk);
      }
      this._pendingChunks = [];
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
          // injecting at a cursor want session_text — see main.js. It's absent
          // on older servers, hence the null.
          this.emit('partial', {
            text: parsed.text,
            isFinal: parsed.is_final,
            lineIndex: parsed.line_index ?? null,
            sessionText: parsed.session_text ?? null,
          });
          break;
        case 'polished': {
          // Server-measured stage durations (see jetson-server/server.py).
          // Mapped to the camelCase shape lib/timing.js merges into the trace;
          // absent on older servers, in which case these stay undefined/null.
          //
          // touchup_ms is the current name for what used to be gemma_ms, back
          // when the touch-up was an LLM call. The server still emits gemma_ms
          // as a deprecated alias; prefer touchup_ms and fall back, so this
          // works against a server on either side of that change.
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
        case 'error':
          this.emit('server-error', parsed.message);
          break;
        default:
          this.emit('error', new Error(`Unknown message type from server: ${parsed.type}`));
      }
    });

    this._ws.on('close', () => {
      this._isOpen = false;
      this.emit('close');
    });

    this._ws.on('error', (err) => {
      // Per the spec's resilience checklist (Step 6): if the Jetson is
      // unreachable mid-dictation, this should fail gracefully, not crash —
      // the caller (main.js) is responsible for leaving whatever raw
      // partial text is already injected in place rather than losing it.
      this.emit('error', err);
    });
  }

  /**
   * Feed a chunk of int16 PCM audio (as a Buffer/ArrayBuffer) in, as-is.
   */
  sendAudioChunk(int16Buffer) {
    const outgoing = Buffer.isBuffer(int16Buffer) ? int16Buffer : Buffer.from(int16Buffer);

    if (this._isOpen) {
      this._ws.send(outgoing);
    } else {
      // Hotkey was pressed and capture started before the socket finished
      // connecting — buffer briefly rather than dropping audio.
      this._pendingChunks.push(outgoing);
    }
  }

  /** Call when the hotkey is released. */
  endUtterance() {
    if (this._isOpen) {
      this._ws.send(JSON.stringify({ type: 'end_of_utterance' }));
    }
  }

  close() {
    if (this._ws) {
      this._ws.close();
    }
  }
}

module.exports = { DictationConnection, SEND_OPUS_OVER_WIRE };
