#!/usr/bin/env python3
"""
Zero-dependency client hook for cf-rag shared personal preference memory.
Supports Claude, Codex, Droid, and other AI coding assistants.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

_DEFAULT_CONFIG_PATH = Path.home() / ".config" / "cf-rag" / "config.json"
_FALLBACK_CONFIG_PATH = Path.home() / ".config" / "whisper-profile-memory" / "config.json"
_MAX_CAPTURE_CHARS = 8000
_MAX_CONTEXT_CLAIMS = 12
_MAX_CONTEXT_CHARS = 3000
_DEFAULT_TIMEOUT = 10.0
_USER_AGENT = "cf-rag-hook/1.0"


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
    if not base_url or not token or not owner_id:
        raise RuntimeError("Config requires base_url, token, and owner_id")
    if not base_url.endswith("/memory"):
        base_url = f"{base_url}/memory"
    return {"base_url": base_url, "token": token, "owner_id": owner_id}


def _workspace_id_for_path(value: str | None) -> str | None:
    if not value or not value.strip():
        value = os.getcwd()
    try:
        normalized = os.path.realpath(value).strip()
        if not normalized:
            return None
        return "ws_" + hashlib.sha256(normalized.encode("utf-8")).hexdigest()[:32]
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
    for key in ("session_id", "thread_id", "conversation_id"):
        val = payload.get(key)
        if isinstance(val, str) and val.strip():
            prefix = f"{source_app}:"
            return prefix + val.strip()[: 256 - len(prefix)]
    return f"{source_app}:unknown"


def _extract_event_id(payload: dict[str, Any]) -> str | None:
    for key in ("message_id", "turn_id", "event_id"):
        val = payload.get(key)
        if isinstance(val, str) and val.strip():
            return val.strip()[:128]
    return None


def _extract_workspace_id(payload: dict[str, Any]) -> str | None:
    path = payload.get("workspace_root") or payload.get("cwd")
    return _workspace_id_for_path(str(path) if path else None)


def _http_post(url: str, token: str, body: dict[str, Any], timeout: float = _DEFAULT_TIMEOUT) -> dict[str, Any]:
    req = urllib.request.Request(
        url,
        data=json.dumps(body, ensure_ascii=False).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {token}",
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

        config = _load_config(config_path)
        normalized = " ".join(prompt.split())[:_MAX_CAPTURE_CHARS].strip()
        if not normalized:
            return 0

        body: dict[str, Any] = {
            "text": normalized,
            "source_app": source_app,
            "external_session_id": _extract_session_id(payload, source_app),
        }
        event_id = _extract_event_id(payload)
        if event_id:
            body["event_id"] = event_id
        ws_id = _extract_workspace_id(payload)
        if ws_id:
            body["workspace_id"] = ws_id

        _http_post(f"{config['base_url']}/profile/ingest", config["token"], body)
    except Exception:
        # Silent fail: never block prompt execution on hook error
        pass
    return 0


def handle_context(source_app: str, config_path: str | None = None) -> int:
    try:
        payload = _read_stdin_payload()
        config = _load_config(config_path)
        ws_id = _extract_workspace_id(payload)

        body: dict[str, Any] = {
            "user_id": config["owner_id"],
            "profile_only": True,
            "limit": _MAX_CONTEXT_CLAIMS,
            "types": ["preference", "instruction", "decision", "profile", "task_state"],
        }
        if ws_id:
            body["workspace_id"] = ws_id

        res = _http_post(f"{config['base_url']}/context", config["token"], body)
        claims = res.get("claims", [])
        if not isinstance(claims, list) or not claims:
            return 0

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

        if lines:
            context_text = "Shared user preferences from other tools:\n" + "\n".join(lines)
            output = {
                "hookSpecificOutput": {
                    "hookEventName": "SessionStart",
                    "additionalContext": context_text,
                },
                "suppressOutput": True,
            }
            print(json.dumps(output, ensure_ascii=False))
    except Exception:
        # Silent fail: never block session startup on hook error
        pass
    return 0


def main() -> None:
    parser = argparse.ArgumentParser(description="cf-rag memory hook CLI")
    parser.add_argument("--config", help="Path to config file")
    subparsers = parser.add_subparsers(dest="command", required=True)

    capture_parser = subparsers.add_parser("hook-capture", aliases=["capture"])
    capture_parser.add_argument("--source-app", default="cli", help="Source app identifier (e.g. claude, codex, droid)")

    context_parser = subparsers.add_parser("hook-context", aliases=["context"])
    context_parser.add_argument("--source-app", default="cli", help="Source app identifier (e.g. claude, codex, droid)")

    args = parser.parse_args()
    if args.command in ("hook-capture", "capture"):
        sys.exit(handle_capture(args.source_app, args.config))
    elif args.command in ("hook-context", "context"):
        sys.exit(handle_context(args.source_app, args.config))
    else:
        sys.exit(0)


if __name__ == "__main__":
    main()
