"""Bounded public content processing; credentials travel only in dedicated HTTPS headers."""
from __future__ import annotations

import http.client
import json
import os
import re
import time
from datetime import datetime, timedelta
from urllib.parse import urlsplit

from public_data import CATEGORIES, UTC, digest, parse_date, privacy_check, public_url, stamp, strings_check

FIELDS = {'id', 'title', 'summary', 'insight', 'categories', 'platforms', 'markets', 'games', 'processing'}
REQUEST_SECONDS = 70
PROCESS_SECONDS = 240
# Local validation revision, not an attestation of the backend's model or prompt.
CONTENT_RULE_VERSION = 'public-content-v2'
CACHE_CONFIG_FIELDS = ('CONTENT_MODEL', 'CONTENT_BASE_URL', 'CONTENT_PROVIDER', 'CONTENT_PROTOCOL',
                       'CONTENT_KEY_TYPE', 'CONTENT_PRICE_MODEL', 'CONTENT_PRICE_VERSION',
                       'CONTENT_INPUT_MICROS_PER_MILLION', 'CONTENT_OUTPUT_MICROS_PER_MILLION',
                       'CONTENT_MAX_OUTPUT_TOKENS', 'CONTENT_ENABLE_SEARCH', 'CONTENT_ENABLE_THINKING')
FAILURE_REASONS = {
    'disabled': '公共内容模型未配置或未启用',
    'configuration': '公共内容模型配置不受支持',
    'price': '公共内容模型价格未确认',
    'budget': '公共内容本月预算不足',
    'input': '公共内容输入超过限制',
    'provider': '模型服务失败，已受理调用仍可能收费',
    'usage': '模型用量未通过校验，费用仍可能保留预占',
    'output': '模型输出未通过结构或引用校验',
    'aborted': '任务已停止或超时，已受理调用仍可能收费',
}


def placeholder(value):
    return bool(re.search(r'(?i)change[-_]?(?:me|this)|replace[-_]?(?:me|with|this)|placeholder|your[-_]|example|dummy|paste[-_]|<|>|\$\{|\{\{|待填写|请填写', value)
                or re.fullmatch(r'(?i)(?:sk-)?(?:x+|0+|todo|test|sample|key|token|secret)', value))


def checked_settings(url, token, api_key):
    # The endpoint is an operator-controlled, fixed URL, never supplied by source material.
    if (not url or placeholder(url) or not public_url(url)
            or not re.fullmatch(r'https://[A-Za-z0-9.-]+(?::443)?/internal/content', url)):
        raise ValueError('invalid public content configuration')
    u = urlsplit(url)
    if any(not re.fullmatch(r'[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?', label)
           for label in u.hostname.split('.')) or u.hostname.endswith('.invalid'):
        raise ValueError('invalid public content configuration')
    if (not isinstance(token, str) or not 32 <= len(token) <= 512 or placeholder(token)
            or not re.fullmatch(r'[A-Za-z0-9._~+/-]+={0,2}', token)
            or token.lower().startswith('sk-')):
        raise ValueError('invalid public content configuration')
    if (not isinstance(api_key, str) or len(api_key) > 256 or placeholder(api_key)
            or not re.fullmatch(r'sk-[A-Za-z0-9._~+/-]{16,253}={0,2}', api_key) or api_key.lower().startswith('sk-sp-')):
        raise ValueError('invalid public content configuration')
    return u


def content_settings():
    values = tuple(os.environ.get(name, '') for name in ('CONTENT_PROCESS_URL', 'CONTENT_SERVICE_TOKEN', 'CONTENT_API_KEY'))
    try:
        checked_settings(*values)
    except (ValueError, TypeError):
        return None
    return values


def failure_reason(row, fallback):
    # Free-form reasons, upstream error messages and unknown codes are never reflected.
    p = row.get('processing') if isinstance(row, dict) else None
    if isinstance(p, dict) and p.get('status') == 'unavailable' and isinstance(p.get('code'), str):
        detail = FAILURE_REASONS.get(p['code'])
        if detail:
            return detail + '；不发布模型文本，保留原始公开证据'
    return fallback


def content_hash(item):
    # No credential or endpoint identity: key rotation/missing credentials permit history reuse.
    # Old raw-only hashes intentionally miss. Backend-only changes need a future fingerprint contract.
    value = {'version': CONTENT_RULE_VERSION, 'title': item['originalTitle'], 'evidence': item['_evidence'],
             'configuration': {name: os.environ.get(name, '') for name in CACHE_CONFIG_FIELDS}}
    privacy_check(value)
    return digest(value)


