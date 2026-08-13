"""
Tests for the deterministic touch-up.

The governing risk here is asymmetric. Leaving a filler word in is a cosmetic
annoyance; DELETING a word the user actually said is data loss they may not
notice until later. So most of these tests assert what must survive, not what
must be removed — the filler list is deliberately short for the same reason.

Run: python3 test_polish.py
"""

from __future__ import annotations

import contextlib

import config
import polish


def check(raw, expected, known_terms=None, note=""):
    actual = polish.polish(raw, known_terms=known_terms or [])
    if actual != expected:
        raise AssertionError(f"{raw!r} -> {actual!r}, expected {expected!r}" + (f" ({note})" if note else ""))


def check_contains_all(raw, words, known_terms=None):
    """Asserts every word survives, without pinning exact formatting."""
    actual = polish.polish(raw, known_terms=known_terms or [])
    lowered = actual.lower()
    missing = [w for w in words if w.lower() not in lowered]
    if missing:
        raise AssertionError(f"{raw!r} -> {actual!r} lost {missing}")


@contextlib.contextmanager
def spoken_commands_enabled():
    """Spoken commands are opt-in; flip the flag for the tests that cover them."""
    original = config.SPOKEN_COMMANDS_ENABLED
    config.SPOKEN_COMMANDS_ENABLED = True
    try:
        yield
    finally:
        config.SPOKEN_COMMANDS_ENABLED = original


tests = {}


def test(fn):
    tests[fn.__name__] = fn
    return fn


# --- Filler removal -----------------------------------------------------------


@test
def test_removes_core_fillers():
    check("um so i think uh we should ship it", "So I think we should ship it")
    check("erm hello", "Hello")
    check("hmm let me think", "Let me think")


@test
def test_all_filler_yields_empty():
    # Returning the raw transcript here would paste "um uh" at the cursor.
    check("um uh erm", "")
    check("   um   ", "")


@test
def test_removes_you_know_as_a_phrase():
    check("you know, the thing is complicated", "The thing is complicated")


@test
def test_keeps_you_and_know_separately():
    check_contains_all("you should know the answer", ["you", "should", "know", "answer"])
    check_contains_all("do you know him", ["you", "know", "him"])


@test
def test_fenced_like_removed_but_bare_like_kept():
    check("it was, like, really big", "It was really big")
    # These are the load-bearing uses that a naive filler list destroys.
    check_contains_all("write it like this", ["write", "like", "this"])
    check_contains_all("i like the design", ["like", "design"])
    check_contains_all("looks like it works", ["looks", "like", "works"])


@test
def test_words_that_look_like_fillers_are_preserved():
    # Every one of these was excluded from the filler list on purpose.
    check_contains_all("what kind of car is that", ["kind", "of", "car"])
    check_contains_all("sort of works", ["sort", "of", "works"])
    check_contains_all("that is not what i mean", ["not", "what", "i", "mean"])
    check_contains_all("so the answer is four", ["so", "answer", "four"])
    check_contains_all("ah that explains it", ["ah", "explains"])


@test
def test_filler_inside_a_word_is_not_removed():
    # Word boundaries: "um" must not be stripped out of "umbrella" or "album".
    check_contains_all("the umbrella is in the album", ["umbrella", "album"])
    check_contains_all("uhura and ermine", ["uhura", "ermine"])


# --- Spoken commands ----------------------------------------------------------


@test
def test_spoken_commands_are_off_by_default():
    """
    The default has to be off, because every command word is also an ordinary
    English word and rules can't tell them apart. Enabled unconditionally, these
    inputs were being mangled into the values in the comments.
    """
    check("a period of time", "A period of time")               # was "A. Of time"
    check("the semicolon operator in C", "The semicolon operator in C")  # was "The; operator in C"
    check("comma separated values are useful", "Comma separated values are useful")
    check("we discussed the colon cancer study", "We discussed the colon cancer study")
    check("in the new line of business", "In the new line of business")
    check("that is a full stop for now", "That is a full stop for now")
    check("the period of the pendulum", "The period of the pendulum")


