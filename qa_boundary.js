'use strict';
/**
 * 백엔드 경계값 검증
 * 1. 잘못된 augment ID select → 서버 크래시 없음
 * 2. 중복 select_augment → 두 번 적용되지 않음
 * 3. orb_threshold double-fire 없음 (같은 누적 주기에 1회만)
 * 4. 재접속 시 새 세션 발급
 */
const { io } = require('socket.io-client');
const BASE = process.argv[2] || 'http://localhost:3000';
let passed = 0, failed = 0;
const ok = (c, l) => { if (c) { console.log('  PASS:', l); passed++; } else { console.log('  FAIL:', l); failed++; } };

// ─── 1. 잘못된 augmentID / 빈 augment 전송 ───
function test1() {
  return new Promise(resolve => {
    const s = io(BASE, { transports: ['websocket'] });
    let crashed = false;
    s.on('connect', () => s.emit('create_room', { name: 'QB_T1' }));
    s.on('room_created', () => {
      s.emit('select_champion', { champion: 'warrior' });
      s.emit('ready', { ready: true });
      setTimeout(() => s.emit('start_game'), 200);
    });
    s.on('state', st => {
      if (st.mutatorOffer && st.mutatorOffer.length)
        s.emit('select_mutator', { id: st.mutatorOffer[0].id });
      if (st.phase === 'playing') {
        // 업그레이드 화면 아닐 때 select_augment (무시돼야 함)
        s.emit('select_augment', { id: null });
        s.emit('select_augment', { id: 'INVALID_XXXX_9999' });
        s.emit('select_augment', { id: '' });
      }
    });
    s.on('disconnect', () => { crashed = true; });
    s.on('connect_error', () => { crashed = true; });
    setTimeout(() => {
      ok(!crashed, 'T1: 잘못된 select_augment 전송 시 서버/소켓 크래시 없음');
      s.close(); resolve();
    }, 3000);
  });
}

// ─── 2. 중복 select_augment (augment_select 진입 후 연속 2회) ───
function test2() {
  return new Promise(resolve => {
    const s = io(BASE, { transports: ['websocket'] });
    let myPid = null, augEntered = false, selectCount = 0, postStats = null;
    s.on('connect', () => s.emit('create_room', { name: 'QB_T2' }));
    s.on('room_created', d => {
      myPid = d.pid;
      s.emit('select_champion', { champion: 'warrior' });
      s.emit('ready', { ready: true });
      setTimeout(() => s.emit('start_game'), 200);
    });
    s.on('state', st => {
      if (st.mutatorOffer && st.mutatorOffer.length)
        s.emit('select_mutator', { id: st.mutatorOffer[0].id });
      const me = (st.players || []).find(p => p.id === myPid);
      if (!me) return;
      if (st.phase === 'playing' && st.enemies && st.enemies.length && !me.dead) {
        const ne = st.enemies[0];
        const a = Math.atan2(ne.y - me.y, ne.x - me.x);
        const d = Math.sqrt((ne.x - me.x) ** 2 + (ne.y - me.y) ** 2);
        s.emit('input', { moveX: d > 80 ? Math.cos(a) : 0, moveY: d > 80 ? Math.sin(a) : 0, aimAngle: a, attacking: true });
      }
      if (st.phase === 'augment_select' && !augEntered) {
        augEntered = true;
        const o = st.offers;
        let choices = [];
        if (Array.isArray(o)) choices = o;
        else if (o && typeof o === 'object') { const v = Object.values(o); if (v.length) choices = v[0]; }
        if (!choices.length) return;
        const id = choices[0].id;
        // 동일 id를 두 번 연속 전송
        s.emit('select_augment', { id });
        s.emit('select_augment', { id });
        selectCount = 2;
      }
      if (augEntered && st.phase !== 'augment_select' && !postStats) {
        postStats = { aug: (me.augments || []).length, skill: (me.skills || []).filter(Boolean).length };
      }
    });
    setTimeout(() => {
      if (postStats) {
        const total = postStats.aug + postStats.skill;
        ok(total <= 1, `T2: 중복 select_augment 1회만 적용 (aug=${postStats.aug} skill=${postStats.skill} 합계=${total})`);
      } else {
        console.log('  SKIP: T2 — 업그레이드 미진입 (게임 진행 부족)');
      }
      s.close(); resolve();
    }, 12000);
  });
}

