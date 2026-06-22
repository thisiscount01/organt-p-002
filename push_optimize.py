import os
import base64, json, urllib.request, urllib.error, sys

TOKEN = os.environ.get("GITHUB_TOKEN", "")
if not TOKEN:
    print("ERROR: GITHUB_TOKEN not set", flush=True)
    sys.exit(1)

REPO = "thisiscount01/organt-arena-roguelite"
BASE = "https://api.github.com"

def api(method, path, data=None):
    url = BASE + path
    body = json.dumps(data).encode() if data else None
    req = urllib.request.Request(url, data=body, method=method, headers={
        "Authorization": f"token {TOKEN}",
        "Accept": "application/vnd.github.v3+json",
        "Content-Type": "application/json"
    })
    try:
        with urllib.request.urlopen(req) as r:
            return json.loads(r.read())
    except urllib.error.HTTPError as e:
        body = e.read()
        try:
            return json.loads(body)
        except:
            return {"error": body.decode()}

files = [
    "server.js",
    "public/app.js",
]

print("=== git status (files to commit) ===", flush=True)
for f in files:
    path = f"/home/user/organt_workspace/arena-roguelite/{f}"
    exists = os.path.exists(path)
    size = os.path.getsize(path) if exists else 0
    print(f"  {f}: {'exists' if exists else 'MISSING'}, {size} bytes", flush=True)

print("\n=== Fetching current HEAD ===", flush=True)
head = api("GET", f"/repos/{REPO}/git/refs/heads/main")
if "object" not in head:
    print(f"ERROR fetching HEAD: {head}", flush=True)
    sys.exit(1)

commit_sha = head["object"]["sha"]
print(f"HEAD commit: {commit_sha}", flush=True)

commit = api("GET", f"/repos/{REPO}/git/commits/{commit_sha}")
if "tree" not in commit:
    print(f"ERROR fetching commit: {commit}", flush=True)
    sys.exit(1)

base_tree_sha = commit["tree"]["sha"]
print(f"Base tree: {base_tree_sha}", flush=True)

print("\n=== Creating blobs ===", flush=True)
tree_items = []
for fpath in files:
    full_path = f"/home/user/organt_workspace/arena-roguelite/{fpath}"
    with open(full_path, "rb") as f:
        content = f.read()
    b64 = base64.b64encode(content).decode()
    blob = api("POST", f"/repos/{REPO}/git/blobs", {"content": b64, "encoding": "base64"})
    sha = blob.get("sha", "ERROR")
    if sha == "ERROR":
        print(f"ERROR creating blob for {fpath}: {blob}", flush=True)
        sys.exit(1)
    print(f"  blob {fpath}: {sha[:8]}", flush=True)
    tree_items.append({"path": fpath, "mode": "100644", "type": "blob", "sha": sha})

print("\n=== Creating tree ===", flush=True)
tree = api("POST", f"/repos/{REPO}/git/trees", {"base_tree": base_tree_sha, "tree": tree_items})
tree_sha = tree.get("sha", "ERROR")
if tree_sha == "ERROR":
    print(f"ERROR creating tree: {tree}", flush=True)
    sys.exit(1)
print(f"Tree sha: {tree_sha[:8]}", flush=True)

COMMIT_MSG = "optimize: 20Hz tick + single emit('tick') + WS-only + perMessageDeflate + dirty-flag"

print("\n=== Creating commit ===", flush=True)
new_commit = api("POST", f"/repos/{REPO}/git/commits", {
    "message": COMMIT_MSG,
    "tree": tree_sha,
    "parents": [commit_sha]
})
new_sha = new_commit.get("sha", "ERROR")
if new_sha == "ERROR":
    print(f"ERROR creating commit: {new_commit}", flush=True)
    sys.exit(1)
print(f"New commit sha: {new_sha[:8]}", flush=True)
print(f"Commit message: {COMMIT_MSG}", flush=True)

print("\n=== Updating ref (push) ===", flush=True)
result = api("PATCH", f"/repos/{REPO}/git/refs/heads/main", {"sha": new_sha})
updated_sha = result.get("object", {}).get("sha", "ERROR")
if updated_sha == "ERROR":
    print(f"ERROR updating ref: {result}", flush=True)
    sys.exit(1)

print(f"Ref updated to: {updated_sha[:8]}", flush=True)
print(f"\n=== PUSH SUCCESS ===", flush=True)
print(f"https://github.com/{REPO}/commit/{new_sha}", flush=True)
