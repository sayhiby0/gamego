import copy
from datetime import timedelta
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch
from urllib.parse import parse_qs, urlsplit

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'scripts'))
from collectors import CollectionError, Response, parse_chart, parse_feed
from pipeline import board_template, load_config, run_pipeline, select_movements
from public_data import (ROOT, apply_history, atomic_json, comparable_key, load_history, privacy_check,
                         public_url, publish, read_json, safe_text, stamp, validate_dashboard)
from test_collectors import NOW, SOURCE, chart, feed, reviews
from test_content import ENV
from test_skills import page as skill_page


def small_config():
    config = load_config()
    config['sources'] = [s for s in config['sources'] if s['id'] in ('ign', 'steam-popularity', 'steam-commercial', 'steam-reviews', 'steam-announcements')]
    for source in config['sources']:
        source['fallbacks'] = []
    return config


class FakeHTTP:
    def __init__(self, failures=(), total=120, now=NOW):
        self.urls = []
        self.failures, self.total, self.now = failures, total, now

    def get(self, url, allowed_hosts=()):
        self.urls.append(url)
        if any(f in url for f in self.failures):
            raise CollectionError('network', '测试传输失败；不是线上结果')
        if '/charts/' in url:
            return Response(chart('popularity' if 'mostplayed' in url else 'commercial'), url, 'text/html')
        if '/appreviews/' in url:
            return Response(reviews(self.total, samples=[{'timestamp_created': int((self.now-timedelta(days=1)).timestamp()), 'voted_up': True, 'review': 'The game combat update is great', 'author': {'steamid': '76561198000000000'}}]), url, 'application/json')
        if '/ISteamNews/' in url:
            appid = int(parse_qs(urlsplit(url).query)['appid'][0])
            return Response(json.dumps({'appnews': {'appid': appid, 'newsitems': []}}).encode(), url, 'application/json')
        return Response(feed(date=stamp(self.now-timedelta(hours=1))), url, 'application/xml')


class RegistryTests(unittest.TestCase):
    def test_full_registered_channels_and_methods(self):
        config = load_config()
        self.assertGreater(len(config['sources']), 85)
        self.assertEqual({s['method'] for s in config['sources']}, {'rss', 'rsshub', 'web', 'controlled_search'})
        self.assertEqual(len([s for s in config['sources'] if s['method'] == 'rss' and s['mode'] != 'fallback_only']), 11)
        self.assertEqual(len([s for s in config['sources'] if s['method'] == 'rsshub']), 11)
        searches = [s for s in config['sources'] if s['method'] == 'controlled_search']
        self.assertEqual(len({s['name'] for s in searches}), 18)
        self.assertEqual(len(searches), 19)  # GameSpot additionally has the verified articles-only scope.
        self.assertFalse(any(s['lastSuccessAt'] for s in config['sources']))

    def test_taptap_never_enabled(self):
        entries = [s for s in load_config()['sources'] if s['gameMappings'] and 'taptap' in s['url']]
        self.assertGreaterEqual(len(entries), 14)
        self.assertFalse(any(s['enabled'] for s in entries))
        mismatch = next(s for s in entries if '/app/34599' in s['url'])
        self.assertEqual(mismatch['gameMappings'][0]['identity'], 'mismatch')
        self.assertIn('PATIENCE', mismatch['reason'])

    def test_qualified_canonical_fallback_configuration(self):
        config = load_config()
        sources = {s['id']: s for s in config['sources']}
        self.assertIn('ign-canonical', sources['ign']['fallbacks'])
        self.assertTrue(sources['ign-canonical']['fallbackVerified'])
        self.assertEqual(sources['ign']['seriesId'], sources['ign-canonical']['seriesId'])


