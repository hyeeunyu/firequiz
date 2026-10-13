// Code.gs를 그대로 불러와 Apps Script 서비스(시트·속성·잠금·UrlFetch)를 메모리로 흉내 내는 테스트 서버.
const fs = require('fs'), vm = require('vm'), http = require('http'), path = require('path');

const sheets = {};
const props = { APP_TOKEN: 'testtoken123', GEMINI_API_KEY: 'fake' };
const SHEET_ID = 'mock-sheet-id-123';
let editorContext = true;   // setup()은 편집기 실행(활성 시트 있음), 이후 웹 앱 실행(활성 시트 없음)을 흉내
let openByIdCalls = 0;
let geminiCalls = [];
let mode = { drop: 0, gemini: 'normal' }; // gemini: normal | fail_all(전 모델 503) | transient(3.6-flash 503 1회) | omit_one(일괄 응답에서 마지막 문항 누락)

function makeSheet(name) {
  const rows = []; // 2차원 배열 (1행 = rows[0])
  const ensure = (r, c) => { while (rows.length < r) rows.push([]); rows.forEach((row) => { while (row.length < c) row.push(''); }); };
  const sh = {
    name, rows,
    getLastRow: () => { let n = rows.length; while (n > 0 && rows[n - 1].every((v) => v === '')) n--; return n; },
    setFrozenRows() {},
    getRange(r, c, nr = 1, nc = 1) {
      return {
        getValues() { ensure(r + nr - 1, c + nc - 1); return rows.slice(r - 1, r - 1 + nr).map((row) => row.slice(c - 1, c - 1 + nc)); },
        getValue() { ensure(r, c); return rows[r - 1][c - 1]; },
        setValues(v) { if (v.length !== nr || v[0].length !== nc) throw new Error('범위 크기 불일치'); ensure(r + nr - 1, c + nc - 1); v.forEach((row, i) => row.forEach((x, j) => { rows[r - 1 + i][c - 1 + j] = x; })); return this; },
        setFontWeight() { return this; }
      };
    },
    deleteRow(r) { rows.splice(r - 1, 1); }
  };
  return sh;
}
const ss = { getId: () => SHEET_ID, getName: () => '테스트 스프레드시트', getSheetByName: (n) => sheets[n] || null, insertSheet: (n) => (sheets[n] = makeSheet(n)) };

