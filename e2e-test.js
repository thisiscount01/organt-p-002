// 소켓 레벨 전투 검증(룸 흐름): create_room(solo)→ready→start→변이→직접조준 플레이→근접 적중.
const { io } = require('socket.io-client');
const s = io('http://localhost:3000', { transports: ['websocket'] });
let myPid = null, gotState = false, gotHit = false, gotAttack = false, sawEnemies = false, lastWave = 0;
let started = false, mutPicked = false, readied = false;
s.on('connect', () => s.emit('create_room', { name: 'SOLO', champion: 'warrior' }));
s.on('room_created', d => { myPid = d.pid; s.emit('ready', { ready: true }); readied = true; setTimeout(() => s.emit('start_game'), 150); });
s.on('game_started', () => started = true);
s.on('state', st => {
  gotState = true; lastWave = st.wave;
  if (st.mutatorOffer && !mutPicked) { s.emit('select_mutator', { id: st.mutatorOffer[0].id }); mutPicked = true; }
  if (st.enemies && st.enemies.length) sawEnemies = true;
  const me = (st.players || []).find(p => p.id === myPid);
  if (me && st.enemies && st.enemies.length) {
    let nd = 1e9, ne = null;
    for (const e of st.enemies) { const d = (e.x - me.x) ** 2 + (e.y - me.y) ** 2; if (d < nd) { nd = d; ne = e; } }
    const a = Math.atan2(ne.y - me.y, ne.x - me.x);
    const inR = Math.sqrt(nd) <= 84 + ne.r - 4;
    s.emit('input', { moveX: inR ? 0 : Math.cos(a), moveY: inR ? 0 : Math.sin(a), aimAngle: a, attacking: true, dashing: false });
  }
});
s.on('events', evs => { for (const e of evs) { if (e.type === 'hit') gotHit = true; if (e.type === 'attack') gotAttack = true; } });
setTimeout(() => {
  console.log('started=', started, ' gotState=', gotState, ' sawEnemies=', sawEnemies, ' wave=', lastWave);
  console.log('gotAttack=', gotAttack, ' gotHit(근접 적중)=', gotHit);
  console.log((started && gotState && sawEnemies && gotHit) ? 'E2E PASS' : 'E2E FAIL');
  s.close(); process.exit(gotState && gotHit ? 0 : 1);
}, 5000);