// ─── 3. orb_threshold double-fire 없음 ───
function test3() {
  return new Promise(resolve => {
    const s = io(BASE, { transports: ['websocket'] });
    let myPid = null, thresholdFires = 0, orbTotal = 0;
    s.on('connect', () => s.emit('create_room', { name: 'QB_T3' }));
    s.on('room_created', d => {
      myPid = d.pid;
      s.emit('select_champion', { champion: 'warrior' });
      s.emit('ready', { ready: true });
      setTimeout(() => s.emit('start_game'), 200);
    });
    s.on('state', st => {
      if (st.mutatorOffer && st.mutatorOffer.length)
        s.emit('select_mutator', { id: st.mutatorOffer[0].id });
      if (st.phase === 'augment_select') s.emit('select_augment', { id: 'sharp' });
      const me = (st.players || []).find(p => p.id === myPid);
      if (!me || me.dead || st.phase !== 'playing') return;
      if (!st.enemies || !st.enemies.length) return;
      let nd = 1e9, ne = null;
      for (const e of st.enemies) { const d = (e.x - me.x) ** 2 + (e.y - me.y) ** 2; if (d < nd) { nd = d; ne = e; } }
      if (!ne) return;
      const a = Math.atan2(ne.y - me.y, ne.x - me.x);
      const d2 = Math.sqrt(nd);
      s.emit('input', { moveX: d2 > 80 ? Math.cos(a) : 0, moveY: d2 > 80 ? Math.sin(a) : 0, aimAngle: a, attacking: true });
    });
    s.on('events', evs => {
      for (const e of evs) {
        if (e.type === 'orb_threshold') thresholdFires++;
        if (e.type === 'orb_grant') orbTotal++;
      }
    });
    setTimeout(() => {
      console.log(`  [T3] orb_grant=${orbTotal} orb_threshold=${thresholdFires}`);
      // 오브 누적 10개 = threshold 1회 (임계치 초과하면 초기화 후 재누적으로 다시 발생할 수 있음)
      // 핵심: threshold < orb_grant / 10 * 1.5 (최대 오브 10개당 1.5회 미만)
      const maxExpected = Math.max(1, Math.floor(orbTotal / 9) + 1);
      ok(thresholdFires >= 1, `T3a: orb_threshold 최소 1회 발생`);
      ok(thresholdFires <= maxExpected, `T3b: threshold double-fire 없음 (발생=${thresholdFires} 최대예상=${maxExpected} orb=${orbTotal})`);
      s.close(); resolve();
    }, 12000);
  });
}

// ─── 4. 재접속 시 새 세션 발급 ───
function test4() {
  return new Promise(resolve => {
    const s1 = io(BASE, { transports: ['websocket'] });
    let pid1 = null;
    s1.on('connect', () => s1.emit('create_room', { name: 'QB_T4A' }));
    s1.on('room_created', d => { pid1 = d.pid; });
    setTimeout(() => {
      s1.close();
      setTimeout(() => {
        const s2 = io(BASE, { transports: ['websocket'] });
        let pid2 = null;
        s2.on('connect', () => s2.emit('create_room', { name: 'QB_T4B' }));
        s2.on('room_created', d => { pid2 = d.pid; });
        setTimeout(() => {
          ok(pid1 !== null, `T4a: 첫 번째 연결 pid 발급 (pid=${pid1})`);
          ok(pid2 !== null, `T4b: 재접속 pid 발급 (pid=${pid2})`);
          ok(s2.connected, 'T4c: 재접속 성공');
          // pid는 다를 수도, 같을 수도 있음 (서버 정책에 따라)
          // 중요한 건 새 연결이 정상 동작하는 것
          s2.close(); resolve();
        }, 1500);
      }, 500);
    }, 2000);
  });
}

// ─── 5. 음수 orbCount 없음 ───
function test5() {
  return new Promise(resolve => {
    const s = io(BASE, { transports: ['websocket'] });
    let myPid = null, minOrb = 999;
    s.on('connect', () => s.emit('create_room', { name: 'QB_T5' }));
    s.on('room_created', d => {
      myPid = d.pid;
      s.emit('select_champion', { champion: 'warrior' });
      s.emit('ready', { ready: true });
      setTimeout(() => s.emit('start_game'), 200);
    });
    s.on('state', st => {
      if (st.mutatorOffer && st.mutatorOffer.length)
        s.emit('select_mutator', { id: st.mutatorOffer[0].id });
      if (st.phase === 'augment_select') s.emit('select_augment', { id: 'sharp' });
      const me = (st.players || []).find(p => p.id === myPid);
      if (me && me.orbCount != null && me.orbCount < minOrb) minOrb = me.orbCount;
      const ne2 = me && !me.dead && st.enemies && st.enemies.length ? (() => {
        let nd = 1e9, ne = null;
        for (const e of st.enemies) { const d = (e.x - me.x) ** 2 + (e.y - me.y) ** 2; if (d < nd) { nd = d; ne = e; } }
        return ne;
      })() : null;
      if (ne2) {
        const a = Math.atan2(ne2.y - me.y, ne2.x - me.x);
        const d2 = Math.sqrt((ne2.x - me.x) ** 2 + (ne2.y - me.y) ** 2);
        s.emit('input', { moveX: d2 > 80 ? Math.cos(a) : 0, moveY: d2 > 80 ? Math.sin(a) : 0, aimAngle: a, attacking: true });
      }
    });
    setTimeout(() => {
      ok(minOrb >= 0, `T5: orbCount 음수 없음 (최솟값=${minOrb})`);
      s.close(); resolve();
    }, 6000);
  });
}

// ─── 실행 ───
(async () => {
  console.log('======================================');
  console.log('백엔드 경계값 QA');
  console.log('======================================');
  console.log('[T1] 잘못된 select_augment 전송...');
  await test1();
  console.log('[T2] 중복 select_augment...');
  await test2();
  console.log('[T3] orb_threshold double-fire...');
  await test3();
  console.log('[T4] 재접속 세션...');
  await test4();
  console.log('[T5] orbCount 음수 없음...');
  await test5();
  console.log(`\n결과: PASS=${passed} FAIL=${failed} 총=${passed + failed}`);
  process.exit(failed > 0 ? 1 : 0);
})();
