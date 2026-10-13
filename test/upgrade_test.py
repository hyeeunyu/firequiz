"""실제 이전 빌드(앱 1.1.0 + 서버 1.1.0)에서 새 빌드(앱 1.2.0 + 서버 1.2.0)로 올릴 때의 기록 보존·호환성 테스트.
사용: python3 test/upgrade_test.py <이전 pwa 폴더> <이전 Code.gs>"""
import json, os, shutil, subprocess, sys, tempfile, time, urllib.request
from playwright.sync_api import sync_playwright, expect

ROOT = os.path.dirname(os.path.abspath(__file__))
OLD_PWA, OLD_GS = sys.argv[1], sys.argv[2]
NEW_PWA, NEW_GS = os.path.join(ROOT, '..', 'pwa'), os.path.join(ROOT, '..', 'apps-script', 'Code.gs')
WORK = tempfile.mkdtemp(); SITE = os.path.join(WORK, 'site'); shutil.copytree(OLD_PWA, SITE)
APP, GAS = 'http://localhost:8081/', 'http://localhost:8091/'
bank = {q['question']: q for q in json.load(open(os.path.join(SITE, 'data/questions.json')))['questions']}
st = subprocess.Popen([sys.executable, '-m', 'http.server', '8081', '-d', SITE], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
mk = subprocess.Popen(['node', os.path.join(ROOT, 'mock-gas-server.js')], env={**os.environ, 'PORT': '8091', 'CODE_GS': OLD_GS}, stdout=subprocess.DEVNULL, stderr=subprocess.STDOUT)
time.sleep(1.2)
def dump(): return json.load(urllib.request.urlopen(GAS + '__dump'))
def rows(sheet='풀이기록'): t = dump()['sheets'][sheet]; return [dict(zip(t[0], r)) for r in t[1:]]
def ok(m): print('  ✓', m)
def idb(page): return page.evaluate('''async () => { const db = await new Promise(r => { const q = indexedDB.open('firequiz'); q.onsuccess = () => r(q.result); });
  return await new Promise(r => { const g = db.transaction('attempts').objectStore('attempts').getAll(); g.onsuccess = () => r(g.result); }); }''')
errors = []
try:
    with sync_playwright() as p:
        prof = os.path.join(WORK, 'profile')
        # 1) 이전 앱 1.1.0 + 이전 서버 1.1.0 에서 기록 만들기
        ctx = p.chromium.launch_persistent_context(prof); page = ctx.new_page(); page.on('pageerror', lambda e: errors.append(str(e)))
        page.goto(APP)
        expect(page.locator('.chip.ok', has_text='오프라인 준비 완료')).to_be_visible(timeout=20000)
        page.click('button[data-view="settings"]'); page.fill('#cfg-url', GAS); page.fill('#cfg-token', 'testtoken123')
        page.click('[data-action="ping"]'); expect(page.locator('#ping-result')).to_contain_text('서버 1.1.0', timeout=10000)
        page.click('button[data-view="home"]')
        page.click('[data-action="filter"][data-key="type"][data-v="short_answer"]')
        expect(page.locator('[data-action="filter"][data-key="type"][data-v="short_answer"]')).to_have_attribute('aria-pressed', 'true')
        page.click('[data-action="start"]')
        q = bank[page.locator('.qtext').inner_text()]
        page.fill('#ans', q['accepted_answers'][0]); page.click('[data-action="submit-short"]')
        old = page.locator('.qtext').inner_text(); page.click('[data-action="next"]')
        page.wait_for_function('o => document.querySelector(".qtext").innerText !== o', arg=old)
        page.click('[data-action="unknown"]'); page.click('.assess button[data-v="incorrect"]')
        expect(page.locator('.chip.ok', has_text='모두 저장됨')).to_be_visible(timeout=15000)
        before = sorted((a['attempt_id'], a['rev']) for a in idb(page) if a.get('answered_at'))
        assert len(before) == 2 and len(rows()) == 2 and 'record_json' not in dump()['sheets']['풀이기록'][0]
        ok('이전 앱 1.1.0 + 이전 서버 1.1.0: 풀이 2건 기기 저장·서버 저장 (record_json 열 없음)')
        ctx.close()

        # 2) 앱만 1.2.0으로 업데이트 (서버는 아직 1.1.0)
        shutil.rmtree(SITE); shutil.copytree(NEW_PWA, SITE)
        ctx = p.chromium.launch_persistent_context(prof); page = ctx.new_page(); page.on('pageerror', lambda e: errors.append(str(e)))
        page.goto(APP)
        expect(page.locator('#update-banner')).to_be_visible(timeout=20000)
        with page.expect_navigation(): page.click('[data-action="apply-update"]')
        expect(page.locator('.chip.ok', has_text='오프라인 준비 완료')).to_be_visible(timeout=20000)
        page.click('button[data-view="settings"]')
        expect(page.locator('.card', has_text='오프라인 준비 상태')).to_contain_text('앱 버전 1.2.0')
        after = sorted((a['attempt_id'], a['rev']) for a in idb(page) if a.get('answered_at'))
        assert after == before, (before, after)
        assert page.evaluate('caches.keys()') == ['firequiz-1.2.0']
        ok('앱 1.1.0 → 1.2.0 업데이트: IndexedDB 기록 2건(attempt_id·rev) 그대로, 캐시만 교체')
        page.click('button[data-view="records"]')
        expect(page.locator('.card .sub').first).to_contain_text('1.2.0 이전 버전', timeout=15000)
        page.click('button[data-view="home"]'); page.click('[data-action="discard-session"]') if page.locator('[data-action="discard-session"]').count() else None
        page.click('[data-action="start"]')
        page.click('[data-action="unknown"]'); page.click('.assess button[data-v="needs_review"]')
        page.wait_for_timeout(3500)
        assert len(rows()) == 3
        ok('새 앱 + 이전 서버: 올리기는 계속 동작(3행), 내려받기는 "서버 업데이트 필요" 안내')
        ctx.close()

        # 3) 서버도 1.2.0으로 교체 (같은 시트·토큰)
        r = json.load(urllib.request.urlopen(GAS + '__reload?code=' + urllib.request.quote(NEW_GS)))
        assert r['version'] == '1.2.0'
        ctx = p.chromium.launch_persistent_context(prof); page = ctx.new_page(); page.on('pageerror', lambda e: errors.append(str(e)))
        page.goto(APP)
        expect(page.locator('.chip.ok', has_text='모두 저장됨')).to_be_visible(timeout=15000)
        page.click('button[data-view="records"]')
        expect(page.locator('.card .sub').first).to_contain_text('마지막으로 받은 시각', timeout=15000)
        hdr = dump()['sheets']['풀이기록'][0]
        assert hdr[-1] == 'record_json' and len(rows()) == 3
        ok('서버 1.2.0 교체: 기존 시트에 record_json 열 제목만 맨 뒤에 추가, 기존 3행 유지, 내려받기 정상')
        ctx.close()

        # 4) 새 기기가 이전 서버 시절 행(record_json 없음)을 내려받기
        ctx = p.chromium.launch_persistent_context(os.path.join(WORK, 'profile2')); page = ctx.new_page(); page.on('pageerror', lambda e: errors.append(str(e)))
        page.goto(APP)
        expect(page.locator('.chip.ok', has_text='오프라인 준비 완료')).to_be_visible(timeout=20000)
        page.click('button[data-view="settings"]'); page.fill('#cfg-url', GAS); page.fill('#cfg-token', 'testtoken123')
        page.click('[data-action="ping"]'); expect(page.locator('#ping-result')).to_contain_text('서버 1.2.0', timeout=10000)
        page.click('button[data-view="records"]')
        expect(page.locator('.list .item.other')).to_have_count(3, timeout=15000)
        got = {a['attempt_id']: a for a in idb(page)}
        srv = {r['attempt_id']: r for r in rows()}
        for k, r in srv.items():
            a = got[k]
            assert a['submitted_answer'] == r['submitted_answer'] and a['self_assessment'] == r['self_assessment'] and a['type'] == r['question_type'] and a['rev'] == r['rev'], (a, r)
        page.click('button[data-view="wrong"]')
        expect(page.locator('.list .item')).to_have_count(len([r for r in rows('오답노트') if r['resolved'] == 'N']))
        ok('새 기기: record_json 없는 이전 행 3건을 열 값으로 복원해 병합, 오답노트도 서버와 일치')
        ctx.close()
    assert not errors, errors
    ok('페이지 스크립트 오류 0건')
    print('\n업데이트 테스트 통과')
finally:
    st.terminate(); mk.terminate()
