#!/usr/bin/env python3
"""
Zero-dependency client hook for cf-mem shared personal preference memory.
Supports Claude, Codex, Droid, and Whisper clients.
"""

from __future__ import annotations

import argparse
import fcntl
import hashlib
import json
import os
import re
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any
from urllib.parse import urlencode

_DEFAULT_CONFIG_PATH = Path.home() / ".config" / "cf-mem" / "config.json"
_FALLBACK_CONFIG_PATH = Path.home() / ".config" / "whisper-profile-memory" / "config.json"
_MAX_CAPTURE_CHARS = 8000
_MAX_CONTEXT_CLAIMS = 12
_MAX_CONTEXT_CHARS = 3000
_DEFAULT_TIMEOUT = 10.0
_USER_AGENT = "cf-mem-hook/1.0"
_SUPPORTED_SOURCE_APPS = ("claude", "codex", "droid", "whisper")
_STATE_PATH = Path.home() / ".local" / "state" / "cf-mem" / "hook-state.json"
_STATE_MAX_AGE_SECONDS = 7 * 24 * 60 * 60
_STATE_MAX_SESSIONS = 512
_REFRESH_TURN_THRESHOLD = 32
_REFRESH_TOKEN_THRESHOLD = 256_000
_DEFAULT_PROJECT_ID = "personal"
_MIN_ASSISTANT_CAPTURE_CHARS = 80
_TRANSCRIPT_TAIL_BYTES = 512_000
# Anything under a temp root disappears on reboot, so the whole subtree is
# disqualified. Both the symlinked and resolved macOS spellings are listed:
# /var -> /private/var means a bare "/var/tmp" never matches a resolved path.
def _temp_roots() -> frozenset[Path]:
    roots = {
        Path("/tmp"), Path("/var/tmp"),
        Path("/private/tmp"), Path("/private/var/tmp"),
        # macOS per-user temp: $TMPDIR is /var/folders/<..>/T/<..>, which
        # resolves under /private/var/folders and matches none of the above.
        Path("/var/folders"), Path("/private/var/folders"),
    }
    try:
        roots.add(Path(tempfile.gettempdir()).resolve())
    except Exception:
        pass
    return frozenset(roots)


_TEMP_ROOTS = _temp_roots()
# Matched exactly only. "/" is every path's ancestor and $HOME is where real
# projects live, so testing either by ancestry would disqualify everything.
_NON_PROJECT_EXACT = frozenset({Path("/")})


def _resolve_config_path(raw_path: str | None = None) -> Path:
    if raw_path and raw_path.strip():
        return Path(raw_path).expanduser().resolve()
    env_path = os.getenv("CF_RAG_CONFIG") or os.getenv("WHISPER_PROFILE_MEMORY_CONFIG")
    if env_path and env_path.strip():
        return Path(env_path).expanduser().resolve()
    if _DEFAULT_CONFIG_PATH.exists():
        return _DEFAULT_CONFIG_PATH
    if _FALLBACK_CONFIG_PATH.exists():
        return _FALLBACK_CONFIG_PATH
    return _DEFAULT_CONFIG_PATH


def _load_config(raw_path: str | None = None) -> dict[str, str]:
    path = _resolve_config_path(raw_path)
    if not path.exists():
        raise RuntimeError(f"Config file missing: {path}")
    with open(path, "r", encoding="utf-8") as f:
        data = json.load(f)
    if not isinstance(data, dict):
        raise RuntimeError("Config file must be a JSON object")
    base_url = str(data.get("base_url") or "").strip().rstrip("/")
    token = str(data.get("token") or "").strip()
    owner_id = str(data.get("owner_id") or "").strip()
    project_id = str(data.get("project_id") or "").strip()
    if not base_url or not token or not owner_id:
        raise RuntimeError("Config requires base_url, token, and owner_id")
    if not base_url.endswith("/memory"):
        base_url = f"{base_url}/memory"
    return {"base_url": base_url, "token": token, "owner_id": owner_id, "project_id": project_id}


def _resolve_project_id(config: dict[str, str]) -> str:
    project_id = config.get("project_id", "").strip()
    if project_id:
        return project_id
    return os.getenv("CF_MEM_PROJECT_ID", "").strip() or _DEFAULT_PROJECT_ID


