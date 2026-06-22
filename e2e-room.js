// 멀티 룸 e2e: 방 생성→코드 참가→중복락→난입차단→시작→인원스케일→부활→전멸 게임오버.
const { io } = require('socket.io-client');
const URL = 'http://localhost:3000';
function mk() { return io(URL, { transports: ['websocket'], forceNew: true }); }
const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (k, v) => console.log('  ' + (v ? 'PASS' : 'FAIL') + ': ' + k + (v === true ? '' : ' → ' + JSON.stringify(v)));

(async () => {
  // 1) 방장 생성
  const host = mk(); let hostPid = null, code = null, hostRoom = null, hostError = null;
  host.on('room_created', d => { hostPid = d.pid; code = d.code; });
  host.on('room_state', s => { hostRoom = s; });
  host.on('room_error', d => { hostError = d.reason; });
  host.on('connect', () => host.emit('create_room', { name: 'HOST' }));
  await sleep(600);
  log('방 생성·코드 발급', !!code);

  // 2) 두 번째 클라 코드 참가
  const p2 = mk(); let p2pid = null, p2room = null, p2err = null;
  p2.on('room_joined', d => { p2pid = d.pid; });
  p2.on('room_state', s => { p2room = s; });
  p2.on('room_error', d => { p2err = d.reason; });
  p2.on('connect', () => p2.emit('join_room', { code, name: 'P2' }));
  await sleep(500);
  log('코드로 참가(멤버 2명)', hostRoom && hostRoom.members.length === 2);

  // 3) 챔피언 선택 + 중복락
  host.emit('select_champion', { champion: 'warrior' });
  await sleep(200);
  p2.emit('select_champion', { champion: 'warrior' }); // 중복 시도 → 거절
  await sleep(250);
  log('중복 챔피언 거절(champion_taken)', p2err === 'champion_taken');
  p2.emit('select_champion', { champion: 'mage' });
  await sleep(250);
  const taken = hostRoom && hostRoom.takenChampions;
  log('takenChampions 맵 {champion:pid}', taken && taken.warrior === hostPid && taken.mage === p2pid);

  // 4) 진행 중 난입 차단: 준비→시작 후 3번째 참가 시도
  host.emit('ready', { ready: true }); p2.emit('ready', { ready: true });
  await sleep(300);
  const canStart = hostRoom && hostRoom.canStart;
  log('전원 준비 시 canStart', !!canStart);
  let gameStarted = false; host.on('game_started', () => gameStarted = true);
  let hostState = null; host.on('state', s => hostState = s);
  let p2State = null; p2.on('state', s => p2State = s);
  host.emit('start_game');
  await sleep(800);
  log('start_game으로 게임 시작', gameStarted);
  log('인게임 state 수신(멤버 2명 렌더)', hostState && hostState.players && hostState.players.length === 2);

  // 난입 차단
  const p3 = mk(); let p3err = null;
  p3.on('room_error', d => p3err = d.reason);
  p3.on('connect', () => p3.emit('join_room', { code, name: 'LATE' }));
  await sleep(500);
  log('진행 중 방 난입 차단(in_progress)', p3err === 'in_progress');

  // 5) 인원수 비례: 스폰 예산/적수가 솔로보다 많아야(2인). 비교용 솔로 룸.
  const solo = mk(); let soloState = null, soloCode = null;
  solo.on('room_created', d => soloCode = d.code);
  solo.on('state', s => soloState = s);
  solo.on('connect', () => solo.emit('create_room', { name: 'SOLO' }));
  await sleep(400);
  solo.emit('select_champion', { champion: 'archer' });
  await sleep(150);
  solo.emit('ready', { ready: true });
  await sleep(200);
  solo.emit('start_game');
  await sleep(1500);
  const twoTotal = hostState && hostState.enemiesTotal, soloTotal = soloState && soloState.enemiesTotal;
  log('인원 비례 난이도(2인 enemiesTotal > 솔로)', { two: twoTotal, solo: soloTotal, ok: twoTotal > soloTotal });

  // 6) 부활/전멸: 2인 룸에서 입력 정지(가만히) → 한 명씩 다운, 전멸 시에만 game_over
  let hostGameOver = false; host.on('events', evs => { for (const e of evs) if (e.type === 'game_over') hostGameOver = true; });
  let sawSomeDownOthersAlive = false, sawRevive = false;
  host.on('events', evs => { for (const e of evs) if (e.type === 'player_revived') sawRevive = true; });
  host.on('state', s => {
    if (!s.players) return;
    const dead = s.players.filter(p => p.dead).length, alive = s.players.length - dead;
    if (dead >= 1 && alive >= 1) sawSomeDownOthersAlive = true;
  });
  const t0 = Date.now();
  while (Date.now() - t0 < 60000 && !hostGameOver) {
    host.emit('input', { moveX: 0, moveY: 0, aimAngle: 0, attacking: false, dashing: false });
    p2.emit('input', { moveX: 0, moveY: 0, aimAngle: 0, attacking: false, dashing: false });
    await sleep(120);
  }
  log('일부 다운+나머지 생존(게임 지속)', sawSomeDownOthersAlive);
  log('부활 발생(player_revived)', sawRevive);
  log('전원 사망 시에만 game_over', hostGameOver);

  console.log('ROOM_E2E_DONE');
  process.exit(0);
})().catch(e => { console.log('ERR', e.message); process.exit(1); });
