#!/usr/bin/env bash
# Changes made on GitHub between synchronization runs, for the quest github-read-assigned-issues.
# Tom runs this with Tom's own GitHub CLI login (it writes); the synchronization itself only
# reads. Each set is made once, after a preview and a typed "yes".
#
#   bash participant/tools/github-practice-changes.sh rehearsal   (made 11-23-2026)
#       close api #3 (completed), rename web #2, transfer api #2 to the web repository
#   bash participant/tools/github-practice-changes.sh final
#       unassign web #2, close api #1 as not planned, transfer web #5 back to the api repository

set -euo pipefail

WEB=gtq-practice-kettlebook-web
API=gtq-practice-kettlebook-api
OWNER=$(gh api user --jq .login)

confirm() {
  echo "Signed in as: $OWNER. This set writes to GitHub:"
  printf '  %s\n' "$@"
  printf 'Type yes to make these changes: '
  read -r ANSWER
  [ "$ANSWER" = "yes" ] || { echo "Nothing was changed."; exit 1; }
}

case "${1:-}" in
  rehearsal)
    confirm "close $OWNER/$API #3 as completed, with a short comment" \
      "rename $OWNER/$WEB #2 to \"Add a print view for recipes and shopping lists\"" \
      "transfer $OWNER/$API #2 to $OWNER/$WEB"
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
  final)
    confirm "remove $OWNER as assignee of $OWNER/$WEB #2" \
      "close $OWNER/$API #1 as not planned" \
      "transfer $OWNER/$WEB #5 back to $OWNER/$API (it gets a new number there)"
    echo "1. Unassigning $WEB #2..."
    gh issue edit 2 --repo "$OWNER/$WEB" --remove-assignee "$OWNER" >/dev/null
    echo "2. Closing $API #1 as not planned..."
    gh issue close 1 --repo "$OWNER/$API" --reason "not planned" >/dev/null
    echo "3. Transferring $WEB #5 back to $API..."
    NEW=$(gh issue transfer 5 "$OWNER/$API" --repo "$OWNER/$WEB")
    echo "   now: $NEW"
    echo "Done."
    ;;
  *)
    echo "Usage: bash participant/tools/github-practice-changes.sh rehearsal | final"
    exit 2
    ;;
esac
