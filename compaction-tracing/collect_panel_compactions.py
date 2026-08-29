#!/usr/bin/env python3
"""Collect compaction metrics for all herdr agent panes (post-hoc style).

The orchestrator does NOT ask child agents to report anything. Instead this
script reads `herdr agent list` -> agent_session.value (session file path)
and aggregates compaction entries per pane.

Usage:
    ./collect_panel_compactions.py            # all panes
    ./collect_panel_compactions.py --name impl review   # filter by pane name
    ./collect_panel_compactions.py --json     # machine-readable

Verification targets (HANDOFF.md item 4):
  - running panes (working) can be read while the file is being appended
  - finished panes (idle/done) remain readable -> post-hoc counting works
"""

import glob
import json
import os
import re
import subprocess
import sys
from datetime import datetime

RESERVE = 16384


def herdr_agents() -> list[dict]:
    out = subprocess.run(["herdr", "agent", "list"], capture_output=True, text=True, check=True).stdout
    return json.loads(out)["result"]["agents"]


def model_windows() -> dict[tuple[str, str], int]:
    out = subprocess.run(["pi", "--list-models"], capture_output=True, text=True, check=True).stdout
    windows = {}
    for line in out.splitlines()[1:]:
        p = line.split()
        if len(p) < 3:
            continue
        m = re.fullmatch(r"([\d.]+)([kKmM])", p[2])
        if not m:
            continue
        v = float(m.group(1))
        if m.group(2) in "kK":
            v *= 1_000
        elif m.group(2) in "mM":
            v *= 1_000_000
        windows[(p[0], p[1])] = int(v)
    return windows


def session_dir_for_cwd(cwd: str) -> str:
    """~/.pi/agent/sessions/--home-<user>-workspace-lab-- style dir name."""
    return os.path.join(os.path.expanduser("~/.pi/agent/sessions"),
                        "--" + cwd.strip("/").replace("/", "-") + "--")


def latest_session_in_dir(cwd: str) -> str | None:
    """Fallback: newest .jsonl under the cwd-encoded sessions dir."""
    d = session_dir_for_cwd(cwd)
    if not os.path.isdir(d):
        return None
    files = [f for f in glob.glob(os.path.join(d, "*.jsonl")) if os.path.isfile(f)]
    return max(files, key=os.path.getmtime) if files else None


def session_metrics(path: str) -> dict:
    """Return compaction count, tokensBeforeSum, and last active model."""
    compactions = []
    model = None
    last_change_ts = None
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
                model = (obj.get("provider"), obj.get("modelId"))
                last_change_ts = t
            elif obj.get("type") == "compaction":
                compactions.append((t, obj.get("tokensBefore") or 0))
    return {
        "compactions": len(compactions),
        "tokensBeforeSum": sum(t for _, t in compactions),
        "entries": compactions,
        "model": model,
        "modelSince": last_change_ts,
    }


def main() -> int:
    args = sys.argv[1:]
    want_json = "--json" in args
    names = []
    if "--name" in args:
        i = args.index("--name")
        names = args[i + 1:]
    if not names:
        names = None  # no filter

    agents = herdr_agents()
    windows = model_windows()
    rows = []
    used_paths: set[str] = set()
    for a in agents:
        name = a.get("name") or "(unnamed)"
        if names is not None and name not in names:
            continue
        s = a.get("agent_session") or {}
        path = s.get("value")
        fallback = None
        if not path or not os.path.isfile(path):
            # fallback: newest session file in the cwd-encoded dir
            fb = latest_session_in_dir(a.get("cwd") or "")
            if not fb:
                rows.append({"name": name, "pane": a.get("pane_id"),
                             "status": a.get("agent_status"), "cwd": a.get("cwd"),
                             "error": f"session file missing ({path}); no fallback"})
                continue
            if fb in used_paths:
                rows.append({"name": name, "pane": a.get("pane_id"),
                             "status": a.get("agent_status"), "cwd": a.get("cwd"),
                             "error": f"fallback {fb} already counted for another pane"})
                continue
            path = fb
            fallback = True
        used_paths.add(path)
        m = session_metrics(path)
        window = windows.get(m["model"]) if m["model"] else None
        rows.append({
            "name": name, "pane": a.get("pane_id"), "status": a.get("agent_status"),
            "cwd": a.get("cwd"), "session_file": path,
            "compactions": m["compactions"], "tokensBeforeSum": m["tokensBeforeSum"],
            "model": f"{m['model'][0]}/{m['model'][1]}" if m["model"] else None,
            "window": window, "fallback": fallback,
        })

    if want_json:
        print(json.dumps(rows, ensure_ascii=False, indent=2))
        return 0

    print(f"{'name':<16} {'pane':<7} {'status':<8} {'cmps':>4} {'tokensSum':>11} {'window':>7}  model")
    total_c = total_t = 0
    for r in rows:
        if "error" in r:
            print(f"{r['name']:<16} {r['pane']:<7} {r['status']:<8} {'--':>4} {'--':>11} {'--':>7}  {r['error']}")
            continue
        fb = " (fallback)" if r.get("fallback") else ""
        w = f"{r['window']/1000:.0f}K" if r.get("window") else "--"
        print(f"{r['name']:<16} {r['pane']:<7} {r['status']:<8} {r['compactions']:>4} "
              f"{r['tokensBeforeSum']:>11,} {w:>7}  {r.get('model') or '-'}{fb}")
        total_c += r.get("compactions", 0)
        total_t += r.get("tokensBeforeSum", 0)
    print(f"\ntotal: {total_c} compactions / {total_t:,} tokens across {len(rows)} panes")
    return 0


if __name__ == "__main__":
    sys.exit(main())