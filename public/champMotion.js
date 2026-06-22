/*
 * champMotion.js — 챔피언 모션 상태머신 (owner: 모션 애니메이터)
 * window.ChampMotion.drawChampion(ctx, p, now, opts) 단일 진입점.
 *
 * 계약(프론트 owner와 합의):
 *  - app.js가 z-order 레이어3에서 호출. ctx는 카메라/쉐이크 적용 완료, p.x/p.y는 월드=화면 좌표.
 *  - p: { champion, x, y, facing(rad=조준각), tier:1|2|3, level, hp, maxHp, dead, invuln,
 *         attackAnim:{ type:'swing'|'cast'|'shoot'|'dash', startedAt(ms), aimAngle(rad), duration(s) } | null,
 *         hitFlash(ms, 선택): 피격 시각(performance.now 기준) — 100ms 내 붉은 오버레이 표시.
 *         flash(bool, 선택): 즉각 흰/적 플래시 강제. }
 *  - now: 클라 추정 서버시간(ms). opts: { isSelf, color(직업색) }
 *  - 서버 권위: 진행도 prog = (now-startedAt)/(duration*1000). 자체 타이머 없음(순수 함수).
 *  - 공격 모션 기준각 = attackAnim.aimAngle(= 서버 부채꼴 판정 방향). 평상시 회전 = p.facing.
 *  - 안전장치: prog>=1 또는 attackAnim=null 이면 아이들로 렌더(무기 튐 방지).
 *  - 본 모듈은 본체+무기+조준회전+공격모션+Tier1~3 치장 + HP/이름/별 라벨까지 그린다(폴백과 동일 책임).
 *
 * [v2] 추가 — 이동 생동감·유휴 맥동·피격 리액션·사망 연출
 */
