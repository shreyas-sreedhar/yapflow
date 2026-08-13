"""
Yapflow Jetson WebSocket server.

Protocol (JSON control messages interleaved with binary Opus frames, on one
persistent connection per dictation):

  Mac -> Jetson, on hotkey press:
    {"type": "start", "secret": "<optional shared secret>", "known_terms": ["term1", "term2", ...]}
    (known_terms is the Mac's locally-learned personal dictionary, per
    docs/yapflow-master-plan.md Section 3.3 — optional, defaults to
    empty if omitted)

  Mac -> Jetson, continuously while hotkey held:
    binary frame: one Opus-encoded audio packet (20-50ms of audio)

  Mac -> Jetson, on hotkey release:
    {"type": "end_of_utterance"}

  Jetson -> Mac, as Moonshine produces partial/final transcript lines:
    {"type": "partial", "text": "...", "is_final": false}
    {"type": "partial", "text": "...", "is_final": true}

  Jetson -> Mac, once Gemma has polished the final transcript:
    {"type": "polished", "raw_text": "...", "polished_text": "...",
     "timings": {"asr_finalize_ms": <int>, "gemma_ms": <int>}}
    (timings are server-measured DURATIONS, not timestamps — the Mac merges
    them into its own per-stage latency trace by value, never by wall-clock,
    since the two machines' clocks aren't synced. See the Mac's
    mac-app/src/lib/timing.js and docs/yapflow-master-plan.md Section 4.)

  Jetson -> Mac, on any server-side error during a session:
    {"type": "error", "message": "..."}

This module deliberately does NOT decode Opus itself by default — see the
OPUS_DECODE_ON_SERVER flag below. Decoding on the Mac client and sending raw
PCM is simpler and keeps this server's dependency footprint small, but Opus
is kept as the wire format either way (per the spec's reasoning on why Opus
matters for bandwidth/latency over WiFi). If you DO want to decode Opus here
instead, set OPUS_DECODE_ON_SERVER = True and ensure `opuslib` (or another
Opus binding) is installed — see requirements.txt.
"""

from __future__ import annotations

import asyncio
import json
import logging
import time

import websockets
from websockets.server import WebSocketServerProtocol

import config
from asr import StreamingSession, get_transcriber
from polish import polish

logging.basicConfig(level=getattr(logging, config.LOG_LEVEL, logging.INFO))
logger = logging.getLogger("yapflow.server")

# If True, this server expects raw PCM (int16, 16kHz, mono) binary frames
# instead of Opus-encoded frames, and skips decoding entirely. Flip this
# based on whether you decide to decode Opus on the Mac (simpler Jetson
# deps) or here (smaller Mac app, more Jetson deps). Default: Mac decodes,
# matching "keep the Jetson server surface minimal" from CLAUDE.md.
EXPECT_RAW_PCM = True


def _timings(asr_finalize_ms: int, touchup_ms: "int | None") -> dict:
    """
    Build the server-measured durations block.

    `gemma_ms` is emitted as a deprecated alias for `touchup_ms` so the Mac's
    existing metrics dashboard and the `gemma_ms` column in its SQLite sessions
    table keep working across the version skew between the two sides. Drop the
    alias once the Mac app has shipped a build that reads `touchup_ms`.
    """
    return {
        "asr_finalize_ms": asr_finalize_ms,
        "touchup_ms": touchup_ms,
        "gemma_ms": touchup_ms,  # deprecated alias
    }


