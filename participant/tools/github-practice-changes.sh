#!/usr/bin/env bash
# Changes made on GitHub between synchronization runs, for the quest github-read-assigned-issues.
# Tom runs this with Tom's own GitHub CLI login (it writes); the synchronization itself only
# reads. Each set is made once, after a preview and a typed "yes".
#
#   bash participant/tools/github-practice-changes.sh rehearsal   (made 11-23-2026)
#       close api #3 (completed), rename web #2, transfer api #2 to the web repository
#   bash participant/tools/github-practice-changes.sh final   (made 11-23-2026)
#       unassign web #2, close api #1 as not planned, transfer web #5 back to the api repository
#   bash participant/tools/github-practice-changes.sh last   (made 11-23-2026)
#       close web #1 as completed, assign web #2 to you again, transfer api #4 to the web repository
#   bash participant/tools/github-practice-changes.sh review
#       close web #6 as not planned (after the review: its record must show closed, the reason and
#       the time, with its notes kept)

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
  last)
    confirm "close $OWNER/$WEB #1 as completed" \
      "assign $OWNER/$WEB #2 to $OWNER again" \
      "transfer $OWNER/$API #4 to $OWNER/$WEB (it gets a new number there)"
    echo "1. Closing $WEB #1 as completed..."
    gh issue close 1 --repo "$OWNER/$WEB" --reason completed >/dev/null
    echo "2. Assigning $WEB #2 to $OWNER again..."
    gh issue edit 2 --repo "$OWNER/$WEB" --add-assignee "$OWNER" >/dev/null
    echo "3. Transferring $API #4 to $WEB..."
    NEW=$(gh issue transfer 4 "$OWNER/$WEB" --repo "$OWNER/$API")
    echo "   now: $NEW"
    echo "Done."
    ;;
  review)
    confirm "close $OWNER/$WEB #6 as not planned"
    echo "1. Closing $WEB #6 as not planned..."
    gh issue close 6 --repo "$OWNER/$WEB" --reason "not planned" >/dev/null
    echo "Done."
    ;;
  *)
    echo "Usage: bash participant/tools/github-practice-changes.sh rehearsal | final | last | review"
    exit 2
    ;;
esac
