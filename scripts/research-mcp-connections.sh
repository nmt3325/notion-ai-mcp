#!/usr/bin/env bash
set -u

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$repo_root"
mkdir -p .ci
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
base="https://www.""notion.so"
out="$repo_root/.ci/mcp-connections-research.txt"
mkdir -p "$work/assets" "$work/chunks"

{
  echo "researched_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "method=wget full current webpack chunk map plus bounded MCP connection extraction"
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
    "checkMcpOAuthSupport","validateMcpConnection","postWorkflowsMcpServerConnect",
    "initiateMcpOAuth","getPreconfiguredMcpServers","connectPreconfiguredMcpServer",
    "oauth_byo_app","enabledToolNames","enabledResourceUris",
    "runReadToolsAutomatically","runWriteToolsAutomatically",
    "approvalIntent","selectedScopes","authHeaders","preconfiguredServerId",
    "createdSource","defaultEnabled"
]
core_terms=[
    "checkMcpOAuthSupport","validateMcpConnection","postWorkflowsMcpServerConnect",
    "initiateMcpOAuth","getPreconfiguredMcpServers","connectPreconfiguredMcpServer",
    "oauth_byo_app","enabledToolNames","runReadToolsAutomatically",
    "runWriteToolsAutomatically","authHeaders"
]
count_terms=primary_terms+["__NONE__"]
counts={term:0 for term in count_terms}
candidate_sources=[]
for label,text in sources:
    for term in count_terms:
        counts[term]+=len(list(re.finditer(re.escape(term),text)))
    module_match=re.search(r"753163\([^)]*\)\{",text)
    has_mcp_sentinel=bool(module_match and "__NONE__" in text[module_match.start():module_match.start()+2000])
    if any(term in text for term in core_terms) or has_mcp_sentinel:
        candidate_sources.append((label,text))
print(f"mcp_candidate_source_count={len(candidate_sources)}")
print("MCP_CANDIDATE_SOURCES="+json.dumps([label for label,_ in candidate_sources]))
printed={term:0 for term in primary_terms}
for label,text in candidate_sources:
    for term in primary_terms:
        for match in re.finditer(re.escape(term),text):
            if printed[term]>=2: break
            printed[term]+=1
            radius=4200 if term in {"initiateMcpOAuth","validateMcpConnection","postWorkflowsMcpServerConnect","runReadToolsAutomatically","oauth_byo_app"} else 2600
            lo=max(0,match.start()-radius);hi=min(len(text),match.end()+radius)
            print(f"\nSOURCE={label} TERM={term} MATCH={printed[term]}")
            print(text[lo:hi].replace("\n"," "))
for label,text in candidate_sources:
    module_match=re.search(r"753163\([^)]*\)\{",text)
    if not module_match: continue
    sentinel=text.find("__NONE__",module_match.start(),module_match.start()+2000)
    if sentinel<0: continue
    lo=max(0,module_match.start()-300);hi=min(len(text),sentinel+1800)
    print(f"\nSOURCE={label} TERM=mcp_no_tools_sentinel MATCH=1")
    print(text[lo:hi].replace("\n"," "))
    break
print("\nTERM_COUNTS="+json.dumps(counts,sort_keys=True))

events=set(); api_paths=set(); strings=set()
for _,text in candidate_sources:
    events.update(re.findall(r'eventName\s*:\s*["\x27]([^"\x27]+)["\x27]',text))
    api_paths.update(re.findall(r'["\x27](/api/[A-Za-z0-9_./:-]{2,160})["\x27]',text))
    strings.update(re.findall(r'["\x27]([^"\x27]{1,160}(?:[Mm][Cc][Pp]|oauth)[^"\x27]{0,160})["\x27]',text))
print("MCP_EVENT_NAMES="+json.dumps(sorted(value for value in events if re.search(r'mcp|oauth',value,re.I))))
print("MCP_API_PATHS="+json.dumps(sorted(value for value in api_paths if re.search(r'mcp|oauth',value,re.I))))
print("MCP_STRING_LITERALS="+json.dumps(sorted(strings)[:300]))

PY
} > "$out" 2>&1

wc -c "$out"
