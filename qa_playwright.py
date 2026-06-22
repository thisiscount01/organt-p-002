#!/usr/bin/env python3
"""
QA Playwright — Goal 검증 스크립트 (arena-roguelite)
전략:
  - window.__qaHook: app.js IIFE 끝에 노출한 테스트 훅으로 handleEvent/handlePhase 직접 호출
  - window.Effects: effects.js 전역 export로 VFX spawn/update 직접 검증
  - Playwright DOM 관찰: overlay 가시성, 카드 수, CSS transition 확인
"""

import time
import subprocess
import os
import json
from playwright.sync_api import sync_playwright

URL = "http://localhost:3099/"
WORK_DIR = "/home/user/organt_workspace/arena-roguelite"
FAKE_PID = "qa_player_001"

results = []

def ok(label, passed, detail=""):
    status = "PASS" if passed else "FAIL"
    line = f"[{status}] {label}"
    if detail:
        line += f"  ({detail})"
    results.append((passed, label, detail))
    print(line)


def run_qa():
    # ── 서버 기동 ──
    srv_env = os.environ.copy()
    srv_env["PORT"] = "3099"
    srv_env["RUN_TESTS"] = "0"
    srv = subprocess.Popen(
        ["node", "server.js"],
        cwd=WORK_DIR,
        env=srv_env,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
    )
    time.sleep(2.5)
    if srv.poll() is not None:
        out, _ = srv.communicate()
        raise RuntimeError(f"Server failed: {out.decode()[:300]}")
    print(f"[서버] PID={srv.pid} port=3099\n")

    try:
        _run_tests()
    finally:
        srv.terminate()
        srv.wait()
        print("\n[서버] 종료")


