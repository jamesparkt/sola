#!/usr/bin/env python3
"""AI 작업 일지 — 클로드 코드 자동 기록 장치.

구글 문서 'AI 작업 일지'에 클로드 코드 작업을 약 5분 간격으로 남기게 한다.
- SessionStart: 일지를 먼저 읽으라고 알려 준다(지난 세션에서 못 남긴 지시도 함께).
- UserPromptSubmit: 목사님 지시를 모아 둔다(일지 문서에는 아직 쓰지 않는다).
- Stop: 마지막 기록 뒤 5분이 지났고 새 지시가 있으면, 클로드에게 일지를 쓰게 한다.
- SessionEnd: 못 남긴 지시를 다음 세션으로 넘긴다.

모은 지시는 이 컴퓨터의 ~/.claude/ai-journal/ 에만 둔다. 저장소에는 아무것도 쓰지 않는다.
"""
import json
import os
import sys
import time
from datetime import datetime, timedelta, timezone

DOC_ID = "1SgiQOAkc5NfMq_z0-iW_yCk7cqK-5CyA2yr67oUw3o8"
DOC_URL = f"https://docs.google.com/document/d/{DOC_ID}/edit"
MARKER = "(여기부터 새 글)"
INTERVAL = int(os.environ.get("AI_JOURNAL_INTERVAL", "300"))  # 초. 기본 5분
STATE_DIR = os.path.expanduser(os.environ.get("AI_JOURNAL_STATE_DIR", "~/.claude/ai-journal"))
CARRY_FILE = os.path.join(STATE_DIR, "unlogged.json")
KST = timezone(timedelta(hours=9))
MAX_PROMPT = 300
MAX_PENDING = 20


def now_kst():
    return datetime.now(KST).strftime("%Y-%m-%d %H:%M")


def state_path(session_id):
    safe = "".join(c for c in (session_id or "unknown") if c.isalnum() or c in "-_")
    return os.path.join(STATE_DIR, f"{safe}.json")


def load(path, default):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return default


def save(path, data):
    os.makedirs(STATE_DIR, exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False)
    os.replace(tmp, path)


def where(cwd):
    name = os.path.basename(os.path.normpath(cwd or "")) or "?"
    return f"클로드 코드 · {name}"


def how_to_write(cwd):
    return (
        f"쓰는 법: Google Docs 커넥터 update_doc 으로 문서 {DOC_ID} 에 replaceAllText 한 번만 보낸다. "
        f"찾을 글 '{MARKER}' (matchCase true) → 바꿀 글 '{MARKER}\\n\\n' + 아래 형식의 새 글(줄 사이 \\n, 끝에는 \\n 없음). "
        "그러면 표시줄 바로 아래(맨 위)에 빈 줄을 두고 새 글이 들어간다. 지난 글은 건드리지 않는다.\n"
        f"형식:\n[{now_kst()}] {where(cwd)}\n주제: \n지시: 목사님 지시 한두 줄 요약\n"
        "진행: 답변·진행 상황 한두 줄\n상태: 진행 중 / 완료 / 막힘 / 넘김(→ 받을 AI)\n링크: (있을 때만)\n"
        "짧게 쓰고, 비밀번호·키·성도 개인 상담 내용은 쓰지 않는다. "
        "구글 커넥터가 없으면 쓰지 말고 목사님께 '일지 연결이 안 됩니다' 한 줄만 말한다. "
        "다 쓰면 목사님께 따로 보고하지 말고 하던 대답을 그대로 마친다."
    )


def emit(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False))
    sys.stdout.flush()


