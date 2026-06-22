// 멀티소켓 e2e: 방 생성/참가/챔피언락/정원·난입차단/시작/룸격리/인원 스케일.
const { io } = require('socket.io-client');
const URL = 'http://localhost:3000';
const mk = () => io(URL, { transports: ['websocket'], forceNew: true });
const log = [];
let results = {};

function wait(ms) { return new Promise(r => setTimeout(r, ms)); }
function once(s, ev) { return new Promise(r => s.once(ev, r)); }

(async () => {
  // A: 방 생성
  const A = mk(); await once(A, 'connect');
  A.emit('create_room', { name: 'host', champion: 'warrior' });
  const created = await once(A, 'room_created');
  const code = created.code;
  results.created = !!code;

  // B: 같은 방 참가
  const B = mk(); await once(B, 'connect');
  B.emit('join_room', { code, name: 'guest' });
  const joined = await once(B, 'room_joined');
  results.joined = joined.code === code;

  // 챔피언 중복락: B가 warrior 시도 → 거절
  let champErr = null; B.once('room_error', e => champErr = e.reason);
  B.emit('select_champion', { champion: 'warrior' });
  await wait(150);
  results.champLock = champErr === 'champion_taken';
  B.emit('select_champion', { champion: 'mage' });
  await wait(100);

  // 정원/난입: C,D,E 참가 → 4명까지, 5번째 거절
  const C = mk(), D = mk(); await once(C, 'connect'); await once(D, 'connect');
  C.emit('join_room', { code, name: 'c' }); D.emit('join_room', { code, name: 'd' });
  await wait(150);
  const E = mk(); await once(E, 'connect');
  let fullErr = null; E.once('room_error', e => fullErr = e.reason);
  E.emit('join_room', { code, name: 'e' });
  await wait(150);
  results.full = fullErr === 'full';

  // 룸 격리: F가 새 방 생성 → 다른 코드, 서로 안 섞임
  const F = mk(); await once(F, 'connect');
  F.emit('create_room', { name: 'other' });
  const created2 = await once(F, 'room_created');
  results.isolated = created2.code !== code;

  // C,D 챔피언 선택 + 전원 ready → 방장 시작
  C.emit('select_champion', { champion: 'archer' });
  D.emit('select_champion', { champion: 'assassin' });
  await wait(150);
  for (const [s, on] of [[A, true], [B, true], [C, true], [D, true]]) s.emit('ready', { ready: on });
  await wait(200);
  let started = false; A.once('game_started', () => started = true);
  A.emit('start_game');
  await wait(300);
  results.started = started;

  // 시작 후 난입 차단
  const G = mk(); await once(G, 'connect');
  let inProg = null; G.once('room_error', e => inProg = e.reason);
  G.emit('join_room', { code });
  await wait(150);
  results.inProgress = inProg === 'in_progress';

  // 게임 state 수신: room 필드 + 4명 + 변이선택 처리
  let lastState = null, mutPicked = false;
  A.on('state', st => { lastState = st; if (st.mutatorOffer && !mutPicked) { A.emit('select_mutator', { id: st.mutatorOffer[0].id }); mutPicked = true; } });
  await wait(1500);
  results.roomField = !!(lastState && lastState.room && lastState.room.code === code);
  results.fourPlayers = !!(lastState && lastState.players && lastState.players.length === 4);
  results.gameRunning = !!(lastState && (lastState.phase === 'playing' || lastState.phase === 'mutator_select'));

  console.log('결과:', JSON.stringify(results, null, 0));
  const allOk = Object.values(results).every(Boolean);
  console.log('항목:', Object.entries(results).map(([k, v]) => `${k}=${v ? 'O' : 'X'}`).join(' '));
  console.log(allOk ? 'ROOMS E2E PASS' : 'ROOMS E2E FAIL');
  [A, B, C, D, E, F, G].forEach(s => s.close());
  process.exit(allOk ? 0 : 1);
})().catch(e => { console.log('ERROR', e.message); process.exit(1); });
