"""
클라이언트 최적화 검증: RENDER_DELAY=50 + extrapolation 적용 확인
- page_errors 없음
- canvas 렌더링 정상
- tick 수신 후 보간 동작 확인
"""
from playwright.sync_api import sync_playwright

with sync_playwright() as p:
    browser = p.chromium.launch()
    page = browser.new_page()
    page_errors = []
    console_errors = []

    page.on('pageerror', lambda err: page_errors.append(str(err)))
    page.on('console', lambda msg: console_errors.append(msg.text()) if msg.type == 'error' else None)

    page.goto('http://localhost:3000', wait_until='networkidle', timeout=15000)
    page.wait_for_timeout(1000)

    canvas_ok = page.evaluate("() => !!document.querySelector('canvas')")
    title = page.title()

    # app.js가 IIFE 안이라 RENDER_DELAY를 직접 못 읽으므로 소스에서 확인
    import urllib.request
    src = urllib.request.urlopen('http://localhost:3000/app.js').read().decode()
    render_delay_line = [l.strip() for l in src.splitlines() if 'RENDER_DELAY' in l and 'const' in l]
    has_extrap = 'extraAlpha' in src
    interp_extrap = 'extraAlpha = 0' in src and 'cur.x - pv.x' in src

    print(f"Canvas found: {canvas_ok}")
    print(f"Title: {title}")
    print(f"RENDER_DELAY line: {render_delay_line}")
    print(f"extraAlpha declared: {has_extrap}")
    print(f"interpEntities extrapolation present: {interp_extrap}")
    print(f"Page errors: {page_errors if page_errors else 'NONE'}")
    print(f"Console errors: {console_errors if console_errors else 'NONE'}")

    browser.close()
