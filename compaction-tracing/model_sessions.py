#!/usr/bin/env python3
"""Correlate compaction entries with the model (and its context window) active
at the time of each compaction, across all pi session files.

Emits a per-session table plus a by-model summary:
    - compactions: count in the session
    - tokensBeforeSum: total context tokens discarded
    - windows: sum of context windows of the models active at each compaction
    - ratio: tokensBeforeSum / windows  ("how many full windows were forgotten")

Usage:
    ./model_sessions.py [--all]        # sessions with compactions (default)
                                       # --all: every session file
"""

import json
import os
import re
import subprocess
import sys
from collections import defaultdict
from glob import glob

SESSIONS_ROOT = os.path.expanduser("~/.pi/agent/sessions")
RESERVE = 16384  # compact triggers at contextWindow - reserveTokens


def parse_models() -> dict[tuple[str, str], int]:
    """Parse `pi --list-models` TSV into {(provider, model): contextTokens}."""
    out = subprocess.run(
        ["pi", "--list-models"], capture_output=True, text=True, check=True
    ).stdout
    models: dict[tuple[str, str], int] = {}
    for line in out.splitlines()[1:]:  # skip header
        parts = line.split()
        if len(parts) < 3:
            continue
        provider, model, context = parts[0], parts[1], parts[2]
        m = re.fullmatch(r"([\d.]+)([kKmM])", context)
        if not m:
            continue
        value = float(m.group(1))
        if m.group(2) in ("k", "K"):
            value *= 1_000
        elif m.group(2) in ("m", "M"):
            value *= 1_000_000
        models[(provider, model)] = int(value)
    return models


def scan_session(path: str, models: dict[tuple[str, str], int]):
    """Return list of (timestamp, tokensBefore, window) per compaction."""
    model_since: list[tuple[str, str, int]] = []  # (timestamp, provider, modelId)
    compactions = []
    with open(path, encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
            except json.JSONDecodeError:
                continue
            t = obj.get("timestamp")
            if obj.get("type") == "model_change":
                model_since.append((t, obj.get("provider"), obj.get("modelId")))
            elif obj.get("type") == "compaction":
                compactions.append((t, obj.get("tokensBefore") or 0))
    rows = []
    for ctime, tokens in compactions:
        provider = model = None
        for mt, mp, mm in model_since:
            if mt <= ctime:
                provider, model = mp, mm
            else:
                break
        window = models.get((provider, model)) if provider else None
        rows.append((ctime, tokens, provider, model, window))
    return rows


def main() -> int:
    all_files = sorted(glob(f"{SESSIONS_ROOT}/*/*.jsonl"))
    models = parse_models()
    print(f"models parsed from `pi --list-models`: {len(models)}")

    per_session = []  # (path, rows)
    for path in all_files:
        rows = scan_session(path, models)
        if rows:
            per_session.append((path, rows))

    if "--all" not in sys.argv:
        files_n = len(per_session)
        total = len(all_files)
        print(f"sessions with compactions: {files_n} / {total}")
    else:
        print(f"all sessions scanned: {len(all_files)}")

    print()
    print(f"{'window':>7} {'count':>6} {'sessions':>9} {'tokensSum':>12} {'tokens/window':>13}")
    by_window = defaultdict(lambda: [0, set(), 0])
    unknowns = 0
    unk_tokens = 0
    for path, rows in per_session:
        for _, tokens, provider, model, window in rows:
            if window is None:
                unknowns += 1
                unk_tokens += tokens
                continue
            by_window[f"{window/1000:.0f}K"][0] += 1
            by_window[f"{window/1000:.0f}K"][1].add(path)
            by_window[f"{window/1000:.0f}K"][2] += tokens
    for w in sorted(by_window, key=lambda k: int(k[:-1])):
        n, sessions, tokens = by_window[w]
        print(f"{w:>7} {n:>6} {len(sessions):>9} {tokens:>12,} {tokens/n:>13,.0f}")
    if unknowns:
        print(f"unknown: {unknowns} compactions ({unk_tokens:,} tokens, model not in --list-models)")

    print()
    print("--- per session (ratio = tokensBeforeSum / windowSum of its compactions) ---")
    detail = []
    for path, rows in per_session:
        tokens = sum(r[1] for r in rows)
        windows = [r[4] for r in rows if r[4] is not None]
        ratio = tokens / sum(windows) if windows else None
        models_used = sorted({f"{p}/{m}" for _, _, p, m, _ in rows if p})
        detail.append((len(rows), tokens, ratio, models_used, path))
    for n, tokens, ratio, mused, path in sorted(detail, key=lambda x: -(x[2] or 0)):
        r = f"{ratio:.2f}" if ratio is not None else "  -- "
        print(f"{n:>2} compactions {tokens:>9,} tokens  ratio={r}  {','.join(mused)}")
        print(f"      {path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())