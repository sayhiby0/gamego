#!/usr/bin/env python3
"""GameGo local public pipeline. Python standard library only; no cloud/deploy side effects."""
from __future__ import annotations

import argparse
import copy
from datetime import datetime
import json
from pathlib import Path
import sys
import time

# Also usable as `import scripts.pipeline` without installing a package.
SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

from collectors import (CollectionError, PublicHTTP, REVIEW_DEFINITION, REVIEW_PARAMS,
                        collect_with_fallback, dedupe_news, news_url, parse_announcements,
                        parse_chart, parse_feed, parse_reviews, review_url)
from content_processing import PROCESS_SECONDS, process_movements, process_news
from public_data import (BEIJING, ROOT, UTC, apply_history, comparable_key, digest, load_history, parse_date,
                         public_url, publish, read_json, stale_board, stamp, validate_dashboard)
from skill_refresh import refresh_skills


def source_ref(source):
    return {'id': source['id'], 'name': source['name'], 'url': source['url']}


def board_template(metric, source, mobile=False):
    if mobile:
        reasons = {'popularity': 'TapTap 榜单未取得稳定合规的有效字段；不启用错配/未知游戏ID，不以全应用免费榜替代',
                   'reputation': '手游评分量纲、评价数及近期评论未打通；不从评分总值推测近期情绪',
                   'commercial': '中国手游收入/畅销来源未核验；Apple免费/付费应用榜不是收入或销售份数榜'}
        return {'id': 'mobile-' + metric, 'title': '手游' + {'popularity': '人气', 'reputation': '口碑', 'commercial': '商业表现'}[metric],
                'platform': 'mobile', 'source': source, 'metric': metric, 'definition': reasons[metric],
                'scope': '中国手游；来源覆盖缺失', 'unit': '未核验', 'period': '未核验',
                'methodologyVersion': 'mobile-unavailable-v1', 'observedAt': None,
                'status': 'unavailable', 'reason': reasons[metric], 'items': []}
    definitions = {'popularity': 'Steam Current Players：采集时同时在线人数，不是DAU；Peak Today日界线未核实，不计算日峰值涨幅。',
                   'commercial': 'Steam Global Top Sellers，页面明示按revenue排序；精确窗口、收入构成未核实。无金额/份数，非净收入/销量榜；页面自带变化不用作本项目涨幅。',
                   'reputation': REVIEW_DEFINITION}
    board = {'id': 'steam-' + metric, 'title': {'popularity': 'Steam 采集时在线人数', 'commercial': 'Steam 全球畅销（收入排名）', 'reputation': 'Steam 当期候选口碑（本查询汇总）'}[metric],
             'platform': 'pc', 'source': {'id': 'steam', 'name': 'Steam', 'url': source['url']}, 'metric': metric,
             'definition': definitions[metric], 'scope': 'Steam 全球',
             'unit': {'popularity': '人（同时在线）', 'commercial': '名次（金额/份数未披露）', 'reputation': '%（本查询汇总好评率）'}[metric],
             'period': '采集时刻' if metric == 'popularity' else '平台实时收入排名，精确计算窗口未确认' if metric == 'commercial' else '本查询服务端汇总，精确时间窗口未核实；非近30天',
             'methodologyVersion': source.get('methodologyVersion', 'steam-query-v1'),
             'observedAt': None, 'status': 'unavailable', 'reason': '尚未取得本次有效数据', 'items': [],
             'dataType': 'platform_rank' if metric != 'reputation' else 'query_summary'}
    if metric == 'reputation':
        board.update(minimumSample=100, queryParameters=dict(REVIEW_PARAMS))
    return board


