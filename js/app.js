import { db, openDB } from './db.js';

/* =====================================================================
 * 상수·상태
 * ===================================================================*/
const APP_VERSION = self.FQ_VERSION || 'dev';
const SET_SIZE = 5;
const TYPE_LABEL = { short_answer: '단답형', essay: '서술형' };
const SELF_LABEL = { correct: '맞음', needs_review: '보완 필요', incorrect: '틀림', not_assessed: '미평가' };
const AI_LABEL = { correct: '정답', partial: '부분정답', incorrect: '오답', undetermined: '판단보류' };
const RESULT_LABEL = { correct: '정답', wrong: '오답', pending: '판단 대기' };

const state = {
  bank: [], byId: new Map(), units: [], meta: null, issues: [],
  generated: new Map(), attempts: new Map(),
  session: null, view: 'home',
  filters: { type: 'both', units: null, source: 'bank' },
  config: { url: '', token: '' },
  deviceId: '', history: {},
  online: navigator.onLine, syncing: false, lastSync: null, lastSyncError: '',
  offline: { checked: false, ready: false, missing: [], controlled: false, persisted: null },
  showResolved: false, busy: {},
  batch: { running: false, confirm: null },
  lastPull: null, pullNote: ''
};

const $app = document.getElementById('app');
const $status = document.getElementById('statusbar');

/* =====================================================================
 * 유틸
 * ===================================================================*/
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const nowIso = () => new Date().toISOString();
const rid = (n = 6) => Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => (b % 36).toString(36)).join('');
const shuffle = (a) => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const fmtTime = (iso) => { if (!iso) return ''; const d = new Date(iso); return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };

// 단답형 정규화: NFKC + 소문자 + 공백 제거만. 기호·숫자·소수점은 그대로 둔다.
export const normalize = (s) => String(s ?? '').normalize('NFKC').toLowerCase().replace(/\s+/g, '');

function toast(msg, ms = 2600) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.classList.add('show');
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove('show'), ms);
}

const getQ = (id) => state.byId.get(id) || state.generated.get(id);
const isOnline = () => navigator.onLine;
const serverReady = () => !!(state.config.url && state.config.token);
const needLabel = () => (!isOnline() ? ' (온라인 필요)' : !serverReady() ? ' (설정에서 서버 연결 필요)' : '');

/* =====================================================================
 * 시작
 * ===================================================================*/
async function boot() {
  try {
    await openDB();
  } catch (e) {
    $app.innerHTML = `<div class="card"><h2>저장소를 열 수 없습니다</h2><p>${esc(e.message)}</p></div>`;
    return;
  }
  const [bankRes, attempts, generated] = await Promise.all([
    fetch('./data/questions.json').then((r) => { if (!r.ok) throw new Error('문제은행 파일 ' + r.status); return r.json(); }),
    db.getAll('attempts'), db.getAll('generated')
  ]).catch((e) => { $app.innerHTML = `<div class="card"><h2>문제은행을 불러오지 못했습니다</h2><p>${esc(e.message)}</p><p class="sub">처음 한 번은 인터넷에 연결된 상태로 열어야 합니다.</p></div>`; throw e; });

  state.meta = bankRes.metadata;
  state.issues = bankRes.source_review_issues || [];
  state.bank = bankRes.questions.filter((q) => q.enabled !== false);
  state.bank.forEach((q) => state.byId.set(q.id, q));
  state.units = Object.keys(bankRes.metadata.unit_counts || {});
  state.bank.forEach((q) => { if (!state.units.includes(q.unit)) state.units.push(q.unit); });
  attempts.forEach((a) => state.attempts.set(a.attempt_id, a));
  generated.forEach((g) => state.generated.set(g.id, g));

  state.deviceId = await db.kvGet('device_id');
  if (!state.deviceId) { state.deviceId = 'D' + rid(7); await db.kvSet('device_id', state.deviceId); }
  state.config = await db.kvGet('config', { url: self.FQ_DEFAULT_SCRIPT_URL || '', token: '' });
  state.history = await db.kvGet('history', {});
  state.session = await db.kvGet('session', null);
  state.lastSync = await db.kvGet('last_sync', null);
  state.lastPull = await db.kvGet('last_pull', null);
  const savedFilters = await db.kvGet('filters', null);
  if (savedFilters) state.filters = { ...state.filters, ...savedFilters };
  if (!state.filters.units) state.filters.units = [...state.units];

  // 앱이 AI 채점 도중 닫혔던 경우 정리
  for (const a of state.attempts.values()) {
    if (a.ai_status === 'pending') { a.ai_status = 'error'; a.ai_error = '앱이 닫혀 채점이 중단되었습니다. 다시 시도하세요.'; await db.put('attempts', a); }
  }

  window.addEventListener('online', () => { state.online = true; renderStatus(); syncNow('online'); });
  window.addEventListener('offline', () => { state.online = false; renderStatus(); });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') syncNow('visible'); });
  document.addEventListener('click', onClick);
  document.addEventListener('input', onInput);
  document.addEventListener('change', onChange);

  render();
  registerSW();
  requestPersist();
  syncNow('open');
}

/* =====================================================================
 * 서비스 워커 / 오프라인 준비 확인
 * ===================================================================*/
async function registerSW() {
  if (!('serviceWorker' in navigator)) { state.offline = { ...state.offline, checked: true, ready: false, missing: ['서비스 워커 미지원 브라우저'] }; renderStatus(); return; }
  try {
    const reg = await navigator.serviceWorker.register('./sw.js', { scope: './', updateViaCache: 'none' });
    const showUpdate = () => { if (reg.waiting && navigator.serviceWorker.controller) document.getElementById('update-banner').hidden = false; };
    showUpdate();
    reg.addEventListener('updatefound', () => {
      const nw = reg.installing;
      nw && nw.addEventListener('statechange', () => { if (nw.state === 'installed') { showUpdate(); checkOffline(); } });
    });
    let reloading = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (state.applyingUpdate && !reloading) { reloading = true; location.reload(); return; }
      checkOffline();
    });
    state.swReg = reg;
    await navigator.serviceWorker.ready;
    await checkOffline();
    if (isOnline()) reg.update().catch(() => {});
  } catch (e) {
    state.offline = { ...state.offline, checked: true, ready: false, missing: ['서비스 워커 등록 실패: ' + e.message] };
    renderStatus();
  }
}

async function checkOffline() {
  const list = self.FQ_PRECACHE || [];
  const missing = [];
  if ('caches' in self) {
    for (const u of list) {
      const hit = await caches.match(new URL(u, location.href).href, { ignoreSearch: true });
      if (!hit) missing.push(u);
    }
  } else missing.push('Cache Storage 미지원');
  const controlled = !!navigator.serviceWorker?.controller;
  const ready = missing.length === 0 && controlled && state.bank.length > 0;
  const wasReady = state.offline.ready;
  state.offline = { ...state.offline, checked: true, ready, missing, controlled };
  if (ready && !wasReady) await db.kvSet('offline_ready_at', nowIso());
  renderStatus();
  if (state.view === 'settings') render();
}

async function requestPersist() {
  try {
    if (navigator.storage?.persist) {
      state.offline.persisted = (await navigator.storage.persisted()) || (await navigator.storage.persist());
    }
  } catch { /* 무시 */ }
}

function applyUpdate() {
  state.applyingUpdate = true;
  const w = state.swReg?.waiting;
  if (w) w.postMessage('SKIP_WAITING'); else location.reload();
}

/* =====================================================================
 * 기록(attempt)
 * ===================================================================*/
function newAttempt(q, sessionId) {
  const a = {
    attempt_id: `A-${state.deviceId}-${Date.now().toString(36)}-${rid(4)}`,
    rev: 1, synced_rev: 0,
    question_id: q.id, concept_id: q.concept_id, type: q.type, unit: q.unit, topic: q.topic,
    origin: q.generated_online ? 'generated' : 'bank',
    review_status: q.review_status,
    question_text: q.question, model_answer: q.model_answer,
    source_pages: q.source?.pdf_pages || [],
    submitted_answer: '', auto_check: '', self_assessment: 'not_assessed',
    ai_status: 'none', ai_verdict: '', ai_score: '', ai_feedback: '', ai_detail: null, ai_error: '',
    answered_at: null, model_viewed_at: null, ai_graded_at: null,
    created_at: nowIso(), updated_at: nowIso(), device_id: state.deviceId, session_id: sessionId
  };
  state.attempts.set(a.attempt_id, a);
  return a;
}

async function saveAttempt(a, { bump = true } = {}) {
  if (bump) { a.rev = (a.rev || 0) + 1; a.edited_by = state.deviceId; }
  a.updated_at = nowIso();
  state.attempts.set(a.attempt_id, a);
  await db.put('attempts', a);
  if (bump && a.answered_at) scheduleSync();
}

export function finalResult(a) {
  if (!a || !a.answered_at) return 'pending';
  if (a.auto_check === 'alias_match') return 'correct';
  const s = a.self_assessment, v = a.ai_verdict;
  if (s === 'incorrect' || s === 'needs_review' || v === 'incorrect' || v === 'partial') return 'wrong';
  if (s === 'correct' || v === 'correct') return 'correct';
  return 'pending';
}

const needsSync = (a) => a.answered_at && (a.synced_rev || 0) < (a.rev || 0);
const pendingCount = () => [...state.attempts.values()].filter(needsSync).length + [...state.generated.values()].filter((g) => !g.synced).length;

/* =====================================================================
 * 세트 구성 (5문항, 같은 concept 중복 없음, 최근 출제·단원 편중 완화)
 * ===================================================================*/
function buildPool(source) {
  const f = state.filters;
  const typeOk = (q) => f.type === 'both' || q.type === f.type;
  const unitOk = (q) => f.units.includes(q.unit);
  if (source === 'wrong') {
    const ids = wrongNotes().filter((w) => !w.resolved).map((w) => w.question_id);
    return ids.map(getQ).filter((q) => q && typeOk(q) && unitOk(q));
  }
  if (source === 'generated') return [...state.generated.values()].filter((q) => typeOk(q) && unitOk(q));
  return state.bank.filter((q) => typeOk(q) && unitOk(q));
}

