import copy
from datetime import datetime, timedelta, timezone
import json
from pathlib import Path
import shutil
import subprocess
import sys
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'scripts'))
from collectors import CollectionError, PublicHTTP, Response
from public_data import CONTRACT, stamp
from skill_refresh import METRIC, ROUNDED, WINDOW, refresh_skills

NOW = datetime(2026, 9, 23, 8, tzinfo=timezone.utc)
CONFIGURED = json.loads((ROOT / 'config/skills.json').read_text(encoding='utf-8'))


def skill(**changes):
    row = copy.deepcopy(CONFIGURED[0])
    row.update(checkedAt=None, status='unchecked', popularity=None)
    row.update(changes)
    return row


def heat(value=1234, date=None, url=None):
    return {'metric': METRIC, 'value': value, 'source': url or CONFIGURED[0]['url'],
            'window': WINDOW, 'collectedAt': stamp(date or NOW)}


def page(row=None, stats='<div><span>All Time Installs</span><strong>1,234</strong></div>', content=True):
    row = row or CONFIGURED[0]
    prose = '<article><p>Use this skill to research competing products and prepare evidence-based comparison pages.</p></article>' if content else ''
    return (f'<html><head><title>{row["name"]} | skills.sh</title></head><body><main>'
            f'<h1>{row["name"]}</h1><a href="https://github.com/coreyhaines31/marketingskills">'
            f'{row["author"]}</a>{stats}{prose}</main></body></html>').encode()


class FakeHTTP:
    def __init__(self, body=None, url=None, content_type='text/html; charset=utf-8', error=None):
        self.body = page() if body is None else body
        self.url = url
        self.content_type = content_type
        self.error = error
        self.calls = []

    def get(self, url, allowed_hosts=()):
        self.calls.append((url, tuple(allowed_hosts)))
        if self.error:
            raise self.error
        return Response(self.body, self.url or url, self.content_type)