def _resolve_workspace_info(value: str | None) -> tuple[str, str] | None:
    try:
        current = Path(value).expanduser().resolve() if value and value.strip() else Path.cwd().resolve()
        root = None
        for candidate in (current, *current.parents):
            if (
                (candidate / ".git").exists()
                or (candidate / "pyproject.toml").is_file()
                or (candidate / "package.json").is_file()
            ):
                root = candidate
                break
        if root is None:
            # No repo marker: the directory itself is still the project
            # identity, so facts stated there stay attributable.
            root = current
        # $HOME and the temp roots are not projects even when they happen to
        # contain a marker (a stray /tmp/.git is enough). Claiming otherwise is
        # worse than having no workspace at all: defaultClaimApplicability turns
        # any truthy workspace_id into workspace scope, which would pin a
        # globally-intended rule to that directory forever.
        if root in _NON_PROJECT_EXACT or root == Path.home().resolve():
            return None
        if any(root == r or r in root.parents for r in _TEMP_ROOTS):
            return None
        project_name = root.name
        digest = hashlib.sha256(str(root).encode("utf-8")).hexdigest()[:16]
        return f"ws_{project_name}_{digest}", project_name
    except Exception:
        return None


def _read_stdin_payload() -> dict[str, Any]:
    try:
        raw = sys.stdin.read()
        if not raw.strip():
            return {}
        data = json.loads(raw)
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def _extract_prompt(payload: dict[str, Any]) -> str:
    for key in ("prompt", "message", "user_prompt", "text"):
        val = payload.get(key)
        if isinstance(val, str) and val.strip():
            return val.strip()
    return ""


def _extract_session_id(payload: dict[str, Any], source_app: str) -> str:
    prefix = f"{source_app}:"
    for key in ("session_id", "thread_id", "conversation_id"):
        val = payload.get(key)
        if isinstance(val, str) and val.strip():
            session_id = val.strip()
            while session_id.casefold().startswith(prefix.casefold()):
                session_id = session_id[len(prefix):].strip()
            if session_id:
                return session_id[:256]
    return "unknown"


def _extract_event_id(payload: dict[str, Any]) -> str | None:
    for key in ("message_id", "turn_id", "event_id"):
        val = payload.get(key)
        if isinstance(val, str) and val.strip():
            return val.strip()[:128]
    return None


def _extract_workspace_info(payload: dict[str, Any]) -> tuple[str, str] | None:
    path = payload.get("workspace_root") or payload.get("cwd")
    return _resolve_workspace_info(str(path) if path else None)


def _state_key(payload: dict[str, Any], source_app: str, workspace_info: tuple[str, str] | None) -> str:
    session_id = _extract_session_id(payload, source_app)
    workspace_id = workspace_info[0] if workspace_info else ""
    return hashlib.sha256(f"{source_app}\n{session_id}\n{workspace_id}".encode("utf-8")).hexdigest()


def _read_state(handle: Any) -> dict[str, Any]:
    handle.seek(0)
    try:
        state = json.load(handle)
    except Exception:
        state = {}
    if not isinstance(state, dict):
        state = {}
    sessions = state.get("sessions")
    if not isinstance(sessions, dict):
        sessions = {}
    state["version"] = 1
    state["sessions"] = sessions
    return state


def _write_state(handle: Any, state: dict[str, Any]) -> None:
    handle.seek(0)
    handle.truncate()
    json.dump(state, handle, ensure_ascii=False)
    handle.write("\n")
    handle.flush()
    os.fsync(handle.fileno())


def _with_state_lock(callback: Any) -> Any:
    _STATE_PATH.parent.mkdir(parents=True, exist_ok=True)
    with open(_STATE_PATH, "a+", encoding="utf-8") as handle:
        os.chmod(_STATE_PATH, 0o600)
        fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
        try:
            state = _read_state(handle)
            result = callback(state)
            _write_state(handle, state)
            return result
        finally:
            fcntl.flock(handle.fileno(), fcntl.LOCK_UN)


