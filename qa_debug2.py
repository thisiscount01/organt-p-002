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

    # io 객체의 모든 키 탐색
    result = page.evaluate("""() => {
      if (!window.io) return ['no io'];
      const keys = [];
      for (const k in window.io) { try { keys.push(k + ':' + typeof window.io[k]); } catch(e) {} }
      return keys.slice(0,30);
    }""")
    print("io keys:", result)

    # Socket 객체를 얻을 다른 방법 탐색 (io() 재호출 시 캐시 반환)
    result2 = page.evaluate("""() => {
      try {
        // io() 재호출 — socket.io는 같은 URL에 대해 Manager를 캐시함
        const s = window.io();
        return {
          type: typeof s,
          hasOnevent: typeof s.onevent === 'function',
          hasSendPacket: typeof s.sendPacket === 'function',
          id: s.id,
          connected: s.connected,
          ioKeys: Object.keys(s.io || {}).slice(0, 15)
        };
      } catch(e) { return {err: e.message}; }
    }""")
    print("io() re-call:", result2)

    # _socket 내부에서 engine 찾기
    result3 = page.evaluate("""() => {
      try {
        const s = window.io();
        const mgr = s.io; // Manager
        const eng = mgr.engine;
        const trans = eng && eng.transport;
        return {
          hasMgr: !!mgr,
          hasEng: !!eng,
          transName: trans && trans.name,
          hasWs: !!(trans && trans.ws),
          wsState: trans && trans.ws && trans.ws.readyState,
          engState: eng && eng.readyState,
          mgrKeys: Object.keys(mgr || {}).slice(0,10)
        };
      } catch(e) { return {err: e.message}; }
    }""")
    print("socket.io internal:", result3)

    browser.close()

srv.terminate(); srv.wait()
print("done")
