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
  echo "method=wget plus webpack-runtime dependency crawl"
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
from urllib.parse import urljoin, urlsplit
source = pathlib.Path(sys.argv[1]).read_text(errors="ignore")
origin = "https://www." + "notion.so/login"
urls = {urljoin(origin, html.unescape(v)) for v in re.findall(r'(?:src|href)=["\x27]([^"\x27]+?\.js(?:\?[^"\x27]*)?)["\x27]', source)}
pathlib.Path(sys.argv[2]).write_text("\n".join(sorted(urls)) + ("\n" if urls else ""))
print(f"initial_asset_count={len(urls)}")
for url in sorted(urls):
    parsed=urlsplit(url)
    print(f"asset_host={parsed.hostname} asset_path={parsed.path}")
PY

  mkdir -p "$work/assets" "$work/chunks"
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

  echo "== Resolve runtime maps and crawl attachment dependencies =="
  python3 - "$work/assets" "$work/manifest.tsv" "$work/chunks" <<'PY'
import concurrent.futures, json, pathlib, re, subprocess, sys
from urllib.parse import urljoin, urlsplit
assets=pathlib.Path(sys.argv[1]); chunks=pathlib.Path(sys.argv[3])
manifest={}
for line in pathlib.Path(sys.argv[2]).read_text(errors="ignore").splitlines():
    if "\t" in line:
        name,url=line.split("\t",1); manifest[name]=url

def js_object(text,start):
    brace=text.find("{",start)
    if brace<0: raise ValueError("object start not found")
    depth=0; quote=None; escaped=False
    for pos in range(brace,len(text)):
        char=text[pos]
        if quote:
            if escaped: escaped=False
            elif char=="\\": escaped=True
            elif char==quote: quote=None
            continue
        if char in "\"'": quote=char
        elif char=="{": depth+=1
        elif char=="}":
            depth-=1
            if depth==0: return text[brace:pos+1],pos+1
    raise ValueError("unterminated object")

def parse_map(source):
    source=re.sub(r'([,{])\s*([0-9]+)\s*:',r'\1"\2":',source)
    return json.loads(source)

runtime_file=None; runtime_text=""; runtime_url=""
for file in assets.glob("*.js"):
    text=file.read_text(errors="ignore")
    marker=text.find(".u=e=>")
    if marker>=0:
        runtime_file=file; runtime_text=text; runtime_url=manifest.get(file.name,""); break
if runtime_file is None:
    print("runtime_found=false"); raise SystemExit
marker=runtime_text.find(".u=e=>")
name_source,after_names=js_object(runtime_text,marker)
hash_source,after_hashes=js_object(runtime_text,after_names)
name_map=parse_map(name_source); hash_map=parse_map(hash_source)
public=[]
for match in re.finditer(r'\.p=["\x27]([^"\x27]+)["\x27]',runtime_text): public.append(match.group(1))
runtime_parts=urlsplit(runtime_url)
runtime_dir=runtime_url.rsplit("/",1)[0]+"/"
base_candidates=[runtime_dir]
for value in public:
    candidate=urljoin(runtime_url,value)
    if not candidate.endswith("/"): candidate+="/"
    base_candidates.append(candidate)
base_candidates=list(dict.fromkeys(base_candidates))
print("runtime_found=true")
print(f"runtime_host={runtime_parts.hostname} runtime_path={runtime_parts.path}")
print(f"runtime_name_count={len(name_map)} runtime_hash_count={len(hash_map)}")
print("runtime_public_paths="+json.dumps(public))
print("base_candidates="+json.dumps([urlsplit(v).path for v in base_candidates]))

def filename(chunk_id):
    key=str(chunk_id); digest=hash_map.get(key)
    if not digest: return None
    return f"{name_map.get(key,key)}-{digest}.js"

seed_ids={21537,32823,77915,96907,50356,91005,17752,70596,98253,31781,21260,23648,42557,6948,68039,8730,44937,11987,85685}
interesting=re.compile(r'(file|upload|attachment|agent.*chat|chat.*input|preview|transcri)',re.I)
for key,value in name_map.items():
    if interesting.search(str(value)): seed_ids.add(int(key))
seed_ids={value for value in seed_ids if filename(value)}
print(f"seed_chunk_count={len(seed_ids)}")

def fetch_one(chunk_id):
    dest=chunks/f"{chunk_id}.js"
    if dest.exists() and dest.stat().st_size: return True
    name=filename(chunk_id)
    if not name: return False
    for base in base_candidates:
        url=urljoin(base,name)
        result=subprocess.run(["wget","-q","--timeout=25","-O",str(dest),url])
        if result.returncode==0 and dest.exists() and dest.stat().st_size:
            return True
        dest.unlink(missing_ok=True)
    return False

seen=set(); frontier=set(seed_ids); downloaded=set()
for depth in range(4):
    current=sorted(frontier-seen)
    if not current: break
    if len(seen)+len(current)>800: current=current[:max(0,800-len(seen))]
    if not current: break
    with concurrent.futures.ThreadPoolExecutor(max_workers=16) as pool:
        outcomes=dict(zip(current,pool.map(fetch_one,current)))
    seen.update(current)
    successful={chunk for chunk,ok in outcomes.items() if ok}
    downloaded.update(successful)
    next_ids=set()
    for chunk in successful:
        text=(chunks/f"{chunk}.js").read_text(errors="ignore")
        next_ids.update(int(value) for value in re.findall(r'\.e\(\s*([0-9]{1,7})',text))
    frontier={value for value in next_ids if value not in seen and filename(value)}
    print(f"crawl_depth={depth} attempted={len(current)} downloaded={len(successful)} discovered_next={len(frontier)}")
print(f"crawled_chunk_count={len(downloaded)}")
print(f"crawled_chunk_bytes={sum((chunks/f'{value}.js').stat().st_size for value in downloaded)}")

terms=["803083","getUploadFileUrl","getSignedFileUrls","signedPutUrl","signedGetUrl","fileSizeBytes","permissionRecord","createFileUpload","completeFileUpload","sendUpload"]
match_total=0
for chunk in sorted(downloaded):
    text=(chunks/f"{chunk}.js").read_text(errors="ignore")
    for term in terms:
        positions=[match.start() for match in re.finditer(re.escape(term),text)]
        for index,pos in enumerate(positions[:8],1):
            match_total+=1
            radius=5000 if term=="803083" else 1800
            lo=max(0,pos-radius); hi=min(len(text),pos+radius)
            print(f"\nCHUNK={chunk} FILE={filename(chunk)} TERM={term} MATCH={index}")
            print(text[lo:hi].replace("\n"," "))
print(f"exact_match_total={match_total}")

api_strings=set()
for chunk in downloaded:
    text=(chunks/f"{chunk}.js").read_text(errors="ignore")
    if not re.search(r'upload|attachment|signedFile|fileSizeBytes|permissionRecord',text,re.I): continue
    api_strings.update(re.findall(r'["\x27]([A-Za-z0-9_./:-]{3,120}(?:[Uu]pload|[Ff]ile|[Aa]ttachment|[Ss]igned)[A-Za-z0-9_./:-]{0,120})["\x27]',text))
print("\nAPI_STRING_COUNT="+str(len(api_strings)))
for value in sorted(api_strings)[:500]: print("API_STRING="+value)
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
