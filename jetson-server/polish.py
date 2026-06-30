"""
The Gemma 3 4B polish step. One Ollama call per dictation, doing cleanup,
personalization, and mid-utterance self-correction together in a single
prompt — not three separate passes.

Why one call, not a chain: Wispr Flow's own API sends a single
`disable-formatting` boolean alongside every request rather than running
formatting as a separate downstream step, meaning one model invocation
handles both "clean this transcript" and "format/personalize it" depending
on a flag. That's more latency-efficient (one inference pass, not several)
and is the pattern this project follows. See CLAUDE.md Decisions section 4
and docs/yapflow-master-plan.md Section 2.8/3.1 before changing this to a
multi-call pipeline.
"""

from __future__ import annotations

import logging
from typing import Optional

import ollama

import config

logger = logging.getLogger("yapflow.polish")

_model_ready = False


def ensure_model_ready() -> None:
    """
    Pull the model if needed and preload it so the first real dictation
    doesn't pay a cold-start cost. Mirrors the pattern in Moonshine's own
    ollama_voice.py reference example. Call this once at server startup,
    not per-request.
    """
    global _model_ready
    if _model_ready:
        return

    listed = ollama.list()
    model_names = [m.model for m in (listed.models or [])]
    if config.OLLAMA_MODEL not in model_names:
        logger.info("Pulling Ollama model '%s' (first run only)...", config.OLLAMA_MODEL)
        ollama.pull(config.OLLAMA_MODEL)

    logger.info("Preloading Ollama model '%s'...", config.OLLAMA_MODEL)
    # keep_alive matches config.OLLAMA_KEEP_ALIVE ("-1" = stay resident
    # forever). See CLAUDE.md Decisions section 9 on why we deliberately
    # avoid letting the model unload between requests on this hardware.
    ollama.generate(model=config.OLLAMA_MODEL, prompt="", keep_alive=config.OLLAMA_KEEP_ALIVE)
    _model_ready = True


def _build_system_prompt(personalize: bool, known_terms: list[str]) -> str:
    """
    One prompt, gated by the `personalize` flag, handling three jobs at once:
    cleanup, personalization/formatting, and mid-utterance self-correction.
    """
    base = (
        "You are a dictation post-processor. You receive a raw, unpunctuated "
        "speech-to-text transcript and return clean, polished text ready to "
        "be inserted at a text cursor in place of the raw transcript.\n\n"
        "Rules:\n"
        "- Add appropriate punctuation and capitalization.\n"
        "- Remove filler words (um, uh, you know, like) unless they carry "
        "real meaning.\n"
        "- If the speaker corrects or restates something mid-utterance "
        "(signaled by phrases like 'actually', 'no wait', 'I mean', 'sorry, "
        "X not Y', or simply repeating a phrase with a change), output ONLY "
        "the corrected/final version — drop the superseded fragment "
        "entirely. For example, 'let's meet Tuesday, actually no, "
        "Wednesday' becomes 'Let's meet Wednesday.'\n"
        "- Output ONLY the polished text. No preamble, no explanation, no "
        "quotation marks around the output.\n"
    )

    if not personalize:
        return base

    personalization = (
        "\nThe speaker has previously corrected the following terms — when "
        "the transcript contains something that sounds similar to one of "
        "these, prefer the speaker's known spelling/usage:\n"
    )
    if known_terms:
        personalization += "\n".join(f"- {term}" for term in known_terms)
    else:
        personalization += "(none recorded yet)"

    return base + personalization


def polish(
    raw_transcript: str,
    personalize: bool = True,
    known_terms: Optional[list[str]] = None,
) -> str:
    """
    The single Gemma call. Returns polished text, or the raw transcript
    unchanged if the model call fails or returns something empty/malformed
    (see CLAUDE.md / spec Step 6 resilience checklist — never erase the
    user's words because of a server-side failure).
    """
    ensure_model_ready()
    known_terms = known_terms or []

    system_prompt = _build_system_prompt(personalize, known_terms)

    try:
        response = ollama.chat(
            model=config.OLLAMA_MODEL,
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": raw_transcript},
            ],
            options={"num_ctx": config.OLLAMA_NUM_CTX},
            keep_alive=config.OLLAMA_KEEP_ALIVE,
        )
        polished = response["message"]["content"].strip()
        if not polished:
            logger.warning("Gemma returned empty polish result, falling back to raw transcript")
            return raw_transcript
        return polished
    except Exception:
        logger.exception("Gemma polish call failed, falling back to raw transcript")
        return raw_transcript
