"""헤드리스 크롬 종단 테스트: 오프라인 준비, 비행기 모드 재실행, 채점, 동기화 중복방지, 생성문제, 업데이트 보존."""
import json, re, shutil, subprocess, sys, time, urllib.request, os, tempfile
from playwright.sync_api import sync_playwright, expect

ROOT = os.path.dirname(os.path.abspath(__file__))
PWA = os.path.join(ROOT, '..', 'pwa')
WORK = tempfile.mkdtemp()
SITE = os.path.join(WORK, 'site'); shutil.copytree(PWA, SITE)
PROFILE = os.path.join(WORK, 'profile')
APP = 'http://localhost:8080/'
GAS = 'http://localhost:8090/'
bank = json.load(open(os.path.join(SITE, 'data/questions.json')))
QS = {q['id']: q for q in bank['questions']}

static = subprocess.Popen([sys.executable, '-m', 'http.server', '8080', '-d', SITE], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
mock = subprocess.Popen(['node', os.path.join(ROOT, 'mock-gas-server.js')], stdout=open(os.path.join(WORK, 'mock.log'), 'w'), stderr=subprocess.STDOUT)
time.sleep(1.2)

# 서버 단위 검사: SHEET_ID 없을 때 / 편집기 밖에서 setup()을 실행할 때의 오류 메시지
print(subprocess.run(['node', os.path.join(ROOT, 'server-unit.js')], check=True, capture_output=True, text=True).stdout, end='')

def dump(): return json.load(urllib.request.urlopen(GAS + '__dump'))
def gas(body):
    req = urllib.request.Request(GAS, data=json.dumps({'token': 'testtoken123', **body}).encode(), method='POST')
    return json.load(urllib.request.urlopen(req))
def gemini_mode(m): urllib.request.urlopen(GAS + '__gemini?mode=' + m)
def rows_of(d, sheet='풀이기록'):
    t = d['sheets'][sheet]; return [dict(zip(t[0], r)) for r in t[1:]]
def ok(msg): print('  ✓', msg)

def current_qid(page):
    t = page.locator('.src').first.inner_text() if page.locator('.src').count() else ''
    return None

def qtext(page): return page.locator('.qtext').inner_text()
def find_q(text): return next(q for q in bank['questions'] if q['question'] == text)
def set_filter(page, key, v):
    page.click(f'[data-action="filter"][data-key="{key}"][data-v="{v}"]')
    expect(page.locator(f'[data-action="filter"][data-key="{key}"][data-v="{v}"]')).to_have_attribute('aria-pressed', 'true')
def units(page, which):
    page.click(f'[data-action="units-{which}"]')
    expect(page.locator('input[data-unit]:checked' if which == 'none' else 'input[data-unit]:not(:checked)')).to_have_count(0)
def click_next(page, sel='[data-action="next"]'):
    old = qtext(page); page.click(sel)
    page.wait_for_function('o => document.querySelector(".qtext") && document.querySelector(".qtext").innerText !== o', arg=old)

try:
    with sync_playwright() as p:
        # ---------- 1차 실행 (온라인) ----------
        ctx = p.chromium.launch_persistent_context(PROFILE, viewport={'width': 1200, 'height': 900})
        page = ctx.new_page()
        errors = []
        page.on('pageerror', lambda e: errors.append(str(e)))
        page.goto(APP)
        expect(page.locator('.chip.ok', has_text='오프라인 준비 완료')).to_be_visible(timeout=20000)
        expect(page.locator('#update-banner')).to_be_hidden()
        ok('첫 온라인 접속 후 "오프라인 준비 완료" 표시 (업데이트 배너 없음)')

        page.click('button[data-view="settings"]')
        page.fill('#cfg-url', GAS)
        page.fill('#cfg-token', 'testtoken123')
        page.click('[data-action="ping"]')
        expect(page.locator('#ping-result')).to_contain_text('연결됨', timeout=10000)
        ok('설정 화면 → Apps Script 연결 확인(ping) 성공: ' + page.locator('#ping-result').inner_text())

        # 단답형 5문제, 단원 1개만
        page.click('button[data-view="home"]')
        set_filter(page, 'type', 'short_answer')
        units(page, 'none')
        page.check('input[data-unit="기체 구조·재료·중량·착륙장치·정비기초"]')
        expect(page.locator('input[data-unit]:checked')).to_have_count(1)
        page.click('[data-action="start"]')
        expect(page.locator('.qtext')).to_be_visible()
        assert page.locator('.progress span').count() == 5
        ok('단답형·단원 선택 후 5문제 세트 시작')

        seen_concepts = set()
        # 1번: 허용 답안의 대소문자·공백 변형 → 자동 정답
        q = find_q(qtext(page)); seen_concepts.add(q['concept_id'])
        variant = q['accepted_answers'][-1].upper().replace('', ' ').strip() if re.search('[a-z]', q['accepted_answers'][-1]) else ' ' + q['accepted_answers'][0] + '  '
        page.fill('#ans', variant)
        page.click('[data-action="submit-short"]')
        expect(page.locator('.panel.ok')).to_contain_text('정답')
        ok(f'1번 {q["id"]}: "{variant}" → 허용 답안 일치로 정답')

        # 2번: 목록에 없는 답 → 판단 보류 → 모범답안 → 자기평가 틀림
        click_next(page)
        q = find_q(qtext(page)); seen_concepts.add(q['concept_id'])
        page.fill('#ans', '전혀 다른 답')
        page.click('[data-action="submit-short"]')
        expect(page.locator('.panel.warn')).to_contain_text('아직 오답으로 처리하지 않았습니다')
        assert page.locator('.assess').count() == 0
        page.click('[data-action="view-model"]')
        page.click('.assess button[data-v="incorrect"]')
        expect(page.locator('.assess button[data-v="incorrect"]')).to_have_attribute('aria-pressed', 'true')
        ok(f'2번 {q["id"]}: 불일치 → 즉시 오답 아님 → 모범답안 보기 → 자기평가 "틀림"')

        # 3번: 불일치 답 → AI 채점 (자기평가와 별도)
        click_next(page)
        q3 = find_q(qtext(page)); seen_concepts.add(q3['concept_id'])
        page.fill('#ans', '모르겠는데요')
        page.click('[data-action="submit-short"]')
        page.click('[data-action="ai"]')
        expect(page.locator('.panel', has_text='AI 채점 결과')).to_be_visible(timeout=15000)
        ok(f'3번 {q3["id"]}: AI 채점 결과 표시 — ' + page.locator('.panel', has_text='AI 채점 결과').locator('h3').inner_text())

        # 4번: 작성 중 답안만 입력하고 앱 종료
        click_next(page)
        q4 = find_q(qtext(page)); seen_concepts.add(q4['concept_id'])
        page.fill('#ans', '작성중초안')
        page.wait_for_timeout(700)
        click_next(page)
        q5 = find_q(qtext(page)); seen_concepts.add(q5['concept_id'])
        assert len(seen_concepts) == 5, '같은 concept 중복'
        ok('세트 5문항 concept_id 중복 없음')
        page.wait_for_timeout(3000)  # 자동 동기화 대기
        d = dump()
        ids = [r[0] for r in d['sheets']['풀이기록'][1:]]
        assert len(ids) == 3 and len(set(ids)) == 3, ids
        ok(f'자동 동기화: 확정된 3건만 서버 저장 (초안은 전송 안 함)')
        assert any(c['model'] == 'gemini-3.8-flash' for c in d['geminiCalls']) and any(c['model'] == 'gemini-3.6-flash' for c in d['geminiCalls'])
        assert all('x-goog-api-key' in c['headers'] for c in d['geminiCalls'])
        ok('Gemini 모델 404 시 다음 모델로 폴백, API 키는 서버 헤더로만 전달')
        ctx.close()

        # ---------- 2차 실행: 비행기 모드에서 앱 새로 열기 ----------
        ctx = p.chromium.launch_persistent_context(PROFILE, viewport={'width': 1200, 'height': 900}, offline=True)
        page = ctx.new_page()
        page.on('pageerror', lambda e: errors.append(str(e)))
        page.goto(APP)
        expect(page.locator('.chip.ok', has_text='오프라인 준비 완료')).to_be_visible(timeout=15000)
        expect(page.locator('.statusbar')).to_contain_text('오프라인')
        ok('비행기 모드 + 앱 완전 종료 후 재실행 → 정상 로딩')
        page.click('[data-action="go"][data-view="quiz"]')
        click_next(page, '[data-action="prev"]')
        assert page.locator('#ans').input_value() == '작성중초안'
        ok('작성 중이던 답안이 재실행 후에도 유지')
        page.fill('#ans', '오프라인 답')
        page.click('[data-action="submit-short"]')
        page.click('[data-action="view-model"]')
        page.click('.assess button[data-v="needs_review"]')
        assert page.locator('[data-action="ai"]').is_disabled()
        ok('오프라인: 모범답안·자기평가 가능, AI 채점 버튼 비활성')
        click_next(page)
        page.click('[data-action="unknown"]')
        page.click('.assess button[data-v="correct"]')
        page.click('[data-action="finish"]')
        expect(page.locator('h1')).to_have_text('세트 결과')
        # 이미 서버에 저장된 2번 문항의 자기 평가를 오프라인에서 수정 (미전송 수정 → 나중에 충돌 병합 대상)
        page.locator('[data-action="jump"][data-i="1"]').click()
        page.click('.assess button[data-v="needs_review"]')
        expect(page.locator('.assess button[data-v="needs_review"]')).to_have_attribute('aria-pressed', 'true')
        expect(page.locator('.chip.warn', has_text='미전송 3건')).to_be_visible()
        ok('오프라인 풀이 2건 + 기존 기록 수정 1건 = 미전송 3건 대기 표시')
        ctx.close()

        # ---------- 3차: 오프라인 재실행 후 기록 유지 확인, 서술형 ----------
        ctx = p.chromium.launch_persistent_context(PROFILE, viewport={'width': 1200, 'height': 900}, offline=True)
        page = ctx.new_page(); page.goto(APP)
        expect(page.locator('.chip.warn', has_text='미전송 3건')).to_be_visible(timeout=15000)
        page.click('button[data-view="home"]')
        set_filter(page, 'type', 'essay')
        units(page, 'all')
        page.click('[data-action="start"]')
        qe = find_q(qtext(page))
        assert qe['type'] == 'essay'
        page.fill('#ans', '서술 답안 테스트입니다')
        page.click('[data-action="view-model"]')
        expect(page.locator('.panel', has_text='채점 핵심 내용')).to_be_visible()
        assert page.locator('#ans').get_attribute('readonly') is not None
        page.click('.assess button[data-v="needs_review"]')
        ok(f'서술형 {qe["id"]}: 모범답안·핵심 내용 표시 → 답안 잠금 → 자기평가 "보완 필요"')
        # 검토 표시 문항이 있는지 화면 확인용으로 PDF 기준 배지 렌더 확인
        page.click('button[data-view="wrong"]')
        expect(page.locator('h1')).to_have_text('오답노트')
        n_wrong = page.locator('.list .item').count()
        ok(f'오답노트 {n_wrong}건 (틀림·보완 필요·AI 부분정답 반영)')
        ctx.close()

        # ---------- 다른 기기(DX)가 같은 기록을 서버에서 먼저 수정 ----------
        srv = {r['attempt_id']: r for r in gas({'action': 'pull', 'since': ''})['attempts']}
        x = next(r for r in srv.values() if r['submitted_answer'] == '전혀 다른 답')
        X_ID, X_REV = x['attempt_id'], x['rev']
        dx = dict(x, rev=X_REV + 1, base_rev=X_REV, submitted_answer='DX가 바꾼 답', self_assessment='correct', self_assessed_at='2026-01-01T00:00:00.000Z',
                  ai_status='done', ai_verdict='correct', ai_score=95, ai_feedback='DX 기기 AI 피드백', ai_graded_at='2026-01-02T00:00:00.000Z', ai_mode='single',
                  edited_by='DX-OTHER', updated_at='2026-01-02T00:00:00.000Z')
        r = gas({'action': 'sync', 'records': [dx]})
        assert [s['attempt_id'] for s in r['saved']] == [X_ID] and not r['conflicts'], r
        stale = dict(x, base_rev=X_REV - 1, rev=X_REV, self_assessment='correct')   # 낡은 기준으로 보낸 수정은 충돌로 돌아와야 함
        r = gas({'action': 'sync', 'records': [stale]})
        assert not r['saved'] and r['conflicts'][0]['attempt_id'] == X_ID and r['conflicts'][0]['server']['rev'] == X_REV + 1, r
        ok(f'서버: 다른 기기 수정 반영(rev {X_REV}→{X_REV + 1}), 낡은 기준(base_rev)의 수정은 덮어쓰지 않고 충돌로 반환')

        # ---------- 4차: 온라인 복귀, 응답 유실 후 재전송 중복 방지 ----------
        ctx = p.chromium.launch_persistent_context(PROFILE, viewport={'width': 1200, 'height': 900})
        urllib.request.urlopen(GAS + '__drop?n=1')   # 앱이 열리며 보내는 첫 동기화: 서버는 저장, 응답은 유실
        page = ctx.new_page(); page.on('pageerror', lambda e: errors.append(str(e))); page.goto(APP)
        expect(page.locator('.chip.bad', has_text='전송 실패')).to_be_visible(timeout=15000)
        rows_after_drop = len(dump()['sheets']['풀이기록']) - 1
        ok(f'응답 유실 → 앱은 "전송 실패·기록 보관" 유지 (서버엔 이미 {rows_after_drop}행)')
        page.click('.statusbar [data-action="sync"]')
        expect(page.locator('.chip.ok', has_text='모두 저장됨')).to_be_visible(timeout=15000)
        d = dump()
        ids = [r[0] for r in d['sheets']['풀이기록'][1:]]
        assert len(ids) == len(set(ids)) == rows_after_drop == 6, (ids, rows_after_drop)
        ok(f'수동 재전송 성공 — 서버 풀이기록 {len(ids)}행, 중복 0')
        page.click('.statusbar [data-action="sync"]')
        page.wait_for_timeout(1500)
        assert len(dump()['sheets']['풀이기록']) - 1 == 6
        ok('한 번 더 동기화해도 행 수 불변')

        xr = next(r for r in rows_of(d) if r['attempt_id'] == X_ID)
        assert xr['submitted_answer'] == '전혀 다른 답', xr['submitted_answer']          # 이 기기의 확정 답안 유지
        assert xr['self_assessment'] == 'needs_review'                                   # 더 늦은 자기 평가(이 기기) 유지
        assert xr['ai_verdict'] == 'correct' and xr['ai_feedback'] == 'DX 기기 AI 피드백'  # 다른 기기 AI 결과 병합
        assert xr['rev'] == X_REV + 2 and xr['final_result'] == 'wrong', (xr['rev'], xr['final_result'])
        ok(f'수정 충돌 병합: 답안·자기평가는 이 기기, AI 결과는 다른 기기 것으로 합쳐 같은 행 갱신 (rev {xr["rev"]}, 1행)')
        page.click('button[data-view="records"]')
        expect(page.locator('.item', has_text='다른 기기에서도 수정된 기록이라 병합')).to_have_count(1)

        wrong_sheet = d['sheets']['오답노트']
        hdr = wrong_sheet[0]
        counts = {r[0]: r[hdr.index('wrong_count')] for r in wrong_sheet[1:]}
        assert all(v == 1 for v in counts.values()), counts
        ok(f'서버 오답노트 {len(counts)}건, 재전송 후에도 오답 횟수 1회씩')

        # 자기평가 변경 → rev 증가 → 같은 행 갱신
        page.click('button[data-view="wrong"]')
        page.locator('[data-action="retry-one"]').first.click()
        page.fill('#ans', '아무답') if page.locator('input#ans').count() else page.fill('#ans', '아무답')
        if page.locator('[data-action="submit-short"]').count(): page.click('[data-action="submit-short"]')
        page.click('[data-action="view-model"]') if page.locator('[data-action="view-model"]').count() else None
        if page.locator('.assess').count(): page.click('.assess button[data-v="correct"]')
        page.wait_for_timeout(3500)
        d = dump(); rows = d['sheets']['풀이기록']
        assert len(rows) - 1 == 7 and len({r[0] for r in rows[1:]}) == 7
        ok('오답 다시 풀기 1건 추가 저장 (7행)')

        # 비슷한 새 문제 만들기
        page.click('[data-action="similar"]')
        expect(page.locator('[data-action="solve-generated"]')).to_be_visible(timeout=15000)
        page.click('[data-action="solve-generated"]')
        expect(page.locator('.badge.gen')).to_have_text('AI 생성 · 검토 전')
        gq = qtext(page); assert gq.startswith('[변형]')
        page.fill('#ans', '테스트답')
        if page.locator('[data-action="submit-short"]').count(): page.click('[data-action="submit-short"]')
        else: page.click('[data-action="view-model"]')
        page.wait_for_timeout(3500)
        d = dump()
        assert len(d['sheets']['생성문제']) - 1 == 1
        assert any(r[5] == 'generated' for r in d['sheets']['풀이기록'][1:])
        ok('비슷한 새 문제 생성 → 새 ID(G-…)로 저장·풀이·서버 동기화')

        # ---------- 세트 일괄 채점 ----------
        page.click('button[data-view="home"]')
        set_filter(page, 'source', 'bank')
        set_filter(page, 'type', 'both')
        units(page, 'all')
        for attempt in range(20):
            page.click('[data-action="start"]') if page.locator('[data-action="start"]').count() else None
            types = []
            for i in range(5):
                types.append(find_q(qtext(page)))
                if i < 4: click_next(page)
            if any(q['type'] == 'short_answer' for q in types[:3]) and sum(1 for q in types[:4] if q['type'] == 'essay') >= 1: break
            page.click('button[data-view="home"]'); page.click('[data-action="discard-session"]')
        else: raise AssertionError('혼합 세트를 만들지 못함')
        for i in range(4): click_next(page, '[data-action="prev"]')
        alias_i = next(i for i, q in enumerate(types[:3]) if q['type'] == 'short_answer')
        plan = {}
        for i, q in enumerate(types):
            if i == 4: plan[i] = ''                                # 빈 답안
            elif i == alias_i: plan[i] = ' ' + q['accepted_answers'][0].upper() + ' '   # 허용 답안 → 로컬 채점
            else: plan[i] = f'일괄채점 답안 {i + 1}번 ' + q['id']
            if plan[i]: page.fill('#ans', plan[i])
            if i < 4: click_next(page)
        ai_ids = [types[i]['id'] for i in range(4) if i != alias_i]
        calls0 = len(dump()['geminiCalls'])

        gemini_mode('fail_all')
        page.click('[data-action="batch-ai"]')
        expect(page.locator('#batch-confirm')).to_contain_text('빈 답안 1문항: 5번')
        expect(page.locator('#batch-confirm')).to_contain_text('오답으로 처리하지 않으며')
        ok('빈 답안이 있으면 제출 전에 확인 (5번) — 자동 오답 처리 없음')
        page.click('[data-action="batch-confirm"]')
        expect(page.locator('h1')).to_have_text('세트 전체 검토')
        expect(page.locator('.panel.bad', has_text='일괄 채점 실패')).to_have_count(3, timeout=15000)
        for i in range(4):
            if i != alias_i: expect(page.locator(f'.review-item[data-qid="{types[i]["id"]}"] .myans')).to_have_text(plan[i])
        expect(page.locator(f'.review-item[data-qid="{types[alias_i]["id"]}"]')).to_contain_text('기기에서 채점')
        expect(page.locator(f'.review-item[data-qid="{types[4]["id"]}"]')).to_contain_text('답안 미작성')
        d = dump(); calls = d['geminiCalls'][calls0:]
        assert [c['status'] for c in calls] == [404, 503, 503] and all(c['batch'] == ai_ids for c in calls), calls
        ok(f'일괄 채점: 허용 답안 일치 1문항은 로컬 채점, 나머지 {len(ai_ids)}문항만 1회 요청 · 전 모델 503 실패 시 작성 답안 유지')

        gemini_mode('omit_one')
        page.click('[data-action="batch-ai"]')
        expect(page.locator('.panel', has_text='AI 채점 결과')).to_have_count(2, timeout=15000)
        expect(page.locator('.panel.bad', has_text='결과가 없었습니다')).to_have_count(1)
        missing_id = ai_ids[-1]
        gemini_mode('transient')
        calls1 = len(dump()['geminiCalls'])
        page.click('[data-action="batch-ai"]')
        expect(page.locator('.panel', has_text='AI 채점 결과')).to_have_count(3, timeout=15000)
        calls = dump()['geminiCalls'][calls1:]
        assert [(c['model'], c['status']) for c in calls] == [('gemini-3.8-flash', 404), ('gemini-3.6-flash', 503), ('gemini-2.5-flash', 200)], calls
        assert all(c['batch'] == [missing_id] for c in calls), calls
        ok('응답에서 빠진 문항만 다시 요청 · 503 일시 오류 시 다음 모델(gemini-2.5-flash)로 넘어가 채점 성공')
        for qid in ai_ids:
            expect(page.locator(f'.review-item[data-qid="{qid}"] .panel', has_text='AI 채점 결과')).to_contain_text('모의 일괄 피드백 ' + qid)
            expect(page.locator(f'.review-item[data-qid="{qid}"] .panel', has_text='AI 채점 결과')).to_contain_text('세트 일괄 채점')
        ok('문제 ID별로 판정·피드백이 각 문항에 따로 표시')
        page.wait_for_timeout(3500)
        d = dump(); rs = [r for r in rows_of(d) if r['question_id'] in [q['id'] for q in types]]
        assert len(rs) == 4 and len({r['attempt_id'] for r in rs}) == 4, [(r['question_id'], r['rev']) for r in rs]
        for r in rs:
            if r['question_id'] in ai_ids: assert r['ai_feedback'] == '모의 일괄 피드백 ' + r['question_id'] and r['ai_status'] == 'done', r
            else: assert r['auto_check'] == 'alias_match' and r['final_result'] == 'correct'
        assert all(json.loads(r['record_json']).get('ai_mode') == 'batch' for r in rs if r['question_id'] in ai_ids)
        ok('실패·재시도 3회 후에도 서버 풀이기록은 문항당 1행 (빈 5번은 저장 안 됨), 문제별 판정·피드백 저장')
        # 개별 채점 기능 유지: 빈 5번을 작성해 개별 AI 채점
        page.locator(f'.review-item[data-qid="{types[4]["id"]}"] [data-action="jump"]').click()
        page.fill('#ans', '개별 채점 답안')
        if types[4]['type'] == 'short_answer': page.click('[data-action="submit-short"]')
        page.click('.card [data-action="ai"]')
        expect(page.locator('.panel', has_text='AI 채점 결과')).to_contain_text('개별 채점', timeout=15000)
        ok('일괄 채점 후에도 문제별 개별 AI 채점 동작')
        page.wait_for_timeout(3000)
        BATCH_ROWS = len(rows_of(dump()))

        # 백업 내보내기
        page.click('button[data-view="settings"]')
        with page.expect_download() as dl:
            page.click('[data-action="export"]')
        path = os.path.join(WORK, 'backup.json'); dl.value.save_as(path); backup = json.load(open(path))
        ok(f'기록 내보내기: attempts {len(backup["attempts"])}건, generated {len(backup["generated"])}건')

        # 연결 진단 버튼 (모의 서버 대상) — 저장·재전송·수정본에서 1행 유지, 끝나면 진단 행 삭제
        before = dump()['sheets']['풀이기록']
        page.click('[data-action="diagnose"]')
        expect(page.locator('#diag-summary')).to_contain_text('결과: 모두 통과', timeout=20000)
        txt = page.locator('#diag-result').inner_text()
        assert '행 수 1 (1이어야 정상)' in txt and '1행, rev 2여야 정상' in txt and '모의 서버 테스트로 간주' in txt, txt
        d = dump()
        assert d['sheets']['풀이기록'] == before, '진단 후 풀이기록이 원래대로 돌아오지 않음'
        assert d['sheetIdProp'] == 'mock-sheet-id-123' and d['openByIdCalls'] > 0
        ok(f'연결 진단: 저장→재전송→수정본 모두 1행 유지, 진단 행 삭제 후 풀이기록 {len(before)-1}행 그대로 · openById 호출 {d["openByIdCalls"]}회')
        ctx.close()

        # ---------- 두 번째 기기(B): 같은 URL·토큰으로 내려받기 ----------
        ctxB = p.chromium.launch_persistent_context(os.path.join(WORK, 'profileB'), viewport={'width': 800, 'height': 1100})
        pb = ctxB.new_page(); pb.on('pageerror', lambda e: errors.append('B: ' + str(e))); pb.goto(APP)
        expect(pb.locator('.chip.ok', has_text='오프라인 준비 완료')).to_be_visible(timeout=20000)
        pb.click('button[data-view="settings"]'); pb.fill('#cfg-url', GAS); pb.fill('#cfg-token', 'testtoken123')
        pb.click('[data-action="ping"]')
        expect(pb.locator('#ping-result')).to_contain_text('연결됨', timeout=10000)
        d = dump(); srv_rows = rows_of(d)
        pb.click('button[data-view="records"]')
        expect(pb.locator('.list .item.other')).to_have_count(len(srv_rows), timeout=15000)
        srv_wrong_open = [r for r in rows_of(d, '오답노트') if r['resolved'] == 'N']
        pb.click('button[data-view="wrong"]')
        expect(pb.locator('.list .item')).to_have_count(len(srv_wrong_open))
        xb = pb.evaluate('''async () => { const db = await new Promise(r => { const q = indexedDB.open('firequiz'); q.onsuccess = () => r(q.result); });
            return await new Promise(r => { const g = db.transaction('attempts').objectStore('attempts').get(%r); g.onsuccess = () => r(g.result); }); }''' % X_ID)
        assert xb['ai_detail'] is None or isinstance(xb['ai_detail'], dict)
        assert xb['rev'] == xb['synced_rev'] == X_REV + 2 and xb['self_assessment'] == 'needs_review'
        ok(f'기기 B: 서버 기록 {len(srv_rows)}건 내려받아 병합, 오답노트 {len(srv_wrong_open)}건 동일 (서버 오답노트와 일치)')
        # B에서 새로 풀기 → 서버로 → A가 받음
        pb.click('button[data-view="home"]'); set_filter(pb, 'type', 'short_answer')
        pb.click('[data-action="start"]')
        qb = find_q(pb.locator('.qtext').inner_text())
        pb.fill('#ans', qb['accepted_answers'][0]); pb.click('[data-action="submit-short"]')
        expect(pb.locator('.panel.ok')).to_be_visible()
        pb.wait_for_timeout(3000)
        assert any(r['question_id'] == qb['id'] for r in rows_of(dump()))
        pb.click('.statusbar [data-action="sync"]'); pb.wait_for_timeout(1500)
        assert len(rows_of(dump())) == len(srv_rows) + 1
        ok('기기 B 풀이 1건 서버 저장 · B가 다시 동기화해도 행 중복 없음')
        # B 오프라인 재실행: 마지막 동기화까지의 기록 표시
        ctxB.close()
        ctxB = p.chromium.launch_persistent_context(os.path.join(WORK, 'profileB'), viewport={'width': 800, 'height': 1100}, offline=True)
        pb = ctxB.new_page(); pb.goto(APP)
        expect(pb.locator('.chip.ok', has_text='오프라인 준비 완료')).to_be_visible(timeout=15000)
        pb.click('button[data-view="records"]')
        expect(pb.locator('.list .item')).to_have_count(len(srv_rows) + 1)
        expect(pb.locator('.card .sub').first).to_contain_text('오프라인 — 마지막 동기화')
        ok(f'기기 B 오프라인 재실행: 마지막 동기화까지의 기록 {len(srv_rows) + 1}건 표시')
        ctxB.close()

        # ---------- 5차: 앱 업데이트 후 기록 보존 + 가져오기 ----------
        pc = os.path.join(SITE, 'precache.js')
        src = open(pc).read(); OLD = re.search(r"FQ_VERSION = '(.*?)'", src).group(1); NEW = OLD + '.1'
        open(pc, 'w').write(src.replace(f"'{OLD}'", f"'{NEW}'"))
        ctx = p.chromium.launch_persistent_context(PROFILE, viewport={'width': 1200, 'height': 900})
        page = ctx.new_page(); page.goto(APP)
        expect(page.locator('#update-banner')).to_be_visible(timeout=20000)
        page.wait_for_timeout(1500)
        if 0: print('DEBUG0', page.evaluate('''async()=>{const r=await navigator.serviceWorker.getRegistration();return {w:!!r.waiting,ws:r.waiting&&r.waiting.state,a:r.active&&r.active.state,inst:!!r.installing,keys:await caches.keys(), uvc:r.updateViaCache}}'''))
        with page.expect_navigation():
            page.click('[data-action="apply-update"]')
        expect(page.locator('.chip.ok', has_text='오프라인 준비 완료')).to_be_visible(timeout=20000)
        if 0: print('DEBUG', page.evaluate('''async()=>{const k=await caches.keys();const out={keys:k,v:self.FQ_VERSION,ctl:navigator.serviceWorker.controller&&navigator.serviceWorker.controller.scriptURL};for(const n of k){const c=await caches.open(n);const r=await c.match('./precache.js');out[n]=r?(await r.text()).match(/FQ_VERSION = '(.*?)'/)[1]:null}return out}'''))
        page.click('button[data-view="settings"]')
        expect(page.locator('.card', has_text='오프라인 준비 상태')).to_contain_text('앱 버전 ' + NEW)
        page.click('button[data-view="records"]')
        n = len([a for a in backup['attempts'] if a.get('answered_at')])
        expect(page.locator('.list .item')).to_have_count(n + 1, timeout=15000)   # 기존 기록 + 기기 B 기록 1건
        expect(page.locator('.list .item.other')).to_have_count(1)
        ok(f'업데이트({OLD}→{NEW}) 적용 후 풀이 기록 {n}건 그대로 유지 + 기기 B 기록 1건 받아 옴')
        caches = page.evaluate('caches.keys()')
        assert caches == ['firequiz-' + NEW], caches
        ok('이전 앱 캐시만 삭제, IndexedDB 기록 보존')
        ctx.close()

        # 새 기기 가정: 빈 프로필에 백업 가져오기
        ctx = p.chromium.launch_persistent_context(os.path.join(WORK, 'profile2'), viewport={'width': 1200, 'height': 900})
        page = ctx.new_page(); page.goto(APP)
        expect(page.locator('.chip.ok', has_text='오프라인 준비 완료')).to_be_visible(timeout=20000)
        page.click('button[data-view="settings"]')
        if 0: print('DEBUG imp', page.locator('#import-file').count(), os.path.exists(path))
        page.locator('#import-file').set_input_files(path, timeout=8000)
        expect(page.locator('#toast')).to_contain_text('가져오기 완료')
        page.click('button[data-view="records"]')
        assert page.locator('.list .item').count() == n
        ok('다른 프로필로 기록 가져오기 성공 (' + page.locator('#toast').inner_text() + ')')
        ctx.close()

        # ---------- 오프라인: 전체 모범답안 보기 + 문제별 자기 평가 ----------
        ctx = p.chromium.launch_persistent_context(os.path.join(WORK, 'profileOff'), viewport={'width': 1200, 'height': 900})
        page = ctx.new_page(); page.goto(APP)
        expect(page.locator('.chip.ok', has_text='오프라인 준비 완료')).to_be_visible(timeout=20000)
        ctx.close()
        ctx = p.chromium.launch_persistent_context(os.path.join(WORK, 'profileOff'), viewport={'width': 1200, 'height': 900}, offline=True)
        page = ctx.new_page(); page.on('pageerror', lambda e: errors.append(str(e))); page.goto(APP)
        expect(page.locator('.chip.ok', has_text='오프라인 준비 완료')).to_be_visible(timeout=15000)
        page.click('[data-action="start"]')
        page.fill('#ans', '오프라인 일괄 1'); click_next(page)
        page.fill('#ans', '오프라인 일괄 2'); click_next(page)
        expect(page.locator('[data-action="batch-ai"]')).to_be_disabled()
        expect(page.locator('[data-action="batch-ai"]')).to_contain_text('온라인 필요')
        page.click('[data-action="batch-model"]')
        expect(page.locator('#batch-confirm')).to_contain_text('빈 답안 3문항: 3번, 4번, 5번')
        page.click('[data-action="batch-confirm"]')
        expect(page.locator('h1')).to_have_text('세트 전체 검토')
        expect(page.locator('.review-item .panel h3', has_text='모범답안')).to_have_count(2)
        expect(page.locator('.review-item', has_text='답안 미작성')).to_have_count(3)
        btns = page.locator('.review-item .assess')
        alias_auto = 2 - btns.count()
        for k in range(btns.count()):
            btns.nth(k).locator('button[data-v="needs_review"]' if k == 0 else 'button[data-v="correct"]').click()
        expect(page.locator('.assess button[aria-pressed="true"]')).to_have_count(btns.count())
        page.click('button[data-view="records"]')
        expect(page.locator('.list .item')).to_have_count(2)
        expect(page.locator('.card .sub').first).to_contain_text('서버를 연결하면')
        ok('오프라인: 전체 모범답안 보기(빈 3문항 확인·미제출) → 문제별 자기 평가 저장, AI 일괄 버튼 비활성')
        ctx.close()

        assert not errors, errors
        ok('페이지 스크립트 오류 0건')
        print('\n전체 테스트 통과')
finally:
    static.terminate(); mock.terminate()
    print(open(os.path.join(WORK, 'mock.log')).read()[-600:])
