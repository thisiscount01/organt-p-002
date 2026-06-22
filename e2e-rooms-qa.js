'use strict';
// QA 보강 검증. Part A: 소켓 — no_room/not_host/준비게이팅. Part B: 인프로세스 — 인원스케일·부활/전멸·룸내 회귀.
const { io } = require('socket.io-client');
const { Game } = require('./server.js');
let PASS = 0, FAIL = 0; const fails = [], notes = [];
const ok = (c, m) => { if (c) PASS++; else { FAIL++; fails.push('FAIL: ' + m); } };
const note = m => notes.push(m);
const URL = 'http://localhost:3000';
const mk = () => io(URL, { transports: ['websocket'], forceNew: true });
const once = (s, ev, ms=2500) => new Promise(r => { const t=setTimeout(()=>r(null),ms); s.once(ev, p=>{clearTimeout(t);r(p);}); });
const wait = ms => new Promise(r => setTimeout(r, ms));
// 즉사방지(1타 35%상한·0.5s i프레임) 우회해 확실히 처치
function killPlayer(g, p) {
  // 시계 진행 없이 처치: i프레임 해제 + HP 1로 낮춘 뒤 1타(즉사방지 35%상한이라도 hp<상한이면 사망)
  p.invulnUntil = 0; p.shield = 0; p.hp = 1; g.hurtPlayer(p, 99999, {});
}

async function partA() {
  const A = mk(); await once(A,'connect');
  A.emit('create_room', { name:'A' });
  const cr = await once(A,'room_created'); const code = cr && cr.code;
  // no_room
  const X = mk(); await once(X,'connect');
  X.emit('join_room', { code:'ZZZZ' });
  const e1 = await once(X,'room_error');
  ok(e1 && e1.reason==='no_room', `잘못된 코드→no_room (${e1&&e1.reason})`);
  // not_host: B 참가 후 비방장 시작
  const B = mk(); await once(B,'connect');
  B.emit('join_room', { code }); await once(B,'room_joined');
  B.emit('start_game');
  const e2 = await once(B,'room_error');
  ok(e2 && e2.reason==='not_host', `비방장 시작→not_host (${e2&&e2.reason})`);
  // need_champion / need_ready 게이팅
  A.emit('start_game');
  const e3 = await once(A,'room_error');
  ok(e3 && (e3.reason==='need_champion'||e3.reason==='need_ready'), `미준비 시작 거부 (${e3&&e3.reason})`);
  A.emit('select_champion',{champion:'warrior'}); B.emit('select_champion',{champion:'mage'});
  await wait(120);
  A.emit('start_game');
  const e4 = await once(A,'room_error');
  ok(e4 && e4.reason==='need_ready', `챔피언만·준비전 거부→need_ready (${e4&&e4.reason})`);
  A.emit('ready',{ready:true}); B.emit('ready',{ready:true}); await wait(150);
  A.emit('start_game');
  const gsd = await once(A,'game_started');
  ok(!!gsd, `전원 준비 후 방장 시작 성공`);
  [A,B,X].forEach(s=>s.close());
}

