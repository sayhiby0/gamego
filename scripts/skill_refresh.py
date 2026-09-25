"""Refresh only maintained skills.sh entries; stdlib, no writes or skill execution."""
from __future__ import annotations

import copy
from datetime import datetime, timedelta
from html.parser import HTMLParser
from pathlib import Path
import re
import sys
from urllib.parse import urljoin, urlsplit

# Match pipeline.py's support for both script and namespace-package imports.
SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

from collectors import CollectionError, PublicHTTP, is_challenge
from public_data import UTC, date_field, parse_date, public_url, shape, stamp

MAX_SKILLS = 12
MAX_BYTES = 2_000_000
REFRESH_AFTER = timedelta(days=7)
SKILL_HOSTS = ('skills.sh', 'www.skills.sh')
METRIC = '单 Skill 安装量（目录显示）'
WINDOW = 'All Time（累计）'
ROUNDED = '（显示值，可能舍入）'
HEAT_FIELDS = {'metric', 'value', 'source', 'window', 'collectedAt'}
COMPACT = re.compile(r'(?:0|[1-9][0-9]{0,5})(?:\.[0-9]{1,3})?[KMkm]')
STATS = re.compile(r'(?:all\s+time\s+installs|installs\s+(?:all\s+time|\(all\s+time\)))\s*[:：]?\s*(.+)', re.I)


def _date(value, now):
    try:
        date_field(value, False)
    except ValueError:
        return None
    parsed = parse_date(value)
    return parsed if parsed and parsed <= now else None


def _heat(value, url, checked, now):
    if not isinstance(value, dict) or set(value) != HEAT_FIELDS:
        return None
    if value['metric'] != METRIC or value['window'] != WINDOW or value['source'] != url:
        return None
    collected = _date(value['collectedAt'], now)
    if not checked or not collected or collected > checked:
        return None
    count = value['value']
    exact = type(count) is int and 0 <= count <= 2**53 - 1
    rounded = isinstance(count, str) and count.endswith(ROUNDED) and COMPACT.fullmatch(count[:-len(ROUNDED)])
    return copy.deepcopy(value) if exact or rounded else None


def _merge_history(skill, history, now):
    """Only dynamic metadata; attemptedAt breaks ties, never becomes checkedAt."""
    checked = _date(skill['checkedAt'], now)
    if not checked:
        skill['checkedAt'] = None
    if skill['status'] not in ('verified', 'unavailable', 'unchecked'):
        skill['status'] = 'unchecked'
    if skill['status'] == 'verified' and not checked:
        skill['status'] = 'unchecked'
    skill['popularity'] = _heat(skill['popularity'], skill['url'], checked, now)
    floor = datetime.min.replace(tzinfo=UTC)

    def rank(date, attempted, status):
        # On an undated tie, failure wins rather than hiding a necessary retry.
        return (date or floor, attempted or date or floor, status == 'unavailable')

    baseline = rank(checked, checked, skill['status'])
    candidates = []
    for snapshot in history:
        if not isinstance(snapshot, dict) or not isinstance(snapshot.get('skills'), list):
            continue
        attempted = _date(snapshot.get('attemptedAt'), now)
        if snapshot.get('attemptedAt') is not None and not attempted:
            continue
        for row in snapshot['skills']:
            if not isinstance(row, dict) or row.get('id') != skill['id'] or row.get('url') != skill['url']:
                continue
            status = row.get('status')
            date = _date(row.get('checkedAt'), now)
            if status not in ('verified', 'unavailable', 'unchecked'):
                continue
            if (row.get('checkedAt') is not None and not date) or (status == 'verified' and not date):
                continue
            if status == 'unchecked' and date:
                continue
            if attempted and date and attempted < date:
                continue
            key = rank(date, attempted, status)
            if key > baseline:
                candidates.append((key, row, date))
    for _, row, date in sorted(candidates, key=lambda item: item[0]):
        skill['checkedAt'] = row.get('checkedAt')
        skill['status'] = row['status']
        heat = _heat(row.get('popularity'), skill['url'], date, now)
        old = skill['popularity']
        if heat and (not old or parse_date(heat['collectedAt']) >= parse_date(old['collectedAt'])):
            skill['popularity'] = heat
        elif 'popularity' in row and row['popularity'] is None and row['status'] == 'verified':
            skill['popularity'] = None