def select_movements(boards, product_map=None, history=()):
    """Independent platform quotas, deterministic priority, optional verified product aliases."""
    product_map = product_map or {}
    options = []
    for board in boards:
        if board['status'] not in ('ok', 'partial') or board['metric'] not in ('popularity', 'commercial'):
            continue
        comparable = [b for snap in history for b in snap['rankings'] if b['items'] and b['observedAt']
                      and comparable_key(b) == comparable_key(board) and b['observedAt'] < board['observedAt']]
        previous = max(comparable, key=lambda b: b['observedAt']) if comparable else None
        prior_ids = {i['gameId'] for i in previous['items']} if previous else set()
        for item in board['items']:
            change = item.get('rankChange')
            entered = previous['observedAt'] if previous and item['gameId'] not in prior_ids else None
            priority = ((0, -change, item['rank']) if change is not None and change > 0 else
                        (1, item['rank'], 0) if entered else (2, item['rank'], 0))
            options.append((priority, board['platform'], board['id'], item['gameId'], board, item, entered))
    seen, counts, result = set(), {'pc': 0, 'mobile': 0}, []
    for _, platform, _, _, board, item, entered in sorted(options, key=lambda row: row[:4]):
        product = product_map.get(item['gameId'], item['gameId'])
        if product in seen or counts[platform] >= {'pc': 2, 'mobile': 4}[platform]:
            continue
        seen.add(product)
        counts[platform] += 1
        change = item.get('rankChange')
        reason = ('对比上次同来源同口径快照 ' + item['baselineAt'] + f'，{board["title"]}上升{change}名；不是日涨幅'
                  if change is not None and change > 0 else
                  f'对比 {entered}，首次进入本项目已采集的{board["title"]}前20候选；不代表游戏首发或日增长' if entered else
                  f'当期{board["title"]}第{item["rank"]}入选；未将首次采集或当期位置当作增长')
        result.append({'id': digest([product, board['observedAt']])[:24], 'gameId': product, 'name': item['name'],
                       'platform': platform, 'reason': reason, 'observedAt': board['observedAt'],
                       'positive': [], 'negative': [], 'events': [], 'insight': None, 'status': 'insufficient',
                       'limitations': [], 'sources': [board['source']], '_platformGameId': item['gameId']})
    return result


def load_config(path=ROOT / 'config/sources.json'):
    config = json.loads(path.read_text(encoding='utf-8'))
    if config.get('schemaVersion') != 1 or not isinstance(config.get('sources'), list):
        raise ValueError('invalid source registry')
    seen = set()
    for source in config['sources']:
        if not source.get('id') or source['id'] in seen or not public_url(source.get('url')):
            raise ValueError('invalid or duplicate registry source')
        seen.add(source['id'])
        if source.get('enabled') and any(m.get('identity') in ('unknown', 'mismatch', 'not_a_chart') for m in source.get('gameMappings', [])):
            raise ValueError('unverified game mapping cannot be enabled')
        if source.get('enabled') and source.get('adapter') not in ('rss', 'steam_chart', 'steam_reviews', 'steam_announcements'):
            raise ValueError('enabled source requires supported adapter')
    return config


