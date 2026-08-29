#!/usr/bin/env python3
"""Scan all session files for gpt-5.6 requests exceeding 272K total input.

OpenAI prices requests with >272K total input tokens at long-context rates
for the ENTIRE request. pi defaults GPT-5.6 family to a 272K window, but
requests sent right after model switches or in other edge paths could still
exceed it. This scans every recorded assistant usage.
"""
import glob, json, os, sys

LIMIT = 272_000
SESSIONS = os.path.expanduser("~/.pi/agent/sessions/*/*.jsonl")

def main():
    over = []
    max_by_model = {}
    total_req = 0
    files = sorted(glob.glob(SESSIONS))
    for fp in files:
        try:
            with open(fp, encoding="utf-8") as fh:
                for line in fh:
                    try:
                        o = json.loads(line)
                    except Exception:
                        continue
                    if o.get("type") != "message":
                        continue
                    m = o.get("message") or {}
                    if m.get("role") != "assistant":
                        continue
                    u = m.get("usage") or {}
                    inp = u.get("input") or 0
                    cr = u.get("cacheRead") or 0
                    if not (inp or cr):
                        continue
                    total_req += 1
                    model = m.get("model") or "?"
                    prov = m.get("provider") or "?"
                    key = (prov, model)
                    sz = inp + cr
                    # skip non-gpt-5.6 quickly
                    if "gpt-5.6" not in model:
                        continue
                    prev = max_by_model.get(key, 0)
                    if sz > prev:
                        max_by_model[key] = sz
                    if sz > LIMIT:
                        over.append({
                            "file": fp.split("/")[-1][:45],
                            "ts": o.get("timestamp", "")[:19],
                            "provider": prov, "model": model,
                            "input": inp, "cacheRead": cr, "size": sz,
                            "cost": (u.get("cost") or {}).get("total"),
                            "stopReason": m.get("stopReason"),
                        })
        except OSError:
            continue
    print(f"sessions scanned: {len(files)}, assistant requests w/ usage: {total_req}")
    print(f"\nmax input+cacheRead per gpt-5.6 model (limit {LIMIT:,}):")
    for (prov, model), sz in sorted(max_by_model.items()):
        flag = "  <-- OVER" if sz > LIMIT else ""
        print(f"  {prov:<14} {model:<16} {sz:>10,}{flag}")
    print(f"\nrequests OVER {LIMIT:,}: {len(over)}")
    for r in sorted(over, key=lambda r: -r["size"]):
        print(f"  {r['ts']} {r['file']} {r['provider']}/{r['model']} "
              f"in={r['input']:,} cache={r['cacheRead']:,} total={r['size']:,} "
              f"cost=${r['cost'] or 0:.4f} stop={r['stopReason']}")
    return 0

if __name__ == "__main__":
    sys.exit(main())
