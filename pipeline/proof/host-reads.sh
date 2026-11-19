#!/usr/bin/env bash
# Runs Frontier's own Registry reader against this repository's files, over
# file:// and over HTTP. Needs a Frontier checkout with its packages installed.
#
#   bash pipeline/proof/host-reads.sh <Frontier checkout>
set -euo pipefail
FRONTIER="$(cd "${1:?give the path to a Frontier checkout}" && pwd)"
HERE="$(cd "$(dirname "$0")" && pwd)"
cd "$FRONTIER"
FRONTIER="$FRONTIER" node --import tsx --test "$HERE/host-reads.test.ts"