const ctx = {
  console,
  SpreadsheetApp: {
    // 실제 웹 앱 실행에서 getActiveSpreadsheet()는 null → 웹 앱 경로가 이것에 의존하면 테스트가 실패한다
    getActiveSpreadsheet: () => (editorContext ? ss : null),
    openById: (id) => { openByIdCalls++; if (id !== SHEET_ID) throw new Error('잘못된 ID: ' + id); return ss; },
    flush() {}
  },
  PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => props[k] || null, setProperty: (k, v) => { props[k] = v; } }) },
  LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
  Utilities: { getUuid: () => require('crypto').randomUUID() },
  Logger: { log: (m) => console.log('[Logger]', m) },
  ContentService: { MimeType: { JSON: 'json' }, createTextOutput: (s) => ({ s, setMimeType() { return this; } }) },
  UrlFetchApp: {
    fetch(url, opt) {
      const model = decodeURIComponent(url.split('/models/')[1].split(':')[0]);
      const prompt = JSON.parse(opt.payload).contents[0].parts[0].text;
      const batchIds = [...prompt.matchAll(/<item id="([^"]+)">/g)].map((m) => m[1]);
      const call = { model, headers: opt.headers, batch: batchIds.length ? batchIds : null, status: 200 };
      geminiCalls.push(call);
      if (model === 'gemini-3.8-flash') { call.status = 404; return resp(404, '{"error":{"message":"model not found"}}'); } // 폴백 경로 검증
      if (mode.gemini === 'fail_all') { call.status = 503; return resp(503, '{"error":{"code":503,"message":"The model is overloaded"}}'); }
      if (mode.gemini === 'transient' && model === 'gemini-3.6-flash') { mode.gemini = 'normal'; call.status = 503; return resp(503, '{"error":{"code":503,"message":"UNAVAILABLE"}}'); }
      const gradeOne = (ans, model_answer) => {
        const ok = ans.length > 3 && model_answer.includes(ans.slice(0, 4));
        return { verdict: ok ? 'correct' : 'partial', score: ok ? 90 : 40, matched_points: ['a'], missing_points: ok ? [] : ['b'], errors: [], feedback: '모의 피드백' };
      };
      let out;
      if (batchIds.length) {
        const blocks = prompt.split('<item id="').slice(1);
        let results = blocks.map((b) => {
          const id = b.split('"')[0];
          const ans = b.split('<student_answer>\n')[1].split('\n</student_answer>')[0];
          return { id, ...gradeOne(ans, b.match(/\[모범답안\] (.*)/)[1]), feedback: '모의 일괄 피드백 ' + id };
        });
        if (mode.gemini === 'omit_one') { results = results.slice(0, -1); mode.gemini = 'normal'; }
        results.push({ id: 'NOT-REQUESTED', verdict: 'correct', score: 100, feedback: 'x' }); // 요청에 없던 id는 서버가 버려야 함
        out = { results };
      } else if (prompt.includes('변형 문제')) {
        const short = prompt.includes('유형: 단답형');
        out = { question: '[변형] ' + prompt.match(/\[기준 문항\] (.*)/)[1], model_answer: prompt.match(/\[모범답안\] (.*)/)[1],
          accepted_answers: short ? ['변형정답'] : [], key_points: ['핵심1', '핵심2'], explanation: '설명' };
      } else {
        const ans = prompt.split('<student_answer>\n')[1].split('\n</student_answer>')[0];
        out = gradeOne(ans, prompt.match(/\[모범답안\] (.*)/)[1]);
      }
      return resp(200, JSON.stringify({ candidates: [{ content: { parts: [{ text: '```json\n' + JSON.stringify(out) + '\n```' }] } }] }));
    }
  }
};
function resp(code, body) { return { getResponseCode: () => code, getContentText: () => body }; }
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(process.env.CODE_GS || path.join(__dirname, '../apps-script/Code.gs'), 'utf8'), ctx);
ctx.setup();
if (props.SHEET_ID !== SHEET_ID) throw new Error('setup()이 SHEET_ID를 저장하지 않음');
editorContext = false;
console.log('[mock] setup 완료, SHEET_ID 저장 확인 → 이후 웹 앱 컨텍스트(활성 시트 없음)');

const PORT = Number(process.env.PORT || 8090);
http.createServer((req, res) => {
  const cors = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json; charset=utf-8' };
  if (req.url.startsWith('/__dump')) {
    const out = {}; Object.keys(sheets).forEach((k) => { out[k] = sheets[k].rows.slice(0, sheets[k].getLastRow()); });
    res.writeHead(200, cors); return res.end(JSON.stringify({ sheets: out, geminiCalls, openByIdCalls, sheetIdProp: props.SHEET_ID || null }));
  }
  if (req.url.startsWith('/__reload')) { // 서버 코드 교체(시트·스크립트 속성은 유지) — 이전 서버 → 새 서버 업데이트 재현
    const f = new URL(req.url, 'http://x').searchParams.get('code');
    vm.runInContext(fs.readFileSync(f, 'utf8'), ctx); res.writeHead(200, cors); return res.end(JSON.stringify({ ok: true, version: ctx.SERVER_VERSION }));
  }
  if (req.url.startsWith('/__gemini')) { mode.gemini = new URL(req.url, 'http://x').searchParams.get('mode') || 'normal'; res.writeHead(200, cors); return res.end('{"ok":true}'); }
  if (req.url.startsWith('/__drop')) { mode.drop = Number(new URL(req.url, 'http://x').searchParams.get('n') || 1); res.writeHead(200, cors); return res.end('{"ok":true}'); }
  if (req.method === 'OPTIONS') { res.writeHead(400, cors); return res.end('preflight should not happen'); } // 실제 Apps Script는 사전요청을 처리하지 못함
  if (req.method === 'GET') { res.writeHead(200, cors); return res.end(ctx.doGet().s); }
  let body = '';
  req.on('data', (d) => { body += d; });
  req.on('end', () => {
    const ct = req.headers['content-type'] || '';
    const out = ctx.doPost({ postData: { contents: body, type: ct } }).s;
    if (mode.drop > 0) { mode.drop--; console.log('[mock] 저장 후 응답 유실 시뮬레이션'); return req.socket.destroy(); }
    res.writeHead(200, cors); res.end(out);
  });
}).listen(PORT, () => console.log('mock GAS on', PORT));
