// 근접(chase) 적이 '비비기'인지 'windup→strike' discrete 공격인지 틱별로 추적.
const { io } = require('socket.io-client');
const sock = io('http://localhost:3000', { transports: ['websocket'] });
let myPid = null, last = null;
const t0 = Date.now();
let playerHits = 0, firstHitMs = null;
const meleeTypes = new Set(['slime','goblin','orc','bat','splitslime','giant','shieldorc']);
// 추적: 특정 근접 적 1마리의 상태 전이 시퀀스
const tracked = new Map(); // id -> {type, states:[], sawAttackAnim}
sock.on('connect', () => sock.emit('join', { name: 'AFK', champion: 'warrior' }));
sock.on('joined', d => { if (d && d.id != null) myPid = d.id; });
sock.on('events', evs => {
  for (const e of evs) {
    if (e.type === 'player_hit') { playerHits++; if (firstHitMs == null) firstHitMs = Date.now()-t0; }
  }
});
sock.on('state', s => {
  last = s;
  for (const en of s.enemies) {
    if (!meleeTypes.has(en.type)) continue;
    if (!tracked.has(en.id)) tracked.set(en.id, { type: en.type, seq: [], anim: false });
    const r = tracked.get(en.id);
    const tag = en.state + (en.attackAnim ? `(${en.attackAnim.type})` : '');
    if (r.seq[r.seq.length-1] !== tag) r.seq.push(tag);
    if (en.attackAnim) r.anim = true;
  }
});
setInterval(() => { if (myPid!=null) sock.emit('input', { moveX:0,moveY:0,aimAngle:0,attacking:false }); }, 100);
setTimeout(() => {
  // windup/strike를 실제로 거친 근접 적만 골라 시퀀스 샘플 출력
  const withAttack = [...tracked.values()].filter(r => r.seq.some(t => t.startsWith('windup') || t.startsWith('strike')));
  const sample = withAttack.slice(0,4).map(r => `${r.type}: ${r.seq.join(' → ')}`);
  console.log('PROBE ' + JSON.stringify({
    trackedMelee: tracked.size,
    meleeWithWindupOrStrike: withAttack.length,
    meleeWithAttackAnim: [...tracked.values()].filter(r=>r.anim).length,
    playerHits, firstHitMs,
    finalPhase: last && last.phase, wave: last && last.wave,
  }, null, 0));
  for (const line of sample) console.log('  SEQ ' + line);
  process.exit(0);
}, 20000);
