#!/usr/bin/env bash
set -u
repo_root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$repo_root"
mkdir -p .ci
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
base="https://www.""notion.so"
out="$repo_root/.ci/attachment-callsites.txt"
mkdir -p "$work/assets" "$work/chunks"
{
  echo "researched_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "method=wget full chunk map plus module-export callsite tracing"
  wget -q --timeout=30 -O "$work/login.html" "$base/login" || { echo "login_fetch_failed=true"; exit 0; }
  python3 - "$work/login.html" "$work/assets.txt" <<'PY'
import html,pathlib,re,sys
from urllib.parse import urljoin
text=pathlib.Path(sys.argv[1]).read_text(errors="ignore")
origin="https://www."+"notion.so/login"
urls=sorted({urljoin(origin,html.unescape(v)) for v in re.findall(r'(?:src|href)=["\x27]([^"\x27]+?\.js(?:\?[^"\x27]*)?)["\x27]',text)})
pathlib.Path(sys.argv[2]).write_text("\n".join(urls)+("\n" if urls else ""))
PY
  : > "$work/manifest.tsv"
  while IFS= read -r url; do
    name="$(printf '%s' "$url" | sha256sum | cut -c1-20).js"
    if wget -q --timeout=30 -O "$work/assets/$name" "$url"; then printf '%s\t%s\n' "$name" "$url" >> "$work/manifest.tsv"; else rm -f "$work/assets/$name"; fi
  done < "$work/assets.txt"
  python3 - "$work/assets" "$work/manifest.tsv" "$work/chunks" <<'PY'
import concurrent.futures,json,pathlib,re,subprocess,sys
from urllib.parse import urljoin,urlsplit
assets=pathlib.Path(sys.argv[1]); chunks=pathlib.Path(sys.argv[3])
manifest={}
for line in pathlib.Path(sys.argv[2]).read_text(errors="ignore").splitlines():
    if "\t" in line:
        k,v=line.split("\t",1); manifest[k]=v

def js_object(text,start):
    brace=text.find("{",start); depth=0; quote=None; escaped=False
    for p in range(brace,len(text)):
        c=text[p]
        if quote:
            if escaped: escaped=False
            elif c=="\\": escaped=True
            elif c==quote: quote=None
            continue
        if c in "\"'": quote=c
        elif c=="{": depth+=1
        elif c=="}":
            depth-=1
            if depth==0: return text[brace:p+1],p+1
    raise ValueError("unterminated object")
def parse_map(value): return json.loads(re.sub(r'([,{])\s*([0-9]+)\s*:',r'\1"\2":',value))
runtime_text=runtime_url=""
for file in assets.glob("*.js"):
    text=file.read_text(errors="ignore")
    if ".u=e=>" in text: runtime_text=text; runtime_url=manifest.get(file.name,""); break
if not runtime_text: print("runtime_found=false"); raise SystemExit
marker=runtime_text.find(".u=e=>")
names,after=js_object(runtime_text,marker); hashes,_=js_object(runtime_text,after)
name_map=parse_map(names); hash_map=parse_map(hashes)
bases=[runtime_url.rsplit("/",1)[0]+"/"]
for m in re.finditer(r'\.p=["\x27]([^"\x27]+)["\x27]',runtime_text):
    value=urljoin(runtime_url,m.group(1)); bases.append(value if value.endswith("/") else value+"/")
bases=list(dict.fromkeys(bases))
def filename(cid):
    k=str(cid); return f"{name_map.get(k,k)}-{hash_map[k]}.js" if k in hash_map else None
def fetch(cid):
    dest=chunks/f"{cid}.js"
    for base in bases:
        result=subprocess.run(["wget","-q","--timeout=30","--tries=2","-O",str(dest),urljoin(base,filename(cid))])
        if result.returncode==0 and dest.exists() and dest.stat().st_size: return True
        dest.unlink(missing_ok=True)
    return False
ids=sorted(int(k) for k in hash_map)
with concurrent.futures.ThreadPoolExecutor(max_workers=24) as pool: outcomes=dict(zip(ids,pool.map(fetch,ids)))
downloaded=[cid for cid,ok in outcomes.items() if ok]
print(f"chunks_downloaded={len(downloaded)} chunks_total={len(ids)}")
sources=[]
for file in assets.glob("*.js"): sources.append(("initial:"+urlsplit(manifest.get(file.name,"")).path,file.read_text(errors="ignore")))
for cid in downloaded: sources.append((f"chunk:{cid}:{filename(cid)}",(chunks/f"{cid}.js").read_text(errors="ignore")))
needle="createAgentServiceFileUploadURL"
owner=None
for label,text in sources:
    pos=text.find(needle)
    if pos<0: continue
    headers=[m for m in re.finditer(r'(?:^|[,{}])([0-9]{1,9})\(([A-Za-z_$][\w$]*,[A-Za-z_$][\w$]*,[A-Za-z_$][\w$]*)\)\{',text[:pos])]
    if headers:
        match=headers[-1]; owner=(label,text,pos,match.group(1),match.start(1)); break
if owner is None: print("owner_module_found=false"); raise SystemExit
label,text,pos,module_id,module_start=owner
next_header=re.search(r'},[0-9]{1,9}\([A-Za-z_$][\w$]*,[A-Za-z_$][\w$]*,[A-Za-z_$][\w$]*\)\{',text[module_start+1:])
module_end=(module_start+1+next_header.start()+1) if next_header else len(text)
module_text=text[module_start:module_end]
print(f"owner_module_found=true owner_source={label} owner_module_id={module_id} owner_module_bytes={len(module_text)}")
exports={local:exported for exported,local in re.findall(r'([A-Za-z0-9_$]+):\(\)=>\s*([A-Za-z0-9_$]+)',module_text)}
locals_by_event={}
for event in ["createAgentServiceFileUploadURL","completeAgentServiceFileUpload","getFileContentURLForAgentThread"]:
    ep=module_text.find(event)
    prior=module_text[:ep]
    matches=list(re.finditer(r'async function\s+([A-Za-z0-9_$]+)\s*\(',prior))
    if matches: locals_by_event[event]=matches[-1].group(1)
    print(f"\nOWNER_EVENT_CONTEXT={event}")
    print(module_text[max(0,ep-700):min(len(module_text),ep+1100)].replace("\n"," "))
export_by_event={event:exports.get(local) for event,local in locals_by_event.items()}
print("LOCAL_BY_EVENT="+json.dumps(locals_by_event,sort_keys=True))
print("EXPORT_BY_EVENT="+json.dumps(export_by_event,sort_keys=True))

callsite_count=0
shown_by_event={event:0 for event in export_by_event}
reference_sources={event:[] for event in export_by_event}
for source_label,source_text in sources:
    if module_id not in source_text: continue
    aliases=set()
    for m in re.finditer(r'([A-Za-z_$][\w$]*)\s*=\s*\(\)\s*=>\s*[A-Za-z_$][\w$]*\(\s*'+re.escape(module_id)+r'\s*\)',source_text): aliases.add((m.group(1),True))
    for m in re.finditer(r'([A-Za-z_$][\w$]*)\s*=\s*[A-Za-z_$][\w$]*\(\s*'+re.escape(module_id)+r'\s*\)',source_text): aliases.add((m.group(1),False))
    patterns=[]
    for event,exported in export_by_event.items():
        if not exported: continue
        patterns.append((event,re.compile(r'[A-Za-z_$][\w$]*\(\s*'+re.escape(module_id)+r'\s*\)\.'+re.escape(exported)+r'\b')))
        for alias,is_fn in aliases:
            prefix=re.escape(alias)+(r'\(\)' if is_fn else '')
            patterns.append((event,re.compile(prefix+r'\.'+re.escape(exported)+r'\b')))
    seen=set()
    for event,pattern in patterns:
        for match in pattern.finditer(source_text):
            key=(event,match.start())
            if key in seen: continue
            seen.add(key); callsite_count+=1
            if source_label not in reference_sources[event]: reference_sources[event].append(source_label)
            if shown_by_event[event] >= 2: continue
            shown_by_event[event]+=1
            lo=max(0,match.start()-1800); hi=min(len(source_text),match.end()+3200)
            print(f"\nCALLSITE_SOURCE={source_label} EVENT={event} INDEX={callsite_count}")
            print(source_text[lo:hi].replace("\n"," "))
print(f"CALLSITE_COUNT={callsite_count}")
print("CALLSITE_SHOWN_BY_EVENT="+json.dumps(shown_by_event,sort_keys=True))
for event,source_labels in reference_sources.items():
    print(f"REFERENCE_SOURCES event={event} count={len(source_labels)} labels="+json.dumps(source_labels[:20]))
for event in ["createAgentServiceFileUploadURL","completeAgentServiceFileUpload","getFileContentURLForAgentThread"]:
    print(f"EVENT_EXPORT {event}={export_by_event.get(event)}")
PY
} > "$out" 2>&1
wc -c "$out"