def _identity(skill):
    """No inferred hosts, query credentials, mirrors or arbitrary provider URLs."""
    url = skill['url']
    if not public_url(url):
        raise CollectionError('unsafe_url', 'Skill 原文必须是无凭据的公网 HTTPS')
    parsed = urlsplit(url)
    parts = parsed.path.strip('/').split('/')
    if (parsed.hostname != 'skills.sh' or parsed.query or parsed.fragment or len(parts) != 3
            or any(not re.fullmatch(r'[A-Za-z0-9_.-]+', part) or part in ('.', '..') for part in parts)):
        raise CollectionError('unsafe_url', '仅支持维护配置中的 skills.sh 单 Skill 原文')
    owner, project, name = parts
    author = re.sub(r'\s*/\s*', '/', skill['author'].strip())
    if name.casefold() != skill['name'].casefold() or author.casefold() != f'{owner}/{project}'.casefold():
        raise CollectionError('identity', 'Skill 配置名称、作者项目与 URL 不一致')
    return owner, project, name


class _Node:
    def __init__(self, tag, attrs=(), parent=None):
        self.tag, self.attrs, self.parent = tag, dict(attrs), parent
        self.children = []

    def text(self):
        return ' '.join(' '.join(child.text() if isinstance(child, _Node) else child
                                for child in self.children).split())

    def ancestors(self):
        node = self.parent
        while node is not None:
            yield node
            node = node.parent


class _Page(HTMLParser):
    VOID = {'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr'}
    HIDDEN = {'head', 'script', 'style', 'template', 'noscript', 'svg', 'iframe'}

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.root = _Node('root')
        self.stack = [(self.root, False)]
        self.nodes = []
        self.redirect = False

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == 'meta' and (attrs.get('http-equiv') or '').lower() == 'refresh':
            self.redirect = True
        if len(self.nodes) >= 30000 or len(self.stack) >= 128:
            raise CollectionError('size', 'Skill 页面结构超出解析上限')
        parent, hidden = self.stack[-1]
        hidden = (hidden or tag in self.HIDDEN or 'hidden' in attrs or 'inert' in attrs
                  or (attrs.get('aria-hidden') or '').lower() == 'true'
                  or bool(re.search(r'(?:display\s*:\s*none|visibility\s*:\s*hidden)', attrs.get('style') or '', re.I)))
        node = _Node(tag, attrs, parent)
        if not hidden:
            parent.children.append(node)
            self.nodes.append(node)
        if tag not in self.VOID:
            self.stack.append((node, hidden))

    def handle_startendtag(self, tag, attrs):
        self.handle_starttag(tag, attrs)
        if tag not in self.VOID:
            self.handle_endtag(tag)

    def handle_endtag(self, tag):
        for index in range(len(self.stack) - 1, 0, -1):
            if self.stack[index][0].tag == tag:
                del self.stack[index:]
                break

    def handle_data(self, data):
        node, hidden = self.stack[-1]
        if not hidden and data.strip():
            node.children.append(data)


def _count(raw):
    if COMPACT.fullmatch(raw):
        return raw + ROUNDED
    if re.fullmatch(r'(?:0|[1-9][0-9]{0,15}|[1-9][0-9]{0,2}(?:,[0-9]{3}){1,5})', raw):
        count = int(raw.replace(',', ''))
        if count <= 2**53 - 1:
            return count
    return None


def _popularity(page, url, now):
    # Entire small DOM blocks must label All Time *installs*. Do not search for
    # a number near arbitrary prose, stars, example code, related cards or tables.
    candidates = []
    for node in page.nodes:
        if node.tag not in ('div', 'section', 'aside', 'dl', 'p', 'span'):
            continue
        if any(parent.tag in ('a', 'article', 'pre', 'code', 'table', 'nav', 'footer') for parent in node.ancestors()):
            continue
        text = node.text()
        match = STATS.fullmatch(text) if len(text) <= 150 else None
        if match:
            candidates.append((node, match.group(1)))
            if len(candidates) > 64:
                return None
    # Prefer the smallest label/value block; do not also parse its enclosing grid.
    leaves = [(node, raw) for node, raw in candidates
              if not any(node in other.ancestors() for other, _ in candidates if other is not node)]
    values = []
    for node, raw in leaves:
        # Only an unambiguous detail-page statistics area, never another skill's
        # card or directory total. Ambiguous layouts deliberately yield no heat.
        scope = next((p for p in node.ancestors() if p.tag in ('section', 'aside', 'main')), page.root)
        scoped = [n for n in page.nodes if scope in n.ancestors()]
        headings = {'all time installs', 'installs', 'all time', 'statistics', 'install statistics'}
        if any(n.tag in ('h2', 'h3', 'h4', 'h5', 'h6') and n.text().casefold() not in headings
               and not any(p.tag in ('article', 'pre', 'code') for p in n.ancestors()) for n in scoped):
            continue
        if any(n.tag == 'a' and urlsplit(urljoin(url, n.attrs.get('href') or '')).path.rstrip('/') != urlsplit(url).path.rstrip('/')
               and len(urlsplit(urljoin(url, n.attrs.get('href') or '')).path.strip('/').split('/')) == 3 for n in scoped):
            continue
        values.append(_count(raw))
    if not values or None in values or len(set(values)) != 1:
        return None
    return {'metric': METRIC, 'value': values[0], 'source': url, 'window': WINDOW, 'collectedAt': stamp(now)}