class PipelineTests(unittest.TestCase):
    def setUp(self):
        for guard in (patch.dict('os.environ', {}, clear=True),
                      patch('socket.create_connection', side_effect=AssertionError('real network forbidden'))):
            guard.start()
            self.addCleanup(guard.stop)

    def test_offline_never_uses_transport_or_content(self):
        with tempfile.TemporaryDirectory() as directory:
            http = FakeHTTP()
            with patch('content_processing.service_post') as post:
                data, manifest = run_pipeline(directory, True, NOW, http, small_config())
            self.assertEqual(http.urls, [])
            post.assert_not_called()
            self.assertEqual(data['news'], [])
            self.assertEqual(data['movements'], [])
            self.assertTrue(all(not b['items'] for b in data['rankings']))
            self.assertTrue(all(c['attemptedAt'] is None and c['status'] == 'not_attempted' for c in data['coverage']))
            self.assertIsNone(manifest['lastSuccessAt'])
            self.assertEqual(manifest['dates'], [])
            self.assertEqual(manifest['status'], 'unavailable')
            self.assertEqual(len(data['skills']), 2)

    def test_end_to_end_mock_public_collection(self):
        with tempfile.TemporaryDirectory() as directory, patch.dict('os.environ', {}, clear=True):
            http = FakeHTTP()
            data, manifest = run_pipeline(directory, False, NOW, http, small_config())
            validate_dashboard(data)
            self.assertEqual(len(data['news']), 1)
            self.assertIsNone(data['news'][0]['summary'])
            self.assertIsNone(data['news'][0]['insight'])
            self.assertEqual(manifest['latestDate'], '2026-09-23')
            self.assertTrue((Path(directory)/'2026-09-23.json').exists())
            self.assertEqual(len(data['movements']), 2)
            self.assertTrue(all(m['status'] == 'insufficient' for m in data['movements']))
            self.assertNotIn('7656119', json.dumps(data))
            mobile = [b for b in data['rankings'] if b['platform'] == 'mobile']
            self.assertEqual({b['metric'] for b in mobile}, {'popularity', 'reputation', 'commercial'})
            self.assertTrue(all(not b['items'] and b['reason'] for b in mobile))
            first = next(b for b in data['rankings'] if b['id'] == 'steam-popularity')['items'][0]
            self.assertIsNone(first['rankChange'])
            self.assertEqual(len([url for url in http.urls if '/appreviews/' in url and 'filter=all' in url]), 2)

    def test_pipeline_processes_movements_through_the_content_channel(self):
        calls = []
        def post(url, token, api_key, payload):
            self.assertEqual((url, token, api_key), (ENV['CONTENT_PROCESS_URL'], ENV['CONTENT_SERVICE_TOKEN'], ENV['CONTENT_API_KEY']))
            self.assertNotIn(api_key, json.dumps(payload))
            self.assertNotIn(token, json.dumps(payload))
            calls.append(payload)
            material = payload['items'][0]
            if payload.get('kind') == 'movement':
                return {'items': [{'id': material['id'], 'gameId': material['gameId'],
                    'positive': [{'text': '有限匿名样本认可战斗更新。', 'evidenceId': 'e1'}], 'negative': [], 'events': [],
                    'insight': {'text': 'AI 推论：可进一步调查战斗反馈，当前样本不能代表总体。', 'citations': ['e1']},
                    'processing': {'status': 'processed', 'reason': '', 'cached': False}}]}
            return {'items': [{'id': material['id'], 'title': '游戏发行', 'summary': '游戏发布更新。',
                'insight': 'AI 推论：可关注更新节奏，但效果尚未知。', 'categories': [], 'platforms': [], 'markets': [], 'games': [],
                'processing': {'status': 'processed', 'reason': '', 'cached': False}}]}
        with tempfile.TemporaryDirectory() as directory, patch.dict('os.environ', ENV):
            data, _ = run_pipeline(directory, False, NOW, FakeHTTP(), small_config(), post=post)
            validate_dashboard(data)
            self.assertEqual(len(calls), 3)
            self.assertEqual(sum(p.get('kind') == 'movement' for p in calls), 2)
            for card in data['movements']:
                self.assertTrue(card['insight'].startswith('AI 推论：'))
                self.assertEqual(card['negative'], [])
                self.assertNotIn('未对玩家动向调用模型', ''.join(card['limitations']))
                self.assertIn('公共内容预算入口', ''.join(card['limitations']))

    def test_public_files_never_contain_generated_credentials_or_error_details(self):
        for secret in (ENV['CONTENT_API_KEY'], ENV['CONTENT_SERVICE_TOKEN']):
            for failure in ('generated', 'error', 'exception'):
                def post(url, token, api_key, payload):
                    if failure == 'exception':
                        raise TimeoutError('upstream-trace ' + secret)
                    material = payload['items'][0]
                    processing = {'status': 'processed', 'reason': 'upstream-trace ' + secret, 'cached': False}
                    if failure == 'error':
                        processing.update(status='unavailable', code='budget')
                    if payload.get('kind') == 'movement':
                        return {'items': [{'id': material['id'], 'gameId': material['gameId'],
                            'positive': [{'text': '匿名样本 ' + secret, 'evidenceId': 'e1'}], 'negative': [], 'events': [],
                            'insight': None, 'processing': processing}]}
                    return {'items': [{'id': material['id'], 'title': '游戏更新', 'summary': '模型摘要 ' + secret,
                        'insight': 'AI 推论：待验证。', 'categories': [], 'platforms': [], 'markets': [], 'games': [],
                        'processing': processing}]}
                with tempfile.TemporaryDirectory() as directory, patch.dict('os.environ', ENV):
                    data, manifest = run_pipeline(directory, False, NOW, FakeHTTP(), small_config(), post=post)
                    validate_dashboard(data)
                    self.assertIsNone(data['news'][0]['summary'])
                    self.assertTrue(all(row['insight'] is None for row in data['movements']))
                    for path in Path(directory).glob('*.json'):
                        text = path.read_text(encoding='utf-8')
                        self.assertNotIn(secret, text)
                        self.assertNotIn('upstream-trace', text)
                    self.assertIsNotNone(manifest['lastSuccessAt'])

    def test_history_cache_survives_missing_and_rotated_keys_in_pipeline(self):
        def success(url, token, api_key, payload):
            material = payload['items'][0]
            if payload.get('kind') == 'movement':
                return {'items': []}
            return {'items': [{'id': material['id'], 'title': '游戏更新', 'summary': '游戏发布了更新。',
                'insight': 'AI 推论：更新效果尚需观察。', 'categories': [], 'platforms': [], 'markets': [], 'games': [],
                'processing': {'status': 'processed', 'reason': '', 'cached': False}}]}
        with tempfile.TemporaryDirectory() as directory:
            with patch.dict('os.environ', ENV):
                first, _ = run_pipeline(directory, False, NOW, FakeHTTP(), small_config(), post=success)
            self.assertIsNotNone(first['news'][0]['summary'])
            for field, value in (('CONTENT_API_KEY', ''), ('CONTENT_SERVICE_TOKEN', ''), ('CONTENT_API_KEY', 'sk-new9d8c7b6a5432')):
                calls = []
                def post(url, token, api_key, payload):
                    calls.append(payload)
                    return success(url, token, api_key, payload)
                with patch.dict('os.environ', ENV | {field: value}):
                    data, _ = run_pipeline(directory, False, NOW + timedelta(minutes=1), FakeHTTP(), small_config(), post=post)
                    self.assertEqual(data['news'][0]['summary'], first['news'][0]['summary'])
                    self.assertIn('复用', data['news'][0]['processing']['reason'])
                    self.assertTrue(all(call.get('kind') == 'movement' for call in calls))
                    if not value:
                        self.assertEqual(calls, [])
                    for path in Path(directory).glob('*.json'):
                        text = path.read_text(encoding='utf-8')
                        self.assertNotIn(ENV['CONTENT_API_KEY'], text)
                        self.assertNotIn(ENV['CONTENT_SERVICE_TOKEN'], text)
                        if value:
                            self.assertNotIn(value, text)

    def test_reputation_threshold_and_current_candidate_union(self):
        with tempfile.TemporaryDirectory() as directory:
            http = FakeHTTP(total=99)
            data, _ = run_pipeline(directory, False, NOW, http, small_config())
            board = next(b for b in data['rankings'] if b['metric'] == 'reputation' and b['platform'] == 'pc')
            self.assertEqual(board['items'], [])
            self.assertEqual(board['queryParameters']['candidateIds'], ['steam:1', 'steam:2'])
            self.assertEqual(board['minimumSample'], 100)
            self.assertFalse(any('/appreviews/570' in url for url in http.urls))

    def test_partial_failure_retains_old_board_date_and_stale(self):
        with tempfile.TemporaryDirectory() as directory:
            old, _ = run_pipeline(directory, False, NOW, FakeHTTP(), small_config())
            next_day = NOW + timedelta(days=1)
            current, manifest = run_pipeline(directory, False, next_day, FakeHTTP(failures=('mostplayed',), now=next_day), small_config())
            board = next(b for b in current['rankings'] if b['id'] == 'steam-popularity')
            self.assertEqual(board['observedAt'], stamp(NOW))
            self.assertEqual(board['status'], 'stale')
            self.assertEqual(current['attemptedAt'], stamp(next_day))
            self.assertEqual(manifest['status'], 'partial')
            self.assertEqual(len(manifest['dates']), 2)

    def test_all_failure_preserves_latest_bytes_and_updates_manifest(self):
        with tempfile.TemporaryDirectory() as directory:
            old, _ = run_pipeline(directory, False, NOW, FakeHTTP(), small_config())
            path = Path(directory)/'latest.json'
            before = path.read_bytes()
            tomorrow = NOW + timedelta(days=1)
            _, manifest = run_pipeline(directory, False, tomorrow, FakeHTTP(failures=('https://',), now=tomorrow), small_config())
            self.assertEqual(path.read_bytes(), before)
            self.assertEqual(manifest['attemptedAt'], stamp(tomorrow))
            self.assertEqual(manifest['lastSuccessAt'], stamp(NOW))
            self.assertEqual(manifest['status'], 'stale')
            self.assertEqual(manifest['failedAt'], stamp(tomorrow))
            self.assertEqual(manifest['dates'], ['2026-09-23'])
            self.assertFalse((Path(directory)/'2026-09-24.json').exists())

    def test_skill_only_refresh_is_reused_without_claiming_news_success(self):
        configured = read_json(ROOT / 'config/skills.json')
        class SkillsOnlyHTTP(FakeHTTP):
            def get(self, url, allowed_hosts=()):
                if url.startswith('https://skills.sh/'):
                    self.urls.append(url)
                    row = next(row for row in configured if row['url'] == url)
                    return Response(skill_page(row), url, 'text/html')
                return super().get(url, allowed_hosts)
        with tempfile.TemporaryDirectory() as directory:
            checked = NOW + timedelta(days=8)
            http = SkillsOnlyHTTP(failures=('https://',), now=checked)
            data, manifest = run_pipeline(directory, False, checked, http, small_config())
            self.assertTrue(all(row['checkedAt'] == stamp(checked) for row in data['skills']))
            self.assertIsNone(manifest['lastSuccessAt'])
            self.assertEqual(manifest['dates'], [])
            for offline, later in ((False, checked + timedelta(days=1)), (True, checked + timedelta(days=2))):
                client = FakeHTTP(failures=('https://',), now=later)
                result, _ = run_pipeline(directory, offline, later, client, small_config())
                self.assertEqual(result['skills'], data['skills'])
                self.assertFalse(any('skills.sh' in url for url in client.urls))

    def test_skill_metadata_survives_news_failure_without_refreshing_old_news(self):
        configured = read_json(ROOT / 'config/skills.json')
        class SkillsHTTP(FakeHTTP):
            def get(self, url, allowed_hosts=()):
                if url.startswith('https://skills.sh/'):
                    self.urls.append(url)
                    row = next(row for row in configured if row['url'] == url)
                    return Response(skill_page(row), url, 'text/html')
                return super().get(url, allowed_hosts)
        with tempfile.TemporaryDirectory() as directory:
            old, _ = run_pipeline(directory, False, NOW, SkillsHTTP(), small_config())
            later = NOW + timedelta(days=8)
            data, manifest = run_pipeline(directory, False, later, SkillsHTTP(failures=('https://',), now=later), small_config())
            latest = read_json(Path(directory) / 'latest.json')
            for field in ('news', 'rankings', 'movements', 'coverage', 'dataDate', 'lastSuccessAt'):
                self.assertEqual(latest[field], old[field], field)
            self.assertEqual(latest['skills'], data['skills'])
            self.assertTrue(all(row['checkedAt'] == stamp(later) for row in latest['skills']))
            self.assertEqual(manifest['status'], 'stale')
            self.assertEqual(manifest['lastSuccessAt'], stamp(NOW))
            self.assertFalse((Path(directory) / (later.date().isoformat() + '.json')).exists())
            failure = later + timedelta(days=7)
            run_pipeline(directory, False, failure, FakeHTTP(failures=('https://',), now=failure), small_config())
            latest = read_json(Path(directory) / 'latest.json')
            self.assertTrue(all(row['status'] == 'unavailable' and row['checkedAt'] == stamp(later) for row in latest['skills']))
            self.assertEqual([row['popularity'] for row in latest['skills']], [row['popularity'] for row in data['skills']])
            retry = failure + timedelta(hours=1)
            recovered, _ = run_pipeline(directory, False, retry, SkillsHTTP(failures=('https://',), now=retry), small_config())
            self.assertTrue(all(row['checkedAt'] == stamp(retry) for row in recovered['skills']))
            expired = NOW + timedelta(days=31)
            client = SkillsHTTP(failures=('https://',), now=expired)
            recent, _ = run_pipeline(directory, False, expired, client, small_config())
            client = FakeHTTP(failures=('https://',), now=expired + timedelta(days=1))
            reused, _ = run_pipeline(directory, False, client.now, client, small_config())
            self.assertEqual(reused['skills'], recent['skills'])
            self.assertFalse(any('skills.sh' in url for url in client.urls))
            self.assertTrue(all(not snap['rankings'] for snap in load_history(Path(directory), client.now)))

    def test_offline_retains_existing_valid_latest(self):
        with tempfile.TemporaryDirectory() as directory:
            run_pipeline(directory, False, NOW, FakeHTTP(), small_config())
            before = (Path(directory)/'latest.json').read_bytes()
            data, manifest = run_pipeline(directory, True, NOW + timedelta(hours=1), FakeHTTP(), small_config())
            self.assertEqual(data['news'], [])
            self.assertEqual((Path(directory)/'latest.json').read_bytes(), before)
            self.assertEqual(manifest['status'], 'stale')

    def test_retention_only_near_30_dates(self):
        with tempfile.TemporaryDirectory() as directory:
            run_pipeline(directory, False, NOW, FakeHTTP(), small_config())
            tomorrow = NOW+timedelta(days=30)
            _, manifest = run_pipeline(directory, False, tomorrow, FakeHTTP(now=tomorrow), small_config())
            self.assertFalse((Path(directory)/'2026-09-23.json').exists())
            self.assertEqual(manifest['dates'], [tomorrow.date().isoformat()])

    def test_manifest_does_not_advertise_invalid_archives(self):
        with tempfile.TemporaryDirectory() as directory:
            atomic_json(Path(directory)/'2026-09-22.json', {'not': 'a dashboard'})
            _, manifest = run_pipeline(directory, False, NOW, FakeHTTP(), small_config())
            self.assertEqual(manifest['dates'], ['2026-09-23'])

    def test_no_history_compare_across_methodology_versions(self):
        with tempfile.TemporaryDirectory() as directory:
            run_pipeline(directory, False, NOW, FakeHTTP(), small_config())
            config = small_config()
            next(s for s in config['sources'] if s['id'] == 'steam-popularity')['methodologyVersion'] = 'v2'
            data, _ = run_pipeline(directory, False, NOW+timedelta(hours=1), FakeHTTP(), config)
            board = next(b for b in data['rankings'] if b['id'] == 'steam-popularity')
            self.assertTrue(all(row['rankChange'] is None for row in board['items']))

    def test_comparable_second_snapshot_not_daily(self):
        with tempfile.TemporaryDirectory() as directory:
            run_pipeline(directory, False, NOW, FakeHTTP(), small_config())
            data, _ = run_pipeline(directory, False, NOW+timedelta(hours=3), FakeHTTP(), small_config())
            board = next(b for b in data['rankings'] if b['id'] == 'steam-popularity')
            self.assertEqual(board['items'][0]['baselineAt'], stamp(NOW))
            self.assertEqual(board['items'][0]['rankChange'], 0)

    def test_pipeline_executes_configured_fallback_not_just_unit_stub(self):
        with tempfile.TemporaryDirectory() as directory:
            config = small_config()
            full = {s['id']: s for s in load_config()['sources']}
            config['sources'] = [full[s['id']] for s in config['sources']] + [full['ign-canonical']]
            http = FakeHTTP(failures=('feeds.ign.com',))
            data, _ = run_pipeline(directory, False, NOW, http, config)
            self.assertTrue(any('www.ign.com/rss/articles/feed' in url for url in http.urls))
            coverage = {row['id']: row for row in data['coverage']}
            self.assertEqual(coverage['ign']['status'], 'failed')
            self.assertEqual(coverage['ign-canonical']['status'], 'ok')
            self.assertEqual(data['news'][0]['sources'][0]['id'], 'ign-canonical')


