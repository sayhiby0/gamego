"""Public-data boundary, comparable snapshots and crash-safe JSON publication (stdlib)."""
from __future__ import annotations

import copy
import hashlib
import ipaddress
import json
import math
import os
from pathlib import Path
import re
import tempfile
from datetime import datetime, timedelta, timezone
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

UTC = timezone.utc
BEIJING = timezone(timedelta(hours=8))
ROOT = Path(__file__).resolve().parents[1]
CONTRACT = json.loads((ROOT / 'config/public-contract.json').read_text(encoding='utf-8'))
CATEGORIES = {'产品与版本', '运营活动', '营销与联动', '发行与渠道', '行业与公司', '玩家口碑'}
SECRET = re.compile(r'(?i)(?:\bBearer\s+\S+|(?<![A-Za-z0-9])sk-[A-Za-z0-9._~-]+|-----BEGIN [A-Z ]*PRIVATE KEY|\bgh[pousr]_[A-Za-z0-9]{16,}|\bAKIA[A-Z0-9]{16}\b)')
PERSONAL = re.compile(r'(?i)(?:[\w.+-]+@[\w.-]+\.[a-z]{2,}|steamcommunity\.com/(?:id|profiles)/\S+|\b7656119\d{10}\b|(?<!\d)1[3-9]\d{9}(?!\d))')
PRIVATE_FIELDS = {'steamid', 'steam_id', 'username', 'profile', 'avatar', 'email', 'phone', 'password', 'token', 'authorization', 'cookie', 'apikey', 'api_key', 'secret', 'prompt', 'systemprompt', 'system_prompt', 'developer_prompt', 'ledger', 'allowlist', 'raw', 'raw_response', 'raw_html', 'review', 'reviews', 'cursor', 'access_token', 'refresh_token', 'client_secret', 'service_token', 'model_key', 'player_profile'}


def stamp(value: datetime) -> str:
    return value.astimezone(UTC).isoformat(timespec='auto').replace('+00:00', 'Z')


def parse_date(value) -> datetime | None:
    if not isinstance(value, str):
        return None
    try:
        result = datetime.fromisoformat(value.replace('Z', '+00:00'))
        return result.astimezone(UTC) if result.tzinfo is not None else None
    except (ValueError, OverflowError):
        return None


def public_url(value: str, upgrade_hosts=()) -> str | None:
    if not isinstance(value, str) or len(value) > 2048 or re.search(r'[\s\\\x00-\x1f\x7f]', value):
        return None
    try:
        u = urlsplit(value)
        scheme = 'https' if u.scheme == 'http' and u.hostname in upgrade_hosts else u.scheme
        if scheme != 'https' or not u.hostname or u.username or u.password or u.port not in (None, 443):
            return None
        if u.hostname in ('localhost',) or u.hostname.endswith(('.localhost', '.local', '.internal')):
            return None
        try:
            if not ipaddress.ip_address(u.hostname).is_global:
                return None
        except ValueError:
            if '.' not in u.hostname:
                return None
        for key, _ in parse_qsl(u.query, keep_blank_values=True):
            if re.search(r'(?i)token|secret|password|api.?key|authorization|signature|credential', key):
                return None
        return urlunsplit((scheme, u.netloc.lower(), u.path or '/', u.query, ''))
    except ValueError:
        return None


def canonical_url(value: str) -> str:
    u = urlsplit(value)
    query = [(k, v) for k, v in parse_qsl(u.query, keep_blank_values=True)
             if not k.lower().startswith('utm_') and k.lower() not in ('fbclid', 'gclid', 'snr')]
    return urlunsplit((u.scheme.lower(), u.netloc.lower(), u.path or '/', urlencode(sorted(query)), ''))


def digest(value) -> str:
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def safe_text(value: str, limit=500) -> str:
    """Omit identifiable excerpts; do not pretend that redacted reviews are new quotations."""
    if not isinstance(value, str) or SECRET.search(value) or PERSONAL.search(value):
        return ''
    if any(secret and secret in value for secret in
           (os.environ.get('CONTENT_SERVICE_TOKEN', ''), os.environ.get('CONTENT_API_KEY', ''))):
        return ''
    return ' '.join(value.split())[:limit]


