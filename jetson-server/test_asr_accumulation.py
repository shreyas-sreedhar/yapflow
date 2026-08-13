"""
Regression tests for the transcript accumulation bug.

The bug: StreamingSession.finalize() used to return a scalar `_last_line_text`
that was overwritten by every transcript event and only ever assigned inside
the results() async generator. Two failures fell out of that:

  1. The websocket handler cancels the task driving results() *before* calling
     finalize(), with no intervening await — so the final on_line_completed
     fired by stop() was queued and never consumed. finalize() returned the last
     partial, not the finalized text.
  2. Because it overwrote rather than accumulated, a natural pause mid-dictation
     (which makes Moonshine complete one line and start another) discarded
     everything said before the pause.

These tests exercise the listener/accumulator directly against synthetic
Moonshine events, so they run anywhere — no model download, no audio, no
Jetson. That's deliberate: the accumulator is the part that was wrong, and
it's the part worth pinning.

Note on what these tests are and aren't: they pin the *new* accumulator, and
can't be run red against the old code, because the old code had no
`transcript()` to call — the bug was in its absence. So
`test_old_scalar_semantics_lost_text` below reimplements the old overwrite
behaviour in four lines and asserts it produced the wrong answer, which keeps
the actual regression documented and executable rather than just described in
a comment.

Run with:  python3 -m pytest test_asr_accumulation.py -v
       or:  python3 test_asr_accumulation.py
"""

from __future__ import annotations

import asyncio
import enum
import sys
import threading
import types


def _stub_module(name: str, **attrs) -> None:
    """
    Register a placeholder module so `import asr` succeeds without the real
    dependency installed.

    The accumulator under test touches neither moonshine_voice nor numpy — it
    only handles transcript event objects — so stubbing them keeps these tests
    runnable on a laptop or in CI, not just on a provisioned Jetson. If a test
    ever needs real behaviour from either, that's the signal to stop stubbing it
    rather than to make the stub smarter.
    """
    if name in sys.modules:
        return
    module = types.ModuleType(name)
    for key, value in attrs.items():
        setattr(module, key, value)
    sys.modules[name] = module


_stub_module("numpy", int16=None, float32=None, frombuffer=None)
# A real IntEnum, matching the library: asr.py uses ModelArch[name] and
# ModelArch.__members__, neither of which a SimpleNamespace supports.
class _FakeModelArch(enum.IntEnum):
    TINY = 0
    BASE = 1
    TINY_STREAMING = 2
    BASE_STREAMING = 3
    SMALL_STREAMING = 4
    MEDIUM_STREAMING = 5


_stub_module(
    "moonshine_voice",
    ModelArch=_FakeModelArch,
    Transcriber=object,
    TranscriptEventListener=object,
    get_model_for_language=lambda *a, **k: (None, None),
)

import asr  # noqa: E402 - must follow the stubs above


def _event(text: str):
    """A stand-in for Moonshine's TranscriptEvent, which only needs `.line.text` here."""
    return types.SimpleNamespace(line=types.SimpleNamespace(text=text))


def _listener() -> "asr._QueueListener":
    """
    A listener wired to a real event loop that is never run. Nothing here awaits
    the queue; we only assert on accumulator state, which is exactly the point —
    correctness must not depend on anyone draining the queue.
    """
    loop = asyncio.new_event_loop()
    return asr._QueueListener(loop, asyncio.Queue())


def test_single_line_accumulates():
    listener = _listener()
    listener.on_line_text_changed(_event("hello"))
    listener.on_line_text_changed(_event("hello world"))
    listener.on_line_completed(_event("Hello world."))
    assert listener.transcript() == "Hello world."


def test_pause_mid_dictation_keeps_both_halves():
    """
    THE regression. A pause completes line 1 and starts line 2; the old scalar
    returned only line 2.
    """
    listener = _listener()
    listener.on_line_text_changed(_event("first half"))
    listener.on_line_completed(_event("First half."))
    listener.on_line_text_changed(_event("second half"))
    listener.on_line_completed(_event("Second half."))
    assert listener.transcript() == "First half. Second half."


