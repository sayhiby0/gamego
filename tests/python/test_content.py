import copy
from datetime import timedelta
import http.client
import json
from pathlib import Path
import sys
import unittest
from unittest.mock import MagicMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'scripts'))
from collectors import parse_feed
from content_processing import (CACHE_CONFIG_FIELDS, FAILURE_REASONS, content_hash, movement_input,
                                process_movements, process_news, service_post, validate_movement, validate_processed)
from public_data import CONTRACT, digest, privacy_check, stamp
from test_collectors import NOW, SOURCE, feed

# Synthetic values only. Every transport in this module is mocked.
ENV = {'CONTENT_PROCESS_URL': 'https://content.unit.test/internal/content',
       'CONTENT_SERVICE_TOKEN': 'unit-content-service-4f8c2d9e6a1b7053',
       'CONTENT_API_KEY': 'sk-unitContent9c4e2b7a6d5f8031'}
BAD_SETTINGS = (
    [('CONTENT_API_KEY', value) for value in ('', 'sk-sp-ordinaryNotAllowed', 'sk-placeholder', 'sk-your-key',
      'sk-replace-with-value', 'sk-CHANGE_THIS', 'sk-xxxx', 'sk-', 'sk-a\r\nInjected: yes',
      'sk-中文', 'sk-a b', 'sk-' + 'a' * 254, 'sk-' + 'a' * 253 + '=',
      'sk-' + 'a' * 15 + '=', 'sk-safeUnit9e8d7c6b5a4321===', 'sk-safeUnit9e8d7c6b5a4321=middle')] +
    [('CONTENT_SERVICE_TOKEN', value) for value in ('', 'short', 'replace-me-' * 4, 'your-token-' * 4,
      'x' * 32, 'token\r\n' + 'a' * 32, '令' * 32, 'a' * 513, 'sk-' + 'a' * 40)] +
    [('CONTENT_PROCESS_URL', value) for value in ('', 'http://127.0.0.1:8000/internal/content',
      'http://content.unit.test/internal/content', 'https://content.unit.test:8443/internal/content',
      'https://content.unit.test/v1/chat/completions', 'https://u:p@content.unit.test/internal/content',
      'https://content.unit.test/internal/content?key=x', 'https://content.unit.test/internal/content#fragment',
      'https://content.unit.test/internal/content#', 'https://content.unit.test/internal/content?',
      'https://content.unit.test/\ninternal/content', 'https://127.0.0.1/internal/content',
      'https://localhost/internal/content', 'https://example.com/internal/content',
      'https://your-worker.workers.dev/internal/content', 'https://content.invalid/internal/content')]
)


def valid_response(item):
    return {'id': item['id'], 'title': 'Steam 游戏发布更新', 'summary': '来源公告称该游戏发布更新。',
            'insight': '行业启发：可关注版本发布节奏，尚不能据此判断商业效果。',
            'categories': ['产品与版本'], 'platforms': ['pc'], 'markets': [], 'games': [],
            'processing': {'status': 'success', 'reason': ''}}


