/* audio.js — Arena Wave 프로시저럴 사운드 FX  (owner: VFX)
 * Web Audio API 기반. 외부 파일 없이 전부 오실레이터·노이즈로 합성.
 *
 * window.GameAudio.play(key, opts)  — 사운드 재생
 * window.GameAudio.setVolume(0..1) — 마스터 볼륨
 * window.GameAudio.toggle()         — 뮤트 전환(볼륨 아이콘용)
 *
 * 사용 규칙:
 *   - AudioContext는 첫 사용자 인터랙션(클릭/키) 이후 초기화(Chrome 자동재생 정책).
 *   - 모든 play() 호출은 내부에서 resume/init 후 안전하게 실행.
 *   - 오류 시 조용히 무시(게임플레이 영향 없음).
 */
(function () {
  'use strict';

  var actx = null;
  var masterGain = null;
  var muted = false;
  var masterVol = 0.55;
  var initialized = false;

  // BGM 상태
  var bgmMasterGain = null;  // BGM 전용 gain (masterGain 하위, 볼륨·뮤트 연동)
  var bgmFadeGain   = null;  // 현재 트랙 채널 gain (크로스페이드용)
  var bgmTimer      = null;  // 스케줄러 setTimeout 핸들
  var bgmTrack      = null;  // 재생 중 트랙명 ('battle'|'lobby'|null)
  var bgmBeat       = 0;     // 현재 16분음표 인덱스
  var bgmNoteTime   = 0;     // 다음 음표 AudioContext 절대 시각
  var bgmPending    = null;  // 첫 인터랙션 전 예약 트랙명

  function init() {
    if (initialized) return;
    try {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      actx = new AC();
      masterGain = actx.createGain();
      masterGain.gain.value = masterVol;
      masterGain.connect(actx.destination);
      initialized = true;
    } catch (e) { /* Web Audio 없음 — 무음으로 진행 */ }
  }

  function resume() {
    if (actx && actx.state === 'suspended') {
      try { actx.resume(); } catch (e) {}
    }
  }

  // 첫 인터랙션에서 컨텍스트 초기화
  function onFirstInteraction() {
    init();
    resume();
    document.removeEventListener('click', onFirstInteraction);
    document.removeEventListener('keydown', onFirstInteraction);
    // 인터랙션 전 예약된 BGM 트랙 처리
    if (bgmPending) { var _p = bgmPending; bgmPending = null; playBgm(_p); }
  }
  document.addEventListener('click', onFirstInteraction, { passive: true });
  document.addEventListener('keydown', onFirstInteraction, { passive: true });

  // ── 저수준 헬퍼 ──

  function t0() { return actx ? actx.currentTime : 0; }

  /** 오실레이터 레이어 하나 생성·재생 */
  function osc(freq, type, gain, startT, endT, freqEnd) {
    if (!actx || !masterGain) return;
    var o = actx.createOscillator();
    var g = actx.createGain();
    o.type = type || 'sine';
    o.frequency.setValueAtTime(freq, startT);
    if (freqEnd != null && freqEnd > 0)
      o.frequency.exponentialRampToValueAtTime(Math.max(freqEnd, 0.001), endT);
    g.gain.setValueAtTime(Math.max(gain, 0.0001), startT);
    g.gain.exponentialRampToValueAtTime(0.0001, Math.max(endT, startT + 0.005));
    o.connect(g); g.connect(masterGain);
    o.start(startT);
    o.stop(Math.max(endT + 0.025, startT + 0.03));
  }

  /** 화이트노이즈 버스트 (밴드패스 필터 포함) */
  function noiseB(dur, gain, centerHz, q, startT) {
    if (!actx || !masterGain) return;
    var rate = actx.sampleRate;
    var len = Math.max(1, Math.ceil(rate * dur));
    var buf = actx.createBuffer(1, len, rate);
    var d = buf.getChannelData(0);
    for (var i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    var src = actx.createBufferSource();
    src.buffer = buf;
    var filt = actx.createBiquadFilter();
    filt.type = 'bandpass';
    filt.frequency.value = centerHz || 600;
    filt.Q.value = q || 1;
    var g = actx.createGain();
    g.gain.setValueAtTime(Math.max(gain, 0.0001), startT);
    g.gain.exponentialRampToValueAtTime(0.0001, Math.max(startT + dur, startT + 0.01));
    src.connect(filt); filt.connect(g); g.connect(masterGain);
    src.start(startT);
    src.stop(startT + dur + 0.02);
  }

  /** 저역통과 필터 스윕 오실레이터 */
  function oscLP(freq, freqEnd, type, gain, lpStart, lpEnd, startT, endT) {
    if (!actx || !masterGain) return;
    var o = actx.createOscillator();
    var filt = actx.createBiquadFilter();
    var g = actx.createGain();
    filt.type = 'lowpass';
    filt.frequency.setValueAtTime(lpStart, startT);
    filt.frequency.exponentialRampToValueAtTime(Math.max(lpEnd, 20), endT);
    o.type = type || 'sawtooth';
    o.frequency.setValueAtTime(freq, startT);
    if (freqEnd > 0) o.frequency.exponentialRampToValueAtTime(Math.max(freqEnd, 0.001), endT);
    g.gain.setValueAtTime(Math.max(gain, 0.0001), startT);
    g.gain.exponentialRampToValueAtTime(0.0001, endT);
    o.connect(filt); filt.connect(g); g.connect(masterGain);
    o.start(startT);
    o.stop(endT + 0.03);
  }

  // ── 사운드 정의 (키→함수 맵) ──

  var SOUNDS = {

    /* 오브 픽업 — 짧은 스파클 챔피언 (0.22s) */
    pickup_orb: function () {
      var t = t0();
      osc(1047, 'sine', 0.12, t, t + 0.18, 2094);
      osc(1568, 'sine', 0.07, t + 0.04, t + 0.2, 3136);
    },

    /* 오브 10개 임계치 — 드라마틱 상승+붐 (0.75s) */
    orb_threshold: function () {
      var t = t0();
      // 상승 사운드
      osc(220, 'sawtooth', 0.22, t, t + 0.4, 880);
      osc(330, 'sawtooth', 0.14, t + 0.05, t + 0.45, 1320);
      // 고음 반짝임
      osc(3520, 'sine', 0.07, t + 0.3, t + 0.58, 2200);
      // 심층 붐
      var o = actx.createOscillator();
      var g = actx.createGain();
      o.type = 'sine';
      o.frequency.setValueAtTime(90, t + 0.32);
      o.frequency.exponentialRampToValueAtTime(28, t + 0.75);
      g.gain.setValueAtTime(0.52, t + 0.32);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.75);
      o.connect(g); g.connect(masterGain);
      o.start(t + 0.32); o.stop(t + 0.78);
      noiseB(0.22, 0.18, 200, 0.7, t + 0.32);
    },

    /* 업그레이드 화면 오픈 — 시간정지 스윕 (0.95s) */
    upgrade_open: function () {
      var t = t0();
      // 저역통과 스윕 (시간이 멈추는 느낌)
      oscLP(160, 55, 'sawtooth', 0.28, 2200, 140, t, t + 0.55);
      // 공명 핑
      osc(1108, 'sine', 0.16, t + 0.08, t + 0.88, 554);
      osc(554,  'sine', 0.11, t + 0.12, t + 0.92, 277);
      // 섬세한 노이즈 스윕
      noiseB(0.45, 0.10, 700, 0.4, t);
    },

    /* 업그레이드 카드 선택 — 확정 챠임 + 베이스 (0.4s) */
    upgrade_select: function () {
      var t = t0();
      // 메이저 코드 히트 (C5-E5-G5)
      osc(523, 'sine', 0.32, t, t + 0.35, 523);
      osc(659, 'sine', 0.22, t + 0.04, t + 0.38, 659);
      osc(784, 'sine', 0.16, t + 0.08, t + 0.40, 784);
      // 베이스 펀치
      var bo = actx.createOscillator();
      var bg = actx.createGain();
      bo.type = 'sine';
      bo.frequency.setValueAtTime(130, t);
      bo.frequency.exponentialRampToValueAtTime(48, t + 0.22);
      bg.gain.setValueAtTime(0.44, t);
      bg.gain.exponentialRampToValueAtTime(0.0001, t + 0.26);
      bo.connect(bg); bg.connect(masterGain);
      bo.start(t); bo.stop(t + 0.28);
    },

    /* 효과 즉시 적용 — 상승 아르페지오 (0.55s) */
    effect_applied: function (opts) {
      var t = t0();
      var tp = (opts && opts.type) || 'atk';
      // 타입별 기본 피치
      var base = tp === 'hp' ? 392 : tp === 'spd' ? 523 : 659;
      var freqs = [base, base * 1.25, base * 1.5, base * 2.0];
      freqs.forEach(function (f, i) {
        osc(f, 'sine', 0.22, t + i * 0.075, t + i * 0.075 + 0.26);
      });
      // 마무리 광채
      osc(base * 4, 'sine', 0.07, t + 0.28, t + 0.56, base * 2);
    },

    /* 적 처치 — 임팩트 펀치 (0.18s) */
    enemy_kill: function () {
      var t = t0();
      noiseB(0.15, 0.18, 280, 1.8, t);
      osc(160, 'sine', 0.28, t, t + 0.12, 55);
    },

    /* 보스 처치 — 에픽 붐 + 팡파레 (1.3s) */
    boss_kill: function () {
      var t = t0();
      noiseB(0.55, 0.32, 180, 0.9, t);
      osc(70, 'sine', 0.48, t, t + 0.55, 28);
      osc(140, 'sawtooth', 0.28, t + 0.08, t + 0.62, 38);
      // 승리 스팅 (C5→E5→G5→C6)
      var vfreqs = [523, 659, 784, 1047];
      vfreqs.forEach(function (f, i) {
        osc(f, 'sine', 0.24, t + 0.52 + i * 0.11, t + 0.52 + i * 0.11 + 0.22);
      });
    },

    /* 플레이어 피격 — 임팩트 노이즈 + 피치 드롭 (0.3s) */
    player_hit: function () {
      var t = t0();
      noiseB(0.22, 0.28, 160, 1.4, t);
      osc(200, 'sine', 0.24, t, t + 0.22, 75);
    },

    /* 힐 — 부드러운 상승 (0.35s) */
    heal: function () {
      var t = t0();
      osc(523, 'sine', 0.14, t, t + 0.3, 784);
      osc(659, 'sine', 0.09, t + 0.06, t + 0.33, 1047);
    },

    /* 웨이브 시작 — 팡파레 or 불길한 저음 (0.7s) */
    wave_start: function (opts) {
      var t = t0();
      var boss = opts && opts.boss;
      if (boss) {
        osc(55,  'sawtooth', 0.28, t, t + 0.75, 55);
        osc(82,  'sawtooth', 0.18, t, t + 0.7,  82);
        noiseB(0.55, 0.18, 110, 0.7, t + 0.18);
      } else {
        osc(392, 'triangle', 0.18, t, t + 0.38, 523);
        osc(523, 'triangle', 0.14, t + 0.15, t + 0.52);
        osc(659, 'triangle', 0.11, t + 0.28, t + 0.65);
      }
    },

    /* 웨이브 클리어 — 밝은 5음계 상승 (0.65s) */
    wave_clear: function () {
      var t = t0();
      var notes = [523, 659, 784, 1047, 1319];
      notes.forEach(function (f, i) {
        osc(f, 'sine', 0.20 - i * 0.02, t + i * 0.088, t + i * 0.088 + 0.28);
      });
    },

    /* 스킬 발동 — skillType 분기 (0.18~0.5s) */
    skill_cast: function (opts) {
      var st = opts && opts.skillType;
      if (st === 'stun_strike')        { SOUNDS.skill_stun_strike(opts);        return; }
      if (st === 'multi_hit')          { SOUNDS.skill_multi_hit(opts);          return; }
      if (st === 'shield_stance')      { SOUNDS.skill_shield_stance(opts);      return; }
      if (st === 'nova')               { SOUNDS.skill_nova(opts);               return; }
      if (st === 'aoe_field')          { SOUNDS.skill_aoe_field(opts);          return; }
      if (st === 'chain')              { SOUNDS.skill_chain(opts);              return; }
      if (st === 'projectile_barrage') { SOUNDS.skill_projectile_barrage(opts); return; }
      if (st === 'buff')               { SOUNDS.skill_buff(opts);               return; }
      if (st === 'summon')             { SOUNDS.skill_summon(opts);             return; }
      if (st === 'dash_strike')        { SOUNDS.skill_dash_strike(opts);        return; }
      if (st === 'vortex')             { SOUNDS.skill_vortex(opts);             return; }
      if (st === 'execute')            { SOUNDS.skill_execute(opts);            return; }
      if (st === 'reflect_shield')     { SOUNDS.skill_reflect_shield(opts);     return; }
      if (st === 'leech_aura')         { SOUNDS.skill_leech_aura(opts);         return; }
      if (st === 'dot_strike')         { SOUNDS.skill_dot_strike(opts);         return; }
      if (st === 'ground_slam')        { SOUNDS.skill_ground_slam(opts);        return; }
      if (st === 'time_slow_aoe')      { SOUNDS.skill_time_slow_aoe(opts);      return; }
      if (st === 'whirlwind')          { SOUNDS.skill_whirlwind(opts);          return; }
      if (st === 'echo_shot')          { SOUNDS.skill_echo_shot(opts);          return; }
      if (st === 'mine')               { SOUNDS.skill_mine(opts);               return; }
      if (st === 'phantom_strike')     { SOUNDS.skill_phantom_strike(opts);     return; }
      if (st === 'turret')             { SOUNDS.skill_turret(opts);             return; }
      // generic 폴백
      var t = t0();
      noiseB(0.16, 0.13, 900, 0.4, t);
      osc(880, 'square', 0.06, t, t + 0.14, 440);
    },

    /* ── 캐릭터 전용 스킬 사운드 ── */

    /* 오렌지 임팩트 — 무거운 타격 + 스턴 찌릿 (0.4s)
     * 감정 계층: [충격] 저역 펀치 → [마비] 고역 전기 스파크 2단 레이어 */
    skill_stun_strike: function () {
      var t = t0();
      // 1. 무거운 저역 타격 펀치 (sub-bass 붐)
      var bo = actx.createOscillator();
      var bg = actx.createGain();
      bo.type = 'sine';
      bo.frequency.setValueAtTime(110, t);
      bo.frequency.exponentialRampToValueAtTime(30, t + 0.28);
      bg.gain.setValueAtTime(0.60, t);
      bg.gain.exponentialRampToValueAtTime(0.0001, t + 0.30);
      bo.connect(bg); bg.connect(masterGain);
      bo.start(t); bo.stop(t + 0.32);
      // 2. 임팩트 크런치 노이즈 (오렌지 질감 — 중저역 밴드패스)
      noiseB(0.12, 0.35, 320, 2.2, t);
      // 3. 스턴 찌릿 — 전기 버즈 (고역 square, 빠른 피치 드롭)
      osc(1100, 'square', 0.09, t + 0.05, t + 0.22, 480);
      osc(1600, 'square', 0.05, t + 0.08, t + 0.18, 600);
      // 4. 잔향 링 (마비 지속감)
      osc(440, 'sine', 0.04, t + 0.20, t + 0.40, 420);
    },

    /* 핑크 연속 타격 — 5연타 드럼롤, 점층 강도 (0.45s)
     * 감정 계층: [연속 타격] 타격마다 볼륨+피치 상승 → 마지막 타격 클라이막스 */
    skill_multi_hit: function () {
      var t = t0();
      var hitInterval = 0.075; // 75ms 간격으로 5타
      var baseGain   = [0.12, 0.16, 0.20, 0.26, 0.34];
      var baseFreq   = [340,  380,  420,  470,  540];
      var noiseGain  = [0.08, 0.11, 0.14, 0.18, 0.24];
      for (var i = 0; i < 5; i++) {
        var ht = t + i * hitInterval;
        // 각 타격 임팩트 노이즈 (핑크 — 중고역 밴드패스)
        noiseB(0.055, noiseGain[i], baseFreq[i], 3.5, ht);
        // 각 타격 오실레이터 (피치 드롭)
        osc(baseFreq[i] * 2.2, 'triangle', baseGain[i], ht, ht + 0.06, baseFreq[i]);
      }
      // 5연타 완성 — 마무리 임팩트 플래시 (고역 핑크 신스)
      osc(1240, 'sine', 0.07, t + 0.35, t + 0.45, 880);
    },

    /* 청색 방어 발동 — 마법진 울림 + 수정 핑 (0.5s)
     * 감정 계층: [보호/안정] 저역 공명 → 고역 수정 핑 → 지속 방어막 울림 */
    skill_shield_stance: function () {
      var t = t0();
      // 1. 마법진 저역 공명 (부드러운 기동음)
      var mo = actx.createOscillator();
      var mf = actx.createBiquadFilter();
      var mg = actx.createGain();
      mo.type = 'sine';
      mo.frequency.setValueAtTime(110, t);
      mo.frequency.linearRampToValueAtTime(165, t + 0.25); // 완만 상승
      mf.type = 'bandpass';
      mf.frequency.value = 200;
      mf.Q.value = 1.8;
      mg.gain.setValueAtTime(0.0001, t);
      mg.gain.linearRampToValueAtTime(0.38, t + 0.12);
      mg.gain.exponentialRampToValueAtTime(0.0001, t + 0.50);
      mo.connect(mf); mf.connect(mg); mg.connect(masterGain);
      mo.start(t); mo.stop(t + 0.52);
      // 2. 수정 핑 (청색 high-end 반짝임)
      osc(2200, 'sine', 0.10, t + 0.06, t + 0.42, 1760);
      osc(3300, 'sine', 0.05, t + 0.10, t + 0.38, 2640);
      // 3. 방어막 성립 하모닉 (퍼펙트 5th 공명)
      osc(330,  'sine', 0.06, t + 0.18, t + 0.50, 330);
      osc(495,  'sine', 0.04, t + 0.18, t + 0.50, 495);
      // 4. 마법진 노이즈 스윕 (얇은 청색 입자감)
      noiseB(0.20, 0.06, 1800, 4.0, t + 0.05);
    },

    /* nova — 폭발적 충격파 (0.65s)
     * 감정 계층: [폭발/충격파] 서브베이스 붐 → 저→고 주파수 급상승 스윕 → 에너지 잔향
     * 충격파가 바깥으로 퍼지는 느낌. 저역 붐 먼저 치고, 사운드가 고역으로 열린다. */
    skill_nova: function () {
      var t = t0();
      // 1. 서브베이스 충격파 발생 (폭발 시작점, 묵직한 토대)
      var bo = actx.createOscillator();
      var bg = actx.createGain();
      bo.type = 'sine';
      bo.frequency.setValueAtTime(80, t);
      bo.frequency.exponentialRampToValueAtTime(22, t + 0.48);
      bg.gain.setValueAtTime(0.65, t);
      bg.gain.exponentialRampToValueAtTime(0.0001, t + 0.52);
      bo.connect(bg); bg.connect(masterGain);
      bo.start(t); bo.stop(t + 0.54);
      // 2. 충격파 스윕 — LP 필터 급상승 (폭발이 바깥으로 퍼지는 느낌)
      oscLP(120, 2400, 'sawtooth', 0.35, 80, 4000, t + 0.02, t + 0.38);
      // 3. 전방위 노이즈 버스트 (충격파 질감 — 저역 + 중역 두 레이어)
      noiseB(0.22, 0.30, 500, 0.5, t);
      noiseB(0.14, 0.20, 1800, 0.9, t + 0.08);
      // 4. 고역 공명 잔향 (에너지 방출 후 울림, 옥타브 5th 쌍)
      osc(1760, 'sine', 0.08, t + 0.28, t + 0.65, 880);
      osc(2640, 'sine', 0.04, t + 0.32, t + 0.65, 1320);
    },

    /* aoe_field — 장판 생성 (0.68s)
     * 감정 계층: [지형/위협] 대지 저역 럼블 → 갈라지는 크런치 → 장판 공명 안착
     * 땅이 떨리다가 장판이 솟아올라 고정되는 느낌. 지속감과 묵직함이 핵심. */
    skill_aoe_field: function () {
      var t = t0();
      // 1. 대지 럼블 — 서서히 올라오는 저역 진동 (땅이 떨리는 토대음)
      var eo = actx.createOscillator();
      var eg = actx.createGain();
      eo.type = 'sine';
      eo.frequency.setValueAtTime(55, t);
      eo.frequency.linearRampToValueAtTime(42, t + 0.62);
      eg.gain.setValueAtTime(0.0001, t);
      eg.gain.linearRampToValueAtTime(0.50, t + 0.15);
      eg.gain.exponentialRampToValueAtTime(0.0001, t + 0.68);
      eo.connect(eg); eg.connect(masterGain);
      eo.start(t); eo.stop(t + 0.70);
      // 2. 지면 크런치 노이즈 (땅이 갈라지는 질감 — 저역 2단 레이어)
      noiseB(0.28, 0.28, 180, 1.2, t + 0.04);
      noiseB(0.18, 0.14, 360, 2.0, t + 0.20);
      // 3. 장판 솟아오름 — LP 스윕 (저→중역, 에너지가 땅에서 솟는 느낌)
      oscLP(60, 220, 'sawtooth', 0.22, 60, 600, t + 0.12, t + 0.55);
      // 4. 장판 활성화 공명 (안착 완료 저역 하모닉 — 지속감)
      osc(110, 'sine', 0.06, t + 0.42, t + 0.68, 110);
      osc(165, 'sine', 0.04, t + 0.44, t + 0.68, 165);
    },

    /* chain — 연쇄 번개 (0.45s)
     * 감정 계층: [연쇄/전기] 전기 체인이 순서대로 점프 → 연쇄 클라이막스 방전
     * 탁탁탁 빠른 체인 점프 + 마지막에 강한 번개 방전. 각 타격마다 고역 상승. */
    skill_chain: function () {
      var t = t0();
      // 전기 체인 점프 — 4연쇄 (점점 높고 강하게)
      var chainTimes = [0, 0.088, 0.168, 0.240];
      var chainFreqs = [1800, 2200, 2700, 3300];
      var chainGains = [0.12, 0.16, 0.20, 0.26];
      for (var i = 0; i < 4; i++) {
        var ct = t + chainTimes[i];
        // 체인 버즈 (square, 빠른 피치 드롭 — 전기 점프 질감)
        osc(chainFreqs[i], 'square', chainGains[i], ct, ct + 0.055, chainFreqs[i] * 0.38);
        // 체인 스파크 노이즈 (고역 전기 임팩트)
        noiseB(0.040, chainGains[i] * 0.65, chainFreqs[i] * 0.75, 6.0, ct);
      }
      // 연쇄 완성 — 마지막 번개 방전 (저역 잔상 + 중역 노이즈)
      osc(180, 'sawtooth', 0.14, t + 0.27, t + 0.42, 55);
      noiseB(0.12, 0.16, 800, 1.5, t + 0.26);
      // 잔여 전기 지직거림 (고역 감쇠)
      osc(4400, 'square', 0.04, t + 0.29, t + 0.38, 2200);
    },

    /* projectile_barrage — 연속 발사 (0.55s)
     * 감정 계층: [연사/빠름] 가볍고 날카로운 연사, 마지막에 강한 마무리 타격
     * 6발 연속 발사 — 발사마다 조금씩 강해지고, 마지막 발이 가장 임팩트. */
    skill_projectile_barrage: function () {
      var t = t0();
      var shotCount = 6;
      var interval  = 0.068; // 68ms 연사 간격
      for (var i = 0; i < shotCount; i++) {
        var st2 = t + i * interval;
        // 발사 클릭 노이즈 (날카로운 고역 임팩트 — 연사 질감)
        noiseB(0.032, 0.12 + i * 0.010, 2800, 5.5, st2);
        // 투사체 출발음 (빠른 피치 하강 — 슝 느낌)
        osc(1400 - i * 28, 'triangle', 0.065, st2, st2 + 0.042, 560);
      }
      // 마지막 발 강조 임팩트 (연사 완료, 강한 마무리)
      var finT = t + shotCount * interval;
      osc(900, 'sine', 0.08, finT, finT + 0.09, 380);
      noiseB(0.09, 0.14, 1200, 1.8, finT);
    },

    /* buff — 버프 기동 (0.62s)
     * 감정 계층: [보상/강화] 마법진 기동 → 에너지 상승 → 힘 충전 완료 반짝임
     * 힘이 서서히 차오르다가 고역 핑으로 완성. 상승감·보상감이 핵심. */
    skill_buff: function () {
      var t = t0();
      // 1. 마법진 기동 — 저역 서서히 차오름 (힘이 쌓이는 느낌)
      var po = actx.createOscillator();
      var pg = actx.createGain();
      po.type = 'sine';
      po.frequency.setValueAtTime(110, t);
      po.frequency.linearRampToValueAtTime(220, t + 0.50);
      pg.gain.setValueAtTime(0.0001, t);
      pg.gain.linearRampToValueAtTime(0.36, t + 0.22);
      pg.gain.exponentialRampToValueAtTime(0.0001, t + 0.60);
      po.connect(pg); pg.connect(masterGain);
      po.start(t); po.stop(t + 0.62);
      // 2. 에너지 상승 스윕 (LP 스윕 — 힘이 위로 차오르는 느낌)
      oscLP(180, 440, 'sawtooth', 0.18, 300, 2000, t + 0.08, t + 0.50);
      // 3. 마법진 하모닉 구조 (옥타브 + 5th 공명 — 안정감)
      osc(220, 'sine', 0.09, t + 0.16, t + 0.55, 220);
      osc(330, 'sine', 0.06, t + 0.19, t + 0.55, 330);
      // 4. 충전 완료 반짝임 (고역 핑 + 고역 노이즈 — 파워업 보상음)
      osc(2200, 'sine', 0.10, t + 0.43, t + 0.62, 4400);
      osc(3300, 'sine', 0.06, t + 0.45, t + 0.62, 6600);
      noiseB(0.09, 0.08, 3000, 3.0, t + 0.45);
    },

    /* summon — 소환 의식 (0.82s)
     * 감정 계층: [신비/소환] 이계 공간 열림 → 의식 파동 공명 → 소환체 출현 충격
     * 소환은 가장 느리고 묵직해야 한다. 공간감·신비감 → 묵직한 출현 임팩트. */
    skill_summon: function () {
      var t = t0();
      // 1. 이계 공명 — 깊은 저역 베이스 (공간이 열리는 느낌, 서서히 강해짐)
      var so = actx.createOscillator();
      var sg = actx.createGain();
      so.type = 'sine';
      so.frequency.setValueAtTime(40, t);
      so.frequency.linearRampToValueAtTime(55, t + 0.72);
      sg.gain.setValueAtTime(0.0001, t);
      sg.gain.linearRampToValueAtTime(0.48, t + 0.28);
      sg.gain.exponentialRampToValueAtTime(0.0001, t + 0.82);
      so.connect(sg); sg.connect(masterGain);
      so.start(t); so.stop(t + 0.84);
      // 2. 소환 의식 파동 — 신비 하모닉 (이계 진동, 3성부 화음)
      osc(220, 'sine',     0.14, t + 0.06, t + 0.66, 165);
      osc(330, 'triangle', 0.09, t + 0.09, t + 0.68, 247);
      osc(495, 'sine',     0.05, t + 0.13, t + 0.65, 370);
      // 3. 의식 노이즈 럼블 (신비감 강화 — 낮은 저역 스모크)
      noiseB(0.35, 0.16, 150, 0.8, t + 0.12);
      // 4. 마법진 고역 입자 (신비 에너지 파티클 — 얇고 높게)
      osc(1760, 'sine', 0.07, t + 0.18, t + 0.56, 2640);
      osc(2640, 'sine', 0.04, t + 0.22, t + 0.52, 3520);
      // 5. 소환 완성 출현 임팩트 (묵직한 붐 + 크런치)
      noiseB(0.18, 0.28, 300, 1.5, t + 0.60);
      osc(110, 'sine', 0.22, t + 0.60, t + 0.82, 38);
    },

    /* dash_strike — 대시 타격 (0.44s)
     * 감정 계층: [속도/타격] 공기를 가르는 이동 스윕 → 강한 충돌 임팩트 → 에너지 분산
     * 이동과 타격 두 단계가 명확히 구분되어야 한다. 스윕 → 임팩트 순서가 핵심. */
    skill_dash_strike: function () {
      var t = t0();
      // 1. 대시 스윕 — 공기 가르는 swoosh (노이즈 + LP 급상승)
      noiseB(0.10, 0.22, 1600, 0.3, t);
      oscLP(280, 1800, 'sawtooth', 0.16, 500, 3000, t, t + 0.11);
      // 2. 타격 임팩트 붐 — 강한 충돌 서브베이스 (스윕 끝나자마자 치고 들어옴)
      var io = actx.createOscillator();
      var ig = actx.createGain();
      io.type = 'sine';
      io.frequency.setValueAtTime(120, t + 0.11);
      io.frequency.exponentialRampToValueAtTime(32, t + 0.40);
      ig.gain.setValueAtTime(0.62, t + 0.11);
      ig.gain.exponentialRampToValueAtTime(0.0001, t + 0.42);
      io.connect(ig); ig.connect(masterGain);
      io.start(t + 0.11); io.stop(t + 0.44);
      // 3. 임팩트 크런치 노이즈 (타격 질감 — 중저역 밴드패스)
      noiseB(0.14, 0.30, 380, 2.0, t + 0.11);
      // 4. 고역 임팩트 분산 (타격 후 에너지 방출 — 에지감)
      osc(1400, 'square', 0.06, t + 0.13, t + 0.28, 420);
      noiseB(0.09, 0.10, 2200, 3.5, t + 0.12);
    },

    /* vortex — 소용돌이/끌어당김 (0.65s)
     * 감정 계층: [흡입/회전] 저음 회전 풍압 → 점점 당겨지는 피치 하강 → 중심 흡수 임팩트 */
    skill_vortex: function () {
      var t = t0();
      // 1. 저음 회전 베이스 — 점점 낮아지는 피치 (끌어당김 표현)
      var vo = actx.createOscillator();
      var vg = actx.createGain();
      vo.type = 'sawtooth';
      vo.frequency.setValueAtTime(160, t);
      vo.frequency.exponentialRampToValueAtTime(55, t + 0.60);
      vg.gain.setValueAtTime(0.0001, t);
      vg.gain.linearRampToValueAtTime(0.38, t + 0.10);
      vg.gain.exponentialRampToValueAtTime(0.0001, t + 0.65);
      vo.connect(vg); vg.connect(masterGain);
      vo.start(t); vo.stop(t + 0.67);
      // 2. 회전 저역 노이즈 (풍압 — 두꺼운 저역 밴드패스)
      noiseB(0.55, 0.25, 120, 1.2, t);
      noiseB(0.35, 0.14, 240, 2.0, t + 0.15);
      // 3. 흡수 중심 공명 (중역 피치 하강 — 중심으로 빨려드는 느낌)
      oscLP(300, 80, 'sawtooth', 0.18, 800, 100, t + 0.20, t + 0.62);
      // 4. 고역 회오리 끝 — 소멸 스파크
      osc(1800, 'sine', 0.04, t + 0.55, t + 0.65, 900);
    },

    /* execute — 처형 일격 (0.55s)
     * 감정 계층: [극적 결말] 서브베이스 폭발 타격 → 고음 슬래시 절단 → 결말 잔향 */
    skill_execute: function () {
      var t = t0();
      // 1. 서브베이스 폭발 타격 — 극도로 묵직한 붐
      var eo = actx.createOscillator();
      var eg = actx.createGain();
      eo.type = 'sine';
      eo.frequency.setValueAtTime(55, t);
      eo.frequency.exponentialRampToValueAtTime(22, t + 0.52);
      eg.gain.setValueAtTime(0.70, t);
      eg.gain.exponentialRampToValueAtTime(0.0001, t + 0.55);
      eo.connect(eg); eg.connect(masterGain);
      eo.start(t); eo.stop(t + 0.57);
      // 2. 충돌 크런치 노이즈 (극적 타격 질감 — 저중역 밀도 있는 크런치)
      noiseB(0.18, 0.40, 280, 1.8, t);
      noiseB(0.10, 0.28, 560, 2.5, t + 0.02);
      // 3. 고음 슬래시 절단 (예리한 상승 사인파 — 검이 뚫고 지나가는 느낌)
      osc(1200, 'sine', 0.12, t + 0.04, t + 0.22, 3600);
      osc(2400, 'sine', 0.07, t + 0.06, t + 0.20, 5800);
      // 4. 처형 완료 잔향 (저역 공명 — 결말감)
      osc(130, 'sine', 0.06, t + 0.28, t + 0.55, 110);
    },

    /* reflect_shield — 반사 방어막 (0.58s)
     * 감정 계층: [보호/반격] 차징 공명 → 방어막 성립 → 메탈 반사 핑 반짝임 */
    skill_reflect_shield: function () {
      var t = t0();
      // 1. 차징 공명 — 고역으로 상승하는 보호막 에너지 (밴드패스 필터)
      var ro = actx.createOscillator();
      var rf = actx.createBiquadFilter();
      var rg = actx.createGain();
      ro.type = 'sine';
      ro.frequency.setValueAtTime(220, t);
      ro.frequency.linearRampToValueAtTime(660, t + 0.28);
      rf.type = 'bandpass';
      rf.frequency.value = 400;
      rf.Q.value = 2.0;
      rg.gain.setValueAtTime(0.0001, t);
      rg.gain.linearRampToValueAtTime(0.30, t + 0.18);
      rg.gain.exponentialRampToValueAtTime(0.0001, t + 0.38);
      ro.connect(rf); rf.connect(rg); rg.connect(masterGain);
      ro.start(t); ro.stop(t + 0.40);
      // 2. 방어막 성립 — 고역 수정 핑 (반짝이는 금속 반사음)
      osc(3520, 'sine', 0.14, t + 0.26, t + 0.58, 1760);
      osc(4400, 'sine', 0.08, t + 0.28, t + 0.55, 2200);
      osc(2640, 'sine', 0.06, t + 0.30, t + 0.58, 1320);
      // 3. 금속 반사 노이즈 (고역 메탈릭 텍스처)
      noiseB(0.12, 0.12, 4000, 5.0, t + 0.26);
      // 4. 방어막 지속 저역 공명 (안정적 보호 신호)
      osc(220, 'sine', 0.05, t + 0.35, t + 0.58, 220);
    },

    /* leech_aura — 흡혈 오라 (0.72s)
     * 감정 계층: [흡수/생명력] 끈적한 저역 지속 흡수 → 심장박동 리듬 → 생명력 흡수 완료 */
    skill_leech_aura: function () {
      var t = t0();
      // 1. 흡수 지속음 — 낮고 끈적한 저역 오라 (사인파, 느린 피치 진동)
      var la = actx.createOscillator();
      var lag = actx.createGain();
      la.type = 'sine';
      la.frequency.setValueAtTime(48, t);
      la.frequency.linearRampToValueAtTime(52, t + 0.36);
      la.frequency.linearRampToValueAtTime(46, t + 0.72);
      lag.gain.setValueAtTime(0.0001, t);
      lag.gain.linearRampToValueAtTime(0.35, t + 0.08);
      lag.gain.exponentialRampToValueAtTime(0.0001, t + 0.72);
      la.connect(lag); lag.connect(masterGain);
      la.start(t); la.stop(t + 0.74);
      // 2. 심장박동 리듬 — 저역 펄스 2회 (둥-둥)
      var beatTimes = [0.06, 0.22];
      beatTimes.forEach(function (bt) {
        var bpo = actx.createOscillator();
        var bpg = actx.createGain();
        bpo.type = 'sine';
        bpo.frequency.setValueAtTime(80, t + bt);
        bpo.frequency.exponentialRampToValueAtTime(30, t + bt + 0.14);
        bpg.gain.setValueAtTime(0.38, t + bt);
        bpg.gain.exponentialRampToValueAtTime(0.0001, t + bt + 0.16);
        bpo.connect(bpg); bpg.connect(masterGain);
        bpo.start(t + bt); bpo.stop(t + bt + 0.18);
      });
      // 3. 흡수 노이즈 — 끈적한 저역 스모크
      noiseB(0.40, 0.14, 140, 1.0, t + 0.05);
      // 4. 생명력 흡수 완료 — 중역 공명 (작은 보상음)
      osc(660, 'sine', 0.06, t + 0.55, t + 0.72, 880);
    },

    /* dot_strike — 출혈/독 타격 (0.50s)
     * 감정 계층: [관통/오염] 찌르기 임팩트 → 독 틱 버블 시퀀스 → 오염 잔향 */
    skill_dot_strike: function () {
      var t = t0();
      // 1. 찌르기 임팩트 — 날카로운 중고역 타격 (관통감)
      noiseB(0.08, 0.30, 1800, 4.5, t);
      osc(1600, 'triangle', 0.12, t, t + 0.10, 400);
      // 2. 독 틱 버블 — 4회 작은 버블음 (오염 진행)
      var tickTimes = [0.12, 0.22, 0.32, 0.42];
      var tickFreqs = [280, 320, 260, 300];
      tickTimes.forEach(function (tt, i) {
        osc(tickFreqs[i], 'sine', 0.07, t + tt, t + tt + 0.06, tickFreqs[i] * 1.4);
        noiseB(0.04, 0.05, 400, 3.0, t + tt);
      });
      // 3. 오염 잔향 — 저역 감쇠 공명 (독이 퍼지는 느낌)
      oscLP(200, 80, 'sawtooth', 0.10, 300, 80, t + 0.18, t + 0.50);
    },

    /* ground_slam — 지면 강타 (0.62s)
     * 감정 계층: [충격/지진] 서브베이스 붐 → 지면 균열 노이즈 → 지진 잔동 */
    skill_ground_slam: function () {
      var t = t0();
      // 1. 서브베이스 붐 — 매우 낮은 임팩트 (지면 강타의 핵심)
      var gso = actx.createOscillator();
      var gsg = actx.createGain();
      gso.type = 'sine';
      gso.frequency.setValueAtTime(80, t);
      gso.frequency.exponentialRampToValueAtTime(18, t + 0.50);
      gsg.gain.setValueAtTime(0.75, t);
      gsg.gain.exponentialRampToValueAtTime(0.0001, t + 0.55);
      gso.connect(gsg); gsg.connect(masterGain);
      gso.start(t); gso.stop(t + 0.57);
      // 2. 지면 균열 노이즈 (저역 밀도 — 땅이 갈라지는 거친 질감)
      noiseB(0.30, 0.45, 160, 0.8, t);
      noiseB(0.20, 0.28, 90, 0.5, t + 0.04);
      // 3. 충격파 확산 노이즈 (중저역 — 크랙 균열 퍼짐)
      noiseB(0.18, 0.18, 380, 1.5, t + 0.08);
      // 4. 지진 잔동 — 저역 떨림 (지면 진동 지속)
      oscLP(55, 38, 'sawtooth', 0.15, 100, 40, t + 0.30, t + 0.62);
    },

    /* time_slow_aoe — 시간 둔화 (0.80s)
     * 감정 계층: [시간/이더리얼] 피치 다운 스윕 → 공간 감속 → 이더리얼 잔향 */
    skill_time_slow_aoe: function () {
      var t = t0();
      // 1. 피치 다운 스윕 — 시간이 느려지는 느낌 (사인파 급격한 하강)
      var tso = actx.createOscillator();
      var tsg = actx.createGain();
      tso.type = 'sine';
      tso.frequency.setValueAtTime(880, t);
      tso.frequency.exponentialRampToValueAtTime(55, t + 0.55);
      tsg.gain.setValueAtTime(0.22, t);
      tsg.gain.exponentialRampToValueAtTime(0.0001, t + 0.62);
      tso.connect(tsg); tsg.connect(masterGain);
      tso.start(t); tso.stop(t + 0.64);
      // 2. 고역 피치 다운 레이어 (옥타브 위 — 시간이 멈추는 풍부한 질감)
      osc(1760, 'sine', 0.12, t + 0.04, t + 0.50, 110);
      // 3. 이더리얼 노이즈 스윕 (넓은 공간감 — 고역 얇은 노이즈)
      noiseB(0.50, 0.08, 2000, 0.3, t + 0.08);
      // 4. 이더리얼 잔향 — 고역 공명 페이드아웃 (신비감)
      osc(1320, 'sine', 0.07, t + 0.45, t + 0.80, 660);
      osc(1980, 'sine', 0.04, t + 0.50, t + 0.80, 990);
      // 5. 저역 무게감 — 시간 왜곡 베이스
      osc(82, 'sine', 0.08, t + 0.12, t + 0.65, 55);
    },

    /* whirlwind — 회오리 (0.70s)
     * 감정 계층: [회전/절단] 회전 저주파 노이즈 → 날 스윙 반복 → 회오리 정점 */
    skill_whirlwind: function () {
      var t = t0();
      // 1. 회전 저주파 노이즈 — 회오리 핵심 사운드 (두꺼운 저역)
      noiseB(0.55, 0.28, 130, 0.7, t);
      noiseB(0.40, 0.18, 260, 1.2, t + 0.08);
      // 2. 날 스윙 반복 — 4회 빠른 슬래시 스윕 (회전마다 칼바람)
      var swingTimes = [0.02, 0.17, 0.32, 0.47];
      swingTimes.forEach(function (sw) {
        noiseB(0.10, 0.18, 1400, 0.4, t + sw);
        oscLP(800, 2400, 'sawtooth', 0.08, 1000, 4000, t + sw, t + sw + 0.10);
      });
      // 3. 회오리 정점 — 고역 급상승 (스킬 클라이막스)
      osc(1200, 'sine', 0.08, t + 0.55, t + 0.70, 2400);
      noiseB(0.12, 0.15, 2000, 2.5, t + 0.56);
    },

    /* echo_shot — 반사 투사체 (0.65s)
     * 감정 계층: [발사/반향] 발사 클릭 → 핑 핑 핑 메탈 반향 시퀀스 → 잔향 소멸 */
    skill_echo_shot: function () {
      var t = t0();
      // 1. 발사 클릭 — 날카로운 발사 임팩트
      noiseB(0.06, 0.25, 3000, 6.0, t);
      osc(1800, 'triangle', 0.10, t, t + 0.055, 600);
      // 2. 메탈 반향 시퀀스 — 핑 핑 핑 핑 (점점 작아지고 피치 내려감)
      var pings = [
        { delay: 0.10, freq: 2200, gain: 0.14 },
        { delay: 0.22, freq: 1900, gain: 0.09 },
        { delay: 0.34, freq: 1600, gain: 0.06 },
        { delay: 0.46, freq: 1300, gain: 0.03 }
      ];
      pings.forEach(function (p) {
        osc(p.freq, 'sine', p.gain, t + p.delay, t + p.delay + 0.12, p.freq * 0.5);
        noiseB(0.04, p.gain * 0.4, p.freq * 0.6, 5.0, t + p.delay);
      });
    },

    /* mine — 덫 설치 (0.45s)
     * 감정 계층: [설치/경계] 기계 클릭 → 스프링 장전 → 경고 비프 */
    skill_mine: function () {
      var t = t0();
      // 1. 기계 클릭 — 날카로운 금속 배치음
      noiseB(0.04, 0.22, 3500, 7.0, t);
      osc(1200, 'square', 0.08, t, t + 0.04, 2400);
      // 2. 스프링 장전 — 피치 상승 짧은 스윕
      osc(400, 'sawtooth', 0.10, t + 0.06, t + 0.16, 1200);
      noiseB(0.08, 0.08, 1800, 3.0, t + 0.06);
      // 3. 기계 세팅 클릭 — 두 번째 락킹음
      noiseB(0.03, 0.14, 4000, 8.0, t + 0.18);
      osc(2000, 'square', 0.06, t + 0.18, t + 0.22, 1000);
      // 4. 경고 비프 — 활성화 신호 (설치 완료)
      osc(880,  'sine', 0.07, t + 0.28, t + 0.38, 880);
      osc(1100, 'sine', 0.04, t + 0.32, t + 0.42, 1100);
    },

    /* phantom_strike — 순간이동 타격 (0.42s)
     * 감정 계층: [순간/충격] 공간 찢김 스윕 → 텔레포트 공백 → 강한 임팩트 */
    skill_phantom_strike: function () {
      var t = t0();
      // 1. 공간 찢김 — 고역에서 저역으로 역방향 피치 스윕 (이상공간 진입)
      osc(3200, 'sine', 0.14, t, t + 0.09, 160);
      noiseB(0.08, 0.16, 3500, 2.0, t);
      // 2. 텔레포트 공백 — 의도적 무음(0.09~0.14) → 임팩트 직전 긴장감
      // 3. 순간이동 완성 임팩트 — 서브베이스 폭발 타격
      var pso = actx.createOscillator();
      var psg = actx.createGain();
      pso.type = 'sine';
      pso.frequency.setValueAtTime(100, t + 0.14);
      pso.frequency.exponentialRampToValueAtTime(28, t + 0.40);
      psg.gain.setValueAtTime(0.68, t + 0.14);
      psg.gain.exponentialRampToValueAtTime(0.0001, t + 0.42);
      pso.connect(psg); psg.connect(masterGain);
      pso.start(t + 0.14); pso.stop(t + 0.44);
      // 4. 타격 크런치 + 에너지 분산
      noiseB(0.12, 0.30, 400, 2.2, t + 0.14);
      osc(1800, 'square', 0.06, t + 0.16, t + 0.28, 540);
    },

    /* turret — 포탑 설치 (0.55s)
     * 감정 계층: [기계/설치] 구조물 배치 클릭 시퀀스 → 기계 초기화 → 작동음 */
    skill_turret: function () {
      var t = t0();
      // 1. 구조물 배치 — 기계 클릭 시퀀스 3회 (설치 단계)
      var clickOffsets = [0, 0.10, 0.20];
      clickOffsets.forEach(function (ck) {
        noiseB(0.03, 0.18, 2500, 5.0, t + ck);
        osc(600 + ck * 2000, 'square', 0.07, t + ck, t + ck + 0.04, 1200 + ck * 4000);
      });
      // 2. 기계 초기화 — LP 스윕 (부품이 결합되는 느낌)
      oscLP(300, 800, 'sawtooth', 0.12, 400, 1800, t + 0.24, t + 0.42);
      noiseB(0.16, 0.12, 1000, 2.0, t + 0.24);
      // 3. 포탑 가동 — 저역 윙윙 상승 (작동 시작)
      var two = actx.createOscillator();
      var twg = actx.createGain();
      two.type = 'sawtooth';
      two.frequency.setValueAtTime(120, t + 0.40);
      two.frequency.linearRampToValueAtTime(180, t + 0.55);
      twg.gain.setValueAtTime(0.0001, t + 0.40);
      twg.gain.linearRampToValueAtTime(0.18, t + 0.46);
      twg.gain.exponentialRampToValueAtTime(0.0001, t + 0.55);
      two.connect(twg); twg.connect(masterGain);
      two.start(t + 0.40); two.stop(t + 0.57);
      // 4. 가동 완료 핑 — 포탑 활성화 신호
      osc(1760, 'sine', 0.08, t + 0.50, t + 0.55, 2200);
    },

    /* ── 적 등장·공격 사운드 ── */

    /* 붉은 돌진 예고 — 저음 거칠게 끌어오는 사운드 (0.35s)
     * 감정 계층: [위협/경보] 긴장 빌드업, 음량 상승 → 플레이어에게 회피 신호 */
    charger_telegraph: function () {
      var t = t0();
      // 1. 저역 거친 그라울 (sawtooth, LP 필터 스윕)
      oscLP(55, 95, 'sawtooth', 0.30, 200, 900, t, t + 0.35);
      // 2. 중저역 긁히는 노이즈 (붉은 질감 — 저역 밴드패스)
      noiseB(0.28, 0.22, 180, 1.5, t + 0.04);
      // 3. 빌드업 강화 — 두 번째 oscillator (음량 증가)
      var ro = actx.createOscillator();
      var rg = actx.createGain();
      ro.type = 'sawtooth';
      ro.frequency.setValueAtTime(70, t + 0.10);
      ro.frequency.exponentialRampToValueAtTime(110, t + 0.35);
      rg.gain.setValueAtTime(0.0001, t + 0.10);
      rg.gain.linearRampToValueAtTime(0.42, t + 0.35); // 끝으로 갈수록 커짐
      rg.gain.exponentialRampToValueAtTime(0.0001, t + 0.38);
      ro.connect(rg); rg.connect(masterGain);
      ro.start(t + 0.10); ro.stop(t + 0.40);
    },

    /* 핑크 집결 신호 — 높은 외침 + 집결 울림 (0.4s)
     * 감정 계층: [경보/신호] 날카로운 외침 → 반향 울림으로 여러 개체 집결 암시 */
    rally_imp_call: function () {
      var t = t0();
      // 1. 날카로운 외침 (높은 사인파 — 임프 목소리 느낌)
      osc(880, 'sine', 0.28, t, t + 0.12, 1320);
      osc(660, 'triangle', 0.18, t + 0.04, t + 0.18, 880);
      // 2. 집결 울림 (에코 레이어 — 조금 늦게, 볼륨 낮게)
      osc(880, 'sine', 0.12, t + 0.10, t + 0.28, 1200);
      osc(660, 'sine', 0.08, t + 0.16, t + 0.34, 900);
      // 3. 핑크 공명 노이즈 (중고역 집결 파동)
      noiseB(0.20, 0.10, 1400, 2.8, t + 0.06);
      // 4. 세 번째 에코 (더 희미하게 — 거리감 표현)
      osc(880, 'sine', 0.05, t + 0.24, t + 0.40, 1100);
    },

    /* 보라 마법 사격 — 헥사 마법진 회전 고음 (0.35s)
     * 감정 계층: [마법/위협] 회전 피치 스윕 → 발사 클릭 → 고음 잔향 */
    hex_shooter_cast: function () {
      var t = t0();
      // 1. 헥사 마법진 회전감 — 피치 회전 스윕 (올라갔다 내려옴)
      osc(600, 'sine', 0.14, t, t + 0.18, 1200);
      osc(1200, 'sine', 0.10, t + 0.18, t + 0.35, 600);
      // 2. 보라 질감 하모닉 (7도 불협화 — 마법진 회전 특유의 긴장감)
      osc(700, 'triangle', 0.08, t + 0.04, t + 0.28, 840);
      // 3. 발사 클릭 (임팩트 포인트)
      noiseB(0.06, 0.18, 2400, 5.0, t + 0.16);
      // 4. 고음 잔향 (마법 에너지 방출 후 흩어짐)
      osc(2800, 'sine', 0.06, t + 0.20, t + 0.35, 1400);
      osc(1900, 'sine', 0.04, t + 0.22, t + 0.35, 950);
    },

    /* 레벨업 — 4음계 아르페지오 (0.5s) */
    levelup: function () {
      var t = t0();
      var notes = [440, 554, 659, 880];
      notes.forEach(function (f, i) {
        osc(f, 'sine', 0.24, t + i * 0.075, t + i * 0.075 + 0.28);
      });
    },

    /* 대시 — 빠른 스윕 노이즈 */
    dash: function () {
      var t = t0();
      noiseB(0.12, 0.10, 1200, 0.35, t);
    },

    /* 적 타격 — 일반/크리티컬 2단 계층 (0.10~0.15s)
     * 감정 계층: [타격감] 저역 크런치 펀치 → (crit) 금속 챠임 + 강화 붐
     * 일반: 짧고 예리한 저역 크런치. 크리티컬: 금속 챠임 레이어로 명확히 차별화.
     * 볼륨: 일반 0.14~0.18, 크리티컬 0.20~0.25 (SFX 레벨 유지) */
    hit: function (opts) {
      var t = t0();
      var crit = opts && opts.crit;
      // 1. 저역 크런치 펀치 — 모든 타격의 토대 (짧고 묵직)
      var ho = actx.createOscillator();
      var hg = actx.createGain();
      ho.type = 'sine';
      ho.frequency.setValueAtTime(crit ? 140 : 110, t);
      ho.frequency.exponentialRampToValueAtTime(28, t + (crit ? 0.14 : 0.11));
      hg.gain.setValueAtTime(crit ? 0.25 : 0.18, t);
      hg.gain.exponentialRampToValueAtTime(0.0001, t + (crit ? 0.15 : 0.12));
      ho.connect(hg); hg.connect(masterGain);
      ho.start(t); ho.stop(t + (crit ? 0.17 : 0.14));
      // 2. 임팩트 크런치 노이즈 (중저역 밴드패스 — 펀치 질감)
      noiseB(crit ? 0.12 : 0.09, crit ? 0.20 : 0.14, crit ? 360 : 280, 2.2, t);
      // 3. 고역 에지 (타격 예리함 — 귀에 박히는 찰나)
      osc(crit ? 1600 : 1200, 'triangle', crit ? 0.08 : 0.05, t, t + (crit ? 0.07 : 0.05), crit ? 640 : 480);
      // ── 크리티컬 전용 레이어 ──
      if (crit) {
        // 금속 챠임 (메탈릭 고역 핑 — 크리티컬 인지 신호, 3520/2640 Hz)
        osc(3520, 'sine', 0.12, t + 0.02, t + 0.14, 2200);
        osc(2640, 'sine', 0.07, t + 0.03, t + 0.13, 1760);
        // 고역 메탈 노이즈 (금속 질감 강화)
        noiseB(0.06, 0.10, 3000, 4.5, t + 0.01);
      }
    },
  };

  // ── BGM 시스템 (적응형 절차적 배경음악) ──
  //
  // 주파수 대역 분리 설계:
  //   BGM — 65–2500 Hz 중역 중심, 전체 볼륨 0.28 (SFX 트랜지언트 저역과 겹치지 않도록)
  //   SFX — 서브베이스(20–120 Hz) 및 초고역(>3 kHz) 타격 중심
  //
  // app.js 연동 위치:
  //   게임 시작: GameAudio.playBgm('battle')
  //   웨이브 클리어 / 업그레이드 화면: GameAudio.playBgm('lobby')
  //   게임 오버: GameAudio.stopBgm(1500)

  var BGM_LOOKAHEAD  = 0.14;   // 선스케줄 창 (초)
  var BGM_INTERVAL   = 55;     // 폴링 간격 (ms)
  var BGM_FADE_SEC   = 0.8;    // 크로스페이드 (초)

  // ── 전투 BGM 패턴 (140 BPM, 16분음표×16, E단조 긴장감) ──
  var BT_BPM      = 140;
  var BT_STEPS    = 16;
  var BT_STEP_DUR = 60 / (BT_BPM * 4);  // ≈0.107s
  // 베이스 라인: E2-E2-G2-A2-E2-E2-D2-C2 (0=쉬기)
  var BT_BASS  = [82.4, 0, 82.4, 0,  98.0, 0, 110.0, 0,
                  82.4, 0, 82.4, 0,  73.4, 65.4, 0, 0];
  var BT_KICK  = [1,0,0,0, 1,0,0,0, 1,0,0,0, 1,0,0,0]; // 강박 킥
  var BT_SNARE = [0,0,0,0, 1,0,0,0, 0,0,0,0, 1,0,0,0]; // 약박 스네어
  var BT_HAT   = [1,0,1,0, 1,0,1,0, 1,0,1,0, 1,0,1,0]; // 짝수 하이햇
  // 리드 모티프: E4-G4-F4-D4 (4비트마다 한 음, 긴장 단조)
  var BT_LEAD  = [0,0,0,329.6, 0,0,0,392.0, 0,0,0,349.2, 0,0,0,293.7];

  // ── 로비 BGM 패턴 (75 BPM, 16분음표×32, Am→F→C→G 잔잔한 아르페지오) ──
  var LB_BPM      = 75;
  var LB_STEPS    = 32;
  var LB_STEP_DUR = 60 / (LB_BPM * 4);  // =0.200s
  var LB_ARP = [220.0, 0, 261.6, 0, 329.6, 0, 440.0, 0,   // Am
                174.6, 0, 220.0, 0, 261.6, 0, 329.6, 0,   // F
                130.8, 0, 261.6, 0, 329.6, 0, 440.0, 0,   // C
                196.0, 0, 246.9, 0, 329.6, 0, 392.0, 0];  // G
  var LB_PAD = [1,0,0,0,0,0,0,0, 1,0,0,0,0,0,0,0,
                1,0,0,0,0,0,0,0, 1,0,0,0,0,0,0,0];
  var LB_PAD_ROOTS = [220.0, 174.6, 130.8, 196.0]; // Am,F,C,G 루트

  function initBgmChain() {
    if (bgmMasterGain || !actx) return;
    bgmMasterGain = actx.createGain();
    bgmMasterGain.gain.value = 0.28; // SFX 대비 낮게 — 주파수 마스킹 방지
    bgmMasterGain.connect(masterGain);
  }

  function scheduleBgmStep(gainNode, track, stepIdx) {
    if (!actx || !gainNode) return;
    var st = bgmNoteTime;

    if (track === 'battle') {
      // 베이스 (sawtooth + LP 필터 360 Hz, SFX 저역과 분리)
      if (BT_BASS[stepIdx] > 0) {
        var bso = actx.createOscillator();
        var blf = actx.createBiquadFilter();
        var bsg = actx.createGain();
        bso.type = 'sawtooth';
        bso.frequency.setValueAtTime(BT_BASS[stepIdx], st);
        blf.type = 'lowpass';
        blf.frequency.value = 360;
        bsg.gain.setValueAtTime(0.0001, st);
        bsg.gain.linearRampToValueAtTime(0.48, st + 0.009);
        bsg.gain.exponentialRampToValueAtTime(0.0001, st + BT_STEP_DUR * 1.7);
        bso.connect(blf); blf.connect(bsg); bsg.connect(gainNode);
        bso.start(st); bso.stop(st + BT_STEP_DUR * 2.0);
      }
      // 킥드럼 (서브베이스 사인 피치드롭 — BGM 킥은 SFX보다 약하게)
      if (BT_KICK[stepIdx]) {
        var kko = actx.createOscillator();
        var kkg = actx.createGain();
        kko.type = 'sine';
        kko.frequency.setValueAtTime(100, st);
        kko.frequency.exponentialRampToValueAtTime(28, st + 0.09);
        kkg.gain.setValueAtTime(0.55, st);
        kkg.gain.exponentialRampToValueAtTime(0.0001, st + 0.10);
        kko.connect(kkg); kkg.connect(gainNode);
        kko.start(st); kko.stop(st + 0.12);
      }
      // 스네어 (밴드패스 노이즈 1800 Hz)
      if (BT_SNARE[stepIdx]) {
        var snr = actx.sampleRate;
        var snl = Math.ceil(snr * 0.08);
        var snbf = actx.createBuffer(1, snl, snr);
        var snbd = snbf.getChannelData(0);
        for (var sni = 0; sni < snl; sni++) snbd[sni] = Math.random() * 2 - 1;
        var snbs = actx.createBufferSource();
        snbs.buffer = snbf;
        var snff = actx.createBiquadFilter();
        snff.type = 'bandpass'; snff.frequency.value = 1800; snff.Q.value = 0.9;
        var sngg = actx.createGain();
        sngg.gain.setValueAtTime(0.38, st);
        sngg.gain.exponentialRampToValueAtTime(0.0001, st + 0.08);
        snbs.connect(snff); snff.connect(sngg); sngg.connect(gainNode);
        snbs.start(st); snbs.stop(st + 0.09);
      }
      // 하이햇 (하이패스 8kHz 노이즈, 얇게)
      if (BT_HAT[stepIdx]) {
        var htr = actx.sampleRate;
        var htl = Math.ceil(htr * 0.020);
        var htbf = actx.createBuffer(1, htl, htr);
        var htbd = htbf.getChannelData(0);
        for (var hti = 0; hti < htl; hti++) htbd[hti] = Math.random() * 2 - 1;
        var htbs = actx.createBufferSource();
        htbs.buffer = htbf;
        var htff = actx.createBiquadFilter();
        htff.type = 'highpass'; htff.frequency.value = 8000;
        var htgg = actx.createGain();
        htgg.gain.setValueAtTime(0.09, st);
        htgg.gain.exponentialRampToValueAtTime(0.0001, st + 0.020);
        htbs.connect(htff); htff.connect(htgg); htgg.connect(gainNode);
        htbs.start(st); htbs.stop(st + 0.023);
      }
      // 리드 멜로디 (square + LP 1600 Hz, 중역)
      if (BT_LEAD[stepIdx] > 0) {
        var llo = actx.createOscillator();
        var llflt = actx.createBiquadFilter();
        var llg = actx.createGain();
        llo.type = 'square';
        llo.frequency.setValueAtTime(BT_LEAD[stepIdx], st);
        llflt.type = 'lowpass'; llflt.frequency.value = 1600;
        llg.gain.setValueAtTime(0.0001, st);
        llg.gain.linearRampToValueAtTime(0.12, st + 0.015);
        llg.gain.exponentialRampToValueAtTime(0.0001, st + BT_STEP_DUR * 3.0);
        llo.connect(llflt); llflt.connect(llg); llg.connect(gainNode);
        llo.start(st); llo.stop(st + BT_STEP_DUR * 3.5);
      }

    } else { // lobby
      // 아르페지오 (sine, 부드럽게 페이드)
      if (LB_ARP[stepIdx] > 0) {
        var aao = actx.createOscillator();
        var aag = actx.createGain();
        aao.type = 'sine';
        aao.frequency.setValueAtTime(LB_ARP[stepIdx], st);
        aag.gain.setValueAtTime(0.0001, st);
        aag.gain.linearRampToValueAtTime(0.15, st + 0.030);
        aag.gain.exponentialRampToValueAtTime(0.0001, st + LB_STEP_DUR * 3.5);
        aao.connect(aag); aag.connect(gainNode);
        aao.start(st); aao.stop(st + LB_STEP_DUR * 4.0);
      }
      // 패드 코드 (단조 트라이어드: 루트+단3도+완전5도, 느리게 페이드)
      if (LB_PAD[stepIdx]) {
        var prootIdx = Math.floor(stepIdx / 8) % 4;
        var pr = LB_PAD_ROOTS[prootIdx];
        var pchords = [pr, pr * 1.1892, pr * 1.4983];
        pchords.forEach(function (pf) {
          var ppo = actx.createOscillator();
          var ppg = actx.createGain();
          ppo.type = 'sine';
          ppo.frequency.setValueAtTime(pf, st);
          ppg.gain.setValueAtTime(0.0001, st);
          ppg.gain.linearRampToValueAtTime(0.07, st + 0.20);
          ppg.gain.exponentialRampToValueAtTime(0.0001, st + LB_STEP_DUR * 7.5);
          ppo.connect(ppg); ppg.connect(gainNode);
          ppo.start(st); ppo.stop(st + LB_STEP_DUR * 8.0);
        });
      }
    }
  }

  function bgmSchedulerLoop() {
    if (!actx || !bgmTrack || !bgmFadeGain) return;
    var steps = (bgmTrack === 'battle') ? BT_STEPS : LB_STEPS;
    var stepDur = (bgmTrack === 'battle') ? BT_STEP_DUR : LB_STEP_DUR;
    while (bgmNoteTime < actx.currentTime + BGM_LOOKAHEAD) {
      scheduleBgmStep(bgmFadeGain, bgmTrack, bgmBeat % steps);
      bgmBeat++;
      bgmNoteTime += stepDur;
    }
    bgmTimer = setTimeout(bgmSchedulerLoop, BGM_INTERVAL);
  }

  /** BGM 트랙 시작·교체 (0.8s 크로스페이드)
   *  trackName: 'battle' | 'lobby'
   *  app.js 연동: 게임시작→playBgm('battle'), 웨이브클리어→playBgm('lobby') */
  function playBgm(trackName) {
    if (!initialized) { bgmPending = trackName; return; }
    if (!actx) return;
    initBgmChain();
    resume();
    if (actx.state === 'suspended') { bgmPending = trackName; return; }
    if (bgmTrack === trackName) return; // 동일 트랙 중복 요청 무시

    var now = actx.currentTime;

    // 새 채널 gain 생성 — fade-in
    var newGain = actx.createGain();
    newGain.gain.setValueAtTime(0.0001, now);
    newGain.gain.linearRampToValueAtTime(1.0, now + BGM_FADE_SEC);
    newGain.connect(bgmMasterGain);

    // 기존 채널 fade-out 후 disconnect
    if (bgmFadeGain) {
      var oldGain = bgmFadeGain;
      oldGain.gain.setValueAtTime(oldGain.gain.value, now);
      oldGain.gain.linearRampToValueAtTime(0.0001, now + BGM_FADE_SEC);
      setTimeout(function () { try { oldGain.disconnect(); } catch (e) {} },
        Math.round((BGM_FADE_SEC + 0.15) * 1000));
    }

    // 스케줄러 초기화 및 재시작
    if (bgmTimer) { clearTimeout(bgmTimer); bgmTimer = null; }
    bgmTrack    = trackName;
    bgmFadeGain = newGain;
    bgmBeat     = 0;
    bgmNoteTime = now;
    bgmSchedulerLoop();
  }

  /** BGM 페이드아웃 후 정지
   *  fadeMs: 페이드 시간(ms, 기본 800)
   *  app.js 연동: 게임오버→stopBgm(1500) */
  function stopBgm(fadeMs) {
    var fadeSec = (fadeMs != null ? Math.max(fadeMs, 0) : 800) / 1000;
    if (bgmTimer) { clearTimeout(bgmTimer); bgmTimer = null; }
    bgmTrack = null;
    if (bgmFadeGain && actx) {
      var now = actx.currentTime;
      var og  = bgmFadeGain;
      bgmFadeGain = null;
      og.gain.setValueAtTime(og.gain.value, now);
      og.gain.linearRampToValueAtTime(0.0001, now + fadeSec);
      setTimeout(function () { try { og.disconnect(); } catch (e) {} },
        Math.round((fadeSec + 0.15) * 1000));
    } else {
      bgmFadeGain = null;
    }
  }

  // ── 퍼블릭 API ──

  function play(key, opts) {
    if (muted) return;
    init();
    if (!actx || !initialized) return;
    resume();
    if (actx.state === 'suspended') return;
    try {
      var fn = SOUNDS[key];
      if (fn) fn(opts || {});
    } catch (e) { /* 조용히 무시 */ }
  }

  function setVolume(v) {
    masterVol = Math.max(0, Math.min(1, v));
    if (masterGain) masterGain.gain.value = masterVol;
  }

  function toggle() {
    muted = !muted;
    if (masterGain) masterGain.gain.value = muted ? 0 : masterVol;
    return !muted;
  }

  function isMuted() { return muted; }

  window.GameAudio = {
    play:       play,
    setVolume:  setVolume,
    toggle:     toggle,
    isMuted:    isMuted,
    init:       init,
    playBgm:    playBgm,
    stopBgm:    stopBgm
  };
})();