def run_pipeline(output_dir=None, offline=False, now=None, http=None, config=None, post=None):
    now = now or datetime.now(UTC)
    if now.tzinfo is None:
        raise ValueError('clock must have a timezone')
    output = Path(output_dir).resolve() if output_dir else ROOT / 'site/data'
    # Only this explicit data directory is created; nothing touches existing backend/JS/config.
    output.mkdir(parents=True, exist_ok=True)
    config = config or load_config()
    policy = config['policy']
    http = http or PublicHTTP(max_requests=min(90, policy.get('maxRequests', 90)),
                              timeout=min(15, policy.get('timeoutSeconds', 10)),
                              max_bytes=min(2_000_000, policy.get('maxBytes', 2_000_000)),
                              total_seconds=min(300, policy.get('totalSeconds', 240)))
    history = load_history(output, now)
    previous_coverage = {}
    for snapshot in history:
        for row in snapshot['coverage']:
            if row['lastSuccessAt']:
                previous_coverage.setdefault(row['id'], row['lastSuccessAt'])
    sources = {source['id']: source for source in config['sources']}
    coverage = {}
    for source in sources.values():
        coverage[source['id']] = {'id': source['id'], 'name': source['name'], 'method': source['method'], 'url': source['url'],
                                 'status': 'not_attempted' if offline or source['enabled'] else 'not_configured',
                                 'attemptedAt': None, 'lastSuccessAt': previous_coverage.get(source['id']),
                                 'reason': '离线模式：未尝试网络，不代表采集成功' if offline else source['reason'], 'count': 0}
    attempted_at, any_success, news, boards = stamp(now), False, [], []

    def record_attempt(source_id, ok, reason, count=0):
        nonlocal any_success
        row = coverage[source_id]
        row.update(status='ok' if ok else 'failed', attemptedAt=attempted_at, reason=reason, count=count)
        if ok:
            row['lastSuccessAt'] = attempted_at
            any_success = True

    # Steam first to avoid using the whole finite run budget on unreachable RSS hosts.
    daily = sorted((s for s in sources.values() if s.get('mode') == 'daily'), key=lambda s: s.get('purpose') != 'ranking')
    for source in daily:
        is_chart = source.get('adapter') == 'steam_chart'
        board = board_template(source['metric'], source) if is_chart else None
        if not source['enabled'] or offline:
            if board:
                board['reason'] = coverage[source['id']]['reason']
                boards.append(board if offline else stale_board(board, history))
            continue

        def collect(current):
            response = http.get(current['url'], current.get('allowedHosts', []))
            if current['adapter'] == 'rss':
                return parse_feed(response.body, current)
            if current['adapter'] == 'steam_chart':
                return parse_chart(response.body, current['metric'])
            raise CollectionError('configuration', '没有启用此类适配器')

        data, used, attempts, failure = collect_with_fallback(source, sources, collect, now)
        for attempt in attempts:
            record_attempt(attempt['id'], attempt['ok'], attempt['reason'], len(data) if attempt['ok'] else 0)
        if used and used['id'] != source['id']:
            coverage[source['id']]['reason'] += '；实际使用已登记同口径替代入口：' + used['name'] + ' (' + used['id'] + ')'
        if data is None:
            coverage[source['id']]['reason'] = failure
        if board:
            if data is not None:
                board.update(items=data, observedAt=attempted_at, status='ok', reason='本次本机解析有效app行；最多20项，不表示持续生产可用')
                board['source']['url'] = used['url']
                apply_history(board, history)
            else:
                board['reason'] = failure
                board = stale_board(board, history)
            boards.append(board)
        elif data is not None:
            fresh_count = sum(0 <= (now - parse_date(row['publishedAt'])).total_seconds() <= 86400 for row in data)
            coverage[used['id']]['reason'] += f'；{len(data)}条有效日期订阅，24小时内{fresh_count}条（主题筛选前）'
            news.extend(data)

    # Always preserve the Steam dimensions even in reduced/test registries.
    for metric in ('popularity', 'commercial'):
        if not any(b['platform'] == 'pc' and b['metric'] == metric for b in boards):
            boards.append(board_template(metric, {'url': 'https://store.steampowered.com/charts/' + ('mostplayed' if metric == 'popularity' else 'topselling/global')}))
    candidates = {row['gameId']: row for board in boards if board['status'] == 'ok' for row in board['items']}
    review_source = sources.get('steam-reviews')
    reputation = board_template('reputation', review_source or {'url': 'https://store.steampowered.com/reviews/'})
    reputation['queryParameters']['candidateIds'] = sorted(candidates)
    reputation['queryParameters']['evaluatedIds'] = []
    review_items, reviews_ok, reviews_failed = [], 0, 0
    if not offline and review_source and review_source['enabled'] and candidates:
        for game_id, item in sorted(candidates.items()):
            try:
                response = http.get(review_url(game_id.split(':')[1]), review_source['allowedHosts'])
                review = parse_reviews(response.body, now)
                reviews_ok += 1
                reputation['queryParameters']['evaluatedIds'].append(game_id)
                if review['total'] >= 100:
                    review_items.append(dict(item, value=round(100 * review['positive'] / review['total'], 2), reviewCount=review['total'],
                                             previousRank=None, rankChange=None, baselineAt=None))
            except CollectionError:
                reviews_failed += 1
        record_attempt('steam-reviews', reviews_ok > 0,
                       f'当期候选并集{len(candidates)}款，明确查询参数汇总成功{reviews_ok}款、失败{reviews_failed}款；100条门槛通过{len(review_items)}款；'
                       '服务端汇总时间窗口未核实，不称近30天/完整历史；无已验证同口径fallback', reviews_ok)
    if reviews_ok:
        for index, item in enumerate(sorted(review_items, key=lambda r: (-r['value'], -r['reviewCount'], r['gameId']))[:20], 1):
            item['rank'] = index
            reputation['items'].append(item)
        reputation.update(observedAt=attempted_at, status='partial' if reviews_failed else 'ok',
                          reason=f'仅当期榜单候选并集；{reviews_ok}款汇总有效，{reviews_failed}款失败；不足100评价不入榜')
        apply_history(reputation, history)
    else:
        reputation['reason'] = ('离线模式：未尝试评价采集' if offline else
                                '没有当期有效候选或候选评价全部失败；无同口径fallback，不以历史候选冒充当期口碑')
        if not offline:
            # Old candidate sets may be shown ONLY as an explicitly stale whole board, not merged.
            compatible = copy.deepcopy(reputation)
            old = next((b for snap in history for b in snap['rankings'] if b['id'] == reputation['id'] and b['methodologyVersion'] == reputation['methodologyVersion'] and b.get('queryParameters') and all(b['queryParameters'].get(k) == v for k, v in REVIEW_PARAMS.items())), None)
            if old:
                compatible['queryParameters'] = old['queryParameters']
                reputation = stale_board(compatible, history)
    boards.append(reputation)
    for metric in ('popularity', 'reputation', 'commercial'):
        ref = {'id': 'mobile-commercial-unavailable' if metric == 'commercial' else 'taptap',
               'name': '中国手游商业数据（未接入）' if metric == 'commercial' else 'TapTap（未接入）',
               'url': 'https://www.taptap.cn/top'}
        boards.append(board_template(metric, ref, mobile=True))

    movements = select_movements(boards, history=history)
    announcements_source = sources.get('steam-announcements')
    announcement_attempts, announcement_successes = 0, 0
    for card in movements:
        appid = card.pop('_platformGameId').split(':')[1]
        url = review_url(appid, recent=True)
        samples = []
        if not offline and review_source and review_source['enabled']:
            try:
                samples = parse_reviews(http.get(url, review_source['allowedHosts']).body, now, recent=True)['samples']
                card['sources'].append({'id': 'steam-reviews', 'name': 'Steam 最近排序评价（本页匿名样本）', 'url': url})
                for positive, field in ((True, 'positive'), (False, 'negative')):
                    card[field] = [{'text': row['publishedAt'] + ' · 匿名原文节选（非总体结论）：' + row['text'], 'sourceUrl': url}
                                   for row in samples if row['positive'] is positive][:2]
            except CollectionError as exc:
                card['limitations'].append('评价样本：' + str(exc) + '；无已验证同口径fallback')
        if not offline and announcements_source and announcements_source['enabled']:
            announcement_attempts += 1
            try:
                card['events'] = parse_announcements(http.get(news_url(appid), announcements_source['allowedHosts']).body, appid, now)
                announcement_successes += 1
                for event in card['events']:
                    card['sources'].append({'id': 'steam-announcements', 'name': 'Steam 官方公告', 'url': event['sourceUrl']})
            except CollectionError as exc:
                card['limitations'].append('官方公告：' + str(exc) + '；无已验证同口径fallback')
        card['limitations'].extend([
            f'filter=recent只表示排序；本次最多取一页100条，按timestamp_created严格筛近7天，匿名有效样本{len(samples)}条；非完整近7天评价。',
            '评价查询 language=all、purchase_type=all、review_type=all、day_range=365，三项过滤均=1；汇总好评率与本页样本分开。',
            '近期匿名有效样本不足20条，不输出情绪变化强结论。' if len(samples) < 20 else '有20条以上匿名样本也不自动推断代表性、因果或全体玩家态度。'])
        card['status'] = 'partial' if (samples or card['events']) and len(samples) >= 20 else 'insufficient'
        if not samples and not card['events']:
            card['limitations'].append('最近7天未取得可核验匿名评价或官方公告，保留证据不足提示卡。')
    if announcement_attempts:
        record_attempt('steam-announcements', announcement_successes > 0,
                       f'仅入选游戏按需请求{announcement_attempts}次，{announcement_successes}次JSON有效；另逐条核对appid/官方feed/发布时间，外部媒体不称公告', announcement_successes)

    news = dedupe_news(news, now)
    # Validate the entire public draft BEFORE any potentially paid processing request.
    clean_news = [{k: v for k, v in item.items() if not k.startswith('_')} for item in news]
    skills = refresh_skills(read_json(ROOT / 'config/skills.json') or [], history, now, offline=offline, http=http)
    notice = ('离线模式：所有网络来源和AI均未尝试；空数据不是采集成功。' if offline else
              '本次有限本地公开采集；未做生产持续验收。手游三维度缺失；AI未成功的条目只保留标题和来源。' if any_success else
              '本次公开采集全部未取得有效字段；保留上次有效latest（如有），本次失败时间见manifest；不伪造当前数据。')
    dashboard = {'schemaVersion': 1, 'dataDate': now.astimezone(BEIJING).date().isoformat(), 'attemptedAt': attempted_at,
                 'lastSuccessAt': attempted_at if any_success else None, 'status': 'partial' if any_success else 'unavailable' if offline else 'failed',
                 'notice': notice, 'news': clean_news, 'rankings': boards, 'movements': movements, 'skills': skills, 'coverage': list(coverage.values())}
    validate_dashboard(dashboard)
    kwargs = {'post': post} if post else {}
    deadline = time.monotonic() + PROCESS_SECONDS
    process_news(news, history, offline=offline, max_items=min(30, policy.get('contentMaxItems', 30)), deadline=deadline, **kwargs)
    process_movements(movements, offline=offline, now=now, deadline=deadline, **kwargs)
    dashboard['news'] = [{k: v for k, v in item.items() if not k.startswith('_')} for item in news]
    validate_dashboard(dashboard)
    manifest = publish(output, dashboard, any_success, now)
    return dashboard, manifest


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--offline', action='store_true', help='不尝试网络，输出诚实的不可用空板；已有有效latest不覆盖')
    parser.add_argument('--output-dir', type=Path, default=ROOT / 'site/data', help='公开JSON输出目录，可使用临时目录')
    args = parser.parse_args(argv)
    try:
        data, manifest = run_pipeline(args.output_dir, args.offline)
    except (OSError, ValueError, KeyError, TypeError) as exc:
        print('Pipeline failed before publication: ' + type(exc).__name__, file=sys.stderr)
        return 1
    print(json.dumps({'outputDir': str(args.output_dir.resolve()), 'status': manifest['status'],
                      'attemptedAt': manifest['attemptedAt'], 'lastSuccessAt': manifest['lastSuccessAt'],
                      'news': len(data['news']), 'rankingItems': sum(len(b['items']) for b in data['rankings']),
                      'movements': len(data['movements']), 'networkAttempted': not args.offline}, ensure_ascii=False))
    return 0 if args.offline or data['lastSuccessAt'] else 2


if __name__ == '__main__':
    raise SystemExit(main())
