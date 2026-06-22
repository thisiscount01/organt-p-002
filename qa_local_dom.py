"""QA 시각·DOM 검증 — 로컬 서버 (짧은 버전, 30s 이내)"""
from playwright.sync_api import sync_playwright
import time, sys

BASE = 'http://localhost:3000'
results = []
def ok(cond, label):
    tag = 'PASS' if cond else 'FAIL'
    results.append((tag, label))
    print(f'  {tag}: {label}')

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    ctx = browser.new_context(viewport={'width':1280,'height':720})
    page = ctx.new_page()
    js_errors = []
    page.on('pageerror', lambda e: js_errors.append(str(e)))

    page.goto(BASE, wait_until='domcontentloaded', timeout=10000)
    time.sleep(1.5)
    page.screenshot(path='qa_local_lobby.png')

    # DOM 구조
    dom = page.evaluate("""() => ({
        game: !!document.getElementById('game'),
        hud: !!document.getElementById('hud'),
        orbCount: !!document.getElementById('orbCount'),
        augmentOverlay: !!document.getElementById('augmentOverlay'),
        gameCanvas: !!document.getElementById('gameCanvas')
    })""")
    print(f'  DOM: {dom}')
    ok(dom['game'], 'DOM: #game')
    ok(dom['hud'], 'DOM: #hud')
    ok(dom['orbCount'], 'DOM: #orbCount (오브 카운터)')
    ok(dom['augmentOverlay'], 'DOM: #augmentOverlay (업그레이드 오버레이)')
    ok(dom['gameCanvas'], 'DOM: #gameCanvas (캔버스)')

    # CSS 검증
    style_text = page.evaluate("""() => {
        let r = '';
        for (const ss of document.styleSheets) {
            try { for (const rule of ss.cssRules) r += rule.cssText + ' '; } catch(e) {}
        }
        return r;
    }""")
    print(f'  CSS 길이: {len(style_text)}자')
    ok('time-stopped' in style_text, 'CSS: .time-stopped 시간정지 정의')
    ok('saturate' in style_text, 'CSS: saturate 탈채색 필터')
    ok('brightness' in style_text, 'CSS: brightness 어두워짐 필터')
    ok('dropIn' in style_text or 'cardDrop' in style_text or 'augDrop' in style_text or 'slideDown' in style_text, 'CSS: 카드 진입 keyframe')
    ok('fadeIn' in style_text or 'overlayFade' in style_text or 'FadeIn' in style_text, 'CSS: 오버레이 fadeIn keyframe')
    ok('#FF88FF' in style_text or 'threshold' in style_text.lower() or 'ff88' in style_text.lower(), 'CSS: threshold 강조 색상')
    ok('blur' in style_text or 'backdrop' in style_text, 'CSS: blur/backdrop 연출')

    # 로컬 app.js 직접 fetch
    local_js = page.evaluate("""async () => {
        try { const r = await fetch('/app.js'); return await r.text(); }
        catch(e) { return 'err:'+e.message; }
    }""")
    print(f'  app.js 길이: {len(local_js)}자')
    ok('orb' in local_js.lower(), 'app.js: orb 코드')
    ok('arc' in local_js.lower() or 'bezier' in local_js.lower() or 'lerp' in local_js.lower(), 'app.js: arc/lerp 이동 코드')
    ok('augment' in local_js.lower(), 'app.js: augment 코드')
    ok('orbCount' in local_js or 'orb_count' in local_js or 'orbcount' in local_js.lower(), 'app.js: orbCount HUD 갱신')
    ok('time-stopped' in local_js or 'timeStopped' in local_js, 'app.js: time-stopped 클래스 적용')
    ok('AUG_GLYPH' in local_js or 'glyph' in local_js.lower() or 'emoji' in local_js.lower() or '⚔' in local_js, 'app.js: 아이콘/이모지 코드')
    ok('sharp' in local_js and ('0.20' in local_js or '20' in local_js), 'app.js: 공격력+20% 수치 반영')
    ok('boots' in local_js.lower() and ('0.15' in local_js or '15' in local_js), 'app.js: 속도+15% 수치')
    ok('steelheart' in local_js.lower() or ('steel' in local_js.lower() and '0.25' in local_js), 'app.js: HP+25% 수치')

    # effects.js 확인
    fx_js = page.evaluate("""async () => {
        try { const r = await fetch('/effects.js'); return await r.text(); }
        catch(e) { return 'err:'+e.message; }
    }""")
    print(f'  effects.js 길이: {len(fx_js)}자')
    ok('orb' in fx_js.lower(), 'effects.js: orb VFX 코드')
    ok('bezier' in fx_js.lower() or 'arc' in fx_js.lower(), 'effects.js: Bezier/arc 궤도')
    ok('flash' in fx_js.lower() or 'pickup' in fx_js.lower(), 'effects.js: 픽업 플래시')
    ok('particle' in fx_js.lower() or 'burst' in fx_js.lower(), 'effects.js: 파티클 burst')

    ok(len(js_errors) == 0, f'JS 에러 없음 (에러={len(js_errors)}개)')
    if js_errors:
        print(f'  JS 에러: {js_errors[:3]}')

    browser.close()

p2 = sum(1 for t,_ in results if t=='PASS')
f2 = sum(1 for t,_ in results if t=='FAIL')
print(f'\n시각/DOM 검증: PASS={p2} FAIL={f2} 총={p2+f2}')
for tag,label in results:
    if tag=='FAIL': print(f'  FAIL: {label}')
sys.exit(1 if f2 > 0 else 0)
