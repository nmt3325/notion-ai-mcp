#!/usr/bin/env bash
set -u

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$repo_root"
mkdir -p .ci
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
base="https://www.""notion.so"
out="$repo_root/.ci/attachment-research.txt"

{
  echo "researched_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "method=wget plus local grep/python parsing"
  echo

  echo "== Fetch Notion login and initial JavaScript assets =="
  if wget -q --timeout=30 -O "$work/login.html" "$base/login"; then
    echo "login_bytes=$(wc -c < "$work/login.html")"
  else
    echo "login_fetch_failed=true"
    : > "$work/login.html"
  fi

  python3 - "$work/login.html" "$work/assets.txt" <<'PY'
import html, pathlib, re, sys
from urllib.parse import urljoin
source = pathlib.Path(sys.argv[1]).read_text(errors="ignore")
urls = set()
for value in re.findall(r'(?:src|href)=["\x27]([^"\x27]+?\.js(?:\?[^"\x27]*)?)["\x27]', source):
    urls.add(urljoin("https://www." + "notion.so/login", html.unescape(value)))
pathlib.Path(sys.argv[2]).write_text("\n".join(sorted(urls)) + ("\n" if urls else ""))
print(f"initial_asset_count={len(urls)}")
PY

  mkdir -p "$work/chunks"
  if [ -s "$work/assets.txt" ]; then
    while IFS= read -r url; do
      name="$(printf '%s' "$url" | sha256sum | cut -c1-20).js"
      wget -q --timeout=30 -O "$work/chunks/$name" "$url" || rm -f "$work/chunks/$name"
    done < "$work/assets.txt"
  fi

  cat > "$work/known-paths.txt" <<'EOF'
/_next/static/chunks/11987-e776e35fc76bf683.js
/_next/static/chunks/85685-bb234a4660313c5d.js
/_next/static/chunks/98283-dabd9a8a2f398ea7.js
/_next/static/chunks/42557-6f281a3fef700ada.js
/_next/static/chunks/68039-487febf7d94b9605.js
/_next/static/chunks/6948-1a545a315d35c2e0.js
/_next/static/chunks/8730-e9a8023a69dafcc5.js
/_next/static/chunks/44937-826a5dc7f39d1cc4.js
/_next/static/chunks/21537-a3579c5d68ae9c08.js
/_next/static/chunks/32823-9c182da79bc02f5b.js
/_next/static/chunks/77915-23f10af6d9c9516e.js
/_next/static/chunks/96907-297be8202d82c883.js
EOF
  while IFS= read -r path; do
    name="known-$(basename "$path")"
    wget -q --timeout=30 -O "$work/chunks/$name" "$base$path" || rm -f "$work/chunks/$name"
  done < "$work/known-paths.txt"

  python3 - "$work/chunks" "$work/generated-urls.txt" <<'PY'
import pathlib, re, sys
root = pathlib.Path(sys.argv[1])
pairs = set()
paths = set()
for file in root.glob("*.js"):
    text = file.read_text(errors="ignore")
    for chunk, digest in re.findall(r'(?<![\w])([0-9]{2,7}):["\x27]([0-9a-f]{12,24})["\x27]', text):
        pairs.add((chunk, digest))
    for path in re.findall(r'(/_next/static/[^"\x27\\ ]+?\.js)', text):
        paths.add(path)
base = "https://www." + "notion.so"
urls = {base + p for p in paths}
for chunk, digest in pairs:
    urls.add(f"{base}/_next/static/chunks/{chunk}-{digest}.js")
pathlib.Path(sys.argv[2]).write_text("\n".join(sorted(urls)) + ("\n" if urls else ""))
print(f"runtime_candidate_count={len(urls)}")
PY

  if [ -s "$work/generated-urls.txt" ]; then
    cat "$work/generated-urls.txt" | xargs -r -P 16 -I '{}' sh -c '
      url="$1"; dest="$2/$(printf "%s" "$1" | sha256sum | cut -c1-20).js"
      wget -q --timeout=25 -O "$dest" "$url" || rm -f "$dest"
    ' sh '{}' "$work/chunks"
  fi
  echo "downloaded_js_count=$(find "$work/chunks" -type f -name '*.js' | wc -l)"
  echo "downloaded_js_bytes=$(find "$work/chunks" -type f -name '*.js' -printf '%s\n' | awk '{s+=$1} END {print s+0}')"
  echo

  echo "== Relevant bundle matches =="
  grep -RnaE -C 1 '803083|getUploadFileUrl|getSignedFileUrls|signedPutUrl|signedGetUrl|fileSizeBytes|permissionRecord|uploadFile|fileUrl|createFileUpload|completeFileUpload|sendUpload' "$work/chunks" 2>/dev/null | head -n 600 || true
  echo

  echo "== Public source-code matches from grep.app (fetched with wget) =="
  for query in \
    'getUploadFileUrl' \
    'getSignedFileUrls' \
    'fileSizeBytes permissionRecord' \
    'signedPutUrl notion' \
    'createFileUpload notion'; do
    encoded="$(python3 -c 'import sys,urllib.parse; print(urllib.parse.quote(sys.argv[1]))' "$query")"
    json="$work/grep-$(printf '%s' "$query" | sha256sum | cut -c1-12).json"
    echo "-- query: $query"
    if wget -q --timeout=30 -O "$json" "https://grep.app/api/search?q=$encoded"; then
      python3 - "$json" <<'PY'
import json, pathlib, re, sys
try:
    data = json.loads(pathlib.Path(sys.argv[1]).read_text())
except Exception as exc:
    print("parse_error=" + str(exc)); raise SystemExit
hits = data.get("hits", {}).get("hits", [])
print("hit_count=" + str(data.get("hits", {}).get("total", len(hits))))
for hit in hits[:12]:
    repo = hit.get("repo", {}).get("raw") if isinstance(hit.get("repo"), dict) else hit.get("repo")
    path = hit.get("path", {}).get("raw") if isinstance(hit.get("path"), dict) else hit.get("path")
    content = hit.get("content", {}).get("snippet", "")
    content = re.sub(r"<[^>]+>", "", content)
    content = re.sub(r"\s+", " ", content).strip()
    print(f"{repo} :: {path} :: {content[:900]}")
PY
    else
      echo "fetch_failed=true"
    fi
  done
} > "$out" 2>&1

wc -c "$out"
