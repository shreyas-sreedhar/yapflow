"""
End-to-end protocol tests: runs the real server against a real WebSocket client,
with only the Moonshine model stubbed.

This exercises the parts that unit tests can't reach — the handshake, the
persistent-connection utterance loop, the legacy single-shot path, audio framing,
and the shape of every message on the wire. The ASR model is replaced by a fake
that emits synthetic transcript events on a schedule, so the tests are
deterministic and need no model download, no GPU, and no Jetson.

Run: python3 test_protocol.py
"""

from __future__ import annotations

import asyncio
import enum
import json
import sys
import types

# --- Stub moonshine_voice before importing the server ---------------------------
#
# The fake stream mimics the library's documented event contract: line-text-changed
# events as audio arrives, and exactly one line-completed per line, including one
# fired by stop().


class _FakeStream:
    def __init__(self, update_interval=0.3):
        self._listeners = []
        self._chunks = 0
        self._started = False
        self._completed_current = False
        self.stopped = False
        # Mirrors the real library: close() is what frees the native handle, and
        # Stream has no __del__, so a session that never calls it leaks.
        self.closed = False
        # Words revealed one at a time as audio arrives, so partials grow.
        self._words = ["hello", "world", "this", "is", "a", "test"]
        self._revealed = 0

    def add_listener(self, listener):
        self._listeners.append(listener)

    def remove_listener(self, listener):
        if listener in self._listeners:
            self._listeners.remove(listener)

    def close(self):
        self.closed = True
        self._listeners.clear()

    def start(self):
        self._started = True

    def add_audio(self, samples, sample_rate):
        self._chunks += 1
        # Reveal a word every 3 chunks to simulate incremental recognition.
        if self._chunks % 3 == 0 and self._revealed < len(self._words):
            self._revealed += 1
            self._emit("on_line_text_changed", self._current_text())
            self._completed_current = False

    def stop(self):
        self.stopped = True
        # The library completes any active line on stop(). Only fire if there IS
        # an active line — matching the real contract, and what finalize() waits on.
        if self._revealed > 0 and not self._completed_current:
            self._completed_current = True
            self._emit("on_line_completed", self._current_text())

    def force_line_break(self):
        """Simulates the speaker pausing: completes the line and starts a new one."""
        self._emit("on_line_completed", self._current_text())
        self._completed_current = True
        self._words = ["second", "line", "here"]
        self._revealed = 0
        self._chunks = 0

    def _current_text(self):
        return " ".join(self._words[: self._revealed])

    def _emit(self, method, text):
        event = types.SimpleNamespace(line=types.SimpleNamespace(text=text))
        for listener in list(self._listeners):
            getattr(listener, method)(event)


class _FakeTranscriber:
    def __init__(self, model_path=None, model_arch=None):
        self.streams = []

    def create_stream(self, update_interval=0.3):
        stream = _FakeStream(update_interval)
        self.streams.append(stream)
        return stream


# A real IntEnum, not a SimpleNamespace: asr.py looks the arch up with
# ModelArch[name] and reports valid values from ModelArch.__members__, so the stub
# has to support both — same as the real library, whose ModelArch is an IntEnum.
class _FakeModelArch(enum.IntEnum):
    TINY = 0
    BASE = 1
    TINY_STREAMING = 2
    BASE_STREAMING = 3
    SMALL_STREAMING = 4
    MEDIUM_STREAMING = 5


_stub = types.ModuleType("moonshine_voice")
_stub.ModelArch = _FakeModelArch
_stub.Transcriber = _FakeTranscriber
_stub.TranscriptEventListener = object
_stub.get_model_for_language = lambda lang, arch=None: ("/fake/model/path", arch)
sys.modules["moonshine_voice"] = _stub

import websockets  # noqa: E402

import asr  # noqa: E402
import server  # noqa: E402

HOST = "127.0.0.1"
PORT = 8799
URL = f"ws://{HOST}:{PORT}"


def pcm_frame(num_samples=320):
    """A 20ms frame of silence as raw int16 LE — the real wire format."""
    return (0).to_bytes(2, "little") * num_samples


async def read_until(ws, msg_type, timeout=5.0):
    """Collects messages until one of `msg_type` arrives; returns (that, all)."""
    collected = []
    deadline = asyncio.get_event_loop().time() + timeout
    while True:
        remaining = deadline - asyncio.get_event_loop().time()
        if remaining <= 0:
            raise AssertionError(f"timed out waiting for {msg_type!r}; got {collected}")
        raw = await asyncio.wait_for(ws.recv(), timeout=remaining)
        msg = json.loads(raw)
        collected.append(msg)
        if msg.get("type") == msg_type:
            return msg, collected


