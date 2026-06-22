// 클라 통합 관점 검증: app.js가 받는 데이터/송신으로 스킬·대시·변이가 동작하는가.
const { io } = require('socket.io-client');
const champ = process.argv[2] || 'warrior';
const sock = io('http://localhost:3000', { transports: ['websocket'] });
let myPid = null, last = null;
let gotSkill = false, usedSkill = false, sawCooldown = false, sawReadyAgain = false;
let skillCastSeen = false, sawMutatorOffer = false, mutatorChosen = false;
const castTypes = new Set();
let dashMaxRun = 0, runLen = 0, dashMoveTotal = 0, lastX = null, lastY = null, dashUntilSeen = false;
let replaceDone = false;
const SKILL_TYPES = ['dash_strike', 'aoe_field', 'nova', 'projectile_barrage', 'buff', 'summon', 'chain'];

sock.on('connect', () => sock.emit('join', { name: 'SKC', champion: champ }));
sock.on('joined', d => { if (d && d.id != null) myPid = d.id; });
sock.on('events', evs => {
  for (const e of evs) {
    // 클라 정규화와 동일: type이 skill_cast거나 스킬타입+slot이면 skill_cast로 인식
    let t = e.type;
    if (t !== 'skill_cast' && SKILL_TYPES.includes(t) && e.slot != null) { e.skillType = t; t = 'skill_cast'; }
    if (t === 'skill_cast') { skillCastSeen = true; castTypes.add(e.skillType || e.type); }
    if (e.type === 'mutator_offer') sawMutatorOffer = true;
    if (e.type === 'mutator_chosen') mutatorChosen = true;
  }
});
const readyPrev = [false, false, false];
sock.on('state', s => {
  last = s;
  const me = s.players.find(p => p.id === myPid);
  if (s.phase === 'mutator_select' && s.mutatorOffer && s.mutatorOffer.length) sock.emit('select_mutator', { id: s.mutatorOffer[0].id });
  if (s.phase === 'augment_select' && s.offers && s.offers[myPid]) {
    const offs = s.offers[myPid];
    const sk = offs.find(o => o.kind === 'skill') || offs[0];
    if (me && me.skills && me.skills.every(x => x) && sk.kind === 'skill') {
      sock.emit('select_augment', { id: sk.id });
      sock.emit('replace_skill', { slot: 0, id: sk.id }); replaceDone = true;
    } else sock.emit('select_augment', { id: sk.id });
  }
  if (me) {
    if (me.skills && me.skills.some(x => x)) gotSkill = true;
    if (me.skills) for (let i = 0; i < 3; i++) {
      const sk = me.skills[i];
      if (sk && sk.cdLeft > 0) sawCooldown = true;
      if (sk && sk.ready && !readyPrev[i] && sawCooldown) sawReadyAgain = true;
      readyPrev[i] = !!(sk && sk.ready);
    }
    if (me.dashUntil != null) dashUntilSeen = true;
    if (me.dashing) { runLen++; if (lastX != null) dashMoveTotal += Math.hypot(me.x - lastX, me.y - lastY); dashMaxRun = Math.max(dashMaxRun, runLen); }
    else runLen = 0;
    lastX = me.x; lastY = me.y;
  }
});
let tick = 0;
setInterval(() => {
  if (!last || myPid == null) return;
  const me = last.players.find(p => p.id === myPid); if (!me) return;
  tick++;
  let nd = 1e9, ne = null;
  for (const en of last.enemies) { const dx = en.x - me.x, dy = en.y - me.y, d = dx * dx + dy * dy; if (d < nd) { nd = d; ne = en; } }
  let aim = 0, mx = 0, my = 0;
  if (ne) { aim = Math.atan2(ne.y - me.y, ne.x - me.x); const dist = Math.sqrt(nd); const inR = dist < 90; mx = inR ? 0 : Math.cos(aim); my = inR ? 0 : Math.sin(aim); }
  sock.emit('input', { moveX: mx, moveY: my, aimAngle: aim, attacking: true, dashing: tick % 16 === 0 });
  if (me.skills) for (let slot = 0; slot < 3; slot++) { const sk = me.skills[slot]; if (sk && sk.ready) { sock.emit('use_skill', { slot, aimAngle: aim }); usedSkill = true; break; } }
}, 50);

setTimeout(() => {
  console.log('RESULT ' + JSON.stringify({
    champion: champ, gotSkill, usedSkill, sawCooldown, sawReadyAgain,
    skillCastSeen, castTypes: [...castTypes], sawMutatorOffer, mutatorChosen, replaceDone,
    dashUntilSeen, dashMaxRunTicks: dashMaxRun, dashMoveTotalPx: Math.round(dashMoveTotal),
    activeMutator: last && last.activeMutator ? last.activeMutator.id : null,
  }));
  process.exit(0);
}, 32000);