async def _handle_session(websocket: WebSocketServerProtocol) -> None:
    """
    One call of this function = one dictation session = one WebSocket
    connection lifecycle. The Mac client is expected to open a fresh
    connection per dictation (hotkey press to hotkey release), not keep one
    long-lived socket across multiple dictations — this keeps session state
    (the ASR Stream) trivially scoped and avoids any cross-dictation state
    bugs.
    """
    if config.SHARED_SECRET:
        # The first message on every connection must be the start control
        # message carrying the shared secret, if one is configured.
        try:
            first_raw = await asyncio.wait_for(websocket.recv(), timeout=5.0)
        except asyncio.TimeoutError:
            await websocket.close(code=4001, reason="auth timeout")
            return

        try:
            first_msg = json.loads(first_raw)
        except (json.JSONDecodeError, TypeError):
            await websocket.close(code=4002, reason="expected JSON start message")
            return

        if first_msg.get("type") != "start" or first_msg.get("secret") != config.SHARED_SECRET:
            logger.warning("Rejected connection: bad or missing shared secret")
            await websocket.close(code=4003, reason="unauthorized")
            return
        known_terms = first_msg.get("known_terms", [])
    else:
        # No secret configured — still expect (and discard) a start message
        # for protocol consistency, but don't enforce a token.
        try:
            first_raw = await asyncio.wait_for(websocket.recv(), timeout=5.0)
            first_msg = json.loads(first_raw)  # validate it's well-formed JSON
        except (asyncio.TimeoutError, json.JSONDecodeError, TypeError):
            await websocket.close(code=4002, reason="expected JSON start message")
            return
        known_terms = first_msg.get("known_terms", []) if isinstance(first_msg, dict) else []

    session = StreamingSession()
    logger.info("Dictation session started")

    async def _stream_results_to_client():
        """Forward Moonshine's partial/final results to the Mac as they arrive."""
        try:
            async for result in session.results():
                await websocket.send(
                    json.dumps(
                        {
                            "type": "partial",
                            "text": result.text,
                            "is_final": result.is_final,
                            "line_index": result.line_index,
                            "session_text": result.session_text,
                        }
                    )
                )
        except websockets.exceptions.ConnectionClosed:
            pass

    forward_task = asyncio.create_task(_stream_results_to_client())

    try:
        async for message in websocket:
            if isinstance(message, (bytes, bytearray)):
                # An audio frame. EXPECT_RAW_PCM controls whether this is
                # already-decoded PCM or still-Opus-encoded — see module
                # docstring. If you switch to server-side Opus decode, this
                # is the line to change (decode, then feed_pcm_int16).
                if EXPECT_RAW_PCM:
                    session.feed_pcm_int16(message)
                else:
                    raise NotImplementedError(
                        "Server-side Opus decoding not enabled — set "
                        "EXPECT_RAW_PCM=False and implement decode here, or "
                        "decode on the Mac client instead (recommended)."
                    )
                continue

            # A JSON control message.
            try:
                control = json.loads(message)
            except (json.JSONDecodeError, TypeError):
                logger.warning("Ignoring malformed control message: %r", message)
                continue

            if control.get("type") == "end_of_utterance":
                break
            else:
                logger.warning("Ignoring unrecognized control message type: %r", control.get("type"))

    except websockets.exceptions.ConnectionClosed:
        logger.info("Connection closed by client mid-dictation (network drop?)")
        # If the connection drops mid-dictation there's nobody left to send the
        # transcript to, so we just tear down. The Mac client is responsible for
        # leaving whatever raw partial text it already injected in place rather
        # than losing it — see macos-app/src/lib/wsClient.js.
        #
        # finalize() must still run even though we discard its result: it's what
        # calls _stream.stop(), and without it the Moonshine stream and its
        # thread leak for the lifetime of the process. This path used to call
        # close() alone, which only removes the listener.
        forward_task.cancel()
        try:
            session.finalize()
        except Exception:
            logger.exception("Error finalizing ASR session after connection drop")
        finally:
            session.close()
        return

    # Hotkey released (or connection ended cleanly): finalize ASR, run the
    # deterministic touch-up, send the result back. We time each stage
    # (monotonic perf_counter) so the Mac can attribute post-release latency
    # to ASR vs. touch-up — see macos-app/src/lib/timing.js.
    forward_task.cancel()
    _t_finalize_start = time.perf_counter()
    raw_text = session.finalize()
    session.close()
    asr_finalize_ms = round((time.perf_counter() - _t_finalize_start) * 1000)

    if not raw_text.strip():
        # Very short utterance, or no speech detected. Per the spec's
        # resilience checklist (Step 6), this should not error or hang —
        # just report back an empty polish result and let the client decide
        # what to do (almost certainly: nothing, no text was said).
        await websocket.send(
            json.dumps(
                {
                    "type": "polished",
                    "raw_text": "",
                    "polished_text": "",
                    "timings": _timings(asr_finalize_ms, None),
                }
            )
        )
        logger.info("Dictation session ended with no speech detected")
        return

    touchup_ms = None
    try:
        _t_polish_start = time.perf_counter()
        polished_text = polish(raw_text, personalize=True, known_terms=known_terms)
        touchup_ms = round((time.perf_counter() - _t_polish_start) * 1000)
    except Exception:
        logger.exception("Unhandled error during touch-up step")
        await websocket.send(
            json.dumps({"type": "error", "message": "touch-up step failed, raw transcript follows"})
        )
        polished_text = raw_text

    await websocket.send(
        json.dumps(
            {
                "type": "polished",
                "raw_text": raw_text,
                "polished_text": polished_text,
                "timings": _timings(asr_finalize_ms, touchup_ms),
            }
        )
    )
    logger.info(
        "Dictation session complete (asr_finalize=%sms, touchup=%sms)", asr_finalize_ms, touchup_ms
    )


def _warm_models() -> None:
    """
    Load Moonshine at startup so the FIRST dictation isn't slow. Best-effort:
    if the model download hasn't finished, log and carry on — get_transcriber()
    will retry lazily on first use.

    There is only one model to warm now; the Gemma/Ollama preload that used to
    live here went away with the LLM polish step. The load happens exactly once
    and the model stays resident for the process lifetime, which also avoids the
    CMA fragmentation that repeated load/unload cycles cause on this hardware.

    Note this loads weights but does not run a dummy inference, so a first-call
    graph-build cost (if any) is still paid on dictation #1.
    """
    try:
        logger.info("Warming Moonshine model at startup...")
        get_transcriber()
    except Exception:
        logger.exception("Moonshine warm-up failed; will load lazily on first dictation")


async def main() -> None:
    logger.info("Starting Yapflow server on %s:%d", config.HOST, config.PORT)
    # Warm-up is blocking model I/O; run it off the event loop so startup
    # logging/serve setup isn't stalled, but await it before accepting
    # connections so the first client doesn't race a half-loaded model.
    await asyncio.get_event_loop().run_in_executor(None, _warm_models)
    async with websockets.serve(_handle_session, config.HOST, config.PORT, max_size=2**22):
        await asyncio.Future()  # run forever


if __name__ == "__main__":
    asyncio.run(main())
