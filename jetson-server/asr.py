"""
Streaming ASR wrapper around Moonshine v2 (moonshine_voice package).

The API surface used here, per the library's README:

    Transcriber(model_path=..., model_arch=...)   # or get_model_for_language()
    transcriber.add_listener(listener)
    transcriber.start()
    transcriber.add_audio(audio_data, sample_rate)   # float32, -1.0..1.0, mono
    transcriber.stop()
    transcriber.create_stream(update_interval=...)   # for multiple concurrent inputs

Note we do NOT use the library's MicTranscriber, which reads from the local
machine's microphone. The microphone is on the MacBook; audio arrives here as
raw PCM16 over a WebSocket. So we use the lower-level Transcriber + Stream
classes and push audio in ourselves via add_audio().

Why Moonshine v2 over Whisper at all: Whisper always operates on a fixed
30-second input window regardless of utterance length, and caches nothing
between calls, so live captioning means re-processing audio from scratch on
every update. Moonshine's streaming models process exactly the audio they're
given and cache encoder/decoder state, so most of the latency cost is paid
incrementally while the user is still talking, not after they release the
hotkey. That property is the whole reason this design works over a LAN hop —
don't swap it for faster-whisper or whisper.cpp without measuring
release-to-text latency before and after.

Transcript accumulation lives in _QueueListener, not in the async generator
that feeds the websocket. See that class for why — it's the fix for a bug that
silently dropped everything said before a mid-dictation pause.
"""

from __future__ import annotations

import asyncio
import logging
import threading
from concurrent.futures import ThreadPoolExecutor
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

# How long finalize() waits for stop()'s final on_line_completed callback before
# giving up and returning whatever it has accumulated. This is a safety net, not
# an expected cost: for a streaming model the final decode is already mostly
# done, so the callback normally lands in single-digit milliseconds. The ceiling
# exists so a missed callback truncates a transcript instead of hanging the
# dictation.
FINALIZE_TIMEOUT_SECONDS = 0.25

# Sentinel enqueued to tell results() there are no more results coming, so the
# forwarding task can finish on its own instead of being cancelled out from under
# a queue that still has partials in it.
_RESULTS_DONE = object()

# All Moonshine calls go through this ONE worker thread.
#
# max_workers=1 is the point, not a resource-saving default. The transcriber is a
# process-global singleton and the native library is not thread-safe for
# concurrent calls against it, so the work has to be serialized somewhere — doing
# it here means correctness doesn't depend on callers happening to await in order.
# It also keeps inference off the asyncio event loop, which is what lets the
# server keep reading audio and sending partials while a pass is running.
#
# Module-level rather than per-session so serialization holds across back-to-back
# dictations on a long-lived connection, and so there's no thread churn per
# utterance.
_inference_executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="moonshine")


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
        # Fail loudly on a bad YAPFLOW_ASR_MODEL. This used to be
        # getattr(..., None), which silently handed None to
        # get_model_for_language() and quietly loaded the library default — so a
        # typo'd env var looked like it worked while running a different model
        # than the one you asked for, and every latency measurement taken
        # afterwards was against the wrong thing.
        try:
            # ModelArch[...] rather than getattr, and __members__ rather than
            # dir(): ModelArch is an IntEnum, so dir() also lists every inherited
            # int method and makes the error message useless.
            requested_arch = ModelArch[config.MOONSHINE_MODEL_ARCH]
        except KeyError:
            raise ValueError(
                f"YAPFLOW_ASR_MODEL={config.MOONSHINE_MODEL_ARCH!r} is not a valid "
                f"ModelArch. Valid values: {', '.join(ModelArch.__members__)}"
            ) from None

        model_path, model_arch = get_model_for_language("en", requested_arch)
        logger.info(
            "Loading Moonshine model (%s) — first load only, stays resident",
            config.MOONSHINE_MODEL_ARCH,
        )
        _transcriber = Transcriber(model_path=model_path, model_arch=model_arch)
    return _transcriber


@dataclass
class PartialResult:
    # The text of the single line this event is about. Moonshine's events are
    # per-line, and a line ends at a natural speech pause — so this does NOT
    # grow monotonically across a dictation. When the speaker pauses, the
    # current line completes and the next event starts a fresh line back at the
    # beginning.
    text: str
    is_final: bool
    # Ordinal of the line this event refers to within the session, so a client
    # can distinguish "the current line grew" from "a new line started".
    line_index: int
    # The whole session transcript so far, all lines joined. THIS is what a
    # client injecting text at a cursor wants: it does grow monotonically (up to
    # Moonshine revising the tail of the active line), so diffing against it is
    # safe where diffing against `text` is not.
    session_text: str


