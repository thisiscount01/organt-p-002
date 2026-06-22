// 헤드리스 E2E: 스킬 시스템 v2 검증
// 목표:
//  1. 직업당 ≥20 스킬, type 중복 0건
//  2. 모든 스킬에 vfxId·sfxId·castMotion·tags·upgrades
//  3. SYNERGY_RULES ≥6 entries
//  4. skill_cast 이벤트에 vfxId·sfxId·castMotion·cd·damage·tags 포함
//  5. DPS 분산 ≤35%
//  6. 시너지 트리거 (fire+ice 상황 → cryo_explosion 또는 dmgMult)
'use strict';
const { Game, SKILLS, SKILL_BY_ID, SYNERGY_RULES } = require('./server.js');

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { console.log('  ✔ ' + msg); passed++; }
  else       { console.error('  ✘ ' + msg); failed++; }
}

// ─────── TEST 1: 스킬 수·직업별 20종·type 중복 0건 ───────
console.log('[T1] 스킬 수·직업별·type 중복');
ok(SKILLS.length === 80, `총 ${SKILLS.length}종 =80`);
for (const cls of ['warrior','mage','archer','assassin']) {
  const mine = SKILLS.filter(s => s.classOnly === cls);
  ok(mine.length === 20, `${cls} ${mine.length}종 =20`);
  const types = mine.map(s => s.type);
  const uniq = new Set(types);
  ok(uniq.size === types.length, `${cls} type 중복 없음 (${uniq.size}종)`);
}

// ─────── TEST 2: 필수 필드 존재 ───────
console.log('[T2] 필수 필드(vfxId·sfxId·castMotion·tags·upgrades)');
{
  let missingVfx=[], missingAll=[];
  for (const s of SKILLS) {
    if (!s.vfxId || !s.sfxId || !s.castMotion || !s.tags || !s.upgrades || !s.upgrades.length) missingAll.push(s.id);
    if (!s.vfxId) missingVfx.push(s.id);
  }
  ok(missingAll.length === 0, `필수 필드 누락 스킬 ${missingAll.length}건 (누락: ${missingAll.join(',') || '없음'})`);
  // upgrades 구조 확인
  let badUpg = SKILLS.filter(s => !s.upgrades || s.upgrades.length !== 3 ||
    s.upgrades.some(u => u.level == null || u.dmgMult == null || u.cdMult == null || u.rangeAdd == null)).map(s => s.id);
  ok(badUpg.length === 0, `upgrades 3단계 구조 ${badUpg.length}건 오류 (${badUpg.join(',') || '없음'})`);
}

// ─────── TEST 3: SYNERGY_RULES ≥6 ───────
console.log('[T3] SYNERGY_RULES ≥6');
{
  const keys = Object.keys(SYNERGY_RULES || {});
  ok(keys.length >= 6, `SYNERGY_RULES ${keys.length}종 ≥6`);
  ok(keys.every(k => SYNERGY_RULES[k].key && SYNERGY_RULES[k].dmgMult >= 1.0),
    `모든 룰에 key·dmgMult≥1.0`);
}

// ─────── TEST 4: skill_cast 이벤트 필드 검증 ───────
console.log('[T4] skill_cast 이벤트 vfxId·sfxId·castMotion·cd·damage·tags 포함');
{
  const testSkills = ['w_shockwave', 'm_frost_nova', 'a_volley', 's_smoke_bomb'];
  for (const sid of testSkills) {
    const g = new Game({ seed: 42 });
    const cls = SKILL_BY_ID[sid].classOnly;
    const p = g.addPlayer('s1', 'T', cls);
    g.selectMutator(g.mutatorOffer[0].id);
    g.enemies = []; g.spawnQueue = [];
    p.x = 400; p.y = 360;
    for (let k = 0; k < 5; k++) { const e = g.spawnEnemy({ type:'slime', elite:null, boss:false }); e.x = 460+k*20; e.y = 360; e.hp = e.maxHp = 500; }
    p.skills[0] = { id: sid, cdLeft: 0, cdMax: SKILL_BY_ID[sid].cd };
    p.input.aimAngle = 0;
    g.events = [];
    g.useSkill('s1', 0, 0);
    const ev = g.events.find(e => e.type === 'skill_cast' && e.id === sid);
    ok(!!ev, `${sid} skill_cast 이벤트 발행`);
    if (ev) {
      ok(!!ev.vfxId,     `${sid} vfxId=${ev.vfxId}`);
      ok(!!ev.sfxId,     `${sid} sfxId=${ev.sfxId}`);
      ok(!!ev.castMotion,`${sid} castMotion=${ev.castMotion}`);
      ok(ev.cd > 0,      `${sid} cd=${ev.cd}`);
      ok(ev.damage >= 0, `${sid} damage=${ev.damage}`);
      ok(Array.isArray(ev.tags) && ev.tags.length > 0, `${sid} tags=[${(ev.tags||[]).join(',')}]`);
    }
  }
}