# --- Tests --------------------------------------------------------------------


async def test_persistent_connection_handles_multiple_utterances():
    """The whole point of the restructure: one socket, many dictations."""
    async with websockets.serve(server._handle_session, HOST, PORT):
        async with websockets.connect(URL) as ws:
            await ws.send(json.dumps({"type": "hello"}))

            for expected_round in range(3):
                await ws.send(json.dumps({"type": "start_utterance", "known_terms": []}))
                for _ in range(20):
                    await ws.send(pcm_frame())
                await ws.send(json.dumps({"type": "end_of_utterance"}))

                polished, all_msgs = await read_until(ws, "polished")
                assert polished["polished_text"], f"round {expected_round}: empty transcript"
                partials = [m for m in all_msgs if m["type"] == "partial"]
                assert partials, f"round {expected_round}: no partials"
                # Socket must still be usable for the next round.
                assert ws.state.name == "OPEN", f"round {expected_round}: socket closed"


async def test_pause_mid_dictation_keeps_both_halves_end_to_end():
    """
    The word-eating bug, exercised through the whole server rather than just the
    accumulator: a pause completes line 1 and starts line 2, and the final
    transcript must contain both. The old scalar returned only line 2.
    """
    async with websockets.serve(server._handle_session, HOST, PORT):
        async with websockets.connect(URL) as ws:
            await ws.send(json.dumps({"type": "hello"}))
            await ws.send(json.dumps({"type": "start_utterance"}))

            # First line: enough audio to reveal several words.
            for _ in range(20):
                await ws.send(pcm_frame())
            await asyncio.sleep(0.15)  # let the server consume it

            # Simulate the speaker pausing, which Moonshine turns into a line break.
            stream = asr.get_transcriber().streams[-1]
            stream.force_line_break()

            # Second line.
            for _ in range(12):
                await ws.send(pcm_frame())
            await ws.send(json.dumps({"type": "end_of_utterance"}))

            polished, _ = await read_until(ws, "polished")
            raw = polished["raw_text"]
            assert "hello" in raw.lower(), f"first half lost: {raw!r}"
            assert "second" in raw.lower(), f"second half lost: {raw!r}"


async def test_every_stream_is_freed_on_a_multi_utterance_connection():
    """
    Stream.close() is what calls moonshine_free_stream, and Stream has no
    __del__ — so a session that only removes its listener leaks the native handle
    plus its encoder/decoder cache for the process lifetime. That is once per
    dictation on a box designed to serve unbounded dictations from one process.
    """
    async with websockets.serve(server._handle_session, HOST, PORT):
        async with websockets.connect(URL) as ws:
            await ws.send(json.dumps({"type": "hello"}))
            for _ in range(3):
                await ws.send(json.dumps({"type": "start_utterance"}))
                for _ in range(12):
                    await ws.send(pcm_frame())
                await ws.send(json.dumps({"type": "end_of_utterance"}))
                await read_until(ws, "polished")

    streams = asr.get_transcriber().streams
    assert len(streams) == 3, f"expected 3 streams, got {len(streams)}"
    leaked = [i for i, s in enumerate(streams) if not s.closed]
    assert not leaked, f"streams {leaked} were never closed"


async def test_start_utterance_mid_utterance_does_not_merge_dictations():
    """
    The merged-dictation bug. The Mac's end-of-utterance handshake is async, so a
    fast release-then-re-press could skip end_of_utterance entirely. The server
    then dropped the new start_utterance as "unrecognized", kept running the old
    utterance, fed the new audio into the old stream, and returned ONE transcript
    containing both dictations.

    A start_utterance arriving mid-utterance now ends the current one implicitly.
    """
    async with websockets.serve(server._handle_session, HOST, PORT):
        async with websockets.connect(URL) as ws:
            await ws.send(json.dumps({"type": "hello"}))

            # First dictation, deliberately never ended.
            await ws.send(json.dumps({"type": "start_utterance"}))
            for _ in range(20):
                await ws.send(pcm_frame())
            await asyncio.sleep(0.15)

            # Second dictation opens without an intervening end_of_utterance.
            await ws.send(json.dumps({"type": "start_utterance"}))
            for _ in range(12):
                await ws.send(pcm_frame())
            await ws.send(json.dumps({"type": "end_of_utterance"}))

            first, _ = await read_until(ws, "polished")
            second, _ = await read_until(ws, "polished")

    # Two separate transcripts, not one merged one.
    assert first["polished_text"], f"first dictation lost: {first!r}"
    assert second["polished_text"], f"second dictation lost: {second!r}"

    # And two separate streams, each freed.
    streams = asr.get_transcriber().streams
    assert len(streams) == 2, f"expected 2 streams, got {len(streams)}"
    assert all(s.closed for s in streams), "a stream was leaked"


