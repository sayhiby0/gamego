"""Bounded public HTTPS transport and RSS/Steam adapters. Never execute source scripts."""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta
from email.utils import parsedate_to_datetime
from html import unescape
from html.parser import HTMLParser
import http.client
import ipaddress
import json
import re
import socket
import ssl
import time
from urllib.parse import urlencode, urljoin, urlsplit
import xml.etree.ElementTree as ET

from public_data import UTC, canonical_url, digest, parse_date, public_url, safe_text, stamp


class CollectionError(Exception):
    """Only curated error codes/messages cross into public coverage."""
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


@dataclass
class Response:
    body: bytes
    url: str
    content_type: str


class PublicHTTP:
    def __init__(self, max_requests=90, timeout=10, max_bytes=2_000_000, total_seconds=240):
        self.max_requests = max_requests
        self.timeout = timeout
        self.max_bytes = max_bytes
        self.deadline = time.monotonic() + total_seconds
        self.requests = 0
        self.blocked_hosts = set()
        self.cache = {}
        self.context = ssl.create_default_context()

    def _request(self, url):
        u = urlsplit(url)
        if self.requests >= self.max_requests or time.monotonic() >= self.deadline:
            raise CollectionError('budget', '公开 HTTP 请求数或本次总时限已用尽，未再请求')
        if u.hostname in self.blocked_hosts:
            raise CollectionError('blocked', '该主机本次已拒绝访问或限流，不继续请求')
        self.requests += 1
        connection = None
        try:
            # Resolve, validate every address, then PIN the chosen IP for this connection.
            # Host and TLS SNI remain the original hostname. No proxy/cookie/browser state.
            answers = socket.getaddrinfo(u.hostname, 443, type=socket.SOCK_STREAM)
            addresses = list(dict.fromkeys(a[4][0] for a in answers))
            if not addresses or any(not ipaddress.ip_address(ip).is_global for ip in addresses):
                raise CollectionError('unsafe_url', '拒绝非公网地址')
            timeout = min(self.timeout, max(0.1, self.deadline - time.monotonic()))
            connection = http.client.HTTPSConnection(u.hostname, timeout=timeout, context=self.context)
            sock = socket.create_connection((addresses[0], 443), timeout=timeout)
            try:
                connection.sock = self.context.wrap_socket(sock, server_hostname=u.hostname)
            except Exception:
                sock.close()
                raise
            connection.request('GET', u.path + ('?' + u.query if u.query else ''), headers={
                'User-Agent': 'GameGo-PublicCollector/1.0', 'Accept-Encoding': 'identity',
                'Accept': 'application/rss+xml, application/atom+xml, application/json, text/html, application/xml;q=0.9',
                'Accept-Language': 'en-US,en;q=0.8', 'Connection': 'close'})
            response = connection.getresponse()
            headers = {k.lower(): v for k, v in response.getheaders()}
            if response.status in (401, 403, 429):
                self.blocked_hosts.add(u.hostname)
                raise CollectionError('blocked', f'HTTP {response.status}：拒绝访问或限流，不绕过、不立即重试')
            if response.status in (301, 302, 303, 307, 308):
                return response.status, headers, b''
            if response.status != 200:
                raise CollectionError('http', f'HTTP {response.status}，未取得有效数据')
            if headers.get('content-encoding', 'identity').lower() not in ('identity', ''):
                raise CollectionError('encoding', '拒绝未请求的压缩响应')
            length = headers.get('content-length')
            if length and (not length.isdigit() or int(length) > self.max_bytes):
                raise CollectionError('size', '响应超过大小上限或长度非法')
            chunks, size = [], 0
            while True:
                if time.monotonic() >= self.deadline:
                    raise CollectionError('budget', '响应读取超过本次总时限')
                connection.sock.settimeout(min(timeout, max(0.1, self.deadline - time.monotonic()))) if connection.sock else None
                chunk = response.read1(min(65536, self.max_bytes + 1 - size))
                if not chunk:
                    break
                size += len(chunk)
                if size > self.max_bytes:
                    raise CollectionError('size', '响应超过大小上限')
                chunks.append(chunk)
            return response.status, headers, b''.join(chunks)
        except CollectionError:
            raise
        except (OSError, ValueError, http.client.HTTPException):
            raise CollectionError('network', 'DNS/TLS/网络连接失败或超时；未绕过防护') from None
        finally:
            if connection:
                connection.close()

    def get(self, url, allowed_hosts=()):
        if not public_url(url):
            raise CollectionError('unsafe_url', '仅允许无凭据的公网 HTTPS URL')
        allowed = set(allowed_hosts) | {urlsplit(url).hostname}
        start = url
        if start in self.cache:
            return self.cache[start]
        seen = set()
        for _ in range(4):
            if not public_url(url) or urlsplit(url).hostname not in allowed or url in seen:
                raise CollectionError('redirect', '拒绝未登记域名、不安全或循环重定向')
            seen.add(url)
            status, headers, body = self._request(url)
            if status in (301, 302, 303, 307, 308):
                url = urljoin(url, headers.get('location', ''))
                continue
            if is_challenge(body):
                self.blocked_hosts.add(urlsplit(url).hostname)
                raise CollectionError('blocked', '返回登录/验证码/防护页，不视为成功')
            result = Response(body, url, headers.get('content-type', ''))
            self.cache[start] = result
            return result
        raise CollectionError('redirect', '超过三次安全重定向上限')