class SkillHistoryTests(unittest.TestCase):
    def test_offline_never_constructs_client_or_claims_observation(self):
        rows = [skill(), skill(id='expired', checkedAt=stamp(NOW - timedelta(days=10)), status='verified')]
        original = copy.deepcopy(rows)
        with patch('skill_refresh.PublicHTTP', side_effect=AssertionError('no client offline')):
            result = refresh_skills(rows, [], NOW, offline=True)
        self.assertEqual(result, original)
        self.assertIsNot(result, rows)
        self.assertIsNot(result[0], rows[0])

    def test_offline_injected_client_is_not_used(self):
        http = FakeHTTP(error=AssertionError('no network offline'))
        old = skill(checkedAt=stamp(NOW - timedelta(days=20)), status='unavailable',
                    popularity=heat(date=NOW - timedelta(days=20)))
        result = refresh_skills([old], [], NOW, offline=True, http=http)
        self.assertEqual(result, [old])
        self.assertFalse(http.calls)

    def test_recent_and_exact_seven_day_boundary(self):
        for age, expected_calls in ((timedelta(0), 0), (timedelta(days=7) - timedelta(microseconds=1), 0),
                                    (timedelta(days=7), 1), (timedelta(days=7, seconds=1), 1)):
            with self.subTest(age=age):
                row = skill(checkedAt=stamp(NOW - age), status='verified')
                http = FakeHTTP()
                result = refresh_skills([row], [], NOW, http=http)[0]
                self.assertEqual(len(http.calls), expected_calls)
                self.assertEqual(result['checkedAt'], stamp(NOW) if expected_calls else row['checkedAt'])

    def test_timezone_equivalent_boundary(self):
        date = (NOW - timedelta(days=7)).astimezone(timezone(timedelta(hours=8))).isoformat()
        http = FakeHTTP()
        refresh_skills([skill(checkedAt=date, status='verified')], [], NOW, http=http)
        self.assertEqual(len(http.calls), 1)

    def test_recent_history_copies_only_metadata_and_never_mutates_inputs(self):
        base = skill(checkedAt=stamp(NOW - timedelta(days=20)), status='verified')
        old = skill(checkedAt=stamp(NOW - timedelta(days=10)), status='verified')
        recent = skill(checkedAt=stamp(NOW - timedelta(days=1)), status='verified',
                       popularity=heat(date=NOW - timedelta(days=1)), description='untrusted old description',
                       author='wrong author', name='wrong name', curatedOrder=999, extra='not public')
        history = [{'skills': [recent]}, {'skills': [old]}]
        before = copy.deepcopy((base, history))
        http = FakeHTTP(error=AssertionError('recent checks are reused'))
        result = refresh_skills([base], history, NOW, http=http)[0]
        for key in base:
            self.assertEqual(result[key], recent[key] if key in ('checkedAt', 'status', 'popularity') else base[key])
        self.assertEqual(set(result), set(CONTRACT['skill']))
        self.assertEqual((base, history), before)
        result['popularity']['value'] = 999
        self.assertEqual(recent['popularity']['value'], 1234)
        self.assertFalse(http.calls)

    def test_changed_url_and_id_never_reuse_history(self):
        recent = skill(checkedAt=stamp(NOW), status='verified', popularity=heat())
        for row in (skill(url='https://skills.sh/coreyhaines31/new-project/competitor-alternatives',
                          author='coreyhaines31 / new-project'), skill(id='new-id')):
            with self.subTest(row=row):
                http = FakeHTTP(error=CollectionError('network', 'offline fixture'))
                result = refresh_skills([row], [{'skills': [recent]}], NOW, http=http)[0]
                self.assertEqual(len(http.calls), 1)
                self.assertEqual(result['status'], 'unavailable')
                self.assertIsNone(result['checkedAt'])
                self.assertIsNone(result['popularity'])

    def test_maintained_order_and_descriptions_not_history_order(self):
        rows = copy.deepcopy(CONFIGURED[::-1])
        rows[0]['curatedOrder'], rows[1]['curatedOrder'] = 99, 1
        history = [{'skills': [dict(row, checkedAt=stamp(NOW), curatedOrder=0, description='replace')
                               for row in CONFIGURED] + [skill(id='auto-added')]}]
        result = refresh_skills(rows, history, NOW, offline=True)
        self.assertEqual([r['id'] for r in result], [r['id'] for r in rows])
        self.assertEqual([r['curatedOrder'] for r in result], [99, 1])
        self.assertEqual([r['description'] for r in result], [r['description'] for r in rows])
        self.assertEqual(len(result), 2)

    def test_older_or_other_collections_do_not_override_config(self):
        row = skill(checkedAt=stamp(NOW - timedelta(days=1)), status='verified',
                    popularity=heat(date=NOW - timedelta(days=1)))
        old = dict(row, checkedAt=stamp(NOW - timedelta(days=2)), status='unavailable')
        history = [{'skills': [old]}, {'news': [dict(row, checkedAt=stamp(NOW), popularity=None)]}]
        self.assertEqual(refresh_skills([row], history, NOW, offline=True), [row])

    def test_invalid_history_timestamps_status_or_snapshot_are_ignored(self):
        for changes in ({'checkedAt': 'yesterday'}, {'checkedAt': '2026-09-23'},
                        {'checkedAt': '2026-09-23T07:00:00'}, {'checkedAt': stamp(NOW + timedelta(seconds=1))},
                        {'checkedAt': None}, {'status': 'success'}, {'status': 'unchecked'},
                        {'status': {}}, {'checkedAt': []}):
            with self.subTest(changes=changes):
                row = skill()
                history = [{'skills': [skill(checkedAt=stamp(NOW), status='verified') | changes]}]
                self.assertEqual(refresh_skills([row], history, NOW, offline=True), [row])
        for attempted in ('bad', stamp(NOW + timedelta(days=1)), stamp(NOW - timedelta(days=1))):
            history = [{'attemptedAt': attempted, 'skills': [skill(checkedAt=stamp(NOW), status='verified')]}]
            self.assertIsNone(refresh_skills([skill()], history, NOW, offline=True)[0]['checkedAt'])

    def test_invalid_heat_never_imported(self):
        variants = [heat(value=True), heat(value=-1), heat(value=float('nan')), heat(value=float('inf')),
                    heat(value=1.5), heat(value='1.2K'), heat(value=2**53), heat(value='<script>1</script>'),
                    heat(url='https://github.com/coreyhaines31/marketingskills'),
                    heat(date=NOW + timedelta(seconds=1)), heat() | {'metric': 'GitHub Stars'},
                    heat() | {'window': 'Weekly'}, heat() | {'private': 'extra'},
                    {k: v for k, v in heat().items() if k != 'collectedAt'}]
        for bad in variants:
            with self.subTest(bad=bad):
                history = [{'skills': [skill(checkedAt=stamp(NOW), status='verified', popularity=bad)]}]
                result = refresh_skills([skill()], history, NOW, offline=True)[0]
                self.assertEqual(result['checkedAt'], stamp(NOW))
                self.assertIsNone(result['popularity'])

    def test_heat_may_not_postdate_success_or_replace_newer_heat(self):
        check = NOW - timedelta(days=1)
        history = [{'skills': [skill(checkedAt=stamp(check), status='verified', popularity=heat())]}]
        self.assertIsNone(refresh_skills([skill()], history, NOW, offline=True)[0]['popularity'])
        row = skill(checkedAt=stamp(check), status='verified', popularity=heat(date=check))
        history = [{'skills': [skill(checkedAt=stamp(NOW), status='verified',
                                    popularity=heat(1, NOW - timedelta(days=2)))]}]
        self.assertEqual(refresh_skills([row], history, NOW, offline=True)[0]['popularity'], row['popularity'])

    def test_failure_retains_last_success_and_old_heat_and_next_run_retries(self):
        past = NOW - timedelta(days=10)
        original = skill(checkedAt=stamp(past), status='verified', popularity=heat(date=past))
        http = FakeHTTP(error=CollectionError('network', 'test failure'))
        failed = refresh_skills([original], [], NOW, http=http)[0]
        self.assertEqual(failed, original | {'status': 'unavailable'})
        retried = refresh_skills([original], [{'attemptedAt': stamp(NOW), 'skills': [failed]}],
                                 NOW + timedelta(hours=1), http=FakeHTTP())[0]
        self.assertEqual(retried['status'], 'verified')
        self.assertEqual(retried['checkedAt'], stamp(NOW + timedelta(hours=1)))
        self.assertEqual(original['status'], 'verified')

    def test_recent_failure_not_hidden_by_equal_checked_at_in_config(self):
        past = NOW - timedelta(days=1)
        configured = skill(checkedAt=stamp(past), status='verified', popularity=heat(date=past))
        failed = configured | {'status': 'unavailable'}
        for history in ([{'skills': [failed]}],
                        [{'attemptedAt': stamp(NOW), 'skills': [failed]},
                         {'attemptedAt': stamp(past), 'skills': [configured]}]):
            with self.subTest(history=history):
                offline = refresh_skills([configured], history, NOW, offline=True)[0]
                self.assertEqual(offline['status'], 'unavailable')
                self.assertEqual(offline['popularity'], configured['popularity'])
                http = FakeHTTP()
                result = refresh_skills([configured], history, NOW, http=http)[0]
                self.assertEqual(len(http.calls), 1)
                self.assertEqual(result['checkedAt'], stamp(NOW))

    def test_failure_without_previous_success_keeps_null_time(self):
        http = FakeHTTP(error=TimeoutError('timeout'))
        result = refresh_skills([skill()], [], NOW, http=http)[0]
        self.assertEqual(result['status'], 'unavailable')
        self.assertIsNone(result['checkedAt'])
        self.assertIsNone(result['popularity'])

    def test_future_config_time_does_not_suppress_retry(self):
        row = skill(checkedAt=stamp(NOW + timedelta(days=1)), status='verified')
        http = FakeHTTP()
        result = refresh_skills([row], [], NOW, http=http)[0]
        self.assertEqual(len(http.calls), 1)
        self.assertEqual(result['checkedAt'], stamp(NOW))

    def test_reject_more_than_twelve_or_extra_contract_fields_before_network(self):
        http = FakeHTTP()
        for rows in ([skill(id=str(i)) for i in range(13)], [skill(extra=True)]):
            with self.subTest(rows=len(rows)), self.assertRaises(ValueError):
                refresh_skills(rows, [], NOW, http=http)
        self.assertFalse(http.calls)

    def test_naive_clock_rejected_and_empty_config_needs_no_client(self):
        with self.assertRaises(ValueError):
            refresh_skills([], [], NOW.replace(tzinfo=None))
        with patch('skill_refresh.PublicHTTP', side_effect=AssertionError('empty config')):
            self.assertEqual(refresh_skills([], [], NOW), [])