function pickSet(pool) {
  const seen = (q) => state.history[q.id] || 0;
  const byUnit = new Map();
  shuffle([...pool]).forEach((q) => { if (!byUnit.has(q.unit)) byUnit.set(q.unit, []); byUnit.get(q.unit).push(q); });
  byUnit.forEach((arr) => arr.sort((a, b) => seen(a) - seen(b)));
  // 단원 순서: 최근에 덜 본 단원부터
  const unitOrder = shuffle([...byUnit.keys()]).sort((a, b) => {
    const ua = Math.min(...byUnit.get(a).map(seen)), ub = Math.min(...byUnit.get(b).map(seen));
    return ua - ub;
  });
  const picked = [], usedConcept = new Set();
  let progress = true;
  while (picked.length < SET_SIZE && progress) {
    progress = false;
    for (const u of unitOrder) {
      if (picked.length >= SET_SIZE) break;
      const arr = byUnit.get(u);
      const i = arr.findIndex((q) => !usedConcept.has(q.concept_id));
      if (i >= 0) { const q = arr.splice(i, 1)[0]; picked.push(q); usedConcept.add(q.concept_id); progress = true; }
    }
  }
  return picked;
}

async function startSession(questions, source) {
  if (!questions.length) { toast('조건에 맞는 문제가 없습니다.'); return; }
  const id = 'S-' + Date.now().toString(36) + rid(3);
  const items = [];
  for (const q of questions) {
    const a = newAttempt(q, id);
    await saveAttempt(a, { bump: false });
    items.push({ qid: q.id, aid: a.attempt_id });
    state.history[q.id] = Date.now();
  }
  await db.kvSet('history', state.history);
  state.session = { id, items, index: 0, source, created_at: nowIso(), finished: false };
  await db.kvSet('session', state.session);
  go('quiz');
}

async function setIndex(i) {
  state.session.index = Math.max(0, Math.min(state.session.items.length - 1, i));
  await db.kvSet('session', state.session);
  render();
  window.scrollTo({ top: 0 });
}

/* =====================================================================
 * 오답노트 (로컬 계산 — 서버 오답노트와 같은 규칙)
 * ===================================================================*/
function wrongNotes() {
  const byQ = new Map();
  for (const a of state.attempts.values()) {
    if (!a.answered_at) continue;
    if (!byQ.has(a.question_id)) byQ.set(a.question_id, []);
    byQ.get(a.question_id).push(a);
  }
  const out = [];
  byQ.forEach((list, qid) => {
    list.sort((x, y) => (x.answered_at < y.answered_at ? -1 : 1));
    const wrongs = list.filter((a) => finalResult(a) === 'wrong');
    if (!wrongs.length) return;
    const last = list[list.length - 1];
    out.push({
      question_id: qid, last, wrong_count: wrongs.length, attempt_count: list.length,
      last_wrong_at: wrongs[wrongs.length - 1].answered_at, resolved: finalResult(last) === 'correct'
    });
  });
  return out.sort((a, b) => (a.last_wrong_at < b.last_wrong_at ? 1 : -1));
}

/* =====================================================================
 * 서버 통신 (Apps Script)
 * ===================================================================*/
async function callServer(action, payload = {}, timeoutMs = 60000) {
  if (!serverReady()) throw new Error('설정 화면에서 Apps Script 주소와 토큰을 먼저 입력하세요.');
  if (!isOnline()) throw new Error('오프라인 상태입니다.');
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  const t0 = performance.now();
  let res;
  try {
    // Content-Type을 지정하지 않으면 text/plain으로 전송되어 CORS 사전요청 없이 Apps Script에 도달한다.
    res = await fetch(state.config.url, {
      method: 'POST', redirect: 'follow', signal: ctrl.signal, cache: 'no-store',
      body: JSON.stringify({ action, token: state.config.token, device_id: state.deviceId, app_version: APP_VERSION, ...payload })
    });
  } catch (e) {
    throw new Error(e.name === 'AbortError' ? '서버 응답 시간 초과' : '서버에 연결하지 못했습니다.');
  } finally { clearTimeout(t); }
  const text = await res.text();
  // 진단용: 실제 Apps Script는 script.google.com → script.googleusercontent.com 으로 302 리다이렉트한 뒤 JSON을 준다.
  state.lastHttp = { action, status: res.status, redirected: res.redirected, finalHost: hostOf(res.url),
    contentType: res.headers.get('content-type') || '', ms: Math.round(performance.now() - t0) };
  let data;
  try { data = JSON.parse(text); } catch {
    throw new Error(/<html/i.test(text) ? '서버가 JSON 대신 웹페이지를 돌려줬습니다. 웹 앱 배포의 액세스 권한이 "모든 사용자"인지, 새 버전으로 배포했는지 확인하세요.' : `서버 응답을 해석하지 못했습니다 (HTTP ${res.status}).`);
  }
  if (!data.ok) {
    const err = new Error(data.error === 'sheet_not_configured' ? '서버에 스프레드시트 ID(SHEET_ID)가 없습니다. Apps Script 편집기에서 setup()을 실행한 뒤 다시 시도하세요.' : (data.message || data.error || '서버 오류'));
    err.code = data.error; err.server = true; throw err;
  }
  return data;
}

function hostOf(u) { try { return new URL(u).host; } catch { return ''; } }

let syncTimer = null;
function scheduleSync() { clearTimeout(syncTimer); syncTimer = setTimeout(() => syncNow('auto'), 2000); }

async function syncNow(reason) {
  if (state.syncing || !serverReady() || !isOnline()) { renderStatus(); return { skipped: true }; }
  state.syncing = true; renderStatus();
  let savedTotal = 0, failedTotal = 0, conflictTotal = 0;
  let pulled = { added: 0, updated: 0, conflicts: 0 };
  try {
    // 1) 올리기: 충돌이 나면 병합한 뒤 한 번 더 올린다 (최대 3회)
    for (let round = 0; round < 3; round++) {
      const recs = [...state.attempts.values()].filter(needsSync);
      const gens = [...state.generated.values()].filter((g) => !g.synced);
      if (!recs.length && !gens.length) break;
      const r = await pushOnce(recs, gens);
      savedTotal += r.saved; failedTotal += r.failed; conflictTotal += r.conflicts;
      if (!r.conflicts) break;
    }
    // 2) 내려받기: 다른 기기 기록 병합 (앱 열 때·재연결·앱으로 돌아올 때·수동·연결 확인 때. 풀이 직후 자동 전송 때는 생략)
    if (reason !== 'auto') pulled = await pullAll();
    state.lastSync = nowIso();
    const left = [...state.attempts.values()].filter(needsSync).length;
    state.lastSyncError = failedTotal && left ? `${failedTotal}건 저장 확인 실패 (다음 동기화 때 다시 보냄)` : '';
    await db.kvSet('last_sync', state.lastSync);
    if (reason === 'manual') {
      const c = conflictTotal + pulled.conflicts;
      toast(`동기화 완료: 보냄 ${savedTotal}건 · 받음 ${pulled.added + pulled.updated}건${c ? ` · 수정 충돌 ${c}건 병합` : ''}`, 3500);
    }
  } catch (e) {
    state.lastSyncError = e.message;
    if (reason === 'manual') toast('동기화 실패: ' + e.message, 4000);
  } finally {
    state.syncing = false;
    renderStatus();
    if (['records', 'settings', 'wrong', 'home'].includes(state.view)) render();
  }
  return { saved: savedTotal, failed: failedTotal, conflicts: conflictTotal, pulled };
}

async function pushOnce(recs, gens) {
  let saved = 0, failed = 0, conflicts = 0;
  for (let i = 0; i < Math.max(recs.length, gens.length); i += 50) {
    const batch = recs.slice(i, i + 50);
    const gbatch = gens.slice(i, i + 50);
    const sentRev = new Map(batch.map((a) => [a.attempt_id, a.rev]));
    const res = await callServer('sync', { records: batch.map(toServerRecord), generated: gbatch.map(toServerGenerated) }, 90000);
    // 서버가 "재조회로 확인한" 항목만 저장 완료 처리한다.
    for (const s of res.saved || []) {
      const a = state.attempts.get(s.attempt_id);
      if (!a) continue;
      a.synced_rev = Math.max(a.synced_rev || 0, Math.min(Number(s.rev) || 0, sentRev.get(s.attempt_id) || 0));
      a.last_synced_at = res.server_time;
      await db.put('attempts', a);
      saved++;
    }
    // 다른 기기가 먼저 고친 기록: 병합 후 다음 라운드에 다시 보낸다
    for (const c of res.conflicts || []) {
      const a = state.attempts.get(c.attempt_id);
      if (!a || !c.server) continue;
      const m = mergeConflict(a, c.server);
      state.attempts.set(m.attempt_id, m);
      await db.put('attempts', m);
      conflicts++;
    }
    for (const gid of res.saved_generated || []) {
      const g = state.generated.get(gid);
      if (g) { g.synced = true; await db.put('generated', g); }
    }
    failed += (res.failed || []).length;
  }
  return { saved, failed, conflicts };
}

/* ---------- 기기 간 동기화: 내려받기·병합 ---------- */
async function pullAll() {
  const out = { added: 0, updated: 0, conflicts: 0 };
  if (state.pullUnsupported === state.config.url) return out;
  const saved = await db.kvGet('pull_cursor', null);
  let cursor = saved && saved.url === state.config.url ? saved.cursor : '';
  for (let page = 0; page < 40; page++) {
    let res;
    try {
      res = await callServer('pull', { since: cursor, limit: 300 }, 90000);
    } catch (e) {
      if (e.code === 'unknown_action') {
        state.pullUnsupported = state.config.url;
        state.pullNote = '서버 코드가 1.2.0 이전 버전이라 다른 기기 기록을 받지 못했습니다. 서버를 업데이트하세요.';
        return out;
      }
      throw e;
    }
    state.pullNote = '';
    for (const g of res.generated || []) {
      if (!g || typeof g.id !== 'string' || state.generated.has(g.id)) continue;
      const item = { ...g, synced: true, generated_online: true };
      state.generated.set(item.id, item);
      await db.put('generated', item);
    }
    for (const s of res.attempts || []) await mergeFromServer(s, out);
    cursor = res.cursor || cursor;
    await db.kvSet('pull_cursor', { url: state.config.url, cursor });
    if (!res.more) break;
  }
  await db.kvSet('history', state.history);
  state.lastPull = nowIso();
  await db.kvSet('last_pull', state.lastPull);
  return out;
}

