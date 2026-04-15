#!/usr/bin/env bash
# mcp-auth-check.sh — Claude Code MCP authentication health check
# Bundled with the Termicode extension. Copied to ~/.claude/scripts/ on activation.
# Generic: no hardcoded usernames, server names, or paths.

SETTINGS="$HOME/.claude/settings.json"
CACHE="$HOME/.claude/mcp-needs-auth-cache.json"
LOG_DIR="$HOME/.claude/logs"
LOG="$LOG_DIR/mcp-auth-check.log"
MODE="--mode=session-start"

for arg in "$@"; do
  case "$arg" in --mode=*) MODE="$arg" ;; esac
done

mkdir -p "$LOG_DIR"
log()  { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" >> "$LOG"; }
err()  { echo "[$(date '+%Y-%m-%d %H:%M:%S')] ERROR: $*" >> "$LOG"; errors+=("$*"); }

# Trap unexpected exits — capture line number and last command
script_errors=()
errors=()
trap 'script_errors+=("Unexpected exit at line $LINENO (last cmd: $BASH_COMMAND)")' ERR

# ── Output helpers ────────────────────────────────────────────────────────────

output_json() {
  local ctx="$1"
  local err_ctx=""

  if [[ "${#script_errors[@]}" -gt 0 ]] || [[ "${#errors[@]}" -gt 0 ]]; then
    all_errors=("${errors[@]+"${errors[@]}"}" "${script_errors[@]+"${script_errors[@]}"}")
    err_ctx=" Script errors (share with Claude Code for help): ${all_errors[*]} — Log: $LOG"
  fi

  jq -n --arg ctx "${ctx}${err_ctx}" \
    '{"hookSpecificOutput": {"hookEventName": "SessionStart", "additionalContext": $ctx}}'
}

notify_error() {
  local msg="$1"
  log "Notifying error: $msg"
  osascript 2>/dev/null <<APPLESCRIPT || true
set btn to button returned of (display dialog "$msg" & return & return & "Log: $LOG" buttons {"Dismiss", "Copy Log Path"} default button "Copy Log Path" with title "MCP Auth Check Error" with icon stop)
if btn = "Copy Log Path" then
  set the clipboard to "$LOG"
end if
APPLESCRIPT
}

# ── Require jq ────────────────────────────────────────────────────────────────

if ! command -v jq &>/dev/null; then
  err "jq not found — cannot parse MCP config"
  if [[ "$MODE" == "--mode=session-start" ]]; then
    output_json ""
  else
    notify_error "jq is required but not installed. Install it with: brew install jq"
  fi
  exit 0
fi

failed=()
needs_browser=()

# ── Phase 1: Local MCPs with token storage ────────────────────────────────────
# Any server with MCP_REMOTE_CONFIG_DIR in its env uses mcp-remote OAuth.
# Tokens are stored locally and can be refreshed silently.

if [[ -f "$SETTINGS" ]]; then
  while IFS= read -r server_name; do
    [[ -z "$server_name" ]] && continue

    token_dir=$(jq -r --arg s "$server_name" \
      '.mcpServers[$s].env.MCP_REMOTE_CONFIG_DIR // empty' \
      "$SETTINGS" 2>/dev/null) || { err "Failed to read settings for $server_name"; continue; }
    [[ -z "$token_dir" ]] && continue

    log "Checking local MCP: $server_name"

    # Find the first token file in the directory
    token_file=""
    for f in "$token_dir"/*_tokens.json; do
      [[ -f "$f" ]] && token_file="$f" && break
    done

    if [[ -z "$token_file" ]]; then
      log "  No token file found — needs auth"
      failed+=("$server_name")
      continue
    fi

    # Check expiry: file mtime is the token issuance time
    expires_in=$(jq -r '.expires_in // 3600' "$token_file" 2>/dev/null || echo 3600)
    mtime=$(stat -f %m "$token_file" 2>/dev/null) || { err "stat failed on $token_file"; failed+=("$server_name"); continue; }
    now=$(date +%s)
    expiry=$(( mtime + expires_in - 60 ))  # 60s safety buffer

    if [[ "$now" -lt "$expiry" ]]; then
      log "  Token valid (expires in $((expiry - now))s)"
      continue
    fi

    log "  Token expired — attempting silent refresh"

    refresh_token=$(jq -r '.refresh_token // empty' "$token_file" 2>/dev/null)
    if [[ -z "$refresh_token" ]]; then
      log "  No refresh token available"
      failed+=("$server_name")
      continue
    fi

    # Extract SSE URL from server args (first https:// argument)
    sse_url=$(jq -r --arg s "$server_name" \
      '.mcpServers[$s].args[] | select(startswith("https://"))' \
      "$SETTINGS" 2>/dev/null | head -1)
    if [[ -z "$sse_url" ]]; then
      err "$server_name: cannot find SSE URL in args"
      failed+=("$server_name")
      continue
    fi

    # Discover token endpoint via OAuth well-known metadata
    base_url="${sse_url%/sse}"
    base_url="${base_url%/}"
    well_known=$(curl -sf --max-time 10 \
      "$base_url/.well-known/oauth-authorization-server" 2>/dev/null || echo "")

    if [[ -z "$well_known" ]]; then
      err "$server_name: could not reach $base_url/.well-known/oauth-authorization-server"
      failed+=("$server_name")
      continue
    fi

    token_endpoint=$(echo "$well_known" | jq -r '.token_endpoint // empty' 2>/dev/null)
    if [[ -z "$token_endpoint" ]]; then
      err "$server_name: token_endpoint missing from well-known metadata"
      failed+=("$server_name")
      continue
    fi

    # Extract client_id from client_info file (same hash prefix as token file)
    hash_prefix="$(basename "$token_file" _tokens.json)"
    client_info="$token_dir/${hash_prefix}_client_info.json"
    client_id=""
    [[ -f "$client_info" ]] && \
      client_id=$(jq -r '.client_id // empty' "$client_info" 2>/dev/null)

    # Attempt the refresh
    response=$(curl -sf --max-time 10 \
      -X POST "$token_endpoint" \
      --data-urlencode "grant_type=refresh_token" \
      --data-urlencode "client_id=$client_id" \
      --data-urlencode "refresh_token=$refresh_token" \
      2>/dev/null || echo "")

    new_access_token=$(echo "$response" | jq -r '.access_token // empty' 2>/dev/null)
    if [[ -n "$new_access_token" ]]; then
      # Atomic write — mv updates mtime, resetting the expiry clock
      tmp="${token_file}.tmp"
      echo "$response" > "$tmp" && mv "$tmp" "$token_file"
      log "  Refreshed successfully"
    else
      err "$server_name: refresh POST failed (endpoint: $token_endpoint)"
      failed+=("$server_name")
    fi

  done < <(jq -r '.mcpServers | keys[]' "$SETTINGS" 2>/dev/null || true)
fi

# ── Phase 2: Check claude.ai MCP auth cache ───────────────────────────────────
# Claude Code writes to this file when a remote MCP requires re-auth.
# We flag entries newer than 6 hours (stale entries are ignored).

if [[ -f "$CACHE" ]]; then
  cutoff_ms=$(( $(date +%s) * 1000 - 21600000 ))
  while IFS= read -r server_name; do
    [[ -z "$server_name" ]] && continue
    needs_browser+=("$server_name")
    log "Cache: $server_name needs browser auth"
  done < <(jq -r --argjson cutoff "$cutoff_ms" \
    'to_entries | map(select(.value.timestamp > $cutoff)) | .[].key' \
    "$CACHE" 2>/dev/null || true)
fi

# ── Phase 3: Notify ───────────────────────────────────────────────────────────

all=(${failed[@]+"${failed[@]}"} ${needs_browser[@]+"${needs_browser[@]}"})

if [[ "${#all[@]}" -gt 0 ]]; then
  # Build display string: first 3 names, then "+ N more" if needed
  shown=("${all[@]:0:3}")
  list=$(printf '%s, ' "${shown[@]}")
  list="${list%, }"
  extra=$(( ${#all[@]} - ${#shown[@]} ))
  [[ "$extra" -gt 0 ]] && list="$list (+$extra more)"

  log "Notifying: $list"

  if [[ "$MODE" == "--mode=cron" ]]; then
    # Blocking dialog — user can open terminal for immediate fix
    osascript 2>/dev/null <<APPLESCRIPT || true
set serverList to "$list"
set btn to button returned of (display dialog "These MCP servers need re-authentication:" & return & return & serverList & return & return & "Open a terminal to fix them now?" buttons {"Later", "Open Terminal"} default button "Open Terminal" with title "MCP Auth Required" with icon caution)
if btn = "Open Terminal" then
  tell application "System Events"
    set isIterm to (name of processes) contains "iTerm2"
  end tell
  if isIterm then
    tell application "iTerm"
      activate
      create window with default profile
      tell current session of current window
        write text "claude /mcp"
      end tell
    end tell
  else
    tell application "Terminal"
      activate
      do script "claude /mcp"
    end tell
  end if
end if
APPLESCRIPT
  else
    # Non-blocking notification for session-start
    osascript -e "display notification \"$list\" with title \"MCP Auth Required\" subtitle \"Run /mcp to re-authenticate\" sound name \"Basso\"" 2>/dev/null || true
  fi
fi

# ── Phase 4: Write status file for Termicode UI ──────────────────────────────
# The extension reads this to show a warning bar with CTA.

STATUS="$HOME/.claude/mcp-auth-status.json"
all_json="[]"
if [[ "${#all[@]}" -gt 0 ]]; then
  all_json=$(printf '%s\n' "${all[@]}" | jq -R . | jq -s .)
fi
jq -n --argjson servers "$all_json" --argjson ts "$(date +%s)" \
  '{"timestamp": $ts, "needs_auth": $servers}' > "${STATUS}.tmp" && mv "${STATUS}.tmp" "$STATUS"

# ── Phase 5: JSON output for Claude context (session-start only) ──────────────

if [[ "$MODE" == "--mode=session-start" ]]; then
  if [[ "${#all[@]}" -gt 0 ]]; then
    output_json "MCP WARNING: The following servers need re-authentication and may not work: ${all[*]}. Inform the user and suggest running /mcp to fix it."
  else
    output_json ""
  fi
fi
