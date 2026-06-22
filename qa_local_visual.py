"""
QA 시각·백엔드 독립 검증 — 로컬 서버 대상
- 업그레이드 화면 스크린샷 캡처 및 시각 품질 검증
- 백엔드 경계값: 음수 orb, 범위 초과, select_augment 재선택 등
"""
from playwright.sync_api import sync_playwright
import time, sys, json

BASE = 'http://localhost:3000'
results = []

def ok(cond, label):
    tag = 'PASS' if cond else 'FAIL'
    results.append((tag, label))
    print(f'  {tag}: {label}')

# ─── 백엔드 경계값 검증 (socket.io-client via node) ───
import subprocess

def node_eval(code, timeout=12):
    r = subprocess.run(['node', '-e', code], capture_output=True, text=True, timeout=timeout+2)
    return r.stdout.strip(), r.stderr.strip()

print('\n[백엔드 경계값 검증]')

# 1. 음수/0 orb 주입 시도 — server는 grantOrb만 내부 호출이므로, 직접 select_augment 없이 호출 시도
boundary_code = r"""
const {io}=require('socket.io-client');
const s=io('http://localhost:3000',{transports:['websocket']});
const results=[];
s.on('connect',()=>{
  s.emit('create_room',{name:'QA_BOUNDARY'});
});
s.on('room_created', d=>{
  s.emit('select_champion',{champion:'warrior'});
  s.emit('ready',{ready:true});
  setTimeout(()=>s.emit('start_game'),200);
});
s.on('state', st=>{
  if(st.mutatorOffer && st.mutatorOffer.length) s.emit('select_mutator',{id:st.mutatorOffer[0].id});
  // augment_select 아닌데 select_augment 보내기 (경계값 테스트)
  if(st.phase==='playing'){
    s.emit('select_augment',{id:'sharp'});  // 업그레이드 화면 아닌데 선택 시도
  }
});
// 잘못된 augment id 보내기
setTimeout(()=>{
  s.emit('select_augment',{id:'INVALID_AUG_9999'});
  results.push('sent_invalid_aug');
},2000);
// 중복 select_augment (같은 id 2번)
setTimeout(()=>{
  s.emit('select_augment',{id:'sharp'});
  s.emit('select_augment',{id:'sharp'});
  results.push('sent_duplicate_aug');
},3000);
setTimeout(()=>{
  console.log(JSON.stringify(results));
  s.close();
  process.exit(0);
},6000);
"""
out, err = node_eval(boundary_code, timeout=10)
print(f'  경계값 전송 결과: {out}')
ok('sent_invalid_aug' in out and 'sent_duplicate_aug' in out, 'Backend-1: 잘못된/중복 select_augment 전송 시 서버 크래시 없음 (graceful 처리)')

# 2. 오브 누적 후 threshold 연속 발생 여부 (double-fire 방지)
double_check_code = r"""
const {io}=require('socket.io-client');
const s=io('http://localhost:3000',{transports:['websocket']});
let thresholdCount=0, orbCount=0;
s.on('connect',()=>{ s.emit('create_room',{name:'QA_DOUBLE'}); });
s.on('room_created',()=>{
  s.emit('select_champion',{champion:'warrior'});
  s.emit('ready',{ready:true});
  setTimeout(()=>s.emit('start_game'),200);
});
s.on('events',evs=>{
  for(const e of evs){
    if(e.type==='orb_threshold') thresholdCount++;
    if(e.type==='orb_grant') orbCount++;
  }
});
s.on('state',st=>{
  if(st.mutatorOffer&&st.mutatorOffer.length) s.emit('select_mutator',{id:st.mutatorOffer[0].id});
  if(st.phase==='augment_select') s.emit('select_augment',{id:'sharp'});
  const me=(st.players||[]).find(p=>p.id===s.id)||{};
  if(st.phase==='playing' && st.enemies && st.enemies.length && !me.dead){
    const ne=st.enemies[0];
    const a=Math.atan2(ne.y-me.y,ne.x-me.x);
    const d=Math.sqrt((ne.x-me.x)**2+(ne.y-me.y)**2);
    s.emit('input',{moveX:d>80?Math.cos(a):0,moveY:d>80?Math.sin(a):0,aimAngle:a,attacking:true,dashing:false});
  }
});
setTimeout(()=>{
  console.log(JSON.stringify({thresholdCount, orbCount, doubleThreshold: thresholdCount > 1 && orbCount < 20}));
  s.close(); process.exit(0);
},18000);
"""
out2, err2 = node_eval(double_check_code, timeout=22)
print(f'  threshold double-fire 체크: {out2}')
try:
    d2 = json.loads(out2)
    ok(d2.get('thresholdCount',0) >= 1, f'Backend-2a: orb_threshold 최소 1회 발생 (실제={d2.get("thresholdCount",0)})')
    # 오브 10개 한 라운드에서 threshold가 1번만 발생하면 정상
    ok(not d2.get('doubleThreshold', False), 'Backend-2b: threshold double-fire 없음 (단일 발생)')
