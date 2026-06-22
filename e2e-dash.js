'use strict';
// 대시가 '순간이동'인지 'N틱 연속 이동'인지 실플레이 소켓으로 측정 + i프레임 확인.
const { io } = require('socket.io-client');
const sock = io('http://localhost:3000', { transports: ['websocket'] });
let myPid = null, phase = null, sentDash = false, dashStartIdx = null;
const samples = []; // {t,x,y,dashing,invuln}
let idx = 0;
sock.on('connect', () => sock.emit('join', { name: 'D', champion: 'warrior' }));
sock.on('joined', d => { if (d && d.id != null) myPid = d.id; });
sock.on('state', s => {
  phase = s.phase;
  if (phase === 'mutator_select' && s.mutatorOffer) sock.emit('select_mutator', { id: s.mutatorOffer[0].id });
  const me = s.players && s.players.find(p => p.id === myPid);
  if (!me) return;
  // playing 진입 후 한 번 대시 발사(정지 상태에서)
  if (phase === 'playing' && !sentDash) {
    sock.emit('input', { moveX: 0, moveY: 0, aimAngle: 0, dashing: true, attacking: false });
    sentDash = true; dashStartIdx = idx;
    setTimeout(() => sock.emit('input', { moveX:0,moveY:0,aimAngle:0,dashing:false,attacking:false }), 60);
  }
  if (sentDash) samples.push({ i: idx++, x: me.x, y: me.y, dashing: !!me.dashing, invuln: !!me.invuln });
});
setTimeout(() => {
  // 대시 구간(dashing=true 또는 그 직후) 위치 변화 분석
  const xs = samples.map(s => s.x);
  const deltas = [];
  for (let k = 1; k < samples.length; k++) deltas.push(+(samples[k].x - samples[k-1].x).toFixed(1));
  const moveDeltas = deltas.filter(d => Math.abs(d) > 0.5);
  const dashTicks = samples.filter(s => s.dashing).length;
  const totalMove = +(Math.max(...xs) - Math.min(...xs)).toFixed(1);
  const maxSingle = moveDeltas.length ? Math.max(...moveDeltas.map(Math.abs)) : 0;
  const invulnDuringDash = samples.filter(s => s.dashing).every(s => s.invuln);
  console.log('DASH ' + JSON.stringify({
    phase, dashFlagTicks: dashTicks, movingTicks: moveDeltas.length,
    totalMovePx: totalMove, maxSingleTickPx: +maxSingle.toFixed(1),
    maxSingleRatio: totalMove ? +(maxSingle/totalMove).toFixed(2) : null,
    invulnDuringDash, firstDeltas: deltas.slice(0, 10),
  }));
  process.exit(0);
}, 4000);
