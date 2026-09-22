#!/bin/zsh
# Deploy the Access-protected build of IOL Cards (worker: iolcards-secure).
# Leaves the open "ioltester" worker and GitHub Pages site untouched.
set -e
cd "$(dirname "$0")"

OUT=.deploy-public
rm -rf "$OUT"
mkdir -p "$OUT"

# Allowlist: only what the browser needs. Nothing else gets published.
cp index.html app.js style.css admin.html "$OUT/"
cp iol-logo-dark.png iol-logo-white.png "iol leisure logo.png" "$OUT/"

echo "Publishing:"
( cd "$OUT" && find . -type f | sort )

npx wrangler deploy --config wrangler.secure.toml