const SERVER_ONLY = ['server_saved_at', 'final_result', 'base_rev'];
function fromServerCopy(sv) {
  const o = { ...sv };
  SERVER_ONLY.forEach((k) => delete o[k]);
  const Rs = Number(sv.rev) || 0;
  if (o.ai_status === 'pending') o.ai_status = 'none';
  return { ...o, rev: Rs, synced_rev: Rs, last_synced_at: sv.server_saved_at || nowIso(), ai_error: '' };
}

async function mergeFromServer(sv, out) {
  if (!sv || typeof sv.attempt_id !== 'string' || !sv.answered_at) return;
  const L = state.attempts.get(sv.attempt_id);
  const Rs = Number(sv.rev) || 0;
  let next = null;
  if (!L) {
    next = fromServerCopy(sv); out.added++;
  } else {
    const unsent = needsSync(L) || (!L.answered_at && (L.submitted_answer || '').trim());
    if (!unsent) {
      if (Rs > (L.rev || 0)) { next = { ...L, ...fromServerCopy(sv) }; out.updated++; }
    } else if (Rs > (L.synced_rev || 0)) {
      next = mergeConflict(L, sv); out.conflicts++;   // 미전송 수정이 있는 기록을 다른 기기도 고쳤음
    }
  }
  if (!next) return;
  state.attempts.set(next.attempt_id, next);
  await db.put('attempts', next);
  const t = Date.parse(next.answered_at);
  if (t && (state.history[next.question_id] || 0) < t) state.history[next.question_id] = t;
}

// 같은 기록을 두 기기가 고친 경우의 병합 규칙
//  - 답안: 이 기기에서 확정한 답안을 덮어쓰지 않는다 (이 기기가 미확정일 때만 서버 답안 사용)
//  - 모범답안 열람: 더 이른 시각
//  - 자기 평가: 평가한 시각이 더 늦은 쪽 (평가 없음은 무시)
//  - AI 채점: 완료된 결과 우선, 둘 다 완료면 더 늦게 채점한 쪽
//  - rev는 양쪽보다 크게 올리고, 서버 rev를 기준(base)으로 다시 올린다
function mergeConflict(L, S) {
  const Rs = Number(S.rev) || 0;
  const m = { ...L };
  if (!L.answered_at && S.answered_at) {
    m.submitted_answer = S.submitted_answer; m.answered_at = S.answered_at; m.auto_check = S.auto_check;
  }
  const early = [L.model_viewed_at, S.model_viewed_at].filter(Boolean).sort()[0] || null;
  m.model_viewed_at = early;
  const assessed = (x) => x.self_assessment && x.self_assessment !== 'not_assessed';
  const at = (x) => x.self_assessed_at || x.updated_at || '';
  if (assessed(S) && (!assessed(L) || at(S) > at(L))) { m.self_assessment = S.self_assessment; m.self_assessed_at = S.self_assessed_at || S.updated_at; }
  if (S.ai_status === 'done' && (L.ai_status !== 'done' || (S.ai_graded_at || '') > (L.ai_graded_at || ''))) {
    Object.assign(m, { ai_status: 'done', ai_verdict: S.ai_verdict, ai_score: S.ai_score, ai_feedback: S.ai_feedback,
      ai_detail: S.ai_detail || null, ai_graded_at: S.ai_graded_at, ai_mode: S.ai_mode || '', ai_error: '' });
  }
  m.rev = Math.max(L.rev || 0, Rs) + 1;
  m.synced_rev = Rs;
  m.updated_at = nowIso();
  m.edited_by = state.deviceId;
  if (S.edited_by && S.edited_by !== state.deviceId) m.merge_note = { at: m.updated_at, other_device: S.edited_by, server_rev: Rs };
  return m;
}

function toServerRecord(a) {
  return {
    attempt_id: a.attempt_id, rev: a.rev, question_id: a.question_id, concept_id: a.concept_id, type: a.type,
    origin: a.origin, unit: a.unit, topic: a.topic, review_status: a.review_status,
    question_text: a.question_text, model_answer: a.model_answer, submitted_answer: a.submitted_answer,
    auto_check: a.auto_check, self_assessment: a.self_assessment, self_assessed_at: a.self_assessed_at || null,
    ai_status: a.ai_status === 'pending' ? 'none' : a.ai_status,
    ai_verdict: a.ai_verdict, ai_score: a.ai_score, ai_feedback: a.ai_feedback, ai_detail: a.ai_detail || null, ai_mode: a.ai_mode || '',
    source_pages: a.source_pages, answered_at: a.answered_at, model_viewed_at: a.model_viewed_at,
    ai_graded_at: a.ai_graded_at, created_at: a.created_at, updated_at: a.updated_at, device_id: a.device_id,
    edited_by: a.edited_by || a.device_id, session_id: a.session_id,
    base_rev: a.synced_rev || 0   // 이 기기가 마지막으로 확인한 서버 rev (수정 충돌 감지용)
  };
}
function toServerGenerated(g) {
  return { id: g.id, base_question_id: g.base_question_id, concept_id: g.concept_id, type: g.type, unit: g.unit, topic: g.topic,
    question: g.question, model_answer: g.model_answer, accepted_answers: g.accepted_answers, key_points: g.key_points,
    explanation: g.explanation, source: g.source, review_status: g.review_status, created_at: g.created_at,
    paired_question_id: g.paired_question_id, enabled: g.enabled, editorial_note: g.editorial_note, difficulty: g.difficulty,
    learning_action: g.learning_action, grading: g.grading, generated_online: true, generator_model: g.generator_model };
}

/* =====================================================================
 * 채점 동작
 * ===================================================================*/
async function submitShort(a, unknown = false) {
  const q = getQ(a.question_id);
  const input = document.getElementById('ans');
  a.submitted_answer = unknown ? '' : (input?.value ?? a.submitted_answer);
  const n = normalize(a.submitted_answer);
  const list = [q.model_answer, ...(q.accepted_answers || [])].map(normalize);
  a.auto_check = n && list.includes(n) ? 'alias_match' : 'no_match';
  a.answered_at = nowIso();
  if (unknown) { a.model_viewed_at = nowIso(); }
  if (a.auto_check === 'alias_match') a.model_viewed_at = a.model_viewed_at || nowIso();
  await saveAttempt(a);
  render();
}

async function viewModel(a) {
  const input = document.getElementById('ans');
  if (!a.answered_at) { a.submitted_answer = input?.value ?? a.submitted_answer; a.answered_at = nowIso(); if (a.type === 'short_answer' && !a.auto_check) a.auto_check = 'no_match'; }
  a.model_viewed_at = a.model_viewed_at || nowIso();
  await saveAttempt(a);
  render();
}

async function selfAssess(a, v) {
  a.self_assessment = v;
  a.self_assessed_at = nowIso();
  await saveAttempt(a);
  render();
}

async function aiGrade(a) {
  if (!isOnline()) { toast('AI 채점은 인터넷 연결이 필요합니다. 오프라인에서는 모범답안으로 자기 평가하세요.', 4000); return; }
  if (!serverReady()) { toast('설정 화면에서 Apps Script 연결을 먼저 해 주세요.', 4000); return; }
  const q = getQ(a.question_id);
  const input = document.getElementById('ans');
  if (!a.answered_at) {
    a.submitted_answer = input?.value ?? a.submitted_answer;
    if (!a.submitted_answer.trim()) { toast('답안을 먼저 작성하세요.'); return; }
    a.answered_at = nowIso();
    if (a.type === 'short_answer' && !a.auto_check) {
      const n = normalize(a.submitted_answer);
      a.auto_check = [q.model_answer, ...(q.accepted_answers || [])].map(normalize).includes(n) ? 'alias_match' : 'no_match';
    }
  }
  a.ai_status = 'pending'; a.ai_error = '';
  await saveAttempt(a, { bump: false });
  render();
  try {
    const res = await callServer('grade', {
      question: { id: q.id, type: q.type, question: q.question, model_answer: q.model_answer, accepted_answers: q.accepted_answers,
        key_points: q.key_points, explanation: q.explanation, topic: q.topic, grading_instructions: q.grading?.instructions },
      answer: a.submitted_answer
    }, 90000);
    const r = res.result;
    Object.assign(a, { ai_status: 'done', ai_verdict: r.verdict, ai_score: r.score, ai_feedback: r.feedback, ai_detail: r, ai_graded_at: r.graded_at || nowIso(), ai_mode: 'single' });
  } catch (e) {
    a.ai_status = 'error'; a.ai_error = e.message;
  }
  await saveAttempt(a);
  render();
}

/* ---------- 세트 일괄 처리: 전체 답안 제출·AI 일괄 채점 / 전체 모범답안 보기 ---------- */
function sessionEntries() {
  const s = state.session;
  if (!s) return [];
  return s.items.map((it, i) => ({ i, q: getQ(it.qid), a: state.attempts.get(it.aid) })).filter((x) => x.q && x.a);
}
const isEmptyDraft = (a) => !a.answered_at && !(a.submitted_answer || '').trim();
const aliasMatch = (q, ans) => { const n = normalize(ans); return !!n && [q.model_answer, ...(q.accepted_answers || [])].map(normalize).includes(n); };
const needsAi = (a) => a.answered_at && a.auto_check !== 'alias_match' && (a.submitted_answer || '').trim() && a.ai_status !== 'done' && a.ai_status !== 'pending';

async function finalizeDraft(q, a) {
  a.answered_at = nowIso();
  if (q.type === 'short_answer') {
    a.auto_check = aliasMatch(q, a.submitted_answer) ? 'alias_match' : 'no_match';
    if (a.auto_check === 'alias_match') a.model_viewed_at = a.model_viewed_at || nowIso();
  }
  await saveAttempt(a);
}

