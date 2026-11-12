#!/bin/bash
# Uso: lanzar.sh <nombre> <worktree>
P=/srv/LogiQD/llenamos/.claude/codex
exec codex exec -C /srv/LogiQD/llenamos/.claude/worktrees/$2 -m gpt-6.1-sol -c model_reasoning_effort='"high"' -s workspace-write -c sandbox_workspace_write.network_access=true --add-dir /srv/LogiQD/node_modules/.pnpm-store --add-dir /home/gery/.cache/firebase --add-dir /home/gery/.config/configstore --add-dir /srv/LogiQD/llenamos/.claude/pw -o $P/logs/$1.informe.md "$(cat $P/$1.txt; echo; cat $P/normas.txt)" </dev/null > $P/logs/$1.log 2>&1
