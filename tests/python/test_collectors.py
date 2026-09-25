import copy
from datetime import datetime, timedelta, timezone
import json
from pathlib import Path
import sys
import unittest
from unittest.mock import MagicMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'scripts'))
from collectors import (ChartParser, CollectionError, PublicHTTP, Response, collect_with_fallback,
                        dedupe_news, feed_date, parse_announcements, parse_chart, parse_feed,
                        parse_reviews, review_url)
from public_data import stamp

NOW = datetime(2026, 9, 23, 8, tzinfo=timezone.utc)
SOURCE = {'id': 'test', 'name': 'Test Games', 'url': 'https://example.com/feed', 'httpsUpgradeHosts': []}


def feed(title='Steam game update announced today', url='https://example.com/article', date=None, excerpt='A game update announcement'):
    return f'<rss><channel><item><title>{title}</title><link>{url}</link><pubDate>{date or stamp(NOW - timedelta(hours=1))}</pubDate><description>{excerpt}</description></item></channel></rss>'.encode()


def chart(metric='popularity', count=2):
    heading = 'Most Played Current Players Peak Today' if metric == 'popularity' else 'Global Top Sellers by revenue Rank Price Change Weeks'
    rows = []
    for index in range(1, count + 1):
        last = f'<td>{10000-index:,}</td><td>20,000</td>' if metric == 'popularity' else '<td>▲ 3</td><td>307</td>'
        rows.append(f'<tr><td></td><td>{index}</td><td><a href="https://store.steampowered.com/app/{index}/Game/?snr=abc"><img src="x">Game {index}</a></td><td>HK$ 24.90</td>{last}</tr>')
    return ('<html><body><h1>' + heading + '</h1><table>' + ''.join(rows) + '</table></body></html>').encode()


def reviews(total=100, samples=None):
    return json.dumps({'success': 1, 'query_summary': {'total_positive': total - 10, 'total_negative': 10, 'total_reviews': total}, 'reviews': samples or []}).encode()


