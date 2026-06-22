import os
import base64, json, urllib.request, urllib.error, sys

TOKEN = os.environ.get("GITHUB_TOKEN", "")
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
        return json.loads(e.read())

files = [
    "server.js",
    "public/index.html",
    "public/style.css",
    "public/app.js",
    "public/champMotion.js",
    "public/effects.js",
    "public/enemyMotion.js",
]

head = api("GET", f"/repos/{REPO}/git/refs/heads/main")
commit_sha = head["object"]["sha"]
commit = api("GET", f"/repos/{REPO}/git/commits/{commit_sha}")
base_tree_sha = commit["tree"]["sha"]
print(f"base tree: {base_tree_sha}", flush=True)

tree_items = []
for fpath in files:
    with open(fpath, "rb") as f:
        content = f.read()
    b64 = base64.b64encode(content).decode()
    blob = api("POST", f"/repos/{REPO}/git/blobs", {"content": b64, "encoding": "base64"})
    sha = blob.get("sha", "ERROR")
    print(f"blob {fpath}: {sha[:8] if sha != 'ERROR' else blob}", flush=True)
    tree_items.append({"path": fpath, "mode": "100644", "type": "blob", "sha": sha})

tree = api("POST", f"/repos/{REPO}/git/trees", {"base_tree": base_tree_sha, "tree": tree_items})
tree_sha = tree.get("sha", "ERROR")
print(f"tree sha: {tree_sha[:8] if tree_sha != 'ERROR' else tree}", flush=True)

new_commit = api("POST", f"/repos/{REPO}/git/commits", {
    "message": "deploy arena-roguelite game",
    "tree": tree_sha,
    "parents": [commit_sha]
})
new_sha = new_commit.get("sha", "ERROR")
print(f"commit sha: {new_sha[:8] if new_sha != 'ERROR' else new_commit}", flush=True)

result = api("PATCH", f"/repos/{REPO}/git/refs/heads/main", {"sha": new_sha})
print(f"ref updated: {result.get('object',{}).get('sha','ERROR')[:8]}", flush=True)
print("DONE", flush=True)
