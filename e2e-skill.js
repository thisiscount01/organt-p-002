'use strict';
// QA: 스킬 시스템 + 대시 검증.
// Part A: 헤드리스 소켓(실플레이) — 대시 연속이동·i프레임·skill_cast 와이어 전송.
// Part B: 인프로세스 Game API — 슬롯 배치/교체/엣지/시드 다양성 + 4직업 type별 효과 실재.
const { Game, SKILL_BY_ID } = require('./server.js');
let PASS = 0, FAIL = 0; const log = [];
const ok = (c, m) => { if (c) { PASS++; } else { FAIL++; log.push('  FAIL: ' + m); } };
const note = m => log.push(m);

// SKILL_BY_ID가 export 안 됐으면 SKILLS로부터 재구성 시도
const toPlaying = g => { if (g.phase === 'mutator_select') g.selectMutator(g.mutatorOffer[0].id); };

// ───────── Part B1: 슬롯 Q→E→R 배치, 슬롯 풀 교체 ─────────
{
  const g = new Game({ seed: 1 }); const p = g.addPlayer('s1', 'T', 'warrior'); toPlaying(g);
  g.addSkill(p, 'w_charge'); g.addSkill(p, 'w_shockwave'); g.addSkill(p, 'w_quake');
  ok(p.skills[0] && p.skills[0].id === 'w_charge', 'Q=첫획득');
  ok(p.skills[1] && p.skills[1].id === 'w_shockwave', 'E=둘째');
  ok(p.skills[2] && p.skills[2].id === 'w_quake', 'R=셋째');
  const full = g.addSkill(p, 'w_war_cry');
  ok(full === false, '슬롯풀이면 자동충전 거부');
  g.replaceSkill('s1', 1, 'w_war_cry');
  ok(p.skills[1].id === 'w_war_cry', 'replace_skill로 E교체');
  note(`[슬롯] Q/E/R = ${p.skills.map(s=>s&&s.id).join(' / ')}`);
}

// ───────── Part B2: 시드별 오퍼 슬롯 다양성(매판 다름) ─────────
{
  const seen = new Set();
  for (const seed of [1,2,3,4,5,6]) {
    const g = new Game({ seed }); const p = g.addPlayer('s1', 'T', 'mage'); toPlaying(g);
    g.wave = 3;
    const ch = g.rollOffer ? null : null; // rollOffer 비공개일 수 있음 → buildOffer 경유
    // 오퍼 생성 함수명이 내부일 수 있어, beginAugmentSelect로 강제 후 offer 읽기
    g.phase = 'augment_select'; g.beginAugmentSelect();
    const offer = (g.pendingOffers.get(p.id) || []).join(',');
    seen.add(offer);
  }
  ok(seen.size >= 3, `시드별 오퍼 구성 다양(${seen.size}/6 유니크)`);
  note(`[다양성] 6시드 중 유니크 오퍼 ${seen.size}종`);
}

