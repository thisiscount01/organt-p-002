// 라이브 배포본 진단: 가만히 선 플레이어가 라이브 서버에서 실제 피해를 받는가 +
// 적이 windup/strike 공격 FSM 상태로 들어오는가(서버가 모션 데이터를 내보내는가).
const { io } = require('socket.io-client');
const URL = process.argv[2] || 'https://todo-organt-demo.onrender.com';
const s = io(URL, { transports: ['websocket'], timeout: 8000 });
let myPid = null, startHp = null, minHp = null, dead = false, lastWave = 0;
const states = {}; let sawAttackAnim = 0, enemyAttackEvents = 0, sawEnemies = false;
s.on('connect', () => { console.log('connected to', URL); s.emit('join', { name: 'LIVEPROBE', champion: 'warrior' }); });
s.on('connect_error', e => { console.log('connect_error:', e.message); });
s.on('joined', d => { if (d.id) myPid = d.id; });
s.on('state', st => {
  lastWave = st.wave;
  if (st.enemies && st.enemies.length) sawEnemies = true;
  for (const e of (st.enemies || [])) { states[e.state] = (states[e.state] || 0) + 1; if (e.attackAnim) sawAttackAnim++; }
  const me = (st.players || []).find(p => p.id === myPid);
  if (me) { if (startHp === null) startHp = me.maxHp; minHp = me.hp; if (me.dead) dead = true; }
  // 입력 전혀 안 보냄(가만히)
});
s.on('events', evs => { for (const e of evs) if (e.type === 'enemy_attack') enemyAttackEvents++; });
setTimeout(() => {
  console.log('joined pid=', myPid, ' sawEnemies=', sawEnemies, ' wave=', lastWave);
  console.log('적 상태 분포:', JSON.stringify(states));
  console.log('attackAnim 실린 스냅샷 수=', sawAttackAnim, ' enemy_attack 이벤트=', enemyAttackEvents);
  console.log('startMaxHp=', startHp, ' 최저HP=', minHp, ' 사망=', dead);
  const tookDmg = startHp !== null && minHp < startHp;
  const hasFSM = (states.windup || 0) + (states.strike || 0) > 0;
  console.log('판정: 라이브서버 피해부여=', tookDmg, ' / 공격FSM노출=', hasFSM);
  s.close(); process.exit(0);
}, 14000);
