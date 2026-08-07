#!/usr/bin/env bash
set -u

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$repo_root"
mkdir -p .ci
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
base="https://www.""notion.so"
out="$repo_root/.ci/attachment-endpoints.txt"
mkdir -p "$work/assets" "$work/chunks"

{
  echo "researched_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "method=wget full current webpack chunk map plus bounded endpoint extraction"
  if ! wget -q --timeout=30 -O "$work/login.html" "$base/login"; then
    echo "login_fetch_failed=true"
    exit 0
  fi
  python3 - "$work/login.html" "$work/assets.txt" <<'PY'
import html, pathlib, re, sys
from urllib.parse import urljoin
text=pathlib.Path(sys.argv[1]).read_text(errors="ignore")
origin="https://www."+"notion.so/login"
urls=sorted({urljoin(origin,html.unescape(value)) for value in re.findall(r'(?:src|href)=["\x27]([^"\x27]+?\.js(?:\?[^"\x27]*)?)["\x27]',text)})
pathlib.Path(sys.argv[2]).write_text("\n".join(urls)+("\n" if urls else ""))
print(f"initial_asset_count={len(urls)}")
PY
  : > "$work/manifest.tsv"
  while IFS= read -r url; do
    name="$(printf '%s' "$url" | sha256sum | cut -c1-20).js"
    if wget -q --timeout=30 -O "$work/assets/$name" "$url"; then
      printf '%s\t%s\n' "$name" "$url" >> "$work/manifest.tsv"
    else
      rm -f "$work/assets/$name"
    fi
  done < "$work/assets.txt"

  python3 - "$work/assets" "$work/manifest.tsv" "$work/chunks" <<'PY'
import concurrent.futures, json, pathlib, re, subprocess, sys
from urllib.parse import urljoin, urlsplit
assets=pathlib.Path(sys.argv[1]); manifest_path=pathlib.Path(sys.argv[2]); chunks=pathlib.Path(sys.argv[3])
manifest={}
for line in manifest_path.read_text(errors="ignore").splitlines():
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
    return json.loads(re.sub(r'([,{])\s*([0-9]+)\s*:',r'\1"\2":',source))

runtime_file=None; runtime_text=""; runtime_url=""
for file in assets.glob("*.js"):
    text=file.read_text(errors="ignore")
    if ".u=e=>" in text:
        runtime_file=file; runtime_text=text; runtime_url=manifest.get(file.name,""); break
if runtime_file is None:
    print("runtime_found=false"); raise SystemExit
marker=runtime_text.find(".u=e=>")
name_source,after_names=js_object(runtime_text,marker)
hash_source,_=js_object(runtime_text,after_names)
name_map=parse_map(name_source); hash_map=parse_map(hash_source)
public=[m.group(1) for m in re.finditer(r'\.p=["\x27]([^"\x27]+)["\x27]',runtime_text)]
runtime_dir=runtime_url.rsplit("/",1)[0]+"/"
bases=[runtime_dir]
for value in public:
    candidate=urljoin(runtime_url,value)
    if not candidate.endswith("/"): candidate+="/"
    bases.append(candidate)
bases=list(dict.fromkeys(bases))
parts=urlsplit(runtime_url)
print("runtime_found=true")
print(f"runtime_host={parts.hostname} runtime_path={parts.path}")
print(f"runtime_name_count={len(name_map)} runtime_hash_count={len(hash_map)}")
print("runtime_public_paths="+json.dumps(public))

def filename(chunk_id):
    key=str(chunk_id); digest=hash_map.get(key)
    return f"{name_map.get(key,key)}-{digest}.js" if digest else None

def fetch_one(chunk_id):
    dest=chunks/f"{chunk_id}.js"; name=filename(chunk_id)
    if not name: return False
    for base in bases:
        result=subprocess.run(["wget","-q","--timeout=30","--tries=2","-O",str(dest),urljoin(base,name)])
        if result.returncode==0 and dest.exists() and dest.stat().st_size: return True
        dest.unlink(missing_ok=True)
    return False

all_ids=sorted(int(key) for key in hash_map)
with concurrent.futures.ThreadPoolExecutor(max_workers=24) as pool:
    outcomes=dict(zip(all_ids,pool.map(fetch_one,all_ids)))
downloaded=[value for value,ok in outcomes.items() if ok]
print(f"full_chunk_attempted={len(all_ids)} full_chunk_downloaded={len(downloaded)}")
print(f"full_chunk_bytes={sum((chunks/f'{value}.js').stat().st_size for value in downloaded)}")

sources=[]
for file in assets.glob("*.js"):
    url=manifest.get(file.name,""); path=urlsplit(url).path
    sources.append((f"initial:{path}",file.read_text(errors="ignore")))
for chunk_id in downloaded:
    sources.append((f"chunk:{chunk_id}:{filename(chunk_id)}",(chunks/f"{chunk_id}.js").read_text(errors="ignore")))

primary_terms=[
    "createAgentServiceFileUploadURL","completeAgentServiceFileUpload",
    "getUploadFileUrl","getSignedFileUrls","signedPutUrl","signedGetUrl",
    "createFileUpload","completeFileUpload","sendUpload","originalFileUrl",
    "assistantSessionId","attachmentSource","fileSizeBytes","permissionRecord"
]
counts={term:0 for term in primary_terms}
printed={term:0 for term in primary_terms}
for label,text in sources:
    for term in primary_terms:
        positions=[m.start() for m in re.finditer(re.escape(term),text)]
        counts[term]+=len(positions)
        for pos in positions:
            if printed[term]>=6: break
            printed[term]+=1
            radius=9000 if term in {"createAgentServiceFileUploadURL","completeAgentServiceFileUpload","getUploadFileUrl","getSignedFileUrls","signedPutUrl"} else 2800
            lo=max(0,pos-radius); hi=min(len(text),pos+len(term)+radius)
            print(f"\nSOURCE={label} TERM={term} MATCH={printed[term]}")
            print(text[lo:hi].replace("\n"," "))
print("\nTERM_COUNTS="+json.dumps(counts,sort_keys=True))

module_pattern=re.compile(r'(?<![0-9])803083\s*\(([^)]{1,160})\)\s*\{')
module_hits=[]
for label,text in sources:
    for match in module_pattern.finditer(text):
        module_hits.append((label,text,match))
print(f"MODULE_803083_DEFINITION_COUNT={len(module_hits)}")
for index,(label,text,match) in enumerate(module_hits[:3],1):
    start=match.start(); brace=text.find("{",match.start())
    depth=0; quote=None; escaped=False; end=min(len(text),start+160000)
    for pos in range(brace,len(text)):
        char=text[pos]
        if quote:
            if escaped: escaped=False
            elif char=="\\": escaped=True
            elif char==quote: quote=None
            continue
        if char in "\"'`": quote=char
        elif char=="{": depth+=1
        elif char=="}":
            depth-=1
            if depth==0:
                end=pos+1; break
        if pos-start>=160000:
            end=pos+1; break
    print(f"\nMODULE_803083_SOURCE={label} INDEX={index} BYTES={end-start}")
    print(text[start:end].replace("\n"," "))

relevant_events=set(); relevant_paths=set()
for _,text in sources:
    if not re.search(r'AgentServiceFileUpload|signedPutUrl|getSignedFileUrls|803083',text): continue
    relevant_events.update(re.findall(r'eventName\s*:\s*["\x27]([^"\x27]+)["\x27]',text))
    relevant_paths.update(re.findall(r'["\x27](/api/[A-Za-z0-9_./:-]{2,160})["\x27]',text))
print("\nRELEVANT_EVENT_NAMES="+json.dumps(sorted(value for value in relevant_events if re.search(r'file|upload|attachment|signed',value,re.I))))
print("RELEVANT_API_PATHS="+json.dumps(sorted(relevant_paths)))
PY
} > "$out" 2>&1

wc -c "$out"
