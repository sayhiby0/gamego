import { CATEGORIES, SKILL_CATEGORIES, LIMITS, record, text, safeURL, apiBase, formatTime, todayInBeijing, normalizeManifest, normalizeDashboard, archivePath, sanitizeSources, filterNews, dataState, rankTrend, parseGames, boundedHistory, agentRequest, BYOK_STORAGE_KEY, keyProblem, normalizeModels, storedConfig, containsSecret, secretFilter, apiErrorMessage, normalizeUsage, usageText, readSSE, exportMarkdown } from './core.mjs';

const $ = (id) => document.getElementById(id);
const el = (tag, content, className) => {
  const node = document.createElement(tag);
  if (content !== undefined) node.textContent = String(content);
  if (className) node.className = className;
  return node;
};
const append = (parent, ...children) => { children.filter(Boolean).forEach((child) => parent.append(child)); return parent; };
const clear = (node) => node.replaceChildren();
const labels = { pc: 'PC / Steam', mobile: '中国手游', console: '主机', global: '全球', cn: '中国', china: '中国', CN: '中国', popularity: '人气趋势', reputation: '口碑表现', commercial: '营收 / 销量' };
const displayLabel = (value) => Object.hasOwn(labels, value) ? labels[value] : value;
const statusLabels = { ok: '有效', success: '成功', available: '有效', healthy: '有效', fresh: '已更新', complete: '完整', partial: '部分可用', stale: '旧快照', empty: '无新内容', unavailable: '不可用', failed: '失败', error: '失败', blocked: '访问受阻', not_configured: '未配置', disabled: '未启用', unchecked: '未检查', not_attempted: '未尝试', processed: '已加工', verified: '已核验原文', insufficient: '样本不足', not_integrated: '未接入', skipped: '已跳过', degraded: '降级', raw: '未完成 AI 加工' };
const methods = { rss: '原生 RSS', rsshub: 'RSSHub', webpage: '公开网页', search: '受控搜索' };
const methodKey = (key) => ['web', 'html', 'page'].includes(key) ? 'webpage' : key === 'controlled_search' ? 'search' : key;
function badge(status, label) {
  const tone = ['ok', 'success', 'available', 'complete', 'verified', 'fresh', 'healthy'].includes(status) ? 'good' : ['partial', 'stale', 'failed', 'error', 'blocked', 'degraded'].includes(status) ? 'warning' : 'muted';
  return el('span', label || (Object.hasOwn(statusLabels, status) ? statusLabels[status] : status) || '未提供状态', `badge ${tone}`);
}
function link(name, url, className) {
  const valid = safeURL(url);
  if (!valid) return el('span', `${name}（链接不可用）`, 'muted-copy');
  const node = el('a', name, className);
  node.href = valid; node.target = '_blank'; node.rel = 'noopener noreferrer'; node.referrerPolicy = 'no-referrer';
  return node;
}
function sourcesNode(sources) {
  const row = el('div', undefined, 'source-links');
  const checked = sanitizeSources(sources);
  append(row, el('span', checked.length ? '依据来源' : '暂无可核验来源'));
  checked.forEach((source) => row.append(link(`${source.name} ↗`, source.url)));
  return row;
}
function empty(title, detail) {
  return append(el('div', undefined, 'empty-state'), el('span', '◇', 'empty-icon'), el('h3', title), el('p', detail));
}
function metadata(entries, className = 'ranking-metadata') {
  const dl = el('dl', undefined, className);
  entries.forEach(([key, value]) => {
    if (className === 'skill-details') append(dl, el('dt', key), el('dd', value || '暂未提供'));
    else append(dl, append(el('div'), el('dt', key), el('dd', value || '暂未提供')));
  });
  return dl;
}
const state = { data: null, latest: null, manifest: null, view: 'news', date: 'latest', platform: 'pc', metric: 'popularity', loading: false, archiveSequence: 0, base: '', models: [], config: null, configEpoch: 0, active: null, messages: [], lastRequest: null };
const views = {
  news: ['DAILY BRIEFING', '今日情报', '从变化中发现机会，让每一个判断都有依据。'],
  rankings: ['MARKET SIGNALS', '游戏榜单', '分开看人气、口碑与商业表现，不制造综合热度。'],
  movements: ['PLAYER PERSPECTIVES', '玩家动向', '循着真实证据，理解反馈背后的运营问题。'],
  skills: ['CURATED SKILLS', 'Skills 精选', '精选研究与营销方法，为你的工作流增加一份助力。'],
  assistant: ['GAMEGO ASSISTANT', 'AI 助手', '自带百炼 API 的游戏研究助手，回答有来源，缺失有说明。'],
};
function navigate() {
  const name = location.hash.slice(1);
  state.view = Object.hasOwn(views, name) ? name : 'news';
  document.querySelectorAll('[data-view]').forEach((anchor) => {
    if (anchor.dataset.view === state.view) anchor.setAttribute('aria-current', 'page');
    else anchor.removeAttribute('aria-current');
  });
  for (const key of Object.keys(views)) $(`view-${key}`).hidden = key !== state.view;
  const [eyebrow, title, description] = views[state.view];
  $('page-eyebrow').textContent = eyebrow;
  $('page-title').replaceChildren(document.createTextNode(title), el('span', '.', 'heading-dot'));
  $('page-description').textContent = description;
  document.title = `${title} · GameGo`;
  $('overview').hidden = ['skills', 'assistant'].includes(state.view);
  $('archive-control').hidden = ['skills', 'assistant'].includes(state.view);
  $('load-notice').hidden = state.view === 'assistant' || (state.view === 'skills' && Boolean(state.latest));
}
async function fetchJSON(path, { signal } = {}) {
  const timeout = AbortSignal.timeout(15000);
  const response = await fetch(path, { cache: 'no-store', credentials: 'omit', redirect: 'error', signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
  if (!response.ok) throw new Error(`读取失败（HTTP ${response.status}）`);
  const body = await response.text();
  if (body.length > 4000000) throw new Error('公开数据超过读取上限');
  try { return JSON.parse(body); } catch { throw new Error('文件不是有效 JSON'); }
}
function populateFilters() {
  const news = state.data?.news || [];
  for (const [id, field, title] of [['market-filter', 'markets', '全部市场'], ['platform-filter', 'platforms', '全部平台'], ['game-filter', 'games', '全部游戏']]) {
    const select = $(id), current = select.value;
    clear(select); select.append(new Option(title, ''));
    const values = [...new Set(news.flatMap((item) => item[field]))].sort((a, b) => a.localeCompare(b, 'zh-CN'));
    values.forEach((value) => select.append(new Option(displayLabel(value), value)));
    if (values.includes(current)) select.value = current;
  }
  const selected = [...document.querySelectorAll('#category-filters input:checked')].map((input) => input.value);
  const categories = [...new Set([...CATEGORIES, ...news.flatMap((item) => item.categories)])];
  clear($('category-filters'));
  categories.forEach((category) => {
    const input = document.createElement('input'); input.type = 'checkbox'; input.value = category; input.checked = selected.includes(category);
    $('category-filters').append(append(el('label', undefined, 'filter-chip'), input, el('span', category)));
  });
}
function renderOverview() {
  const data = state.data, archive = state.date !== 'latest';
  const info = dataState(data, state.manifest, todayInBeijing(), archive);
  $('data-date').textContent = data?.dataDate || '暂无数据日期';
  $('data-state').textContent = info.label;
  $('data-state').className = `badge ${info.tone}`;
  $('data-detail').textContent = info.detail;
  $('news-count').textContent = data ? String(data.news.length) : '—';
  $('movement-count').textContent = data ? String(data.movements.length) : '—';
  const latestAttempt = !archive && state.manifest?.attemptedAt && (!data?.attemptedAt || Date.parse(state.manifest.attemptedAt) > Date.parse(data.attemptedAt));
  $('last-attempt').textContent = `本次尝试：${formatTime(latestAttempt ? state.manifest.attemptedAt : data?.attemptedAt)}`;
  $('last-success').textContent = formatTime(data?.lastSuccessAt || (!archive && state.manifest?.lastSuccessAt));
}
function renderNews() {
  const data = state.data;
  const filtered = filterNews(data?.news || [], { query: $('query').value, market: $('market-filter').value, platform: $('platform-filter').value, game: $('game-filter').value, categories: [...document.querySelectorAll('#category-filters input:checked')].map((input) => input.value) });
  $('filtered-count').textContent = `${filtered.length} / ${data?.news.length || 0} 条`;
  clear($('news-list'));
  if (!filtered.length) {
    $('news-list').append(empty(data?.news.length ? '没有符合筛选的资讯' : '本次暂无可展示的新资讯', data?.news.length ? '换一个关键词，或重置筛选再试。分类之间为“或”，不同筛选条件之间为“且”。' : '尚未取得有效来源，或本次没有新报道。不会将旧文章重标为今日新闻，请查看数据日期与覆盖明细。'));
    return;
  }
  for (const item of filtered) {
    const card = el('article', undefined, 'news-card');
    const tags = el('div', undefined, 'tags');
    [...item.platforms.map(displayLabel), ...item.markets.map(displayLabel), ...item.categories, ...item.games].slice(0, 12).forEach((tag) => tags.append(el('span', tag, 'tag')));
    if (!item.categories.length) tags.append(el('span', '类别未确定', 'tag'));
    append(card, append(el('div', undefined, 'card-topline'), tags, el('time', formatTime(item.publishedAt))), el('h3', item.title));
    if (item.originalTitle && item.originalTitle !== item.title) card.append(el('p', item.originalTitle, 'original-title'));
    append(card, el('div', '事实摘要', 'fact-label'), el('p', item.summary || `摘要暂不可用：${item.processing.reason || '未取得可验证的中文摘要'}`, 'summary'));
    const insight = append(el('div', undefined, 'insight'), el('strong', 'AI 行业启发 · 推论，非已证实效果'), el('p', item.insight || `本次未生成行业启发：${item.processing.reason || '证据或加工状态不足，暂不作推论'}`));
    append(card, insight);
    if (!['ok', 'success', 'complete'].includes(item.processing.status) && item.processing.reason) card.append(el('p', `加工说明：${item.processing.reason}`, 'muted-copy'));
    append(card, sourcesNode(item.sources));
    $('news-list').append(card);
  }
}
function renderRankings() {
  document.querySelectorAll('[data-rank-platform]').forEach((button) => button.setAttribute('aria-pressed', String(button.dataset.rankPlatform === state.platform)));
  document.querySelectorAll('[data-rank-metric]').forEach((button) => button.setAttribute('aria-pressed', String(button.dataset.rankMetric === state.metric)));
  const descriptions = {
    popularity: '人气指标保留来源原口径。同时在线不是 DAU，下载热度不是营收。Steam 不代表整个 PC 市场，TapTap 不代表全部中国手游。',
    reputation: '已收录候选游戏口碑对比，不是平台全量最高口碑榜。规格建议排序门槛 ≥100 条有效评价；近期变化样本 <20 条不作强结论。未确认窗口的累计评分不能表述为近期情绪。',
    commercial: '平台收入排名、官方披露与第三方估算分别解读。有排名不代表披露金额或份数；应用免费榜、付费榜与下载热度均不能代替营收榜。',
  };
  $('ranking-method').textContent = descriptions[state.metric];
  clear($('ranking-list'));
  const boards = (state.data?.rankings || []).filter((board) => board.platform === state.platform && board.metric === state.metric);
  if (!boards.length) {
    $('ranking-list').append(empty(`${labels[state.platform]} · ${labels[state.metric]}暂无可核验数据`, state.platform === 'mobile' ? '尚未提供稳定、合规的该维度手游数据。保留此入口与缺失状态，不用其他指标替代。' : '尚未取得该指标有效快照。未披露的数值不推算，也不补造历史名次。'));
    return;
  }
  for (const board of boards) {
    const card = el('article', undefined, 'ranking-card');
    append(card, append(el('div', undefined, 'section-heading'), el('h2', board.title || labels[state.metric]), badge(board.status)));
    const entries = [['来源与数据平台', `${board.source.name || '来源未提供'} · ${labels[board.platform]}`], ['指标定义', board.definition || '定义未提供，不作指标推断'], ['地区 / 语言 / 候选样本', board.scope || '范围未说明，不应外推全市场'], ['统计周期', board.period || '窗口未确认'], ['单位', board.unit || '单位未披露'], ['采集时间 / 口径版本', `${formatTime(board.observedAt)} · ${board.methodologyVersion || '版本未提供'}`]];
    if (board.metric === 'reputation') entries.push(['最低样本门槛', board.minimumSample !== null ? `${board.minimumSample} 条（来源声明）` : '已验证门槛未提供；规格建议 ≥100 条，仅作不足提示，不自行重排榜单']);
    append(card, metadata(entries));
    if (board.reason) card.append(el('p', board.reason, 'method-note'));
    if (!board.items.length) card.append(empty('本榜单暂无有效条目', board.reason || '数据缺失，不填充示例游戏。历史数据积累中。'));
    else {
      const table = el('table');
      const header = el('tr');
      ['排名', '游戏', `原始指标${board.unit ? ` / ${board.unit}` : ''}`, '样本 / 历史比较'].forEach((title) => { const th = el('th', title); th.scope = 'col'; header.append(th); });
      append(table, append(el('thead'), header));
      const body = el('tbody');
      board.items.forEach((item) => {
        const tr = el('tr');
        const trend = rankTrend(item, board.observedAt);
        const value = item.value === null ? '未披露' : new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 3 }).format(item.value);
        append(tr, el('td', item.rank > 0 ? String(item.rank).padStart(2, '0') : '未提供'), append(el('td'), item.url ? link(item.name, item.url) : el('span', item.name)), el('td', value));
        const comparison = el('td');
        if (board.metric === 'reputation') comparison.append(el('p', item.reviewCount === null ? '评价样本数未提供' : `${item.reviewCount.toLocaleString('zh-CN')} 条评价${item.reviewCount < (board.minimumSample ?? 100) ? ' · 样本不足' : ''}`));
        append(comparison, el('span', trend)); tr.append(comparison); body.append(tr);
      });
      append(table, body); card.append(append(el('div', undefined, 'table-wrap'), table));
    }
    append(card, sourcesNode(board.source.url ? [board.source] : []));
    $('ranking-list').append(card);
  }
}
function evidenceSection(title, items, missing) {
  const section = append(el('section', undefined, 'evidence-section'), el('h4', title));
  if (!items.length) section.append(el('p', missing));
  else {
    const ul = el('ul');
    for (const item of items) {
      const li = el('li', item.text);
      li.append(item.sourceUrl ? link('依据 ↗', item.sourceUrl) : el('span', '（原文链接未提供，勿作为已核实证据）'));
      ul.append(li);
    }
    section.append(ul);
  }
  return section;
}
function renderMovements() {
  clear($('movement-list'));
  const items = state.data?.movements || [];
  if (!items.length) {
    $('movement-list').append(empty('尚无证据充分的玩家动向', '仅按当期榜单动态选题，不使用固定追踪名单补数。首次快照不称为“涨幅异常”，正负反馈不足时保持缺失。'));
    return;
  }
  items.forEach((item) => {
    const card = el('article', undefined, 'movement-card');
    append(card, append(el('div', undefined, 'card-topline'), el('span', `${labels[item.platform]} · ${formatTime(item.observedAt)}`), badge(item.status)), el('h3', item.name || '游戏名称未提供'), el('p', `入选依据：${item.reason || '未提供，不推测榜单变化'}`, 'selection-reason'));
    append(card, evidenceSection('玩家观点 / 主要好评点', item.positive, '本次未取得相关好评反馈，不制造正向观点。'), evidenceSection('玩家观点 / 不满与争议', item.negative, '本次未取得相关不满反馈；不代表没有争议。'), evidenceSection('事实证据 / 争议事件与运营、营销动作', item.events, '本次未取得相关事件证据。'));
    append(card, append(el('div', undefined, 'insight'), el('strong', 'AI 分析 · 非全体玩家结论'), el('p', item.insight || '本次未生成 AI 分析；请查看下方样本与加工限制。')));
    if (item.limitations.length) card.append(el('p', `样本边界：${item.limitations.join('；')}`, 'method-note'));
    append(card, sourcesNode(item.sources)); $('movement-list').append(card);
  });
}
function renderSkills() {
  clear($('skills-list'));
  if (state.view === 'skills') $('load-notice').hidden = Boolean(state.latest);
  // The pipeline publishes curated config/skills.json into the latest dashboard.
  const skills = state.latest?.skills || state.data?.skills || [];
  $('skills-list').append(el('p', `当前公开目录 ${skills.length} 项。初始目标 6–12 项，宁缺毋滥；检查仅代表原文可读，不代表已安装、已审计或获任何工具兼容保证。`, 'muted-copy'));
  for (const category of SKILL_CATEGORIES) {
    const group = append(el('section', undefined, 'skill-group'), el('h2', category));
    const grid = el('div', undefined, 'skills-grid');
    const filtered = skills.filter((skill) => skill.category === category);
    if (!filtered.length) grid.append(empty('本分类暂无已发布的精选条目', '仅收录可核验原文，不生成假链接。本地 game-daily / game-monitor 只在 AI 助手中说明，不公开本地路径。'));
    filtered.forEach((skill) => {
      const card = el('article', undefined, 'skill-card');
      append(card, append(el('div', undefined, 'card-topline'), el('span', 'CURATED / 精选'), badge(skill.status)), el('h3', skill.name), el('p', skill.description, 'skill-description'), metadata([['适用场景', skill.scenarios], ['作者 / 项目', skill.author || '作者信息暂不可用'], ['Agent / 工具', skill.tools || '兼容工具元数据暂不可用，请查阅原文'], ['使用前提', skill.prerequisites || '前提未确认，请查阅原文依赖与权限']], 'skill-details'));
      const foot = el('div', undefined, 'skill-footer');
      append(foot, link('查看 Skill 原文 ↗', skill.url), el('p', `最近检查：${formatTime(skill.checkedAt)}`));
      const heat = skill.popularity;
      if (heat) append(foot, el('p', `${heat.metric}：${heat.value} · ${heat.window} · 采集 ${formatTime(heat.collectedAt)}`), link('热度指标来源 ↗', heat.source));
      else foot.append(el('p', '热度：暂无可核验数据（指标来源 / 统计窗口 / 采集日期不完整时不展示数值）'));
      append(card, foot); grid.append(card);
    });
    append(group, grid); $('skills-list').append(group);
  }
}
function renderCoverage() {
  const coverage = state.data?.coverage || [];
  clear($('coverage-list')); clear($('coverage-summary'));
  const keys = [...new Set([...Object.keys(methods), ...coverage.map((item) => methodKey(item.method) || 'unknown')])];
  keys.forEach((key) => {
    const rows = coverage.filter((item) => (methodKey(item.method) || 'unknown') === key);
    const group = append(el('section', undefined, 'coverage-method'), el('h3', `${methods[key] || key} · ${rows.length} 项登记`));
    const successes = rows.filter((row) => ['ok', 'success', 'available', 'healthy'].includes(row.status) && row.lastSuccessAt && row.count > 0).length;
    if (Object.hasOwn(methods, key)) $('coverage-summary').append(append(el('div', undefined, 'coverage-summary-row'), el('span', methods[key]), badge(rows.length ? (successes ? 'partial' : 'unavailable') : 'not_configured', rows.length ? `${successes} / ${rows.length} 本次有效` : '未提供记录')));
    if (!rows.length) group.append(el('p', '本次公开数据未提供此方法的登记或尝试记录，不能视为已接入或已尝试。', 'method-note'));
    rows.forEach((item) => {
      const card = el('article', undefined, 'coverage-item');
      append(card, append(el('div', undefined, 'card-topline'), el('strong', item.name || item.id || '未命名来源'), badge(item.status)), el('p', item.reason || '未提供方法结果的具体说明，不推定有效覆盖。'), el('small', `本次尝试：${formatTime(item.attemptedAt)}`), el('small', `最近成功：${formatTime(item.lastSuccessAt)} · 有效条目：${item.count ?? '未提供'}`));
      if (item.url) card.append(link('来源入口 ↗', item.url));
      group.append(card);
    });
    $('coverage-list').append(group);
  });
}
function renderPublic() { renderOverview(); populateFilters(); renderNews(); renderRankings(); renderMovements(); renderSkills(); renderCoverage(); }
async function loadArchive() {
  const sequence = ++state.archiveSequence;
  const date = $('archive-date').value;
  state.date = date;
  if (date === 'latest') { state.data = state.latest; renderPublic(); $('load-notice').textContent = [state.latest?.notice, dataState(state.latest, state.manifest).detail].filter(Boolean).join(' · '); return; }
  state.data = null; renderPublic(); $('load-notice').textContent = `正在读取 ${date} 归档…`;
  try {
    const data = normalizeDashboard(await fetchJSON(archivePath(date, state.manifest?.dates)));
    if (data.dataDate !== date) throw new Error('归档内容日期与请求不符');
    if (sequence !== state.archiveSequence) return;
    state.data = data; $('load-notice').textContent = `正在查看 ${date} 历史快照，以下记录仅代表该日采集结果。${data.notice ? ` ${data.notice}` : ''}`;
  } catch (error) {
    if (sequence !== state.archiveSequence) return;
    $('load-notice').textContent = `归档不可用：${error.message}。不会用最新数据冒充所选日期。`;
  }
  renderPublic();
}
async function loadPublic() {
  const results = await Promise.allSettled([fetchJSON('./data/latest.json'), fetchJSON('./data/manifest.json')]);
  const errors = [];
  try { if (results[1].status === 'fulfilled') state.manifest = normalizeManifest(results[1].value); else throw results[1].reason; } catch (error) { errors.push(`归档清单不可用：${error.message}`); }
  try { if (results[0].status === 'fulfilled') state.latest = normalizeDashboard(results[0].value); else throw results[0].reason; } catch (error) { errors.push(`公开数据不可用：${error.message}`); }
  state.data = state.latest;
  const select = $('archive-date'); clear(select);
  select.append(new Option(state.latest ? `最新 · ${state.latest.dataDate}` : '最新可用数据', 'latest'));
  state.manifest?.dates.forEach((date) => select.append(new Option(date, date)));
  select.disabled = !state.manifest?.dates.length;
  $('load-notice').textContent = [...errors, state.data?.notice, dataState(state.data, state.manifest).detail].filter(Boolean).join(' · ');
  renderPublic();
}