@test
def test_spoken_commands_work_when_enabled():
    with spoken_commands_enabled():
        check("hello period", "Hello.")
        check("wait comma then go", "Wait, then go")
        check("really question mark", "Really?")
        check("stop exclamation mark", "Stop!")
        check("done full stop", "Done.")
        check("one new line two", "One\nTwo")
        check("one new paragraph two", "One\n\nTwo")


@test
def test_determiner_guard_protects_noun_uses_when_enabled():
    with spoken_commands_enabled():
        check("a period of time", "A period of time")
        check("the semicolon operator in C", "The semicolon operator in C")
        check("in the new line of business", "In the new line of business")
        check("my colon hurts", "My colon hurts")
        check("that is a full stop for now", "That is a full stop for now")


@test
def test_command_does_not_eat_a_preceding_newline():
    # The leading whitespace class must be [ \t]*, not \s*: with \s* the comma
    # rule consumed the newline the new-line rule had just inserted, so
    # "first line new line comma then" silently lost its line break.
    with spoken_commands_enabled():
        result = polish.polish("first line new line comma then")
        assert "\n" in result, repr(result)


@test
def test_new_paragraph_wins_over_new_line():
    # Ordered longest-first so "new paragraph" can't be partially consumed.
    with spoken_commands_enabled():
        assert polish.polish("one new paragraph two") == "One\n\nTwo"


# --- Personal dictionary ------------------------------------------------------


@test
def test_known_term_fixes_casing():
    check("deploy to kubernetes", "Deploy to Kubernetes", known_terms=["Kubernetes"])
    check("call yapflow now", "Call YapFlow now", known_terms=["YapFlow"])


@test
def test_known_term_casing_survives_recapitalization():
    """
    The dictionary exists for proper nouns, product names, and jargon — exactly
    the terms whose casing generic sentence-capitalization destroys. Substitution
    used to run BEFORE _recapitalize, which then uppercased what it had just
    inserted: iPhone -> IPhone, eBay -> EBay, npm -> Npm.
    """
    check("iphone is great", "iPhone is great", known_terms=["iPhone"])
    check("ebay and iphone", "eBay and iPhone", known_terms=["eBay", "iPhone"])
    check("macos is fine. iphone too", "macOS is fine. iPhone too", known_terms=["macOS", "iPhone"])
    # An explicit entry beats generic capitalization even at a sentence start.
    check("npm install it", "npm install it", known_terms=["npm"])


@test
def test_hyphenated_interjections_are_not_amputated():
    # \buh\b matches before a hyphen, so "uh-huh" became "-huh". "uh-huh" is a
    # real word meaning yes; the residue was garbage.
    check_contains_all("uh-huh and um-hum", ["uh-huh", "um-hum"])
    # The bare fillers must still go.
    check("um so yes uh", "So yes")


@test
def test_known_term_respects_word_boundaries():
    # "cat" must not rewrite the "cat" inside "concatenate".
    result = polish.polish("concatenate the cat", known_terms=["CAT"])
    # Case-insensitive: the first letter gets capitalized as a sentence start.
    assert "concatenate" in result.lower(), result
    assert "conCATenate" not in result, result
    assert "CAT" in result, result


@test
def test_regex_hostile_known_terms_are_escaped():
    # These would be regex syntax errors or group references if unescaped.
    for term in [r"\1", "a(b", "c[d", "e*", "f+", "$g", "^h", "back\\slash"]:
        # Must not raise, and must not corrupt the input.
        result = polish.polish("hello world", known_terms=[term])
        assert "hello" in result.lower(), (term, result)


@test
def test_known_terms_are_bounded():
    # A hostile or corrupted client shouldn't turn every dictation into
    # thousands of regex passes.
    many = [f"term{i}" for i in range(500)]
    result = polish.polish("hello world", known_terms=many)
    assert result == "Hello world", result

    too_long = ["x" * 500]
    assert polish.polish("hello", known_terms=too_long) == "Hello"


