// end-to-end: 변이 2택1 → 플레이 → 진짜 대시(연속이동) → 스킬 슬롯 스키마 노출 확인.
// 룸 API(create_room → ready → start_game) 플로로 동작.
const { io } = require('socket.io-client');
const s = io('http://localhost:3000', { transports: ['websocket'] });
let myPid = null, picked = false, sawMutatorOffer = false, activeMut = null;
let phase = '', skillsField = null, dashSeen = false, dashStart = null, dashPath = [];
let dashSentAt = 0, tick = 0;

s.on('connect', () => {
  s.emit('create_room', { name: 'SKILLE2E', champion: 'assassin' });
});

s.on('room_created', d => {
  myPid = d.pid;
  s.emit('ready', { ready: true });
  s.emit('start_game');
});

s.on('room_error', d => { console.error('room_error', d); });

s.on('state', st => {
  tick++; phase = st.phase;
  if (st.mutatorOffer) { sawMutatorOffer = true; if (!picked) { s.emit('select_mutator', { id: st.mutatorOffer[0].id }); picked = true; } }
  if (st.activeMutator) activeMut = st.activeMutator.name;
  const me = (st.players || []).find(p => p.id === myPid);
  if (me) {
    skillsField = me.skills; // [null,null,null] 또는 [{id,cdLeft,...},null,null] 형태여야
    // 플레이 시작 후 한 번 대시 입력 → 연속 이동 관찰
    if (phase === 'playing' && !dashSentAt && tick > 5) {
      s.emit('input', { moveX: 0, moveY: 0, aimAngle: 0, attacking: false, dashing: true });
      dashSentAt = tick; dashStart = me.x;
    }
    if (dashSentAt && tick >= dashSentAt && tick <= dashSentAt + 8) {
      dashPath.push(me.x);
      if (me.dashing) dashSeen = true;
      if (tick === dashSentAt + 1) s.emit('input', { moveX: 0, moveY: 0, aimAngle: 0, attacking: false, dashing: false });
    }
  }
});

setTimeout(() => {
  const moved = dashPath.length >= 2 ? (Math.max(...dashPath) - Math.min(...dashPath)) : 0;
  const steps = []; for (let i = 1; i < dashPath.length; i++) steps.push(+(dashPath[i] - dashPath[i - 1]).toFixed(0));
  const continuous = steps.filter(v => v > 1).length >= 2;
  console.log('phase=', phase, ' 변이오퍼봄=', sawMutatorOffer, ' 선택된변이=', activeMut);
  console.log('skills 슬롯 스키마=', JSON.stringify(skillsField));
  console.log('대시: dashing=true관측=', dashSeen, ' 이동량=', moved.toFixed(0), ' 스텝=[' + steps.join(',') + '] 연속이동=', continuous);
  const ok = sawMutatorOffer && activeMut && Array.isArray(skillsField) && skillsField.length === 3 && dashSeen && continuous;
  console.log(ok ? 'SKILL/DASH E2E PASS' : 'SKILL/DASH E2E FAIL');
  s.close(); process.exit(ok ? 0 : 1);
}, 5000);