def privacy_check(value):
    if isinstance(value, dict):
        for key, child in value.items():
            if (not isinstance(key, str) or key.lower().replace('-', '_') in PRIVATE_FIELDS
                    or key.lower().replace('-', '_') in {'content_api_key', 'content_process_token', 'content_service_token', 'x_content_api_key'}):
                raise ValueError('禁止公开敏感字段')
            privacy_check(key)
            privacy_check(child)
    elif isinstance(value, list):
        for child in value:
            privacy_check(child)
    elif isinstance(value, str):
        if SECRET.search(value) or PERSONAL.search(value):
            raise ValueError('禁止公开凭据或个人资料')
        # Exact matching also covers short/synthetic or malformed configured credentials.
        if any(secret and secret in value for secret in
               (os.environ.get('CONTENT_SERVICE_TOKEN', ''), os.environ.get('CONTENT_API_KEY', ''))):
            raise ValueError('禁止公开内容服务凭据')
        if len(value) > 8000:
            raise ValueError('禁止公开长篇原文')
    elif isinstance(value, float) and not math.isfinite(value):
        raise ValueError('非有限数值')


def shape(value, name, extras=(), required=True):
    if not isinstance(value, dict):
        raise ValueError(f'{name}: object required')
    keys = set(CONTRACT[name])
    if set(value) - keys - set(extras) or (required and keys - set(value)):
        raise ValueError(f'{name}: fields do not match public contract')


def date_field(value, nullable=True):
    if value is None and nullable:
        return
    if not isinstance(value, str) or not re.fullmatch(r'\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)', value) or not parse_date(value):
        raise ValueError('invalid timestamp')


def sources_check(sources):
    if not isinstance(sources, list) or len(sources) > 50:
        raise ValueError('invalid sources')
    for source in sources:
        if not isinstance(source, dict) or set(source) != {'id', 'name', 'url'} or not source['name'] or not public_url(source['url']):
            raise ValueError('invalid public source')


def strings_check(values, allowed=None):
    if not isinstance(values, list) or len(values) > 30 or any(not isinstance(v, str) or len(v) > 500 for v in values):
        raise ValueError('invalid text list')
    if allowed and set(values) - set(allowed):
        raise ValueError('invalid classification')


