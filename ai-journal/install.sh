#!/usr/bin/env bash
# 이 컴퓨터의 모든 클로드 코드 작업에 'AI 작업 일지' 자동 기록을 켠다.
# 사용: bash ai-journal/install.sh   (끄기: bash ai-journal/install.sh --off)
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
DEST="$HOME/.claude/hooks/ai_journal.py"
SETTINGS="$HOME/.claude/settings.json"
mkdir -p "$HOME/.claude/hooks"
[ "${1:-}" = "--off" ] || cp "$HERE/.claude/hooks/ai_journal.py" "$DEST"

python3 - "$SETTINGS" "${1:-}" <<'PY'
import json, os, sys
path, mode = sys.argv[1], sys.argv[2]
cmd = 'python3 "$HOME/.claude/hooks/ai_journal.py"'
try:
    s = json.load(open(path, encoding="utf-8"))
except FileNotFoundError:
    s = {}
hooks = s.setdefault("hooks", {})
for ev in ("SessionStart", "UserPromptSubmit", "Stop", "SessionEnd"):
    groups = [g for g in hooks.get(ev, [])
              if not any("ai_journal.py" in h.get("command", "") for h in g.get("hooks", []))]
    if mode != "--off":
        groups.append({"hooks": [{"type": "command", "command": cmd}]})
    if groups:
        hooks[ev] = groups
    else:
        hooks.pop(ev, None)
os.makedirs(os.path.dirname(path), exist_ok=True)
json.dump(s, open(path, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
print("일지 자동 기록을 껐습니다." if mode == "--off" else "일지 자동 기록을 켰습니다. 새 클로드 코드 세션부터 적용됩니다.")
PY