def is_challenge(body):
    text = body[:100_000].decode('utf-8', 'ignore')
    return bool(re.search(r'(?is)<title[^>]*>\s*(?:just a moment|access denied|attention required|verify you are human|安全验证|登录)[^<]*</title>|/cdn-cgi/challenge-platform/|id=["\']cf-chl|<form[^>]+(?:captcha|challenge)', text))


class TextParser(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.parts, self.hidden = [], 0

    def handle_starttag(self, tag, attrs):
        if tag in ('script', 'style'):
            self.hidden += 1

    def handle_endtag(self, tag):
        if tag in ('script', 'style'):
            self.hidden = max(0, self.hidden - 1)

    def handle_data(self, data):
        if not self.hidden:
            self.parts.append(data)


def plain(value, limit=500):
    parser = TextParser()
    parser.feed(str(value)[:20000])
    return safe_text(' '.join(parser.parts), limit)


def feed_date(value):
    parsed = parse_date(value)
    if parsed:
        return parsed
    try:
        parsed = parsedate_to_datetime(value)
        return parsed.astimezone(UTC) if parsed.tzinfo else None
    except (ValueError, TypeError, OverflowError, IndexError):
        return None


def parse_feed(body: bytes, source: dict):
    if len(body) > 2_000_000:
        raise CollectionError('size', 'RSS 超过大小限制')
    if is_challenge(body):
        raise CollectionError('blocked', 'RSS 入口返回防护页')
    # Reject DTD/entities in every XML encoding before ElementTree can expand them.
    if re.search(br'<!\s*(?:DOCTYPE|ENTITY)', body.replace(b'\x00', b''), re.I):
        raise CollectionError('xml', '拒绝含 DTD 或实体声明的 XML')
    try:
        root = ET.fromstring(body)
    except (ET.ParseError, ValueError):
        raise CollectionError('xml', 'RSS/Atom XML 无法解析') from None
    local = lambda tag: tag.rsplit('}', 1)[-1].lower()
    if local(root.tag) not in ('rss', 'feed', 'rdf'):
        raise CollectionError('xml', '不是 RSS/Atom 文档')
    entries = [node for node in root.iter() if local(node.tag) in ('item', 'entry')][:500]
    result = []
    for entry in entries:
        fields, links = {}, []
        for child in entry:
            key = local(child.tag)
            fields.setdefault(key, []).append(''.join(child.itertext()))
            if key == 'link' and child.attrib.get('rel', 'alternate') == 'alternate':
                links.append(child.attrib.get('href') or child.text or '')
        title = plain(next(iter(fields.get('title', [])), ''), 500)
        published = next(iter(fields.get('pubdate') or fields.get('published') or fields.get('date') or []), '')
        # Atom updated is NOT a substitute for first publication; undated entries are omitted.
        date = feed_date(published)
        links = [public_url(link.strip(), source.get('httpsUpgradeHosts', [])) for link in links]
        link = next((link for link in links if link), None)
        if not title or not date or not link:
            continue
        excerpt = plain(next(iter(fields.get('description') or fields.get('summary') or []), ''), 500)
        result.append({'id': digest(canonical_url(link))[:24], 'title': title, 'originalTitle': title,
                       'publishedAt': stamp(date), 'platforms': [], 'markets': [], 'games': [], 'categories': [],
                       'summary': None, 'insight': None,
                       'processing': {'status': 'unavailable', 'reason': '未配置公共内容加工服务；仅展示核验过的订阅标题和链接'},
                       'sources': [{'id': source['id'], 'name': source['name'], 'url': link}],
                       '_evidence': excerpt or title, '_tags': ' '.join(fields.get('category', []))})
    if not result:
        raise CollectionError('date', '订阅中没有同时具备标题、安全链接与带时区发布日期的条目')
    return result


GAME = re.compile(r'(?i)\b(?:games?|gaming|gamer|steam|xbox|playstation|nintendo|switch|rpg|dlc|patch|esports|ubisoft|capcom|pokemon|pokémon|genshin|honkai|dota|warcraft|minecraft|diablo|fortnite)\b|游戏|玩家|手游|端游|米哈游|任天堂|原神|鸣潮|方舟|星穹|绝区零|王者荣耀|和平精英|英雄联盟|版本更新|发行商|开发商')
NON_GAME = re.compile(r'(?i)\b(?:movie|films?|tv|disney\+?|netflix|streaming|actor|actress|celebrity|iphone|recipe|astrology|football)\b|电视剧|电影|影评|星座|菜谱|手机评测')
HARDWARE = re.compile(r'(?i)\b(?:laptops?|gaming (?:pcs?|monitors?|keyboards?|mice|headsets?)|graphics cards?)\b|游戏本|电竞(?:笔记本|显示器|键盘|鼠标|耳机)|显卡')
HARDWARE_OFFER = re.compile(r'(?i)^\s*(?:save\s+(?:[$£€]\s*[\d,.]+|\d+(?:\.\d+)?%)\s+(?:off|on)\b|get\b.*\bfor\s+(?:under\s+)?[$£€]\s*\d)|(?:低至|到手价|立省|直降)\s*[¥￥]?\s*\d')


def dedupe_news(items, now):
    selected = []
    for item in items:
        date = parse_date(item.get('publishedAt'))
        if not date or not timedelta(0) <= now - date <= timedelta(hours=24):
            continue
        if HARDWARE.search(item['title']) and HARDWARE_OFFER.search(item['title']):
            continue
        text = ' '.join((item['title'], item.get('_evidence', ''), item.get('_tags', '')))
        if NON_GAME.search(text) and not GAME.search(item['title']):
            continue
        if not GAME.search(text):
            continue
        selected.append(item)
    selected.sort(key=lambda x: x['publishedAt'], reverse=True)
    # Union-find handles bridge duplicates: same URL in A/B, same definite title in B/C.
    groups = []
    for item in selected:
        urls = {canonical_url(s['url']) for s in item['sources']}
        title = re.sub(r'\s+', ' ', unescape(item['originalTitle']).casefold()).strip()
        # Exact substantial title, including numbers/punctuation; no fuzzy event invention.
        title_key = title if len(title) >= 18 else None
        matches = [g for g in groups if g['urls'] & urls or (title_key and title_key in g['titles'])]
        if not matches:
            groups.append({'row': item, 'urls': urls, 'titles': {title_key} if title_key else set()})
            continue
        target = matches[0]
        for group in matches[1:]:
            target['row']['sources'].extend(group['row']['sources'])
            target['urls'].update(group['urls'])
            target['titles'].update(group['titles'])
            groups.remove(group)
        target['row']['sources'].extend(item['sources'])
        target['urls'].update(urls)
        if title_key:
            target['titles'].add(title_key)
        # Preserve earliest reported publication for an identified event, not the newest repost.
        target['row']['publishedAt'] = min(target['row']['publishedAt'], item['publishedAt'])
    result = []
    for group in groups:
        row = group['row']
        row['sources'] = list({(s['id'], s['url']): s for s in row['sources']}.values())[:50]
        result.append(row)
    return sorted(result, key=lambda x: x['publishedAt'], reverse=True)[:30]


class ChartParser(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.rows, self.row, self.cell, self.link = [], None, None, None
        self.visible, self.hidden = [], 0

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag in ('script', 'style'):
            self.hidden += 1
        if self.hidden:
            return
        if tag == 'tr':
            self.row = {'cells': [], 'apps': []}
        if tag in ('td', 'th') and self.row is not None:
            self.cell = []
        if tag == 'a' and self.row is not None:
            href = urljoin('https://store.steampowered.com', attrs.get('href', ''))
            match = re.match(r'https://store\.steampowered\.com/app/(\d+)(?:/|\?|$)', href)
            if match:
                self.link = {'id': match[1], 'text': []}

    def handle_data(self, data):
        if self.hidden:
            return
        self.visible.append(data)
        if self.cell is not None:
            self.cell.append(data)
        if self.link is not None:
            self.link['text'].append(data)

    def handle_endtag(self, tag):
        if tag in ('script', 'style'):
            self.hidden = max(0, self.hidden - 1)
            return
        if self.hidden:
            return
        if tag == 'a' and self.link is not None:
            self.row['apps'].append(self.link)
            self.link = None
        if tag in ('td', 'th') and self.cell is not None:
            self.row['cells'].append(' '.join(' '.join(self.cell).split()))
            self.cell = None
        if tag == 'tr' and self.row is not None:
            self.rows.append(self.row)
            self.row, self.cell, self.link = None, None, None


def parse_chart(body, metric):
    if is_challenge(body):
        raise CollectionError('blocked', 'Steam 榜单返回防护页')
    parser = ChartParser()
    parser.feed(body.decode('utf-8', 'replace'))
    text = ' '.join(' '.join(parser.visible).split())
    if metric == 'popularity' and not all(x in text for x in ('Current Players', 'Peak Today')):
        raise CollectionError('format', 'Steam 在线榜指标表头未匹配')
    if metric == 'commercial' and not (re.search(r'\bGlobal\b', text) and re.search(r'by revenue', text, re.I)):
        raise CollectionError('format', 'Steam 全球/收入定义未核实')
    result, seen, ranks = [], set(), set()
    for row in parser.rows:
        cells = row['cells']
        apps = row['apps']
        # Verified Steam HTML has a leading empty/icon column: rank is cells[1].
        # Also accept the five-column accessible form, never shift past nonempty data.
        if len(cells) == 6 and not cells[0].strip():
            cells = cells[1:]
        if len(cells) != 5 or not apps or not re.fullmatch(r'\d+', cells[0]):
            continue
        if len({a['id'] for a in apps}) != 1:
            continue
        appid = apps[0]['id']
        name = next((safe_text(' '.join(a['text']), 200) for a in apps if ' '.join(a['text']).strip()), '')
        # Some rows have separate image/text anchors; the name cell is authoritative fallback.
        name = name or safe_text(cells[1], 200)
        rank, value = int(cells[0]), None
        if not name or rank < 1 or appid in seen or rank in ranks:
            continue
        if metric == 'popularity':
            if not all(re.fullmatch(r'(?:\d+|\d{1,3}(?:,\d{3})+)', v) for v in cells[-2:]):
                continue
            value = int(cells[-2].replace(',', ''))
            if value > int(cells[-1].replace(',', '')):
                continue
        seen.add(appid)
        ranks.add(rank)
        result.append({'gameId': 'steam:' + appid, 'name': name, 'rank': rank, 'value': value,
                       'reviewCount': None, 'url': f'https://store.steampowered.com/app/{appid}/',
                       'previousRank': None, 'rankChange': None, 'baselineAt': None})
    if not result:
        raise CollectionError('format', 'Steam 页面没有有效 app 表格行，不把 HTTP 200 当作成功')
    return sorted(result, key=lambda r: r['rank'])[:20]


REVIEW_PARAMS = {'json': '1', 'language': 'all', 'review_type': 'all', 'purchase_type': 'all',
                 'filter': 'all', 'day_range': '365', 'filter_offtopic_activity': '1',
                 'filter_offensive': '1', 'filter_review_below_threshold': '1', 'num_per_page': '100'}
REVIEW_DEFINITION = ('本查询服务端汇总好评率；language=all、review_type=all、purchase_type=all、filter=all、day_range=365、'
                     'filter_offtopic_activity=1、filter_offensive=1、filter_review_below_threshold=1；'
                     '汇总统计精确时间窗口未核实，不能称近30天或完整全历史；口碑只比较当期榜单候选并集，至少100条评价。')


def review_url(appid, recent=False):
    params = dict(REVIEW_PARAMS)
    if recent:
        params['filter'] = 'recent'
    return f'https://store.steampowered.com/appreviews/{int(appid)}?' + urlencode(params)


def parse_reviews(body, now, recent=False):
    try:
        data = json.loads(body)
        if not isinstance(data, dict) or data.get('success') != 1 or not isinstance(data.get('reviews'), list):
            raise ValueError
        summary = data['query_summary']
        values = [summary[k] for k in ('total_positive', 'total_negative', 'total_reviews')]
        if any(type(v) is not int or v < 0 for v in values) or values[0] + values[1] != values[2]:
            raise ValueError
    except (ValueError, KeyError, TypeError):
        raise CollectionError('format', 'Steam 评价 JSON/汇总字段不合法') from None
    samples, seen = [], set()
    if recent:
        for row in data['reviews'][:100]:
            if not isinstance(row, dict) or type(row.get('timestamp_created')) is not int or type(row.get('voted_up')) is not bool or not isinstance(row.get('review'), str):
                continue
            try:
                date = datetime.fromtimestamp(row['timestamp_created'], UTC)
            except (ValueError, OSError, OverflowError):
                continue
            if not timedelta(0) <= now - date <= timedelta(days=7):
                continue
            text = plain(row.get('review', ''), 180)
            key = digest([row['timestamp_created'], row['voted_up'], text])
            if text and key not in seen:
                seen.add(key)
                # Player object, review ID, profile URL and cursor are intentionally never copied.
                samples.append({'text': text, 'positive': row['voted_up'], 'publishedAt': stamp(date)})
    return {'positive': values[0], 'negative': values[1], 'total': values[2], 'samples': samples}


def news_url(appid):
    return 'https://api.steampowered.com/ISteamNews/GetNewsForApp/v2/?' + urlencode({'appid': int(appid), 'count': 10, 'maxlength': 250, 'feeds': 'steam_community_announcements'})


def parse_announcements(body, appid, now):
    try:
        app = json.loads(body)['appnews']
        if app['appid'] != int(appid) or not isinstance(app['newsitems'], list):
            raise ValueError
    except (ValueError, KeyError, TypeError):
        raise CollectionError('format', 'Steam 公告 JSON 身份或字段不匹配') from None
    result = []
    for row in app['newsitems'][:10]:
        # is_external_url describes a Steam News outbound link, not publisher identity.
        # Official community posts may legitimately set it true; check feed + app + URL.
        if not isinstance(row, dict) or row.get('feedname') != 'steam_community_announcements' or row.get('appid') != int(appid):
            continue
        try:
            date = datetime.fromtimestamp(row['date'], UTC)
        except (ValueError, KeyError, TypeError, OSError, OverflowError):
            continue
        url = public_url(row.get('url'))
        if not url:
            continue
        parsed = urlsplit(url)
        official_path = (parsed.hostname == 'store.steampowered.com' and
                         re.match(rf'/news/(?:app/{int(appid)}/view/\d+|externalpost/steam_community_announcements/\d+)', parsed.path)) or (
                         parsed.hostname == 'steamcommunity.com' and
                         re.match(rf'/games/{int(appid)}/announcements/detail/\d+', parsed.path))
        if not official_path:
            continue
        title = plain(row.get('title', ''), 180)
        if title and timedelta(0) <= now - date <= timedelta(days=7):
            result.append({'text': stamp(date) + ' · 官方公告：' + title, 'sourceUrl': url})
    return result[:3]


def eligible_fallback(primary, alternative):
    if not alternative or not alternative.get('enabled') or not alternative.get('fallbackVerified'):
        return False
    fields = ('seriesId', 'purpose', 'metric', 'methodologyVersion', 'scope')
    return all(primary.get(k) == alternative.get(k) for k in fields)


def collect_with_fallback(primary, registry, collect, now):
    """Fallback transport is real, not a counter simulation; at most TWO alternatives."""
    attempts = []
    alternatives = [registry.get(key) for key in primary.get('fallbacks', [])]
    alternatives = [s for s in alternatives if s and s['id'] != primary['id'] and eligible_fallback(primary, s)]
    alternatives = list({s['id']: s for s in alternatives}.values())[:2]
    for source in [primary, *alternatives]:
        try:
            result = collect(source)
            attempts.append({'id': source['id'], 'ok': True, 'reason': '本次本机取得有效字段；不代表持续生产可用', 'at': stamp(now)})
            return result, source, attempts, ''
        except CollectionError as exc:
            attempts.append({'id': source['id'], 'ok': False, 'reason': str(exc), 'at': stamp(now)})
            if exc.code in ('blocked', 'unsafe_url', 'budget'):
                return None, None, attempts, str(exc) + '；未为规避限制而补源'
    suffix = '无已验证、已启用且同口径的可用 fallback' if not alternatives else '已配置同口径 fallback 均失败（最多2次）'
    return None, None, attempts, attempts[-1]['reason'] + '；' + suffix
