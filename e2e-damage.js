// 핵심 재현: 가만히 선 플레이어가 적 공격으로 HP가 깎이고, 대응 안 하면 게임오버에 이르는가.
// 또한 enemy.attackAnim/state(windup→strike) 노출과 player_hit 이벤트 발생을 확인.
const { io } = require('socket.io-client');
const champ = process.argv[2] || 'warrior';
const sock = io('http://localhost:3000', { transports: ['websocket'] });
let myPid = null, last = null;
let startHp = null, minHp = Infinity, playerHitCount = 0, gameOver = false, deathSeen = false;
const enemyStates = new Set();
let sawWindup = false, sawAttackAnim = false, sawStrike = false;
let firstHitMs = null; const t0 = Date.now();

sock.on('connect', () => sock.emit('join', { name: 'AFK', champion: champ }));
sock.on('joined', d => { if (d && d.id != null) myPid = d.id; });
sock.on('events', evs => {
  for (const e of evs) {
    if (e.type === 'player_hit') { playerHitCount++; if (firstHitMs == null) firstHitMs = Date.now() - t0; }
    if (e.type === 'game_over') gameOver = true;
    if (e.type === 'death') deathSeen = true;
  }
});
sock.on('state', s => {
  last = s;
  const me = s.players.find(p => p.id === myPid);
  if (me) { if (startHp == null) startHp = me.maxHp; minHp = Math.min(minHp, me.hp); }
  for (const en of s.enemies) {
    if (en.state) enemyStates.add(en.state);
    if (en.state === 'windup') sawWindup = true;
    if (en.state === 'strike') sawStrike = true;
    if (en.attackAnim) { sawAttackAnim = true; }
  }
});
// 플레이어는 '가만히' 있음: 이동/공격/조준 입력 없음(혹은 0). 적이 알아서 접근·공격해야 함.
setInterval(() => {
  if (myPid == null) return;
  sock.emit('input', { moveX: 0, moveY: 0, aimAngle: 0, attacking: false, dashing: false });
}, 100);

setTimeout(() => {
  const me = last && last.players.find(p => p.id === myPid);
  console.log('RESULT ' + JSON.stringify({
    champion: champ,
    startHp, minHp: minHp === Infinity ? null : minHp,
    hpDropped: startHp != null && minHp < startHp,
    playerHitCount, firstHitMs,
    gameOver, deathSeen,
    enemyStates: [...enemyStates].sort(),
    sawWindup, sawStrike, sawAttackAnim,
    finalPhase: last && last.phase,
    finalHp: me ? me.hp : null, dead: me ? me.dead : null,
  }));
  process.exit(0);
}, 30000);
