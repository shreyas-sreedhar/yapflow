"""
Yapflow Jetson WebSocket server.

One connection per dictation, carrying JSON control messages interleaved with
binary audio frames.

AUDIO WIRE FORMAT: raw signed 16-bit little-endian PCM, 16kHz, mono, ~20ms
(640 bytes) per frame. Not Opus. Earlier versions of this docstring described an
Opus protocol behind an EXPECT_RAW_PCM flag, with a matching flag on the Mac —
both permanently set to raw PCM, and the Opus path could not have worked anyway
(the client handed it 2.6ms chunks, and Opus only accepts 2.5/5/10/20/40/60ms
frames). Both flags are gone. At ~32KB/s there is nothing worth compressing on a
LAN; if that changes, add it deliberately with correctly-sized frames.

The sample rate is NOT negotiated — it's fixed on both sides (asr.py's
PCM_SAMPLE_RATE and the Mac's TARGET_SAMPLE_RATE). A client sending a different
rate gets silently mis-transcribed rather than an error.

  Mac -> Jetson, on hotkey press:
    {"type": "start", "secret": "<optional shared secret>", "known_terms": [...]}
    known_terms is the Mac's locally-learned personal dictionary (see its
    lib/corrections.js getLearnedTerms); the touch-up step uses it for whole-word
    substitution. Optional, defaults to empty.

  Mac -> Jetson, continuously while the hotkey is held:
    binary frame: raw PCM16 audio as described above

  Mac -> Jetson, on hotkey release:
    {"type": "end_of_utterance"}

  Mac -> Jetson, any time:
    {"type": "ping"}   -> {"type": "pong"}   (health check without dictating)

  Jetson -> Mac, as Moonshine produces transcript updates:
    {"type": "partial", "text": "...", "is_final": <bool>,
     "line_index": <int>, "session_text": "..."}

    IMPORTANT: `text` is the text of ONE LINE. Moonshine segments on natural
    speech pauses, so when the speaker pauses, the current line completes and the
    next event starts a new line back at the beginning — `text` does NOT grow
    monotonically across a dictation. A client injecting at a cursor must use
    `session_text`, which is every line joined and does grow. Diffing against
    `text` is how a mid-sentence pause used to wipe already-injected text.

  Jetson -> Mac, once the transcript has been touched up:
    {"type": "polished", "raw_text": "...", "polished_text": "...",
     "timings": {"asr_finalize_ms": <int>, "touchup_ms": <int>, "gemma_ms": <int>}}

    timings are server-measured DURATIONS, never timestamps: the two machines'
    clocks aren't synced, so the Mac merges them into its own per-stage trace by
    value (see the Mac's lib/timing.js). `gemma_ms` is a deprecated alias for
    `touchup_ms`, kept while the Mac app catches up — the touch-up stopped being
    an LLM call.

  Jetson -> Mac, on a server-side error during a session:
    {"type": "error", "message": "..."}
    Note the transcript is still delivered after this; the touch-up falls back to
    the raw transcript rather than dropping the user's words.
"""

from __future__ import annotations

import asyncio
import json
import logging
import signal
import time

import websockets
from websockets.server import WebSocketServerProtocol

import config
from asr import StreamingSession, get_transcriber
from polish import polish

logging.basicConfig(level=getattr(logging, config.LOG_LEVEL, logging.INFO))
logger = logging.getLogger("yapflow.server")