class BoundaryTests(unittest.TestCase):
    def setUp(self):
        for guard in (patch.dict('os.environ', {}, clear=True),
                      patch('socket.create_connection', side_effect=AssertionError('real network forbidden'))):
            guard.start()
            self.addCleanup(guard.stop)

    def board(self, platform='pc'):
        board = board_template('popularity', {'url': 'https://store.steampowered.com/charts/mostplayed', 'methodologyVersion': 'v1'})
        board.update(items=parse_chart(chart(count=8), 'popularity'), status='ok', observedAt=stamp(NOW), platform=platform)
        return board

    def test_snapshot_comparability_includes_source_scope_unit_query(self):
        old = self.board()
        current = copy.deepcopy(old)
        current['observedAt'] = stamp(NOW+timedelta(hours=2))
        current['items'][0]['rank'] = 2
        apply_history(current, [{'rankings': [old]}])
        self.assertEqual(current['items'][0]['rankChange'], -1)
        for key, value in (('scope', 'other'), ('methodologyVersion', 'v2'), ('unit', 'downloads'), ('queryParameters', {'language': 'en'})):
            changed = copy.deepcopy(current)
            changed[key] = value
            apply_history(changed, [{'rankings': [old]}])
            self.assertIsNone(changed['items'][0]['rankChange'])
        changed = copy.deepcopy(current)
        changed['source']['id'] = 'other-platform'
        apply_history(changed, [{'rankings': [old]}])
        self.assertIsNone(changed['items'][0]['rankChange'])

    def test_platform_quotas_and_cross_platform_product_dedupe(self):
        pc, mobile = self.board(), self.board('mobile')
        mobile['id'] = 'mobile-board'
        for item in mobile['items']:
            item['gameId'] = item['gameId'].replace('steam', 'mobile')
        cards = select_movements([pc, mobile], {'mobile:1': 'steam:1'})
        self.assertEqual(len([c for c in cards if c['platform'] == 'pc']), 2)
        self.assertEqual(len([c for c in cards if c['platform'] == 'mobile']), 4)
        self.assertEqual(len({c['gameId'] for c in cards}), len(cards))
        self.assertEqual(len(select_movements([pc])), 2)
        self.assertEqual(len(select_movements([mobile])), 4)

    def test_stale_boards_not_dynamic_candidates(self):
        board = self.board()
        board['status'] = 'stale'
        self.assertEqual(select_movements([board]), [])

    def test_newly_entered_collected_board_requires_history(self):
        old, current = self.board(), self.board()
        current['observedAt'] = stamp(NOW+timedelta(hours=1))
        current['items'][-1]['gameId'] = 'steam:99'
        cards = select_movements([current], history=[{'rankings': [old]}])
        self.assertEqual(cards[0]['gameId'], 'steam:99')
        self.assertIn('不代表游戏首发', cards[0]['reason'])
        self.assertFalse(any('首次进入' in c['reason'] for c in select_movements([current])))

    def test_ranking_and_news_quota_rejection(self):
        with tempfile.TemporaryDirectory() as directory:
            data, _ = run_pipeline(directory, False, NOW, FakeHTTP(), small_config())
            bad = copy.deepcopy(data)
            bad['news'] = [copy.deepcopy(data['news'][0]) for _ in range(31)]
            with self.assertRaises(ValueError):
                validate_dashboard(bad)
            bad = copy.deepcopy(data)
            bad['rankings'][0]['items'] *= 11
            with self.assertRaises(ValueError):
                validate_dashboard(bad)
            bad = copy.deepcopy(data)
            bad['rankings'][0]['observedAt'] = stamp(NOW+timedelta(hours=1))
            with self.assertRaises(ValueError):
                validate_dashboard(bad)

    def test_reject_secret_fields_and_values(self):
        for value in ({'token': 'test'}, {'nested': {'steamid': 'id'}}, {'text': 'Bearer example-secret'}, {'text': 'player@example.com'}, {'text': '76561198012345678'}):
            with self.subTest(value=value), self.assertRaises(ValueError):
                privacy_check(value)
        for name in ('CONTENT_SERVICE_TOKEN', 'CONTENT_API_KEY'):
            # Does not match a generic key regex: exercises exact environment matching.
            secret = 'synthetic-private-value'
            with patch.dict('os.environ', {name: secret}):
                for value in ({'text': '内容 ' + secret}, {secret: 'value'}, {'nested': [secret]}):
                    with self.assertRaises(ValueError) as raised:
                        privacy_check(value)
                    self.assertNotIn(secret, str(raised.exception))
                self.assertEqual(safe_text('内容 ' + secret), '')
                self.assertEqual(safe_text('普通公开文本'), '普通公开文本')
        for value in ('sk-short', 'sk-A._~9-', ENV['CONTENT_API_KEY']):
            self.assertEqual(safe_text(value), '')
            with self.assertRaises(ValueError):
                privacy_check(value)
        for field in ('CONTENT_API_KEY', 'CONTENT_SERVICE_TOKEN', 'X-Content-API-Key'):
            with self.assertRaises(ValueError):
                privacy_check({field: ''})

    def test_public_urls(self):
        for value in ('http://example.com', 'https://localhost/', 'https://[::1]/', 'https://example.com/?api_key=x', 'https://user@example.com/', 'https://example.com:8443/'):
            self.assertIsNone(public_url(value))
        self.assertEqual(public_url('https://example.com/a'), 'https://example.com/a')

    def test_bad_publication_does_not_replace_latest(self):
        with tempfile.TemporaryDirectory() as directory:
            data, _ = run_pipeline(directory, False, NOW, FakeHTTP(), small_config())
            path = Path(directory)/'latest.json'
            before = path.read_bytes()
            data['news'][0]['token'] = 'must-not-publish'
            with self.assertRaises(ValueError):
                publish(Path(directory), data, True, NOW)
            self.assertEqual(path.read_bytes(), before)

    def test_atomic_replace_failure_leaves_old_file_and_no_temp(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)/'data.json'
            atomic_json(path, {'status': 'old'})
            with patch('public_data.os.replace', side_effect=OSError('disk failure')):
                with self.assertRaises(OSError):
                    atomic_json(path, {'status': 'new'})
            self.assertEqual(read_json(path), {'status': 'old'})
            self.assertEqual(len(list(Path(directory).iterdir())), 1)


if __name__ == '__main__':
    unittest.main()