class ContentTests(unittest.TestCase):
    def setUp(self):
        for guard in (patch.dict('os.environ', {}, clear=True),
                      patch('socket.create_connection', side_effect=AssertionError('real network forbidden'))):
            guard.start()
            self.addCleanup(guard.stop)

    def item(self):
        return parse_feed(feed(), SOURCE)[0]

    def test_missing_or_unsafe_credential_and_endpoint_never_call(self):
        for field, value in BAD_SETTINGS:
            item = self.item()
            with self.subTest(field=field, value=value), patch.dict('os.environ', ENV | {field: value}), \
                    patch('content_processing.service_post') as post:
                process_news([item], [], post=post)
                post.assert_not_called()
            self.assertIsNone(item['summary'])
            self.assertIn('配置', item['processing']['reason'])

    def test_no_legacy_agent_or_byok_fallback(self):
        for missing in ('CONTENT_API_KEY', 'CONTENT_SERVICE_TOKEN'):
            env = ENV | {missing: '', 'UNUSED_LEGACY_TOKEN': ENV['CONTENT_SERVICE_TOKEN'],
                         'AGENT_API_KEY': ENV['CONTENT_API_KEY'], 'BYOK_API_KEY': ENV['CONTENT_API_KEY']}
            with patch.dict('os.environ', env), patch('content_processing.service_post') as post:
                process_news([self.item()], [], post=post)
                post.assert_not_called()

    def test_missing_configuration_has_no_paid_call(self):
        items = [self.item()]
        with patch.dict('os.environ', {}, clear=True), patch('content_processing.service_post') as post:
            process_news(items, [], post=post)
            post.assert_not_called()
        self.assertIsNone(items[0]['summary'])
        self.assertIsNone(items[0]['insight'])
        self.assertIn('未配置', items[0]['processing']['reason'])

    def test_offline_never_calls_configured_service(self):
        with patch.dict('os.environ', ENV), patch('content_processing.service_post') as post:
            process_news([self.item()], [], offline=True, post=post)
            post.assert_not_called()

    def test_exact_request_shape_and_success(self):
        items = [self.item()]
        def post(url, token, api_key, payload):
            self.assertEqual(url, ENV['CONTENT_PROCESS_URL'])
            self.assertEqual(token, ENV['CONTENT_SERVICE_TOKEN'])
            self.assertEqual(api_key, ENV['CONTENT_API_KEY'])
            self.assertNotIn(api_key, json.dumps(payload))
            self.assertNotIn(token, json.dumps(payload))
            self.assertEqual(set(payload), {'items'})
            self.assertEqual(set(payload['items'][0]), {'id', 'title', 'publishedAt', 'sources', 'evidence'})
            self.assertEqual(set(payload['items'][0]['sources'][0]), {'name', 'url'})
            self.assertLessEqual(len(payload['items'][0]['evidence']), 500)
            return {'items': [valid_response(items[0])]}
        with patch.dict('os.environ', ENV):
            process_news(items, [], post=post)
        self.assertEqual(items[0]['processing']['status'], 'success')
        self.assertIsNotNone(items[0]['summary'])
        self.assertEqual(items[0]['processing']['contentHash'], content_hash(items[0]))

    def test_internal_metadata_is_validated_but_not_published(self):
        item = self.item()
        row = valid_response(item)
        row['processing'].update(status='processed', cached=True, citations={
            'summary': [item['sources'][0]['url']], 'insight': [item['sources'][0]['url']]})
        self.assertEqual(set(validate_processed(row, item)['processing']), {'status', 'reason', 'contentHash'})
        for bad in ({'cached': 'true'}, {'citations': {'summary': [], 'insight': []}},
                    {'citations': {'summary': ['https://unknown.example.com/'], 'insight': [item['sources'][0]['url']]}},
                    {'unexpected': 'field'}):
            invalid = copy.deepcopy(row)
            invalid['processing'].update(bad)
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                validate_processed(invalid, item)

    def test_success_cache_by_raw_hash_no_repeat_charge(self):
        original = self.item()
        cached = copy.deepcopy(original)
        cached.update(validate_processed(valid_response(cached), cached))
        with patch.dict('os.environ', ENV), patch('content_processing.service_post') as post:
            process_news([original], [{'news': [cached]}], post=post)
            post.assert_not_called()
        self.assertEqual(original['summary'], cached['summary'])
        self.assertIn('复用', original['processing']['reason'])

    def test_cached_news_survives_missing_unsafe_and_rotated_credentials(self):
        cached = self.item()
        with patch.dict('os.environ', ENV):
            cached.update(validate_processed(valid_response(cached), cached))
        cases = BAD_SETTINGS + [('CONTENT_API_KEY', 'sk-rotated8d7c6b5a4321'),
                                ('CONTENT_SERVICE_TOKEN', 'rotated-service-8d7c6b5a43210987654321')]
        for field, value in cases:
            item = self.item()
            with self.subTest(field=field, value=value), patch.dict('os.environ', ENV | {field: value}), \
                    patch('content_processing.service_post') as post:
                process_news([item], [{'news': [cached]}], post=post)
                post.assert_not_called()
                self.assertEqual(content_hash(item), cached['processing']['contentHash'])
            self.assertEqual(item['summary'], cached['summary'])
            self.assertIn('复用', item['processing']['reason'])
        item = self.item()
        with patch('content_processing.service_post') as post:
            process_news([item], [{'news': [cached]}], offline=True, post=post)
            post.assert_not_called()
        self.assertEqual(item['summary'], cached['summary'])

    def test_model_price_and_rule_changes_invalidate_history_without_new_public_fields(self):
        cached = self.item()
        with patch.dict('os.environ', ENV):
            cached.update(validate_processed(valid_response(cached), cached))
        for field in CACHE_CONFIG_FIELDS:
            item = self.item()
            with self.subTest(field=field), patch.dict('os.environ', ENV | {field: 'changed-local-setting'}), \
                    patch('content_processing.service_post', return_value={'items': [valid_response(item)]}) as post:
                process_news([item], [{'news': [cached]}], post=post)
                post.assert_called_once()
                self.assertNotEqual(content_hash(item), cached['processing']['contentHash'])
                self.assertEqual(set(item['processing']), {'status', 'reason', 'contentHash'})
        with patch('content_processing.CONTENT_RULE_VERSION', 'next-local-rule'):
            self.assertNotEqual(content_hash(cached), cached['processing']['contentHash'])
        legacy = copy.deepcopy(cached)
        legacy['processing']['contentHash'] = digest({'version': 1, 'title': cached['originalTitle'], 'evidence': cached['_evidence']})
        item = self.item()
        with patch('content_processing.service_post') as post:
            process_news([item], [{'news': [legacy]}], post=post)
            post.assert_not_called()
        self.assertIsNone(item['summary'])

    def test_cache_and_hash_never_accept_credentials_from_model_or_material(self):
        for field in ('title', 'summary', 'insight', 'games'):
            cached = self.item()
            cached.update(validate_processed(valid_response(cached), cached))
            cached[field] = ['游戏sk-old.synthetic'] if field == 'games' else '内容sk-old.synthetic'
            item = self.item()
            process_news([item], [{'news': [cached]}])
            self.assertIsNone(item['summary'])
        for field in ('originalTitle', '_evidence'):
            item = self.item()
            item[field] = '原文 ' + ENV['CONTENT_API_KEY']
            with patch('content_processing.digest') as hash_call, self.assertRaises(ValueError):
                content_hash(item)
            hash_call.assert_not_called()
        with patch.dict('os.environ', ENV | {'CONTENT_MODEL': ENV['CONTENT_API_KEY']}), \
                patch('content_processing.digest') as hash_call, self.assertRaises(ValueError):
            content_hash(self.item())
        hash_call.assert_not_called()

    def test_changed_original_is_processed_again(self):
        cached = self.item()
        cached.update(validate_processed(valid_response(cached), cached))
        changed = self.item()
        changed['_evidence'] += ' A different substantive sentence.'
        with patch.dict('os.environ', ENV), patch('content_processing.service_post', return_value={'items': [valid_response(changed)]}) as post:
            process_news([changed], [{'news': [cached]}], post=post)
            self.assertEqual(post.call_count, 1)
        self.assertNotEqual(content_hash(cached), content_hash(changed))

    def test_per_run_item_budget(self):
        items = [parse_feed(feed(title=f'Steam game release event {n}', url=f'https://example.com/{n}'), SOURCE)[0] for n in range(3)]
        def post(url, token, api_key, payload):
            self.assertEqual(len(payload['items']), 1)
            return {'items': [valid_response(items[0])]}
        with patch.dict('os.environ', ENV):
            process_news(items, [], max_items=1, post=post)
        self.assertIsNotNone(items[0]['summary'])
        self.assertIsNone(items[1]['summary'])
        self.assertIn('条数上限', items[1]['processing']['reason'])

    def test_each_request_is_bounded_and_failure_preserves_completed_items(self):
        items = [parse_feed(feed(title=f'Steam release {n}', url=f'https://example.com/{n}'), SOURCE)[0] for n in range(3)]
        items[0]['sources'] *= 8
        calls = []
        def post(url, token, api_key, payload):
            self.assertEqual(len(payload['items']), 1)
            self.assertLessEqual(len(payload['items'][0]['sources']), 6)
            calls.append(payload['items'][0]['id'])
            if len(calls) == 2:
                raise TimeoutError
            return {'items': [valid_response(items[0])]}
        with patch.dict('os.environ', ENV):
            process_news(items, [], post=post)
        self.assertEqual(calls, [items[0]['id'], items[1]['id']])
        self.assertEqual(items[0]['processing']['status'], 'success')
        self.assertIsNone(items[1]['summary'])
        self.assertIn('不重试', items[2]['processing']['reason'])

    def test_processing_total_deadline_keeps_completed_results(self):
        items = [parse_feed(feed(title=f'Steam release {n}', url=f'https://example.com/{n}'), SOURCE)[0] for n in range(2)]
        with patch.dict('os.environ', ENV), patch('content_processing.time.monotonic', side_effect=[0, 0, 171]), \
                patch('content_processing.service_post', return_value={'items': [valid_response(items[0])]}) as post:
            process_news(items, [], post=post)
        self.assertEqual(post.call_count, 1)
        self.assertEqual(items[0]['processing']['status'], 'success')
        self.assertIn('总时限', items[1]['processing']['reason'])

    def test_budget_denial_keeps_title_no_retry(self):
        item = self.item()
        denied = valid_response(item)
        denied.update(summary=None, insight=None, processing={'status': 'unavailable', 'code': 'budget', 'reason': 'untrusted diagnostic'})
        with patch.dict('os.environ', ENV), patch('content_processing.service_post', return_value={'items': [denied]}) as post:
            process_news([item], [], post=post)
            self.assertEqual(post.call_count, 1)
        self.assertIsNone(item['summary'])
        self.assertIn('本月预算不足', item['processing']['reason'])
        self.assertNotIn('untrusted diagnostic', item['processing']['reason'])

    def test_failure_codes_are_allowlisted_and_never_echo_reasons(self):
        for code in [*FAILURE_REASONS, None, [], ENV['CONTENT_API_KEY'], 'unknown']:
            item = self.item()
            row = valid_response(item)
            row['processing'] = {'status': 'unavailable', 'code': code,
                                 'reason': 'upstream-trace ' + ENV['CONTENT_API_KEY'] + ENV['CONTENT_SERVICE_TOKEN']}
            with patch.dict('os.environ', ENV), patch('content_processing.service_post', return_value={'items': [row]}) as post:
                process_news([item], [], post=post)
                post.assert_called_once()
                privacy_check(item)
            text = json.dumps(item)
            for forbidden in ('upstream-trace', ENV['CONTENT_API_KEY'], ENV['CONTENT_SERVICE_TOKEN']):
                self.assertNotIn(forbidden, text)
            if isinstance(code, str) and code in FAILURE_REASONS:
                self.assertIn(FAILURE_REASONS[code], item['processing']['reason'])

    def test_success_reason_is_fixed_and_truthful(self):
        for cached in (False, True):
            item = self.item()
            row = valid_response(item)
            row['processing'].update(reason='upstream-trace: 已完成真实付费验证', cached=cached)
            with patch.dict('os.environ', ENV), patch('content_processing.service_post', return_value={'items': [row]}) as post:
                process_news([item], [], post=post)
            self.assertNotIn('upstream-trace', json.dumps(item))
            self.assertIn('本地结构校验', item['processing']['reason'])
            self.assertEqual('服务报告复用缓存' in item['processing']['reason'], cached)

    def test_transport_exceptions_are_not_reflected_or_retried(self):
        for error in (TimeoutError, ValueError, http.client.HTTPException, RuntimeError):
            items = [self.item(), self.item()]
            with patch.dict('os.environ', ENV), patch('content_processing.service_post', side_effect=error(
                    'upstream-trace ' + ENV['CONTENT_API_KEY'] + ENV['CONTENT_SERVICE_TOKEN'])) as post:
                process_news(items, [], post=post)
                post.assert_called_once()
                privacy_check(items)
            self.assertNotIn('upstream-trace', json.dumps(items))
            self.assertIsNone(items[1]['summary'])

    def test_network_failure_is_degraded_not_raised(self):
        item = self.item()
        with patch.dict('os.environ', ENV), patch('content_processing.service_post', side_effect=TimeoutError) as post:
            process_news([item], [], post=post)
            self.assertEqual(post.call_count, 1)
        self.assertIsNone(item['summary'])
        self.assertIn('不重试', item['processing']['reason'])

    def test_invalid_outputs_not_published(self):
        for kind in ('unknown_field', 'secret', 'profile', 'link', 'english', 'unknown_id', 'duplicate', 'html'):
            with self.subTest(kind=kind):
                item = self.item()
                row = valid_response(item)
                if kind == 'unknown_field': row['systemPrompt'] = 'not allowed'
                if kind == 'secret': row['summary'] = '内容 ' + ENV['CONTENT_SERVICE_TOKEN']
                if kind == 'profile': row['summary'] = '玩家 player@example.com 说好玩'
                if kind == 'link': row['insight'] += ' https://unverified.example.com/'
                if kind == 'english': row['summary'] = 'Copied English title'
                if kind == 'unknown_id': row['id'] = 'not-in-request'
                if kind == 'html': row['summary'] = '<script>alert(1)</script> 游戏'
                response = {'items': [row, row] if kind == 'duplicate' else [row]}
                with patch.dict('os.environ', ENV), patch('content_processing.service_post', return_value=response) as post:
                    process_news([item], [], post=post)
                self.assertIsNone(item['summary'])
                self.assertIsNone(item['insight'])

    def test_generated_fields_cannot_leak_either_credential(self):
        for secret in (ENV['CONTENT_API_KEY'], ENV['CONTENT_SERVICE_TOKEN'], 'sk-short'):
            for field in ('title', 'summary', 'insight', 'games', 'reason'):
                item = self.item()
                row = valid_response(item)
                if field == 'reason':
                    row['processing']['reason'] = secret
                else:
                    row[field] = ['游戏 ' + secret] if field == 'games' else '模型文本 ' + secret
                with patch.dict('os.environ', ENV), patch('content_processing.service_post', return_value={'items': [row]}) as post:
                    process_news([item], [], post=post)
                self.assertIsNone(item['summary'])
                self.assertNotIn(secret, json.dumps(item))


