#!/usr/bin/env bash
# Checks the extension and packs it into dist/pr-files-tabs-<version>.zip for the Chrome Web
# Store. On a tag build (v1.2.3), the tag must match the manifest version.
set -euo pipefail
cd "$(dirname "$0")/.."

version=$(node -p "require('./manifest.json').version")
if [[ "${GITHUB_REF_TYPE:-}" == "tag" && "${GITHUB_REF_NAME#v}" != "$version" ]]; then
  echo "Tag $GITHUB_REF_NAME doesn't match manifest version $version" >&2
  exit 1
fi

for file in *.js; do
  node --check "$file"
done

# Every file the manifest points at has to ship.
node -e '
  const fs = require("fs");
  const m = require("./manifest.json");
  const files = [
    ...Object.values(m.icons || {}),
    m.options_ui?.page,
    ...m.content_scripts.flatMap((c) => [...(c.js || []), ...(c.css || [])])
  ].filter(Boolean);
  const missing = files.filter((f) => !fs.existsSync(f));
  if (missing.length) {
    console.error("Missing files referenced by manifest.json: " + missing.join(", "));
    process.exit(1);
  }
'

out="dist/pr-files-tabs-$version.zip"
rm -rf dist
mkdir dist
zip -q -X "$out" manifest.json ./*.js ./*.css ./*.html icons/*.png
echo "$out"
