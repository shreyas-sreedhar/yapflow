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
    {"type": "polished", "raw_text": "...", "polished_text": "..."}

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

import websockets
from websockets.server import WebSocketServerProtocol

import config
from asr import StreamingSession
from polish import polish

logging.basicConfig(level=getattr(logging, config.LOG_LEVEL, logging.INFO))
logger = logging.getLogger("yapflow.server")

# If True, this server expects raw PCM (int16, 16kHz, mono) binary frames
# instead of Opus-encoded frames, and skips decoding entirely. Flip this
# based on whether you decide to decode Opus on the Mac (simpler Jetson
# deps) or here (smaller Mac app, more Jetson deps). Default: Mac decodes,
# matching "keep the Jetson server surface minimal" from CLAUDE.md.
EXPECT_RAW_PCM = True


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
                    json.dumps({"type": "partial", "text": result.text, "is_final": result.is_final})
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
        # Per the spec's resilience checklist (Step 6): if the Jetson
        # connection drops mid-dictation, we simply stop here. The Mac
        # client is responsible for leaving whatever raw partial text it
        # already injected in place, rather than losing it — see
        # mac-app/src/lib/wsClient.js.
        forward_task.cancel()
        session.close()
        return

    # Hotkey released (or connection ended cleanly): finalize ASR, run the
    # single Gemma polish call, send the result back.
    forward_task.cancel()
    raw_text = session.finalize()
    session.close()

    if not raw_text.strip():
        # Very short utterance, or no speech detected. Per the spec's
        # resilience checklist (Step 6), this should not error or hang —
        # just report back an empty polish result and let the client decide
        # what to do (almost certainly: nothing, no text was said).
        await websocket.send(json.dumps({"type": "polished", "raw_text": "", "polished_text": ""}))
        logger.info("Dictation session ended with no speech detected")
        return

    try:
        polished_text = polish(raw_text, personalize=True, known_terms=known_terms)
    except Exception:
        logger.exception("Unhandled error during polish step")
        await websocket.send(
            json.dumps({"type": "error", "message": "polish step failed, raw transcript follows"})
        )
        polished_text = raw_text

    await websocket.send(
        json.dumps({"type": "polished", "raw_text": raw_text, "polished_text": polished_text})
    )
    logger.info("Dictation session complete")


async def main() -> None:
    logger.info("Starting Yapflow server on %s:%d", config.HOST, config.PORT)
    async with websockets.serve(_handle_session, config.HOST, config.PORT, max_size=2**22):
        await asyncio.Future()  # run forever


if __name__ == "__main__":
    asyncio.run(main())
