"""
The touch-up step: deterministic, sub-millisecond, no model.

This used to be a Gemma 3 4B call through Ollama. It isn't anymore, and the
reason is latency: a blocking 4B generation sits squarely on the post-release
critical path, and on an Orin Nano that's measured in seconds, not
milliseconds. It also had to share 8GB of unified memory with the ASR model,
which capped how good the ASR could be. Removing it frees ~3-4GB and lets
Moonshine move up a size class.

The other half of the reason: Moonshine v2 already emits cased, punctuated
text. The old prompt spent most of its instructions asking a language model to
do work the ASR model had already done. What's genuinely left over is
mechanical — filler words, a personal-dictionary swap, spacing — and mechanical
work belongs in string operations, not in a transformer.

What was actually lost by dropping the LLM, stated plainly so nobody
rediscovers it as a bug: mid-utterance self-correction collapsing. "Let's meet
Tuesday, actually no, Wednesday" used to come out as "Let's meet Wednesday."
Rules cannot do that safely — distinguishing a correction from ordinary speech
needs a model. If you want it back, that's a deliberate re-introduction of a
language model and all the latency that comes with it.

Everything here preserves the one invariant that matters: never lose the
user's words. Every failure path returns the raw transcript untouched.
"""

from __future__ import annotations

import logging
import re
from typing import Optional

logger = logging.getLogger("yapflow.polish")

# Bounds on the personal dictionary. The terms arrive from the Mac client over
# the wire (see server.py's `start` message), so they're untrusted input. When
# this fed a system prompt they were also a prompt-injection vector and could
# blow past the model's context window; as plain string substitution neither
# applies, but bounding them still keeps a hostile or corrupted client from
# turning every dictation into 10,000 regex passes.
MAX_KNOWN_TERMS = 100
MAX_TERM_LENGTH = 64

# Filler words removed unconditionally. Deliberately, aggressively
# conservative — every entry here is a word that is essentially never content
# in dictation. Things that look like fillers but are frequently load-bearing
# are excluded on purpose, because a false positive silently deletes a word the
# user said, which is far worse than leaving a filler in:
#   "like"     -> "code like this"
#   "so"       -> "so the answer is"
#   "I mean"   -> "that's not what I mean"
#   "kind of"  -> "what kind of car"
#   "sort of"  -> "sort of thing"
#   "ah"       -> "ah ha", and it's a real interjection
# "you know" is safe as a two-word phrase in a way its component words are not.
_FILLER_PATTERN = re.compile(
    r"\b(?:umm?|uhh?|erm|hmm+|mhm|you\s+know)\b[\s,]*",
    re.IGNORECASE,
)

# "like" only when it's fenced by commas on both sides — "it was, like, huge".
# That framing is the one context where it's reliably a filler rather than a
# preposition or verb. Both commas go with it: the sentence read without the
# aside doesn't want a comma there ("it was really big", not "it was, really
# big").
_FENCED_LIKE = re.compile(r",\s*like\s*,\s*", re.IGNORECASE)

# Standalone lowercase "i" -> "I". Moonshine usually gets this right, but
# filler removal and line-joining can leave one mid-sentence where it started a
# line. Bounded on both sides so "i.e." and identifiers like "i18n" survive.
_LONE_I = re.compile(r"\bi\b(?![.\w])")

# Spoken punctuation and formatting commands. Ordered longest-first within the
# alternation so "new paragraph" wins over "new line" and can't be partially
# consumed. The leading \s* lets these absorb the space before them, so
# "hello period" becomes "hello." and not "hello ."
_SPOKEN_COMMANDS = [
    (re.compile(r"\s*\bnew\s+paragraph\b", re.IGNORECASE), "\n\n"),
    (re.compile(r"\s*\bnew\s+line\b", re.IGNORECASE), "\n"),
    (re.compile(r"\s*\bquestion\s+mark\b", re.IGNORECASE), "?"),
    (re.compile(r"\s*\bexclamation\s+(?:mark|point)\b", re.IGNORECASE), "!"),
    (re.compile(r"\s*\bfull\s+stop\b", re.IGNORECASE), "."),
    (re.compile(r"\s*\bperiod\b", re.IGNORECASE), "."),
    (re.compile(r"\s*\bcomma\b", re.IGNORECASE), ","),
    (re.compile(r"\s*\bcolon\b", re.IGNORECASE), ":"),
    (re.compile(r"\s*\bsemicolon\b", re.IGNORECASE), ";"),
]

# Whitespace before punctuation that should be closed up, e.g. "hello ." -> "hello."
_SPACE_BEFORE_PUNCT = re.compile(r"\s+([.,!?;:])")
# Runs of horizontal whitespace (not newlines — those are meaningful here,
# since "new paragraph" produces them).
_HORIZONTAL_RUN = re.compile(r"[ \t]{2,}")
# A sentence-final punctuation mark followed by a lowercase letter, used to
# re-capitalize after filler removal joins two sentences.
_SENTENCE_START = re.compile(r"([.!?]\s+|\A|\n+)([a-z])")