def validate_dashboard(data):
    privacy_check(data)
    shape(data, 'dashboard')
    if data['schemaVersion'] != 1 or not re.fullmatch(r'\d{4}-\d\d-\d\d', data['dataDate']):
        raise ValueError('invalid schema/date')
    datetime.strptime(data['dataDate'], '%Y-%m-%d')
    date_field(data['attemptedAt'], False)
    date_field(data['lastSuccessAt'])
    for field in ('news', 'rankings', 'movements', 'skills', 'coverage'):
        if not isinstance(data[field], list):
            raise ValueError('invalid collection')
    if len(data['news']) > 30 or len(data['rankings']) > 60 or len(data['coverage']) > 250:
        raise ValueError('public quota exceeded')
    seen = set()
    for row in data['news']:
        shape(row, 'newsItem')
        if not row['id'] or row['id'] in seen or not isinstance(row['title'], str) or not row['title'] or len(row['title']) > 500:
            raise ValueError('invalid news')
        seen.add(row['id'])
        date_field(row['publishedAt'], False)
        age = parse_date(data['attemptedAt']) - parse_date(row['publishedAt'])
        if not timedelta(0) <= age <= timedelta(hours=24):
            raise ValueError('news outside actual 24h window')
        sources_check(row['sources'])
        if not row['sources']:
            raise ValueError('news without evidence')
        for field in ('platforms', 'markets', 'games', 'categories'):
            strings_check(row[field], CATEGORIES if field == 'categories' else None)
        p = row['processing']
        if not isinstance(p, dict) or set(p) - {'status', 'reason', 'contentHash'} or not {'status', 'reason'} <= set(p):
            raise ValueError('invalid processing')
        if 'contentHash' in p and not re.fullmatch('[0-9a-f]{64}', p['contentHash']):
            raise ValueError('invalid content hash')
        for field in ('summary', 'insight'):
            if row[field] is not None and (not isinstance(row[field], str) or not row[field] or len(row[field]) > 2000):
                raise ValueError('invalid generated text')
        if p['status'] != 'success' and (row['summary'] is not None or row['insight'] is not None):
            raise ValueError('degraded AI text must be null')
    groups = {}
    for board in data['rankings']:
        shape(board, 'ranking', ('minimumSample', 'queryParameters', 'dataType'))
        if board['platform'] not in ('pc', 'mobile') or board['metric'] not in ('popularity', 'commercial', 'reputation'):
            raise ValueError('invalid ranking type')
        sources_check([board['source']])
        date_field(board['observedAt'])
        if board['observedAt'] and parse_date(board['observedAt']) > parse_date(data['attemptedAt']):
            raise ValueError('future ranking observation')
        key = (board['source']['id'], board['platform'], board['metric'])
        groups[key] = groups.get(key, 0) + len(board['items'])
        if groups[key] > 20:
            raise ValueError('ranking quota exceeded')
        ids, ranks = set(), set()
        for item in board['items']:
            shape(item, 'rankingItem')
            if not item['gameId'] or item['gameId'] in ids or not item['name'] or type(item['rank']) is not int or item['rank'] < 1 or item['rank'] in ranks or not public_url(item['url']):
                raise ValueError('invalid ranking item')
            ids.add(item['gameId'])
            ranks.add(item['rank'])
            if not board['observedAt']:
                raise ValueError('ranking without observation date')
            if item['value'] is not None and (type(item['value']) not in (int, float) or item['value'] < 0):
                raise ValueError('invalid ranking value')
            if board['metric'] == 'reputation' and (type(item['reviewCount']) is not int or item['reviewCount'] < 100 or not 0 <= item['value'] <= 100):
                raise ValueError('insufficient reputation population')
            if item['baselineAt'] is None:
                if item['previousRank'] is not None or item['rankChange'] is not None:
                    raise ValueError('invented trend')
            else:
                date_field(item['baselineAt'], False)
                if type(item['previousRank']) is not int or item['previousRank'] < 1 or type(item['rankChange']) is not int or item['rankChange'] != item['previousRank'] - item['rank'] or parse_date(item['baselineAt']) >= parse_date(board['observedAt']):
                    raise ValueError('invalid comparable trend')
    counts, seen = {'pc': 0, 'mobile': 0}, set()
    for row in data['movements']:
        shape(row, 'movement')
        if row['platform'] not in counts or row['gameId'] in seen:
            raise ValueError('invalid/duplicate movement product')
        counts[row['platform']] += 1
        seen.add(row['gameId'])
        date_field(row['observedAt'], False)
        sources_check(row['sources'])
        strings_check(row['limitations'])
        if row['insight'] is not None and (not isinstance(row['insight'], str) or not row['insight'].startswith('AI 推论：') or len(row['insight']) > 500):
            raise ValueError('invalid movement inference')
        for field in ('positive', 'negative', 'events'):
            if not isinstance(row[field], list) or len(row[field]) > 20:
                raise ValueError('invalid movement evidence')
            for evidence in row[field]:
                shape(evidence, 'evidence')
                if (not isinstance(evidence['text'], str) or not evidence['text'] or len(evidence['text']) > 500
                        or not public_url(evidence['sourceUrl']) or evidence['sourceUrl'] not in {s['url'] for s in row['sources']}):
                    raise ValueError('invalid movement citation')
    if counts['pc'] > 2 or counts['mobile'] > 4:
        raise ValueError('movement quota exceeded')
    for row in data['coverage']:
        shape(row, 'coverage')
        if not public_url(row['url']) or type(row['count']) is not int or row['count'] < 0:
            raise ValueError('invalid coverage')
        date_field(row['attemptedAt'])
        date_field(row['lastSuccessAt'])
    for row in data['skills']:
        shape(row, 'skill')
        if not public_url(row['url']) or row['category'] not in ('资讯与竞品研究', '运营与营销内容'):
            raise ValueError('invalid skill')
        date_field(row['checkedAt'])
        heat = row['popularity']
        if heat is not None:
            if not isinstance(heat, dict) or set(heat) != {'metric', 'value', 'source', 'window', 'collectedAt'}:
                raise ValueError('invalid skill popularity fields')
            if not public_url(heat['source']) or any(not isinstance(heat[k], str) or not heat[k] or len(heat[k]) > 100 for k in ('metric', 'window')):
                raise ValueError('invalid skill popularity provenance')
            value = heat['value']
            if not ((type(value) in (int, float) and math.isfinite(value) and value >= 0)
                    or (isinstance(value, str) and value.strip() and len(value) <= 100)):
                raise ValueError('invalid skill popularity value')
            date_field(heat['collectedAt'], False)
            if not row['checkedAt'] or parse_date(heat['collectedAt']) > parse_date(row['checkedAt']):
                raise ValueError('skill popularity exceeds last check')


def comparable_key(board):
    return digest({k: board.get(k) for k in ('platform', 'metric', 'methodologyVersion', 'scope', 'period', 'unit', 'queryParameters', 'dataType')} | {'source': board['source']['id']})


def apply_history(board, history):
    """Only previous comparable observations; never label a snapshot delta as daily growth."""
    for item in board['items']:
        item.update(previousRank=None, rankChange=None, baselineAt=None)
    candidates = [b for snapshot in history for b in snapshot['rankings']
                  if b.get('observedAt') and b.get('items') and comparable_key(b) == comparable_key(board)
                  and parse_date(b['observedAt']) < parse_date(board['observedAt'])]
    if not candidates:
        return board
    previous = max(candidates, key=lambda b: b['observedAt'])
    ranks = {item['gameId']: item['rank'] for item in previous['items']}
    for item in board['items']:
        if item['gameId'] in ranks:
            item.update(previousRank=ranks[item['gameId']], rankChange=ranks[item['gameId']] - item['rank'], baselineAt=previous['observedAt'])
    return board