def validate_processed(row, item):
    if not isinstance(row, dict) or set(row) != FIELDS or row['id'] != item['id']:
        raise ValueError('content response fields/id mismatch')
    privacy_check(row)
    p = row['processing']
    if not isinstance(p, dict) or set(p) - {'status', 'reason', 'cached', 'citations'} or p.get('status') not in ('success', 'ok', 'processed'):
        raise ValueError('content service did not successfully process item')
    if not isinstance(p.get('reason', ''), str) or ('cached' in p and type(p['cached']) is not bool):
        raise ValueError('invalid processing metadata')
    if 'citations' in p:
        citations = p['citations']
        if not isinstance(citations, dict) or set(citations) != {'summary', 'insight'}:
            raise ValueError('invalid processing citations')
        allowed = {s['url'] for s in item['sources']}
        for urls in citations.values():
            if not isinstance(urls, list) or not 1 <= len(urls) <= 6 or any(not isinstance(url, str) or url not in allowed for url in urls):
                raise ValueError('unverified processing citation')
    for key in ('title', 'summary', 'insight'):
        value = row[key]
        if not isinstance(value, str) or not value.strip() or len(value) > (500 if key == 'title' else 2000):
            raise ValueError('missing or oversized generated text')
        if re.search(r'<[^>]+>', value):
            raise ValueError('generated markup not allowed')
        links = re.findall(r'https?://[^\s<>\]\)]+', value)
        if any(url not in {s['url'] for s in item['sources']} for url in links):
            raise ValueError('unverified generated link')
    # Do not label copied English feed text as a Chinese model summary.
    if not re.search('[\u4e00-\u9fff]', row['summary']) or not re.search('[\u4e00-\u9fff]', row['insight']):
        raise ValueError('Chinese summary/insight absent')
    for key in ('categories', 'platforms', 'markets', 'games'):
        strings_check(row[key], CATEGORIES if key == 'categories' else None)
    if set(row['platforms']) - {'pc', 'mobile', 'console'}:
        raise ValueError('invalid platform classification')
    reason = ('服务报告复用缓存；加工结果已通过本地结构校验' if p.get('cached') else
              '加工结果已通过本地结构校验；不代表事实已独立核验')
    return {key: row[key] for key in FIELDS if key not in ('id', 'processing')} | {
        'processing': {'status': 'success', 'reason': reason, 'contentHash': content_hash(item)}}


def service_post(url, token, api_key, payload):
    """One HTTPS POST, no redirects or retries; never expose upstream exception details."""
    try:
        u = checked_settings(url, token, api_key)
        if url != os.environ.get('CONTENT_PROCESS_URL', ''):
            raise ValueError('untrusted public content endpoint')
        privacy_check(payload)
        encoded = json.dumps(payload, ensure_ascii=False, separators=(',', ':'))
        if token in encoded or api_key in encoded:
            raise ValueError('credentials in content material')
        body = encoded.encode('utf-8')
        if len(body) > 100_000:
            raise ValueError('content request size exceeded')
        connection = http.client.HTTPSConnection(u.hostname, port=u.port, timeout=REQUEST_SECONDS)
        deadline = time.monotonic() + REQUEST_SECONDS
        try:
            connection.set_debuglevel(0)
            connection.request('POST', '/internal/content', body=body, headers={
                'Authorization': 'Bearer ' + token, 'X-Content-API-Key': api_key,
                'Content-Type': 'application/json', 'Accept': 'application/json',
                'Accept-Encoding': 'identity', 'Idempotency-Key': digest(payload), 'Connection': 'close'})
            response = connection.getresponse()
            if response.status != 200 or response.headers.get('Content-Encoding', 'identity') != 'identity':
                # Includes all redirects: do not even read their response bodies.
                raise ValueError('content service unavailable')
            chunks, size = [], 0
            while True:
                if time.monotonic() >= deadline:
                    raise ValueError('content response time limit')
                if connection.sock:
                    connection.sock.settimeout(max(0.1, min(20, deadline - time.monotonic())))
                chunk = response.read1(min(65536, 300001 - size))
                if not chunk:
                    break
                size += len(chunk)
                if size > 300000:
                    raise ValueError('content response too large')
                chunks.append(chunk)
            result = json.loads(b''.join(chunks))
            privacy_check(result)
            # Also cover explicit arguments, even if the caller's environment changes in flight.
            encoded_result = json.dumps(result, ensure_ascii=False)
            if token in encoded_result or api_key in encoded_result:
                raise ValueError('credentials in content response')
            return result
        finally:
            connection.close()
    except Exception:
        # This credential-bearing transport boundary must never propagate raw diagnostics.
        raise ValueError('public content request failed; no automatic retry') from None


