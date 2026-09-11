// =====================================================================
// 汤少画布工作流 · Supabase Edge Function（CORS / 媒体中转）
// 等价于 worker.js（Cloudflare Worker 版）。
//
// 部署：
//   1) supabase 登录 + 建项目（https://supabase.com/dashboard）
//   2) supabase functions deploy canvas-proxy --no-verify-jwt
//   3) 把得到的 URL 填到画布「接口设置 · 代理地址」
//      https://<project-ref>.supabase.co/functions/v1/canvas-proxy
//
// 本函数对所有来源开放（CORS *），仅作个人项目用途。
// 生产环境请加鉴权（如 require SUPABASE_ANON_KEY 头）。
// =====================================================================

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS, HEAD',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Max-Age': '86400',
};

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

const JSON_HEADERS = { ...CORS, 'Content-Type': 'application/json; charset=utf-8' };

function jerr(status: number, msg: string): Response {
  return new Response(JSON.stringify({ error: msg }), { status, headers: JSON_HEADERS });
}

function preflight(): Response {
  return new Response(null, { status: 204, headers: CORS });
}

function health(): Response {
  return new Response(JSON.stringify({ ok: true, service: 'tangshao-canvas-cors-proxy' }), {
    status: 200,
    headers: JSON_HEADERS,
  });
}

function stripUnsafe(h: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h || {})) {
    const lk = k.toLowerCase();
    if (['host', 'content-length', 'cf-connecting-ip', 'cf-ray', 'x-forwarded-for'].includes(lk)) continue;
    out[k] = v;
  }
  return out;
}

async function forward(req: Request): Promise<Response> {
  let spec: any;
  try { spec = await req.json(); }
  catch (e: any) { return jerr(400, '代理收到的指令不是合法 JSON: ' + (e.message || e)); }

  const target = spec?.url;
  if (!target) return jerr(400, '缺少 url 字段');

  const method = String(spec.method || 'POST').toUpperCase();
  const headers = spec.headers || {};
  let data: BodyInit | undefined;
  if (spec.body !== undefined && spec.body !== null) {
    data = typeof spec.body === 'string' ? spec.body : JSON.stringify(spec.body);
  }

  let upstream: Response;
  try {
    upstream = await fetch(target, {
      method,
      headers: {
        'User-Agent': headers['User-Agent'] || headers['user-agent'] || UA,
        ...stripUnsafe(headers),
      },
      body: data,
      redirect: 'follow',
    });
  } catch (e: any) {
    return jerr(502, `转发失败: ${e.message || e}`);
  }

  // 把上游响应原样吐回去，补 CORS 头
  const respHeaders = new Headers(upstream.headers);
  for (const [k, v] of Object.entries(CORS)) respHeaders.set(k, v);

  return new Response(upstream.body, {
    status: upstream.status,
    headers: respHeaders,
  });
}

// ---------- 媒体转发 /media?url=...&dl=1 ----------
async function media(qs: URLSearchParams): Promise<Response> {
  const target = qs.get('url');
  if (!target) return jerr(400, '缺少 url 参数');
  const dl = qs.get('dl') === '1' || qs.get('dl') === 'true';

  let upstream: Response;
  try {
    upstream = await fetch(target, {
      headers: { 'User-Agent': UA },
      redirect: 'follow',
    });
  } catch (e: any) {
    return jerr(502, `抓取媒体失败: ${e.message || e}`);
  }

  const respHeaders = new Headers(upstream.headers);
  for (const [k, v] of Object.entries(CORS)) respHeaders.set(k, v);
  respHeaders.set('Accept-Ranges', 'bytes');

  if (dl) {
    let fname = '';
    try { fname = decodeURIComponent(new URL(target).pathname.split('/').pop() || ''); }
    catch { fname = ''; }
    fname = fname || 'output';
    respHeaders.set(
      'Content-Disposition',
      `attachment; filename="${fname}"; filename*=UTF-8''${encodeURIComponent(fname)}`
    );
  }

  return new Response(upstream.body, { status: upstream.status, headers: respHeaders });
}

Deno.serve(async (req: Request): Promise<Response> => {
  const url = new URL(req.url);

  if (req.method === 'OPTIONS') return preflight();

  const path = url.pathname.replace(/\/+$/, '');
  if (path === '' || path.endsWith('/health')) return health();
  if (path.endsWith('/media')) return media(url.searchParams);

  if (req.method === 'POST') return forward(req);

  return jerr(405, 'Method not allowed');
});