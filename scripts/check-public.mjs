import { readFile, readdir } from 'node:fs/promises';
import { resolve, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeDashboard, normalizeManifest } from '../site/assets/core.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const privateKey = /^(?:api[_-]?key|.*[_-]api[_-]?key|access[_-]?token|refresh[_-]?token|token|token_hash|password|secret|client_secret|email|identity_hashes|whitelist|allowlist|messages|history|prompt|authorization|usage|owner|author_id|steamid)$/i;
const secretValue = /(?:sk-[a-zA-Z0-9._~+\/-]{16,}={0,2}|gh[pousr]_[a-zA-Z0-9]{20,}|github_pat_[a-zA-Z0-9_]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY-----)/;

export function assertPublic(value, path = '$') {
  if (typeof value === 'string') {
    if (secretValue.test(value) || /(?:[A-Za-z]:[\\/](?:Users|project)|file:\/\/)/i.test(value)) throw new Error(`${path}: 包含凭据形态或本地路径`);
    const emails = value.match(/[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g) ?? [];
    if (emails.length) throw new Error(`${path}: 包含不可公开的邮箱`);
  } else if (Array.isArray(value)) value.forEach((item, i) => assertPublic(item, `${path}[${i}]`));
  else if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      if (privateKey.test(key)) throw new Error(`${path}.${key}: 私有字段不得发布`);
      assertPublic(item, `${path}.${key}`);
    }
  }
}

export function validateSnapshot(value) {
  assertPublic(value);
  const normalized = normalizeDashboard(value);
  for (const key of ['news', 'rankings', 'movements', 'skills', 'coverage']) {
    if (normalized[key].length !== value[key].length) throw new Error(`${key}: 含无效或超出上限的数据`);
  }
  for (let i = 0; i < normalized.news.length; i++) {
    if (normalized.news[i].sources.length !== value.news[i].sources.length) throw new Error('资讯来源格式无效');
  }
  for (let i = 0; i < normalized.rankings.length; i++) {
    const board = normalized.rankings[i];
    if (board.items.length !== value.rankings[i].items.length) throw new Error('榜单条目格式或数量无效');
    if (board.items.length && (!board.observedAt || !board.source.url || !board.definition || !board.methodologyVersion)) throw new Error('榜单缺少时间、来源或口径');
    if (board.items.some((item) => !item.gameId || item.rank === null || item.rank < 1)) throw new Error('榜单游戏标识或排名无效');
  }
  return normalized;
}

export async function checkPublic(site = resolve(root, 'site')) {
  const readJSON = async (file) => JSON.parse(await readFile(resolve(site, file), 'utf8'));
  const latest = validateSnapshot(await readJSON('data/latest.json'));
  const rawManifest = await readJSON('data/manifest.json');
  assertPublic(rawManifest);
  const manifest = normalizeManifest(rawManifest);
  if (rawManifest.dates.length !== manifest.dates.length) throw new Error('归档日期重复、无效或超过30份');
  if (manifest.latestDate && manifest.latestDate !== latest.dataDate) throw new Error('最新日期与快照不一致');
  for (const date of manifest.dates) {
    if (validateSnapshot(await readJSON(`data/${date}.json`)).dataDate !== date) throw new Error('归档内容日期不一致');
  }
  const inspect = async (dir) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) throw new Error('发布目录不能包含符号链接');
      if (entry.name === '.gitkeep') continue;
      if (entry.name.startsWith('.')) throw new Error('发布目录不能包含隐藏文件');
      const path = resolve(dir, entry.name);
      if (entry.isDirectory()) await inspect(path);
      else if (['.json', '.html', '.mjs', '.js', '.css'].includes(extname(path))) {
        const content = await readFile(path, 'utf8');
        if (secretValue.test(content)) throw new Error('公开文件包含凭据形态');
        if (extname(path) === '.json') assertPublic(JSON.parse(content));
      } else if (!['.png', '.jpg', '.jpeg', '.svg', '.webp', '.ico', '.txt'].includes(extname(path))) throw new Error('发布目录包含非公开文件类型');
    }
  };
  await inspect(site);
  return { date: latest.dataDate, news: latest.news.length, rankings: latest.rankings.reduce((n, board) => n + board.items.length, 0), movements: latest.movements.length, archives: manifest.dates.length };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log('公开数据校验通过', await checkPublic()); }
  catch (error) { console.error(`公开数据校验失败：${error.message}`); process.exitCode = 1; }
}