// ─────── TEST 5: DPS 분산 ≤35% ───────
console.log('[T5] DPS 분산 ≤35%');
{
  // 각 클래스 모든 스킬의 평균 damage/cd (rawDPS) 계산
  const classDps = {};
  for (const cls of ['warrior','mage','archer','assassin']) {
    const mine = SKILLS.filter(s => s.classOnly === cls);
    const dpsVals = mine.map(s => s.damage > 0 && s.cd > 0 ? s.damage / s.cd : 0).filter(d => d > 0);
    classDps[cls] = dpsVals.length ? dpsVals.reduce((a,b) => a+b, 0) / dpsVals.length : 0;
  }
  const vals = Object.values(classDps);
  const mn = Math.min(...vals), mx = Math.max(...vals);
  const variance = mn > 0 ? (mx - mn) / mn : 1;
  for (const [cls, dps] of Object.entries(classDps)) console.log(`    ${cls}: avgDPS=${dps.toFixed(1)}`);
  ok(variance <= 0.35, `클래스간 DPS 분산 ${(variance*100).toFixed(1)}% ≤35%`);
}

// ─────── TEST 6: 신규 12 type 실행 검증 ───────
console.log('[T6] 신규 12 type 실제 실행(적 HP 감소 또는 효과 발동)');
{
  const newTypes = {
    vortex:          'w_gravity_slam',
    execute:         'w_final_blow',
    reflect_shield:  'w_counter_stance',
    leech_aura:      'w_blood_feast',
    dot_strike:      'w_bleed_strike',
    echo_shot:       'w_chain_blade',
    phantom_strike:  'm_phantom_flame',
    ground_slam:     'w_meteor_crash',
    time_slow_aoe:   'w_battle_howl',
    turret:          'm_frost_turret',
    mine:            'w_caltrops',
    whirlwind:       'w_whirlwind',
  };
  for (const [type, sid] of Object.entries(newTypes)) {
    const cls = SKILL_BY_ID[sid].classOnly;
    const g = new Game({ seed: 99 });
    const p = g.addPlayer('s1', 'T', cls);
    g.selectMutator(g.mutatorOffer[0].id);
    g.enemies = []; g.spawnQueue = [];
    p.x = 400; p.y = 360;
    for (let k = 0; k < 5; k++) { const e = g.spawnEnemy({ type:'slime', elite:null, boss:false }); e.x = 430+k*20; e.y = 360; e.hp = e.maxHp = 1000; }
    p.skills[0] = { id: sid, cdLeft: 0, cdMax: SKILL_BY_ID[sid].cd };
    p.input.aimAngle = 0;
    g.events = [];
    const used = g.useSkill('s1', 0, 0);
    // 5틱 더 굴려서 장판/포탑/지뢰 효과
    for (let i = 0; i < 30; i++) g.tick();
    const hpAfter = g.enemies.reduce((s, e) => s + e.hp, 0);
    const hpBefore = 5 * 1000;
    const ev = g.events.find(e => e.type === 'skill_cast' && e.id === sid);
    if (type === 'reflect_shield') {
      ok(used && p.reflectShield && p.reflectShield.reflectPct > 0, `${type}(${sid}) reflectShield 설정`);
    } else if (type === 'leech_aura' || type === 'mine' || type === 'whirlwind') {
      ok(used && (g.fields.some(f => f.owner === p.pid) || hpAfter < hpBefore), `${type}(${sid}) 필드생성 또는 피해`);
    } else if (type === 'turret') {
      ok(used && g.summons.some(sm => sm.stationary), `${type}(${sid}) 고정포탑 생성`);
    } else {
      ok(used && hpAfter < hpBefore, `${type}(${sid}) 적 HP 감소 (${hpBefore}→${hpAfter.toFixed(0)})`);
    }
  }
}

// ─────── TEST 7: 시너지 룰 구조 ───────
console.log('[T7] SYNERGY_RULES 구조·dmgMult 값');
{
  for (const [combo, rule] of Object.entries(SYNERGY_RULES || {})) {
    ok(typeof rule.key === 'string' && rule.key.length > 0, `${combo} key='${rule.key}'`);
    ok(typeof rule.dmgMult === 'number' && rule.dmgMult >= 1.2, `${combo} dmgMult=${rule.dmgMult} ≥1.2`);
  }
}

// ─────── 결과 ───────
console.log(`\n══════════════════════════════`);
console.log(`결과: ${passed} PASS / ${failed} FAIL`);
if (failed === 0) console.log('ALL PASS ✔');
else { console.error('FAIL 항목이 있습니다'); process.exit(1); }