class ServicePostTests(unittest.TestCase):
    def setUp(self):
        for guard in (patch.dict('os.environ', ENV, clear=True),
                      patch('socket.create_connection', side_effect=AssertionError('real network forbidden'))):
            guard.start()
            self.addCleanup(guard.stop)
        self.connection = MagicMock()
        self.response = self.connection.getresponse.return_value
        self.response.status = 200
        self.response.headers = {}
        self.response.read1.side_effect = [b'{"items": []}', b'']
        guard = patch('content_processing.http.client.HTTPSConnection', return_value=self.connection)
        self.factory = guard.start()
        self.addCleanup(guard.stop)

    def send(self, **overrides):
        values = ENV | overrides
        return service_post(values['CONTENT_PROCESS_URL'], values['CONTENT_SERVICE_TOKEN'],
                            values['CONTENT_API_KEY'], {'items': []})

    def test_https_dual_headers_and_credential_free_body_and_idempotency(self):
        self.assertEqual(self.send(), {'items': []})
        self.factory.assert_called_once_with('content.unit.test', port=None, timeout=70)
        self.connection.set_debuglevel.assert_called_once_with(0)
        request = self.connection.request.call_args
        self.assertEqual(request.args, ('POST', '/internal/content'))
        self.assertEqual(json.loads(request.kwargs['body']), {'items': []})
        headers = request.kwargs['headers']
        self.assertEqual(headers['Authorization'], 'Bearer ' + ENV['CONTENT_SERVICE_TOKEN'])
        self.assertEqual(headers['X-Content-API-Key'], ENV['CONTENT_API_KEY'])
        self.assertEqual(headers['Idempotency-Key'], digest({'items': []}))
        self.assertEqual(set(headers), {'Authorization', 'X-Content-API-Key', 'Content-Type', 'Accept',
                                        'Accept-Encoding', 'Idempotency-Key', 'Connection'})
        self.connection.close.assert_called_once()
        for key in ('sk-safeUnit9e8d7c6b5a4321', 'sk-' + 'a' * 16, 'sk-' + 'a' * 253,
                    'sk-AbCd.~+/ef012345_6789==', 'sk-' + 'a' * 252 + '=', 'sk-' + 'a' * 251 + '=='):
            self.response.read1.side_effect = [b'{"items": []}', b'']
            self.send(CONTENT_API_KEY=key)
            self.assertEqual(self.connection.request.call_args.kwargs['headers']['X-Content-API-Key'], key)
            self.assertEqual(self.connection.request.call_args.kwargs['headers']['Idempotency-Key'], headers['Idempotency-Key'])

    def test_missing_invalid_and_untrusted_configuration_cannot_open_connection(self):
        for field, value in BAD_SETTINGS:
            with self.subTest(field=field, value=value), self.assertRaises(ValueError):
                self.send(**{field: value})
        with self.assertRaises(ValueError):
            self.send(CONTENT_PROCESS_URL='https://untrusted.unit.test/internal/content')
        self.factory.assert_not_called()

    def test_all_redirects_and_http_errors_stop_without_reading_or_following(self):
        for status in (301, 302, 303, 307, 308, 401, 403, 429, 500):
            self.factory.reset_mock()
            self.connection.reset_mock()
            self.response.status = status
            self.response.headers = {'Location': 'https://elsewhere.unit.test/' + ENV['CONTENT_API_KEY']}
            with self.subTest(status=status), self.assertRaises(ValueError) as raised:
                self.send()
            self.assertNotIn(ENV['CONTENT_API_KEY'], str(raised.exception))
            self.factory.assert_called_once()
            self.connection.request.assert_called_once()
            self.response.read1.assert_not_called()
            self.connection.close.assert_called_once()

    def test_request_response_and_close_exceptions_hide_credentials(self):
        for method in ('request', 'getresponse', 'close'):
            with patch.object(self.connection, method, side_effect=OSError('upstream-trace ' + ENV['CONTENT_API_KEY'])), \
                    self.assertRaises(ValueError) as raised:
                self.response.read1.side_effect = [b'{"items": []}', b'']
                self.send()
            self.assertNotIn(ENV['CONTENT_API_KEY'], str(raised.exception))
            self.assertNotIn('upstream-trace', str(raised.exception))
            self.assertTrue(raised.exception.__suppress_context__)

    def test_payload_credentials_never_reach_hash_or_connection(self):
        for secret in (ENV['CONTENT_API_KEY'], ENV['CONTENT_SERVICE_TOKEN']):
            for payload in ({'items': [secret]}, {secret: []}):
                with patch('content_processing.digest') as hash_call, self.assertRaises(ValueError):
                    service_post(ENV['CONTENT_PROCESS_URL'], ENV['CONTENT_SERVICE_TOKEN'], ENV['CONTENT_API_KEY'], payload)
                hash_call.assert_not_called()
        self.factory.assert_not_called()

    def test_model_echo_is_rejected_at_transport_boundary(self):
        cases = ({'CONTENT_API_KEY': ENV['CONTENT_API_KEY']},
                 {'CONTENT_SERVICE_TOKEN': 'changed-service-token-4f8c2d9e6a1b7053'})
        for overrides in cases:
            secret = next(iter(overrides.values()))
            self.connection.reset_mock()
            self.response.read1.side_effect = [json.dumps({'items': [secret]}).encode(), b'']
            with self.assertRaises(ValueError) as raised:
                self.send(**overrides)
            self.assertNotIn(secret, str(raised.exception))
            self.connection.request.assert_called_once()