async def test_ping_pong_without_dictating():
    """Health check that doesn't require a dictation — used by the systemd probe."""
    async with websockets.serve(server._handle_session, HOST, PORT):
        async with websockets.connect(URL) as ws:
            await ws.send(json.dumps({"type": "hello"}))
            await ws.send(json.dumps({"type": "ping"}))
            msg, _ = await read_until(ws, "pong")
            assert msg["type"] == "pong"


async def test_legacy_single_shot_client_still_works():
    """An un-updated Mac app must keep working while the two sides roll."""
    async with websockets.serve(server._handle_session, HOST, PORT):
        async with websockets.connect(URL) as ws:
            await ws.send(json.dumps({"type": "start", "known_terms": []}))
            for _ in range(20):
                await ws.send(pcm_frame())
            await ws.send(json.dumps({"type": "end_of_utterance"}))
            polished, _ = await read_until(ws, "polished")
            assert polished["polished_text"]


async def test_partial_carries_session_text_and_line_index():
    async with websockets.serve(server._handle_session, HOST, PORT):
        async with websockets.connect(URL) as ws:
            await ws.send(json.dumps({"type": "hello"}))
            await ws.send(json.dumps({"type": "start_utterance"}))
            for _ in range(12):
                await ws.send(pcm_frame())
            await ws.send(json.dumps({"type": "end_of_utterance"}))
            _, all_msgs = await read_until(ws, "polished")

            partials = [m for m in all_msgs if m["type"] == "partial"]
            assert partials, "expected partials"
            for p in partials:
                assert "session_text" in p, "partial missing session_text"
                assert "line_index" in p, "partial missing line_index"
            # session_text must grow monotonically, which is the property that
            # makes cursor-diffing safe.
            lengths = [len(p["session_text"]) for p in partials]
            assert lengths == sorted(lengths), f"session_text not monotonic: {lengths}"


async def test_timings_include_touchup_and_deprecated_alias():
    async with websockets.serve(server._handle_session, HOST, PORT):
        async with websockets.connect(URL) as ws:
            await ws.send(json.dumps({"type": "hello"}))
            await ws.send(json.dumps({"type": "start_utterance"}))
            for _ in range(10):
                await ws.send(pcm_frame())
            await ws.send(json.dumps({"type": "end_of_utterance"}))
            polished, _ = await read_until(ws, "polished")

            t = polished["timings"]
            assert "asr_finalize_ms" in t
            assert "touchup_ms" in t
            assert "gemma_ms" in t, "deprecated alias dropped too early"
            assert t["gemma_ms"] == t["touchup_ms"]


async def test_known_terms_are_applied_by_touchup():
    """known_terms travel over the wire and reach the substitution pass."""
    async with websockets.serve(server._handle_session, HOST, PORT):
        async with websockets.connect(URL) as ws:
            await ws.send(json.dumps({"type": "hello"}))
            # "World" (capitalized) should replace the fake ASR's "world".
            await ws.send(json.dumps({"type": "start_utterance", "known_terms": ["World"]}))
            for _ in range(20):
                await ws.send(pcm_frame())
            await ws.send(json.dumps({"type": "end_of_utterance"}))
            polished, _ = await read_until(ws, "polished")
            assert "World" in polished["polished_text"], polished["polished_text"]


async def test_no_speech_returns_empty_without_erroring():
    async with websockets.serve(server._handle_session, HOST, PORT):
        async with websockets.connect(URL) as ws:
            await ws.send(json.dumps({"type": "hello"}))
            await ws.send(json.dumps({"type": "start_utterance"}))
            # Two frames: not enough for the fake to reveal any word.
            await ws.send(pcm_frame())
            await ws.send(json.dumps({"type": "end_of_utterance"}))
            polished, _ = await read_until(ws, "polished")
            assert polished["raw_text"] == ""
            assert polished["polished_text"] == ""
            assert polished["timings"]["touchup_ms"] is None


