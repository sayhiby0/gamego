import {contentService, agentService, acquireJob, releaseJob} from './services.mjs';
import {modelConfig, listAgentModels, agentModelConfig, validateApiKey, invokeModel, ModelError} from './model.mjs';
import {cleanup} from './ledger.mjs';
import {HttpError, constantTimeEqual, requireOrigin, responseJson, errorResponse, secureResponse, rateLimit, readJson, requestFingerprint, modelHttpError} from './security.mjs';

const ROUTES = Object.freeze({
  '/health':'GET', '/api/models':'GET', '/api/test':'POST',
  '/api/agent':'POST', '/internal/content':'POST',
});

async function authorizeContent(request, env) {
  const header = request.headers.get('authorization');
  if (typeof header !== 'string' || header.length > 519 || !/^Bearer [A-Za-z0-9._~+\/-]{32,512}={0,2}$/i.test(header)) throw new HttpError(401, '服务凭据无效');
  const secret = env?.CONTENT_SERVICE_TOKEN;
  if (typeof secret !== 'string' || secret.length < 32 || secret.length > 512 || !/^[A-Za-z0-9._~+\/-]+={0,2}$/.test(secret)) throw new HttpError(503, '服务未配置');
  if (!await constantTimeEqual(header.slice(7), secret)) throw new HttpError(401, '服务凭据无效');
}

async function visitorRequest(request, env) {
  const header = request.headers.get('authorization');
  if (!header || !/^Bearer \S+$/i.test(header) || header.length > 263) throw modelHttpError('key_invalid');
  const key = validateApiKey(header.slice(7));
  requireOrigin(request, env);
  if (request.headers.has('x-content-api-key') || !env.DB?.prepare) throw new HttpError(503, '服务未配置');
  const ip = request.headers.get('CF-Connecting-IP');
  // Workers supplies this header; the loopback adapter overwrites it from the socket.
  if (!ip || ip.length > 64 || !/^[0-9a-f:.]+$/i.test(ip)) throw new HttpError(503, '请求来源未配置');
  const ipId = await requestFingerprint(ip, env.RATE_LIMIT_SECRET, 'ip');
  await env.DB.prepare('DELETE FROM rate_limits WHERE expires_at <= ?').bind(Date.now()).run();
  await rateLimit(env.DB, `ip:${ipId}`, 30);
  const owner = await requestFingerprint(key, env.RATE_LIMIT_SECRET, 'key');
  await rateLimit(env.DB, `key:${owner}`, 20);
  const body = await readJson(request, new URL(request.url).pathname === '/api/test' ? 2048 : 64_000);
  const config = agentModelConfig(env, {region:body.region, model:body.model}, key);
  return {body, config, owner};
}

function preflight(request, env, method) {
  requireOrigin(request, env);
  if (request.headers.get('Access-Control-Request-Method') !== method) throw new HttpError(405, '请求方法不允许');
  const headers = (request.headers.get('Access-Control-Request-Headers') || '').split(',').map(header => header.trim().toLowerCase()).filter(Boolean);
  if (headers.some(header => !['authorization', 'content-type', 'accept'].includes(header))) throw new HttpError(403, '请求头不允许');
  return new Response(null, {status:204, headers:{
    Allow:`${method}, OPTIONS`, 'Access-Control-Allow-Methods':method,
    'Access-Control-Allow-Headers':'Authorization, Content-Type, Accept', 'Access-Control-Max-Age':'300',
    Vary:'Origin, Access-Control-Request-Method, Access-Control-Request-Headers',
  }});
}

export async function fetchHandler(request, env = {}, ctx = {}) {
  const url = new URL(request.url);
  const method = Object.hasOwn(ROUTES, url.pathname) ? ROUTES[url.pathname] : null;
  let response;
  try {
    if (!method) throw new HttpError(404, '接口不存在');
    if (request.method === 'OPTIONS') response = preflight(request, env, method);
    else {
      if (request.method !== method) throw new HttpError(405, '请求方法不允许');
      if (url.search || url.hash) throw new HttpError(400, '不接受 URL 凭据或参数');
      switch (url.pathname) {
        case '/health':
          if (request.headers.has('origin')) requireOrigin(request, env);
          response = responseJson({ok:true});
          break;
        case '/api/models':
          requireOrigin(request, env);
          response = responseJson({models:listAgentModels(env)});
          break;
        case '/api/test': {
          const {body, config, owner} = await visitorRequest(request, env);
          if (Object.keys(body).length !== 2 || !Object.hasOwn(body, 'region') || !Object.hasOwn(body, 'model')) throw new HttpError(400, '测试参数无效');
          const job = await acquireJob(env.DB, owner);
          if (!job) throw new HttpError(429, '任务数量已达上限');
          try {
            const result = await invokeModel({...config, maxOutput:32}, {signal:request.signal, fetcher:ctx.fetcher,
              messages:[{role:'user', content:'Return exactly this JSON object: {"ok":true}'}]});
            let output;
            try { output = JSON.parse(result.text); } catch { throw new ModelError('output'); }
            if (!output || output.ok !== true || Object.keys(output).length !== 1) throw new ModelError('output');
            response = responseJson({ok:true, model:config.model, region:config.region, usage:result.usage});
          } finally { await releaseJob(env.DB, job); }
          break;
        }
        case '/api/agent': {
          const visitor = await visitorRequest(request, env);
          response = await agentService(request, env, ctx, visitor);
          break;
        }
        case '/internal/content': {
          await authorizeContent(request, env);
          requireOrigin(request, env);
          if (!env.DB?.prepare) throw new HttpError(503, '服务未配置');
          await rateLimit(env.DB, 'content:service', 30);
          const contentKey = validateApiKey(request.headers.get('x-content-api-key'));
          modelConfig(env, 'content', contentKey);
          response = await contentService(request, env, {...ctx, contentKey});
          break;
        }
      }
    }
  } catch (error) {
    response = errorResponse(error instanceof ModelError ? modelHttpError(error.code) : error);
    if (response.status === 405 && method) response.headers.set('Allow', `${method}, OPTIONS`);
  }
  return secureResponse(response, request, env);
}

export async function scheduled(_event, env, ctx) {
  if (!env?.DB?.prepare || !env.DB.batch) throw new HttpError(503, '存储服务未配置');
  const task = cleanup(env.DB);
  ctx?.waitUntil?.(task);
  await task;
}

export default {fetch:fetchHandler, scheduled};