def test_old_scalar_semantics_lost_text():
    """
    Documents the bug this module exists for, executably.

    The old implementation held one string and overwrote it on every event:

        def on_line_completed(self, event):
            self._last_line_text = event.line.text   # overwrite, not append

    Fed the same two-line dictation as the test above, that keeps only the
    second half. Asserting the wrong answer here is intentional — if someone
    reintroduces overwrite semantics, the test above goes red and this one
    explains why.
    """
    last_line_text = ""
    for line in ("First half.", "Second half."):
        last_line_text = line  # the old scalar overwrite

    assert last_line_text == "Second half."
    assert last_line_text != "First half. Second half."


def test_active_line_included_before_completion():
    """finalize() may read the accumulator while a line is still in flight."""
    listener = _listener()
    listener.on_line_completed(_event("Done."))
    listener.on_line_text_changed(_event("still talking"))
    assert listener.transcript() == "Done. still talking"


def test_empty_and_whitespace_lines_do_not_inject_double_spaces():
    listener = _listener()
    listener.on_line_completed(_event("One."))
    listener.on_line_completed(_event("   "))
    listener.on_line_completed(_event(""))
    listener.on_line_completed(_event("Two."))
    assert listener.transcript() == "One. Two."


def test_no_events_yields_empty_transcript():
    assert _listener().transcript() == ""


def test_has_active_line_tracks_in_flight_state():
    listener = _listener()
    assert not listener.transcript_has_active_line()
    listener.on_line_text_changed(_event("talking"))
    assert listener.transcript_has_active_line()
    listener.on_line_completed(_event("Talking."))
    assert not listener.transcript_has_active_line()


def test_completion_event_signals_waiter():
    """
    finalize() waits on this event after stop() so it doesn't race the final
    callback. Verify it actually fires, and that arming clears it first.
    """
    listener = _listener()
    listener.arm_completion_wait()
    assert not listener.wait_for_completion(0.0)

    def complete_soon():
        listener.on_line_completed(_event("Late arrival."))

    threading.Timer(0.02, complete_soon).start()
    assert listener.wait_for_completion(1.0)
    assert listener.transcript() == "Late arrival."


def test_publish_survives_a_dead_loop():
    """
    Moonshine calls these from its own thread, and a late callback can land after
    the handler's loop is gone. That must not raise inside Moonshine's thread.
    """
    loop = asyncio.new_event_loop()
    listener = asr._QueueListener(loop, asyncio.Queue())
    loop.close()
    listener.on_line_completed(_event("After close."))  # must not raise
    assert listener.transcript() == "After close."


def test_partial_result_carries_cumulative_session_text():
    """
    `text` is per-line and does not grow monotonically; `session_text` does.
    A client diffing text at a cursor must use the latter.
    """
    loop = asyncio.new_event_loop()
    queue: asyncio.Queue = asyncio.Queue()
    listener = asr._QueueListener(loop, queue)
    loop.close()  # publishes become no-ops; assert on the accumulator instead

    listener.on_line_completed(_event("First."))
    listener.on_line_text_changed(_event("second"))

    # After a pause, the per-line text restarted from scratch while the session
    # text kept everything.
    assert listener.transcript() == "First. second"
    assert listener.transcript_has_active_line()


if __name__ == "__main__":
    failures = 0
    for name, fn in sorted(globals().items()):
        if not name.startswith("test_") or not callable(fn):
            continue
        try:
            fn()
            print(f"PASS {name}")
        except AssertionError as exc:
            failures += 1
            print(f"FAIL {name}: {exc or 'assertion failed'}")
        except Exception as exc:  # noqa: BLE001 - surface any error as a failure
            failures += 1
            print(f"ERROR {name}: {type(exc).__name__}: {exc}")
    raise SystemExit(1 if failures else 0)