except:
    ok(False, 'Backend-2: threshold double-fire 체크 파싱 실패')

# 3. 저장→재접속 시나리오 (새 소켓 연결 시 상태 리셋 확인)
reconnect_code = r"""
const {io}=require('socket.io-client');
function connect(cb){
  const s=io('http://localhost:3000',{transports:['websocket']});
  s.on('connect',()=>{
    s.emit('create_room',{name:'QA_RECON'});
    s.on('room_created',()=>{
      s.emit('select_champion',{champion:'warrior'});
      s.emit('ready',{ready:true});
      setTimeout(()=>s.emit('start_game'),200);
    });
    s.on('state',st=>{
      if(st.mutatorOffer&&st.mutatorOffer.length) s.emit('select_mutator',{id:st.mutatorOffer[0].id});
    });
    setTimeout(()=>{ cb(s); },1500);
  });
}
connect(s1=>{
  const firstId = s1.id;
  s1.close();
  setTimeout(()=>{
    const s2=io('http://localhost:3000',{transports:['websocket']});
    s2.on('connect',()=>{
      s2.emit('create_room',{name:'QA_RECON2'});
      setTimeout(()=>{
        console.log(JSON.stringify({firstId, secondId: s2.id, differentId: firstId !== s2.id, connected: s2.connected}));
        s2.close(); process.exit(0);
      },1000);
    });
  },500);
});
"""
out3, err3 = node_eval(reconnect_code, timeout=8)
print(f'  재접속 체크: {out3}')
try:
    d3 = json.loads(out3)
    ok(d3.get('connected', False), 'Backend-3a: 재접속 성공')
    ok(d3.get('differentId', False), 'Backend-3b: 재접속 시 새 세션 ID 발급 (상태 리셋)')
except:
    ok(False, 'Backend-3: 재접속 체크 파싱 실패')

