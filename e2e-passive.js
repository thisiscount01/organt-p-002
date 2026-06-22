// 보고된 증상 재현(소켓 레벨): 가만히 선 플레이어의 HP가 실제로 깎이는가.
const { io } = require('socket.io-client');
const s = io('http://localhost:3000', { transports: ['websocket'] });
let myPid = null, startHp = null, minHp = null, dead = false, lastWave = 0;
s.on('connect', () => s.emit('join', { name: 'PASSIVE', champion: 'warrior' }));
let mutPicked = false;
s.on('joined', d => { if (d.id) myPid = d.id; });
s.on('state', st => {
  lastWave = st.wave;
  if (st.mutatorOffer && !mutPicked) { s.emit('select_mutator', { id: st.mutatorOffer[0].id }); mutPicked = true; }
  const me = st.players.find(p => p.id === myPid);
  if (me) { if (startHp === null) startHp = me.maxHp; minHp = me.hp; if (me.dead) dead = true; }
  // 입력을 전혀 보내지 않음(가만히 서 있음)
});
setTimeout(() => {
  console.log('startMaxHp=', startHp, ' 관찰된 최저HP=', minHp, ' 사망=', dead, ' wave=', lastWave);
  const tookDamage = startHp !== null && minHp < startHp;
  console.log(tookDamage ? 'PASSIVE PASS — 가만히 있어도 적에게 피해를 받음(버그 수정 확인)' : 'PASSIVE FAIL — 여전히 무피해');
  s.close(); process.exit(tookDamage ? 0 : 1);
}, 12000);