class FeedTests(unittest.TestCase):
    def test_valid_rss_with_date(self):
        row = parse_feed(feed(), SOURCE)[0]
        self.assertEqual(row['publishedAt'], '2026-09-23T07:00:00Z')
        self.assertIsNone(row['summary'])
        self.assertEqual(row['_evidence'], 'A game update announcement')

    def test_valid_atom_prefers_published_not_updated(self):
        atom = b'<feed xmlns="http://www.w3.org/2005/Atom"><entry><title>A Steam game</title><link rel="alternate" href="https://example.com/a"/><published>2026-09-23T07:00:00Z</published><updated>2026-09-23T08:00:00Z</updated></entry></feed>'
        self.assertEqual(parse_feed(atom, SOURCE)[0]['publishedAt'], '2026-09-23T07:00:00Z')
        with self.assertRaises(CollectionError):
            parse_feed(atom.replace(b'<published>2026-09-23T07:00:00Z</published>', b''), SOURCE)

    def test_bad_xml_and_non_xml(self):
        for body in (b'<rss><unclosed>', b'<html>Welcome</html>', b'{}'):
            with self.subTest(body=body), self.assertRaises(CollectionError):
                parse_feed(body, SOURCE)

    def test_entities_utf8_and_utf16_rejected(self):
        text = '<!DOCTYPE rss [<!ENTITY x "boom">]><rss><channel/></rss>'
        for body in (text.encode(), text.encode('utf-16')):
            with self.subTest(body=body), self.assertRaises(CollectionError):
                parse_feed(body, SOURCE)

    def test_protection_not_success(self):
        with self.assertRaisesRegex(CollectionError, '防护'):
            parse_feed(b'<html><title>Just a moment...</title></html>', SOURCE)

    def test_missing_and_naive_dates_rejected(self):
        for date in ('yesterday', '2026-09-23', '2026-09-23T07:00:00', 'Wed, 23 Sep 2026 07:00:00'):
            with self.subTest(date=date), self.assertRaises(CollectionError):
                parse_feed(feed(date=date), SOURCE)

    def test_bad_url_rejected(self):
        for url in ('javascript:alert(1)', 'http://example.com/a', 'https://u:p@example.com/a', 'https://127.0.0.1/a'):
            with self.subTest(url=url), self.assertRaises(CollectionError):
                parse_feed(feed(url=url), SOURCE)

    def test_explicit_verified_https_upgrade_only(self):
        source = dict(SOURCE, httpsUpgradeHosts=['www.chuapp.com'])
        row = parse_feed(feed(url='http://www.chuapp.com/article/1'), source)[0]
        self.assertEqual(row['sources'][0]['url'], 'https://www.chuapp.com/article/1')

    def test_size_limit(self):
        with self.assertRaises(CollectionError):
            parse_feed(b' ' * 2000001, SOURCE)

    def test_dates_rfc_timezone(self):
        self.assertEqual(feed_date('Wed, 23 Sep 2026 15:00:00 +0800').hour, 7)
        self.assertIsNone(feed_date('not a date'))

    def test_24h_window_excludes_future_and_old(self):
        items = []
        for hours in (1, 24, 25, -1):
            items += parse_feed(feed(title=f'Steam game update event {hours}', url=f'https://example.com/{hours}', date=stamp(NOW-timedelta(hours=hours))), SOURCE)
        self.assertEqual(len(dedupe_news(items, NOW)), 2)

    def test_rules_merge_url_and_exact_event_multi_source(self):
        a = parse_feed(feed(url='https://example.com/a?utm_source=one'), SOURCE)[0]
        b = parse_feed(feed(url='https://example.com/a?utm_source=two'), dict(SOURCE, id='b'))[0]
        c = parse_feed(feed(url='https://other.example/a'), dict(SOURCE, id='c'))[0]
        result = dedupe_news([a, b, c], NOW)
        self.assertEqual(len(result), 1)
        self.assertEqual({s['id'] for s in result[0]['sources']}, {'test', 'b', 'c'})

    def test_similar_titles_not_fuzzy_merged(self):
        rows = []
        for version in ('1.2', '1.3'):
            rows += parse_feed(feed(title='Steam game patch version ' + version, url='https://example.com/' + version), SOURCE)
        self.assertEqual(len(dedupe_news(rows, NOW)), 2)

    def test_news_limit_and_obvious_non_game(self):
        items = []
        for n in range(35):
            items += parse_feed(feed(title=f'Steam game {n} released today', url=f'https://example.com/{n}'), SOURCE)
        items += parse_feed(feed(title='New Disney TV movie trailer released', url='https://example.com/movie', excerpt='Disney streaming actor news'), SOURCE)
        result = dedupe_news(items, NOW)
        self.assertEqual(len(result), 30)
        self.assertFalse(any('Disney' in row['title'] for row in result))

    def test_hardware_offers_do_not_become_game_news(self):
        titles = [
            "Save $1,050 Off the Alienware 16X Aurora RTX 5060 Gaming Laptop During Walmart's GeForce Week Sale",
            'Get a Lenovo Legion Go S Ryzen Z2 Go Handheld Gaming PC in Excellent Condition for Under $500',
            'Save 30% on Gaming Monitors This Week',
            '游戏本限时优惠，到手价￥4999元',
        ]
        for title in titles:
            with self.subTest(title=title):
                rows = parse_feed(feed(title=title), SOURCE)
                self.assertEqual(dedupe_news(rows, NOW), [])

    def test_game_offers_and_hardware_industry_news_remain(self):
        titles = [
            'Save 27% Off Kirby Air Riders for the Nintendo Switch 2',
            'Steam game price drops to $20 during its anniversary event',
            'Gaming laptop maker announces layoffs after sales decline',
            'New gaming laptop announced with game developer partnership',
            '游戏发行商宣布限时折扣，直降20元',
            '电竞显卡厂商公布季度财报',
        ]
        for title in titles:
            with self.subTest(title=title):
                rows = parse_feed(feed(title=title), SOURCE)
                self.assertEqual(len(dedupe_news(rows, NOW)), 1)

    def test_hardware_offer_in_excerpt_does_not_hide_game_article(self):
        rows = parse_feed(feed(title='Steam game update announced today',
                               excerpt='Save $300 Off a Gaming Laptop. The game adds a new map.'), SOURCE)
        self.assertEqual(len(dedupe_news(rows, NOW)), 1)