# How long to wait for the result-forwarding task to flush the last queued
# partials after an utterance ends. These are already-computed results going out
# over an open socket, so this should complete in single-digit milliseconds; the
# ceiling only exists so a stalled send can't hold the dictation open.
RESULT_DRAIN_TIMEOUT_SECONDS = 1.0


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
    One call of this function = one WebSocket connection, carrying one OR MANY
    dictations.

    The connection used to be the dictation: the Mac opened a fresh socket on
    every hotkey press, which put a TCP connect, a WebSocket handshake, and an
    auth round-trip in the hot path before the first audio byte could flow. No
    audio was lost (the client buffers pre-connect), but the ASR couldn't begin
    incremental work until the socket was up, so it received a burst instead of a
    stream — eroding exactly the property Moonshine is chosen for, worst on the
    short utterances where latency is most noticeable.

    Now the client connects once at app start and keeps the socket warm.

    Two client shapes are accepted so the Mac app and the server can be rolled
    independently:

      NEW: {"type":"hello"} once, then {"type":"start_utterance"} / audio /
           {"type":"end_of_utterance"} per dictation, connection stays open.
      OLD: {"type":"start"} then audio then {"type":"end_of_utterance"}, one
           dictation, connection closes. Treated as hello + start_utterance.
    """
    handshake = await _authenticate(websocket)
    if handshake is None:
        return

    known_terms, legacy_single_shot = handshake

    if legacy_single_shot:
        # An old client's "start" both authenticated and opened the utterance.
        await _run_utterance(websocket, known_terms)
        return

    # Persistent mode: sit on the connection and run an utterance each time the
    # client opens one.
    try:
        async for message in websocket:
            if isinstance(message, (bytes, bytearray)):
                # Audio outside an utterance. Can arrive if the client races
                # hotkey-down against its own start_utterance; ignore rather than
                # erroring, since the client will resend once the utterance opens.
                logger.debug("Ignoring %d bytes of audio outside an utterance", len(message))
                continue

            try:
                control = json.loads(message)
            except (json.JSONDecodeError, TypeError):
                logger.warning("Ignoring malformed control message: %r", message)
                continue

            control_type = control.get("type")
            if control_type == "start_utterance":
                # Terms can be refreshed per utterance; the personal dictionary
                # grows as the user corrects things.
                if "known_terms" in control:
                    known_terms = control.get("known_terms") or []
                await _run_utterance(websocket, known_terms)
            elif control_type == "ping":
                await websocket.send(json.dumps({"type": "pong"}))
            elif control_type == "end_of_utterance":
                # Stray end without a start. Harmless.
                logger.debug("Ignoring end_of_utterance outside an utterance")
            else:
                logger.warning("Ignoring unrecognized control message type: %r", control_type)
    except websockets.exceptions.ConnectionClosed:
        logger.info("Client disconnected")


async def _authenticate(websocket: WebSocketServerProtocol):
    """
    Read and validate the first message on a connection.

    Returns (known_terms, legacy_single_shot), or None if the connection was
    rejected and closed.

    Close codes: 4001 handshake timeout, 4002 non-JSON handshake, 4003
    unauthorized.

    The timeout is generous because in persistent mode a client connects at app
    start and may not dictate for hours — but the HANDSHAKE itself still arrives
    immediately on connect, so a short window is fine and keeps half-open
    connections from accumulating.
    """
    try:
        first_raw = await asyncio.wait_for(websocket.recv(), timeout=10.0)
    except asyncio.TimeoutError:
        await websocket.close(code=4001, reason="handshake timeout")
        return None
    except websockets.exceptions.ConnectionClosed:
        return None

    try:
        first_msg = json.loads(first_raw)
    except (json.JSONDecodeError, TypeError):
        await websocket.close(code=4002, reason="expected a JSON handshake message")
        return None

    if not isinstance(first_msg, dict):
        await websocket.close(code=4002, reason="expected a JSON object")
        return None

    msg_type = first_msg.get("type")
    if msg_type not in ("hello", "start"):
        await websocket.close(code=4002, reason="expected 'hello' or 'start'")
        return None

    if config.SHARED_SECRET and first_msg.get("secret") != config.SHARED_SECRET:
        logger.warning("Rejected connection: bad or missing shared secret")
        await websocket.close(code=4003, reason="unauthorized")
        return None

    known_terms = first_msg.get("known_terms") or []
    # "start" is the old one-connection-per-dictation shape.
    return known_terms, msg_type == "start"


async def _run_utterance(websocket: WebSocketServerProtocol, known_terms: list) -> None:
    """
    One dictation: feed audio until end_of_utterance, then finalize, touch up,
    and send the result back.

    Returns normally when the utterance completes. Re-raises ConnectionClosed so
    the caller's loop can exit — but only after finalizing, so the ASR stream is
    never leaked.
    """
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
                # An audio frame: raw PCM16, 16kHz, mono. See module docstring.
                session.feed_pcm_int16(message)
                continue

            # A JSON control message.
            try:
                control = json.loads(message)
            except (json.JSONDecodeError, TypeError):
                logger.warning("Ignoring malformed control message: %r", message)
                continue

            control_type = control.get("type")
            if control_type == "end_of_utterance":
                break
            elif control_type == "ping":
                await websocket.send(json.dumps({"type": "pong"}))
            else:
                logger.warning("Ignoring unrecognized control message type: %r", control_type)

    except websockets.exceptions.ConnectionClosed:
        logger.info("Connection closed by client mid-dictation (network drop?)")
        # Nobody left to send the transcript to, so tear down. The Mac client is
        # responsible for leaving whatever raw partial text it already injected in
        # place rather than losing it — see macos-app/src/lib/wsClient.js.
        #
        # finalize() must still run even though its result is discarded: it's what
        # calls _stream.stop(), and without it the Moonshine stream and its thread
        # leak for the lifetime of the process. This path used to call close()
        # alone, which only removes the listener.
        forward_task.cancel()
        try:
            session.finalize()
        except Exception:
            logger.exception("Error finalizing ASR session after connection drop")
        finally:
            session.close()
        raise

    # Hotkey released: finalize ASR, run the deterministic touch-up, send the
    # result back. We time each stage (monotonic perf_counter) so the Mac can
    # attribute post-release latency to ASR vs. touch-up — see
    # macos-app/src/lib/timing.js.
    #
    # Note the ORDER here. finalize() first, so stop()'s final events are queued;
    # then the sentinel; then await the forwarding task so it drains everything
    # still pending. Cancelling the task first — which is what this used to do —
    # threw away every queued partial, so the client's live text silently stopped
    # updating near the end of every dictation.
    _t_finalize_start = time.perf_counter()
    try:
        raw_text = session.finalize()
    finally:
        session.close()
    asr_finalize_ms = round((time.perf_counter() - _t_finalize_start) * 1000)

    session.signal_results_done()
    try:
        await asyncio.wait_for(forward_task, timeout=RESULT_DRAIN_TIMEOUT_SECONDS)
    except (asyncio.TimeoutError, asyncio.CancelledError):
        # Bounded: a stuck send must not hold the dictation open.
        forward_task.cancel()
    except websockets.exceptions.ConnectionClosed:
        pass

    if not raw_text.strip():
        # Very short utterance, or no speech detected. Must not error or hang —
        # report an empty result and let the client decide what to do (almost
        # certainly: retract any live partial text and otherwise do nothing).
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

    # Warm-up is blocking model I/O; run it off the event loop so startup logging
    # and serve setup aren't stalled, but await it before accepting connections so
    # the first client doesn't race a half-loaded model.
    await asyncio.get_running_loop().run_in_executor(None, _warm_models)

    # Shut down cleanly on SIGTERM, which is what `systemctl stop` and
    # `systemctl restart` send. Without this the process ran until systemd's
    # timeout expired and then took SIGKILL, which meant every restart looked
    # like a 90-second hang and in-flight dictations died mid-write.
    loop = asyncio.get_running_loop()
    shutdown = asyncio.Event()
    for signal_name in ("SIGTERM", "SIGINT"):
        try:
            loop.add_signal_handler(getattr(signal, signal_name), shutdown.set)
        except (NotImplementedError, AttributeError):
            # Not available on every platform; the default handler still applies.
            pass

    async with websockets.serve(
        _handle_session,
        config.HOST,
        config.PORT,
        max_size=2**22,
        # Detect a Mac that vanished without closing (laptop lid, WiFi drop).
        # Matters more now that connections are long-lived rather than one per
        # dictation: without it, dead sockets would accumulate.
        ping_interval=20,
        ping_timeout=20,
    ):
        logger.info("Ready — listening for dictations")
        await shutdown.wait()

    logger.info("Shutting down")


if __name__ == "__main__":
    asyncio.run(main())
