"""
Yapflow Jetson server — configuration.

Edit these values for your setup, or override via environment variables
of the same name (e.g. YAPFLOW_PORT=9000).
"""

import os

# --- Network ---
HOST = os.environ.get("YAPFLOW_HOST", "0.0.0.0")
PORT = int(os.environ.get("YAPFLOW_PORT", "8765"))

# Optional shared secret: trivial to add, no real downside. Set this to a random
# string and put the same value in the Mac app's config. Leave as None to
# disable the check entirely (fine on a trusted home LAN, but the check is
# nearly free, so there's little reason not to set it).
SHARED_SECRET = os.environ.get("YAPFLOW_SECRET", None)

# --- ASR (Moonshine v2 streaming) ---
# One of: TINY_STREAMING, SMALL_STREAMING, MEDIUM_STREAMING.
#
# SMALL_STREAMING (123M params, 7.84% WER) was chosen when this box also had to
# host Gemma 3 4B. That constraint is gone — the LLM polish step was removed, so
# there's roughly 3-4GB of unified memory free. MEDIUM_STREAMING (245M params,
# 6.65% WER, better than Whisper Large v3) is now affordable and is worth
# A/B-ing against this default: flip the env var, restart, and compare
# asr_finalize_ms p95 and WER-by-eye on the same set of utterances.
#
# A typo here is a hard error, not a silent fallback — see asr.py.
MOONSHINE_MODEL_ARCH = os.environ.get("YAPFLOW_ASR_MODEL", "SMALL_STREAMING")

# How often Moonshine emits incremental transcript updates while audio is
# still streaming in. Shorter = more responsive partial text, more compute.
# Because the streaming models do most of their work as audio arrives, this
# mostly affects how often live partial text refreshes, not final latency.
ASR_UPDATE_INTERVAL_SECONDS = float(os.environ.get("YAPFLOW_ASR_UPDATE_INTERVAL", "0.3"))

# --- Touch-up ---
# Whether to interpret spoken punctuation and formatting commands ("period",
# "comma", "new line", "question mark", …) in the transcript.
#
# OFF by default, and that default is deliberate. Every one of those words is
# also an ordinary English word, and rules can't tell which the speaker meant:
# enabled, "a period of time" becomes "A. Of time" and "the semicolon operator"
# becomes "The; operator". Moonshine v2 already emits punctuation, so the cost of
# leaving this off is small.
#
# Enabling adds a determiner guard that catches the common noun uses, but it's a
# heuristic — "comma separated values" still breaks. See polish.py.
SPOKEN_COMMANDS_ENABLED = os.environ.get("YAPFLOW_SPOKEN_COMMANDS", "").lower() in (
    "1",
    "true",
    "yes",
)

# --- Logging ---
LOG_LEVEL = os.environ.get("YAPFLOW_LOG_LEVEL", "INFO")