class SteamTests(unittest.TestCase):
    def test_actual_app_table_cells_and_cap(self):
        rows = parse_chart(chart(count=25), 'popularity')
        self.assertEqual(len(rows), 20)
        self.assertEqual(rows[0]['value'], 9999)
        self.assertEqual(rows[0]['name'], 'Game 1')
        self.assertIsNone(rows[0]['rankChange'])

    def test_commercial_no_price_as_revenue_or_native_change(self):
        row = parse_chart(chart('commercial'), 'commercial')[0]
        self.assertIsNone(row['value'])
        self.assertIsNone(row['rankChange'])
        self.assertIsNone(row['reviewCount'])

    def test_chart_shell_and_wrong_definition_rejected(self):
        for body in (b'<html>Steam Global Top Sellers by revenue</html>', chart('popularity')):
            with self.assertRaises(CollectionError):
                parse_chart(body, 'commercial')

    def test_not_bundle_or_unrelated_link(self):
        body = chart().replace(b'/app/', b'/sub/')
        with self.assertRaises(CollectionError):
            parse_chart(body, 'popularity')

    def test_explicit_review_query_not_30_days(self):
        url = review_url(570)
        for text in ('language=all', 'purchase_type=all', 'review_type=all', 'filter=all', 'filter_offtopic_activity=1', 'filter_offensive=1', 'filter_review_below_threshold=1', 'day_range=365'):
            self.assertIn(text, url)
        self.assertIn('filter=recent', review_url(570, recent=True))
        self.assertNotIn('day_range=30', url)

    def test_reviews_validate_summary(self):
        self.assertEqual(parse_reviews(reviews(), NOW)['total'], 100)
        for value in (b'{}', b'<html>blocked</html>', reviews().replace(b'"total_reviews": 100', b'"total_reviews": 99')):
            with self.assertRaises(CollectionError):
                parse_reviews(value, NOW)

    def test_anonymous_7d_sample_no_player_profiles(self):
        sample = {'timestamp_created': int((NOW-timedelta(days=1)).timestamp()), 'voted_up': True, 'review': 'The combat game update feels good',
                  'author': {'steamid': '76561198012345678', 'personaname': 'Player'}, 'recommendationid': '12345'}
        old = dict(sample, timestamp_created=int((NOW-timedelta(days=8)).timestamp()))
        future = dict(sample, timestamp_created=int((NOW+timedelta(minutes=1)).timestamp()))
        result = parse_reviews(reviews(samples=[sample, sample, old, future]), NOW, recent=True)
        self.assertEqual(len(result['samples']), 1)
        self.assertNotIn('author', json.dumps(result))
        self.assertNotIn('7656119', json.dumps(result))

    def test_personal_info_in_review_is_omitted(self):
        sample = {'timestamp_created': int(NOW.timestamp()), 'voted_up': False, 'review': 'Contact me user@example.com'}
        self.assertEqual(parse_reviews(reviews(samples=[sample]), NOW, recent=True)['samples'], [])

    def test_official_announcements_not_external_media(self):
        row = {'appid': 570, 'feedname': 'steam_community_announcements', 'is_external_url': False,
               'url': 'https://store.steampowered.com/news/app/570/view/1', 'date': int((NOW-timedelta(days=1)).timestamp()), 'title': 'Game patch released'}
        rows = [row, dict(row, feedname='pcgamer'), dict(row, is_external_url=True, url='https://news.example.com/story'), dict(row, appid=730), dict(row, date=int((NOW-timedelta(days=8)).timestamp())),
                dict(row, is_external_url=True, url='https://store.steampowered.com/news/externalpost/steam_community_announcements/123')]
        body = json.dumps({'appnews': {'appid': 570, 'newsitems': rows}}).encode()
        self.assertEqual(len(parse_announcements(body, 570, NOW)), 2)


