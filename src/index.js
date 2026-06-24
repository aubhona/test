const ORIGIN_HOST = 'uz.do-kazankiu.ru';
const ORIGIN_URL = `https://${ORIGIN_HOST}`;

const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailers',
  'transfer-encoding',
  'upgrade',
]);

const REWRITABLE_CONTENT_TYPES = [
  'text/html',
  'text/css',
  'application/javascript',
  'text/javascript',
  'application/json',
  'application/xml',
  'text/xml',
];

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function getWorkerOrigin(requestUrl) {
  return `${requestUrl.protocol}//${requestUrl.host}`;
}

function getCorsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, HEAD, POST, PUT, DELETE, OPTIONS, PATCH',
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Max-Age': '86400',
  };
}

function shouldRewriteContentType(contentType) {
  if (!contentType) {
    return false;
  }

  const normalized = contentType.toLowerCase();
  return REWRITABLE_CONTENT_TYPES.some((type) => normalized.includes(type));
}

function rewriteUrls(text, workerOrigin) {
  const hostPattern = escapeRegex(ORIGIN_HOST);

  return text
    .replace(
      new RegExp(`https?:\\/\\/${hostPattern}(?=[/?#]|["'\\s]|$)`, 'gi'),
      workerOrigin,
    )
    .replace(
      new RegExp(`\\/\\/${hostPattern}(?=[/?#]|["'\\s]|$)`, 'gi'),
      workerOrigin,
    );
}

function rewriteLocation(location, workerOrigin) {
  if (!location) {
    return location;
  }

  if (location.startsWith('/')) {
    return location;
  }

  try {
    const locationUrl = new URL(location);

    if (locationUrl.hostname === ORIGIN_HOST) {
      return `${workerOrigin}${locationUrl.pathname}${locationUrl.search}${locationUrl.hash}`;
    }

    return location;
  } catch {
    return rewriteUrls(location, workerOrigin);
  }
}

function rewriteSetCookie(setCookie) {
  return setCookie.replace(/;\s*Domain=[^;]*/gi, '');
}

function buildUpstreamHeaders(request, workerHost) {
  const headers = new Headers();

  for (const [name, value] of request.headers.entries()) {
    const lowerName = name.toLowerCase();

    if (lowerName === 'host' || lowerName.startsWith('cf-') || HOP_BY_HOP_HEADERS.has(lowerName)) {
      continue;
    }

    headers.set(name, value);
  }

  headers.set('Host', ORIGIN_HOST);
  headers.set('X-Forwarded-Host', workerHost);
  headers.set('X-Forwarded-Proto', 'https');

  const clientIp = request.headers.get('CF-Connecting-IP');
  if (clientIp) {
    headers.set('X-Forwarded-For', clientIp);
    headers.set('X-Real-IP', clientIp);
  }

  return headers;
}

function buildResponseHeaders(upstreamHeaders, workerOrigin) {
  const headers = new Headers();

  for (const [name, value] of upstreamHeaders.entries()) {
    const lowerName = name.toLowerCase();

    if (HOP_BY_HOP_HEADERS.has(lowerName) || lowerName === 'set-cookie') {
      continue;
    }

    if (lowerName === 'location') {
      headers.set(name, rewriteLocation(value, workerOrigin));
      continue;
    }

    headers.set(name, value);
  }

  const setCookies =
    typeof upstreamHeaders.getSetCookie === 'function'
      ? upstreamHeaders.getSetCookie()
      : upstreamHeaders.get('set-cookie')
        ? [upstreamHeaders.get('set-cookie')]
        : [];

  for (const cookie of setCookies) {
    if (cookie) {
      headers.append('set-cookie', rewriteSetCookie(cookie));
    }
  }

  return headers;
}

async function proxyRequest(request) {
  const requestUrl = new URL(request.url);
  const workerOrigin = getWorkerOrigin(requestUrl);
  const targetUrl = new URL(`${requestUrl.pathname}${requestUrl.search}`, ORIGIN_URL);

  const upstreamRequest = new Request(targetUrl.toString(), {
    method: request.method,
    headers: buildUpstreamHeaders(request, requestUrl.host),
    body: ['GET', 'HEAD'].includes(request.method) ? undefined : request.body,
    redirect: 'manual',
  });

  const upstreamResponse = await fetch(upstreamRequest);
  const responseHeaders = buildResponseHeaders(upstreamResponse.headers, workerOrigin);
  const contentType = upstreamResponse.headers.get('content-type') || '';

  for (const [name, value] of Object.entries(getCorsHeaders())) {
    responseHeaders.set(name, value);
  }

  if (!shouldRewriteContentType(contentType)) {
    return new Response(upstreamResponse.body, {
      status: upstreamResponse.status,
      statusText: upstreamResponse.statusText,
      headers: responseHeaders,
    });
  }

  const rewrittenBody = rewriteUrls(await upstreamResponse.text(), workerOrigin);

  responseHeaders.delete('content-encoding');
  responseHeaders.delete('content-length');
  responseHeaders.delete('transfer-encoding');

  return new Response(rewrittenBody, {
    status: upstreamResponse.status,
    statusText: upstreamResponse.statusText,
    headers: responseHeaders,
  });
}

export default {
  async fetch(request) {
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: getCorsHeaders(),
      });
    }

    try {
      return await proxyRequest(request);
    } catch (error) {
      return new Response(`Proxy error: ${error.message}`, {
        status: 502,
        headers: {
          ...getCorsHeaders(),
          'Content-Type': 'text/plain; charset=utf-8',
        },
      });
    }
  },
};
