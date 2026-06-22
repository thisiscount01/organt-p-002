'use strict';
// 백엔드 경계값 A — T1(잘못된 aug) + T4(재접속) + T5(음수orb)
const { io } = require('socket.io-client');
const BASE = process.argv[2] || 'http://localhost:3000';
let passed = 0, failed = 0;
const ok = (c, l) => { if (c) { console.log('  PASS:', l); passed++; } else { console.log('  FAIL:', l); failed++; } };

function test1() {
  return new Promise(resolve => {
    const s = io(BASE, { transports: ['websocket'] });
    let crashed = false;
    s.on('connect', () => s.emit('create_room', { name: 'QBA1' }));
    s.on('room_created', () => {
      s.emit('select_champion', { champion: 'warrior' });
      s.emit('ready', { ready: true });
      setTimeout(() => s.emit('start_game'), 200);
    });
    s.on('state', st => {
      if (st.mutatorOffer && st.mutatorOffer.length) s.emit('select_mutator', { id: st.mutatorOffer[0].id });
      if (st.phase === 'playing') {
        s.emit('select_augment', { id: null });
        s.emit('select_augment', { id: 'INVALID_XXXX_9999' });
        s.emit('select_augment', { id: '' });
        s.emit('select_augment', {}); // id 없음
      }
    });
    s.on('disconnect', () => { crashed = true; });
    setTimeout(() => {
      ok(!crashed, 'T1: 잘못된 select_augment 전송 시 서버 크래시 없음');
      s.close(); resolve();
    }, 4000);
  });
}

function test4() {
  return new Promise(resolve => {
    const s1 = io(BASE, { transports: ['websocket'] });
    let pid1 = null;
    s1.on('connect', () => s1.emit('create_room', { name: 'QBA4A' }));
    s1.on('room_created', d => { pid1 = d.pid; });
    setTimeout(() => {
      s1.close();
      setTimeout(() => {
        const s2 = io(BASE, { transports: ['websocket'] });
        let pid2 = null;
        s2.on('connect', () => s2.emit('create_room', { name: 'QBA4B' }));
        s2.on('room_created', d => { pid2 = d.pid; });
        setTimeout(() => {
          ok(pid1 !== null, `T4a: 1차 연결 pid 발급 (pid=${pid1})`);
          ok(pid2 !== null, `T4b: 재접속 pid 발급 (pid=${pid2})`);
          ok(s2.connected, 'T4c: 재접속 성공');
          s2.close(); resolve();
        }, 1500);
      }, 500);
    }, 2000);
  });
}

function test5() {
  return new Promise(resolve => {
    const s = io(BASE, { transports: ['websocket'] });
    let myPid = null, minOrb = 999;
    s.on('connect', () => s.emit('create_room', { name: 'QBA5' }));
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
      if (me && me.orbCount != null && me.orbCount < minOrb) minOrb = me.orbCount;
      if (me && !me.dead && st.enemies && st.enemies.length) {
        let nd = 1e9, ne = null;
        for (const e of st.enemies) { const d = (e.x - me.x) ** 2 + (e.y - me.y) ** 2; if (d < nd) { nd = d; ne = e; } }
        if (ne) {
          const a = Math.atan2(ne.y - me.y, ne.x - me.x);
          const d2 = Math.sqrt(nd);
          s.emit('input', { moveX: d2 > 80 ? Math.cos(a) : 0, moveY: d2 > 80 ? Math.sin(a) : 0, aimAngle: a, attacking: true });
        }
      }
    });
    setTimeout(() => {
      ok(minOrb >= 0, `T5: orbCount 음수 없음 (최솟값=${minOrb !== 999 ? minOrb : 'N/A'})`);
      s.close(); resolve();
    }, 6000);
  });
}

(async () => {
  console.log('[T1] 잘못된 select_augment...');
  await test1();
  console.log('[T4] 재접속...');
  await test4();
  console.log('[T5] orbCount 음수...');
  await test5();
  console.log(`결과A: PASS=${passed} FAIL=${failed}`);
  process.exit(failed > 0 ? 1 : 0);
})();
