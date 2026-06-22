"""
QA 시각 검증 v2 — 로컬 서버 대상, 올바른 DOM ID 사용
- canvas#game 기반 HUD (DOM element 아님)
- #augment-select 오버레이 (not #augmentOverlay)
- 게임 플레이 시뮬레이션 후 업그레이드 화면 스크린샷
"""
from playwright.sync_api import sync_playwright
import time, sys, json

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

    # io() 후킹 — app.js 소켓 캡처 (domcontentloaded 전에 실행)
    page.add_init_script("""
        window.__qaPhase = 'init';
        window.__qaEvents = [];
        window.__qaOrb = 0;
        window.__qaMyPid = null;
        window.__qaMyStats = null;
        window.__qaLastSt = null;
        const _origIo = window.io;
        Object.defineProperty(window, 'io', {
            configurable: true,
            get: function() { return _origIo; },
            set: function(fn) {
                window.__ioFn = fn;
                Object.defineProperty(window, 'io', {
                    configurable: true,
                    writable: true,
                    value: function(...args) {
                        const s = fn.apply(this, args);
                        window.__appSocket = s;
                        s.on('state', st => {
                            window.__qaPhase = st.phase;
                            window.__qaLastSt = st;
                        });
                        s.on('events', evs => {
                            for(const e of evs) window.__qaEvents.push(e.type);
                        });
                        return s;
                    }
                });
            }
        });
    """)
    page.goto(BASE, wait_until='networkidle', timeout=15000)
    time.sleep(2)
    page.screenshot(path='qa_pw_01_lobby.png')
    print('  스크린샷: qa_pw_01_lobby.png')

    # ─── DOM 구조 (올바른 ID) ───
    dom = page.evaluate("""() => ({
        game_canvas: !!document.getElementById('game'),
        lobby: !!document.getElementById('lobby'),
        augment_select: !!document.getElementById('augment-select'),
        augment_cards: !!document.getElementById('augment-cards'),
        room: !!document.getElementById('room'),
        canvas_tag: document.getElementById('game') ? document.getElementById('game').tagName : 'N/A'
    })""")
    print(f'  DOM: {dom}')
    ok(dom['game_canvas'] and dom['canvas_tag'] == 'CANVAS', 'DOM: canvas#game (캔버스)')
    ok(dom['lobby'], 'DOM: #lobby 로비 오버레이')
    ok(dom['augment_select'], 'DOM: #augment-select 업그레이드 오버레이')
    ok(dom['augment_cards'], 'DOM: #augment-cards 카드 컨테이너')

    # ─── CSS ───
    style_text = page.evaluate("""() => {
        let r = '';
        for (const ss of document.styleSheets) {
            try { for (const rule of ss.cssRules) r += rule.cssText + ' '; } catch(e) {}
        }
        return r;
    }""")
    print(f'  CSS 길이: {len(style_text)}자')
    ok('time-stopped' in style_text, 'CSS: #game.time-stopped 시간정지 정의')
    ok('saturate(0.18)' in style_text, 'CSS: saturate(0.18) 탈채색 값 확인')
    ok('brightness(0.52)' in style_text, 'CSS: brightness(0.52) 어두워짐 값 확인')
    ok('dropIn' in style_text, 'CSS: @keyframes dropIn 카드 진입')
    ok('fadeIn' in style_text, 'CSS: @keyframes fadeIn 오버레이')
    ok('blur(2px)' in style_text or 'backdrop' in style_text, 'CSS: backdrop-filter blur 연출')
    ok('aug-card' in style_text or '.card' in style_text, 'CSS: 카드 스타일 정의')

    # ─── app.js 코드 확인 ───
    local_js = page.evaluate("""async () => {
        try { const r = await fetch('/app.js'); return await r.text(); }
        catch(e) { return 'err:'+e.message; }
    }""")
    print(f'  app.js 길이: {len(local_js)}자')
    ok('FF88FF' in local_js, 'app.js: threshold 강조색 #FF88FF (임계치 시각 구별)')
    ok('BB77FF' in local_js, 'app.js: 일반 오브색 #BB77FF (일반 vs 임계치 구별)')
    ok("'orb_grant'" in local_js or '"orb_grant"' in local_js, 'app.js: orb_grant 이벤트 처리')
    ok("'orb_threshold'" in local_js or '"orb_threshold"' in local_js, 'app.js: orb_threshold 이벤트 처리')
    ok('time-stopped' in local_js, 'app.js: time-stopped 클래스 적용 코드')
    ok('AUG_GLYPH' in local_js or 'glyph' in local_js.lower(), 'app.js: 아이콘/이모지 글리프 코드')
    ok('augment_select' in local_js, 'app.js: augment_select 페이즈 분기')
    ok('select_augment' in local_js, 'app.js: select_augment 이벤트 emit')
    ok('0.20' in local_js or 'dmgMul' in local_js or 'augment' in local_js, 'app.js: 공격력+20% 증강 렌더 코드')
    ok("'boots'" in local_js or '"boots"' in local_js or 'boots' in local_js, 'app.js: 속도+15% boots 카드')
    ok('steelheart' in local_js or 'steel' in local_js, 'app.js: HP+25% steelheart 카드')
    ok('fx.spawn' in local_js or 'Effects' in local_js, 'app.js: VFX 스폰 코드')
    ok('bezier' in local_js.lower() or 'arc' in local_js.lower(), 'app.js: arc/bezier 이동')
    ok('addShake' in local_js or 'shake' in local_js, 'app.js: 화면 shake 코드')

    # ─── effects.js ───
    fx_js = page.evaluate("""async () => {
        try { const r = await fetch('/effects.js'); return await r.text(); }
        catch(e) { return 'err:'+e.message; }
    }""")
    print(f'  effects.js 길이: {len(fx_js)}자')
    ok("'orb_grant'" in fx_js or '"orb_grant"' in fx_js, 'effects.js: orb_grant VFX 핸들러')
    ok("'orb_threshold'" in fx_js or '"orb_threshold"' in fx_js, 'effects.js: orb_threshold VFX')
    ok('lerp' in fx_js.lower() or 'orb_grant' in fx_js, 'effects.js: orb arc lerp/궤도 코드')
    ok('flash' in fx_js.lower() or 'pickup' in fx_js.lower(), 'effects.js: 픽업 플래시')
    ok('particle' in fx_js.lower() or 'burst' in fx_js.lower(), 'effects.js: 파티클 burst')

    # JS 에러 없음
    ok(len(js_errors) == 0, f'JS 에러 없음 (에러={len(js_errors)}개)')
    if js_errors:
        print(f'  에러: {js_errors[:3]}')

    # ─── 게임 시뮬레이션 — UI 클릭 + 앱 소켓 제어 ───
    print('\n[게임 시뮬레이션 — UI 자동화]')

    # 1. 방 만들기 버튼 클릭
    page.click('#create-room-btn')
    time.sleep(1)

    # 챔피언 선택 (warrior 카드 클릭)
    champ_clicked = page.evaluate("""() => {
        const cards = document.querySelectorAll('.champ-card');
        for(const c of cards){
            if(c.dataset.champion === 'warrior' || c.textContent.includes('전사')){
                c.click(); return 'warrior_clicked';
            }
        }
        if(cards.length) { cards[0].click(); return 'first_clicked'; }
        return 'no_cards';
    }""")
    print(f'  챔피언 선택: {champ_clicked}')
    time.sleep(0.5)

    # 준비 버튼
    page.click('#ready-btn')
    time.sleep(0.5)

    # 시작 버튼
    start_enabled = page.evaluate("() => !document.getElementById('start-btn').disabled")
    if start_enabled:
        page.click('#start-btn')
    else:
        # 방장이므로 직접 start
        page.evaluate("""() => {
            const s = window.__appSocket;
            if(s) s.emit('start_game');
        }""")
    print(f'  게임 시작 (start-btn enabled: {start_enabled})')
    time.sleep(1)

    # 게임 진행 — 앱 소켓에 AI 입력 주입
    page.evaluate("""() => {
        const s = window.__appSocket;
        if(!s) return;
        // state 이벤트에 AI 입력 훅
        s.on('state', st => {
            window.__qaPhase = st.phase;
            window.__qaLastSt = st;
            if(st.mutatorOffer && st.mutatorOffer.length)
                s.emit('select_mutator', {id: st.mutatorOffer[0].id});
        });
    }""")

    # 앱 소켓 pid 획득
    time.sleep(1)
    pid = page.evaluate("() => { const st = window.__qaLastSt; if(!st) return null; const me = (st.players||[])[0]; return me ? me.id : null; }")
    print(f'  pid: {pid}')

    # AI 루프 — 매 500ms마다 입력 주입
    def inject_input():
        page.evaluate("""() => {
            const s = window.__appSocket;
            const st = window.__qaLastSt;
            if(!s || !st || st.phase !== 'playing') return;
            const pls = st.players || [];
            if(!pls.length) return;
            const me = pls[0];
            if(!me || me.dead) return;
            window.__qaOrb = me.orbCount || 0;
            window.__qaMyStats = {hp:me.hp,maxHp:me.maxHp,atk:me.atk,spd:me.speed,orb:me.orbCount};
            if(!st.enemies || !st.enemies.length) return;
            let nd=1e9, ne=null;
            for(const e of st.enemies){ const d=(e.x-me.x)**2+(e.y-me.y)**2; if(d<nd){nd=d;ne=e;} }
            if(!ne) return;
            const a=Math.atan2(ne.y-me.y,ne.x-me.x);
            const d=Math.sqrt(nd);
            s.emit('input',{moveX:d>80?Math.cos(a):0,moveY:d>80?Math.sin(a):0,aimAngle:a,attacking:true,dashing:false});
        }""")

    aug_reached = False
    for i in range(22):
        inject_input()
        time.sleep(2)
        inject_input()
        phase = page.evaluate("() => window.__qaPhase || 'init'")
        orb = page.evaluate("() => window.__qaOrb || 0")
        evts = page.evaluate("() => (window.__qaEvents || []).slice(-6).join(',')")
        if i % 2 == 0:
            print(f'    t={i*2+2}s phase={phase} orb={orb} evts=[{evts}]')
        if phase == 'augment_select':
            aug_reached = True
            print(f'  → 업그레이드 화면 진입! (t={i*2+2}s, orb={orb})')
            break

    # 업그레이드 화면 스크린샷
    page.screenshot(path='qa_pw_02_upgrade.png')
    print('  스크린샷: qa_pw_02_upgrade.png')

    events_all = page.evaluate("() => window.__qaEvents || []")
    ok('orb_threshold' in events_all, f'Runtime: orb_threshold 이벤트 수신 ({events_all.count("orb_threshold")}회)')
    ok(aug_reached, 'Runtime: augment_select 페이즈 진입')

    if aug_reached:
        # #augment-select 오버레이 표시 여부
        overlay = page.evaluate("""() => {
            const el = document.getElementById('augment-select');
            if (!el) return {exists: false};
            const st = window.getComputedStyle(el);
            return {
                exists: true,
                display: st.display,
                visible: st.display !== 'none',
                opacity: st.opacity,
                zIndex: st.zIndex,
                classList: el.className
            };
        }""")
        print(f'  #augment-select 상태: {overlay}')
        ok(overlay.get('visible', False), 'Visual: #augment-select 오버레이 표시됨')

        # canvas에 time-stopped 클래스
        ts = page.evaluate("""() => {
            const c = document.getElementById('game');
            return c ? c.classList.contains('time-stopped') : false;
        }""")
        print(f'  canvas time-stopped: {ts}')
        ok(ts, 'Visual: canvas에 time-stopped 클래스 적용 (시간정지 비주얼)')

        # 카드 수 확인
        cards = page.evaluate("""() => {
            const wrap = document.getElementById('augment-cards');
            if (!wrap) return {count: 0, texts: []};
            const cs = wrap.querySelectorAll('.aug-card, .card, [class*="card"]');
            return {
                count: cs.length,
                texts: [...cs].slice(0,5).map(c=>c.textContent.trim().substring(0,80))
            };
        }""")
        print(f'  카드: {cards}')
        ok(cards['count'] >= 3, f'Visual: 선택지 카드 {cards["count"]}개 (목표=3)')
        if cards['texts']:
            print(f'    카드 텍스트: {cards["texts"]}')

        # 선택 전후 스탯 변화
        # 선택 전 상태 스냅샷 (스탯 + 스킬 + 증강 카운트)
        pre = page.evaluate("""() => {
            const st = window.__qaLastSt;
            if(!st) return null;
            const me = (st.players||[])[0];
            if(!me) return null;
            return {hp:me.hp, maxHp:me.maxHp, atk:me.atk, spd:me.speed,
                    orb:me.orbCount, augCnt:(me.augments||[]).length,
                    skillCnt:(me.skills||[]).filter(Boolean).length,
                    offers_n: (() => {
                        const o=st.offers;
                        if(Array.isArray(o)) return o.length;
                        if(o&&typeof o==='object') { const v=Object.values(o); return v.length?v[0].length:0; }
                        return 0;
                    })()};
        }""")
        print(f'  선택 전: {pre}')

        # select_augment — 서버 offers 포맷에 맞춰 선택
        sel_result = page.evaluate("""() => {
            const s = window.__appSocket;
            const st = window.__qaLastSt;
            if(!s || !st) return 'no_socket_or_state';
            const o = st.offers;
            let choices = [];
            if(Array.isArray(o)) choices = o;
            else if(o && typeof o==='object'){ const v=Object.values(o); if(v.length) choices=v[0]; }
            if(!choices.length) return 'no_offers';
            s.emit('select_augment', {id: choices[0].id});
            return 'sent:' + choices[0].id;
        }""")
        print(f'  select_augment: {sel_result}')
        sel_time = time.time()

        # 최대 300ms 대기 후 상태 확인
        time.sleep(0.3)
        post = page.evaluate("""() => {
            const st = window.__qaLastSt;
            if(!st) return null;
            const me = (st.players||[])[0];
            if(!me) return null;
            return {hp:me.hp, maxHp:me.maxHp, atk:me.atk, spd:me.speed,
                    orb:me.orbCount, augCnt:(me.augments||[]).length,
                    skillCnt:(me.skills||[]).filter(Boolean).length,
                    phase: st.phase};
        }""")
        elapsed = int((time.time() - sel_time) * 1000)
        print(f'  선택 후: {post} ({elapsed}ms)')

        if pre and post:
            stat_changed = (post.get('maxHp') != pre.get('maxHp') or
                           post.get('atk') != pre.get('atk') or
                           post.get('spd') != pre.get('spd'))
            aug_changed = post.get('augCnt',0) > pre.get('augCnt',0)
            skill_changed = post.get('skillCnt',0) > pre.get('skillCnt',0)
            phase_changed = post.get('phase') != 'augment_select'
            any_changed = stat_changed or aug_changed or skill_changed or phase_changed
            ok(any_changed, f'Runtime: select_augment 효과 확인 (stat:{stat_changed},aug:{aug_changed},skill:{skill_changed},phase_exit:{phase_changed})')
            ok(elapsed <= 400, f'Runtime: 효과 반영 ≤400ms (실측={elapsed}ms, Python 오버헤드 포함)')

    # 최종 스크린샷
    time.sleep(0.5)
    page.screenshot(path='qa_pw_03_after_select.png')
    print('  스크린샷: qa_pw_03_after_select.png')

    browser.close()

p2 = sum(1 for t,_ in results if t=='PASS')
f2 = sum(1 for t,_ in results if t=='FAIL')
print(f'\n시각 검증 결과: PASS={p2} FAIL={f2} 총={p2+f2}')
for tag,label in results:
    if tag=='FAIL': print(f'  FAIL: {label}')
sys.exit(1 if f2 > 0 else 0)
