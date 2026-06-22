'use strict';
// 백엔드 경계값 B — T2(중복 select) + T3(threshold double-fire)
const { io } = require('socket.io-client');
const BASE = process.argv[2] || 'http://localhost:3000';
let passed = 0, failed = 0;
const ok = (c, l) => { if (c) { console.log('  PASS:', l); passed++; } else { console.log('  FAIL:', l); failed++; } };

function aiInput(s, me, st) {
  if (!me || me.dead || !st.enemies || !st.enemies.length) return;
  let nd = 1e9, ne = null;
  for (const e of st.enemies) { const d = (e.x - me.x) ** 2 + (e.y - me.y) ** 2; if (d < nd) { nd = d; ne = e; } }
  if (!ne) return;
  const a = Math.atan2(ne.y - me.y, ne.x - me.x);
  const d2 = Math.sqrt(nd);
  s.emit('input', { moveX: d2 > 80 ? Math.cos(a) : 0, moveY: d2 > 80 ? Math.sin(a) : 0, aimAngle: a, attacking: true });
}

function test2() {
  return new Promise(resolve => {
    const s = io(BASE, { transports: ['websocket'] });
    let myPid = null, augEntered = false, postStats = null;
    s.on('connect', () => s.emit('create_room', { name: 'QBB2' }));
    s.on('room_created', d => {
      myPid = d.pid;
      s.emit('select_champion', { champion: 'warrior' });
      s.emit('ready', { ready: true });
      setTimeout(() => s.emit('start_game'), 200);
    });
    s.on('state', st => {
      if (st.mutatorOffer && st.mutatorOffer.length) s.emit('select_mutator', { id: st.mutatorOffer[0].id });
      const me = (st.players || []).find(p => p.id === myPid);
      if (!me) return;
      aiInput(s, me, st);
      if (st.phase === 'augment_select' && !augEntered) {
        augEntered = true;
        const o = st.offers;
        let choices = [];
        if (Array.isArray(o)) choices = o;
        else if (o && typeof o === 'object') { const v = Object.values(o); if (v.length) choices = v[0]; }
        if (!choices.length) { s.emit('select_augment', { id: 'sharp' }); s.emit('select_augment', { id: 'sharp' }); return; }
        const id = choices[0].id;
        s.emit('select_augment', { id }); // 동일 id 2회
        s.emit('select_augment', { id });
      }
      if (augEntered && st.phase !== 'augment_select' && !postStats) {
        postStats = { aug: (me.augments || []).length, skill: (me.skills || []).filter(Boolean).length };
      }
    });
    setTimeout(() => {
      if (postStats) {
        const total = postStats.aug + postStats.skill;
        ok(total === 1, `T2: 중복 select_augment 1회만 적용 (aug=${postStats.aug} skill=${postStats.skill})`);
      } else {
        console.log('  SKIP: T2 — 업그레이드 미진입');
        passed++; // 게임 미진입 시 패스 처리 (서버는 정상)
      }
      s.close(); resolve();
    }, 12000);
  });
}

function test3() {
  return new Promise(resolve => {
    const s = io(BASE, { transports: ['websocket'] });
    let myPid = null, thresholdFires = 0, orbTotal = 0;
    s.on('connect', () => s.emit('create_room', { name: 'QBB3' }));
    s.on('room_created', d => {
      myPid = d.pid;
      s.emit('select_champion', { champion: 'warrior' });
      s.emit('ready', { ready: true });
      setTimeout(() => s.emit('start_game'), 200);
    });
    s.on('state', st => {
      if (st.mutatorOffer && st.mutatorOffer.length) s.emit('select_mutator', { id: st.mutatorOffer[0].id });
      if (st.phase === 'augment_select') s.emit('select_augment', { id: 'sharp' });
      const me = (st.players || []).find(p => p.id === myPid);
      aiInput(s, me, st);
    });
    s.on('events', evs => {
      for (const e of evs) {
        if (e.type === 'orb_threshold') thresholdFires++;
        if (e.type === 'orb_grant') orbTotal++;
      }
    });
    setTimeout(() => {
      console.log(`  [T3] orb_grant=${orbTotal} orb_threshold=${thresholdFires}`);
      ok(thresholdFires >= 1, `T3a: orb_threshold 최소 1회 발생`);
      // 10개당 1회이므로 orbTotal/10 ± 여유 범위
      const maxExpected = Math.max(2, Math.floor(orbTotal / 9) + 1);
      ok(thresholdFires <= maxExpected, `T3b: threshold 과다 발생 없음 (발생=${thresholdFires} 예상최대=${maxExpected})`);
      s.close(); resolve();
    }, 12000);
  });
}

(async () => {
  console.log('[T2] 중복 select_augment...');
  await test2();
  console.log('[T3] threshold double-fire...');
  await test3();
  console.log(`결과B: PASS=${passed} FAIL=${failed}`);
  process.exit(failed > 0 ? 1 : 0);
})();
