#!/usr/bin/env python3
"""Count automatic compaction entries in a pi session JSONL file.

Usage:
    ./count_compactions.py <session.jsonl>            # human-readable summary
    ./count_compactions.py <session.jsonl> --json     # machine-readable JSON
    ./count_compactions.py                            # reads $PI_SESSION_FILE

The session file is append-only JSONL, one entry object per line. A compaction
entry looks like:
    {"type":"compaction","timestamp":"...","tokensBefore":50000,...}

Note: entries do not record manual/threshold/overflow. In the pi-issue-pr-workflow
no one runs /compact manually, so every entry counts as automatic.
"""

import json
import os
import sys

MODE_JSON = "--json" in sys.argv


def main() -> int:
    args = [a for a in sys.argv[1:] if a != "--json"]
    if args:
        path = args[0]
    else:
        path = os.environ.get("PI_SESSION_FILE", "")
    if not path or not os.path.isfile(path):
        print(f"error: session file not found: {path or '<empty>'}", file=sys.stderr)
        print("usage: count_compactions.py <session.jsonl> [--json]", file=sys.stderr)
        return 2

    entries = []
    with open(path, encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
            except json.JSONDecodeError:
                continue  # skip malformed line; never miscount on parse noise
            if obj.get("type") == "compaction":
                entries.append(obj)

    count = len(entries)
    tokens_before_sum = sum(e.get("tokensBefore") or 0 for e in entries)
    details_keys = sorted({k for e in entries for k in (e.get("details") or {}).keys()})

    if MODE_JSON:
        print(json.dumps({
            "session_file": path,
            "compactions": count,
            "tokensBeforeSum": tokens_before_sum,
            "detailsKeys": details_keys,
            "entries": [
                {"timestamp": e.get("timestamp"),
                 "tokensBefore": e.get("tokensBefore"),
                 "details": e.get("details")}
                for e in entries
            ],
        }, ensure_ascii=False, indent=2))
    else:
        print(f"session: {path}")
        print(f"compactions: {count}")
        print(f"tokensBefore sum: {tokens_before_sum}")
        if details_keys:
            print(f"details keys: {', '.join(details_keys)}")
        for e in entries:
            print(f"  - {e.get('timestamp')}  tokensBefore={e.get('tokensBefore')}")
    return 0


if __name__ == "__main__":
    sys.exit(main())