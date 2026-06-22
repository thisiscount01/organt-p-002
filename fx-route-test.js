// app.js의 effectsAPI 라우팅 로직을 런타임으로 검증.
// window.Effects가 spawn을 노출하면 spawn/update/render/getHitStop/getScreenShake가
// 모두 '같은 인스턴스(window.Effects)'로 가야 한다(폴백 FX 아님).
const fs = require('fs');
const src = fs.readFileSync('public/app.js', 'utf8');

// 1) 정적 검증: 프레임 루프가 fx(프레임당 1회 확정) 한 인스턴스로 update/render를 호출하는가.
const checks = [
  ['effectsAPI 캐시', /const fx = effectsAPI\(\);/],
  ['getHitStop 반영', /fx\.getHitStop/],
  ['getScreenShake 합산', /fx\.getScreenShake/],
  ['update fx 라우팅', /if \(!frozen && typeof fx\.update === 'function'\) fx\.update\(dt\);/],
  ['render fx 라우팅', /\(fx\.render \|\| FX\.render\)\.call\(fx, ctx, sNow/],
  ['옛 폴백직접호출 제거(FX.update(dt) 단독)', /FX\.update\(dt\);/, true /*absent*/],
  ['옛 effectsAPI().render 이중호출 제거', /effectsAPI\(\)\.render \|\| FX\.render\)\.call\(effectsAPI\(\)/, true],
];
let fail = 0;
for (const [name, re, mustAbsent] of checks) {
  const found = re.test(src);
  const ok = mustAbsent ? !found : found;
  console.log((ok ? '  PASS: ' : '  FAIL: ') + name);
  if (!ok) fail++;
}

// 2) 런타임 검증: effectsAPI 패턴을 그대로 재현해 인스턴스 일관성 확인.
const calls = [];
const windowEffects = {
  spawn: () => calls.push('spawn'),
  update: () => calls.push('update'),
  render: () => calls.push('render'),
  getHitStop: () => { calls.push('getHitStop'); return 0; },
  getScreenShake: () => { calls.push('getScreenShake'); return { x: 0, y: 0 }; },
};
const FX = { spawn: () => calls.push('FX.spawn'), update: () => calls.push('FX.update'), render: () => calls.push('FX.render') };
let WIN = { Effects: windowEffects };
const effectsAPI = () => (WIN.Effects && typeof WIN.Effects.spawn === 'function') ? WIN.Effects : FX;

// window.Effects 있는 경우: 한 프레임 시뮬
function simFrame() {
  const fx = effectsAPI();
  if (typeof fx.getHitStop === 'function') fx.getHitStop();
  if (typeof fx.getScreenShake === 'function') fx.getScreenShake();
  // spawn은 이벤트 핸들러 경로(effectsAPI())
  effectsAPI().spawn('hit', {});
  if (typeof fx.update === 'function') fx.update(0.016);
  (fx.render || FX.render).call(fx, {}, 0);
}
calls.length = 0; simFrame();
const all = calls.join(',');
const usesWindow = !all.includes('FX.');
console.log('  ' + (usesWindow ? 'PASS' : 'FAIL') + ': window.Effects 로드 시 모든 호출이 동일 인스턴스(window.Effects)로 라우팅 → [' + all + ']');
if (!usesWindow) fail++;

// window.Effects 없는 경우: 폴백 FX로 일관
WIN = {};
calls.length = 0; simFrame();
const fb = calls.join(',');
const usesFallback = fb.includes('FX.render') && fb.includes('FX.update') && fb.includes('FX.spawn');
console.log('  ' + (usesFallback ? 'PASS' : 'FAIL') + ': window.Effects 미로드 시 폴백 FX로 일관 → [' + fb + ']');
if (!usesFallback) fail++;

console.log('\n===== fx-route-test: ' + (fail === 0 ? 'ALL PASS' : fail + ' FAIL') + ' =====');
process.exit(fail === 0 ? 0 : 1);