class MovementContentTests(unittest.TestCase):
    def setUp(self):
        for guard in (patch.dict('os.environ', {}, clear=True),
                      patch('socket.create_connection', side_effect=AssertionError('real network forbidden'))):
            guard.start()
            self.addCleanup(guard.stop)

    def test_missing_unsafe_credentials_and_endpoints_preserve_evidence_without_call(self):
        for field, value in BAD_SETTINGS:
            item = self.item()
            original = copy.deepcopy(item['positive'])
            with self.subTest(field=field, value=value), patch.dict('os.environ', ENV | {field: value}), \
                    patch('content_processing.service_post') as post:
                process_movements([item], post=post, now=NOW)
                post.assert_not_called()
            self.assertIsNone(item['insight'])
            self.assertEqual(item['positive'], original)

    def test_failures_and_success_never_echo_upstream_reason(self):
        for status, code in (('unavailable', 'budget'), ('unavailable', 'unknown'), ('processed', None)):
            item = self.item()
            row = self.reply(movement_input(item, NOW))['items'][0]
            row['processing'].update(status=status, reason='upstream-trace: 任意上游消息')
            if code:
                row['processing']['code'] = code
            with patch.dict('os.environ', ENV), patch('content_processing.service_post', return_value={'items': [row]}) as post:
                process_movements([item], post=post, now=NOW)
            self.assertNotIn('upstream-trace', json.dumps(item))
            if code == 'budget':
                self.assertIn('本月预算不足', ''.join(item['limitations']))
            if status == 'processed':
                self.assertIsNotNone(item['insight'])

    def test_model_fields_and_exceptions_never_leak_credentials(self):
        for secret in (ENV['CONTENT_API_KEY'], ENV['CONTENT_SERVICE_TOKEN'], 'sk-short'):
            for field in ('positive', 'insight', 'reason', 'code'):
                item = self.item()
                original = copy.deepcopy(item['positive'])
                row = self.reply(movement_input(item, NOW))['items'][0]
                if field == 'positive': row[field][0]['text'] = '生成文本 ' + secret
                if field == 'insight': row[field]['text'] = 'AI 推论：' + secret
                if field == 'reason': row['processing']['reason'] = secret
                if field == 'code': row['processing'].update(status='unavailable', code=secret, reason=secret)
                with patch.dict('os.environ', ENV), patch('content_processing.service_post', return_value={'items': [row]}) as post:
                    process_movements([item], post=post, now=NOW)
                self.assertEqual(item['positive'], original)
                self.assertIsNone(item['insight'])
                self.assertNotIn(secret, json.dumps(item))
        items = [self.item(), self.item()]
        with patch.dict('os.environ', ENV), patch('content_processing.service_post', side_effect=TimeoutError(
                'upstream-trace ' + ENV['CONTENT_API_KEY'])) as post:
            process_movements(items, post=post, now=NOW)
            post.assert_called_once()
            privacy_check(items)
        self.assertNotIn('upstream-trace', json.dumps(items))

    def item(self):
        value = copy.deepcopy(CONTRACT['movement'])
        url = 'https://store.steampowered.com/appreviews/570?json=1'
        value.update(id='movement-570', gameId='steam:570', name='Dota 2', observedAt=stamp(NOW),
                     sources=[{'id': 'reviews', 'name': 'Steam 匿名评价', 'url': url}],
                     positive=[{'text': stamp(NOW - timedelta(days=1)) + ' · 匿名原文节选：Combat is great.', 'sourceUrl': url}])
        return value

    def reply(self, material):
        return {'items': [{'id': material['id'], 'gameId': material['gameId'],
                          'positive': [{'text': '该匿名样本认可战斗体验。', 'evidenceId': 'e1'}], 'negative': [], 'events': [],
                          'insight': {'text': 'AI 推论：可进一步调查战斗体验反馈，单一样本不能代表整体口碑。', 'citations': ['e1']},
                          'processing': {'status': 'processed', 'reason': '通过校验', 'cached': False}}]}

    def test_missing_and_offline_leave_original_evidence_without_requests(self):
        for env, offline in (({}, False), (ENV, True)):
            item = self.item()
            original = copy.deepcopy(item['positive'])
            with patch.dict('os.environ', env, clear=True), patch('content_processing.service_post') as post:
                process_movements([item], offline=offline, post=post, now=NOW)
                post.assert_not_called()
            self.assertEqual(item['positive'], original)
            self.assertIsNone(item['insight'])
            self.assertRegex(''.join(item['limitations']), '离线|未配置')

    def test_success_keeps_evidence_date_source_and_missing_negative(self):
        item = self.item()
        def post(url, token, api_key, payload):
            self.assertEqual(url, ENV['CONTENT_PROCESS_URL'])
            self.assertEqual(token, ENV['CONTENT_SERVICE_TOKEN'])
            self.assertEqual(api_key, ENV['CONTENT_API_KEY'])
            self.assertNotIn(token, json.dumps(payload))
            self.assertNotIn(api_key, json.dumps(payload))
            self.assertEqual(payload['kind'], 'movement')
            self.assertEqual(len(payload['items']), 1)
            self.assertEqual(payload['items'][0]['evidence'][0]['kind'], 'positive')
            return self.reply(payload['items'][0])
        with patch.dict('os.environ', ENV):
            process_movements([item], post=post, now=NOW)
        self.assertEqual(item['negative'], [])
        self.assertIn('AI 整理', item['positive'][0]['text'])
        self.assertTrue(item['positive'][0]['text'].startswith(stamp(NOW - timedelta(days=1))))
        self.assertEqual(item['positive'][0]['sourceUrl'], item['sources'][0]['url'])
        self.assertTrue(item['insight'].startswith('AI 推论：'))
        self.assertEqual(set(item), set(CONTRACT['movement']))

    def test_missing_dates_old_future_or_undeclared_sources_never_become_evidence(self):
        for date in ('', 'not-a-date', stamp(NOW + timedelta(seconds=1)), stamp(NOW - timedelta(days=7, seconds=1))):
            item = self.item()
            item['positive'][0]['text'] = date + ' · 匿名原文：test'
            self.assertEqual(movement_input(item, NOW)['evidence'], [])
        item = self.item()
        item['positive'][0]['sourceUrl'] = 'https://other.example.com/'
        with patch.dict('os.environ', ENV), patch('content_processing.service_post') as post:
            process_movements([item], post=post, now=NOW)
            post.assert_not_called()
        self.assertIn('没有带日期', ''.join(item['limitations']))
        item = self.item()
        item['positive'][0]['text'] = stamp(NOW - timedelta(days=7)) + ' · 匿名原文：test'
        self.assertEqual(len(movement_input(item, NOW)['evidence']), 1)

    def test_bad_output_never_overwrites_original_evidence(self):
        for failure in ('kind', 'identity', 'citation', 'html', 'url', 'english', 'secret', 'inference', 'cached', 'empty'):
            item = self.item()
            original = copy.deepcopy(item)
            row = self.reply(movement_input(item, NOW))['items'][0]
            if failure == 'kind': row['negative'] = row.pop('positive'); row['positive'] = []
            if failure == 'identity': row['gameId'] = 'steam:730'
            if failure == 'citation': row['positive'][0]['evidenceId'] = 'unknown'
            if failure == 'html': row['positive'][0]['text'] = '<script>中文</script>'
            if failure == 'url': row['positive'][0]['text'] = '来源 https://evil.test/'
            if failure == 'english': row['positive'][0]['text'] = 'Only English'
            if failure == 'secret': row['positive'][0]['text'] = '服务密钥' + ENV['CONTENT_SERVICE_TOKEN']
            if failure == 'inference': row['insight']['citations'] = ['unknown']
            if failure == 'cached': row['processing']['cached'] = 'yes'
            if failure == 'empty': row.update(positive=[], insight=None)
            with self.subTest(failure=failure), patch.dict('os.environ', ENV), patch('content_processing.service_post', return_value={'items': [row]}) as post:
                process_movements([item], post=post, now=NOW)
            self.assertEqual(item['positive'], original['positive'])
            self.assertIsNone(item['insight'])

    def test_insight_only_keeps_cited_evidence_dates_and_public_reference_labels(self):
        item = self.item()
        event = {'text': stamp(NOW - timedelta(hours=2)) + ' · 官方公告：新地图开放测试。',
                 'sourceUrl': 'https://store.steampowered.com/news/app/570/view/1'}
        item['events'] = [event]
        item['sources'].append({'id': 'announcement', 'name': '官方公告', 'url': event['sourceUrl']})
        response = self.reply(movement_input(item, NOW))
        response['items'][0].update(positive=[], insight={'text': 'AI 推论：地图更新值得观察，效果尚不明确。', 'citations': ['e2']})
        with patch.dict('os.environ', ENV), patch('content_processing.service_post', return_value=response) as post:
            process_movements([item], post=post, now=NOW)
        self.assertIn('[e1]', item['positive'][0]['text'])
        self.assertIn('Combat is great.', item['positive'][0]['text'])
        self.assertIn('[e2]', item['events'][0]['text'])
        self.assertTrue(item['events'][0]['text'].startswith(stamp(NOW - timedelta(hours=2))))
        self.assertIn('新地图开放测试', item['events'][0]['text'])
        self.assertEqual(item['events'][0]['sourceUrl'], event['sourceUrl'])
        self.assertIn('AI 推论引用：[e2]', item['limitations'])
        self.assertTrue(item['insight'].startswith('AI 推论：'))
        self.assertEqual(item['negative'], [])
        self.assertEqual(set(item), set(CONTRACT['movement']))

    def test_duplicate_model_citations_cannot_overwrite_evidence_or_drop_groups(self):
        item = self.item()
        original = copy.deepcopy(item['positive'])
        response = self.reply(movement_input(item, NOW))
        response['items'][0]['positive'] *= 2
        with patch.dict('os.environ', ENV), patch('content_processing.service_post', return_value=response) as post:
            process_movements([item], post=post, now=NOW)
        self.assertEqual(item['positive'], original)
        self.assertIsNone(item['insight'])

    def test_null_insight_is_truthful_when_an_evidence_group_remains(self):
        item = self.item()
        response = self.reply(movement_input(item, NOW))
        response['items'][0]['insight'] = None
        with patch.dict('os.environ', ENV), patch('content_processing.service_post', return_value=response) as post:
            process_movements([item], post=post, now=NOW)
        self.assertIsNone(item['insight'])
        self.assertIn('不足以形成', ''.join(item['limitations']))
        self.assertIn('AI 整理', item['positive'][0]['text'])

    def test_timeout_preserves_completed_result_and_does_not_retry(self):
        items = [self.item() for _ in range(3)]
        calls = []
        def post(url, token, api_key, payload):
            calls.append(payload)
            if len(calls) == 2:
                raise TimeoutError
            return self.reply(payload['items'][0])
        with patch.dict('os.environ', ENV):
            process_movements(items, post=post, now=NOW)
        self.assertEqual(len(calls), 2)
        self.assertIsNotNone(items[0]['insight'])
        self.assertIsNone(items[1]['insight'])
        self.assertIn('不重试', ''.join(items[2]['limitations']))

    def test_shared_deadline_and_six_game_limit(self):
        with patch.dict('os.environ', ENV), patch('content_processing.time.monotonic', return_value=171), patch('content_processing.service_post') as post:
            item = self.item()
            process_movements([item], now=NOW, deadline=240, post=post)
            post.assert_not_called()
            self.assertIn('总时限', ''.join(item['limitations']))
        calls = []
        def post(url, token, api_key, payload):
            calls.append(payload)
            return self.reply(payload['items'][0])
        with patch.dict('os.environ', ENV):
            items = [self.item() for _ in range(7)]
            process_movements(items, now=NOW, post=post)
        self.assertEqual(len(calls), 6)
        self.assertIsNone(items[-1]['insight'])


if __name__ == '__main__':
    unittest.main()
