#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOOK_TEMPLATE="${SCRIPT_DIR}/cf_mem_hook.py"

CONFIG_DIR="${HOME}/.config/cf-mem"
CONFIG_FILE="${CONFIG_DIR}/config.json"
LEGACY_CONFIG_FILE="${HOME}/.config/whisper-profile-memory/config.json"

TARGET_CLI=""
OPT_BASE_URL=""
OPT_TOKEN=""
OPT_OWNER_ID=""

usage() {
  cat <<'EOF'
Usage:
  ./scripts/install-hooks.sh --cli <codex|droid|claude|all> [options]

Options:
  --cli <name>        Target CLI to install hooks for (codex, droid, claude, all)
  --base-url <url>    Base URL of cf-mem service (e.g. https://mem.zhougao.win/memory)
  --token <token>     Bearer token for cf-mem authentication
  --owner-id <id>     Owner/user identifier
  -h, --help          Show this help message

Examples:
  ./scripts/install-hooks.sh --cli codex
  ./scripts/install-hooks.sh --cli droid
  ./scripts/install-hooks.sh --cli claude
  ./scripts/install-hooks.sh --cli all
EOF
  exit "${1:-1}"
}

# Parse command line arguments
while [[ $# -gt 0 ]]; do
  case "$1" in
    --cli)
      TARGET_CLI="${2:-}"
      shift 2
      ;;
    --base-url)
      OPT_BASE_URL="${2:-}"
      shift 2
      ;;
    --token)
      OPT_TOKEN="${2:-}"
      shift 2
      ;;
    --owner-id)
      OPT_OWNER_ID="${2:-}"
      shift 2
      ;;
    -h|--help)
      usage 0
      ;;
    *)
      echo "Error: Unknown argument '$1'" >&2
      usage 1
      ;;
  esac
done

if [[ -z "$TARGET_CLI" ]]; then
  echo "Error: Missing required argument --cli <codex|droid|claude|all>" >&2
  usage
fi

if [[ ! -f "$HOOK_TEMPLATE" ]]; then
  echo "Error: Hook template not found at $HOOK_TEMPLATE" >&2
  exit 1
fi

# Ensure config file exists
ensure_config() {
  if [[ -f "$CONFIG_FILE" ]]; then
    return 0
  fi

  mkdir -p "$CONFIG_DIR"
  if [[ -n "$OPT_BASE_URL" && -n "$OPT_TOKEN" && -n "$OPT_OWNER_ID" ]]; then
    python3 - <<PY
import json
data = {
    "base_url": "${OPT_BASE_URL}",
    "token": "${OPT_TOKEN}",
    "owner_id": "${OPT_OWNER_ID}"
}
with open("${CONFIG_FILE}", "w", encoding="utf-8") as f:
    json.dump(data, f, indent=2)
    f.write("\n")
PY
    chmod 600 "$CONFIG_FILE"
    echo "✓ Created config at $CONFIG_FILE"
  elif [[ -f "$LEGACY_CONFIG_FILE" ]]; then
    cp -a "$LEGACY_CONFIG_FILE" "$CONFIG_FILE"
    chmod 600 "$CONFIG_FILE"
    echo "✓ Migrated config from $LEGACY_CONFIG_FILE -> $CONFIG_FILE"
  elif [[ -f "${SCRIPT_DIR}/config.example.json" ]]; then
    echo "Error: Config file not found at $CONFIG_FILE." >&2
    echo "Please create it by copying ${SCRIPT_DIR}/config.example.json:" >&2
    echo "  mkdir -p ~/.config/cf-mem" >&2
    echo "  cp ${SCRIPT_DIR}/config.example.json ~/.config/cf-mem/config.json" >&2
    echo "Or pass --base-url, --token, and --owner-id to this script." >&2
    exit 1
  else
    echo "Error: Config file not found at $CONFIG_FILE and no --base-url / --token / --owner-id provided." >&2
    exit 1
  fi
}

install_codex() {
  local target_dir="${HOME}/.codex/hooks"
  local target_script="${target_dir}/cf_mem_hook.py"
  local config_path="${HOME}/.codex/hooks.json"

  mkdir -p "$target_dir"
  cp -a "$HOOK_TEMPLATE" "$target_script"
  chmod 755 "$target_script"

  python3 - "$config_path" "$target_script" <<'PY'
import json, sys, os
from pathlib import Path

path = Path(sys.argv[1])
script = sys.argv[2]

data = {}
if path.exists():
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
    except Exception:
        data = {}

if not isinstance(data, dict):
    data = {}

hooks = data.setdefault("hooks", {})
if not isinstance(hooks, dict):
    hooks = {}
    data["hooks"] = hooks

def filter_hooks(groups):
    if not isinstance(groups, list):
        return []
    res = []
    for g in groups:
        if not isinstance(g, dict):
            continue
        sub = g.get("hooks", [])
        if not isinstance(sub, list):
            continue
        cleaned = [
            h for h in sub
            if isinstance(h, dict) and "cf_mem_hook.py" not in str(h.get("command", "")) and "app.profile_memory.cli" not in str(h.get("command", ""))
        ]
        if cleaned:
            res.append({**g, "hooks": cleaned})
    return res

hooks["SessionStart"] = filter_hooks(hooks.get("SessionStart", []))
hooks["UserPromptSubmit"] = filter_hooks(hooks.get("UserPromptSubmit", []))

hooks["SessionStart"].append({
    "matcher": "startup|resume|clear|compact",
    "hooks": [
        {
            "type": "command",
            "command": f"python3 {script} hook-context --source-app codex",
            "timeout": 15,
            "additionalContextLimit": 3000
        }
    ]
})

hooks["UserPromptSubmit"].append({
    "hooks": [
        {
            "type": "command",
            "command": f"python3 {script} hook-capture --source-app codex",
            "timeout": 15
        }
    ]
})

path.parent.mkdir(parents=True, exist_ok=True)
with open(path, "w", encoding="utf-8") as f:
    json.dump(data, f, indent=2)
    f.write("\n")
os.chmod(path, 0o600)
PY

  echo "✓ Installed Codex hook -> $target_script and updated $config_path"
}