function partB() {
  const counts={},hps={},kinds={};
  for (const N of [1,2,3,4]) {
    const g = new Game({ seed:50, numPlayers:N });
    for (let k=0;k<N;k++) g.addPlayer('p'+k,'P','warrior',100+k);
    g.startGame(); if (g.phase==='mutator_select') g.selectMutator(g.mutatorOffer[0].id);
    g.startWave(6);
    counts[N]=g.spawnQueue.length; kinds[N]=new Set(g.spawnQueue.map(s=>s.type)).size;
    hps[N]=g.spawnEnemy({type:'orc',elite:null,boss:false}).maxHp;
  }
  ok(counts[4]>counts[3]&&counts[3]>counts[2]&&counts[2]>counts[1], `스폰 적수 단조↑ ${counts[1]}/${counts[2]}/${counts[3]}/${counts[4]}`);
  ok(hps[4]>hps[1], `적HP 인원비례↑ ${hps[1]}→${hps[4]}`);
  ok(kinds[4]>=kinds[1], `등장 종류 N↑ ${kinds[1]}→${kinds[4]}`);
  note(`[스케일] 적수 ${counts[1]}/${counts[2]}/${counts[3]}/${counts[4]} · orcHP ${hps[1]}/${hps[2]}/${hps[3]}/${hps[4]} · 종류 ${kinds[1]}/${kinds[2]}/${kinds[3]}/${kinds[4]}`);

  { // 부활/전멸 N=2
    const g=new Game({seed:7,numPlayers:2});
    const pa=g.addPlayer('a','A','warrior',1), pb=g.addPlayer('b','B','mage',2);
    g.startGame(); if(g.phase==='mutator_select')g.selectMutator(g.mutatorOffer[0].id);
    const deathNow = g.now;
    killPlayer(g, pa);
    const reviveDelayMs = pa.reviveAt - deathNow;
    ok(pa.dead&&pa.reviveAt>0, `[N2] 1명 사망→부활예약(딜레이=${Math.round(reviveDelayMs)}ms≈${Math.round(reviveDelayMs/33.33)}틱)`);
    g.checkGameOver();
    ok(g.phase!=='gameover', `[N2] 생존자 있으면 지속(phase=${g.phase})`);
    // 부활 시점 직전까지 진행하며 부활 안 됨 확인 → 시점 도달 시 부활
    g.now = pa.reviveAt - 100; g.updateRevive();
    const stillDead = pa.dead;
    g.now = pa.reviveAt + 1; g.updateRevive();
    const invulnMs = pa.invulnUntil - g.now;
    ok(stillDead && !pa.dead && pa.hp>0 && g.now<pa.invulnUntil, `[N2] 타이머 전 사망유지→도달시 리스폰(hp=${Math.round(pa.hp)}/${pa.stats.maxHp}, 무적 ${Math.round(invulnMs)}ms)`);
    note(`[부활] 사망→부활 ${Math.round(reviveDelayMs)}ms(≈${Math.round(reviveDelayMs/33.33)}틱), 리스폰 HP ${Math.round(pa.hp)}/${pa.stats.maxHp}, 리스폰무적 ${Math.round(invulnMs)}ms`);
    killPlayer(g, pa); killPlayer(g, pb); g.checkGameOver();
    ok(pa.dead&&pb.dead&&g.phase==='gameover', `[N2] 전원 사망만 game_over`);
  }
  { // 솔로
    const g=new Game({seed:8,numPlayers:1}); const p=g.addPlayer('s','S','warrior',1);
    g.startGame(); if(g.phase==='mutator_select')g.selectMutator(g.mutatorOffer[0].id);
    killPlayer(g,p); g.checkGameOver();
    ok(p.dead&&p.reviveAt===0&&g.phase==='gameover', `[솔로] 사망 즉시 game_over·부활없음`);
  }
  { // 룸내 회귀
    const g=new Game({seed:11,numPlayers:2});
    const p=g.addPlayer('a','A','warrior',1); g.addPlayer('b','B','mage',2);
    g.startGame(); if(g.phase==='mutator_select')g.selectMutator(g.mutatorOffer[0].id);
    p.skills[0]={id:'w_bash',cdLeft:0,cdMax:8};
    g.enemies=[]; const e=g.spawnEnemy({type:'slime',elite:null,boss:false}); e.x=p.x+40;e.y=p.y;e.hp=e.maxHp=500;
    g.events=[]; const used=g.useSkill('a',0,0);
    ok(used&&g.events.some(ev=>ev.type==='skill_cast'), `[회귀] 룸내 use_skill+skill_cast`);
    ok(e.hp<500, `[회귀] 스킬 피해 실재(hp=${Math.round(e.hp)})`);
    p.input.dashing=true;p.input.aimAngle=0; const xs=[];
    for(let i=0;i<6;i++){g.updatePlayers();xs.push(p.x);p.input.dashing=false;g.now+=33.3;}
    const steps=xs.map((x,i)=>i?+(x-xs[i-1]).toFixed(1):0).filter(d=>d>0.5);
    ok(steps.length>=3, `[회귀] 룸내 대시 연속이동 ${steps.length}틱`);
    g.enemies=[]; const en=g.spawnEnemy({type:'slime',elite:null,boss:false}); en.x=p.x+20;en.y=p.y;en.atkCdLeft=0;
    let fsm=false; for(let i=0;i<30;i++){g.tick(); if(en.state==='windup'||en.state==='strike')fsm=true;}
    ok(fsm, `[회귀] 룸내 적 공격 FSM`);
  }
}

(async()=>{
  try{ await partA(); }catch(e){ fails.push('PARTA-THREW: '+e.message); }
  try{ partB(); }catch(e){ fails.push('PARTB-THREW: '+e.message); }
  console.log(`QA-RESULT ${PASS} PASS / ${FAIL} FAIL`);
  for(const n of notes) console.log(n);
  for(const f of fails) console.log('  '+f);
  process.exit(0);
})();
