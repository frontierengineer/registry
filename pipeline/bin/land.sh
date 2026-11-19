#!/usr/bin/env bash
# Lands a verdict on the Registry's default branch in one commit, from a
# checkout whose `origin` is the Registry and which has fetched the pull
# request's head:
#
#   listed, unpublished   the pull request merged (its one listing file) and
#                         the generated files written beside it; GitHub marks
#                         the pull request merged when its head reaches main
#   rejected              only checks/<hash>.json, when the listing named a
#                         commit, so the publisher's Frontier can read why
#
# The Release's time is stamped once, now. Two landings that race both start
# again from the newest main, so neither is lost and neither is serialized
# behind a queue that could drop one.
#
#   land.sh <verdict file> <pull request number> <head commit> [branch]
set -euo pipefail

VERDICT="$(realpath "$1")"
NUMBER="$2"
HEAD_COMMIT="$3"
BRANCH="${4:-main}"
PIPELINE="$(cd "$(dirname "$0")/.." && pwd)"
AT="$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"
ATTEMPTS=5

outcome="$(node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).outcome)' "$VERDICT")"
id="$(node -e 'process.stdout.write(String(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).id ?? ""))' "$VERDICT")"
commit="$(node -e 'process.stdout.write(String(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).commit ?? ""))' "$VERDICT")"

case "$outcome" in
  listed) message="List ${id} at ${commit} (#${NUMBER})" ;;
  unpublished) message="Unpublish ${id} (#${NUMBER})" ;;
  rejected) message="Record why ${commit:-the listing} was not listed (#${NUMBER})" ;;
  *) echo "nothing lands for a verdict of ${outcome}"; exit 0 ;;
esac

for attempt in $(seq 1 "$ATTEMPTS"); do
  git fetch --quiet origin "$BRANCH"
  git reset --quiet --hard "origin/${BRANCH}"
  if [ "$outcome" != rejected ]; then
    if ! git merge --quiet --no-ff --no-commit "$HEAD_COMMIT" >/dev/null 2>&1; then
      git merge --abort || true
      echo "the listing conflicts with ${BRANCH}: another listing of ${id} landed since this pull request was opened" >&2
      exit 3
    fi
  fi
  node "$PIPELINE/bin/record.mjs" --root . --verdict "$VERDICT" --at "$AT"
  git add -A -- index.json applications checks listings
  if git diff --cached --quiet && [ "$outcome" = rejected ]; then
    echo "nothing new to record"
    exit 0
  fi
  git commit --quiet -m "$message"
  if git push --quiet origin "HEAD:${BRANCH}"; then
    git rev-parse HEAD
    exit 0
  fi
  echo "main moved while landing (attempt ${attempt} of ${ATTEMPTS}); starting again from it" >&2
done
echo "main kept moving; the verdict did not land after ${ATTEMPTS} attempts" >&2
exit 4
