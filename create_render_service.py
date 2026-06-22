import json, urllib.request, urllib.error

RENDER_KEY = "rnd_X9TbkDHrRrY6CVEQBEQxrM92K3pQ"
OWNER = "tea-d8ffkd42m8qs73e7vqeg"
BASE = "https://api.render.com/v1"

def api(method, path, data=None):
    url = BASE + path
    body = json.dumps(data).encode() if data else None
    req = urllib.request.Request(url, data=body, method=method, headers={
        "Authorization": f"Bearer {RENDER_KEY}",
        "Accept": "application/json",
        "Content-Type": "application/json"
    })
    try:
        with urllib.request.urlopen(req) as r:
            return json.loads(r.read())
    except urllib.error.HTTPError as e:
        return json.loads(e.read())

payload = {
    "type": "web_service",
    "name": "organt-arena-roguelite",
    "ownerId": OWNER,
    "repo": "https://github.com/thisiscount01/organt-arena-roguelite",
    "branch": "main",
    "rootDir": "",
    "serviceDetails": {
        "env": "node",
        "envSpecificDetails": {
            "buildCommand": "npm install",
            "startCommand": "node server.js"
        },
        "plan": "free",
        "region": "singapore",
        "numInstances": 1
    }
}

result = api("POST", "/services", payload)
print(json.dumps(result, indent=2))