def process_news(items, history, offline=False, max_items=30, post=service_post, deadline=None):
    cache = {}
    for snapshot in history:
        for row in snapshot['news']:
            if row['processing'].get('status') == 'success' and row['processing'].get('contentHash'):
                cache.setdefault(row['processing']['contentHash'], row)
    settings = content_settings()
    reason = ('离线模式：未尝试公共内容加工' if offline else
              '公共内容服务未配置完整或配置不安全；不调用模型，仅展示订阅标题/来源' if not settings else
              '内容加工未取得有效结果；仅展示订阅标题/来源')
    pending = []
    for item in items:
        item.update(summary=None, insight=None)
        item['processing'] = {'status': 'unavailable', 'reason': reason}
        cached = cache.get(content_hash(item))
        if cached:
            try:
                candidate = {k: cached[k] for k in FIELDS if k not in ('id', 'processing')}
                candidate.update(id=item['id'], processing={'status': 'success', 'reason': ''})
                item.update(validate_processed(candidate, item))
                item['processing']['reason'] = '原文与本地加工配置哈希一致，复用通过结构校验的历史结果；未独立核验后端配置'
                continue
            except (KeyError, ValueError, TypeError):
                pass
        if len(pending) < min(max_items, 30):
            pending.append(item)
        else:
            item['processing']['reason'] = '本次内容加工条数上限已达；不追加调用或挪用 Agent 预算'
    if not pending or offline or not settings:
        return
    deadline = deadline if deadline is not None else time.monotonic() + PROCESS_SECONDS
    for index, item in enumerate(pending):
        # A batch would withhold every result until up to thirty model calls finish.
        if time.monotonic() + REQUEST_SECONDS > deadline:
            for remaining in pending[index:]:
                remaining['processing']['reason'] = '本次内容加工总时限已达；不追加调用，保留已完成结果'
            break
        payload = {'items': [{'id': item['id'], 'title': item['originalTitle'], 'publishedAt': item['publishedAt'],
                             'sources': [{'name': s['name'], 'url': s['url']} for s in item['sources'][:6]],
                             'evidence': item['_evidence'][:500]}]}
        try:
            privacy_check(payload)
            result = post(*settings, payload)
            if not isinstance(result, dict) or set(result) != {'items'} or not isinstance(result['items'], list) or len(result['items']) > 1:
                raise ValueError('invalid service envelope')
            row = result['items'][0] if result['items'] else None
            if row is not None and (not isinstance(row, dict) or row.get('id') != item['id']):
                raise ValueError('unknown content id')
            try:
                item.update(validate_processed(row, item))
            except (ValueError, TypeError, KeyError):
                item['processing']['reason'] = failure_reason(
                    row, '内容服务未返回该项、预算拒绝或输出校验失败；不发布模型文本')
        except Exception:
            # An injected transport must not be able to publish exception diagnostics either.
            for remaining in pending[index:]:
                remaining['processing']['reason'] = '内容服务连接/鉴权/预算失败或响应结构不合格；不重试计费请求，公开采集继续'
            break


def movement_input(item, now):
    observed = parse_date(item['observedAt'])
    if not observed or observed > now:
        raise ValueError('invalid movement observation')
    allowed = {s['url'] for s in item['sources'] if public_url(s['url'])}
    evidence = []
    for field, kind in (('positive', 'positive'), ('negative', 'negative'), ('events', 'event')):
        for entry in item[field][:4]:
            match = re.fullmatch(r'(\S+) · (.+)', entry['text'])
            published = parse_date(match[1]) if match else None
            if (not published or not timedelta(0) <= now - published <= timedelta(days=7)
                    or not timedelta(0) <= observed - published <= timedelta(days=7)
                    or entry['sourceUrl'] not in allowed):
                continue
            evidence.append({'id': f'e{len(evidence) + 1}', 'kind': kind, 'text': match[2][:500],
                             'publishedAt': stamp(published), 'sourceUrl': entry['sourceUrl']})
    value = {key: item[key] for key in ('id', 'gameId', 'name', 'observedAt')} | {'evidence': evidence}
    privacy_check(value)
    return value


def movement_text(value, limit):
    if (not isinstance(value, str) or not value.strip() or len(value) > limit
            or not re.search('[\u3400-\u9fff]', value)
            or re.search(r'[<>\x00-\x1f\x7f]|https?://|\]\s*\(', value)):
        raise ValueError('invalid generated movement text')
    return value


