"""
Yapflow Jetson server — configuration.

Edit these values for your setup, or override via environment variables
of the same name (e.g. YAPFLOW_PORT=9000).
"""

import os

# --- Network ---
HOST = os.environ.get("YAPFLOW_HOST", "0.0.0.0")
PORT = int(os.environ.get("YAPFLOW_PORT", "8765"))

# Optional shared-secret header, carried forward from Phase 1 per the spec's
# Open Decision 4 ("trivial to add, no real downside"). Set this to a random
# string and put the same value in the Mac app's config. Leave as None to
# disable the check entirely (fine on a trusted home LAN, but the check is
# nearly free, so there's little reason not to set it).
SHARED_SECRET = os.environ.get("YAPFLOW_SECRET", None)

# --- ASR (Moonshine v2 streaming) ---
# One of: TINY_STREAMING, SMALL_STREAMING, MEDIUM_STREAMING
# SMALL_STREAMING is the recommended default for live apps (123M params,
# 7.84% WER) — a reasonable balance of accuracy and footprint on an 8GB
# Jetson that's also running Gemma 3 4B alongside it.
MOONSHINE_MODEL_ARCH = os.environ.get("YAPFLOW_ASR_MODEL", "SMALL_STREAMING")

# How often Moonshine emits incremental transcript updates while audio is
# still streaming in. Shorter = more responsive partial text, more compute.
ASR_UPDATE_INTERVAL_SECONDS = 0.3

# --- LLM polish step (Ollama) ---
OLLAMA_HOST = os.environ.get("OLLAMA_HOST", "http://127.0.0.1:11434")

# IMPORTANT: check `ollama list` / ollama.com/library/gemma3 for a -qat
# tagged variant before assuming this default is the most memory-efficient
# choice available — see CLAUDE.md Decisions section.
OLLAMA_MODEL = os.environ.get("YAPFLOW_LLM_MODEL", "gemma3:4b")

# Keep this small and deliberate. The polish prompt is short (raw transcript
# + a handful of learned dictionary terms + instructions) — there is no
# reason to run a large context window for this. See CLAUDE.md Decisions
# section 8 for why this matters on 8GB unified memory.
OLLAMA_NUM_CTX = int(os.environ.get("YAPFLOW_NUM_CTX", "1024"))

# Keep the model resident between requests. Do NOT set this to a short
# duration that causes Ollama to unload/reload the model — see CLAUDE.md
# Decisions section 9 on CMA fragmentation from repeated load/unload cycles.
OLLAMA_KEEP_ALIVE = os.environ.get("YAPFLOW_KEEP_ALIVE", "-1")  # -1 = forever

# --- Logging ---
LOG_LEVEL = os.environ.get("YAPFLOW_LOG_LEVEL", "INFO")