def stale_board(board, history):
    candidates = [b for snapshot in history for b in snapshot['rankings']
                  if b['items'] and b['observedAt'] and comparable_key(b) == comparable_key(board)]
    if not candidates:
        return board
    old = copy.deepcopy(max(candidates, key=lambda b: b['observedAt']))
    old.update(status='stale', reason='本次未取得该榜有效数据，保留原采集时间的旧快照；' + board['reason'])
    return old


def read_json(path):
    try:
        if path.stat().st_size > 5_000_000 or path.is_symlink():
            return None
        return json.loads(path.read_text(encoding='utf-8'))
    except (OSError, ValueError):
        return None


def load_history(output: Path, now: datetime):
    history = []
    cutoff = (now.astimezone(BEIJING).date() - timedelta(days=29)).isoformat()
    for path in [output / 'latest.json', *sorted(output.glob('????-??-??.json'), reverse=True)]:
        data = read_json(path)
        try:
            if data:
                validate_dashboard(data)
                if parse_date(data['attemptedAt']) > now:
                    continue
                if data['lastSuccessAt'] and cutoff <= data['dataDate'] <= now.astimezone(BEIJING).date().isoformat():
                    history.append(data)
                if path.name == 'latest.json':
                    manifest = read_json(output / 'manifest.json')
                    attempted = manifest.get('attemptedAt') if isinstance(manifest, dict) else data['attemptedAt']
                    date_field(attempted, False)
                    if parse_date(data['attemptedAt']) <= parse_date(attempted) <= now:
                        history.append({'attemptedAt': attempted, 'skills': data['skills'],
                                        'news': [], 'rankings': [], 'coverage': []})
        except (ValueError, KeyError, TypeError):
            continue
    return history


def atomic_json(path: Path, data):
    """Write + fsync + replace on the same volume; no partial JSON is ever visible."""
    privacy_check(data)
    encoded = (json.dumps(data, ensure_ascii=False, indent=2, allow_nan=False) + '\n').encode('utf-8')
    fd, name = tempfile.mkstemp(prefix='.' + path.name + '-', suffix='.tmp', dir=path.parent)
    try:
        with os.fdopen(fd, 'wb') as handle:
            handle.write(encoded)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(name, path)
    finally:
        if os.path.exists(name):
            os.unlink(name)


def publish(output: Path, dashboard, any_success: bool, now: datetime):
    validate_dashboard(dashboard)
    previous = read_json(output / 'latest.json')
    try:
        if previous:
            validate_dashboard(previous)
    except (ValueError, KeyError, TypeError):
        previous = None
    retain = not any_success and previous and previous['lastSuccessAt']
    if not retain:
        if any_success:
            atomic_json(output / (dashboard['dataDate'] + '.json'), dashboard)
        atomic_json(output / 'latest.json', dashboard)
    effective = previous if retain else dashboard
    if retain and previous['skills'] != dashboard['skills']:
        effective = copy.deepcopy(previous)
        # Skill checks must not move the retained news's 24-hour observation window.
        effective.update(skills=dashboard['skills'], status='stale', notice=dashboard['notice'])
        validate_dashboard(effective)
        atomic_json(output / 'latest.json', effective)
    today = now.astimezone(BEIJING).date()
    dates = []
    for path in output.glob('????-??-??.json'):
        try:
            day = datetime.strptime(path.stem, '%Y-%m-%d').date()
        except ValueError:
            continue
        if not today - timedelta(days=29) <= day <= today:
            if not path.is_symlink():
                path.unlink()
        elif not path.is_symlink():
            candidate = read_json(path)
            try:
                validate_dashboard(candidate)
                if candidate['dataDate'] == path.stem and candidate['lastSuccessAt']:
                    dates.append(path.stem)
            except (ValueError, TypeError, KeyError):
                continue
    manifest = dict(schemaVersion=1, latestDate=effective['dataDate'] if effective['lastSuccessAt'] else None,
                    dates=sorted(set(dates), reverse=True), attemptedAt=dashboard['attemptedAt'],
                    lastSuccessAt=effective['lastSuccessAt'], status='stale' if retain else dashboard['status'])
    # Minimal failure metadata also survives when latest must remain byte-for-byte intact.
    manifest['failureReason'] = dashboard['notice'] if not any_success else None
    manifest['failedAt'] = dashboard['attemptedAt'] if not any_success else None
    atomic_json(output / 'manifest.json', manifest)
    return manifest
