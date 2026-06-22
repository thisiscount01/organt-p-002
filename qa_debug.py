#!/usr/bin/env python3
import time, subprocess, os
from playwright.sync_api import sync_playwright

WORK_DIR = "/home/user/organt_workspace/arena-roguelite"
srv_env = os.environ.copy()
srv_env["PORT"] = "3099"
srv_env["RUN_TESTS"] = "0"
srv = subprocess.Popen(["node", "server.js"], cwd=WORK_DIR, env=srv_env,
    stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
time.sleep(2.5)

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, args=["--no-sandbox"])
    page = browser.new_page()
    page.goto("http://localhost:3099/", wait_until="networkidle")
    time.sleep(1.5)

    # socket.io 내부 구조 탐색
    result = page.evaluate("""() => {
      if (!window.io) return {err: 'no io'};
      const mgrs = window.io.managers;
      if (!mgrs) return {err: 'no managers'};
      const keys = Object.keys(mgrs);
      if (!keys.length) return {err: 'empty managers', type: typeof mgrs};
      const mgr = mgrs[keys[0]];
      const eng = mgr && mgr.engine;
      const trans = eng && eng.transport;
      return {
        mgrKeys: keys,
        mgrType: typeof mgr,
        engType: typeof eng,
        transName: trans && trans.name,
        hasWs: !!(trans && trans.ws),
        wsState: trans && trans.ws && trans.ws.readyState,
        engState: eng && eng.readyState
      };
    }""")
    print("socket.io structure:", result)

    # onevent 경로 확인
    result2 = page.evaluate("""() => {
      if (!window.io || !window.io.managers) return {err: 'no mgrs'};
      const keys = Object.keys(window.io.managers);
      if (!keys.length) return {err: 'empty'};
      const mgr = window.io.managers[keys[0]];
      const nsps = mgr && mgr.nsps;
      if (!nsps) return {err: 'no nsps'};
      const sock = nsps['/'];
      return {
        hasSock: !!sock,
        hasOnevent: !!(sock && typeof sock.onevent === 'function'),
        hasOnEvent: !!(sock && typeof sock.on === 'function'),
        sockId: sock && sock.id
      };
    }""")
    print("socket onevent:", result2)

    browser.close()

srv.terminate(); srv.wait()
print("done")
