"""Build the maintainable registry from minimal checked metadata, never raw evidence bodies.

Run only when intentionally refreshing config/sources.json; the daily pipeline reads JSON.
"""
from __future__ import annotations

import csv
import hashlib
import json
from pathlib import Path
import re
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[1]
NATIVE = {'IGN': 'ign', 'Kotaku': 'kotaku', 'GameSpot': 'gamespot', 'Polygon': 'polygon',
          'Eurogamer': 'eurogamer', 'Rock Paper Shotgun': 'rps', 'VG247': 'vg247',
          'Gematsu': 'gematsu', 'PlayStation Blog': 'playstation', '机核': 'gcores', '触乐': 'chuapp'}
GAMES = {'168332': ('原神', 'verified'), '34599': ('PATIENCE（不是明日方舟）', 'mismatch'),
         '142793': ('不休的乌拉拉（先行服；非全站榜）', 'not_a_chart'),
         '328943': ('崩坏：星穹铁道（旧映射未确认）', 'unknown'),
         '183019': ('绝区零（旧映射未确认）', 'unknown'), '200112': ('王者荣耀（旧映射未确认）', 'unknown'),
         '218205': ('鸣潮（旧映射未确认）', 'unknown')}


def build_registry():
    sources = {}
    with (ROOT / 'validation/渠道验证清单.csv').open(encoding='utf-8-sig', newline='') as handle:
        for row in csv.DictReader(handle):
            name, category, url = row['来源'], row['类别'], row['请求或结果链接']
            if category in ('搜索命中文章抽查', '浏览器/文档补查'):
                continue
            method = 'rss' if category == 'native_rss' else 'rsshub' if category.startswith('rsshub') else 'controlled_search' if category == '定向搜索' else 'web'
            if method == 'controlled_search':
                match = re.search(r'site:([^\s]+)', row['有效字段或失败依据'])
                domain = match[1].strip('"') if match else 'www.youxiputao.com'
                url = 'https://' + domain.rstrip('/') + '/'
            if not url:
                continue
            if url.startswith('http://'):
                # Candidate registration only, not an assertion HTTPS article transport works.
                url = 'https://' + url[len('http://'):]
            key = method + ':' + url
            if key in sources:
                continue
            ident = NATIVE.get(name) if method == 'rss' else None
            if url.endswith('/charts/mostplayed'):
                ident = 'steam-popularity'
            elif url.endswith('/charts/topselling/global'):
                ident = 'steam-commercial'
            elif '/appreviews/' in url:
                ident = 'steam-reviews'
            elif '/ISteamNews/GetNewsForApp/' in url:
                ident = 'steam-announcements'
            ident = ident or method + '-' + hashlib.sha256(url.encode()).hexdigest()[:12]
            enabled = method == 'rss' and name != 'Kotaku'
            state = 'enabled_local' if enabled else 'not_configured'
            reason = '仅限有限公开订阅采集；原文许可与持续稳定性仍待验收' if enabled else row['判定'] + '；本流水线未启用，未宣称生产接入'
            if method == 'rsshub':
                reason = '公共 RSSHub 实例首轮403；未取得路由/访问许可依据，不换镜像、不绕过'
            if method == 'controlled_search':
                reason = '只登记域名定向发现计划；没有受控搜索服务、账户预算或正文日期核验适配器；本次不搜索'
            metric, adapter, purpose = None, 'rss' if enabled else None, 'news' if method in ('rss', 'rsshub') else 'discovery'
            series = ident
            scope = '来源订阅条目，发布时间前24小时'
            version = 'rss-published-v1'
            if ident in ('steam-popularity', 'steam-commercial'):
                metric = ident.split('-')[1]
                adapter, purpose, enabled, state = 'steam_chart', 'ranking', True, 'enabled_local'
                series, scope, version = 'steam', 'Steam 全球', 'steam-html-' + metric + '-v1'
                reason = '解析真实app表格行；首次无历史不计算涨幅；仅本地采集未做生产持续验收'
            if ident in ('steam-reviews', 'steam-announcements'):
                adapter = 'steam_reviews' if ident == 'steam-reviews' else 'steam_announcements'
                purpose, enabled, state, series = 'evidence', True, 'on_demand', 'steam'
                version, scope = 'steam-explicit-query-v1', '仅当期榜单候选，按需、有限量'
                reason = '仅由当期Steam候选按需调用；不使用登记样本appid作为固定监控列表'
            mapping = []
            match = re.search(r'(?:/app/|/topic/)(\d+)', url)
            if 'taptap' in url and match:
                appid = match[1]
                game, identity = GAMES[appid]
                mapping = [{'platformId': appid, 'game': game, 'identity': identity, 'enabled': False}]
                enabled, state = False, 'disabled_mapping'
                reason = f'TapTap {appid}：{game}；身份状态={identity}；即使身份匹配也未打通评分/评论/榜单，禁用旧路由'
            if category == 'official_configured':
                mapping = [{'game': name.replace(' official', ''), 'identity': 'official_home_only', 'enabled': False}]
            check = row['检查UTC或记录批次']
            sources[key] = {'id': ident, 'name': name, 'purpose': purpose, 'method': method, 'url': url,
                            'regions': ['CN'] if any(x in url for x in ('.cn', '.qq.com', '.mihoyo.com', '.hypergryph.com')) or name in ('机核', '触乐') else ['global'],
                            'languages': ['zh'] if re.search('[\u4e00-\u9fff]', name) else ['en'],
                            'gameMappings': mapping, 'metric': metric, 'scope': scope, 'seriesId': series,
                            'methodologyVersion': version, 'authentication': 'none_public_only',
                            'license': '公开可读不等于取得批量采集或再分发许可；仅短元数据，持续使用待验收',
                            'cost': 'no_paid_call' if method != 'controlled_search' else 'not_authorized_not_configured',
                            'enabled': enabled, 'mode': 'daily' if purpose in ('news', 'ranking') else 'on_demand',
                            'status': state, 'adapter': adapter, 'checkedAt': check,
                            'lastSuccessAt': None, 'reason': reason, 'fallbacks': [], 'fallbackVerified': False,
                            'allowedHosts': [urlsplit(url).hostname], 'httpsUpgradeHosts': [],
                            'validation': {'file': 'validation/' + row['证据文件'], 'environment': 'one_off_local_or_tool_not_production', 'verdict': row['判定']}}
    # Only canonical endpoints actually reached and parsed in the existing validation qualify.
    feeds = json.loads((ROOT / 'validation/feeds.json').read_text(encoding='utf-8'))
    for row in feeds['results']:
        source = next((s for s in sources.values() if s['method'] == 'rss' and s['url'] == row['url']), None)
        if not source or not source['enabled']:
            continue
        final = row.get('final_url')
        if final and final != source['url']:
            source['allowedHosts'].append(urlsplit(final).hostname)
            alternate = dict(source, id=source['id'] + '-canonical', url=final, mode='fallback_only',
                             fallbackVerified=True, fallbacks=[], reason='既有本机验证到达并解析的同一订阅规范入口；仅主入口失败时使用')
            alternate['validation'] = dict(source['validation'], file='validation/feeds.json', verdict='validated_redirect_destination_same_feed')
            source['fallbacks'].append(alternate['id'])
            sources['canonical:' + final] = alternate
        if source['id'] == 'chuapp':
            source['httpsUpgradeHosts'] = ['www.chuapp.com']
    return {'schemaVersion': 1,
            'policy': {'environment': 'local_pipeline_not_production_acceptance', 'maxFallbacks': 2,
                       'maxRequests': 90, 'timeoutSeconds': 10, 'totalSeconds': 240, 'maxBytes': 2000000,
                       'newsHours': 24, 'newsLimit': 30, 'rankingLimit': 20, 'minimumReviews': 100,
                       'movementLimits': {'pc': 2, 'mobile': 4}, 'retentionDays': 30,
                       'contentMaxItems': 30,
                       'search': 'disabled; future adapter must enforce domain/date/quote/budget controls, not search-result publication',
                       'web': 'only Steam table adapter enabled; other HTML candidates need dated-field adapters and access review'},
            'sources': list(sources.values())}


if __name__ == '__main__':
    output = ROOT / 'config/sources.json'
    output.write_text(json.dumps(build_registry(), ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(str(output))