async def test_odd_length_audio_frame_does_not_kill_the_session():
    """A truncated frame is a network artifact, not a fatal error."""
    async with websockets.serve(server._handle_session, HOST, PORT):
        async with websockets.connect(URL) as ws:
            await ws.send(json.dumps({"type": "hello"}))
            await ws.send(json.dumps({"type": "start_utterance"}))
            for _ in range(10):
                await ws.send(pcm_frame())
            await ws.send(pcm_frame() + b"\x01")  # odd byte count
            for _ in range(10):
                await ws.send(pcm_frame())
            await ws.send(json.dumps({"type": "end_of_utterance"}))
            polished, _ = await read_until(ws, "polished")
            assert polished["polished_text"]


async def test_malformed_control_message_is_ignored():
    async with websockets.serve(server._handle_session, HOST, PORT):
        async with websockets.connect(URL) as ws:
            await ws.send(json.dumps({"type": "hello"}))
            await ws.send(json.dumps({"type": "start_utterance"}))
            await ws.send("not json at all")
            await ws.send(json.dumps({"type": "who_knows"}))
            for _ in range(20):
                await ws.send(pcm_frame())
            await ws.send(json.dumps({"type": "end_of_utterance"}))
            polished, _ = await read_until(ws, "polished")
            assert polished["polished_text"]


async def test_bad_secret_is_rejected():
    original = server.config.SHARED_SECRET
    server.config.SHARED_SECRET = "correct-horse"
    try:
        async with websockets.serve(server._handle_session, HOST, PORT):
            async with websockets.connect(URL) as ws:
                await ws.send(json.dumps({"type": "hello", "secret": "wrong"}))
                try:
                    await asyncio.wait_for(ws.recv(), timeout=3.0)
                except websockets.exceptions.ConnectionClosed as exc:
                    assert exc.rcvd.code == 4003, f"expected 4003, got {exc.rcvd.code}"
                    return
                raise AssertionError("connection was not rejected")
    finally:
        server.config.SHARED_SECRET = original


async def test_correct_secret_is_accepted():
    original = server.config.SHARED_SECRET
    server.config.SHARED_SECRET = "correct-horse"
    try:
        async with websockets.serve(server._handle_session, HOST, PORT):
            async with websockets.connect(URL) as ws:
                await ws.send(json.dumps({"type": "hello", "secret": "correct-horse"}))
                await ws.send(json.dumps({"type": "ping"}))
                msg, _ = await read_until(ws, "pong")
                assert msg["type"] == "pong"
    finally:
        server.config.SHARED_SECRET = original


async def test_non_json_handshake_is_rejected():
    async with websockets.serve(server._handle_session, HOST, PORT):
        async with websockets.connect(URL) as ws:
            await ws.send("definitely not json")
            try:
                await asyncio.wait_for(ws.recv(), timeout=3.0)
            except websockets.exceptions.ConnectionClosed as exc:
                assert exc.rcvd.code == 4002, f"expected 4002, got {exc.rcvd.code}"
                return
            raise AssertionError("connection was not rejected")


async def test_client_disconnect_mid_dictation_stops_the_stream():
    """
    The leak this guards: the ConnectionClosed path used to call close() without
    finalize(), so _stream.stop() never ran and the Moonshine stream plus its
    thread leaked per dropped connection.
    """
    async with websockets.serve(server._handle_session, HOST, PORT):
        ws = await websockets.connect(URL)
        await ws.send(json.dumps({"type": "hello"}))
        await ws.send(json.dumps({"type": "start_utterance"}))
        for _ in range(10):
            await ws.send(pcm_frame())
        await asyncio.sleep(0.1)  # let the server consume the audio
        await ws.close()
        await asyncio.sleep(0.3)  # let the server notice and clean up

        transcriber = asr.get_transcriber()
        assert transcriber.streams, "no stream was ever created"
        assert transcriber.streams[-1].stopped, "stop() never called"
        assert transcriber.streams[-1].closed, "native handle leaked: close() never called"


async def main():
    tests = [
        (name, fn)
        for name, fn in sorted(globals().items())
        if name.startswith("test_") and asyncio.iscoroutinefunction(fn)
    ]
    failures = 0
    for name, fn in tests:
        # Reset the process-global transcriber so each test starts clean.
        asr._transcriber = None
        try:
            await asyncio.wait_for(fn(), timeout=20.0)
            print(f"PASS {name}")
        except AssertionError as exc:
            failures += 1
            print(f"FAIL {name}: {exc}")
        except Exception as exc:  # noqa: BLE001
            failures += 1
            print(f"ERROR {name}: {type(exc).__name__}: {exc}")
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