(function () {
  'use strict';
  const TAU = Math.PI * 2;
  const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
  const lerp = (a, b, t) => a + (b - a) * t;
  const ease = {
    outQuad: t => 1 - (1 - t) * (1 - t),
    inQuad: t => t * t,
    outBack: t => { const c = 1.70158; return 1 + (c + 1) * Math.pow(t - 1, 3) + c * Math.pow(t - 1, 2); },
    outCirc: t => Math.sqrt(1 - Math.pow(t - 1, 2)),
    inOutSine: t => -(Math.cos(Math.PI * t) - 1) / 2,
  };

  // ── 모듈 레벨 상태 (프레임 간 보존) ──
  const _pvel   = new Map(); // pid→{vx,vy,lx,ly,lt}  속도 EMA
  const _pdead  = new Map(); // pid→{at}               사망 시작 시각(performance.now)
  const _palive = new Map(); // pid→bool               이전 프레임 생존 여부

  /** 위치 델타 EMA로 속도 추정. */
  function _trackVel(pid, x, y, now) {
    const v = _pvel.get(pid) || { vx: 0, vy: 0, lx: x, ly: y, lt: now - 16 };
    const dt = clamp((now - v.lt) / 1000, 0.001, 0.12);
    const a = 0.28;
    v.vx = v.vx * (1 - a) + ((x - v.lx) / dt) * a;
    v.vy = v.vy * (1 - a) + ((y - v.ly) / dt) * a;
    v.lx = x; v.ly = y; v.lt = now;
    _pvel.set(pid, v);
    return v;
  }

  /** alive→dead 전이 감지 → 사망 시각 기록 / 부활 시 초기화. */
  function _trackDeath(pid, dead, now) {
    const was = _palive.get(pid);
    _palive.set(pid, !dead);
    if (dead && was !== false && !_pdead.has(pid)) _pdead.set(pid, { at: now });
    if (!dead && _pdead.has(pid)) _pdead.delete(pid);
  }

  /** 유휴 맥동 스케일 — 0.8~1.0s 주기, pid로 위상 분산. */
  function _idleSc(now, pid) {
    const phase = ((pid || 0) * 6571) % (Math.PI * 2);
    const period = 880 + Math.sin(phase) * 130; // 750~1010ms
    return 1 + Math.sin(now * Math.PI * 2 / period) * 0.042;
  }

  /** 피격 붉은 플래시 오버레이 (0,0 = 챔피언 중심 기준). */
  function _champHitFlash(ctx, r, p, now) {
    let a = 0;
    if (p.flash) {
      // 즉각 플래시 — 흰색(백색 피격) 또는 붉은색(플레이어 피격)
      a = 0.62;
    } else if (p.hitFlash && now - p.hitFlash < 100) {
      a = (1 - (now - p.hitFlash) / 100) * 0.62;
    }
    if (a < 0.01) return;
    ctx.save();
    ctx.globalAlpha = a;
    ctx.fillStyle = '#FF2020';
    ctx.shadowColor = '#FF0000'; ctx.shadowBlur = 14;
    ctx.beginPath(); ctx.arc(0, 0, r + 2, 0, TAU); ctx.fill();
    ctx.shadowBlur = 0;
    ctx.restore();
  }

  /** 사망 분해 연출 — 분산 파편 + 백색 플래시 (0,0 = 챔피언 중심). */
  function _deathDissolve(ctx, pid, meta, now) {
    const death = _pdead.get(pid);
    if (!death) return;
    const elapsed = now - death.at;
    const DUR = 720;
    if (elapsed >= DUR) return;
    const r = meta.r;

    // 초기 흰 폭발 플래시 (0~130ms)
    if (elapsed < 130) {
      const f = 1 - elapsed / 130;
      ctx.save();
      ctx.globalAlpha = f * 0.85;
      ctx.fillStyle = '#FFFFFF'; ctx.shadowColor = '#FFFFFF'; ctx.shadowBlur = 18;
      ctx.beginPath(); ctx.arc(0, 0, r * (1 + f * 0.5), 0, TAU); ctx.fill();
      ctx.shadowBlur = 0;
      ctx.restore();
    }

    // 파편 분산 (50ms 이후)
    if (elapsed > 45) {
      const tp = clamp((elapsed - 45) / (DUR - 45), 0, 1);
      ctx.save();
      for (let i = 0; i < 8; i++) {
        const ang = (i / 8) * TAU + 0.39;
        const d = ease.outQuad(tp) * r * 2.6;
        const sr = r * 0.3 * (1 - tp * 0.88);
        if (sr < 0.3) continue;
        ctx.globalAlpha = (1 - tp) * 0.82;
        ctx.fillStyle = i % 2 ? meta.body : meta.accent;
        ctx.beginPath(); ctx.arc(Math.cos(ang) * d, Math.sin(ang) * d, sr, 0, TAU); ctx.fill();
      }
      ctx.restore();
    }
  }

  // ── 캔버스 프리미티브(자체 정의: app.js보다 먼저 로드되므로 의존 불가) ──
  function dot(ctx, x, y, r) { ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); ctx.fill(); }
  function tri(ctx, ax, ay, bx, by, cx, cy) { ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.lineTo(cx, cy); ctx.closePath(); ctx.fill(); }
  function ball(ctx, x, y, r, hi, c) {
    const g = ctx.createRadialGradient(x - r * 0.3, y - r * 0.3, r * 0.2, x, y, r);
    g.addColorStop(0, hi); g.addColorStop(1, c);
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); ctx.fill();
  }
  function star(ctx, x, y, r, inner) {
    inner = inner || 0.45;
    ctx.beginPath();
    for (let i = 0; i < 10; i++) {
      const a = -Math.PI / 2 + i * Math.PI / 5, rr = i % 2 ? r * inner : r;
      const px = x + Math.cos(a) * rr, py = y + Math.sin(a) * rr;
      i ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
    }
    ctx.closePath(); ctx.fill();
  }
  function rrect(ctx, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
  }

  // ── 직업 색/치수 메타 ──
  const META = {
    warrior:  { name: '전사', body: '#2C4A7C', accent: '#4A7FBF', r: 22, aura: '#4A90E2' },
    mage:     { name: '마법사', body: '#4A1080', accent: '#8B44CC', r: 18, aura: '#9B59B6' },
    archer:   { name: '궁수', body: '#2E7D32', accent: '#4CAF50', r: 18, aura: '#27AE60' },
    assassin: { name: '암살자', body: '#2D1B4E', accent: '#7B3FA0', r: 16, aura: '#E91E63' },
  };

  // 무기 색 (Tier별)
  const SWORD  = ['#9E9E9E', '#5BA3F5', '#FFD700'];
  const DAGGER = ['#708090', '#CC44FF', '#FF00CC'];
  const BOW    = ['#8D6E63', '#4CAF50', '#00E5FF'];
  const ORB    = ['#9B59B6', '#CC44FF', '#FFFFFF'];

  // 스윙 가시 호 반각(rad). 서버 판정 arc(±arc/2)의 시각 대응 — 전사 넓은 부채꼴.
  const SWING_HALF = 1.05; // ≈60°

  // ───────────────────────── 진입점 ─────────────────────────
  function drawChampion(ctx, p, now, opts) {
    opts = opts || {};
    const meta = META[p.champion] || META.warrior;
    const aimIdle = p.facing || 0;
    const pid = p.id != null ? p.id : (p.x + '|' + p.y); // 안정 식별자

    // ── 속도·사망 상태 추적 ──
    const vel = _trackVel(pid, p.x, p.y, now);
    _trackDeath(pid, !!p.dead, now);
    const speed = Math.sqrt(vel.vx * vel.vx + vel.vy * vel.vy);

    // 공격 진행도(서버 권위, attackAnim.duration=초). prog>=1 이면 idle.
    let atype = null, prog = 1, aimAtk = aimIdle;
    if (p.attackAnim) {
      const a = p.attackAnim;
      prog = (now - a.startedAt) / (Math.max(0.001, a.duration) * 1000);
      if (prog >= 0 && prog < 1) { atype = a.type; aimAtk = (a.aimAngle != null) ? a.aimAngle : aimIdle; }
    }
    // 스킬 시전(서버 권위, castAnim.duration=ms). 캐스트는 평타보다 포즈 우선.
    let cast = null;
    if (p.castAnim) {
      const c = p.castAnim;
      const cp = (now - c.startedAt) / Math.max(1, c.duration);
      if (cp >= 0 && cp < 1) cast = computeCast(c.type, cp, (c.aimAngle != null ? c.aimAngle : aimIdle));
    }
    // 대시(서버 dashUntil 연속이동).
    const dashing = !p.dead && ((p.dashUntil && now < p.dashUntil) || p.dashing);

    const aim    = cast ? cast.aim : (atype ? aimAtk : aimIdle);
    const breathe = Math.sin(now * 0.004 + p.x * 0.01) * 0.7;

    // ── 유휴 맥동 (정지+비공격 시 생명체 호흡감, 0.8~1.0s 주기) ──
    const isIdle = !atype && !cast && !dashing && !p.dead && speed < 35;
    const idleSc = isIdle ? _idleSc(now, pid) : 1;

    // ── 이동 생동감 계수 ──
    const movLean = (!dashing && !p.dead && speed > 28) ? clamp(speed / 280, 0, 1) : 0;
    const movDir  = speed > 28 ? Math.atan2(vel.vy, vel.vx) : 0;

    // ── 사망 애니메이션 계산 ──
    const deathInfo      = _pdead.get(pid);
    const deathElapsed   = (p.dead && deathInfo) ? (now - deathInfo.at) : 9999;
    const deathAnimating = p.dead && deathElapsed < 720;
    const deathT         = deathAnimating ? deathElapsed / 720 : 0;

    ctx.save();
    ctx.translate(p.x, p.y);

    // 사망·무적 투명도
    if (p.dead) {
      ctx.globalAlpha = deathAnimating ? (1 - ease.outQuad(deathT) * 0.78) : 0.22;
    } else if (p.invuln && !dashing) {
      ctx.globalAlpha = 0.45 + 0.35 * Math.sin(now * 0.03);
    }

    // 발 그림자(지면 고정 — 변형 전)
    ctx.save(); ctx.globalAlpha *= 0.5; ctx.fillStyle = 'rgba(0,0,0,0.42)';
    ctx.beginPath(); ctx.ellipse(0, meta.r + 0, meta.r * 0.85, meta.r * 0.32, 0, 0, TAU); ctx.fill(); ctx.restore();

    // ── 몸 변형 레이어 ──
    ctx.save();

    // 사망 시 축소
    if (deathAnimating) {
      const sc = 1 - ease.outQuad(deathT) * 0.65;
      ctx.scale(sc, sc);
    }

    // 유휴 맥동 스케일 (breathe Y 오프셋과 조합)
    if (isIdle) ctx.scale(idleSc, idleSc);

    // 이동 생동감 — 방향 기울기·스쿼시스트레치 (대시 미만 속도 구간)
    if (movLean > 0.01) {
      // 진행 방향의 수직 성분 → 옆으로 기울기
      const leanAng = Math.sin(movDir - aim) * movLean * 0.13;
      ctx.rotate(leanAng);
      // 진행축 스트레치 (빠를수록 납작→길쭉)
      ctx.rotate(movDir);
      ctx.scale(1 + movLean * 0.08, 1 - movLean * 0.06);
      ctx.rotate(-movDir);
    }

    // 대시 기울기·스트레치 (기존)
    if (dashing) {
      ctx.rotate(Math.cos(aim) * 0.20);
      ctx.rotate(aim); ctx.scale(1.22, 0.84); ctx.rotate(-aim);
    }
    if (cast) {
      ctx.translate(Math.cos(cast.aim) * cast.push, Math.sin(cast.aim) * cast.push - cast.rise);
      if (cast.sx !== 1 || cast.sy !== 1) { ctx.rotate(cast.aim); ctx.scale(cast.sx, cast.sy); ctx.rotate(-cast.aim); }
    }

    // 치장 오라(본체 뒤)
    drawAuraBack(ctx, p, meta, now);

    // 직업 본체 + 무기 + 모션
    (DRAW[p.champion] || DRAW.warrior)(ctx, p, meta, now, aim, aimIdle, atype, prog, breathe, opts);

    // 치장 오라(본체 앞 — Tier3 파티클)
    drawAuraFront(ctx, p, meta, now);

    // 스킬 시전 제스처
    if (cast) drawCastGesture(ctx, cast, meta);

    ctx.restore(); // inner restore

    // 사망 파편 분산 (player 중심 기준, 몸 그린 뒤)
    if (deathAnimating) _deathDissolve(ctx, pid, meta, now);

    // 본인 표시 링
    if (opts.isSelf && !p.dead) {
      ctx.strokeStyle = 'rgba(255,255,255,0.28)'; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(0, meta.r, 16, 0.12 * Math.PI, 0.88 * Math.PI); ctx.stroke();
    }

    ctx.restore(); // outer restore
    ctx.globalAlpha = 1;

    // ── 피격 붉은 플래시 오버레이 (별도 패스, 월드좌표) ──
    if (!p.dead) {
      ctx.save(); ctx.translate(p.x, p.y);
      _champHitFlash(ctx, meta.r, p, now);
      ctx.restore();
    }

    // 라벨(월드 좌표)
    drawLabel(ctx, p, meta, opts);
  }

  // ───────────────────────── 스킬 시전 모션 ─────────────────────────
  const CAST_COL = {
    dash_strike: '#FF66AA', aoe_field: '#88FF44', nova: '#FFAA33',
    projectile_barrage: '#66CCFF', buff: '#FFD24A', summon: '#B980FF', chain: '#7CF0FF',
    multi_hit:'#FF5533', stun_strike:'#FFDD00', shield_stance:'#66DDFF',
    vortex:'#88CCFF', execute:'#FF3300', reflect_shield:'#AADDFF',
    leech_aura:'#DD2244', dot_strike:'#55FF66', ground_slam:'#BB7700',
    time_slow_aoe:'#CC88FF', whirlwind:'#FF9933', echo_shot:'#55CCFF',
    phantom_strike:'#CC55EE', mine:'#FFBB33', turret:'#55DDAA',
  };
  function computeCast(type, cp, aim) {
    let push = 0, rise = 0, sx = 1, sy = 1, arm = 0, flare = 0;
    const wp = cp < 0.32 ? ease.outQuad(cp / 0.32) : 1;
    const rp = cp < 0.32 ? 0 : (cp - 0.32) / 0.68;
    const st = rp < 0.34 ? ease.outQuad(rp / 0.34) : 1;
    const settle = rp < 0.34 ? 0 : ease.outBack((rp - 0.34) / 0.66);
    switch (type) {
      case 'dash_strike':
        push = lerp(lerp(-5, 18, st), 0, settle);
        sx = lerp(lerp(1, 1.18, st), 1, settle); sy = lerp(lerp(1, 0.86, st), 1, settle);
        arm = lerp(-1, 1, st); flare = st * (1 - settle); break;
      case 'nova':
        sx = sy = cp < 0.32 ? lerp(1, 0.82, wp) : lerp(0.82, 1.16, ease.outBack(rp));
        arm = cp < 0.32 ? -wp : lerp(-1, 1, ease.outQuad(rp)); flare = rp; break;
      case 'aoe_field':
        rise = cp < 0.32 ? lerp(0, 9, wp) : lerp(9, -3, ease.outQuad(rp));
        arm = cp < 0.32 ? -wp : lerp(-1, 1, ease.outQuad(rp)); flare = rp; break;
      case 'buff': {
        const g = ease.outBack(Math.min(cp / 0.45, 1));
        sx = sy = lerp(1, 1.13, g); rise = Math.sin(cp * Math.PI) * 5;
        arm = lerp(-1, -0.3, wp); flare = Math.sin(cp * Math.PI); break;
      }
      case 'projectile_barrage':
        push = -Math.abs(Math.sin(cp * Math.PI * 6)) * 5; arm = 0.7; flare = Math.abs(Math.sin(cp * Math.PI * 6)); break;
      case 'summon':
        rise = cp < 0.32 ? -lerp(0, 5, wp) : lerp(-5, 0, ease.outBack(rp));
        push = lerp(0, 7, wp) * (1 - rp); arm = lerp(-0.3, 1, wp); flare = wp * (1 - rp); break;
      case 'chain':
        arm = Math.sin(cp * Math.PI); flare = Math.sin(cp * Math.PI); break;
      case 'multi_hit':
        // 고속 연타: 앞뒤 빠른 진동 + 임팩트 squash
        push = Math.sin(cp * Math.PI * 8) * lerp(0, 10, Math.sin(cp * Math.PI));
        sx = lerp(1, 1.12, Math.abs(Math.sin(cp * Math.PI * 8)));
        sy = lerp(1, 0.90, Math.abs(Math.sin(cp * Math.PI * 8)));
        arm = 0.8; flare = Math.abs(Math.sin(cp * Math.PI * 8)); break;
      case 'stun_strike':
        // 강렬 돌진 → 충격 정지 → 회수
        push = cp < 0.30 ? lerp(-4, 22, ease.outQuad(cp / 0.30))
             : cp < 0.50 ? 22
             : lerp(22, 0, ease.outBack((cp - 0.50) / 0.50));
        sx = cp < 0.50 ? lerp(1, 0.80, Math.min(cp/0.50,1)) : lerp(0.80, 1.05, ease.outBack((cp-0.50)/0.50));
        sy = cp < 0.50 ? lerp(1, 1.22, Math.min(cp/0.50,1)) : lerp(1.22, 1.00, ease.outBack((cp-0.50)/0.50));
        arm = lerp(-0.5, 1, ease.outQuad(Math.min(cp/0.40,1)));
        flare = cp < 0.50 ? ease.outQuad(cp/0.50) : 1-(cp-0.50)/0.50; break;
      case 'shield_stance':
        // 방어막 전개: 옆으로 퍼지며 뒤로 당김
        push = lerp(lerp(0,-8,wp), -3, ease.outBack(rp));
        sx = lerp(lerp(1,1.20,wp), 1.10, ease.outBack(rp));
        sy = lerp(lerp(1,0.88,wp), 0.94, ease.outBack(rp));
        rise = Math.sin(cp * Math.PI * 0.5) * 4;
        arm = lerp(-1, -0.4, wp); flare = wp * (1 - settle * 0.6); break;
      case 'vortex':
        // 소용돌이 수렴: 안으로 압축 → 방출
        push = lerp(lerp(0,-6,wp), lerp(-6,4,ease.outBack(rp)), rp);
        sx = cp < 0.32 ? lerp(1,0.80,wp) : lerp(0.80,1.15,ease.outBack(rp));
        sy = cp < 0.32 ? lerp(1,1.18,wp) : lerp(1.18,0.95,ease.outBack(rp));
        arm = cp < 0.32 ? lerp(0,-1,wp) : lerp(-1,1,ease.outQuad(rp));
        flare = rp; break;
      case 'execute':
        // 최대 코일 압축 → 폭발 해방
        push = cp < 0.38 ? lerp(0,-10,ease.outQuad(cp/0.38)) : lerp(-10,28,ease.outQuad((cp-0.38)/0.62));
        sx = cp < 0.38 ? lerp(1,0.74,ease.outQuad(cp/0.38)) : lerp(0.74, 1+ease.outBack((cp-0.38)/0.62)*0.35, 1);
        sy = cp < 0.38 ? lerp(1,1.28,ease.outQuad(cp/0.38)) : lerp(1.28,0.82,ease.outBack((cp-0.38)/0.62));
        arm = cp < 0.38 ? -1 : lerp(-1,1,ease.outQuad((cp-0.38)/0.62));
        flare = cp < 0.38 ? 0 : ease.outQuad((cp-0.38)/0.62); break;
      case 'reflect_shield':
        // 팔 전방 뻗어 방패 전개 → 파동 → 회수
        push = cp < 0.35 ? lerp(0,14,ease.outQuad(cp/0.35)) : cp < 0.60 ? 14 : lerp(14,2,ease.outBack((cp-0.60)/0.40));
        sx = cp < 0.35 ? lerp(1,1.18,ease.outQuad(cp/0.35)) : lerp(1.18,1.05,ease.outBack((cp-0.35)/0.65));
        sy = cp < 0.35 ? lerp(1,0.85,ease.outQuad(cp/0.35)) : lerp(0.85,0.98,ease.outBack((cp-0.35)/0.65));
        arm = lerp(-0.3,1,ease.outQuad(Math.min(cp/0.45,1)));
        flare = cp < 0.55 ? ease.outQuad(cp/0.55) : 1-(cp-0.55)/0.45; break;
      case 'leech_aura':
        // 천천히 맥동 확장 — 오라 호흡
        sx = sy = 1 + Math.sin(cp * Math.PI * 2.5) * 0.10;
        rise = Math.sin(cp * Math.PI) * 4;
        arm = Math.sin(cp * Math.PI * 1.5) * 0.6;
        flare = 0.4 + 0.6 * Math.sin(cp * Math.PI); break;
      case 'dot_strike':
        // 빠른 찌르기 후 느린 회수(독 잔류)
        push = cp < 0.25 ? lerp(0,16,ease.outQuad(cp/0.25)) : lerp(16,2,ease.outBack((cp-0.25)/0.75));
        sx = cp < 0.25 ? lerp(1,0.88,ease.outQuad(cp/0.25)) : lerp(0.88,1.02,(cp-0.25)/0.75);
        sy = cp < 0.25 ? lerp(1,1.14,ease.outQuad(cp/0.25)) : lerp(1.14,0.98,(cp-0.25)/0.75);
        arm = lerp(0,1,ease.outQuad(Math.min(cp/0.30,1)));
        flare = cp < 0.25 ? ease.outQuad(cp/0.25) : Math.max(0,1-(cp-0.25)/0.75)*0.4; break;
      case 'ground_slam':
        // 위로 크게 들어올림 → 내리꽂기 squash
        rise = cp < 0.40 ? lerp(0,-16,ease.outQuad(cp/0.40)) : lerp(-16,6,ease.outBack((cp-0.40)/0.60));
        push = cp > 0.40 ? lerp(0,10,ease.outQuad((cp-0.40)/0.60)) : 0;
        { const si = Math.max(0,(cp-0.40)/0.25), sb = Math.max(0,(cp-0.65)/0.35);
          sx = cp > 0.40 ? lerp(1,1.30,ease.outQuad(Math.min(si,1))) * lerp(1.30,1.02,ease.outBack(Math.min(sb,1))) : 1;
          sy = cp > 0.40 ? lerp(1,0.72,ease.outQuad(Math.min(si,1))) * lerp(0.72,1.00,ease.outBack(Math.min(sb,1))) : 1; }
        arm = cp < 0.40 ? lerp(0,-1,wp) : lerp(-1,1,ease.outQuad((cp-0.40)/0.60));
        flare = cp > 0.40 ? ease.outQuad(Math.min((cp-0.40)/0.30,1)) * (1-Math.max(0,(cp-0.70)/0.30)) : 0; break;
      case 'time_slow_aoe':
        // 시공 왜곡: 늘어지듯 팽창 → 수렴
        sx = 1 + Math.sin(cp * Math.PI) * 0.14;
        sy = 1 - Math.sin(cp * Math.PI) * 0.10;
        rise = Math.sin(cp * Math.PI * 0.5) * 6;
        push = lerp(0,5,Math.sin(cp * Math.PI));
        arm = cp < 0.50 ? lerp(-0.4,1,ease.outQuad(cp/0.50)) : lerp(1,0.2,(cp-0.50)/0.50);
        flare = Math.sin(cp * Math.PI) * 0.9; break;
      case 'whirlwind':
        // 고속 회전: 원심력 가로 퍼짐, 4회 슬래시 리듬
        sx = 1 + Math.abs(Math.sin(cp * Math.PI * 4)) * 0.18;
        sy = 1 - Math.abs(Math.sin(cp * Math.PI * 4)) * 0.12;
        push = Math.sin(cp * Math.PI * 4) * 6;
        rise = -Math.sin(cp * Math.PI) * 3;
        arm = Math.sin(cp * Math.PI * 4);
        flare = 0.5 + 0.5 * Math.abs(Math.sin(cp * Math.PI * 4)); break;
      case 'echo_shot':
        // 연속 도탄: 발사 후 반동 리듬
        push = -Math.max(0, Math.sin(cp * Math.PI * 5)) * 9;
        sx = lerp(1,1.08,Math.abs(Math.sin(cp * Math.PI * 5)));
        sy = lerp(1,0.93,Math.abs(Math.sin(cp * Math.PI * 5)));
        arm = 0.85 + Math.sin(cp * Math.PI * 5) * 0.15;
        flare = Math.max(0, Math.sin(cp * Math.PI * 5)); break;
      case 'phantom_strike':
        // 순간이동: 빠르게 축소 → 사라짐 → 목표에서 팝
        { const pa = Math.max(0,(cp-0.45)/0.30), pb = Math.max(0,(cp-0.75)/0.25);
          sx = cp < 0.30 ? lerp(1,0.55,ease.outQuad(cp/0.30)) : cp < 0.45 ? 0.55
             : lerp(0.55,1.30,ease.outBack(Math.min(pa,1))) * lerp(1.30,1.00,ease.outBack(Math.min(pb,1)));
          sy = sx; }
        push = cp >= 0.45 ? lerp(0,20,ease.outBack(Math.min((cp-0.45)/0.30,1))) * lerp(1,0,Math.max(0,(cp-0.75)/0.25)) : 0;
        arm = cp >= 0.45 ? ease.outBack(Math.min((cp-0.45)/0.40,1)) : 0;
        flare = cp >= 0.45 ? ease.outBack(Math.min((cp-0.45)/0.35,1)) * (1-Math.max(0,(cp-0.80)/0.20)) : 0; break;
      case 'mine':
        // 쪼그려 덫 설치: 아래로 숙이며 앞으로 손 뻗기
        rise = cp < 0.50 ? lerp(0,10,ease.outQuad(cp/0.50)) : lerp(10,2,ease.outBack((cp-0.50)/0.50));
        push = cp < 0.50 ? lerp(0,7,ease.outQuad(cp/0.50)) : lerp(7,1,ease.outBack((cp-0.50)/0.50));
        sx = lerp(1,0.90,Math.sin(cp * Math.PI));
        sy = lerp(1,1.10,Math.sin(cp * Math.PI));
        arm = cp < 0.50 ? lerp(0,0.8,ease.outQuad(cp/0.50)) : 0.8;
        flare = cp < 0.45 ? 0 : ease.outQuad((cp-0.45)/0.30) * (1-Math.max(0,(cp-0.75)/0.25)); break;
      case 'turret':
        // 포탑 설치: 들어올려 내려놓기 → 활성화 glow
        rise = cp < 0.40 ? lerp(0,-12,ease.outQuad(cp/0.40)) : lerp(-12,2,ease.outBack((cp-0.40)/0.60));
        push = cp < 0.40 ? lerp(0,8,ease.outQuad(cp/0.40)) : lerp(8,1,ease.outBack((cp-0.40)/0.60));
        arm = cp < 0.40 ? lerp(0,1,ease.outQuad(cp/0.40)) : lerp(1,0.3,(cp-0.40)/0.60);
        flare = cp > 0.70 ? ease.outQuad((cp-0.70)/0.30) : 0; break;
      default:
        arm = Math.sin(cp * Math.PI); flare = Math.sin(cp * Math.PI);
    }
    return { type, cp, aim, push, rise, sx, sy, arm, flare, col: CAST_COL[type] || '#FFFFFF' };
  }
  function drawCastGesture(ctx, cast, meta) {
    const col = cast.col, r = meta.r;
    ctx.save(); ctx.rotate(cast.aim);
    const reach = r + 6 + 14 * (0.5 + 0.5 * cast.arm);
    const spread = (cast.type === 'nova' || cast.type === 'aoe_field') ? 0.45 + 0.55 * (0.5 + 0.5 * cast.arm) : 0.14;
    ctx.globalAlpha = 0.85; ctx.shadowColor = col; ctx.shadowBlur = 8 + 12 * cast.flare;
    ctx.strokeStyle = col; ctx.lineWidth = 3; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(r * 0.4, 0); ctx.lineTo(Math.cos(spread) * reach, Math.sin(spread) * reach); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(r * 0.4, 0); ctx.lineTo(Math.cos(spread) * reach, -Math.sin(spread) * reach); ctx.stroke();
    ctx.fillStyle = '#FFFFFF'; ctx.globalAlpha = 0.55 + 0.45 * cast.flare;
    ctx.beginPath(); ctx.arc(r * 0.4 + reach * 0.35, 0, 2 + 5 * cast.flare, 0, TAU); ctx.fill();
    ctx.restore();
  }

  // ───────────────────────── 치장(Tier) ─────────────────────────
  function drawAuraBack(ctx, p, meta, now) {
    if (p.tier >= 2) {
      ctx.save();
      ctx.shadowColor = meta.aura; ctx.shadowBlur = 10;
      ctx.strokeStyle = meta.aura; ctx.lineWidth = 2; ctx.globalAlpha = 0.55 + 0.15 * Math.sin(now * 0.005);
      ctx.beginPath(); ctx.arc(0, 0, meta.r + 3, 0, TAU); ctx.stroke();
      ctx.restore();
    }
  }
  function drawAuraFront(ctx, p, meta, now) {
    if (p.tier >= 3) {
      ctx.save(); ctx.globalAlpha = 0.95;
      for (let i = 0; i < 8; i++) {
        const a = now * 0.0028 + i / 8 * TAU;
        const rr = meta.r + 7 + Math.sin(now * 0.006 + i) * 3;
        ctx.fillStyle = i % 2 ? meta.aura : '#FFFFFF';
        ctx.shadowColor = meta.aura; ctx.shadowBlur = 6;
        dot(ctx, Math.cos(a) * rr, Math.sin(a) * rr, 2.3);
      }
      ctx.restore();
    }
  }

  // ───────────────────────── 무기 ─────────────────────────
  function drawSword(ctx, ang, tier, ghostAlpha) {
    ctx.save(); ctx.rotate(ang + Math.PI / 2);
    if (ghostAlpha) ctx.globalAlpha *= ghostAlpha;
    const col = SWORD[tier - 1] || SWORD[0];
    if (tier >= 2) { ctx.shadowColor = tier >= 3 ? '#FF8800' : '#2266CC'; ctx.shadowBlur = tier >= 3 ? 10 : 6; }
    ctx.fillStyle = '#6B3A1F'; ctx.fillRect(-2.5, -6, 5, 9);
    ctx.fillStyle = '#8B5A2B'; ctx.fillRect(-5, -2, 10, 3);
    ctx.fillStyle = col; ctx.fillRect(-2.5, 3, 5, 33); tri(ctx, -2.5, 36, 2.5, 36, 0, 44);
    ctx.fillStyle = 'rgba(255,255,255,0.35)'; ctx.fillRect(-0.6, 4, 1.2, 30);
    if (tier >= 3) { ctx.fillStyle = '#FFD700'; ctx.fillRect(-5, 16, 3, 3); ctx.fillRect(2, 16, 3, 3); }
    ctx.restore();
  }
  function drawDagger(ctx, ang, tier, len) {
    ctx.save(); ctx.rotate(ang + Math.PI / 2);
    const col = DAGGER[tier - 1] || DAGGER[0];
    if (tier >= 2) { ctx.shadowColor = '#AA22FF'; ctx.shadowBlur = 8; }
    ctx.strokeStyle = col; ctx.lineWidth = 3; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(0, 4); ctx.lineTo(0, len); ctx.stroke();
    ctx.fillStyle = col; tri(ctx, -3, len, 3, len, 0, len + 5);
    ctx.fillStyle = '#3a2a1a'; ctx.fillRect(-2, 0, 4, 5);
    ctx.restore();
  }

  // ───────────────────────── 직업별 렌더 ─────────────────────────
  const DRAW = {
    // 전사 — 스윙: 앤티시페이션(뒤로 코일) → 스윙(easeOutQuad) → outBack 팔로스루
    warrior(ctx, p, meta, now, aim, aimIdle, atype, prog, breathe, opts) {
      let lunge = 0, sw = 0, swinging = false, coil = 1;
      if (atype === 'swing') {
        if (prog < 0.30) {
          const a = ease.outQuad(prog / 0.30);
          sw = lerp(0, -SWING_HALF - 0.16, a);
          coil = 1 - 0.06 * a;
          lunge = -2.5 * a;
        } else if (prog < 0.60) {
          swinging = true; sw = lerp(-SWING_HALF - 0.16, SWING_HALF, ease.outQuad((prog - 0.30) / 0.30));
          lunge = Math.sin((prog - 0.30) / 0.30 * Math.PI) * 6;
        } else {
          const a = (prog - 0.60) / 0.40;
          sw = lerp(SWING_HALF, 0, ease.outBack(a));
          coil = 1 + 0.04 * (1 - a);
        }
      }
      const cx = Math.cos(aim) * lunge, cy = Math.sin(aim) * lunge + breathe;

      // 슬래시 잔상(스윙 구간)
      if (swinging) {
        const ghosts = [0.12, 0.24];
        for (let k = 0; k < ghosts.length; k++) {
          const gAng = aim + lerp(sw, -SWING_HALF, ghosts[k] * 2.2);
          ctx.save(); ctx.translate(cx, cy);
          drawSword(ctx, gAng, p.tier, 0.18 - k * 0.06);
          ctx.restore();
        }
        ctx.save(); ctx.translate(cx, cy);
        ctx.strokeStyle = 'rgba(138,180,248,0.35)'; ctx.lineWidth = 4; ctx.lineCap = 'round';
        ctx.beginPath(); ctx.arc(0, 0, 40, aim - SWING_HALF, aim + sw); ctx.stroke();
        ctx.restore();
      }

      ctx.save(); ctx.translate(cx, cy); ctx.scale(2 - coil, coil);
      ball(ctx, 0, 0, 22, meta.accent, meta.body);
      ctx.strokeStyle = meta.accent; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(0, 0, 22, 0, TAU); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(-10, 0); ctx.lineTo(10, 0); ctx.moveTo(0, -10); ctx.lineTo(0, 10); ctx.stroke();
      ctx.fillStyle = '#1E3A6A'; dot(ctx, -18, 4, 6); dot(ctx, 18, 4, 6);
      ctx.fillStyle = '#1E3A6A'; ctx.beginPath(); ctx.arc(0, -6, 16, Math.PI, 0); ctx.fill();
      ctx.fillStyle = '#111'; ctx.fillRect(-8, -8, 16, 5);
      ctx.fillStyle = '#1E3A6A'; tri(ctx, -16, -22, -10, -14, -18, -12); tri(ctx, 16, -22, 10, -14, 18, -12);
      if (p.tier >= 3) { ctx.fillStyle = '#FFD700'; star(ctx, 0, -18, 4); }
      ctx.restore();

      ctx.save(); ctx.translate(cx, cy);
      drawSword(ctx, aim + sw, p.tier);
      ctx.restore();
    },

    // 마법사 — 캐스팅: 차징(구 확대) → 발사(반동) → 복귀
    mage(ctx, p, meta, now, aim, aimIdle, atype, prog, breathe, opts) {
      let orbR = 7, recoil = 0, flash = 0;
      if (atype === 'cast') {
        if (prog < 0.5) {
          const a = ease.outQuad(prog / 0.5);
          orbR = lerp(7, 12, a); recoil = lerp(0, -3, a);
        } else {
          const a = (prog - 0.5) / 0.5;
          orbR = lerp(12, 7, ease.outQuad(a));
          recoil = lerp(-3, 6, ease.outCirc(Math.min(a / 0.4, 1)));
          recoil = lerp(recoil, 0, a < 0.4 ? 0 : ease.outBack((a - 0.4) / 0.6));
          flash = prog < 0.62 ? 1 - (prog - 0.5) / 0.12 : 0;
        }
      }
      ctx.save(); ctx.translate(0, breathe);
      ctx.fillStyle = meta.body; tri(ctx, -12, 10, 12, 10, 0, 28);
      ball(ctx, 0, 0, 18, meta.accent, meta.body);
      ctx.strokeStyle = meta.accent; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(0, 0, 18, 0, TAU); ctx.stroke();
      ctx.fillStyle = '#2A0850'; tri(ctx, 0, -30, -14, -16, 14, -16); ctx.fillRect(-16, -18, 32, 4);
      if (p.tier >= 3) { ctx.fillStyle = '#FFD700'; star(ctx, 0, -30, 5); }
      ctx.restore();

      ctx.save(); ctx.rotate(aim);
      ctx.strokeStyle = '#6B3A1F'; ctx.lineWidth = 4; ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(40 + recoil, 0); ctx.stroke();
      const oc = ORB[p.tier - 1] || ORB[0];
      ctx.save(); ctx.shadowColor = '#AA22FF'; ctx.shadowBlur = (p.tier >= 2 ? 12 : 7) + flash * 14;
      ctx.fillStyle = oc; dot(ctx, 40 + recoil, 0, orbR);
      if (flash > 0) { ctx.globalAlpha = flash * 0.8; ctx.fillStyle = '#FFFFFF'; dot(ctx, 40 + recoil, 0, orbR + 5 * flash); }
      ctx.restore();
      if (p.tier >= 3) {
        ctx.strokeStyle = '#CC88FF'; ctx.lineWidth = 1.5;
        for (let i = 0; i < 6; i++) { const a = now * 0.005 + i / 6 * TAU; ctx.beginPath(); ctx.moveTo(40 + recoil, 0); ctx.lineTo(40 + recoil + Math.cos(a) * 12, Math.sin(a) * 12); ctx.stroke(); }
      }
      ctx.restore();
    },

    // 궁수 — 발사: 당기기(앤티시페이션) → 발사(반동) → 복귀
    archer(ctx, p, meta, now, aim, aimIdle, atype, prog, breathe, opts) {
      let pull = 0, recoil = 0, released = false;
      if (atype === 'shoot') {
        if (prog < 0.5) {
          pull = lerp(0, 8, ease.outQuad(prog / 0.5));
        } else {
          released = true;
          const a = (prog - 0.5) / 0.5;
          recoil = lerp(10, 0, ease.outCirc(Math.min(a / 0.55, 1)));
          recoil = lerp(recoil, 0, a < 0.55 ? 0 : ease.outBack((a - 0.55) / 0.45));
        }
      }
      ctx.save(); ctx.translate(0, breathe);
      ctx.fillStyle = meta.body; ctx.beginPath(); ctx.arc(0, 0, 22, 0, Math.PI); ctx.fill();
      ball(ctx, 0, 0, 18, meta.accent, meta.body);
      ctx.fillStyle = '#1B5E20'; ctx.beginPath(); ctx.arc(0, -2, 16, Math.PI, 0); ctx.fill();
      ctx.fillStyle = '#FFD700'; ctx.fillRect(-5, -4, 3, 3); ctx.fillRect(2, -4, 3, 3);
      ctx.restore();

      ctx.save(); ctx.rotate(aim); ctx.translate(-recoil, 0);
      const bc = BOW[p.tier - 1] || BOW[0];
      ctx.save(); if (p.tier >= 2) { ctx.shadowColor = bc; ctx.shadowBlur = p.tier >= 3 ? 12 : 8; }
      ctx.strokeStyle = bc; ctx.lineWidth = 4;
      ctx.beginPath(); ctx.arc(18, 0, 18, -1.25, 1.25); ctx.stroke(); ctx.restore();
      ctx.strokeStyle = '#ddd'; ctx.lineWidth = 1.5;
      const tx = 18 + Math.cos(1.25) * 18, ty = Math.sin(1.25) * 18;
      ctx.beginPath(); ctx.moveTo(tx, ty); ctx.lineTo(6 - pull, 0); ctx.lineTo(tx, -ty); ctx.stroke();
      if (!released) {
        ctx.strokeStyle = bc; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(6 - pull, 0); ctx.lineTo(30 - pull, 0); ctx.stroke();
        ctx.fillStyle = bc; tri(ctx, 30 - pull, -3, 30 - pull, 3, 36 - pull, 0);
      }
      if (p.tier >= 3) {
        for (let i = 0; i < 3; i++) { const a = now * 0.004 + i / 3 * TAU; ctx.fillStyle = '#7CFC9A'; ctx.globalAlpha = 0.8; dot(ctx, 10 + Math.cos(a) * 26, Math.sin(a) * 26, 2.4); }
      }
      ctx.restore();
    },

    // 암살자 — 대시: 대시 잔상 → 연속 스탭(3회 교차)
    assassin(ctx, p, meta, now, aim, aimIdle, atype, prog, breathe, opts) {
      if (atype === 'dash' && prog < 0.5) {
        const dp = prog / 0.5;
        for (let i = 1; i <= 4; i++) {
          const off = -i * 11 * (1 - dp * 0.4);
          ctx.save(); ctx.globalAlpha = (0.30 - i * 0.06) * (1 - dp);
          ball(ctx, Math.cos(aim) * off, Math.sin(aim) * off + breathe, 16, meta.accent, meta.body);
          ctx.restore();
        }
      }
      let aScale = 1;
      if (atype === 'dash') {
        if (prog < 0.12) aScale = lerp(1, 0.86, ease.outQuad(prog / 0.12));
        else if (prog < 0.45) aScale = lerp(1.14, 1, ease.outQuad((prog - 0.12) / 0.33));
      }
      ctx.save(); ctx.translate(0, breathe); ctx.scale(2 - aScale, aScale);
      if (p.tier >= 3) { ctx.save(); ctx.globalAlpha = 0.35; ball(ctx, -Math.cos(aim) * 6, -Math.sin(aim) * 6, 14, meta.body, meta.body); ctx.restore(); }
      ball(ctx, 0, 0, 16, meta.accent, meta.body);
      ctx.strokeStyle = meta.accent; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(0, 0, 16, 0, TAU); ctx.stroke();
      ctx.fillStyle = '#1A0A30'; ctx.beginPath(); ctx.arc(0, -2, 16, Math.PI, 0); ctx.fill();
      ctx.fillStyle = '#FF3399'; ctx.fillRect(-6, -4, 4, 3); ctx.fillRect(2, -4, 4, 3);
      ctx.restore();

      let spread = 0.42, stabbing = false;
      if (atype === 'dash' && prog >= 0.45) {
        const sp = (prog - 0.45) / 0.55;
        spread = 0.42 + Math.sin(sp * Math.PI * 3) * 0.75;
        stabbing = true;
      }
      if (stabbing) {
        ctx.save();
        ctx.strokeStyle = 'rgba(204,68,255,0.4)'; ctx.lineWidth = 3; ctx.lineCap = 'round';
        ctx.beginPath(); ctx.arc(0, 0, 26, aim - spread * 0.5, aim + spread * 0.5); ctx.stroke();
        ctx.restore();
      }
      drawDagger(ctx, aim - spread * 0.45, p.tier, 22);
      drawDagger(ctx, aim + spread * 0.45, p.tier, 18);
    },
  };

  // ───────────────────────── 라벨(HP/별/이름) ─────────────────────────
  function drawLabel(ctx, p, meta, opts) {
    const w = Math.max(40, meta.r * 1.8), h = 5, x = p.x - w / 2, y = p.y + meta.r + 8;
    const ratio = clamp(p.hp / Math.max(1, p.maxHp), 0, 1);
    ctx.fillStyle = '#333'; ctx.fillRect(x, y, w, h);
    ctx.fillStyle = ratio > 0.5 ? '#44DD44' : ratio > 0.25 ? '#FFCC00' : '#FF4444';
    ctx.fillRect(x, y, w * ratio, h);
    ctx.strokeStyle = 'rgba(0,0,0,0.5)'; ctx.lineWidth = 1; ctx.strokeRect(x, y, w, h);
    const t = clamp(p.tier || 1, 1, 3);
    ctx.fillStyle = t >= 3 ? '#FFD700' : t >= 2 ? '#4A90E2' : '#888888';
    ctx.font = '10px Arial'; ctx.textAlign = 'center';
    ctx.fillText('★'.repeat(t) + '☆'.repeat(3 - t), p.x, y + 16);
    ctx.fillStyle = opts.isSelf ? '#FFFFFF' : '#cfcfe6'; ctx.font = 'bold 11px Arial';
    ctx.fillText(p.name || meta.name, p.x, p.y - meta.r - 12);
    ctx.textAlign = 'left';
  }

  function init() { /* lazy 자원 없음 — 호출 안 해도 무방 */ }

  window.ChampMotion = { drawChampion, init };
})();