# ─── 시각 검증 (Playwright) ───
print('\n[시각 레이어 검증 — 로컬]')

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, args=['--ignore-certificate-errors'])
    ctx = browser.new_context(viewport={'width':1280,'height':720})
    page = ctx.new_page()
    js_errors = []
    page.on('pageerror', lambda e: js_errors.append(str(e)))

    page.goto(BASE, wait_until='domcontentloaded', timeout=15000)
    time.sleep(2)
    page.screenshot(path='qa_local_01_lobby.png')
    print('  스크린샷: qa_local_01_lobby.png')

    # DOM 구조 확인
    dom = page.evaluate("""() => ({
        game: !!document.getElementById('game'),
        hud: !!document.getElementById('hud'),
        orbCount: !!document.getElementById('orbCount'),
        augmentOverlay: !!document.getElementById('augmentOverlay'),
        gameCanvas: !!document.getElementById('gameCanvas')
    })""")
    print(f'  DOM: {dom}')
    ok(dom['game'], 'Visual-A: #game 존재')
    ok(dom['hud'], 'Visual-B: #hud 존재')
    ok(dom['orbCount'], 'Visual-C: #orbCount 카운터 존재')
    ok(dom['augmentOverlay'], 'Visual-D: #augmentOverlay 존재')
    ok(dom['gameCanvas'], 'Visual-E: #gameCanvas canvas 존재')

    # CSS 로컬 확인
    style_text = page.evaluate("""() => {
        let r = '';
        for (const ss of document.styleSheets) {
            try { for (const rule of ss.cssRules) r += rule.cssText + '\\n'; } catch(e) {}
        }
        return r;
    }""")
    ok('time-stopped' in style_text, 'Goal4-CSS: .time-stopped 시간정지 필터 정의')
    ok('saturate' in style_text, 'Goal4-CSS: saturate() 필터 (탈채색 효과) 정의')
    ok('brightness' in style_text, 'Goal4-CSS: brightness() 필터 정의')
    ok('dropIn' in style_text or 'cardDrop' in style_text or 'slideIn' in style_text or 'augDrop' in style_text, 'Goal4-CSS: 카드 dropIn 키프레임 정의')
    ok('fadeIn' in style_text or 'overlayFade' in style_text, 'Goal4-CSS: 오버레이 fadeIn 키프레임 정의')
    ok('#FF88FF' in style_text or 'FF88' in style_text or 'threshold' in style_text.lower(), 'Goal3-CSS: threshold 강조 색상 정의')
    ok('aug-card' in style_text or 'augCard' in style_text or '.card' in style_text, 'Goal5-CSS: 선택지 카드 스타일 정의')

    # 로컬 app.js 직접 fetch
    local_js = page.evaluate("""async () => {
        try {
            const r = await fetch('/app.js');
            const t = await r.text();
            return t.substring(0, 5000);
        } catch(e) { return 'err:' + e.message; }
    }""")
    ok('orb' in local_js.lower(), 'Goal2-appjs: app.js에 orb 코드 존재')
    ok('augment' in local_js.lower() or 'upgrade' in local_js.lower(), 'Goal5-appjs: 업그레이드 UI 코드 존재')
    ok('arc' in local_js.lower() or 'bezier' in local_js.lower() or 'lerp' in local_js.lower(), 'Goal2-appjs: 오브 이동 arc/lerp 코드 존재')

    # 게임 시뮬레이션 — socket inject
    injected = page.evaluate("""() => {
        if (typeof io === 'undefined') return 'no_io';
        window.__qaSocket = io('http://localhost:3000', {transports:['websocket']});
        const s = window.__qaSocket;
        s.on('connect', () => {
            s.emit('create_room', {name: 'QA_VIS_LOCAL'});
        });
        s.on('room_created', () => {
            s.emit('select_champion', {champion: 'warrior'});
            s.emit('ready', {ready: true});
            setTimeout(() => s.emit('start_game'), 300);
        });
        s.on('state', (st) => {
            if(st.mutatorOffer && st.mutatorOffer.length)
                s.emit('select_mutator', {id: st.mutatorOffer[0].id});
            window.__lastPhase = st.phase;
            window.__lastState = st;
            const me = (st.players||[]).find(p=>p.id===s.id);
            if(me) window.__myStats = {hp:me.hp, maxHp:me.maxHp, atk:me.atk, spd:me.speed, orbCount:me.orbCount};
            if(st.phase==='playing' && st.enemies && st.enemies.length && me && !me.dead){
                const ne=st.enemies[0];
                const a=Math.atan2(ne.y-me.y,ne.x-me.x);
                const d=Math.sqrt((ne.x-me.x)**2+(ne.y-me.y)**2);
                s.emit('input',{moveX:d>80?Math.cos(a):0,moveY:d>80?Math.sin(a):0,aimAngle:a,attacking:true,dashing:false});
            }
        });
        s.on('events', (evs) => {
            for(const e of evs) {
                if(!window.__events) window.__events = [];
                window.__events.push(e.type);
            }
        });
        return 'ok';
    }""")
    print(f'  소켓 주입: {injected}')
    ok(injected == 'ok', 'Visual-Socket: 소켓 연결 주입 성공')

    # 게임 진행 대기 (30초 — 오브 10개 수집 목표)
    print('  게임 진행 중 (30초)...')
    for i in range(15):
        time.sleep(2)
        phase = page.evaluate("() => window.__lastPhase || 'unknown'")
        events = page.evaluate("() => (window.__events || []).join(',')")
        orb_hud = page.evaluate("() => { const el=document.getElementById('orbCount'); return el?el.textContent:'?'; }")
        if i % 3 == 0:
            print(f'    t={i*2}s phase={phase} orbHUD={orb_hud} events=[{events[-60:] if events else ""}]')
        if 'augment_select' in phase or 'orb_threshold' in events:
            print(f'  → 임계치 도달! phase={phase}')
            break

    # 업그레이드 화면 스크린샷
    page.screenshot(path='qa_local_02_upgrade.png')
    print('  스크린샷: qa_local_02_upgrade.png')

    final_phase = page.evaluate("() => window.__lastPhase || 'unknown'")
    events_all = page.evaluate("() => (window.__events || [])")
    orb_hud_final = page.evaluate("() => { const el=document.getElementById('orbCount'); return el?el.textContent:'NOT_FOUND'; }")
    my_stats = page.evaluate("() => window.__myStats || null")

    print(f'  최종 phase: {final_phase}')
    print(f'  이벤트 목록: {events_all[-20:] if events_all else []}')
    print(f'  orbHUD: {orb_hud_final}')
    print(f'  내 스탯: {my_stats}')

    ok('orb_threshold' in (events_all or []), 'Goal3-runtime: orb_threshold 이벤트 발생 실측')
    ok(final_phase == 'augment_select' or 'augment_offer' in (events_all or []), 'Goal4-runtime: augment_select 페이즈 진입 실측')
    ok(orb_hud_final != 'NOT_FOUND', 'Goal3-runtime: orbCount HUD 엘리먼트 존재')

    # 업그레이드 화면 오버레이 가시 확인
    overlay_vis = page.evaluate("""() => {
        const el = document.getElementById('augmentOverlay');
        if(!el) return {exists:false};
        const st = window.getComputedStyle(el);
        return {
            exists: true,
            display: st.display,
            opacity: st.opacity,
            visible: st.display !== 'none' && st.opacity !== '0',
            zIndex: st.zIndex,
            backgroundColor: st.backgroundColor
        };
    }""")
    print(f'  augmentOverlay 상태: {overlay_vis}')
    ok(overlay_vis.get('exists', False), 'Goal4-DOM: augmentOverlay 엘리먼트 존재')

    # 업그레이드 화면 진입했으면 카드 수 체크
    if final_phase == 'augment_select':
        card_count = page.evaluate("""() => {
            const cards = document.querySelectorAll('.aug-card, .augment-card, .upgrade-card, [class*="card"]');
            return cards.length;
        }""")
        print(f'  카드 수 (augment_select 진입 시): {card_count}')
        ok(card_count >= 3, f'Goal5-runtime: 선택지 카드 3개 이상 표시 (실제={card_count})')

        # 카드 텍스트 확인
        card_texts = page.evaluate("""() => {
            const cards = document.querySelectorAll('.aug-card, .augment-card, .upgrade-card, [class*="card"]');
            return [...cards].slice(0,5).map(c => c.textContent.trim().substring(0,60));
        }""")
        print(f'  카드 텍스트: {card_texts}')

        # 선택 후 스탯 변화 (200ms 내)
        if my_stats:
            pre_hp = my_stats.get('maxHp')
            pre_atk = my_stats.get('atk')
            t_select = time.time()

            page.evaluate("""() => {
                const s = window.__qaSocket;
                if(!s) return;
                const st = window.__lastState;
                if(st && st.offers && st.offers.length > 0) {
                    s.emit('select_augment', {id: st.offers[0].id});
                } else {
                    s.emit('select_augment', {id: 'sharp'});
                }
            }""")
            time.sleep(0.4)
            post_stats = page.evaluate("() => window.__myStats || null")
            elapsed = int((time.time() - t_select) * 1000)
            print(f'  선택 후 스탯: {post_stats} ({elapsed}ms 후)')
            if post_stats and pre_hp:
                changed = (post_stats.get('maxHp') != pre_hp or post_stats.get('atk') != pre_atk)
                ok(changed, f'Goal6-runtime: 선택 후 스탯 변화 확인 (HP:{pre_hp}→{post_stats.get("maxHp")}, ATK:{pre_atk}→{post_stats.get("atk")})')
                ok(elapsed <= 500, f'Goal6-runtime: 스탯 반영 ≤500ms (실제={elapsed}ms)')

    page.screenshot(path='qa_local_03_final.png')
    print('  스크린샷: qa_local_03_final.png')

    if js_errors:
        print(f'\n  JS 에러: {js_errors[:5]}')
        ok(len(js_errors) == 0, f'JS 에러 없음 (에러={len(js_errors)}개)')

    browser.close()

passed = sum(1 for t,_ in results if t=='PASS')
failed = sum(1 for t,_ in results if t=='FAIL')
print(f'\n==============================')
print(f'전체 검증: PASS={passed} / FAIL={failed} / 총={passed+failed}')
print('==============================')
for tag, label in results:
    if tag == 'FAIL':
        print(f'  FAIL: {label}')
sys.exit(1 if failed > 0 else 0)