async function batchStart(mode, confirmed = false) {
  if (state.batch.running) return;
  await flushDraft();
  const entries = sessionEntries();
  const empties = entries.filter((x) => isEmptyDraft(x.a));
  const written = entries.filter((x) => !isEmptyDraft(x.a));
  if (!written.length) { toast('작성한 답안이 없습니다. 답을 쓴 뒤 다시 눌러 주세요.'); return; }
  if (mode === 'ai' && (!isOnline() || !serverReady())) { toast('AI 일괄 채점은 온라인 연결과 서버 설정이 필요합니다. 오프라인에서는 전체 모범답안 보기로 자기 평가하세요.', 4500); return; }
  // 새로 제출할 답안이 있을 때만 빈 답안을 확인한다 (실패 후 재시도처럼 이미 제출된 답안만 다시 채점할 때는 묻지 않음)
  const fresh = written.filter((x) => !x.a.answered_at);
  if (empties.length && fresh.length && !confirmed) { state.batch.confirm = { mode, empties: empties.map((x) => x.i) }; render(); return; }
  state.batch.confirm = null;
  // 빈 답안은 제출하지 않는다(오답 처리 없음). 작성한 답안만 확정한다.
  for (const { q, a } of written) if (!a.answered_at) await finalizeDraft(q, a);
  if (mode === 'model') {
    for (const { a } of written) if (!a.model_viewed_at) { a.model_viewed_at = nowIso(); await saveAttempt(a); }
    go('review');
    return;
  }
  await batchGrade();
}

async function batchGrade() {
  const targets = sessionEntries().filter((x) => needsAi(x.a));
  const local = sessionEntries().filter((x) => x.a.auto_check === 'alias_match').length;
  if (!targets.length) {
    toast(local ? `AI 채점할 문항이 없습니다. 허용 답안과 일치한 ${local}문항은 기기에서 정답 처리했습니다.` : 'AI 채점할 문항이 없습니다.', 4000);
    go('review'); return;
  }
  state.batch.running = true;
  const keyOf = new Map();
  const items = targets.map(({ q, a }) => {
    let key = q.id, n = 2;
    while ([...keyOf.values()].includes(key)) key = `${q.id}:${n++}`;
    keyOf.set(a.attempt_id, key);
    return { key, answer: a.submitted_answer, question: { id: q.id, type: q.type, question: q.question, model_answer: q.model_answer,
      accepted_answers: q.accepted_answers, key_points: q.key_points, explanation: q.explanation, topic: q.topic, grading_instructions: q.grading?.instructions } };
  });
  for (const { a } of targets) { a.ai_status = 'pending'; a.ai_error = ''; await saveAttempt(a, { bump: false }); }
  go('review');
  let ok = 0, miss = 0;
  try {
    const res = await callServer('grade_batch', { items }, 150000);
    for (const { a } of targets) {
      const r = res.results?.[keyOf.get(a.attempt_id)];
      if (r) {
        Object.assign(a, { ai_status: 'done', ai_verdict: r.verdict, ai_score: r.score, ai_feedback: r.feedback, ai_detail: { ...r, batch: true },
          ai_graded_at: r.graded_at || nowIso(), ai_mode: 'batch', ai_error: '' });
        ok++;
      } else {
        a.ai_status = 'error'; a.ai_error = '일괄 채점 응답에 이 문항 결과가 없었습니다. ‘AI 일괄 채점’을 다시 누르면 이 문항만 다시 요청합니다.'; miss++;
      }
      await saveAttempt(a);
    }
    toast(`AI 일괄 채점 완료: ${ok}문항${miss ? ` · 결과 누락 ${miss}문항(다시 시도 가능)` : ''}${local ? ` · 허용 답안 일치 ${local}문항은 기기에서 채점` : ''}`, 4500);
  } catch (e) {
    for (const { a } of targets) {
      a.ai_status = 'error';
      a.ai_error = `일괄 채점 실패: ${e.message} — 답안은 그대로 저장되어 있습니다. 다시 시도하면 채점되지 않은 문항만 다시 요청합니다.`;
      await saveAttempt(a);
    }
    toast('AI 일괄 채점 실패: ' + e.message, 5000);
  } finally {
    state.batch.running = false;
    render();
  }
}

async function makeSimilar(qid) {
  if (!isOnline() || !serverReady()) { toast('비슷한 새 문제 만들기는 온라인 연결과 서버 설정이 필요합니다.', 4000); return; }
  const base = getQ(qid);
  if (!base) return;
  state.busy['gen:' + qid] = true; render();
  try {
    const res = await callServer('generate', {
      question: { id: base.id, type: base.type, question: base.question, model_answer: base.model_answer,
        key_points: base.key_points, explanation: base.explanation, topic: base.topic }
    }, 90000);
    const g = res.question;
    const rootId = base.base_question_id || base.id;
    const item = {
      id: `G-${rootId}-${Date.now().toString(36)}${rid(3)}`,
      base_question_id: rootId, concept_id: base.concept_id, paired_question_id: null,
      unit: base.unit, topic: base.topic, type: g.type, question: g.question, model_answer: g.model_answer,
      accepted_answers: g.accepted_answers || [], key_points: g.key_points || [], explanation: g.explanation,
      source: { ...(base.source || {}), basis: 'ai_generated_from_question_bank', current_reference_verified: false },
      review_status: 'ai_generated_unverified', enabled: true, editorial_note: 'AI가 기준 문항에서 만든 변형 문제입니다. 검토 전이므로 원 문항과 함께 확인하세요.',
      difficulty: base.difficulty, learning_action: base.learning_action, grading: base.grading,
      generated_online: true, generator_model: g.model || '', created_at: nowIso(), synced: false
    };
    state.generated.set(item.id, item);
    await db.put('generated', item);
    state.lastGenerated = item.id;
    toast('새 문제를 만들었습니다. [생성문제]에서 다시 풀 수 있습니다.');
    scheduleSync();
  } catch (e) {
    toast('생성 실패: ' + e.message, 4500);
  } finally {
    delete state.busy['gen:' + qid];
    render();
  }
}

/* =====================================================================
 * 백업 내보내기·가져오기
 * ===================================================================*/