# Abbreviations whose trailing period is not a sentence boundary. Without this
# guard, "i.e. should" becomes "i.e. Should". Not exhaustive and can't be — this
# is the genuinely ambiguous case in sentence splitting, and the failure mode is
# a stray capital letter, which is cosmetic. Kept to what dictation actually
# produces rather than trying to be a full abbreviation dictionary.
_ABBREVIATIONS = (
    "i.e.", "e.g.", "etc.", "vs.", "cf.", "approx.", "no.", "fig.",
    "mr.", "mrs.", "ms.", "dr.", "prof.", "st.", "jr.", "sr.",
)


def _strip_fillers(text: str) -> str:
    """
    Remove filler words. The trailing `[\\s,]*` in the pattern eats the
    whitespace and any comma that followed the filler, so "well, um, I think"
    collapses cleanly to "well, I think" rather than leaving ", ," behind.
    """
    text = _FENCED_LIKE.sub(" ", text)
    return _FILLER_PATTERN.sub("", text)


def _apply_spoken_commands(text: str) -> str:
    for pattern, replacement in _SPOKEN_COMMANDS:
        text = pattern.sub(replacement, text)
    return text


def _apply_known_terms(text: str, known_terms: list[str]) -> str:
    """
    Personal-dictionary substitution: whole-word, case-insensitive match on a
    learned term, replaced with the user's own spelling of it.

    This is the mechanical descendant of what the Gemma prompt did fuzzily
    ("prefer the speaker's known spelling when the transcript contains
    something similar"). Rules can't do "sounds similar", so this only fixes
    casing and exact-token spelling — which in practice is most of what the
    corrections table actually holds (proper nouns, product names, jargon).

    Terms are `re.escape`d on the pattern side, and substituted via a lambda
    rather than a replacement string, so a term containing a backslash or `\\1`
    can't be reinterpreted as a regex or a group reference. They come from user
    speech via the corrections DB, so neither is hypothetical.
    """
    for term in known_terms:
        if not term:
            continue
        text = re.sub(
            rf"\b{re.escape(term)}\b",
            lambda _m, replacement=term: replacement,
            text,
            flags=re.IGNORECASE,
        )
    return text


def _normalize_whitespace(text: str) -> str:
    text = _SPACE_BEFORE_PUNCT.sub(r"\1", text)
    text = _HORIZONTAL_RUN.sub(" ", text)
    # Strip horizontal space at both ends of each line, without destroying the
    # blank lines that "new paragraph" deliberately created. Both ends matter:
    # the spoken-command substitutions leave a space on the far side of an
    # inserted newline ("hello period new line this" -> "Hello.\n this").
    text = "\n".join(line.strip() for line in text.split("\n"))
    return text.strip()


def _recapitalize(text: str) -> str:
    """
    Capitalize the first letter of the text and of anything following
    sentence-final punctuation or a newline. Needed because filler removal can
    splice two sentences together, and because Moonshine's per-line casing
    doesn't know about the lines we joined in finalize().
    """
    text = _LONE_I.sub("I", text)

    def _cap(match: "re.Match[str]") -> str:
        # Only a period can be an abbreviation boundary; "!"/"?"/newline/start
        # of string always begin a real sentence. The slice has to *include* the
        # matched period for the endswith check to see "i.e." rather than "i.e".
        if match.group(1).startswith("."):
            preceding = text[: match.start() + 1].rstrip().lower()
            if any(preceding.endswith(abbr) for abbr in _ABBREVIATIONS):
                return match.group(0)
        return match.group(1) + match.group(2).upper()

    return _SENTENCE_START.sub(_cap, text)


def _sanitize_known_terms(known_terms: Optional[list[str]]) -> list[str]:
    if not known_terms:
        return []
    cleaned = []
    for term in known_terms[:MAX_KNOWN_TERMS]:
        if not isinstance(term, str):
            continue
        term = term.strip()
        if term and len(term) <= MAX_TERM_LENGTH:
            cleaned.append(term)
    return cleaned


def polish(
    raw_transcript: str,
    personalize: bool = True,
    known_terms: Optional[list[str]] = None,
) -> str:
    """
    Touch up a raw transcript for insertion at a text cursor.

    Signature is unchanged from the Gemma version on purpose — server.py and
    the wire protocol don't need to know this stopped being a model call.

    Returns the raw transcript unchanged on any failure. That guarantee is
    load-bearing: a server-side bug must never silently eat what the user
    said.
    """
    try:
        text = raw_transcript
        text = _strip_fillers(text)
        text = _apply_spoken_commands(text)
        if personalize:
            text = _apply_known_terms(text, _sanitize_known_terms(known_terms))
        text = _normalize_whitespace(text)
        text = _recapitalize(text)

        if not text.strip():
            # Everything we had was filler. Returning the raw transcript would
            # paste "um uh" at the cursor; returning empty is the honest
            # answer, and server.py already has a no-speech path for it.
            return ""
        return text
    except Exception:
        logger.exception("Touch-up failed, falling back to raw transcript")
        return raw_transcript