def on_session_start(data):
    sid = data.get("session_id")
    st = load(state_path(sid), None)
    if st is None:
        save(state_path(sid), {"last_logged": 0, "pending": []})
    carry = load(CARRY_FILE, [])
    lines = [
        "[AI 작업 일지] 목사님의 모든 AI 작업은 구글 문서 'AI 작업 일지'에 함께 기록된다.",
        f"문서: {DOC_URL}",
        "작업을 시작하기 전에 Google Drive read_file_content 로 이 문서를 읽고, "
        f"'{MARKER}' 아래 최근 글 10개 정도로 지금 흐름(다른 AI가 하던 일, 넘겨받을 일)을 파악한다. "
        "목사님께 읽었다고 따로 보고하지 않는다. 지금 작업과 이어지는 글이 있을 때만 한 줄로 짚는다.",
        "기록은 5분마다 자동 알림이 오면 그때 쓴다. 목사님이 '일지 써' 하시면 바로 쓴다.",
    ]
    if carry:
        joined = "\n".join(f"- [{c.get('t', '')}] {c.get('text', '')}" for c in carry[-MAX_PENDING:])
        lines.append("지난 클로드 코드 세션에서 일지에 못 남긴 지시가 있다. 첫 기록 때 함께 한 글로 남긴다:\n" + joined)
        st = load(state_path(sid), {"last_logged": 0, "pending": []})
        st["pending"] = (carry + st.get("pending", []))[-MAX_PENDING:]
        save(state_path(sid), st)
        try:
            os.remove(CARRY_FILE)
        except OSError:
            pass
    emit({"hookSpecificOutput": {"hookEventName": "SessionStart", "additionalContext": "\n".join(lines)}})


def on_prompt(data):
    text = (data.get("prompt") or "").strip()
    if not text:
        return
    sid = data.get("session_id")
    st = load(state_path(sid), {"last_logged": 0, "pending": []})
    one_line = " ".join(text.split())
    if len(one_line) > MAX_PROMPT:
        one_line = one_line[:MAX_PROMPT] + "…"
    st.setdefault("pending", []).append({"t": now_kst(), "text": one_line})
    st["pending"] = st["pending"][-MAX_PENDING:]
    save(state_path(sid), st)


def on_stop(data):
    if data.get("stop_hook_active"):
        return  # 일지를 쓰느라 이어진 차례에서는 다시 막지 않는다
    sid = data.get("session_id")
    st = load(state_path(sid), {"last_logged": 0, "pending": []})
    pending = st.get("pending", [])
    if not pending:
        return
    now = time.time()
    if st.get("last_logged", 0) and now - st["last_logged"] < INTERVAL:
        return
    st["last_logged"] = now
    st["pending"] = []
    save(state_path(sid), st)
    asked = "\n".join(f"- [{p['t']}] {p['text']}" for p in pending)
    reason = (
        "[AI 작업 일지] 기록할 때가 되었다(마지막 기록 뒤 5분 이상, 또는 이 세션의 첫 기록). "
        "지금까지의 작업을 'AI 작업 일지'에 한 글로 남긴다. 지난 기록 뒤 목사님 지시는 다음과 같다:\n"
        f"{asked}\n" + how_to_write(data.get("cwd"))
    )
    emit({"decision": "block", "reason": reason})


def on_session_end(data):
    sid = data.get("session_id")
    st = load(state_path(sid), None)
    if not st:
        return
    pending = st.get("pending", [])
    if pending:
        carry = load(CARRY_FILE, [])
        save(CARRY_FILE, (carry + pending)[-MAX_PENDING:])
    try:
        os.remove(state_path(sid))
    except OSError:
        pass


HANDLERS = {
    "SessionStart": on_session_start,
    "UserPromptSubmit": on_prompt,
    "Stop": on_stop,
    "SessionEnd": on_session_end,
}


def main():
    if os.environ.get("AI_JOURNAL_OFF") == "1":
        return
    try:
        data = json.load(sys.stdin)
    except Exception:
        return
    handler = HANDLERS.get(data.get("hook_event_name"))
    if handler:
        try:
            handler(data)
        except Exception as e:  # 기록 장치 문제로 작업이 멈추면 안 된다
            sys.stderr.write(f"ai_journal: {e}\n")


if __name__ == "__main__":
    main()