install_droid() {
  local target_dir="${HOME}/.factory/hooks"
  local target_script="${target_dir}/cf_mem_hook.py"
  local config_path="${HOME}/.factory/hooks.json"

  mkdir -p "$target_dir"
  cp -a "$HOOK_TEMPLATE" "$target_script"
  chmod 755 "$target_script"

  python3 - "$config_path" "$target_script" <<'PY'
import json, sys, os
from pathlib import Path

path = Path(sys.argv[1])
script = sys.argv[2]

data = {}
if path.exists():
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
    except Exception:
        data = {}

if not isinstance(data, dict):
    data = {}

def filter_hooks(groups):
    if not isinstance(groups, list):
        return []
    res = []
    for g in groups:
        if not isinstance(g, dict):
            continue
        sub = g.get("hooks", [])
        if not isinstance(sub, list):
            continue
        cleaned = [
            h for h in sub
            if isinstance(h, dict) and "cf_mem_hook.py" not in str(h.get("command", "")) and "app.profile_memory.cli" not in str(h.get("command", ""))
        ]
        if cleaned:
            res.append({**g, "hooks": cleaned})
    return res

data["SessionStart"] = filter_hooks(data.get("SessionStart", []))
data["UserPromptSubmit"] = filter_hooks(data.get("UserPromptSubmit", []))

data["SessionStart"].append({
    "matcher": "startup|resume|clear|compact",
    "hooks": [
        {
            "type": "command",
            "command": f"python3 {script} hook-context --source-app droid",
            "timeout": 15
        }
    ]
})

data["UserPromptSubmit"].append({
    "hooks": [
        {
            "type": "command",
            "command": f"python3 {script} hook-capture --source-app droid",
            "timeout": 15
        }
    ]
})

path.parent.mkdir(parents=True, exist_ok=True)
with open(path, "w", encoding="utf-8") as f:
    json.dump(data, f, indent=2)
    f.write("\n")
os.chmod(path, 0o600)
PY

  echo "✓ Installed Droid hook -> $target_script and updated $config_path"
}

install_claude() {
  local target_dir="${HOME}/.claude/hooks"
  local target_script="${target_dir}/cf_mem_hook.py"
  local config_path="${HOME}/.claude/settings.json"

  mkdir -p "$target_dir"
  cp -a "$HOOK_TEMPLATE" "$target_script"
  chmod 755 "$target_script"

  python3 - "$config_path" "$target_script" <<'PY'
import json, sys, os
from pathlib import Path

path = Path(sys.argv[1])
script = sys.argv[2]

data = {}
if path.exists():
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
    except Exception:
        data = {}

if not isinstance(data, dict):
    data = {}

hooks = data.setdefault("hooks", {})
if not isinstance(hooks, dict):
    hooks = {}
    data["hooks"] = hooks

def filter_hooks(groups):
    if not isinstance(groups, list):
        return []
    res = []
    for g in groups:
        if not isinstance(g, dict):
            continue
        sub = g.get("hooks", [])
        if not isinstance(sub, list):
            continue
        cleaned = [
            h for h in sub
            if isinstance(h, dict) and "cf_mem_hook.py" not in str(h.get("command", "")) and "app.profile_memory.cli" not in str(h.get("command", ""))
        ]
        if cleaned:
            res.append({**g, "hooks": cleaned})
    return res

hooks["SessionStart"] = filter_hooks(hooks.get("SessionStart", []))
hooks["UserPromptSubmit"] = filter_hooks(hooks.get("UserPromptSubmit", []))

hooks["SessionStart"].append({
    "matcher": "startup|resume|clear|compact|fork",
    "hooks": [
        {
            "type": "command",
            "command": f"python3 {script} hook-context --source-app claude",
            "timeout": 15
        }
    ]
})

hooks["UserPromptSubmit"].append({
    "hooks": [
        {
            "type": "command",
            "command": f"python3 {script} hook-capture --source-app claude",
            "timeout": 15,
            "async": True
        }
    ]
})

path.parent.mkdir(parents=True, exist_ok=True)
with open(path, "w", encoding="utf-8") as f:
    json.dump(data, f, indent=2)
    f.write("\n")
os.chmod(path, 0o600)
PY

  echo "✓ Installed Claude hook -> $target_script and updated $config_path"
}

ensure_config

case "$TARGET_CLI" in
  codex)
    install_codex
    ;;
  droid)
    install_droid
    ;;
  claude)
    install_claude
    ;;
  all)
    install_codex
    install_droid
    install_claude
    ;;
  *)
    echo "Error: Unknown CLI target '$TARGET_CLI'. Choose codex, droid, claude, or all." >&2
    exit 1
    ;;
esac

echo "Done! cf-mem hooks successfully installed for $TARGET_CLI."