class _QueueListener(TranscriptEventListener):
    """
    Bridges Moonshine's synchronous callback-based event model into an
    asyncio queue, so the websocket handler can `await` results instead of
    juggling callbacks directly alongside socket I/O.

    This listener is ALSO the authoritative accumulator of the transcript.
    That's deliberate and it's the fix for a real bug: the accumulation used to
    live in StreamingSession.results(), the async generator driven by the
    websocket handler's forwarding task. The handler cancels that task before
    calling finalize(), so the final on_line_completed fired by stop() was
    queued and then never consumed — finalize() returned the last *partial*
    instead of the finalized text. Accumulating here, in the callbacks
    themselves, makes the transcript independent of whether anyone is draining
    the queue.

    Moonshine invokes these callbacks from its own thread, so the accumulator
    state is guarded by a lock and the queue is fed via call_soon_threadsafe.
    """

    def __init__(self, loop: asyncio.AbstractEventLoop, queue: "asyncio.Queue[PartialResult]"):
        self._loop = loop
        self._queue = queue
        self._lock = threading.Lock()
        # Lines Moonshine has marked complete, in order. Per the library's
        # guarantees, a completed line is never modified again.
        self._completed_lines: list[str] = []
        # The line currently being spoken, which will keep changing.
        self._active_line = ""
        # Set whenever a line completes, so finalize() can wait for the
        # completion that stop() triggers rather than racing it.
        self._line_completed = threading.Event()

    def _publish(self, result: PartialResult) -> None:
        """
        Hand a result to the asyncio side. Tolerates a closed/finished loop:
        by the time a late callback arrives the handler may already be gone,
        and that must not raise inside Moonshine's thread.
        """
        try:
            self._loop.call_soon_threadsafe(self._queue.put_nowait, result)
        except RuntimeError:
            pass

    def on_line_text_changed(self, event):
        # Incremental update while the user is still speaking.
        with self._lock:
            self._active_line = event.line.text
            line_index = len(self._completed_lines)
        self._publish(
            PartialResult(
                text=event.line.text,
                is_final=False,
                line_index=line_index,
                session_text=self.transcript(),
            )
        )

    def on_line_completed(self, event):
        # Moonshine decided the user paused. This fires mid-dictation on a
        # natural pause, which is exactly the case the old scalar
        # `_last_line_text` mishandled: it overwrote rather than accumulated, so
        # pausing mid-sentence discarded everything said before the pause.
        with self._lock:
            self._completed_lines.append(event.line.text)
            self._active_line = ""
            line_index = len(self._completed_lines) - 1
        self._line_completed.set()
        self._publish(
            PartialResult(
                text=event.line.text,
                is_final=True,
                line_index=line_index,
                session_text=self.transcript(),
            )
        )

    def transcript(self) -> str:
        """
        The full session transcript: every completed line plus whatever is
        still in flight, joined with single spaces. Empty lines are dropped so a
        spurious empty completion can't inject double spaces.
        """
        with self._lock:
            parts = [*self._completed_lines, self._active_line]
        return " ".join(part.strip() for part in parts if part and part.strip())

    def transcript_has_active_line(self) -> bool:
        """
        Whether a line is currently in flight. finalize() uses this to decide
        whether stop() has anything left to complete — if the user's last words
        already landed as a completed line, there's no callback coming and no
        reason to spend the timeout waiting for one.
        """
        with self._lock:
            return bool(self._active_line.strip())

    def wait_for_completion(self, timeout: float) -> bool:
        """
        Block until a line-completed callback lands, up to `timeout` seconds.
        Used by finalize() to give stop()'s final callback a chance to arrive.
        """
        return self._line_completed.wait(timeout)

    def arm_completion_wait(self) -> None:
        self._line_completed.clear()


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
        self._finalized = False

    def _feed_pcm_int16_blocking(self, pcm_int16_bytes: bytes) -> None:
        """
        The blocking half of feed_pcm_int16. Runs on a worker thread — see the
        async wrapper below for why that matters.
        """
        # np.frombuffer raises on a buffer that isn't a whole number of int16s.
        # A truncated frame is a network artifact, not a reason to kill the
        # dictation — drop the trailing odd byte and keep going.
        if len(pcm_int16_bytes) % 2 != 0:
            logger.warning(
                "Dropping trailing odd byte from a %d-byte PCM frame", len(pcm_int16_bytes)
            )
            pcm_int16_bytes = pcm_int16_bytes[:-1]
        if not pcm_int16_bytes:
            return

        # Moonshine wants float32 in -1.0..1.0; the wire carries int16.
        int16_array = np.frombuffer(pcm_int16_bytes, dtype=np.int16)
        float_array = (int16_array.astype(np.float32)) / 32768.0
        self._stream.add_audio(float_array, PCM_SAMPLE_RATE)

    async def feed_pcm_int16(self, pcm_int16_bytes: bytes) -> None:
        """
        Feed a chunk of PCM16 audio into the stream.

        This is async, and the actual work runs in an executor, because
        `Stream.add_audio()` is NOT a cheap enqueue. It calls
        `update_transcription()` inline whenever enough audio has accumulated,
        which runs the model on the calling thread — the library's own docstring
        puts a pass at roughly 102ms fixed plus 269ms per second of audio on the
        tiny model. Called directly from the websocket handler, as it used to be,
        that blocks the event loop for the whole pass: no audio frames read, no
        partials sent, ping/pong stalled. The symptom is partial text arriving in
        bursts and, on a loaded box, dropped connections.

        Serialization is handled by the caller feeding frames one at a time in
        order; the library is not thread-safe for concurrent calls on one stream,
        so do not gather these.
        """
        loop = asyncio.get_running_loop()
        await loop.run_in_executor(
            _inference_executor, self._feed_pcm_int16_blocking, pcm_int16_bytes
        )

    async def finalize_async(self) -> str:
        """
        finalize() off the event loop. stop() runs a final transcription pass, so
        it blocks for the same reasons add_audio does.
        """
        loop = asyncio.get_running_loop()
        return await loop.run_in_executor(_inference_executor, self.finalize)

    async def results(self):
        """
        Async generator yielding PartialResult objects as Moonshine produces
        them. Iterate this concurrently with feeding audio in (e.g. via
        asyncio.gather or two tasks) — don't await it in a way that blocks
        new audio from being fed, since that defeats the point of streaming.

        Terminates cleanly when signal_results_done() is called, which is how the
        caller drains the last few results instead of cancelling mid-queue.
        """
        while True:
            result = await self._queue.get()
            if result is _RESULTS_DONE:
                return
            yield result

    def signal_results_done(self) -> None:
        """
        Marks the end of the result stream so results() can finish naturally.

        Call this AFTER finalize(), so the final on_line_completed that stop()
        fires is already in the queue and gets forwarded ahead of the sentinel.
        Cancelling the forwarding task instead — which is what used to happen —
        discarded every result still queued, so the client's live partial text
        silently stopped updating near the end of each dictation.
        """
        try:
            self._loop.call_soon_threadsafe(self._queue.put_nowait, _RESULTS_DONE)
        except RuntimeError:
            pass

    def finalize(self) -> str:
        """
        Call when the hotkey is released. Returns the complete raw transcript
        for the whole session — every line, not just the last one.

        stop() marks any still-active line complete and fires a final
        on_line_completed from Moonshine's thread. That callback is what moves
        the in-flight line into the completed list, so we wait briefly for it to
        land rather than reading the accumulator immediately and racing it.

        The wait is bounded: if the callback never arrives we return what we
        already have. Degrading to a slightly-truncated transcript is acceptable;
        hanging the dictation is not.

        Idempotent — safe to call from both the normal release path and the
        connection-dropped cleanup path.
        """
        if self._finalized:
            return self._listener.transcript()
        self._finalized = True

        had_active_line = bool(self._listener.transcript_has_active_line())
        if had_active_line:
            self._listener.arm_completion_wait()

        try:
            self._stream.stop()
        except Exception:
            logger.exception("Error stopping ASR stream during finalize")

        if had_active_line and not self._listener.wait_for_completion(FINALIZE_TIMEOUT_SECONDS):
            logger.warning(
                "No line-completed callback within %.2fs of stop(); "
                "returning accumulated transcript as-is",
                FINALIZE_TIMEOUT_SECONDS,
            )

        return self._listener.transcript()

    def close(self) -> None:
        """
        Release the stream. Must be called exactly once per session.

        `Stream.close()` is what calls the native `moonshine_free_stream`, and
        `Stream` has no `__del__` — only `Transcriber` does. So removing the
        listener (which is all this used to do) left the native handle and its
        encoder/decoder cache allocated for the process lifetime: one leak per
        dictation, on a box that now runs a single long-lived process serving
        unbounded dictations in 8GB of unified memory.

        Note `stop()` is not `close()`. stop() ends the transcription session;
        close() frees the handle. Both are needed.
        """
        try:
            self._stream.remove_listener(self._listener)
        except Exception:
            logger.exception("Error removing ASR listener during session close")

        try:
            self._stream.close()
        except Exception:
            logger.exception("Error closing ASR stream during session close")