class TransportFallbackTests(unittest.TestCase):
    def test_redirect_allowed_exact_host(self):
        http = PublicHTTP()
        with patch.object(http, '_request', side_effect=[(302, {'location': 'https://www.example.com/feed'}, b''), (200, {}, b'feed')]) as call:
            self.assertEqual(http.get('https://example.com/feed', ['www.example.com']).url, 'https://www.example.com/feed')
            self.assertEqual(call.call_count, 2)

    def test_redirect_blocks_private_unregistered_and_downgrade(self):
        for target in ('https://127.0.0.1/', 'https://attacker.example/feed', 'http://example.com/feed', 'https://u:p@example.com/'):
            http = PublicHTTP()
            with self.subTest(target=target), patch.object(http, '_request', return_value=(302, {'location': target}, b'')) as call:
                with self.assertRaises(CollectionError):
                    http.get('https://example.com/feed')
                self.assertEqual(call.call_count, 1)

    def test_dns_private_address_blocked_before_connection(self):
        http = PublicHTTP()
        with patch('collectors.socket.getaddrinfo', return_value=[(2, 1, 6, '', ('127.0.0.1', 443))]), patch('collectors.socket.create_connection') as connect:
            with self.assertRaises(CollectionError):
                http.get('https://example.com/')
            connect.assert_not_called()

    def test_request_budget(self):
        with self.assertRaisesRegex(CollectionError, '时限'):
            PublicHTTP(max_requests=0).get('https://example.com/')

    def test_http_size_status_and_compression_limits(self):
        for status, headers, chunks in ((403, [], []), (200, [('Content-Length', '2000001')], []),
                                         (200, [('Content-Encoding', 'gzip')], []), (200, [], [b'x' * 2000001])):
            with self.subTest(status=status, headers=headers):
                http = PublicHTTP()
                response = MagicMock(status=status)
                response.getheaders.return_value = headers
                response.read1.side_effect = chunks
                connection = MagicMock()
                connection.getresponse.return_value = response
                with patch('collectors.socket.getaddrinfo', return_value=[(2, 1, 6, '', ('8.8.8.8', 443))]), patch('collectors.socket.create_connection'), patch.object(http, 'context', MagicMock()), patch('collectors.http.client.HTTPSConnection', return_value=connection):
                    with self.assertRaises(CollectionError):
                        http.get('https://example.com/feed')
                connection.close.assert_called_once()

    def test_redirect_limit_and_body_challenge(self):
        http = PublicHTTP()
        redirects = [(302, {'location': f'https://example.com/{i}'}, b'') for i in range(4)]
        with patch.object(http, '_request', side_effect=redirects) as request:
            with self.assertRaisesRegex(CollectionError, '三次'):
                http.get('https://example.com/start')
            self.assertEqual(request.call_count, 4)
        with patch.object(http, '_request', return_value=(200, {}, b'<title>Access Denied</title>')):
            with self.assertRaisesRegex(CollectionError, '防护页'):
                http.get('https://example.com/challenge')

    def fallback_sources(self):
        primary = {'id': 'p', 'enabled': True, 'seriesId': 'same', 'purpose': 'ranking', 'metric': 'popularity', 'methodologyVersion': 'v1', 'scope': 'global', 'fallbacks': ['a', 'b', 'c']}
        return primary, {k: dict(primary, id=k, fallbackVerified=True) for k in ('a', 'b', 'c')}

    def test_real_fallback_invokes_collector_and_succeeds(self):
        primary, registry = self.fallback_sources()
        invoked = []
        def collect(source):
            invoked.append(source['id'])
            if source['id'] == 'p':
                raise CollectionError('network', 'test transport failed')
            return parse_chart(chart(), 'popularity')
        data, used, attempts, error = collect_with_fallback(primary, registry, collect, NOW)
        self.assertEqual(invoked, ['p', 'a'])
        self.assertEqual(used['id'], 'a')
        self.assertEqual(len(data), 2)
        self.assertFalse(attempts[0]['ok'])
        self.assertTrue(attempts[1]['ok'])
        self.assertEqual(error, '')

    def test_only_two_qualified_fallbacks(self):
        primary, registry = self.fallback_sources()
        invoked = []
        def collect(source):
            invoked.append(source['id'])
            raise CollectionError('network', 'failed')
        _, _, attempts, error = collect_with_fallback(primary, registry, collect, NOW)
        self.assertEqual(invoked, ['p', 'a', 'b'])
        self.assertIn('最多2次', error)
        registry['a']['methodologyVersion'] = 'v2'
        registry['b']['enabled'] = False
        registry['c']['fallbackVerified'] = False
        _, _, attempts, error = collect_with_fallback(primary, registry, collect, NOW)
        self.assertEqual(len(attempts), 1)
        self.assertIn('无已验证', error)

    def test_no_fallback_to_bypass_protection(self):
        primary, registry = self.fallback_sources()
        def collect(source):
            raise CollectionError('blocked', '403')
        _, _, attempts, reason = collect_with_fallback(primary, registry, collect, NOW)
        self.assertEqual(len(attempts), 1)
        self.assertIn('未为规避限制', reason)


if __name__ == '__main__':
    unittest.main()
