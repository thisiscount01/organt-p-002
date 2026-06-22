// 부활 직접 관찰(60s 내): 3인 방. p2는 적에게 돌진해 빨리 다운, host/p3는 회피·공격으로 생존 → p2 부활 관찰.
const { io } = require('socket.io-client');
const URL = 'http://localhost:3000';
function mk() { return io(URL, { transports: ['websocket'], forceNew: true }); }
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const host = mk(); let code = null, S = null, sawRevive = false, gameOver = false, maxET = 0;
  host.on('room_created', d => code = d.code);
  host.on('state', s => { S = s; maxET = Math.max(maxET, s.enemiesTotal || 0); });
  host.on('events', evs => { for (const e of evs) { if (e.type === 'player_revived') sawRevive = true; if (e.type === 'game_over') gameOver = true; } });
  host.on('connect', () => host.emit('create_room', { name: 'HOST' }));
  await sleep(450);
  const p2 = mk(); let p2pid = null; p2.on('room_joined', d => p2pid = d.pid);
  p2.on('connect', () => p2.emit('join_room', { code, name: 'P2' }));
  const p3 = mk(); p3.on('connect', () => p3.emit('join_room', { code, name: 'P3' }));
  await sleep(500);
  host.emit('select_champion', { champion: 'warrior' });
  p2.emit('select_champion', { champion: 'mage' });
  p3.emit('select_champion', { champion: 'archer' });
  await sleep(250);
  host.emit('ready', { ready: true }); p2.emit('ready', { ready: true }); p3.emit('ready', { ready: true });
  await sleep(300);
  host.emit('start_game');
  await sleep(600);

  let p2Down = false, p2Revived = false, wasDown = false;
  const t0 = Date.now(); let a = 0;
  function survive(sock, pid) {
    if (!S || !S.players) return;
    const me = S.players.find(p => p.id === pid); if (!me) return;
    let nd = 1e9, ne = null;
    for (const en of (S.enemies || [])) { const dx = en.x - me.x, dy = en.y - me.y, d = dx * dx + dy * dy; if (d < nd) { nd = d; ne = en; } }
    const aim = ne ? Math.atan2(ne.y - me.y, ne.x - me.x) : 0;
    // 가장 가까운 적 반대로 도망 + 공격 + 대시
    sock.emit('input', { moveX: -Math.cos(aim) + Math.cos(a) * 0.3, moveY: -Math.sin(aim) + Math.sin(a) * 0.3, aimAngle: aim, attacking: true, dashing: (Math.floor(a * 4) % 5 === 0) });
  }
  while (Date.now() - t0 < 52000 && !gameOver && !sawRevive) {
    a += 0.35;
    const meHost = S && S.players && S.players.find(p => p.id !== p2pid);
    survive(host, meHost ? meHost.id : null);
    // p3 생존
    if (S && S.players) { const others = S.players.filter(p => p.id !== p2pid); if (others[1]) survive(p3, others[1].id); }
    // p2: 가장 가까운 적으로 돌진(자살) — 빨리 다운
    if (S && S.players) {
      const me2 = S.players.find(p => p.id === p2pid);
      if (me2 && !me2.dead) {
        let nd = 1e9, ne = null;
        for (const en of (S.enemies || [])) { const dx = en.x - me2.x, dy = en.y - me2.y, d = dx * dx + dy * dy; if (d < nd) { nd = d; ne = en; } }
        const aim = ne ? Math.atan2(ne.y - me2.y, ne.x - me2.x) : 0;
        p2.emit('input', { moveX: Math.cos(aim), moveY: Math.sin(aim), aimAngle: aim, attacking: false, dashing: false });
      }
      if (me2 && me2.dead && me2.reviveAt > 0) { p2Down = true; wasDown = true; }
      if (wasDown && me2 && !me2.dead) p2Revived = true;
    }
    await sleep(110);
  }
  const ok = (k, v) => console.log('  ' + (v ? 'PASS' : 'FAIL') + ': ' + k);
  ok('p2 다운+부활예약(reviveAt>0)', p2Down);
  ok('player_revived 이벤트 수신', sawRevive);
  ok('p2 부활 후 다시 생존(state.dead=false)', p2Revived);
  console.log('  INFO maxEnemiesTotal(3인)=' + maxET + ' gameOver=' + gameOver);
  console.log('REVIVE_DONE');
  process.exit(0);
})().catch(e => { console.log('ERR', e.message); process.exit(1); });