// A saved configuration authorizes only explicit test/submit actions. Draft
// changes revoke it immediately; request snapshots never share this object.
function selectedModel() {
  return state.models.find((item) => item.region === $('api-region').value && item.model === $('api-model').value);
}
function ready() {
  const config = state.config;
  return Boolean(state.base && config && selectedModel() && !keyProblem(config.key) && config.key === $('api-key').value && config.region === $('api-region').value && config.model === $('api-model').value);
}
function apiUI(message) {
  const configured = ready(), busy = Boolean(state.active);
  $('api-state').textContent = configured ? '已保存 · 自付费用' : '未配置 / 待保存';
  $('api-state').className = `badge ${configured ? 'good' : 'muted'}`;
  $('agent-fields').disabled = busy;
  $('send').disabled = !configured || busy;
  $('test-api').disabled = !configured || busy;
  $('stop').disabled = !busy;
  $('retry').disabled = !configured || busy || !state.lastRequest;
  $('download').disabled = !state.messages.some((item) => item.role === 'assistant' && item.content);
  if (message !== undefined) $('api-status').textContent = message;
}
function stopTask() {
  const task = state.active;
  state.active = null;
  if (task) { task.controller.abort(); task.credentials.key = ''; task.filter?.clear(); }
}
function invalidateConfig(message, clearInputs = false) {
  state.configEpoch++;
  state.config = null;
  stopTask();
  state.messages = []; state.lastRequest = null;
  $('test-usage').textContent = '连接测试用量与费用：未知（尚未测试当前配置）';
  if (clearInputs) {
    $('api-key').value = ''; $('api-region').value = ''; renderModelOptions();
    $('remember-key').checked = false;
    $('agent-message').value = ''; $('agent-games').value = '';
  }
  $('stream-status').textContent = '旧任务已停止，对话已清空；已受理的调用仍可能计费。';
  renderChat(); apiUI(message);
}
function renderModelOptions() {
  const select = $('api-model'); clear(select);
  select.append(new Option('请选择已验收模型', ''));
  state.models.filter((item) => item.region === $('api-region').value).forEach((item) => select.append(new Option(item.label, item.model)));
  select.disabled = select.children.length <= 1;
  renderModelDetail();
}
function renderModelDetail() {
  const item = selectedModel();
  $('model-detail').textContent = item ? `${item.model} · ${item.region} · 站主声明验收时间：${formatTime(item.verifiedAt)}。每百万 Token 输入 ¥${item.inputPrice ?? '未知'} / 输出 ¥${item.outputPrice ?? '未知'}；最终以百炼计费为准。本地代码不代表真实联调完成。` : '仅可选站主声明且验证元数据完整的模型／地域；没有可用组合时付费功能关闭。';
}
function removeSavedConfig() {
  try {
    window.localStorage.removeItem(BYOK_STORAGE_KEY);
    $('storage-status').textContent = '本地保存项已清除；清除本机不会撤销百炼 Key。';
    return true;
  } catch {
    $('storage-status').textContent = '删除本地保存项失败；旧 Key 可能仍在浏览器中，请在浏览器站点数据设置清除，泄露时去百炼撤销。';
    return false;
  }
}
function saveConfig(event) {
  event?.preventDefault();
  // A persistence-only change must not destroy the current conversation.
  if (!ready()) invalidateConfig('配置待检查；保存不会调用模型。');
  if (!$('remember-key').checked) removeSavedConfig();
  const problem = keyProblem($('api-key').value), model = selectedModel();
  if (problem || !state.base || !model) {
    apiUI(problem || (!state.base ? '固定后端不可用，付费功能已禁用。' : '请选择站主验收列表中的模型和地域；暂无可用模型时不能发送。'));
    return;
  }
  state.config = { version: 1, key: $('api-key').value, model: model.model, region: model.region };
  if ($('remember-key').checked) {
    try {
      window.localStorage.setItem(BYOK_STORAGE_KEY, JSON.stringify(storedConfig(state.config)));
      $('storage-status').textContent = '已按你的选择记住配置；不保存聊天。同源项目可读，共享设备不推荐。';
    } catch {
      $('storage-status').textContent = '写入本地存储失败，当前配置仅本页内存可用；旧保存项可能仍存在。未自动重试或另行保存。';
    }
  }
  apiUI('已保存配置，仅通过基本格式检查，尚不能证明 Key 有效。可主动测试或提交问题；均可能计费。');
}
function restoreConfig() {
  let saved;
  try {
    const raw = window.localStorage.getItem(BYOK_STORAGE_KEY);
    if (raw === null) return;
    saved = storedConfig(JSON.parse(raw));
  } catch {
    $('storage-status').textContent = '无法读取本地配置（存储受限或内容损坏），未恢复、未自动改写。可仅在本页重新配置。';
    return;
  }
  if (!saved || !state.models.some((item) => item.model === saved.model && item.region === saved.region)) {
    $('storage-status').textContent = '保存项格式不正确或模型／地域未通过当前列表核验，未恢复 Key；可清除或重新配置。';
    return;
  }
  state.config = { ...saved };
  $('api-key').value = saved.key; $('api-region').value = saved.region;
  renderModelOptions(); $('api-model').value = saved.model; renderModelDetail();
  $('remember-key').checked = true;
  $('storage-status').textContent = '已恢复你之前选择记住的配置，没有恢复聊天；未发送 Key，未调用模型。';
  apiUI('配置已恢复，未测试当前有效性。只有主动测试或提交才会使用 Key 并可能计费。');
}
function clearAPI() {
  invalidateConfig('已清空本页 API 配置与对话。清除本机不等于撤销百炼 Key。', true);
  removeSavedConfig();
}
function safeFailure(message) { const error = new Error(message); error.safe = true; return error; }
function requestError(error) {
  if (error.safe === true) return error.message;
  if (error.name === 'TimeoutError') return '请求超时，已受理的调用仍可能计费';
  if (error.message === '连接提前结束，报告可能不完整；可重试') return '连接提前结束，报告可能不完整；可重试';
  return '请求或数据流异常，无法确认具体原因；请检查网络与配置后手动重试';
}
function newTask(kind) {
  // This is a new per-request copy, never a reference to state.config.
  const credentials = { key: state.config.key, model: state.config.model, region: state.config.region };
  const task = { kind, credentials, epoch: state.configEpoch, controller: new AbortController(), stopped: false };
  state.active = task;
  return task;
}
function currentTask(task) { return state.active === task && state.configEpoch === task.epoch && !task.controller.signal.aborted; }
async function apiRequest(path, task, body) {
  if (!currentTask(task) || !['/api/test', '/api/agent'].includes(path)) throw safeFailure('配置已改变，请重新保存后提交。');
  if (containsSecret(body, task.credentials.key)) throw safeFailure('问题、游戏名或上下文中包含疑似 API Key，已阻止发送；请删除秘密，仅在专用配置框填写。');
  const headers = { Accept: path === '/api/agent' ? 'text/event-stream' : 'application/json', 'Content-Type': 'application/json', Authorization: `Bearer ${task.credentials.key}` };
  const response = await fetch(`${state.base}${path}`, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.any([task.controller.signal, AbortSignal.timeout(path === '/api/agent' ? 180000 : 20000)]), cache: 'no-store', credentials: 'omit', redirect: 'error' });
  if (!currentTask(task)) { await response.body?.cancel(); throw safeFailure('旧请求已停止。'); }
  if (!response.ok) {
    let code = '';
    try { code = (await response.json())?.error; } catch { /* Never reflect raw upstream text. */ }
    const message = apiErrorMessage(code, response.status);
    if (currentTask(task) && response.status === 401) {
      invalidateConfig(message, true);
      removeSavedConfig();
    }
    throw safeFailure(message);
  }
  return response;
}
async function testConnection() {
  if (!ready() || state.active) return;
  if (!window.confirm('测试连接会调用一次受限模型请求，可能产生少量费用，由你的百炼账户承担。不搜索、不生成报告。是否继续？')) return;
  if (!ready() || state.active) return;
  const task = newTask('test');
  apiUI('正在主动测试所选模型；停止只尽力取消，已受理调用仍可能计费。');
  $('test-usage').textContent = '本次连接测试用量与费用：未知（等待响应）';
  try {
    const { model, region } = task.credentials;
    const result = await (await apiRequest('/api/test', task, { region, model })).json();
    if (!currentTask(task)) return;
    if (result?.ok !== true || result.model !== model || result.region !== region || !record(result.usage)) throw safeFailure('测试响应不符合约定，不能确认连接成功；费用未知。');
    $('test-usage').textContent = `${model} · ${region} · ${usageText(result.usage)}`;
    apiUI('测试通过：仅代表此刻可调用所选模型，不证明完整取证／工具流程已通过验收。');
  } catch (error) {
    if (state.active === task) apiUI(task.stopped ? '测试已停止，费用未知；已受理调用仍可能计费。' : requestError(error));
  } finally {
    task.credentials.key = '';
    if (state.active === task) { state.active = null; apiUI(); }
  }
}
function renderChat() {
  clear($('chat-log'));
  if (!state.messages.length) $('chat-log').append(empty('从一个明确的问题开始', '可选择行业资讯，或输入一至两款游戏进行调查与对比。模型输出以纯文本呈现，不执行内容中的链接或代码。'));
  state.messages.forEach((message) => {
    const card = el('article', undefined, `chat-message ${message.role}`);
    const content = el('p', message.content);
    const status = el('span', message.state || '', 'message-state');
    const sources = sourcesNode(message.sources);
    const usage = el('p', message.role === 'assistant' ? `${message.model || ''} · ${message.region || ''} · ${usageText(message.usage)}` : '', 'usage-note');
    append(card, el('strong', message.role === 'user' ? '你 / 研究问题' : 'GameGo / 分析'), content);
    if (message.role === 'assistant') append(card, status, usage, sources);
    message.nodes = { content, status, usage, sources };
    $('chat-log').append(card);
  });
}
function updateReply(reply) {
  const log = $('chat-log');
  const pinned = log.scrollHeight - log.scrollTop - log.clientHeight < 90;
  reply.nodes.content.textContent = reply.content;
  reply.nodes.status.textContent = reply.state;
  reply.nodes.usage.textContent = `${reply.model} · ${reply.region} · ${usageText(reply.usage)}`;
  const sources = sourcesNode(reply.sources); reply.nodes.sources.replaceWith(sources); reply.nodes.sources = sources;
  if (pinned) log.scrollTop = log.scrollHeight;
}
async function sendRequest(request) {
  if (!ready() || state.active) { apiUI('请先保存有效格式的配置并选择可用模型；配置编辑后必须重新保存。'); return; }
  if (containsSecret(request, state.config.key)) {
    $('stream-status').textContent = '问题、游戏名或上下文中包含疑似 API Key，已阻止发送；请删除秘密，仅在专用配置框填写。';
    return;
  }
  // Rebuild the whitelisted request; never attach credentials to chat/history.
  const clean = agentRequest(request.skill, request.message, request.games, request.history);
  const task = newTask('agent');
  task.filter = secretFilter(task.credentials.key);
  state.lastRequest = clean;
  const { model, region } = task.credentials;
  const reply = { role: 'assistant', content: '', sources: [], state: '处理中', model, region, usage: null };
  state.messages.push({ role: 'user', content: clean.message, sources: [] }, reply);
  state.messages = state.messages.slice(-24);
  renderChat(); apiUI(); $('stream-status').textContent = '正在提交自付费用的研究任务，按可用来源取证…';
  $('chat-log').scrollTop = $('chat-log').scrollHeight;
  let idleTimer;
  const resetIdle = () => { clearTimeout(idleTimer); idleTimer = setTimeout(() => { task.timedOut = true; task.controller.abort(); }, 45000); };
  try {
    resetIdle();
    const response = await apiRequest('/api/agent', task, { ...clean, region, model });
    if (!response.headers.get('content-type')?.toLowerCase().includes('text/event-stream')) {
      await response.body?.cancel();
      throw safeFailure('服务没有返回约定的 SSE 数据流');
    }
    await readSSE(response.body, (event) => {
      if (!currentTask(task)) return;
      resetIdle();
      if (event.type === 'status') $('stream-status').textContent = containsSecret(event.message, task.credentials.key) ? '正在处理，敏感状态文字已隐藏。' : event.message;
      if (event.type === 'delta') {
        if (reply.content.length + event.text.length > LIMITS.output) { task.controller.abort(); throw safeFailure('输出超过本页安全长度限制，已停止'); }
        reply.content += task.filter.push(event.text);
      }
      if (event.type === 'sources') reply.sources = sanitizeSources([...reply.sources, ...event.sources.filter((source) => !containsSecret(source, task.credentials.key))]);
      if (event.type === 'usage' && (!event.model || event.model === model) && (!event.region || event.region === region)) reply.usage = normalizeUsage(event.usage);
      if (event.type === 'done') {
        if (event.ok === false || event.cancelled) throw safeFailure('服务未确认完成，报告可能不完整；已受理调用仍可能计费。');
        reply.content += task.filter.push('', true); reply.state = '已完成';
      }
      if (event.type === 'error') {
        const message = apiErrorMessage(event.code);
        if (['key_invalid', 'invalid_key', 'invalid_api_key'].includes(event.code.toLowerCase())) {
          invalidateConfig(message, true); removeSavedConfig();
        }
        throw safeFailure(message);
      }
      updateReply(reply);
    }, task.controller.signal);
    if (!currentTask(task)) return;
    if (!reply.content) reply.state = '已结束，服务未返回分析正文';
    $('stream-status').textContent = reply.content ? '分析已完成。请核验来源；下载仅保存当前会话到你的设备。' : '服务已结束，但未返回分析正文；不会生成替代答案。';
  } catch (error) {
    if (state.active !== task) return;
    reply.state = task.stopped ? '已停止，报告可能不完整' : task.timedOut ? '等待数据超时，报告可能不完整' : `分析未完成：${requestError(error)}`;
    $('stream-status').textContent = `${reply.state}。可重试；重试是新的服务请求，可能再次计费。`;
  } finally {
    clearTimeout(idleTimer);
    task.filter.clear(); task.credentials.key = '';
    if (state.active === task) {
      updateReply(reply); state.active = null; apiUI();
    }
  }
}
function submitQuestion(event) {
  event.preventDefault();
  try {
    const games = $('agent-skill').value === 'game-monitor' ? parseGames($('agent-games').value) : [];
    const history = boundedHistory(state.messages.filter((message) => message.role === 'user' || message.state === '已完成'));
    const request = agentRequest($('agent-skill').value, $('agent-message').value, games, history);
    void sendRequest(request);
  } catch (error) { $('stream-status').textContent = error.message; }
}
function clearChat() {
  stopTask();
  state.messages = []; state.lastRequest = null;
  $('agent-message').value = ''; $('agent-games').value = '';
  $('stream-status').textContent = '当前会话已清空，无法恢复；API 配置保留。已受理调用仍可能计费。'; renderChat(); apiUI();
}
function downloadReport() {
  if (!state.messages.some((item) => item.role === 'assistant' && item.content)) return;
  const blob = new Blob([exportMarkdown(state.messages)], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = el('a'); anchor.href = url; anchor.download = `GameGo-${todayInBeijing()}.md`;
  document.body.append(anchor); anchor.click(); anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
async function loadConfig() {
  const epoch = state.configEpoch;
  try {
    const config = await fetchJSON('./config.json');
    state.base = apiBase(config?.apiBase);
    if (!state.base) { apiUI('后端配置缺失：固定 apiBase 未设置或不安全。付费功能禁用，公开情报与草稿仍可使用。'); return; }
    // Public metadata only: no Authorization, cookies or paid model request.
    state.models = normalizeModels(await fetchJSON(`${state.base}/api/models`));
    const select = $('api-region'); clear(select); select.append(new Option('请选择已验收地域', ''));
    [...new Set(state.models.map((item) => item.region))].forEach((region) => select.append(new Option(region, region)));
    select.disabled = !state.models.length;
    renderModelOptions();
    apiUI(state.models.length ? '固定后端已配置。请保存自己的 API 配置；尚未进行实际 Key 验证。' : '没有验证元数据完整的可用模型。付费功能禁用，不默认启用任意模型；公开内容和草稿不受影响。');
    if (state.configEpoch === epoch) restoreConfig();
  } catch {
    state.models = [];
    apiUI('固定后端或模型列表无法读取。付费功能禁用；未发送 Key，也不会自动重试模型。');
  }
}

window.addEventListener('hashchange', navigate);
window.addEventListener('storage', (event) => {
  if ((event.key !== BYOK_STORAGE_KEY && event.key !== null) || (event.key !== null && event.newValue === event.oldValue)) return;
  let storage;
  try { storage = window.localStorage; }
  catch {
    invalidateConfig('存储访问受限，无法核对跨标签变更；已停止旧任务并清空内存 Key，请重新配置。', true);
    $('storage-status').textContent = '无法访问本地存储，未自动采用其他标签页配置，也未删除保存项。';
    return;
  }
  if (event.storageArea !== storage) return;
  invalidateConfig('其他标签页已清除或替换保存配置；本页旧 Key 已失效，任务已停止。不会自动采用新 Key，请重新配置。', true);
  $('storage-status').textContent = '检测到跨标签存储变更，未自动读取新 Key；已发出的调用仍可能计费。';
});
window.addEventListener('pageshow', (event) => {
  if (event.persisted) {
    invalidateConfig('页面恢复后已清空内存与对话，未调用模型。', true);
    restoreConfig();
  }
});
window.addEventListener('pagehide', () => {
  invalidateConfig('页面已离开，内存 Key 与对话已清空；选择记住的配置不会被删除。', true);
});
$('filters').addEventListener('submit', (event) => event.preventDefault());
$('filters').addEventListener('input', renderNews);
$('filters').addEventListener('change', renderNews);
$('filters').addEventListener('reset', () => setTimeout(renderNews, 0));
$('archive-date').addEventListener('change', loadArchive);
document.querySelectorAll('[data-rank-platform]').forEach((button) => button.addEventListener('click', () => { state.platform = button.dataset.rankPlatform; renderRankings(); }));
document.querySelectorAll('[data-rank-metric]').forEach((button) => button.addEventListener('click', () => { state.metric = button.dataset.rankMetric; renderRankings(); }));
const openCoverage = () => $('coverage-dialog').showModal();
$('open-coverage').addEventListener('click', openCoverage);
$('coverage-more').addEventListener('click', openCoverage);
$('close-coverage').addEventListener('click', () => $('coverage-dialog').close());
$('coverage-dialog').addEventListener('click', (event) => { if (event.target === $('coverage-dialog') && event.clientX < $('coverage-dialog').getBoundingClientRect().left) $('coverage-dialog').close(); });
$('api-form').addEventListener('submit', saveConfig);
$('clear-api').addEventListener('click', clearAPI);
$('test-api').addEventListener('click', testConnection);
$('open-guide').addEventListener('click', (event) => { event.preventDefault(); $('api-guide').open = true; $('api-guide').scrollIntoView({ block: 'start' }); });
const editedConfig = () => invalidateConfig('配置已编辑，旧配置与任务已失效；请重新保存。已受理调用仍可能计费。');
$('api-key').addEventListener('input', editedConfig);
$('api-key').addEventListener('change', editedConfig);
$('api-region').addEventListener('change', () => { editedConfig(); renderModelOptions(); });
$('api-model').addEventListener('change', () => { editedConfig(); renderModelDetail(); });
$('remember-key').addEventListener('change', () => {
  $('storage-status').textContent = $('remember-key').checked ? '尚未保存。请先阅读上方同源与中转风险；点击保存才会记住。' : '尚未保存此选择；取消勾选后点击保存，才会删除旧本地保存项并保留本页配置。';
});
const presets = {
  daily: { skill: 'game-daily', message: '整理最近一周已取得证据的游戏发行与版本动态，注明发生时间、原文来源和覆盖缺口。' },
  marketing: { skill: 'game-daily', message: '从已取得的近期资讯中整理运营活动与营销联动案例，分开描述事实、可借鉴做法和适用前提，不推测实际营销效果。' },
  compare: { skill: 'game-monitor', message: '对比填写的两款游戏近期玩家反馈、版本与运营营销动作。分别取证，注明样本时间和缺失维度。' },
};
document.querySelectorAll('[data-preset]').forEach((button) => button.addEventListener('click', () => {
  if (state.active) return;
  const preset = presets[button.dataset.preset];
  $('agent-skill').value = preset.skill;
  $('games-label').hidden = preset.skill !== 'game-monitor';
  $('agent-message').value = preset.message;
  $('stream-status').textContent = preset.skill === 'game-monitor' ? '请先填写一至两款游戏，再点击开始分析；预设问题不会自动发起请求。' : '可以继续编辑问题，再点击开始分析；预设问题不会自动发起请求。';
}));
$('agent-skill').addEventListener('change', () => { $('games-label').hidden = $('agent-skill').value !== 'game-monitor'; });
$('agent-form').addEventListener('submit', submitQuestion);
$('stop').addEventListener('click', () => { if (state.active) { state.active.stopped = true; state.active.controller.abort(); } });
$('retry').addEventListener('click', () => { if (state.lastRequest && !state.active && ready()) void sendRequest(state.lastRequest); });
$('clear-chat').addEventListener('click', clearChat);
$('download').addEventListener('click', downloadReport);
navigate(); renderPublic(); renderChat();
void loadPublic(); void loadConfig();
