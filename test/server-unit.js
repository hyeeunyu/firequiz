// Code.gs 단위 검사 — SHEET_ID 설정 경로 (setup → 스크립트 속성 → openById)
const fs = require('fs'), vm = require('vm'), path = require('path'), assert = require('assert');
const code = fs.readFileSync(path.join(__dirname, '../apps-script/Code.gs'), 'utf8');
function load(active) {
  const props = { APP_TOKEN: 't' };
  const ss = { getId: () => 'ID-1', getName: () => 'S', getSheetByName: () => null, insertSheet: () => ({ getRange: () => ({ setValues() { return this; }, setFontWeight() { return this; } }), setFrozenRows() {}, getLastRow: () => 1 }) };
  const ctx = {
    props,
    SpreadsheetApp: { getActiveSpreadsheet: () => (active ? ss : null), openById: (id) => { if (id !== 'ID-1') throw new Error('bad id'); return ss; }, flush() {} },
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => props[k] || null, setProperty: (k, v) => { props[k] = v; } }) },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    Utilities: { getUuid: () => require('crypto').randomUUID() },
    Logger: { log() {} },
    ContentService: { MimeType: { JSON: 'json' }, createTextOutput: (s) => ({ s, setMimeType() { return this; } }) }
  };
  vm.createContext(ctx); vm.runInContext(code, ctx); return ctx;
}
const post = (ctx, b) => JSON.parse(ctx.doPost({ postData: { contents: JSON.stringify({ token: 't', ...b }) } }).s);

// 1) setup 전: 웹 앱 요청은 명확한 오류 코드로 실패
let c = load(false);
let r = post(c, { action: 'ping' });
assert.strictEqual(r.ok, false); assert.strictEqual(r.error, 'sheet_not_configured'); assert(/setup\(\)/.test(r.message));
assert.strictEqual(JSON.parse(c.doGet().s).sheet_configured, false);
console.log('  ✓ SHEET_ID 없음 → ping 응답 error=sheet_not_configured, "setup()을 먼저 실행" 안내');

// 2) 편집기 밖(활성 시트 없음)에서 setup → 예외
assert.throws(() => c.setup(), /활성 스프레드시트를 찾지 못했습니다/);
console.log('  ✓ 활성 스프레드시트 없이 setup() 실행 → 이유를 알려 주는 예외');

// 3) 편집기에서 setup → SHEET_ID 저장, 이후 웹 앱(활성 시트 없음)에서도 openById로 동작
c = load(true); c.setup();
assert.strictEqual(c.props.SHEET_ID, 'ID-1');
c.SpreadsheetApp.getActiveSpreadsheet = () => null;
r = post(c, { action: 'ping' });
assert.strictEqual(r.ok, true); assert.strictEqual(r.spreadsheet_id, 'ID-1');
console.log('  ✓ 편집기 setup() → SHEET_ID 저장 → 활성 시트 없는 웹 앱에서 openById로 ping 성공');