def _prune_sessions(sessions: dict[str, Any], now: int) -> None:
    stale_keys = [
        key
        for key, value in sessions.items()
        if not isinstance(value, dict)
        or not isinstance(value.get("updated_at"), int)
        or now - value["updated_at"] > _STATE_MAX_AGE_SECONDS
    ]
    for key in stale_keys:
        sessions.pop(key, None)
    if len(sessions) <= _STATE_MAX_SESSIONS:
        return
    ordered = sorted(
        sessions.items(),
        key=lambda item: item[1].get("updated_at", 0) if isinstance(item[1], dict) else 0,
        reverse=True,
    )
    for key, _ in ordered[_STATE_MAX_SESSIONS:]:
        sessions.pop(key, None)


def _estimate_prompt_tokens(prompt: str) -> int:
    # This hook intentionally has no tokenizer dependency; four characters is
    # a conservative approximation for the refresh floor.
    return max(1, (len(prompt) + 3) // 4)


def _record_prompt(payload: dict[str, Any], source_app: str, workspace_info: tuple[str, str] | None, prompt: str) -> bool:
    key = _state_key(payload, source_app, workspace_info)
    now = int(time.time())
    prompt_tokens = _estimate_prompt_tokens(prompt)

    def update(state: dict[str, Any]) -> bool:
        sessions = state["sessions"]
        _prune_sessions(sessions, now)
        current = sessions.get(key)
        if not isinstance(current, dict):
            current = {"turn_count": 0, "accumulated_tokens": 0}
        turn_count = current.get("turn_count", 0)
        accumulated_tokens = current.get("accumulated_tokens", 0)
        refresh_pending = current.get("refresh_pending", False)
        if not isinstance(turn_count, int) or turn_count < 0:
            turn_count = 0
        if not isinstance(accumulated_tokens, int) or accumulated_tokens < 0:
            accumulated_tokens = 0
        if not isinstance(refresh_pending, bool):
            refresh_pending = False
        turn_count += 1
        accumulated_tokens += prompt_tokens
        should_refresh = refresh_pending or (
            turn_count >= _REFRESH_TURN_THRESHOLD
            or accumulated_tokens >= _REFRESH_TOKEN_THRESHOLD
        )
        sessions[key] = {
            "turn_count": turn_count,
            "accumulated_tokens": accumulated_tokens,
            "refresh_pending": should_refresh,
            "updated_at": now,
        }
        return should_refresh

    return bool(_with_state_lock(update))


def _reset_prompt_counter(payload: dict[str, Any], source_app: str, workspace_info: tuple[str, str] | None) -> None:
    key = _state_key(payload, source_app, workspace_info)
    now = int(time.time())

    def update(state: dict[str, Any]) -> None:
        sessions = state["sessions"]
        _prune_sessions(sessions, now)
        sessions[key] = {"turn_count": 0, "accumulated_tokens": 0, "refresh_pending": False, "updated_at": now}

    _with_state_lock(update)


def _context_response(
    response: dict[str, Any],
    hook_event_name: str,
) -> None:
    claims = response.get("claims", [])
    if not isinstance(claims, list) or not claims:
        return

    lines: list[str] = []
    length = 0
    for claim in claims[:_MAX_CONTEXT_CLAIMS]:
        if not isinstance(claim, dict):
            continue
        text = " ".join(str(claim.get("canonical_text") or "").split())
        if not text:
            continue
        line = f"- {text}"
        if length + len(line) + 1 > _MAX_CONTEXT_CHARS:
            break
        lines.append(line)
        length += len(line) + 1

    if not lines:
        return
    context_text = "<system-reminder>\nShared memory rules and user profile:\n" + "\n".join(lines) + "\n</system-reminder>"
    output = {
        "hookSpecificOutput": {
            "hookEventName": hook_event_name,
            "additionalContext": context_text,
        },
        "suppressOutput": True,
    }
    print(json.dumps(output, ensure_ascii=False))


def _request_context(
    config: dict[str, str],
    workspace_info: tuple[str, str] | None,
) -> dict[str, Any]:
    params: dict[str, str] = {
        "user_id": config["owner_id"],
        "categories": "rule,user_profile",
        "limit": str(_MAX_CONTEXT_CLAIMS),
    }
    if workspace_info:
        params["workspace_id"] = workspace_info[0]
    query = urlencode(params)
    project_id = _resolve_project_id(config)
    return _http_get(f"{config['base_url']}/context?{query}", config["token"], project_id)


def _http_get(url: str, token: str, project_id: str = "", timeout: float = _DEFAULT_TIMEOUT) -> dict[str, Any]:
    req = urllib.request.Request(
        url,
        headers={
            "Authorization": f"Bearer {token}",
            **({"X-Project-Id": project_id} if project_id else {}),
            "User-Agent": _USER_AGENT,
        },
        method="GET",
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        content = resp.read().decode("utf-8")
        if content.strip():
            try:
                return json.loads(content)
            except Exception:
                return {}
        return {}


def _http_post(url: str, token: str, body: dict[str, Any], project_id: str = "", timeout: float = _DEFAULT_TIMEOUT) -> dict[str, Any]:
    req = urllib.request.Request(
        url,
        data=json.dumps(body, ensure_ascii=False).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {token}",
            **({"X-Project-Id": project_id} if project_id else {}),
            "User-Agent": _USER_AGENT,
        },
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        content = resp.read().decode("utf-8")
        if content.strip():
            try:
                return json.loads(content)
            except Exception:
                return {}
        return {}


def handle_capture(source_app: str, config_path: str | None = None) -> int:
    try:
        payload = _read_stdin_payload()
        prompt = _extract_prompt(payload)
        if not prompt:
            return 0

        normalized = " ".join(prompt.split())[:_MAX_CAPTURE_CHARS].strip()
        if not normalized:
            return 0

        workspace_info = _extract_workspace_info(payload)
        # Count the prompt before contacting cf-mem. A temporary ingest failure
        # must not erase the local refresh obligation for this conversation.
        should_refresh = _record_prompt(payload, source_app, workspace_info, normalized)

        config = _load_config(config_path)
        body: dict[str, Any] = {
            "text": normalized,
            "source_app": source_app,
            "external_session_id": _extract_session_id(payload, source_app),
        }
        event_id = _extract_event_id(payload)
        if event_id:
            body["event_id"] = event_id
        if workspace_info:
            body["workspace_id"], body["workspace_name"] = workspace_info

        ingest_succeeded = False
        try:
            project_id = _resolve_project_id(config)
            _http_post(f"{config['base_url']}/profile/ingest", config["token"], body, project_id)
            ingest_succeeded = True
        except Exception:
            if not should_refresh:
                return 0
        if should_refresh:
            try:
                _context_response(
                    _request_context(config, workspace_info),
                    "UserPromptSubmit",
                )
                if ingest_succeeded:
                    _reset_prompt_counter(payload, source_app, workspace_info)
            except Exception:
                # Keep refresh_pending set so the next prompt retries the refresh.
                pass
    except Exception:
        # Silent fail: never block prompt execution on hook error
        pass
    return 0


_SECRET_RE = re.compile(
    r"(?:sk-[A-Za-z0-9_-]{16,}"
    r"|gh[pousr]_[A-Za-z0-9]{16,}"
    r"|AKIA[0-9A-Z]{16}"
    r"|xox[abprs]-[A-Za-z0-9-]{10,}"
    r"|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})"
)
_SECRET_ASSIGN_RE = re.compile(
    r"(?i)\b(api[_-]?key|secret|token|password|passwd|bearer)\b\s*[:=]\s*[\"']?([A-Za-z0-9_\-\.]{12,})[\"']?"
)


def _redact_secrets(text: str) -> str:
    """Assistant replies quote configs and logs, so scrub credentials before upload."""
    redacted = _SECRET_RE.sub("[REDACTED]", text)
    return _SECRET_ASSIGN_RE.sub(lambda m: f"{m.group(1)}=[REDACTED]", redacted)


def _text_from_content(content: Any) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for block in content:
            if isinstance(block, dict) and block.get("type") == "text":
                value = block.get("text")
                if isinstance(value, str) and value.strip():
                    parts.append(value)
        return "\n".join(parts)
    return ""


def _assistant_text_from_transcript(path_value: Any) -> str:
    if not isinstance(path_value, str) or not path_value.strip():
        return ""
    try:
        path = Path(path_value).expanduser()
        if not path.is_file():
            return ""
        size = path.stat().st_size
        with open(path, "rb") as f:
            if size > _TRANSCRIPT_TAIL_BYTES:
                f.seek(size - _TRANSCRIPT_TAIL_BYTES)
                f.readline()  # discard the partial line the seek landed in
            raw_lines = f.read().decode("utf-8", errors="replace").splitlines()
    except Exception:
        return ""
    # Walk backwards: the final assistant turn is the conclusion worth keeping.
    for raw in reversed(raw_lines):
        raw = raw.strip()
        if not raw:
            continue
        try:
            event = json.loads(raw)
        except Exception:
            continue
        if not isinstance(event, dict):
            continue
        message = event.get("message")
        if event.get("type") == "assistant" and isinstance(message, dict):
            text = _text_from_content(message.get("content"))
            if text.strip():
                return text
    return ""


def _extract_assistant_text(payload: dict[str, Any]) -> str:
    for key in ("assistant_response", "last_assistant_message", "assistant_message"):
        val = payload.get(key)
        if isinstance(val, str) and val.strip():
            return val
        if isinstance(val, dict):
            text = _text_from_content(val.get("content"))
            if text.strip():
                return text
    return _assistant_text_from_transcript(payload.get("transcript_path"))


def handle_assistant_capture(source_app: str, config_path: str | None = None) -> int:
    """Report the assistant's final turn so project facts can be extracted from it."""
    try:
        payload = _read_stdin_payload()
        raw_text = _extract_assistant_text(payload)
        if not raw_text.strip():
            return 0

        normalized = " ".join(_redact_secrets(raw_text).split())[:_MAX_CAPTURE_CHARS].strip()
        # Short acknowledgements carry no durable fact and would only add noise.
        if len(normalized) < _MIN_ASSISTANT_CAPTURE_CHARS:
            return 0

        config = _load_config(config_path)
        workspace_info = _extract_workspace_info(payload)
        body: dict[str, Any] = {
            "text": normalized,
            "role": "assistant",
            "source_app": source_app,
            "external_session_id": _extract_session_id(payload, source_app),
        }
        event_id = _extract_event_id(payload)
        if event_id:
            body["event_id"] = event_id
        if workspace_info:
            body["workspace_id"], body["workspace_name"] = workspace_info

        _http_post(f"{config['base_url']}/profile/ingest", config["token"], body, _resolve_project_id(config))
    except Exception:
        # Silent fail: never block the end of a turn on hook error.
        pass
    return 0


def handle_context(source_app: str, config_path: str | None = None) -> int:
    try:
        payload = _read_stdin_payload()
        config = _load_config(config_path)
        workspace_info = _extract_workspace_info(payload)

        res = _request_context(config, workspace_info)
        _reset_prompt_counter(payload, source_app, workspace_info)
        _context_response(res, "SessionStart")
    except Exception:
        # Silent fail: never block session startup on hook error
        pass
    return 0


def main() -> None:
    parser = argparse.ArgumentParser(description="cf-mem memory hook CLI")
    parser.add_argument("--config", help="Path to config file")
    subparsers = parser.add_subparsers(dest="command", required=True)

    capture_parser = subparsers.add_parser("hook-capture", aliases=["capture"])
    capture_parser.add_argument(
        "--source-app",
        default="codex",
        choices=_SUPPORTED_SOURCE_APPS,
        help="Source app identifier",
    )

    context_parser = subparsers.add_parser("hook-context", aliases=["context"])
    context_parser.add_argument(
        "--source-app",
        default="codex",
        choices=_SUPPORTED_SOURCE_APPS,
        help="Source app identifier",
    )

    assistant_parser = subparsers.add_parser("hook-assistant", aliases=["assistant"])
    assistant_parser.add_argument(
        "--source-app",
        default="codex",
        choices=_SUPPORTED_SOURCE_APPS,
        help="Source app identifier",
    )

    args = parser.parse_args()
    if args.command in ("hook-assistant", "assistant"):
        sys.exit(handle_assistant_capture(args.source_app, args.config))
    elif args.command in ("hook-capture", "capture"):
        sys.exit(handle_capture(args.source_app, args.config))
    elif args.command in ("hook-context", "context"):
        sys.exit(handle_context(args.source_app, args.config))
    else:
        sys.exit(0)


if __name__ == "__main__":
    main()