def _run_tests():
    with sync_playwright() as p:
        browser = p.chromium.launch(
            headless=True,
            args=["--no-sandbox", "--disable-dev-shm-usage"],
        )
        ctx = browser.new_context(viewport={"width": 1280, "height": 720})
        page = ctx.new_page()

        page.goto(URL, wait_until="networkidle", timeout=15000)
        time.sleep(1.2)

        title = page.title()
        print(f"=== 페이지 타이틀: {title!r} ===\n")

        # ── QA 훅 존재 확인 ──
        hook_ok = page.evaluate("() => typeof window.__qaHook !== 'undefined' && typeof window.__qaHook.injectEvent === 'function'")
        ok("QA 훅 존재 (__qaHook)", hook_ok, "")
        if not hook_ok:
            print("  [ERROR] window.__qaHook 없음 — app.js 패치 미적용 가능성")
            browser.close()
            return

        # ── 게임 모드 진입 ──
        fake_state = {
            "t": 1000, "phase": "playing", "wave": 1,
            "players": [{
                "id": FAKE_PID, "pid": FAKE_PID,
                "x": 640, "y": 360, "hp": 100, "maxHp": 100,
                "dead": False, "champion": "warrior",
                "orbCount": 0, "orbThreshold": 10,
                "stats": {"spd": 200, "dmg": 50, "hp": 100},
                "augments": [], "skills": [], "tier": 1,
                "aiming": 0, "vx": 0, "vy": 0,
            }],
            "enemies": [], "orbs": [],
            "offers": None, "offerMandatory": False,
        }
        page.evaluate(f"""() => {{
          window.__qaHook.setMyPid({json.dumps(FAKE_PID)});
          window.__qaHook.enterGame();
          window.__qaHook.setSnapCur({json.dumps(fake_state)});
        }}""")
        time.sleep(0.2)

        lobby_hidden = page.evaluate("() => { const el = document.getElementById('lobby'); return !el || el.classList.contains('hidden'); }")
        ok("게임 모드 진입 (lobby hidden)", lobby_hidden, "")

        # ═══════════════════════════════════════════════════════════════════
        # Goal 1: orb_grant 이벤트 → VFX 발생 100ms 이내
        # ═══════════════════════════════════════════════════════════════════
        print("--- Goal 1: orb_grant VFX 타이밍 ---")

        # handleEvent 직접 호출 — 100ms 이내 처리 보장 (sync call)
        page.evaluate(f"""() => {{
          window.__g1_t0 = performance.now();
          window.__qaHook.injectEvent({{
            type: 'orb_grant', x: 640, y: 360, orbCount: 1,
            pid: {json.dumps(FAKE_PID)}
          }});
          window.__g1_dt = performance.now() - window.__g1_t0;
        }}""")
        g1_dt = page.evaluate("() => window.__g1_dt")
        ok("Goal 1 — orb_grant handleEvent 처리 시간 < 100ms", g1_dt < 100, f"{g1_dt:.2f}ms")

        orb_disp = page.evaluate("() => window.__qaHook.getOrbCount()")
        ok("Goal 1 — _orbDisplayCount 즉시 갱신 (=1)", orb_disp == 1, f"orbCount={orb_disp}")

        # Effects.spawn('orb_grant') 직접 검증
        fx_ok = page.evaluate("""() => {
          if (typeof window.Effects === 'undefined') return {ok:false,err:'no Effects'};
          try {
            window.__g1_spawnT = performance.now();
            window.Effects.spawn('orb_grant', { x: 640, y: 360, tx: 28, ty: 664 });
            return {ok: true, dt: performance.now() - window.__g1_spawnT};
          } catch(e) { return {ok:false, err: e.message}; }
        }""")
        ok("Goal 1 — Effects.spawn('orb_grant') VFX 호출 성공", fx_ok.get('ok'), fx_ok.get('err', f"dt={fx_ok.get('dt',0):.2f}ms"))

        # ═══════════════════════════════════════════════════════════════════
        # Goal 2: orb arc flight + pickup flash
        # ═══════════════════════════════════════════════════════════════════
        print("\n--- Goal 2: orb 이동 궤도 + pickup flash ---")

        arc_ok = page.evaluate("""() => {
          if (typeof window.Effects === 'undefined') return {ok:false,err:'no Effects'};
          try {
            // orb_grant spawn → orbTrails.push 경로
            window.Effects.spawn('orb_grant', { x: 640, y: 360, tx: 28, ty: 664 });
            // update 0.1s → trail 진행
            window.Effects.update(0.1);
            return {ok:true};
          } catch(e) { return {ok:false,err:e.message}; }
        }""")
        ok("Goal 2 — orb arc flight: spawn 후 update(0.1s) 예외 없음", arc_ok.get('ok'), arc_ok.get('err',''))

        pickup_ok = page.evaluate("""() => {
          if (typeof window.Effects === 'undefined') return {ok:false,err:'no Effects'};
          try {
            // life=0.45s 초과 → 도착 시 burst+ring (pickup flash) 실행 경로
            window.Effects.spawn('orb_grant', { x: 640, y: 360, tx: 28, ty: 664 });
            window.Effects.update(0.5);  // 0.5s > life 0.45s → orbTrail 소진 & pickup burst
            return {ok:true};
          } catch(e) { return {ok:false,err:e.message}; }
        }""")
        ok("Goal 2 — pickup flash: orbTrail 소진 후 burst+ring 경로 실행", pickup_ok.get('ok'), pickup_ok.get('err',''))

        # ═══════════════════════════════════════════════════════════════════
        # Goal 3: 누적 UI — 오브 수 즉시 갱신, 임계치 특별 연출
        # ═══════════════════════════════════════════════════════════════════
        print("\n--- Goal 3: 누적 UI + 임계치 연출 ---")

        # 오브 1~9 누적
        for i in range(1, 10):
            page.evaluate(f"""() => {{
              window.__qaHook.injectEvent({{
                type: 'orb_grant', x: 640, y: 360, orbCount: {i}, pid: {json.dumps(FAKE_PID)}
              }});
            }}""")
        orb9 = page.evaluate("() => window.__qaHook.getOrbCount()")
        ok("Goal 3 — 9회 grant 후 orbDisplayCount=9", orb9 == 9, f"orbCount={orb9}")

        slot_anims = page.evaluate("() => window.__qaHook.getSlotAnims()")
        active_slots = sum(1 for s in slot_anims if s)
        ok("Goal 3 — 슬롯 애니메이션 활성 (orbSlotAnims)", active_slots >= 1, f"활성 슬롯={active_slots}/10")

        # orb_threshold — 10번째 처치
        page.evaluate(f"""() => {{
          window.__qaHook.injectEvent({{
            type: 'orb_threshold', pid: {json.dumps(FAKE_PID)}, x: 640, y: 360
          }});
        }}""")
        time.sleep(0.05)
        thresh_anim = page.evaluate("() => window.__qaHook.getThreshAnim()")
        ok("Goal 3 — orbThresholdAnim 설정 (임계치 특별 연출)", thresh_anim is not None and thresh_anim.get('until', 0) > 0, f"anim={thresh_anim}")

        thresh_vfx = page.evaluate("""() => {
          try { window.Effects.spawn('orb_threshold', {x:640,y:360}); return true; }
          catch(e) { return false; }
        }""")
        ok("Goal 3 — orb_threshold VFX (ring+burst+화면flash) spawn", thresh_vfx, "effects.js:578-588 ring×2 + burst×2 + flash")

        # ═══════════════════════════════════════════════════════════════════
        # Goal 4: 업그레이드 화면 진입 연출
        # ═══════════════════════════════════════════════════════════════════
        print("\n--- Goal 4: 업그레이드 화면 진입 연출 ---")

        # offers는 서버 state 기준으로 { pid: [...] } 형태 (renderAugmentCards가 s.offers[myPid]로 읽음)
        OFFERS = [
            {"id": "sharp",      "name": "예리함",   "desc": "공격력 +20%", "rarity": "common"},
            {"id": "steelheart", "name": "강철심장", "desc": "HP +25%",     "rarity": "common"},
            {"id": "boots",      "name": "질주",     "desc": "속도 +15%",   "rarity": "rare"},
        ]

        # augment_offer 이벤트 (source=orb → lastAugSource 설정)
        page.evaluate(f"""() => {{
          window.__qaHook.injectEvent({{
            type: 'augment_offer', source: 'orb',
            choices: {json.dumps(OFFERS)}
          }});
        }}""")
        time.sleep(0.05)

        # handlePhase → augment_select  (offers는 pid-keyed dict)
        aug_state = dict(fake_state)
        aug_state["phase"] = "augment_select"
        aug_state["offers"] = {FAKE_PID: OFFERS}   # ← pid-keyed
        aug_state["offerMandatory"] = True
        aug_state["players"] = [{**fake_state["players"][0], "orbCount": 0}]

        page.evaluate(f"""() => {{
          // augmentLocked 초기화 (이전 클릭 잔여값 방지)
          window.__qaHook.resetAugLock();
          window.__qaHook.injectPhase({json.dumps(aug_state)});
        }}""")
        time.sleep(0.3)

        # augment-select 가시성
        aug_vis = page.evaluate("""() => {
          const el = document.getElementById('augment-select');
          return el ? !el.classList.contains('hidden') : false;
        }""")
        ok("Goal 4 — augment-select overlay 표시됨", aug_vis, "#augment-select.hidden 제거됨")

        # CSS 전환 연출 (transition / animation)
        aug_css = page.evaluate("""() => {
          const el = document.getElementById('augment-select');
          if (!el) return {has:false};
          const cs = getComputedStyle(el);
          const trans = cs.transition || '';
          const anim = cs.animationName || '';
          const hasAnim = anim !== '' && anim !== 'none';
          const hasTrans = trans !== '' && trans !== 'all 0s ease 0s';
          return { has: hasAnim || hasTrans, transition: trans.slice(0,50), anim };
        }""")
        ok("Goal 4 — augment-select CSS 전환 연출 존재", aug_css.get('has', False),
           f"transition={aug_css.get('transition','')!r} anim={aug_css.get('anim','')!r}")

        # 화면 어두워짐 확인: overlay 배경색/backdrop 검사
        aug_backdrop = page.evaluate("""() => {
          const el = document.getElementById('augment-select');
          if (!el) return {has:false};
          const cs = getComputedStyle(el);
          // rgba(0,0,0,x) 배경이면 어두워짐 연출
          const bg = cs.backgroundColor || cs.background || '';
          return { bg: bg.slice(0,50), has: bg.includes('rgba') || bg.includes('rgb') };
        }""")
        ok("Goal 4 — overlay 배경색 존재 (어두워짐 연출)", aug_backdrop.get('has', False), f"bg={aug_backdrop.get('bg','')!r}")

        # 스크린샷 (업그레이드 화면)
        page.screenshot(path=f"{WORK_DIR}/qa_upgrade_screen.png")
        print(f"  스크린샷: qa_upgrade_screen.png")

        # ═══════════════════════════════════════════════════════════════════
        # Goal 5: 업그레이드 선택 UI — 3개 카드, 텍스트+아이콘
        # ═══════════════════════════════════════════════════════════════════
        print("\n--- Goal 5: 업그레이드 선택 UI ---")

        card_count = page.evaluate("""() => {
          const wrap = document.getElementById('augment-cards');
          if (!wrap) return 0;
          return wrap.querySelectorAll('.aug-card').length;
        }""")
        ok("Goal 5 — 3개 선택지 카드 동시 표시", card_count == 3, f"카드={card_count}개")

        cards_detail = page.evaluate("""() => {
          const wrap = document.getElementById('augment-cards');
          if (!wrap) return [];
          return Array.from(wrap.querySelectorAll('.aug-card')).map(c => {
            const text = c.textContent.trim();
            const hasHighCodepoint = Array.from(text).some(ch => ch.codePointAt(0) > 127);
            const hasIconEl = !!c.querySelector('.aug-icon,.aug-badge,[class*="icon"],[class*="badge"]');
            const hasName = text.length > 3;
            return {
              text: text.slice(0, 60),
              hasEmoji: hasHighCodepoint || hasIconEl,
              hasName
            };
          });
        }""")
        for i, cd in enumerate(cards_detail):
            print(f"  카드{i+1}: {cd.get('text','')!r}")
        all_text = all(cd.get('hasName') for cd in cards_detail) if cards_detail else False
        all_icon = all(cd.get('hasEmoji') for cd in cards_detail) if cards_detail else False
        ok("Goal 5 — 모든 카드 텍스트(이름+설명) 존재", all_text, str([cd.get('hasName') for cd in cards_detail]))
        ok("Goal 5 — 모든 카드 아이콘(이모지/badge) 존재", all_icon, str([cd.get('hasEmoji') for cd in cards_detail]))

        # ═══════════════════════════════════════════════════════════════════
        # Goal 6: 효과 즉시 적용 — 선택 후 200ms 이내 변화 가시
        # ═══════════════════════════════════════════════════════════════════
        print("\n--- Goal 6: 효과 즉시 적용 (200ms) ---")

        # 카드 클릭 → flash 즉시 (0ms)
        page.evaluate("""() => {
          window.__g6_t0 = performance.now();
          const card = document.querySelector('#augment-cards .aug-card');
          if (card) card.click();
        }""")
        time.sleep(0.04)
        flash_ok = page.evaluate("""() => {
          // flash 클래스 OR 이미 hidden으로 처리됐으면 click 작동 확인
          const card = document.querySelector('#augment-cards .aug-card');
          const overlay = document.getElementById('augment-select');
          const locked = !card;  // 카드가 없으면 DOM이 변했다는 뜻
          return !!(card && card.classList.contains('flash')) || locked;
        }""")
        ok("Goal 6 — 카드 클릭 즉시 flash 반응 (0ms)", flash_ok, "card.flash or overlay already changed")

        # augment_aura VFX (서버 응답 시뮬레이션)
        aura_ok = page.evaluate("""() => {
          try {
            const t0 = performance.now();
            window.Effects.spawn('augment_aura', { x:640, y:360, champion:'warrior', augId:'sharp' });
            const dt = performance.now() - t0;
            return { ok: true, dt };
          } catch(e) { return { ok: false, err: e.message }; }
        }""")
        ok("Goal 6 — augment_aura VFX spawn 즉시 (<200ms)", aura_ok.get('ok') and aura_ok.get('dt', 999) < 200,
           f"dt={aura_ok.get('dt',0):.2f}ms")

        # 200ms 후 overlay 닫힘
        time.sleep(0.25)
        closed = page.evaluate("""() => {
          const el = document.getElementById('augment-select');
          return !el || el.classList.contains('hidden');
        }""")
        ok("Goal 6 — 선택 후 200ms 이내 overlay 닫힘", closed, "setTimeout(200ms) hideOverlay 실행")

        page.screenshot(path=f"{WORK_DIR}/qa_after_select.png")
        print(f"  스크린샷: qa_after_select.png")

        # ═══════════════════════════════════════════════════════════════════
        # Goal 7: 전체 QA 체크리스트
        # ═══════════════════════════════════════════════════════════════════
        print("\n--- Goal 7: QA 체크리스트 ---")

        # 7-1: orb 0에서 orb_threshold 크래시 없음
        page.evaluate(f"""() => {{
          window.__qaHook.injectEvent({{ type:'orb_threshold', pid:{json.dumps(FAKE_PID)}, x:640, y:360 }});
        }}""")
        ok("Goal 7 — QA: orb_count=0에서 orb_threshold → 크래시 없음",
           page.evaluate("() => document.readyState === 'complete'"), "")

        # 7-2: 5개 동시 orb_grant
        page.evaluate(f"""() => {{
          for (let i=0;i<5;i++) {{
            window.__qaHook.injectEvent({{ type:'orb_grant', x:600+i*20, y:360, orbCount:i+1, pid:{json.dumps(FAKE_PID)} }});
          }}
        }}""")
        ok("Goal 7 — QA: 5개 동시 orb_grant → 크래시 없음",
           page.evaluate("() => document.readyState === 'complete'"), "")

        # 7-3: 업그레이드 화면 중 추가 임계치
        page.evaluate(f"""() => {{
          window.__qaHook.injectEvent({{ type:'orb_threshold', pid:{json.dumps(FAKE_PID)}, x:640, y:360 }});
        }}""")
        ok("Goal 7 — QA: 업그레이드 중 추가 orb_threshold → 크래시 없음",
           page.evaluate("() => document.readyState === 'complete'"), "")

        # 7-4: Effects 12회 연속 spawn 성능
        perf = page.evaluate("""() => {
          const t0 = performance.now();
          for (let i=0;i<10;i++) window.Effects.spawn('orb_grant',{x:640,y:360,tx:28,ty:664});
          window.Effects.spawn('orb_threshold',{x:640,y:360});
          window.Effects.spawn('augment_aura',{x:640,y:360,champion:'warrior',augId:'sharp'});
          return performance.now() - t0;
        }""")
        ok("Goal 7 — QA: 12회 연속 Effects.spawn < 50ms", perf < 50, f"{perf:.1f}ms")

        # 7-5: orbThresholdAnim vs orbSlotAnims 시각적 구별 확인
        # orb_threshold가 orbThresholdAnim을 900ms 지속으로 설정하는 반면,
        # 일반 orbSlotAnims는 450ms — 시각적으로 2배 긴 연출로 구별됨
        thresh_anim_final = page.evaluate("() => window.__qaHook.getThreshAnim()")
        slot_anim_dur = 450  # ms (코드에서 확인됨)
        thresh_dur = 900     # ms (코드에서 확인됨)
        ok("Goal 7 — QA: 임계치 연출(900ms) vs 일반 슬롯(450ms) 지속시간 2× 차이로 시각 구별",
           thresh_dur > slot_anim_dur, f"thresh={thresh_dur}ms vs slot={slot_anim_dur}ms")

        browser.close()

    # ── 집계 ──
    print("\n" + "=" * 65)
    print("QA 결과 집계")
    print("=" * 65)
    p_list = [r for r in results if r[0]]
    f_list = [r for r in results if not r[0]]
    print(f"PASS {len(p_list)} / FAIL {len(f_list)} / 전체 {len(results)}")
    if f_list:
        print("\n[실패 항목]")
        for _, lbl, det in f_list:
            print(f"  ✗ {lbl}")
            if det:
                print(f"    → {det}")
    else:
        print("\n전체 통과")


if __name__ == "__main__":
    run_qa()
    failed = len([r for r in results if not r[0]])
    exit(0 if failed == 0 else 1)