def validate_movement(row, material):
    fields = {'id', 'gameId', 'positive', 'negative', 'events', 'insight', 'processing'}
    if (not isinstance(row, dict) or set(row) != fields or row['id'] != material['id']
            or row['gameId'] != material['gameId']):
        raise ValueError('movement identity/fields mismatch')
    privacy_check(row)
    p = row['processing']
    if (not isinstance(p, dict) or set(p) != {'status', 'reason', 'cached'}
            or p['status'] != 'processed' or type(p['cached']) is not bool or not isinstance(p['reason'], str)):
        raise ValueError('movement processing failed')
    evidence = {e['id']: e for e in material['evidence']}
    result = {}
    for field, kind in (('positive', 'positive'), ('negative', 'negative'), ('events', 'event')):
        entries = row[field]
        if not isinstance(entries, list) or len(entries) > 4:
            raise ValueError('movement output bounds')
        translated = {}
        for entry in entries:
            if not isinstance(entry, dict) or set(entry) != {'text', 'evidenceId'} or not isinstance(entry['evidenceId'], str):
                raise ValueError('movement reference shape')
            source = evidence.get(entry['evidenceId'])
            if not source or source['kind'] != kind or entry['evidenceId'] in translated:
                raise ValueError('movement evidence kind mismatch or duplicate')
            translated[entry['evidenceId']] = movement_text(entry['text'], 300)
        result[field] = []
        for source in material['evidence']:
            if source['kind'] != kind:
                continue
            text = ('AI 整理：' + translated[source['id']] if source['id'] in translated else '依据原文：' + source['text'])
            result[field].append({'text': (source['publishedAt'] + ' · [' + source['id'] + '] ' + text)[:500],
                                  'sourceUrl': source['sourceUrl']})
    insight = row['insight']
    result['insight'] = None
    if insight is not None:
        if not isinstance(insight, dict) or set(insight) != {'text', 'citations'}:
            raise ValueError('movement insight shape')
        ids = insight['citations']
        if (not isinstance(ids, list) or not 1 <= len(ids) <= 6
                or any(not isinstance(key, str) or key not in evidence for key in ids) or len(set(ids)) != len(ids)):
            raise ValueError('movement insight references')
        text = movement_text(insight['text'], 500)
        if not text.startswith('AI 推论：'):
            raise ValueError('movement inference label missing')
        result['insight'] = text
    if insight is None and not any(row[field] for field in ('positive', 'negative', 'events')):
        raise ValueError('empty movement output')
    return result


def process_movements(items, offline=False, post=service_post, now=None, deadline=None):
    now = now or datetime.now(UTC)
    settings = content_settings()
    reason = ('离线模式：未尝试玩家动向 AI 整理' if offline else
              '公共内容服务未配置完整或配置不安全；未生成玩家动向 AI 整理' if not settings else
              '玩家动向 AI 整理未完成；保留原始公开证据')
    deadline = deadline if deadline is not None else time.monotonic() + PROCESS_SECONDS
    halted = None
    for index, item in enumerate(items):
        item['insight'] = None
        if index >= 6 or offline or not settings or halted:
            item['limitations'].append(halted or ('玩家动向本次上限六款；未追加调用' if index >= 6 else reason))
            continue
        if time.monotonic() + REQUEST_SECONDS > deadline:
            halted = '公共内容加工总时限已达；未追加玩家动向调用，保留原始证据'
            item['limitations'].append(halted)
            continue
        try:
            material = movement_input(item, now)
            if not material['evidence']:
                item['limitations'].append('没有带日期且来源可核验的近七天证据；未调用玩家动向模型')
                continue
            response = post(*settings, {'kind': 'movement', 'items': [material]})
            if not isinstance(response, dict) or set(response) != {'items'} or not isinstance(response['items'], list) or len(response['items']) != 1:
                raise ValueError('invalid movement service envelope')
            row = response['items'][0]
            try:
                result = validate_movement(row, material)
            except (ValueError, KeyError, TypeError):
                item['limitations'].append(failure_reason(
                    row, '玩家动向加工被拒绝或输出/引用校验失败；保留原始证据，不发布模型文本'))
                continue
            item.update(result)
            item['limitations'].append('已通过公共内容预算入口整理；AI 中文转述不代表全体玩家，来源与原始证据日期保持独立。')
            if result['insight'] is None:
                item['limitations'].append('证据不足以形成有用行业推论；本次未生成 AI 推论。')
            else:
                item['limitations'].append('AI 推论引用：' + '、'.join('[' + key + ']' for key in row['insight']['citations']))
        except Exception:
            halted = '玩家动向内容服务连接/鉴权/响应失败；不重试计费请求，保留已完成结果与原始证据'
            item['limitations'].append(halted)
