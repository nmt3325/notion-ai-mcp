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
  echo "method=wget plus local python parsing"
  echo
  echo "== Fetch login and initial JavaScript assets =="
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
origin = "https://www." + "notion.so/login"
urls = {urljoin(origin, html.unescape(v)) for v in re.findall(r'(?:src|href)=["\x27]([^"\x27]+?\.js(?:\?[^"\x27]*)?)["\x27]', source)}
pathlib.Path(sys.argv[2]).write_text("\n".join(sorted(urls)) + ("\n" if urls else ""))
print(f"initial_asset_count={len(urls)}")
for url in sorted(urls): print("asset_url=" + url)
PY

  mkdir -p "$work/assets"
  : > "$work/manifest.tsv"
  if [ -s "$work/assets.txt" ]; then
    while IFS= read -r url; do
      name="$(printf '%s' "$url" | sha256sum | cut -c1-20).js"
      if wget -q --timeout=30 -O "$work/assets/$name" "$url"; then
        printf '%s\t%s\n' "$name" "$url" >> "$work/manifest.tsv"
      else
        rm -f "$work/assets/$name"
      fi
    done < "$work/assets.txt"
  fi
  echo "downloaded_initial_count=$(find "$work/assets" -type f -name '*.js' | wc -l)"
  echo "downloaded_initial_bytes=$(find "$work/assets" -type f -name '*.js' -printf '%s\n' | awk '{s+=$1} END {print s+0}')"
  echo

  echo "== Exact attachment and webpack runtime contexts =="
  python3 - "$work/assets" "$work/manifest.tsv" <<'PY'
import pathlib, re, sys
root = pathlib.Path(sys.argv[1])
manifest = {}
for line in pathlib.Path(sys.argv[2]).read_text(errors="ignore").splitlines():
    if "\t" in line:
        name, url = line.split("\t", 1); manifest[name] = url
terms = [
    "803083", "getUploadFileUrl", "getSignedFileUrls", "signedPutUrl", "signedGetUrl",
    "fileSizeBytes", "permissionRecord", "createFileUpload", "completeFileUpload", "sendUpload"
]
runtime_terms = [".u=", "getChunkScriptFilename", "static/chunks/", "chunkId", ".miniCssF="]
for file in sorted(root.glob("*.js")):
    text = file.read_text(errors="ignore")
    url = manifest.get(file.name, file.name)
    emitted = False
    for term in terms:
        positions = [match.start() for match in re.finditer(re.escape(term), text)]
        for index, pos in enumerate(positions[:6], 1):
            if not emitted:
                print(f"\nasset={url} bytes={len(text.encode())}"); emitted = True
            lo=max(0,pos-700); hi=min(len(text),pos+1400)
            print(f"TERM {term} #{index}: " + text[lo:hi].replace("\n", " "))
    runtime_hits=[]
    for term in runtime_terms:
        runtime_hits.extend((match.start(), term) for match in re.finditer(re.escape(term), text))
    if runtime_hits:
        if not emitted:
            print(f"\nasset={url} bytes={len(text.encode())}"); emitted = True
        for pos, term in sorted(runtime_hits)[:18]:
            lo=max(0,pos-900); hi=min(len(text),pos+2300)
            print(f"RUNTIME {term}: " + text[lo:hi].replace("\n", " "))
    pairs = re.findall(r'(?<![\w])([0-9]{2,7}):["\x27]([0-9a-f]{10,32})["\x27]', text)
    if pairs:
        if not emitted:
            print(f"\nasset={url} bytes={len(text.encode())}")
        print(f"HASH_PAIR_COUNT={len(pairs)} SAMPLE={pairs[:30]}")
PY
  echo

  echo "== Public source-code queries (wget) =="
  for query in 'getUploadFileUrl' 'getSignedFileUrls' 'fileSizeBytes permissionRecord' 'signedPutUrl notion' 'createFileUpload notion'; do
    encoded="$(python3 -c 'import sys,urllib.parse; print(urllib.parse.quote(sys.argv[1]))' "$query")"
    target="$work/grep-$(printf '%s' "$query" | sha256sum | cut -c1-12).json"
    echo "query=$query"
    if wget -q --timeout=30 -O "$target" "https://grep.app/api/search?q=$encoded"; then
      python3 - "$target" <<'PY'
import json, pathlib, re, sys
try: data=json.loads(pathlib.Path(sys.argv[1]).read_text())
except Exception as exc: print("parse_error="+str(exc)); raise SystemExit
hits=data.get("hits",{}).get("hits",[])
print("hit_count="+str(data.get("hits",{}).get("total",len(hits))))
for hit in hits[:10]:
    repo=hit.get("repo",{}).get("raw") if isinstance(hit.get("repo"),dict) else hit.get("repo")
    path=hit.get("path",{}).get("raw") if isinstance(hit.get("path"),dict) else hit.get("path")
    snippet=hit.get("content",{}).get("snippet","")
    snippet=re.sub(r"<[^>]+>","",snippet); snippet=re.sub(r"\s+"," ",snippet).strip()
    print(f"{repo} :: {path} :: {snippet[:800]}")
PY
    else
      echo "fetch_failed=true"
    fi
  done
} > "$out" 2>&1

wc -c "$out"
