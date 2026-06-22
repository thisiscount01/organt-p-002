// 라이브 서버에 AFK 플레이어로 접속해 근접 적이 비비기인지/공격모션 신호가 실리는지 확인.
const { io } = require('socket.io-client');
const URL = process.argv[2] || 'https://todo-organt-demo.onrender.com';
const sock = io(URL, { transports: ['websocket'], timeout: 15000 });
let myPid = null, last = null;
const t0 = Date.now();
let playerHits = 0, firstHitMs = null, connected = false;
const meleeTypes = new Set(['slime','goblin','orc','bat','splitslime','giant','shieldorc']);
const tracked = new Map();
let anyAttackAnimField = false; // 서버 snapshot에 attackAnim 필드 자체가 있나
const allStates = new Set();
sock.on('connect', () => { connected = true; sock.emit('join', { name: 'AFK', champion: 'warrior' }); });
sock.on('connect_error', e => { console.log('CONNERR ' + e.message); });
sock.on('joined', d => { if (d && d.id != null) myPid = d.id; });
sock.on('events', evs => { for (const e of evs) { if (e.type==='player_hit'){playerHits++; if(firstHitMs==null)firstHitMs=Date.now()-t0;} } });
sock.on('state', s => {
  last = s;
  for (const en of s.enemies) {
    if (en.state) allStates.add(en.state);
    if ('attackAnim' in en) anyAttackAnimField = true;
    if (!meleeTypes.has(en.type)) continue;
    if (!tracked.has(en.id)) tracked.set(en.id, { type: en.type, seq: [], anim: false });
    const r = tracked.get(en.id);
    const tag = (en.state||'?') + (en.attackAnim ? '(anim)' : '');
    if (r.seq[r.seq.length-1] !== tag) r.seq.push(tag);
    if (en.attackAnim) r.anim = true;
  }
});
setInterval(() => { if (myPid!=null) sock.emit('input', { moveX:0,moveY:0,aimAngle:0,attacking:false }); }, 100);
setTimeout(() => {
  const withAttack = [...tracked.values()].filter(r => r.seq.some(t => t.startsWith('windup')||t.startsWith('strike')));
  console.log('LIVE ' + JSON.stringify({
    url: URL, connected, joinedPid: myPid,
    enemyStatesSeen: [...allStates].sort(),
    snapshotHasAttackAnimField: anyAttackAnimField,
    trackedMelee: tracked.size, meleeWithWindupOrStrike: withAttack.length,
    meleeWithAttackAnim: [...tracked.values()].filter(r=>r.anim).length,
    playerHits, firstHitMs, finalPhase: last && last.phase, wave: last && last.wave,
  }));
  const sample = [...tracked.values()].slice(0,3).map(r => `${r.type}: ${r.seq.join(' → ')}`);
  for (const l of sample) console.log('  SEQ ' + l);
  process.exit(0);
}, 25000);
