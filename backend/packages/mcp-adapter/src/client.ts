export async function callCore<T = any>(
  baseUrl: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const url = `${baseUrl}${path}`;

  const options: RequestInit = {
    method,
    headers: { 'Content-Type': 'application/json' },
  };

  if (body !== undefined && method !== 'GET') {
    options.body = JSON.stringify(body);
  }

  let response: Response;
  try {
    response = await fetch(url, options);
  } catch (err: any) {
    // Root AGENTS.md: if the service is down, tell the agent how to start it; no auto-start.
    throw new Error(
      `WorkJournal core service is not reachable at ${baseUrl} (${err?.message || err}). ` +
        `Start it with "pnpm start" (service) or "pnpm dev" (watch mode) in backend/, then retry.`,
    );
  }

  const text = await response.text();
  let data: any = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null; // non-JSON body (e.g. text/markdown exports)
    }
  }

  if (!response.ok) {
    const code = typeof data?.error === 'string' ? data.error : undefined;
    const message = data?.message || (typeof data?.error === 'object' && data?.error?.message) ||
      `Core service error: ${response.status}`;
    throw new Error(code ? `[${code}] ${message}` : String(message));
  }

  // Markdown exports come back as text; everything else is JSON.
  return (data === null ? (text as unknown as T) : (data as T));
}