class SkillPageTests(unittest.TestCase):
    def refresh(self, body=None, **kwargs):
        http = FakeHTTP(body=body, **kwargs)
        result = refresh_skills([skill()], [], NOW, http=http)[0]
        self.assertEqual(http.calls, [(CONFIGURED[0]['url'], ('skills.sh', 'www.skills.sh'))])
        return result

    def test_complete_heat_fields_exact_integer_and_no_extra_fields(self):
        result = self.refresh()
        self.assertEqual(result['status'], 'verified')
        self.assertEqual(result['checkedAt'], stamp(NOW))
        self.assertEqual(result['popularity'], heat())
        self.assertEqual(set(result), set(CONTRACT['skill']))

    def test_both_maintained_entries_can_refresh_without_changing_configuration(self):
        rows = copy.deepcopy(CONFIGURED)
        before = copy.deepcopy(rows)
        http = FakeHTTP()
        responses = [Response(page(row), row['url'], 'text/html') for row in rows]
        later = NOW + timedelta(days=8)
        with patch.object(http, 'get', side_effect=responses) as get:
            result = refresh_skills(rows, [], later, http=http)
        self.assertEqual(get.call_count, 2)
        self.assertEqual(rows, before)
        for original, refreshed in zip(rows, result):
            self.assertEqual(refreshed, original | {'checkedAt': stamp(later), 'status': 'verified',
                                                   'popularity': heat(date=later, url=original['url'])})

    def test_challenge_failure_retains_old_metadata_without_advancing_dates(self):
        past = NOW - timedelta(days=8)
        old = skill(checkedAt=stamp(past), status='verified', popularity=heat('1.2K' + ROUNDED, past))
        http = FakeHTTP(body=b'<title>Just a moment...</title>' + page())
        result = refresh_skills([old], [], NOW, http=http)[0]
        self.assertEqual(result, old | {'status': 'unavailable'})

    def test_zero_and_compact_counts_preserve_display_not_invent_exact_value(self):
        for raw, expected in (('0', 0), ('1234', 1234), ('1,234,567', 1234567),
                              ('1.2K', '1.2K' + ROUNDED), ('3M', '3M' + ROUNDED), ('2.30k', '2.30k' + ROUNDED)):
            with self.subTest(raw=raw):
                result = self.refresh(page(stats=f'<div><span>All Time Installs</span><b>{raw}</b></div>'))
                self.assertEqual(result['popularity'], heat(expected))

    def test_split_heading_entities_and_breadcrumb_project(self):
        body = page().replace(b'All Time Installs', b'All&nbsp;Time <em>Installs</em>')
        body = body.replace(b'coreyhaines31 / marketingskills</a>', b'coreyhaines31</a><a href="/coreyhaines31/marketingskills">marketingskills</a>')
        body = body.replace(b'https://github.com/coreyhaines31/marketingskills', b'/coreyhaines31')
        result = self.refresh(body)
        self.assertEqual(result['status'], 'verified')
        self.assertEqual(result['popularity'], heat())

    def test_verified_page_without_provable_heat_is_null_even_with_old_heat(self):
        past = NOW - timedelta(days=8)
        row = skill(checkedAt=stamp(past), status='verified', popularity=heat(date=past))
        http = FakeHTTP(body=page(stats='<div>Repository Stars 50K</div>'))
        result = refresh_skills([row], [], NOW, http=http)[0]
        self.assertEqual(result['status'], 'verified')
        self.assertEqual(result['checkedAt'], stamp(NOW))
        self.assertIsNone(result['popularity'])

    def test_ambiguous_numbers_and_other_metrics_are_not_heat(self):
        stats = ['All Time Installs ' + value for value in ('1.2', '~1,200', '1K+', '1-2K', '1,2K', '1,23',
                                                         '1 234', 'over 1000', '1e3', '12%', '-1', '12 installs / 2 skills',
                                                         '１２３', '9007199254740992')]
        stats += ['All Time 1234', 'Installs 1234', 'Weekly Installs 1234', 'All Time Stars 1234',
                  'GitHub repository stars 1234', 'All Time Downloads 1234', 'All Time Installs 1234 Stars 42']
        for text in stats:
            with self.subTest(text=text):
                result = self.refresh(page(stats=f'<div>{text}</div>'))
                self.assertEqual(result['status'], 'verified')
                self.assertIsNone(result['popularity'])

    def test_multiple_conflicting_counts_or_unrelated_panels_are_null(self):
        variants = ['<div>All Time Installs 100</div><div>All Time Installs 200</div>',
                    '<div>All Time Installs 100</div><div>All Time Installs 1K+</div>',
                    '<section><h2>Related Skills</h2><div>All Time Installs 100</div></section>',
                    '<section><h2>copywriting</h2><div>All Time Installs 100</div></section>',
                    '<section><h2>All Skills</h2><div>All Time Installs 100</div></section>',
                    '<div><a href="/other/project/other">Other skill</a><div>All Time Installs 100</div></div>',
                    '<a href="/other/project/other"><div>All Time Installs 100</div></a>',
                    '<article><div>All Time Installs 100</div></article>',
                    '<pre><div>All Time Installs 100</div></pre>',
                    '<table><tr><td><div>All Time Installs 100</div></td></tr></table>']
        for stats in variants:
            with self.subTest(stats=stats):
                self.assertIsNone(self.refresh(page(stats=stats))['popularity'])

    def test_missing_wrong_hidden_or_script_only_identity_fails(self):
        variants = [b'<html><body><div id="root"></div></body></html>', b'<html>OK</html>',
                    page().replace(b'<h1>competitor-alternatives</h1>', b'<h1>copywriting</h1>'),
                    page().replace(b'coreyhaines31 / marketingskills</a>', b'another / project</a>'),
                    page().replace(b'<h1>', b'<h1 hidden>'),
                    page().replace(b'<h1>', b'<h1 style="display: none">'),
                    b'<script>' + page() + b'</script>', b'<template>' + page() + b'</template>',
                    b'<noscript>' + page() + b'</noscript>', page(content=False, stats='<div>Loading...</div>'),
                    page(content=False, stats='<footer><p>Copyright directory team. Browse the directory of community skills for agents.</p></footer>')]
        for body in variants:
            with self.subTest(body=body[:100]):
                result = self.refresh(body)
                self.assertEqual(result['status'], 'unavailable')
                self.assertIsNone(result['checkedAt'])
                self.assertIsNone(result['popularity'])

    def test_challenge_and_error_pages_fail_even_if_identity_is_embedded(self):
        for marker in ('<title>Just a moment...</title>', '<form id="captcha">Verify you are human</form>',
                       '<script src="/cdn-cgi/challenge-platform/test"></script>',
                       '<p>Vercel Security Checkpoint</p>', '<h2>404: This page could not be found</h2>',
                       '<meta http-equiv="refresh" content="0;url=https://attacker.example/">'):
            with self.subTest(marker=marker):
                self.assertEqual(self.refresh(marker.encode() + page())['status'], 'unavailable')

    def test_hidden_or_hydration_only_heat_not_used(self):
        for wrapper in ('<script>{}</script>', '<div hidden>{}</div>', '<div aria-hidden="true">{}</div>',
                        '<div style="visibility:hidden">{}</div>', '<template>{}</template>'):
            body = page(stats=wrapper.format('<div>All Time Installs 1234</div>'))
            with self.subTest(wrapper=wrapper):
                self.assertIsNone(self.refresh(body)['popularity'])

    def test_non_html_oversized_invalid_utf8_and_deep_pages_fail(self):
        variants = [(b'{"All Time Installs": 1234}', 'application/json'), (page(), 'text/plain'),
                    (b'x' * 2_000_001, 'text/html'), (b'\xff' + page(), 'text/html'),
                    (b'<div>' * 130 + page() + b'</div>' * 130, 'text/html')]
        for body, content_type in variants:
            with self.subTest(content_type=content_type, size=len(body)):
                self.assertEqual(self.refresh(body, content_type=content_type)['status'], 'unavailable')

    def test_valueless_html_attributes_do_not_abort_refresh(self):
        body = b'<meta http-equiv><div aria-hidden style></div>' + page()
        self.assertEqual(self.refresh(body)['status'], 'verified')

    def test_response_redirect_must_still_be_configured_skill(self):
        for url in ('https://attacker.example/skill', 'https://127.0.0.1/', 'http://skills.sh/path',
                    'https://u:p@skills.sh/path', 'https://skills.sh/coreyhaines31/marketingskills/copywriting',
                    'https://skills.sh/', CONFIGURED[0]['url'] + '?token=secret'):
            with self.subTest(url=url):
                self.assertEqual(self.refresh(url=url)['status'], 'unavailable')
        self.assertEqual(self.refresh(url=CONFIGURED[0]['url'] + '/')['status'], 'verified')

    def test_unsafe_or_unsupported_config_urls_never_reach_transport(self):
        for url in ('http://skills.sh/a/b/c', 'https://localhost/a/b/c', 'https://127.0.0.1/a/b/c',
                    'https://169.254.169.254/latest/meta-data/', 'https://[::1]/a/b/c',
                    'https://u:p@skills.sh/a/b/c', 'https://skills.sh:444/a/b/c',
                    'https://skills.sh.evil.example/a/b/c', 'https://github.com/a/b/c',
                    CONFIGURED[0]['url'] + '?api_key=secret', CONFIGURED[0]['url'] + '#secret'):
            http = FakeHTTP(error=AssertionError('must reject before transport'))
            with self.subTest(url=url):
                result = refresh_skills([skill(url=url)], [], NOW, http=http)[0]
                self.assertEqual(result['status'], 'unavailable')
                self.assertFalse(http.calls)

    def test_default_client_is_bounded_and_only_calls_configured_url(self):
        fake = FakeHTTP()
        with patch('skill_refresh.PublicHTTP', return_value=fake) as constructor:
            refresh_skills([skill()], [], NOW)
        constructor.assert_called_once_with(max_requests=12, timeout=10, max_bytes=2_000_000, total_seconds=120)
        self.assertEqual(fake.calls, [(CONFIGURED[0]['url'], ('skills.sh', 'www.skills.sh'))])

    def test_real_transport_rejects_external_redirect_before_second_request(self):
        for target in ('https://attacker.example/skill', 'https://127.0.0.1/',
                       'http://skills.sh/path', 'https://u:p@skills.sh/path'):
            client = PublicHTTP(max_requests=12)
            with self.subTest(target=target), patch.object(client, '_request', return_value=(302, {'location': target}, b'')) as request:
                result = refresh_skills([skill()], [], NOW, http=client)[0]
                self.assertEqual(result['status'], 'unavailable')
                request.assert_called_once_with(CONFIGURED[0]['url'])

    def test_canonical_www_redirect_keeps_exact_skill_identity(self):
        original = CONFIGURED[0]['url']
        target = original.replace('https://skills.sh/', 'https://www.skills.sh/')
        client = PublicHTTP(max_requests=12)
        with patch.object(client, '_request', side_effect=[(308, {'location': target}, b''),
                          (200, {'content-type': 'text/html'}, page())]) as request:
            result = refresh_skills([skill()], [], NOW, http=client)[0]
        self.assertEqual([call.args[0] for call in request.call_args_list], [original, target])
        self.assertEqual(result['status'], 'verified')
        self.assertEqual(result['popularity'], heat())
        for invalid in (target + '?q=1', target.replace('competitor-alternatives', 'copywriting'),
                        target.replace('www.skills.sh', 'www.skills.sh.evil.example')):
            self.assertEqual(self.refresh(url=invalid)['status'], 'unavailable')

    def test_private_dns_is_rejected_before_connection(self):
        client = PublicHTTP(max_requests=12)
        with patch('collectors.socket.getaddrinfo', return_value=[(2, 1, 6, '', ('10.0.0.1', 443))]), patch('collectors.socket.create_connection') as connect:
            result = refresh_skills([skill()], [], NOW, http=client)[0]
            self.assertEqual(result['status'], 'unavailable')
            connect.assert_not_called()

    @unittest.skipUnless(shutil.which('node'), 'Node unavailable; frontend source still documents string support')
    def test_frontend_normalizer_preserves_rounded_string_and_all_heat_fields(self):
        result = self.refresh(page(stats='<div>All Time Installs 1.2K</div>'))
        module = (ROOT / 'site/assets/core.mjs').as_uri()
        source = (f'import {{ normalizeSkills }} from {json.dumps(module)};'
                  'let input = ""; for await (const part of process.stdin) input += part;'
                  'process.stdout.write(JSON.stringify(normalizeSkills(JSON.parse(input))));')
        process = subprocess.run(['node', '--input-type=module', '-e', source], input=json.dumps([result]),
                                 text=True, encoding='utf-8', capture_output=True, check=True, timeout=15)
        self.assertEqual(json.loads(process.stdout)[0]['popularity'], heat('1.2K' + ROUNDED))


if __name__ == '__main__':
    unittest.main()
