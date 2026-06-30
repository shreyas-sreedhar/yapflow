/**
 * WebSocket client to the Jetson server. Opens one fresh connection per
 * dictation (hotkey-down to hotkey-up), per the protocol documented in
 * jetson-server/server.py's module docstring — this keeps session state
 * trivially scoped on both ends rather than multiplexing dictations over a
 * long-lived socket.
 *
 * Wire format: matches jetson-server/server.py's EXPECT_RAW_PCM = True
 * default — this client decodes nothing and sends nothing as Opus over the
 * wire by default; instead it Opus-ENCODES on the way out only if
 * SEND_OPUS_OVER_WIRE is true below. Read the note on that flag before
 * assuming which mode is active.
 */

const WebSocket = require('ws');
const { OpusEncoder } = require('@discordjs/opus');
const { EventEmitter } = require('events');

const SAMPLE_RATE = 16000;
const CHANNELS = 1;

/**
 * Whether to Opus-encode audio before sending it over the wire to the
 * Jetson. The spec's original reasoning for Opus (roughly 10-20x
 * compression vs raw PCM, negligible quality loss for voice, purpose-built
 * for small real-time chunks) is about WIRE bandwidth over WiFi, not about
 * what the Jetson does internally — Moonshine wants float32 PCM either way
 * (see jetson-server/asr.py), so something has to decode Opus before it
 * reaches Moonshine.
 *
 * jetson-server/server.py defaults to EXPECT_RAW_PCM = True, meaning it
 * expects already-decoded PCM and does NOT decode Opus itself by default
 * (to keep its dependency footprint minimal). If you set this flag to
 * true here, you MUST also flip EXPECT_RAW_PCM to False on the server and
 * implement Opus decoding there (e.g. via opuslib) — otherwise the server
 * will try to interpret Opus-encoded bytes as raw int16 PCM, which will
 * produce garbage transcriptions, not an error you'll necessarily notice
 * immediately. Keep these two flags in sync across the repo.
 *
 * Given a home WiFi network (not cellular), raw 16kHz mono int16 PCM is
 * only ~32KB/sec — modest enough that skipping Opus entirely and sending
 * raw PCM is a perfectly reasonable starting point, deferring the Opus
 * encode/decode complexity until you've confirmed it's actually needed.
 * Default here is OFF for that reason; flip both flags together if you
 * want to match Wispr Flow's actual wire format more closely later.
 */
const SEND_OPUS_OVER_WIRE = false;

class DictationConnection extends EventEmitter {
  /**
   * @param {string} url - e.g. ws://jetson.local:8765
   * @param {string|null} sharedSecret
   * @param {string[]} [knownTerms] - locally-learned personal dictionary
   *   terms (see lib/corrections.js getLearnedTerms), sent to the Jetson
   *   in the 'start' message so the Gemma polish call can use them. See
   *   docs/yapflow-master-plan.md Section 3.3.
   */
  constructor(url, sharedSecret, knownTerms = []) {
    super();
    this._url = url;
    this._sharedSecret = sharedSecret;
    this._knownTerms = knownTerms;
    this._ws = null;
    this._opusEncoder = SEND_OPUS_OVER_WIRE ? new OpusEncoder(SAMPLE_RATE, CHANNELS) : null;
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
          this.emit('partial', { text: parsed.text, isFinal: parsed.is_final });
          break;
        case 'polished': {
          // Server-measured stage durations (see jetson-server/server.py).
          // Mapped to the camelCase shape lib/timing.js merges into the trace;
          // absent on older servers, in which case these stay undefined/null.
          const t = parsed.timings || {};
          this.emit('polished', {
            rawText: parsed.raw_text,
            polishedText: parsed.polished_text,
            timings: { asrFinalizeMs: t.asr_finalize_ms ?? null, gemmaMs: t.gemma_ms ?? null },
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
   * Feed a chunk of int16 PCM audio (as a Buffer/ArrayBuffer) in. Encodes
   * to Opus first if SEND_OPUS_OVER_WIRE is true, otherwise sends as-is.
   */
  sendAudioChunk(int16Buffer) {
    const buf = Buffer.isBuffer(int16Buffer) ? int16Buffer : Buffer.from(int16Buffer);
    const outgoing = this._opusEncoder ? this._opusEncoder.encode(buf) : buf;

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