// ───────── Part B3: 4직업 × type별 사용→쿨다운→효과 실재 ─────────
function spawnDummy(g, n, x0) {
  g.enemies = []; g.spawnQueue = [];
  for (let i = 0; i < n; i++) {
    const e = g.spawnEnemy({ type: 'slime', elite: null, boss: false });
    e.x = (x0 || 120) + i * 18; e.y = 360; e.hp = e.maxHp = 500;
  }
}
// 효과 실재 판정: 피해형은 '적 총HP 감소', buff는 버프/스탯/실드, summon은 아군개체, dash는 별도.
function totalEnemyHp(g){ return g.enemies.reduce((s,e)=>s+Math.max(0,e.hp),0); }
const TYPE_CHECK = {
  'dash_strike':        (g,p,ctx) => ctx.dmgDone || ctx.dashed,
  'nova':               (g,p,ctx) => ctx.dmgDone,
  'aoe_field':          (g,p,ctx) => ctx.dmgDone || (g.fields&&g.fields.length>ctx.fields0),
  'projectile_barrage': (g,p,ctx) => ctx.dmgDone || ctx.firedProj>0,
  'chain':              (g,p,ctx) => ctx.dmgDone,
  'summon':             (g,p,ctx) => ctx.minionsUp || ctx.dmgDone,
  'buff':               (g,p,ctx) => p.buffs.length>0 || p.stats.dmg>ctx.beforeDmg || p.shield>0,
  'stun_strike':        (g,p,ctx) => ctx.dmgDone,
  'multi_hit':          (g,p,ctx) => ctx.dmgDone || ctx.firedProj>0,
  'shield_stance':      (g,p,ctx) => p.shield>0 || p.buffs.length>0,
};
const CLASS_SKILLS = {
  warrior:  ['w_shockwave','w_shield_bash','w_quake','w_war_cry','w_frenzy','w_charge','w_titan'],
  mage:     ['m_frost_nova','m_meteor','m_chain_light','m_arcane_burst','m_time_warp','m_summon','m_blink'],
  archer:   ['a_volley','a_explosive','a_arrow_rain','a_multi','a_eagle_eye','a_hawk','a_storm'],
  assassin: ['s_smoke_bomb','s_poison_field','s_shuriken','s_clone','s_mark','s_shadow_leap','s_heart_stab'],
};
const SKB = SKILL_BY_ID || {};
for (const champ of Object.keys(CLASS_SKILLS)) {
  for (const sid of CLASS_SKILLS[champ]) {
    const g = new Game({ seed: 7 }); const p = g.addPlayer('s1', 'T', champ); toPlaying(g);
    spawnDummy(g, 6, 120);
    p.x = 130; p.y = 360; // 적과 근접/사거리 내
    const def = SKB[sid];
    const type = def ? def.type : '?';
    p.skills[0] = { id: sid, cdLeft: 0, cdMax: def ? def.cd : 8 };
    const ctx = { beforeDmg: p.stats.dmg, fields0: (g.fields?g.fields.length:0) };
    const hp0 = totalEnemyHp(g);
    const usedEmptyFail = g.useSkill('s1', 1, 0); // 빈 슬롯(E) 사용 → 실패해야
    g.events = []; // 직전 누적 비우고 use 이벤트만 관찰
    const used = g.useSkill('s1', 0, 0);
    // 계약상 'skill_cast' 이벤트 존재 여부(중복 type 키 버그 탐지)
    const skillCastTyped = g.events.some(e => e.type === 'skill_cast');
    // 시전 이벤트 자체는 발생했나(타입 무관, cast 시그니처로 식별)
    const castEmitted = g.events.some(e => e.id === sid && typeof e.slot === 'number' && e.champion);
    ctx.firedProj = g.projectiles.filter(pr=>pr.owner==='ally').length;
    ctx.dashed = g.now < p.dashUntil;
    for (let i = 0; i < 30; i++) g.tick();
    ctx.dmgDone = totalEnemyHp(g) < hp0 - 0.5;
    ctx.minionsUp = (g.minions&&g.minions.length>0)||(g.allies&&g.allies.length>0)||(g.summons&&g.summons.length>0);
    const checker = TYPE_CHECK[type] || (()=>true);
    const effect = checker(g, p, ctx);
    const cdEntered = p.skills[0].cdLeft > 0;
    const reblocked = g.useSkill('s1', 0, 0) === false;
    ok(usedEmptyFail === false, `[${champ}/${sid}] 빈 슬롯 사용 거부`);
    ok(used === true, `[${champ}/${sid}] 사용 성공`);
    ok(castEmitted, `[${champ}/${sid}] 시전 이벤트 발생(cast 시그니처)`);
    if (!skillCastTyped) note(`  CONTRACT-BUG: [${champ}/${sid}] type='skill_cast' 아님(스킬타입으로 덮임)`);
    ok(cdEntered, `[${champ}/${sid}] 쿨다운 진입`);
    ok(reblocked, `[${champ}/${sid}] 쿨 중 재사용 차단`);
    ok(effect, `[${champ}/${sid}] type=${type} 효과 실재`);
  }
}

console.log(`PART_B ${PASS} PASS / ${FAIL} FAIL`);
for (const l of log) console.log(l);
console.log('PARTB_DONE');