@test
def test_non_string_known_terms_are_skipped():
    # A term that does not appear in the text, so the assertion is about the
    # non-string entries being skipped rather than about substitution. ("hello"
    # as a term would legitimately force lowercase now, since known terms are
    # applied after recapitalization and an explicit entry wins.)
    result = polish.polish("hello", known_terms=[None, 42, {"a": 1}, "Kubernetes"])
    assert result == "Hello", result


@test
def test_personalize_false_skips_substitution():
    result = polish.polish("deploy to kubernetes", personalize=False, known_terms=["Kubernetes"])
    assert "kubernetes" in result, result


# --- Capitalization and whitespace -------------------------------------------


@test
def test_capitalizes_sentence_starts():
    check("first sentence. second one", "First sentence. Second one")
    check("is it done? yes", "Is it done? Yes")
    check("stop! go", "Stop! Go")


@test
def test_recapitalizes_after_filler_joins_sentences():
    check("first sentence. um second sentence", "First sentence. Second sentence")


@test
def test_standalone_i_is_capitalized():
    check("i think i can", "I think I can")
    check("that's what i said", "That's what I said")


@test
def test_lone_i_rule_does_not_break_identifiers_or_abbreviations():
    result = polish.polish("i think i18n and i.e. matter")
    assert "i18n" in result, result
    assert "i.e." in result, result


@test
def test_abbreviations_are_not_sentence_boundaries():
    check("i think i.e. should survive", "I think i.e. should survive")
    check("use redis e.g. for cache. it is fast", "Use redis e.g. for cache. It is fast")
    check("ask dr. smith", "Ask dr. smith")


@test
def test_whitespace_is_normalized():
    check("hello    world", "Hello world")
    check("  hello  ", "Hello")
    check("hello .", "Hello.")
    check("hello ,  world", "Hello, world")


@test
def test_blank_lines_from_new_paragraph_survive_normalization():
    with spoken_commands_enabled():
        result = polish.polish("one new paragraph two")
        assert result == "One\n\nTwo", repr(result)


# --- Robustness ---------------------------------------------------------------


@test
def test_empty_input():
    check("", "")
    check("   ", "")


@test
def test_already_clean_text_is_left_alone():
    # Moonshine v2 already emits cased, punctuated text, so the common case is a
    # no-op. Anything that mangles clean input is a bug.
    for text in [
        "The quick brown fox jumps over the lazy dog.",
        "Let's ship it on Tuesday.",
        "Does this work?",
        "Refactor wsClient.js to reuse the socket.",
    ]:
        assert polish.polish(text) == text, f"{text!r} -> {polish.polish(text)!r}"


@test
def test_never_raises_on_odd_input():
    for weird in ["\n\n\n", "...", "!!!", "👋 emoji 👨‍👩‍👧", "a" * 10000, ",,,", "\t\t"]:
        polish.polish(weird)  # must not raise


@test
def test_unicode_survives():
    check_contains_all("café and naïve and 👋", ["café", "naïve", "👋"])


@test
def test_is_fast_enough_to_be_off_the_critical_path():
    import time

    sample = "um so i think uh we should probably ship this thing on tuesday you know"
    start = time.perf_counter()
    for _ in range(1000):
        polish.polish(sample, known_terms=["Tuesday"])
    per_call_ms = (time.perf_counter() - start)
    assert per_call_ms < 1.0, f"1000 calls took {per_call_ms:.3f}s — too slow for the hot path"


if __name__ == "__main__":
    failures = 0
    for name, fn in sorted(tests.items()):
        try:
            fn()
            print(f"PASS {name}")
        except AssertionError as exc:
            failures += 1
            print(f"FAIL {name}: {exc}")
        except Exception as exc:  # noqa: BLE001
            failures += 1
            print(f"ERROR {name}: {type(exc).__name__}: {exc}")
    raise SystemExit(1 if failures else 0)
