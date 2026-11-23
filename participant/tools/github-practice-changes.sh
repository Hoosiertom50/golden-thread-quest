#!/usr/bin/env bash
# Changes made on GitHub between synchronization runs, for the quest github-read-assigned-issues.
# Tom runs this himself with his own GitHub CLI login (it writes); the synchronization itself only
# reads. Each set is made once.
#
#   bash participant/tools/github-practice-changes.sh rehearsal
#       close api #3 (completed), rename web #2, transfer api #2 to the web repository
#   bash participant/tools/github-practice-changes.sh final
#       for the final recording, after the code is reviewed: a fresh set, written then

set -euo pipefail

WEB=gtq-practice-kettlebook-web
API=gtq-practice-kettlebook-api
OWNER=$(gh api user --jq .login)

case "${1:-}" in
  rehearsal)
    echo "Signed in as: $OWNER"
    echo "1. Closing $API #3 as completed..."
    gh issue close 3 --repo "$OWNER/$API" --reason completed \
      --comment "Practice change: closed between synchronization runs." >/dev/null
    echo "2. Renaming $WEB #2..."
    gh issue edit 2 --repo "$OWNER/$WEB" --title "Add a print view for recipes and shopping lists" >/dev/null
    echo "3. Transferring $API #2 to $WEB..."
    NEW=$(gh issue transfer 2 "$OWNER/$WEB" --repo "$OWNER/$API")
    echo "   now: $NEW"
    echo "Done."
    ;;
  *)
    echo "Usage: bash participant/tools/github-practice-changes.sh rehearsal"
    exit 2
    ;;
esac
