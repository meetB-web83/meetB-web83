const BASE_URL = '/api';

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const hasBody = !!options?.body;
  const response = await fetch(`${BASE_URL}${path}`, {
    headers: hasBody ? { 'Content-Type': 'application/json' } : {},
    ...options,
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ message: 'Request failed' }));
    throw new Error(error.message || `HTTP ${response.status}`);
  }

  const text = await response.text();
  return text ? (JSON.parse(text) as T) : (null as unknown as T);
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body: unknown) => request<T>(path, { method: 'POST', body: JSON.stringify(body) }),
  patch: <T>(path: string, body: unknown) => request<T>(path, { method: 'PATCH', body: JSON.stringify(body) }),
  delete: <T>(path: string) => request<T>(path, { method: 'DELETE' }),
};
