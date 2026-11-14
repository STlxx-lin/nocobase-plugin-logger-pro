export interface SSEEventPayload {
  type: 'meta' | 'reasoning' | 'chunk' | 'done' | 'error';
  content?: string;
  message?: string;
  [key: string]: any;
}

/**
 * Resolve NocoBase API URL & headers from APIClient instance for native fetch SSE streaming.
 */
function resolveRequestMeta(api: any, actionPath: string): { url: string; headers: Record<string, string> } {
  const baseURL = String(api?.axios?.defaults?.baseURL || '/api/').replace(/\/+$/, '');
  const cleanPath = actionPath.replace(/^\/+/, '');
  const url = `${baseURL}/${cleanPath}`;

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Accept': 'text/event-stream',
  };

  try {
    const commonHeaders = api?.axios?.defaults?.headers?.common || {};
    for (const [k, v] of Object.entries(commonHeaders)) {
      if (v && typeof v === 'string') headers[k] = v;
    }
    const token =
      api?.auth?.getToken?.() ||
      (typeof localStorage !== 'undefined' ? localStorage.getItem('NOCOBASE_TOKEN') : null);
    if (token && !headers['Authorization']) {
      headers['Authorization'] = `Bearer ${token}`;
    }
    const role =
      api?.auth?.getRole?.() ||
      (typeof localStorage !== 'undefined' ? localStorage.getItem('NOCOBASE_ROLE') : null);
    if (role && !headers['X-Role']) {
      headers['X-Role'] = role;
    }
    const authenticator = api?.auth?.getAuthenticator?.();
    if (authenticator && !headers['X-Authenticator']) {
      headers['X-Authenticator'] = authenticator;
    }
  } catch {}

  return { url, headers };
}

/**
 * 发起 POST SSE 流式请求并逐条解析 `data: {...}` 事件；
 * 若服务端不支持 SSE 或连接异常，则抛出错误由调用方自动降级为同步请求。
 */
export async function streamActionSSE(
  api: any,
  actionPath: string,
  data: Record<string, any>,
  onEvent: (event: SSEEventPayload) => void,
  signal?: AbortSignal,
): Promise<void> {
  if (typeof fetch !== 'function') {
    throw new Error('Fetch API not available');
  }

  const { url, headers } = resolveRequestMeta(api, actionPath);
  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(data),
    credentials: 'include',
    signal,
  });

  if (!res.ok) {
    throw new Error(`SSE HTTP ${res.status}`);
  }

  const contentType = res.headers.get('content-type') || '';
  if (!contentType.includes('text/event-stream')) {
    throw new Error(`Unexpected content-type: ${contentType}`);
  }

  const reader = res.body?.getReader();
  if (!reader) {
    throw new Error('ReadableStream not supported');
  }

  const decoder = new TextDecoder('utf-8');
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith('data:')) continue;
      const raw = trimmed.slice(5).trim();
      if (!raw || raw === '[DONE]') continue;
      try {
        const parsed = JSON.parse(raw) as SSEEventPayload;
        onEvent(parsed);
      } catch {}
    }
  }
}