async function exportBackup() {
  const data = {
    format: 'firequiz-backup', format_version: 1, app_version: APP_VERSION, exported_at: nowIso(),
    device_id: state.deviceId, bank_created_date: state.meta?.created_date,
    attempts: [...state.attempts.values()], generated: [...state.generated.values()],
    history: state.history, session: state.session
  };
  const blob = new Blob([JSON.stringify(data, null, 1)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = `항공정비_풀이기록_${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
  toast(`기록 ${data.attempts.length}건을 내보냈습니다.`);
}

async function importBackup(file) {
  let data;
  try { data = JSON.parse(await file.text()); } catch { toast('JSON 파일을 읽지 못했습니다.'); return; }
  if (data.format !== 'firequiz-backup' || !Array.isArray(data.attempts)) { toast('이 앱의 백업 파일이 아닙니다.'); return; }
  let added = 0, updated = 0, gen = 0;
  for (const inc of data.attempts) {
    if (!inc || typeof inc.attempt_id !== 'string') continue;
    const cur = state.attempts.get(inc.attempt_id);
    if (!cur) { state.attempts.set(inc.attempt_id, inc); await db.put('attempts', inc); added++; }
    else if ((inc.rev || 0) > (cur.rev || 0)) {
      const merged = { ...inc, synced_rev: Math.min(cur.synced_rev || 0, inc.rev || 0) };
      state.attempts.set(inc.attempt_id, merged); await db.put('attempts', merged); updated++;
    }
  }
  for (const g of data.generated || []) {
    if (g && g.id && !state.generated.has(g.id)) { state.generated.set(g.id, g); await db.put('generated', g); gen++; }
  }
  for (const [k, v] of Object.entries(data.history || {})) state.history[k] = Math.max(state.history[k] || 0, v);
  await db.kvSet('history', state.history);
  toast(`가져오기 완료: 새 기록 ${added}건, 갱신 ${updated}건, 생성문제 ${gen}건`, 4000);
  render(); scheduleSync();
}

/* =====================================================================
 * 화면 그리기
 * ===================================================================*/
function go(view) { state.view = view; render(); window.scrollTo({ top: 0 }); }

function render() {
  document.querySelectorAll('.tabs button').forEach((b) => b.setAttribute('aria-current', b.dataset.view === state.view || (state.view === 'quiz' && b.dataset.view === 'home') || (['summary', 'review'].includes(state.view) && b.dataset.view === 'home') ? 'page' : 'false'));
  const v = { home: viewHome, quiz: viewQuiz, review: viewReview, summary: viewSummary, wrong: viewWrong, records: viewRecords, settings: viewSettings }[state.view] || viewHome;
  $app.innerHTML = v();
  renderStatus();
}

function renderStatus() {
  const o = state.offline;
  const off = !o.checked ? `<span class="chip"><span class="spin"></span> 오프라인 준비 확인 중</span>`
    : o.ready ? `<span class="chip ok">✓ 오프라인 준비 완료</span>`
      : `<span class="chip warn">오프라인 준비 중 (${o.missing.length ? '파일 ' + o.missing.length + '개 남음' : '앱을 한 번 더 열어 주세요'})</span>`;
  const net = isOnline() ? `<span class="chip info">온라인</span>` : `<span class="chip">오프라인</span>`;
  const p = pendingCount();
  const sync = state.syncing ? `<span class="chip info"><span class="spin"></span> 동기화 중</span>`
    : !serverReady() ? `<span class="chip">서버 미설정 · 기록은 기기에 저장됨</span>`
      : p ? `<span class="chip warn">미전송 ${p}건</span>` : `<span class="chip ok">모두 저장됨${state.lastSync ? ' · ' + fmtTime(state.lastSync) : ''}</span>`;
  const err = state.lastSyncError && p ? `<span class="chip bad" title="${esc(state.lastSyncError)}">전송 실패 · 기록 보관 중</span>` : '';
  $status.innerHTML = `${off}${net}${sync}${err}<span class="spacer"></span>
    <button class="btn small" data-action="sync" ${state.syncing || !serverReady() ? 'disabled' : ''}>지금 동기화</button>`;
}

function badgesFor(q) {
  const b = [`<span class="badge type">${TYPE_LABEL[q.type]}</span>`, `<span class="badge">${esc(q.unit)}</span>`, `<span class="badge">${esc(q.topic)}</span>`];
  if (q.review_status === 'pdf_basis_reference_check') b.push(`<span class="badge check" title="현행 법령·기준과 대조가 필요한 문항">PDF 기준 · 현행 대조 필요</span>`);
  if (q.review_status === 'ai_generated_unverified') b.push(`<span class="badge gen">AI 생성 · 검토 전</span>`);
  if (q.difficulty) b.push(`<span class="badge">${esc(q.difficulty)}</span>`);
  return `<div class="badges">${b.join('')}</div>`;
}

function sourceLine(q) {
  const pages = (q.source?.pdf_pages || []).join(', ');
  const ver = q.source?.current_reference_verified ? '현행 자료 대조 완료' : '현행 자료 대조 전';
  const status = q.review_status === 'pdf_basis_reference_check' ? ' · PDF 기준 답안 (현행 법령·승인 기준과 대조 필요)'
    : q.review_status === 'ai_generated_unverified' ? ` · AI 생성 문제 (기준 문항 ${esc(q.base_question_id)})` : '';
  return `<div class="src">근거: ${esc(q.source?.file_name || '소방.PDF')} ${pages ? pages + '쪽' : ''} · ${esc(q.source?.section || q.topic)} · ${ver}${status} · 문항 ID ${esc(q.id)}</div>
    ${q.editorial_note ? `<div class="src">편집 메모: ${esc(q.editorial_note)}</div>` : ''}`;
}

/* ---------- 홈 ---------- */
function viewHome() {
  const f = state.filters;
  const counts = {};
  state.bank.forEach((q) => { if (f.type === 'both' || q.type === f.type) counts[q.unit] = (counts[q.unit] || 0) + 1; });
  const pool = buildPool(f.source);
  const concepts = new Set(pool.map((q) => q.concept_id)).size;
  const attempts = [...state.attempts.values()].filter((a) => a.answered_at);
  const wrongs = wrongNotes().filter((w) => !w.resolved).length;
  const s = state.session;
  const resume = s && !s.finished ? `<div class="card"><div class="row between"><div><h2>풀던 세트가 있습니다</h2>
      <div class="sub">${s.items.length}문항 중 ${s.index + 1}번째 · ${fmtTime(s.created_at)} 시작</div></div>
      <div class="row"><button class="btn" data-action="discard-session">새로 시작</button><button class="btn primary" data-action="go" data-view="quiz">이어서 풀기</button></div></div></div>` : '';
  const seg = (name, opts, cur) => `<div class="seg" role="group">${opts.map(([v, l]) => `<button data-action="filter" data-key="${name}" data-v="${v}" aria-pressed="${cur === v}">${l}</button>`).join('')}</div>`;
  return `${resume}
  <div class="card">
    <h1>5문제씩 풀기</h1>
    <h3>문제 유형</h3>
    ${seg('type', [['both', '단답형 + 서술형'], ['short_answer', '단답형'], ['essay', '서술형']], f.type)}
    <h3 style="margin-top:18px">출제 범위</h3>
    ${seg('source', [['bank', '문제은행'], ['wrong', `오답 다시 풀기 (${wrongs})`], ['generated', `AI 생성문제 (${state.generated.size})`]], f.source)}
    <div class="row between" style="margin-top:18px"><h3 style="margin:0">단원 선택</h3>
      <div class="row"><button class="btn small ghost" data-action="units-all">전체 선택</button><button class="btn small ghost" data-action="units-none">전체 해제</button></div></div>
    <div class="units" style="margin-top:8px">${state.units.map((u) => `<label class="unit ${f.units.includes(u) ? 'checked' : ''}">
      <input type="checkbox" data-unit="${esc(u)}" ${f.units.includes(u) ? 'checked' : ''}><span>${esc(u)}</span><span class="n">${counts[u] || 0}</span></label>`).join('')}</div>
    <div class="row between" style="margin-top:18px">
      <div class="sub">선택 범위: ${pool.length}문항 · 개념 ${concepts}개${concepts && concepts < SET_SIZE ? ` (이번 세트는 ${concepts}문항)` : ''}</div>
      <button class="btn primary" data-action="start" ${pool.length ? '' : 'disabled'}>5문제 시작</button>
    </div>
  </div>
  <div class="card"><h2>학습 현황</h2><div class="stat">
    <div><b>${attempts.length}</b><span>푼 횟수</span></div>
    <div><b>${new Set(attempts.map((a) => a.question_id)).size}</b><span>푼 문항</span></div>
    <div><b>${wrongs}</b><span>남은 오답</span></div>
    <div><b>${state.bank.length}</b><span>문제은행</span></div></div>
    <p class="sub" style="margin-bottom:0">문제은행 ${esc(state.meta?.title)} · ${esc(state.meta?.created_date)} · 법규 등 ${state.meta?.reference_check_question_count ?? ''}문항은 PDF 기준 표시가 붙습니다.</p>
  </div>`;
}

/* ---------- 문제 풀기 ---------- */
function viewQuiz() {
  const s = state.session;
  if (!s) return `<div class="card"><p>진행 중인 세트가 없습니다.</p><button class="btn primary" data-action="go" data-view="home">세트 고르기</button></div>`;
  const it = s.items[s.index];
  const q = getQ(it.qid), a = state.attempts.get(it.aid);
  if (!q || !a) return `<div class="card"><p>문항을 찾을 수 없습니다.</p><button class="btn" data-action="discard-session">세트 종료</button></div>`;
  const locked = !!a.answered_at;
  const prog = s.items.map((x, i) => { const aa = state.attempts.get(x.aid); return `<span class="${i === s.index ? 'cur' : aa?.answered_at ? 'done' : ''}"></span>`; }).join('');
  const isShort = q.type === 'short_answer';
  const online = isOnline() && serverReady();

  let body = '';
  if (isShort) {
    body += `<div class="answer"><input id="ans" type="text" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="답을 입력하세요" value="${esc(a.submitted_answer)}" ${locked ? 'readonly' : ''} enterkeyhint="done"></div>`;
    if (!locked) {
      body += `<div class="row" style="margin-top:12px"><button class="btn primary" data-action="submit-short">제출</button>
        <button class="btn" data-action="unknown">모르겠음 · 모범답안 보기</button></div>`;
    } else if (a.auto_check === 'alias_match') {
      body += `<div class="panel ok"><h3>✓ 정답 — 등록된 허용 답안과 일치</h3></div>`;
    } else {
      body += `<div class="panel warn"><h3>허용 답안 목록과 일치하지 않습니다</h3>
        <div>아직 오답으로 처리하지 않았습니다. 모범답안과 비교해 직접 평가하거나 AI 채점을 받아 보세요.</div>
        <div class="row" style="margin-top:10px">
          ${a.model_viewed_at ? '' : `<button class="btn" data-action="view-model" data-aid="${esc(a.attempt_id)}">모범답안 보기</button>`}
          ${aiButton(a, online)}</div></div>`;
    }
  } else {
    body += `<div class="answer"><textarea id="ans" placeholder="핵심 내용을 문장으로 설명하세요" ${locked && a.model_viewed_at ? 'readonly' : locked ? 'readonly' : ''}>${esc(a.submitted_answer)}</textarea></div>
      <div class="row" style="margin-top:12px">
        ${a.model_viewed_at ? '' : `<button class="btn dark" data-action="view-model" data-aid="${esc(a.attempt_id)}">모범답안 보기</button>`}
        ${aiButton(a, online)}
      </div>
      ${!locked ? `<div class="sub" style="margin-top:6px">모범답안을 보거나 AI 채점을 요청하면 답안이 확정됩니다.</div>` : ''}`;
  }

  if (a.model_viewed_at) body += modelPanel(q) + assessPanel(a);
  body += aiPanel(a);

  if (locked) {
    const busy = state.busy['gen:' + q.id];
    body += `<div class="row" style="margin-top:14px"><button class="btn small" data-action="similar" data-qid="${esc(q.id)}" ${online && !busy ? '' : 'disabled'}>${busy ? '<span class="spin"></span> 만드는 중' : '비슷한 새 문제 만들기'}${needLabel()}</button>
      ${state.lastGenerated && state.generated.get(state.lastGenerated)?.base_question_id === (q.base_question_id || q.id) ? `<button class="btn small" data-action="solve-generated" data-id="${esc(state.lastGenerated)}">방금 만든 문제 풀기</button>` : ''}</div>`;
  }

  const last = s.index === s.items.length - 1;
  return `<div class="card">
    <div class="row between"><div class="sub">${s.index + 1} / ${s.items.length}${s.source === 'wrong' ? ' · 오답 다시 풀기' : s.source === 'generated' ? ' · AI 생성문제' : ''}</div>
      <button class="btn small ghost" data-action="go" data-view="home">나가기 (저장됨)</button></div>
    <div class="progress">${prog}</div>
    ${badgesFor(q)}
    <p class="qtext">${esc(q.question)}</p>
    ${body}
    <div class="quiznav">
      <button class="btn" data-action="prev" ${s.index === 0 ? 'disabled' : ''}>← 이전</button>
      ${last ? `<button class="btn primary" data-action="finish">결과 보기</button>` : `<button class="btn primary" data-action="next">다음 →</button>`}
    </div></div>
    ${s.items.length > 1 ? batchBar() : ''}`;
}

function modelPanel(q) {
  const isShort = q.type === 'short_answer';
  return `<div class="panel"><h3>모범답안</h3><div>${esc(q.model_answer)}</div>
      ${isShort && q.accepted_answers?.length ? `<div class="label">허용 표현</div><div>${q.accepted_answers.map(esc).join(' · ')}</div>` : ''}
      ${!isShort && q.key_points?.length ? `<div class="label">채점 핵심 내용 (의미 기준)</div><ul>${q.key_points.map((k) => `<li>${esc(k)}</li>`).join('')}</ul>` : ''}
      ${q.explanation && q.explanation !== q.model_answer ? `<div class="label">해설</div><div>${esc(q.explanation)}</div>` : ''}
      ${sourceLine(q)}</div>`;
}

function assessPanel(a) {
  if (a.auto_check === 'alias_match') return '';
  return `<div class="panel"><h3>내 자기 평가</h3><div class="sub">AI 채점과 별도로 저장됩니다.</div>
        <div class="assess">${['correct', 'needs_review', 'incorrect'].map((v) => `<button data-action="assess" data-aid="${esc(a.attempt_id)}" data-v="${v}" aria-pressed="${a.self_assessment === v}">${SELF_LABEL[v]}</button>`).join('')}</div></div>`;
}

/* ---------- 세트 전체 도구 (문제 화면·전체 검토 화면 공통) ---------- */
function batchBar() {
  const entries = sessionEntries();
  const online = isOnline() && serverReady();
  const written = entries.filter((x) => !isEmptyDraft(x.a)).length;
  const aiLeft = entries.filter((x) => needsAi(x.a) || (!x.a.answered_at && !isEmptyDraft(x.a) && !(x.q.type === 'short_answer' && aliasMatch(x.q, x.a.submitted_answer)))).length;
  const errs = entries.filter((x) => x.a.ai_status === 'error').length;
  const running = state.batch.running;
  const c = state.batch.confirm;
  const confirm = c ? `<div class="panel warn" id="batch-confirm"><h3>빈 답안 ${c.empties.length}문항: ${c.empties.map((i) => i + 1 + '번').join(', ')}</h3>
      <div>빈 문항은 제출하지 않고 그대로 둡니다. <b>오답으로 처리하지 않으며</b>, 나중에 답을 쓰거나 문제별로 처리할 수 있습니다.</div>
      <div class="row" style="margin-top:10px">
        <button class="btn" data-action="jump" data-i="${c.empties[0]}">${c.empties[0] + 1}번 작성하러 가기</button>
        <button class="btn primary" data-action="batch-confirm">빈 문항 빼고 ${c.mode === 'ai' ? '제출·채점' : '모범답안 보기'}</button>
        <button class="btn ghost" data-action="batch-cancel">취소</button></div></div>` : '';
  return `<div class="card batchbar" id="batch-bar"><div class="row between"><h2 style="margin:0">세트 전체</h2>
      <div class="sub">작성 ${written}/${entries.length}${errs ? ` · 채점 실패 ${errs}문항` : ''}</div></div>
    <div class="row" style="margin-top:10px">
      <button class="btn primary" data-action="batch-ai" ${online && !running && aiLeft ? '' : 'disabled'}>${running ? '<span class="spin"></span> AI 일괄 채점 중…' : errs ? 'AI 일괄 채점 다시 시도' : aiLeft ? '전체 답안 제출 · AI 일괄 채점' : '✓ AI 채점할 문항 없음'}${aiLeft ? needLabel() : ''}</button>
      <button class="btn dark" data-action="batch-model" ${running ? 'disabled' : ''}>전체 모범답안 보기</button>
      ${state.view !== 'review' ? `<button class="btn ghost" data-action="go" data-view="review">전체 검토</button>` : `<button class="btn ghost" data-action="go" data-view="quiz">문제 화면으로</button>`}
    </div>
    <div class="sub" style="margin-top:6px">${aiLeft ? `허용 답안과 일치한 단답형은 기기에서 바로 채점하고, 나머지 ${aiLeft}문항만 한 번의 AI 요청으로 채점합니다. 제출하면 답안이 확정됩니다.` : '작성한 답안은 모두 채점되었거나 허용 답안과 일치했습니다. 빈 문항에 답을 쓰면 다시 일괄 채점할 수 있습니다.'}${online ? '' : ' 오프라인에서는 전체 모범답안을 보고 문제별로 자기 평가하세요.'}</div>
    ${confirm}</div>`;
}

/* ---------- 세트 전체 검토 ---------- */
function viewReview() {
  const s = state.session;
  if (!s) return viewHome();
  const online = isOnline() && serverReady();
  const cards = sessionEntries().map(({ i, q, a }) => {
    let body;
    if (!a.answered_at) {
      body = `<div class="panel">${isEmptyDraft(a) ? '답안 미작성 — 제출하지 않았고 오답으로 처리하지 않았습니다.' : `작성 중(미제출): ${esc(a.submitted_answer)}`}
        <div class="row" style="margin-top:8px"><button class="btn small" data-action="jump" data-i="${i}">이 문제 풀기</button></div></div>`;
    } else {
      body = `<div class="label">내 답</div><div class="myans">${esc(a.submitted_answer || '(모르겠음)')}</div>`;
      if (a.auto_check === 'alias_match') body += `<div class="panel ok"><h3>✓ 정답 — 등록된 허용 답안과 일치 (기기에서 채점)</h3></div>`;
      if (a.model_viewed_at) body += modelPanel(q) + assessPanel(a);
      body += aiPanel(a);
      const btns = [];
      if (!a.model_viewed_at) btns.push(`<button class="btn small" data-action="view-model" data-aid="${esc(a.attempt_id)}">모범답안 보기</button>`);
      if (a.auto_check !== 'alias_match' && (a.submitted_answer || '').trim()) { const b = aiButton(a, online); if (b) btns.push(b.replace('class="btn"', 'class="btn small"')); }
      if (btns.length) body += `<div class="row" style="margin-top:10px">${btns.join('')}</div>`;
    }
    return `<div class="card review-item" data-qid="${esc(q.id)}"><div class="row between"><div class="sub">${i + 1}번 · 문항 ID ${esc(q.id)}</div>
      <span class="res ${finalResult(a)}">${RESULT_LABEL[finalResult(a)]}</span></div>
      ${badgesFor(q)}<p class="qtext" style="font-size:18px">${esc(q.question)}</p>${body}</div>`;
  }).join('');
  return `<div class="card"><div class="row between"><h1 style="margin:0">세트 전체 검토</h1>
      <div class="row"><button class="btn" data-action="go" data-view="quiz">문제 화면</button><button class="btn primary" data-action="finish">결과 보기</button></div></div>
    <p class="sub">문제별 판정·피드백과 자기 평가는 각 풀이 기록에 따로 저장됩니다. AI 결과와 자기 평가는 서로 덮어쓰지 않습니다.</p></div>
    ${batchBar()}${cards}`;
}

function aiButton(a, online) {
  if (a.ai_status === 'done') return '';
  if (a.ai_status === 'pending') return `<button class="btn" disabled><span class="spin"></span> AI 채점 중…</button>`;
  return `<button class="btn" data-action="ai" data-aid="${esc(a.attempt_id)}" ${online && !state.batch.running ? '' : 'disabled'}>AI 채점하기${needLabel()}</button>`;
}

function aiPanel(a) {
  if (a.ai_status === 'error') return `<div class="panel bad"><h3>AI 채점 실패</h3><div>${esc(a.ai_error)}</div><div class="sub">답안과 자기 평가는 그대로 저장되어 있습니다.</div></div>`;
  if (a.ai_status !== 'done') return '';
  const d = a.ai_detail || {};
  const cls = { correct: 'ok', partial: 'warn', incorrect: 'bad', undetermined: 'info' }[a.ai_verdict] || 'info';
  const list = (t, arr) => arr?.length ? `<div class="label">${t}</div><ul>${arr.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : '';
  return `<div class="panel ${cls}"><h3>AI 채점 결과: ${AI_LABEL[a.ai_verdict] || a.ai_verdict} · ${esc(a.ai_score)}점</h3>
    <div>${esc(a.ai_feedback)}</div>${list('충족한 내용', d.matched_points)}${list('누락된 내용', d.missing_points)}${list('오류', d.errors)}
    <div class="src">자기 평가와 별도로 저장 · ${a.ai_mode === 'batch' ? '세트 일괄 채점' : '개별 채점'} · ${fmtTime(a.ai_graded_at)}${d.model ? ' · ' + esc(d.model) : ''}${a.edited_by && a.edited_by !== state.deviceId ? ' · 다른 기기에서 채점' : ''}</div></div>`;
}

/* ---------- 세트 결과 ---------- */
function viewSummary() {
  const s = state.session;
  if (!s) return viewHome();
  const rows = s.items.map((it, i) => {
    const q = getQ(it.qid), a = state.attempts.get(it.aid);
    const r = finalResult(a);
    return `<div class="item"><div class="row between"><div class="q">${i + 1}. ${esc(q?.question)}</div><span class="res ${r}">${RESULT_LABEL[r]}</span></div>
      <div class="meta">${TYPE_LABEL[q?.type]} · 내 답: ${esc(a?.submitted_answer || '(없음)')}</div>
      <div class="meta">자동 확인: ${a?.auto_check === 'alias_match' ? '허용답안 일치' : a?.type === 'short_answer' ? '불일치(판단 보류)' : '-'} · 자기 평가: ${SELF_LABEL[a?.self_assessment] || '-'} · AI: ${a?.ai_status === 'done' ? AI_LABEL[a.ai_verdict] : '-'}</div>
      <button class="btn small ghost" data-action="jump" data-i="${i}">다시 보기</button></div>`;
  }).join('');
  return `<div class="card"><h1>세트 결과</h1><div class="list">${rows}</div>
    <p class="sub">‘판단 대기’는 아직 자기 평가나 AI 채점을 하지 않은 문항입니다. 다시 보기에서 평가할 수 있습니다.</p>
    <div class="row end"><button class="btn" data-action="go" data-view="review">전체 검토</button><button class="btn" data-action="go" data-view="wrong">오답노트</button><button class="btn primary" data-action="start">새 5문제</button></div></div>`;
}

/* ---------- 오답노트 ---------- */
function viewWrong() {
  const notes = wrongNotes();
  const shown = notes.filter((n) => state.showResolved || !n.resolved);
  const online = isOnline() && serverReady();
  const active = notes.filter((n) => !n.resolved).length;
  const items = shown.map((n) => {
    const q = getQ(n.question_id);
    if (!q) return '';
    const busy = state.busy['gen:' + q.id];
    return `<div class="item">${badgesFor(q)}<div class="q">${esc(q.question)}</div>
      <div class="meta">최근 답: ${esc(n.last.submitted_answer || '(없음)')}${n.last.device_id !== state.deviceId ? ' <span class="badge">다른 기기</span>' : ''} · 최근 결과 <span class="res ${finalResult(n.last)}">${RESULT_LABEL[finalResult(n.last)]}</span> · 오답 ${n.wrong_count}회 / 풀이 ${n.attempt_count}회 · ${fmtTime(n.last_wrong_at)}</div>
      <details style="margin-top:6px"><summary>모범답안</summary><div>${esc(q.model_answer)}</div>${sourceLine(q)}</details>
      <div class="row" style="margin-top:8px"><button class="btn small" data-action="retry-one" data-qid="${esc(q.id)}">이 문제 다시 풀기</button>
      <button class="btn small" data-action="similar" data-qid="${esc(q.id)}" ${online && !busy ? '' : 'disabled'}>${busy ? '<span class="spin"></span> 만드는 중' : '비슷한 새 문제 만들기'}${needLabel()}</button></div></div>`;
  }).join('');
  return `<div class="card"><div class="row between"><h1 style="margin:0">오답노트</h1>
      <button class="btn primary" data-action="retry-wrong" ${active ? '' : 'disabled'}>오답 5문제 다시 풀기</button></div>
    <p class="sub">자기 평가 ‘틀림·보완 필요’ 또는 AI 판정 ‘오답·부분정답’이 한 번이라도 있던 문항입니다. 가장 최근 풀이가 정답이면 ‘해결됨’으로 바뀝니다.<br>${syncInfoLine()}</p>
    <label class="row"><input type="checkbox" data-toggle="resolved" ${state.showResolved ? 'checked' : ''}> 해결된 문항도 보기</label></div>
    <div class="list">${items || `<div class="item">${state.showResolved ? '오답 기록이 없습니다.' : '남은 오답이 없습니다.'}</div>`}</div>`;
}

/* ---------- 기록 ---------- */
function viewRecords() {
  const list = [...state.attempts.values()].filter((a) => a.answered_at).sort((x, y) => (x.answered_at < y.answered_at ? 1 : -1));
  const p = list.filter(needsSync).length;
  const items = list.slice(0, 150).map((a) => {
    const r = finalResult(a);
    const other = a.device_id && a.device_id !== state.deviceId;
    return `<div class="item${other ? ' other' : ''}"><div class="row between"><div class="q">${esc(a.question_text)}</div><span class="res ${r}">${RESULT_LABEL[r]}</span></div>
      <div class="meta">${other ? '<span class="badge">다른 기기</span> ' : ''}${fmtTime(a.answered_at)} · ${TYPE_LABEL[a.type]} · 내 답: ${esc(a.submitted_answer || '(없음)')}</div>
      ${a.merge_note ? `<div class="meta">⚠ 다른 기기에서도 수정된 기록이라 병합했습니다 (${fmtTime(a.merge_note.at)})</div>` : ''}
      <div class="meta">자기 평가: ${SELF_LABEL[a.self_assessment]} · AI: ${a.ai_status === 'done' ? AI_LABEL[a.ai_verdict] + ' ' + a.ai_score + '점' : a.ai_status === 'error' ? '실패' : '-'} ·
      ${needsSync(a) ? '<b>미전송</b>' : '서버 저장 확인 ' + fmtTime(a.last_synced_at)}</div></div>`;
  }).join('');
  const others = list.filter((a) => a.device_id && a.device_id !== state.deviceId).length;
  return `<div class="card"><div class="row between"><h1 style="margin:0">풀이 기록</h1>
    <button class="btn" data-action="sync" ${state.syncing || !serverReady() ? 'disabled' : ''}>수동 동기화</button></div>
    <p class="sub">전체 ${list.length}건 (이 기기 ${list.length - others} · 다른 기기 ${others}) · 미전송 ${p}건 ${state.lastSyncError ? '· 최근 오류: ' + esc(state.lastSyncError) : ''}<br>
    ${syncInfoLine()}<br>
    서버가 저장 후 다시 읽어 확인한 기록만 ‘저장 확인’으로 표시합니다. 실패한 기록은 기기에 남아 다음 동기화 때 다시 보내며, 서버는 같은 기록 ID를 한 줄로만 유지합니다.</p></div>
    <div class="list">${items || '<div class="item">아직 기록이 없습니다.</div>'}</div>`;
}

function syncInfoLine() {
  if (!serverReady()) return '기기 간 동기화: 설정에서 서버를 연결하면 같은 URL·토큰을 쓰는 다른 기기의 기록도 함께 보입니다.';
  if (state.pullNote) return '기기 간 동기화: ' + esc(state.pullNote);
  const when = state.lastPull ? fmtTime(state.lastPull) : '아직 받지 않음';
  return isOnline() ? `기기 간 동기화: 마지막으로 받은 시각 ${when}`
    : `오프라인 — 마지막 동기화(${when})까지 받은 기록을 보여 줍니다. 인터넷이 연결되면 자동으로 다시 받습니다.`;
}

/* ---------- 설정 ---------- */
function viewSettings() {
  const o = state.offline;
  return `<div class="card"><h1>서버 연결 (Apps Script)</h1>
    <label class="field"><span>웹 앱 URL</span><input id="cfg-url" type="url" placeholder="https://script.google.com/macros/s/…/exec" value="${esc(state.config.url)}"></label>
    <label class="field"><span>앱 토큰 (APP_TOKEN)</span><input id="cfg-token" type="password" autocomplete="off" value="${esc(state.config.token)}"></label>
    <div class="row"><button class="btn primary" data-action="save-config">저장</button><button class="btn" data-action="ping">연결 확인</button></div>
    <div id="ping-result" class="sub" style="margin-top:8px">${esc(state.pingResult || '')}</div></div>

  <div class="card"><h2>실제 서버 연결 진단</h2>
    <p class="sub">이 기기(설치된 앱)에서 실제 Apps Script로 POST를 보내고 JSON 응답을 읽은 뒤, 임시 진단 기록 1건으로 저장 → 같은 기록 재전송 → 수정본 전송을 차례로 실행해 스프레드시트에 <b>한 줄만</b> 남는지 서버에 다시 물어 확인합니다. 끝나면 진단 기록(attempt_id가 diag-로 시작)을 지웁니다. 내 풀이 기록에는 영향이 없습니다.</p>
    <button class="btn dark" data-action="diagnose" ${state.diagRunning || !serverReady() || !isOnline() ? 'disabled' : ''}>${state.diagRunning ? '<span class="spin"></span> 진단 중…' : '진단 실행'}${needLabel()}</button>
    ${state.diag ? `<ul id="diag-result" class="diag">${state.diag.steps.map((d) => `<li class="${d.ok === true ? 'ok' : d.ok === false ? 'bad' : ''}"><b>${d.ok === true ? '✓' : d.ok === false ? '✗' : '·'} ${esc(d.name)}</b><div class="sub">${esc(d.detail)}</div></li>`).join('')}</ul>
      <p id="diag-summary"><b>${state.diag.done ? (state.diag.steps.every((d) => d.ok !== false) ? '결과: 모두 통과' : '결과: 실패 항목 있음') : ''}</b></p>
      <button class="btn small" data-action="copy-diag">결과 복사</button>` : ''}</div>

  <div class="card"><h2>오프라인 준비 상태</h2>
    <p>${o.ready ? '✓ 오프라인 준비 완료 — 화면, 문제은행 500문항, 모범답안이 이 기기에 저장되었습니다. 비행기 모드에서 앱을 닫았다 다시 열어도 풀 수 있습니다.' : '준비 중입니다. 인터넷에 연결된 상태로 앱을 열어 두면 자동으로 내려받습니다.'}</p>
    <div class="sub">앱 버전 ${esc(APP_VERSION)} · 서비스 워커 제어 ${o.controlled ? '예' : '아니오'} · 저장공간 영구 보존 ${o.persisted === null ? '확인 불가' : o.persisted ? '허용됨' : '미허용(크롬이 자동 결정)'}${o.missing.length ? '<br>남은 파일: ' + o.missing.map(esc).join(', ') : ''}</div>
    <div class="row" style="margin-top:10px"><button class="btn small" data-action="recheck">다시 확인</button><button class="btn small" data-action="check-update" ${isOnline() ? '' : 'disabled'}>앱 업데이트 확인</button></div></div>

  <div class="card"><h2>기록 백업</h2>
    <p class="sub">풀이 기록·자기 평가·AI 채점·생성문제를 JSON 파일로 저장하거나 다시 불러옵니다. 가져오기는 기존 기록을 지우지 않고 합칩니다.</p>
    <div class="row"><button class="btn" data-action="export">기록 내보내기</button><button class="btn" data-action="import">기록 가져오기</button></div></div>

  <div class="card"><h2>문제은행 정보</h2>
    <p class="sub">${esc(state.meta?.title)} · 스키마 ${esc(state.meta?.schema_version)} · ${esc(state.meta?.created_date)} · 문항 ${state.bank.length}개<br>${esc(state.meta?.scope)}<br>${esc(state.meta?.content_status)}</p>
    <details><summary>원문 검토사항 ${state.issues.length}건</summary>
    <table class="issues"><tr><th>쪽</th><th>항목</th><th>처리</th></tr>${state.issues.map((i) => `<tr><td>${esc(i.pdf_page)}</td><td>${esc(i.topic)}<div class="sub">${esc(i.issue)}</div></td><td>${esc(i.handling)}</td></tr>`).join('')}</table></details>
    <div class="sub" style="margin-top:8px">기기 ID ${esc(state.deviceId)}</div></div>`;
}

/* =====================================================================
 * 이벤트
 * ===================================================================*/
let draftTimer = null;
function onInput(e) {
  if (e.target.id === 'ans' && state.view === 'quiz') {
    const it = state.session.items[state.session.index];
    const a = state.attempts.get(it.aid);
    if (!a || a.answered_at) return;
    a.submitted_answer = e.target.value;
    clearTimeout(draftTimer);
    draftTimer = setTimeout(() => saveAttempt(a, { bump: false }), 400); // 작성 중 답안도 기기에 계속 저장
  }
}

async function onChange(e) {
  const t = e.target;
  if (t.dataset.unit) {
    const u = t.dataset.unit;
    const set = new Set(state.filters.units);
    t.checked ? set.add(u) : set.delete(u);
    state.filters.units = state.units.filter((x) => set.has(x));
    await db.kvSet('filters', state.filters); render();
  } else if (t.dataset.toggle === 'resolved') {
    state.showResolved = t.checked; render();
  } else if (t.id === 'import-file' && t.files[0]) {
    await importBackup(t.files[0]); t.value = '';
  }
}

async function onClick(e) {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  const act = el.dataset.action;
  const cur = () => {
    if (el.dataset.aid) return state.attempts.get(el.dataset.aid);   // 전체 검토 화면: 문항별 버튼
    const it = state.session?.items[state.session.index]; return it && state.attempts.get(it.aid);
  };
  switch (act) {
    case 'go': if (el.dataset.view === 'quiz' && !state.session) return go('home'); go(el.dataset.view); break;
    case 'filter': state.filters[el.dataset.key] = el.dataset.v; await db.kvSet('filters', state.filters); render(); break;
    case 'units-all': state.filters.units = [...state.units]; await db.kvSet('filters', state.filters); render(); break;
    case 'units-none': state.filters.units = []; await db.kvSet('filters', state.filters); render(); break;
    case 'start': await startSession(pickSet(buildPool(state.filters.source)), state.filters.source); break;
    case 'discard-session': if (state.session) { state.session.finished = true; await db.kvSet('session', state.session); } state.session = null; go('home'); break;
    case 'submit-short': await submitShort(cur()); break;
    case 'unknown': await submitShort(cur(), true); break;
    case 'view-model': { const a = cur(); if (a) await viewModel(a); break; }
    case 'assess': { const a = cur(); if (a) await selfAssess(a, el.dataset.v); break; }
    case 'ai': { const a = cur(); if (a) await aiGrade(a); break; }
    case 'batch-ai': await batchStart('ai'); break;
    case 'batch-model': await batchStart('model'); break;
    case 'batch-confirm': { const c = state.batch.confirm; if (c) await batchStart(c.mode, true); break; }
    case 'batch-cancel': state.batch.confirm = null; render(); break;
    case 'prev': state.batch.confirm = null; await flushDraft(); await setIndex(state.session.index - 1); break;
    case 'next': state.batch.confirm = null; await flushDraft(); await setIndex(state.session.index + 1); break;
    case 'jump': state.batch.confirm = null; await flushDraft(); state.view = 'quiz'; await setIndex(Number(el.dataset.i)); break;
    case 'finish': await flushDraft(); state.session.finished = true; await db.kvSet('session', state.session); go('summary'); break;
    case 'similar': await makeSimilar(el.dataset.qid); break;
    case 'solve-generated': { const g = state.generated.get(el.dataset.id); if (g) await startSession([g], 'generated'); break; }
    case 'retry-one': { const q = getQ(el.dataset.qid); if (q) await startSession([q], 'wrong'); break; }
    case 'retry-wrong': {
      const qs = wrongNotes().filter((n) => !n.resolved).map((n) => getQ(n.question_id)).filter(Boolean);
      await startSession(pickSet(qs), 'wrong'); break;
    }
    case 'sync': await syncNow('manual'); break;
    case 'save-config': await saveConfig(); break;
    case 'ping': await saveConfig(true); await ping(); break;
    case 'export': await exportBackup(); break;
    case 'import': document.getElementById('import-file').click(); break;
    case 'recheck': await checkOffline(); toast(state.offline.ready ? '오프라인 준비 완료' : '아직 준비되지 않았습니다'); break;
    case 'check-update': if (state.swReg) { await state.swReg.update().catch(() => {}); toast(state.swReg.waiting ? '새 버전이 있습니다. 상단 배너에서 적용하세요.' : '최신 버전입니다.'); } break;
    case 'apply-update': applyUpdate(); break;
    case 'diagnose': await runDiagnostics(); break;
    case 'copy-diag': {
      const txt = diagText();
      try { await navigator.clipboard.writeText(txt); toast('진단 결과를 복사했습니다.'); } catch { toast('복사하지 못했습니다. 화면을 캡처해 주세요.'); }
      break;
    }
  }
}

async function flushDraft() {
  const a = state.session && state.attempts.get(state.session.items[state.session.index]?.aid);
  const input = document.getElementById('ans');
  if (a && input && !a.answered_at && a.submitted_answer !== input.value) { a.submitted_answer = input.value; await saveAttempt(a, { bump: false }); }
}

async function saveConfig(silent = false) {
  const url = document.getElementById('cfg-url')?.value.trim() ?? state.config.url;
  const token = document.getElementById('cfg-token')?.value.trim() ?? state.config.token;
  if (url && !/^https:\/\/script\.google\.com\/macros\/s\/[^/]+\/exec$/.test(url)) {
    toast('URL은 https://script.google.com/macros/s/…/exec 형식이어야 합니다.', 4000);
    if (!/^https?:\/\/(localhost|127\.0\.0\.1)/.test(url)) return;
  }
  state.config = { url, token };
  await db.kvSet('config', state.config);
  if (!silent) toast('저장했습니다.');
  renderStatus();
}

async function ping() {
  state.pingResult = '확인 중…'; render();
  try {
    const r = await callServer('ping', {}, 30000);
    state.pingResult = `✓ 연결됨 — 스프레드시트 “${r.spreadsheet}”, 서버 ${r.version}, Gemini 키 ${r.gemini_configured ? '설정됨' : '없음(AI 기능 불가)'} · 응답 경로 ${state.lastHttp?.finalHost || '?'}`;
    syncNow('ping');
  } catch (e) { state.pingResult = '✗ ' + e.message; }
  render();
}

/* ---------- 실제 서버 연결 진단 ---------- */
function diagText() {
  if (!state.diag) return '';
  return [`[연결 진단] ${state.diag.started}`, ...state.diag.steps.map((d) => `${d.ok === true ? 'OK ' : d.ok === false ? 'FAIL' : '-  '} ${d.name} — ${d.detail}`)].join('\n');
}

async function runDiagnostics() {
  if (state.diagRunning) return;
  await saveConfig(true);
  state.diagRunning = true;
  const steps = [];
  state.diag = { started: nowIso(), steps, done: false };
  const add = (name, ok, detail) => { steps.push({ name, ok, detail }); render(); return ok; };
  const http = () => { const h = state.lastHttp || {}; return `HTTP ${h.status} · 리다이렉트 ${h.redirected ? '예' : '아니오'} · 최종 응답 ${h.finalHost || '?'} · ${h.contentType} · ${h.ms}ms`; };
  const id = `diag-${state.deviceId}-${Date.now().toString(36)}-${rid(4)}`;
  const rec = (rev) => ({ attempt_id: id, rev, question_id: 'DIAG', concept_id: 'DIAG', type: 'short', origin: 'diag',
    unit: '연결진단', topic: '연결진단', question_text: '연결 진단용 임시 기록 (자동 삭제 대상)', submitted_answer: 'rev ' + rev,
    auto_check: 'alias_match', answered_at: state.diag.started, updated_at: nowIso(), device_id: state.deviceId, session_id: 'diag' });
  const check = async () => (await callServer('diag_check', { attempt_id: id }, 30000));
  let wrote = false;
  try {
    add('앱 실행 환경', location.protocol === 'https:' || /^(localhost|127\.0\.0\.1)$/.test(location.hostname),
      `페이지 ${location.origin} · 보안 컨텍스트 ${isSecureContext ? '예' : '아니오'} · 서비스 워커 제어 ${navigator.serviceWorker?.controller ? '예' : '아니오'} · 서버 ${hostOf(state.config.url)}`);

    const p = await callServer('ping', {}, 30000);
    add('1. 연결 확인 (POST ping → JSON 응답 읽기)', true,
      `${http()} · 서버 ${p.version} · 스프레드시트 “${p.spreadsheet}” (${p.spreadsheet_id || 'ID 없음'}) · 풀이기록 ${p.attempts_rows}행 · Gemini 키 ${p.gemini_configured ? '있음' : '없음'}`);
    const realGas = hostOf(state.config.url) === 'script.google.com';
    if (realGas) add('   실제 Apps Script 응답 경로', state.lastHttp.redirected && /googleusercontent\.com$/.test(state.lastHttp.finalHost),
      state.lastHttp.redirected ? `script.google.com → ${state.lastHttp.finalHost} 리다이렉트 후 JSON 수신` : '리다이렉트가 관찰되지 않았습니다 (브라우저/배포 상태 확인 필요)');
    else add('   실제 Apps Script 응답 경로', null, `서버 주소가 script.google.com이 아닙니다 (${hostOf(state.config.url)}). 모의 서버 테스트로 간주합니다.`);

    let r = await callServer('sync', { records: [rec(1)], generated: [] }, 60000); wrote = true;
    let s = (r.saved || []).find((x) => x.attempt_id === id);
    add('2. 풀이 저장 (진단 기록 rev 1 전송)', !!s && s.rev === 1, s ? `서버가 저장 후 재조회로 확인: rev ${s.rev} · ${http()}` : `저장 확인 목록에 없음 (failed: ${JSON.stringify(r.failed || [])})`);
    let c = await check();
    add('   스프레드시트 행 확인', c.row_count === 1, `attempt_id ${id} 행 수 ${c.row_count}`);

    r = await callServer('sync', { records: [rec(1)], generated: [] }, 60000);
    s = (r.saved || []).find((x) => x.attempt_id === id);
    c = await check();
    add('3. 같은 기록 재전송 (응답 유실 후 재전송 상황)', !!s && c.row_count === 1, `저장 확인 ${s ? '예' : '아니오'} · 행 수 ${c.row_count} (1이어야 정상)`);

    r = await callServer('sync', { records: [rec(2)], generated: [] }, 60000);
    s = (r.saved || []).find((x) => x.attempt_id === id);
    c = await check();
    add('4. 수정본 전송 (rev 2, 자기 평가 변경 상황)', !!s && s.rev === 2 && c.row_count === 1 && c.revs[0] === 2,
      `행 수 ${c.row_count} · 저장된 rev ${c.revs.join(',') || '-'} (1행, rev 2여야 정상)`);
  } catch (e) {
    add('오류', false, `${e.message}${state.lastHttp ? ' · 마지막 응답: ' + http() : ''}`);
  }
  if (wrote) {
    try {
      const d = await callServer('diag_cleanup', {}, 30000);
      const c = await check();
      add('5. 진단 기록 삭제', c.row_count === 0, `삭제 ${d.deleted}행 · 남은 행 ${c.row_count}`);
    } catch (e) {
      add('5. 진단 기록 삭제', false, `${e.message} — 스프레드시트 ‘풀이기록’에서 attempt_id가 diag-로 시작하는 행을 직접 지워 주세요.`);
    }
  }
  state.diag.done = true;
  state.diagRunning = false;
  render();
}

boot();