def _parse(response, skill, identity, now):
    owner, project, name = identity
    if not public_url(response.url):
        raise CollectionError('redirect', '拒绝不安全的 Skill 响应 URL')
    final = urlsplit(response.url)
    original = urlsplit(skill['url'])
    if (final.hostname not in SKILL_HOSTS or final.path.rstrip('/') != original.path.rstrip('/')
            or final.query or final.fragment):
        raise CollectionError('redirect', '响应不是配置中的单 Skill 原文')
    if response.content_type.split(';', 1)[0].strip().lower() not in ('text/html', 'application/xhtml+xml'):
        raise CollectionError('html', 'Skill 响应不是 HTML 原文')
    if not isinstance(response.body, bytes) or len(response.body) > MAX_BYTES:
        raise CollectionError('size', 'Skill 响应超过大小上限')
    if is_challenge(response.body):
        raise CollectionError('blocked', '防护页不是 Skill 原文')
    page = _Page()
    page.feed(response.body.decode('utf-8'))
    page.close()
    visible = page.root.text()
    if page.redirect or re.search(r'verify (?:that )?you are human|checking your browser|captcha|access denied|security checkpoint|安全验证|验证码|page not found|skill not found|404\s*[:—-]?\s*(?:not found|this page)', visible, re.I):
        raise CollectionError('blocked', '跳转、错误或防护页不是 Skill 原文')
    headings = [node.text().casefold() for node in page.nodes if node.tag == 'h1']
    if headings != [name.casefold()]:
        raise CollectionError('identity', '页面缺少对应的单 Skill 标题')
    project_text = re.sub(r'\s*/\s*', '/', visible).casefold()
    matched = bool(re.search(r'(?<![\w.-])' + re.escape(f'{owner}/{project}'.casefold()) + r'(?![\w./-])', project_text))
    if not matched:
        links = {(urlsplit(urljoin(skill['url'], n.attrs.get('href') or '')).path.rstrip('/'), n.text().casefold())
                 for n in page.nodes if n.tag == 'a'}
        matched = (f'/{owner}', owner.casefold()) in links and (f'/{owner}/{project}', project.casefold()) in links
    if not matched:
        raise CollectionError('identity', '页面缺少对应的作者和项目')
    heat = _popularity(page, skill['url'], now)
    # Name/breadcrumbs plus a loading root is not original skill content. A real
    # prose/instruction block or an explicit verified install statistic is needed.
    content = any(n.tag in ('p', 'li', 'pre') and len(n.text()) >= 40
                  and any(p.tag in ('main', 'article') for p in n.ancestors())
                  and not any(p.tag in ('nav', 'footer', 'header', 'aside', 'a') for p in n.ancestors())
                  and not re.search(r'loading|please wait|enable javascript|sign in|log in', n.text(), re.I)
                  for n in page.nodes)
    if not content and heat is None:
        raise CollectionError('shell', '页面只有导航或外壳，未取得 Skill 内容')
    return heat


def refresh_skills(configured, history, now, offline=False, http=None) -> list:
    """Return a deep copy of <=12 configured entries, in maintained list order.

    history is an iterable of dashboard snapshots (only their skills are used;
    attemptedAt only disambiguates equal successful checkedAt values). now must
    be timezone-aware. Verified checks younger than seven days are reused; at
    exactly seven days they are due. Unavailable/unchecked entries always retry
    online. Offline never constructs a client or changes observation timestamps.
    Failed checks retain previous successful checkedAt and popularity; a valid
    page without a provable metric is verified with popularity=None.
    """
    if not isinstance(now, datetime) or now.tzinfo is None or now.utcoffset() is None:
        raise ValueError('clock must have a timezone')
    now = now.astimezone(UTC)
    if not isinstance(configured, list) or len(configured) > MAX_SKILLS:
        raise ValueError('skills must be a maintained list of at most 12 entries')
    result = copy.deepcopy(configured)
    for skill in result:
        shape(skill, 'skill')
    history = list(history or ())
    client = http
    for skill in result:
        _merge_history(skill, history, now)
        checked = _date(skill['checkedAt'], now)
        if offline:
            continue
        try:
            identity = _identity(skill)
            if skill['status'] == 'verified' and checked and now - checked < REFRESH_AFTER:
                continue
            if client is None:
                client = PublicHTTP(max_requests=MAX_SKILLS, timeout=10, max_bytes=MAX_BYTES, total_seconds=120)
            response = client.get(skill['url'], allowed_hosts=SKILL_HOSTS)
            heat = _parse(response, skill, identity, now)
        except (CollectionError, OSError, ValueError):
            skill['status'] = 'unavailable'
            continue
        skill.update(checkedAt=stamp(now), status='verified', popularity=heat)
    return result
