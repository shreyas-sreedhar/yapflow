"""
Streaming ASR wrapper around Moonshine v2 (moonshine_voice package).

This is deliberately modeled closely on Moonshine's own official reference
example (examples/python/ollama-voice/ollama_voice.py in moonshine-ai/moonshine),
which already demonstrates exactly this pairing: live microphone transcription
feeding a Gemma model through Ollama. The real API surface, confirmed from
that source and the library's README, is:

    Transcriber(model_path=..., model_arch=...)   # or get_model_for_language()
    transcriber.add_listener(listener)
    transcriber.start()
    transcriber.add_audio(audio_data, sample_rate)   # float32, -1.0..1.0, mono
    transcriber.stop()
    transcriber.create_stream(update_interval=...)   # for multiple concurrent inputs

This project differs from that example in one important way: the official
example uses MicTranscriber to read directly from the Jetson's own microphone.
We don't want that — the microphone is on the MacBook, and audio arrives here
over a WebSocket, already Opus-decoded into PCM by the time it reaches this
module. So we use the lower-level Transcriber + Stream classes instead of
MicTranscriber, and push audio in ourselves via add_audio() as Opus packets
arrive and get decoded, rather than letting the library pull from a local mic.

Why Moonshine v2 over Whisper at all: Whisper always operates on a fixed
30-second input window regardless of utterance length, and caches nothing
between calls, so live captioning means re-processing audio from scratch on
every update. Moonshine's streaming models process exactly the audio they're
given and cache encoder/decoder state, so most of the latency cost is paid
incrementally while the user is still talking, not after they release the
hotkey. See docs/yapflow-master-plan.md Section 2.2 for the full reasoning
and benchmark numbers — don't swap this out for faster-whisper without
re-reading that.
"""

from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass
from typing import Optional

import numpy as np
from moonshine_voice import ModelArch, Transcriber, TranscriptEventListener, get_model_for_language

import config

logger = logging.getLogger("yapflow.asr")

_transcriber: Optional[Transcriber] = None

# Audio arrives at this rate after Opus decode on our side (see server.py).
# Moonshine's add_audio() accepts any sample rate and converts internally,
# but we standardize here so the rest of the pipeline only has one rate to
# reason about.
PCM_SAMPLE_RATE = 16000


def get_transcriber() -> Transcriber:
    """
    Load the Moonshine model once per process and reuse it across every
    dictation session via multiple Stream objects (see StreamingSession
    below). This mirrors the library's own guidance: streams exist so you
    can have several concurrent audio sources without loading multiple
    copies of the model — we only ever have one input at a time here, but
    using create_stream() per-dictation still keeps each session's transcript
    state cleanly isolated without reloading model weights.
    """
    global _transcriber
    if _transcriber is None:
        model_path, model_arch = get_model_for_language(
            "en", getattr(ModelArch, config.MOONSHINE_MODEL_ARCH, None)
        )
        logger.info(
            "Loading Moonshine model (%s) — first load only, stays resident",
            config.MOONSHINE_MODEL_ARCH,
        )
        _transcriber = Transcriber(model_path=model_path, model_arch=model_arch)
    return _transcriber


@dataclass
class PartialResult:
    text: str
    is_final: bool


class _QueueListener(TranscriptEventListener):
    """
    Bridges Moonshine's synchronous callback-based event model into an
    asyncio queue, so the websocket handler can `await` results instead of
    juggling callbacks directly alongside socket I/O.
    """

    def __init__(self, loop: asyncio.AbstractEventLoop, queue: "asyncio.Queue[PartialResult]"):
        self._loop = loop
        self._queue = queue

    def on_line_text_changed(self, event):
        # Incremental update while the user is still speaking — push at the
        # cursor live, per the spec's Path B design.
        self._loop.call_soon_threadsafe(
            self._queue.put_nowait, PartialResult(text=event.line.text, is_final=False)
        )

    def on_line_completed(self, event):
        # Moonshine decided the user paused. This can fire mid-dictation if
        # the user pauses naturally — that's fine, it just means a finalized
        # line is available; StreamingSession.finalize() is what actually
        # ends the *session* when the hotkey is released.
        self._loop.call_soon_threadsafe(
            self._queue.put_nowait, PartialResult(text=event.line.text, is_final=True)
        )


class StreamingSession:
    """
    One instance per dictation (hotkey-down to hotkey-up). Wraps a single
    Moonshine Stream. Feed decoded PCM chunks in as Opus packets arrive;
    read partial/final results out via `results()`; call `finalize()` when
    the hotkey is released to get the best-effort transcript for whatever
    was said.
    """

    def __init__(self):
        self._transcriber = get_transcriber()
        self._loop = asyncio.get_event_loop()
        self._queue: "asyncio.Queue[PartialResult]" = asyncio.Queue()
        self._listener = _QueueListener(self._loop, self._queue)
        self._stream = self._transcriber.create_stream(
            update_interval=config.ASR_UPDATE_INTERVAL_SECONDS
        )
        self._stream.add_listener(self._listener)
        self._stream.start()
        self._last_line_text = ""

    def feed_pcm_int16(self, pcm_int16_bytes: bytes) -> None:
        """
        Feed a chunk of decoded PCM audio into the stream. Opus decoders
        (e.g. @discordjs/opus on the Mac side, or opuslib here if decoding
        server-side) typically hand back signed 16-bit PCM. Moonshine wants
        float32 in the range -1.0..1.0, so we convert here rather than
        pushing that conversion onto the websocket handler.
        """
        int16_array = np.frombuffer(pcm_int16_bytes, dtype=np.int16)
        float_array = (int16_array.astype(np.float32)) / 32768.0
        self._stream.add_audio(float_array, PCM_SAMPLE_RATE)

    async def results(self):
        """
        Async generator yielding PartialResult objects as Moonshine produces
        them. Iterate this concurrently with feeding audio in (e.g. via
        asyncio.gather or two tasks) — don't await it in a way that blocks
        new audio from being fed, since that defeats the point of streaming.
        """
        while True:
            result = await self._queue.get()
            self._last_line_text = result.text
            yield result

    def finalize(self) -> str:
        """
        Call when the hotkey is released. Stops the stream, which per the
        library's documented behavior marks any still-active line complete
        and fires a final on_line_completed — so the most recent queued
        result (or _last_line_text as a fallback if the queue races) is the
        raw transcript to send to the Gemma polish step.
        """
        self._stream.stop()
        return self._last_line_text

    def close(self) -> None:
        try:
            self._stream.remove_listener(self._listener)
        except Exception:
            logger.exception("Error removing ASR listener during session close")
