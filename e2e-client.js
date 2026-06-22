// 헤드리스 클라 시뮬: app.js가 받는 데이터/이벤트로 한 판 흐름이 실제 동작하는지 검증.
const { io } = require('socket.io-client');
const sock = io('http://localhost:3000', { transports: ['websocket'] });
let myPid = null, lastState = null, evtTypes = {}, sawOffer = false, offerHadClassOnly = false;
let maxWave = 0, hitSeen = false, attackSeen = false, deathSeen = false, augTaken = 0;
const enemyTypesSeen = new Set();
const projKindsSeen = new Set();

sock.on('connect', () => sock.emit('join', { name: 'E2E', champion: 'mage' }));
sock.on('joined', d => { if (d && d.id != null) myPid = d.id; });
sock.on('events', evs => {
  for (const e of evs) {
    evtTypes[e.type] = (evtTypes[e.type] || 0) + 1;
    if (e.type === 'hit') hitSeen = true;
    if (e.type === 'attack') attackSeen = true;
    if (e.type === 'death') deathSeen = true;
  }
});
sock.on('state', s => {
  lastState = s; maxWave = Math.max(maxWave, s.wave);
  for (const e of (s.enemies || [])) enemyTypesSeen.add(e.elite ? e.type + ':' + e.elite : e.type);
  for (const p of (s.projectiles || [])) projKindsSeen.add(p.kind);
  if (s.phase === 'augment_select' && s.offers && s.offers[myPid]) {
    const offs = s.offers[myPid];
    if (!sawOffer) { sawOffer = true; if (offs.some(o => o.classOnly)) offerHadClassOnly = true; }
    sock.emit('select_augment', { id: offs[0].id });
    augTaken++;
  }
});
// 직접조준 시뮬: 가장 가까운 적 방향으로 조준+접근+공격
setInterval(() => {
  if (!lastState || myPid == null) return;
  const me = lastState.players.find(p => p.id === myPid); if (!me) return;
  let nd = 1e9, ne = null;
  for (const en of lastState.enemies) { const dx = en.x - me.x, dy = en.y - me.y, d = dx * dx + dy * dy; if (d < nd) { nd = d; ne = en; } }
  let aim = 0, mx = 0, my = 0;
  if (ne) { aim = Math.atan2(ne.y - me.y, ne.x - me.x); const dist = Math.sqrt(nd); const inR = dist < 80; mx = inR ? 0 : Math.cos(aim); my = inR ? 0 : Math.sin(aim); }
  sock.emit('input', { moveX: mx, moveY: my, aimAngle: aim, attacking: true, dashing: false });
}, 33);

setTimeout(() => {
  const s = lastState || {};
  console.log('RESULT ' + JSON.stringify({
    joined: myPid != null, maxWave, phase: s.phase,
    players: (s.players || []).length, attackSeen, hitSeen, deathSeen,
    sawOffer, offerHadClassOnly, augTaken,
    eventTypes: Object.keys(evtTypes).sort(),
    enemyVariantsSeen: [...enemyTypesSeen].sort(),
    projKindsSeen: [...projKindsSeen].sort(),
    hasBossField: 'boss' in s,
  }, null, 0));
  process.exit(0);
}, 15000);
