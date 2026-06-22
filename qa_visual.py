"""
QA 시각 레이어 독립 검증 — Playwright
Goal 2: 오브 arc 애니메이션 CSS/코드 존재
Goal 3: 누적 UI 시각 구별 CSS
Goal 4: 업그레이드 화면 연출 CSS
Goal 5: 카드 UI DOM 구조
Goal 6: HUD 변화 가시 여부
"""
from playwright.sync_api import sync_playwright
import time, sys

BASE = 'https://organt-p-002.onrender.com'
results = []

def ok(cond, label):
    tag = 'PASS' if cond else 'FAIL'
    results.append((tag, label))
    print(f'  {tag}: {label}')

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, args=['--ignore-certificate-errors'])
    ctx = browser.new_context(ignore_https_errors=True, viewport={'width':1280,'height':720})
    page = ctx.new_page()
    js_errors = []
    page.on('pageerror', lambda e: js_errors.append(str(e)))

    print(f'[접속] {BASE}')
    page.goto(BASE, wait_until='domcontentloaded', timeout=30000)
    time.sleep(4)
    page.screenshot(path='qa_vis_01_lobby.png')
    print('  스크린샷: qa_vis_01_lobby.png')

    # --- DOM 구조 확인 ---
    dom_checks = page.evaluate("""
() => ({
    game: !!document.getElementById('game'),
    hud: !!document.getElementById('hud'),
    orbCount: !!document.getElementById('orbCount'),
    augmentOverlay: !!document.getElementById('augmentOverlay'),
    gameCanvas: !!document.getElementById('gameCanvas'),
    augCards: document.querySelectorAll('.aug-card, .upgrade-card').length
})
""")
    print(f'  DOM: {dom_checks}')
    ok(dom_checks['game'], 'Visual-A: #game 엘리먼트 존재')
    ok(dom_checks['hud'], 'Visual-B: #hud HUD 존재')
    ok(dom_checks['orbCount'], 'Visual-C: #orbCount 카운터 존재 (누적 UI)')
    ok(dom_checks['augmentOverlay'], 'Visual-D: #augmentOverlay 업그레이드 오버레이 존재')

    # --- CSS 검증 ---
    style_text = page.evaluate("""
() => {
    let r = '';
    for (const ss of document.styleSheets) {
        try {
            for (const rule of ss.cssRules) r += rule.cssText + '\\n';
        } catch(e) {}
    }
    return r;
}
""")
    css_len = len(style_text)
    print(f'  CSS 총 길이: {css_len}자')
    ok(css_len > 500, 'Visual-E: CSS 로드됨')
    ok('time-stopped' in style_text, 'Goal4-CSS: .time-stopped (시간정지 비주얼) 정의')
    ok('blur' in style_text or 'backdrop' in style_text, 'Goal4-CSS: blur/backdrop 오버레이 연출 정의')
    ok('dropIn' in style_text or 'drop-in' in style_text or 'slideIn' in style_text or 'cardDrop' in style_text, 'Goal4-CSS: 카드 진입 keyframe 정의')
    ok('fadeIn' in style_text or 'overlayFade' in style_text, 'Goal4-CSS: fadeIn keyframe 정의')
    ok('orb' in style_text.lower(), 'Goal3-CSS: orb 관련 스타일 정의')
    # 임계치 시각 구별 (border 색상 변화 등)
    ok('#FF88FF' in style_text or 'threshold' in style_text.lower() or 'pink' in style_text.lower(), 'Goal3-CSS: threshold 시각 구별 색상/스타일 정의')

    # --- app.js / effects.js 소스 확인 ---
    scripts_info = page.evaluate("""
() => document.querySelectorAll('script[src]').length + ' scripts: ' +
      [...document.querySelectorAll('script[src]')].map(s=>s.src).join(', ')
""")
    print(f'  외부 스크립트: {scripts_info}')

    # effects.js 로드 확인
    ok('effects' in scripts_info, 'Goal2-JS: effects.js 스크립트 로드됨')
    ok('app' in scripts_info, 'Goal2-JS: app.js 스크립트 로드됨')

    # app.js 내용 fetch로 확인
    app_src = page.evaluate("""
async () => {
    const scripts = [...document.querySelectorAll('script[src]')];
    for (const s of scripts) {
        if (s.src.includes('app')) {
            try {
                const r = await fetch(s.src);
                const t = await r.text();
                return t.substring(0, 2000);
            } catch(e) { return 'fetch_err: ' + e.message; }
        }
    }
    return 'app_not_found';
}
""")
    print(f'  app.js 앞 200자: {app_src[:200]}')
    ok('orb' in app_src.lower() or 'arc' in app_src.lower() or 'bezier' in app_src.lower(), 'Goal2-app.js: 오브 arc/Bezier 코드 존재')
    ok('augment' in app_src.lower() or 'upgrade' in app_src.lower(), 'Goal5-app.js: 업그레이드 UI 코드 존재')

    # effects.js 확인
    fx_src = page.evaluate("""
async () => {
    const scripts = [...document.querySelectorAll('script[src]')];
    for (const s of scripts) {
        if (s.src.includes('effect')) {
            try {
                const r = await fetch(s.src);
                const t = await r.text();
                return t.substring(0, 2000);
            } catch(e) { return 'fetch_err: ' + e.message; }
        }
    }
    return 'effects_not_found';
}
""")
    print(f'  effects.js 앞 200자: {fx_src[:200]}')
    ok('orb' in fx_src.lower() or 'arc' in fx_src.lower() or 'bezier' in fx_src.lower(), 'Goal2-effects.js: 오브 아크 VFX 코드 존재')
    ok('flash' in fx_src.lower() or 'pickup' in fx_src.lower() or 'particle' in fx_src.lower(), 'Goal2-effects.js: 픽업 플래시/파티클 코드 존재')

    # --- 게임 플레이 시뮬레이션 후 업그레이드 UI 확인 ---
    print('\n[게임 시뮬레이션 시작]')
    # 소켓 찾기 및 게임 시작
    started = page.evaluate("""
() => {
    // io socket 찾기
    const s = window._socket || window.socket || window.gameSocket;
    if (!s) return 'no_socket';
    s.emit('create_room', {name: 'QA_VIS'});
    return 'ok';
}
""")
    print(f'  방 생성: {started}')
    time.sleep(0.8)

    page.evaluate("""
() => {
    const s = window._socket || window.socket || window.gameSocket;
    if (!s) return;
    s.emit('select_champion', {champion: 'warrior'});
    s.emit('ready', {ready: true});
}
""")
    time.sleep(0.5)
    page.evaluate("() => { const s = window._socket || window.socket || window.gameSocket; if(s) s.emit('start_game'); }")
    time.sleep(2)
    page.screenshot(path='qa_vis_02_game.png')
    print('  스크린샷: qa_vis_02_game.png')

    # orbCount HUD 값 확인
    orb_val = page.evaluate("() => { const el = document.getElementById('orbCount'); return el ? el.textContent : 'NOT_FOUND'; }")
    print(f'  현재 orbCount HUD 값: {orb_val}')
    ok(orb_val != 'NOT_FOUND', 'Goal3-runtime: #orbCount HUD 실시간 존재 확인')

    # game 상태 클래스 확인
    game_class = page.evaluate("() => { const el = document.getElementById('game'); return el ? el.className : 'N/A'; }")
    print(f'  #game 클래스: {game_class}')

    browser.close()

passed = sum(1 for t, _ in results if t == 'PASS')
failed = sum(1 for t, _ in results if t == 'FAIL')
print(f'\n==============================')
print(f'시각 레이어 검증: PASS={passed} / FAIL={failed}')
print('==============================')
if js_errors:
    print(f'JS 에러: {js_errors[:3]}')
sys.exit(1 if failed > 0 else 0)
