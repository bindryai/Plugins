// Thin HTTP client over Bindry.API. No SDK, no dependency — every route here is one the web app
// and the agent plugins already call; this just gives the CLI the same access from a terminal.

export class BindryApiError extends Error {
  constructor(message, { status, url } = {}) {
    super(message);
    this.name = 'BindryApiError';
    this.status = status;
    this.url = url;
  }
}

function joinUrl(apiBase, path) {
  return `${apiBase.replace(/\/$/, '')}${path.startsWith('/') ? path : `/${path}`}`;
}

async function request(apiBase, path, { token, searchParams } = {}) {
  const url = new URL(joinUrl(apiBase, path));
  if (searchParams) {
    for (const [key, value] of Object.entries(searchParams)) {
      if (value === undefined || value === null || value === '') continue;
      if (Array.isArray(value)) {
        for (const item of value) url.searchParams.append(key, item);
      } else {
        url.searchParams.set(key, String(value));
      }
    }
  }

  const headers = {};
  if (token) headers['X-Api-Key'] = token;

  let response;
  try {
    response = await fetch(url, { headers });
  } catch (err) {
    throw new BindryApiError(`could not reach ${url} (${err.message}). Is --api-base correct and reachable?`, {
      url: url.toString()
    });
  }

  return response;
}

// Reads a JSON body, throwing a CLI-friendly error for anything that isn't a 2xx with valid JSON.
async function requestJson(apiBase, path, opts) {
  const response = await request(apiBase, path, opts);
  if (response.status === 404) {
    throw new BindryApiError('not found.', { status: 404, url: response.url });
  }
  if (response.status === 401 || response.status === 403) {
    throw new BindryApiError(
      opts?.token
        ? `authentication failed (${response.status}). The stored token may be revoked or expired — run "bindry login" again.`
        : `authentication required (${response.status}). Run "bindry login <token>" first, or this may be private.`,
      { status: response.status, url: response.url }
    );
  }
  if (!response.ok) {
    throw new BindryApiError(`request failed: ${response.status} ${response.statusText} (${response.url})`, {
      status: response.status,
      url: response.url
    });
  }
  try {
    return await response.json();
  } catch (err) {
    throw new BindryApiError(`response from ${response.url} was not valid JSON (${err.message}).`, {
      url: response.url
    });
  }
}

// --- Public Library (anonymous, no token) ---

export function searchPublicCatalog(apiBase, { q, kind, category, target, tags, skip, take } = {}) {
  return requestJson(apiBase, '/api/public/catalog', {
    searchParams: { q, kind, category, target, tags, skip, take }
  });
}

export function getPublicStack(apiBase, slugOrId) {
  return requestJson(apiBase, `/api/public/catalog/stacks/${encodeURIComponent(slugOrId)}`);
}

export function getPublicBinding(apiBase, slugOrId) {
  return requestJson(apiBase, `/api/public/catalog/bindings/${encodeURIComponent(slugOrId)}`);
}

// The JSON-envelope route (StackExportResult: { content, contentType, fileName, ... }), not
// /export/file — that one returns the raw compiled bytes with a target-dependent content type
// (text/markdown for Markdown/AgentsMd, application/json for SkillBundle), which only `.json()`
// parses correctly for one of the three targets. The envelope always parses, and pull.mjs decides
// what to do with .content based on the target it asked for.
export function exportPublicStack(apiBase, slugOrId, target) {
  return requestJson(apiBase, `/api/public/catalog/stacks/${encodeURIComponent(slugOrId)}/export`, {
    searchParams: { target }
  });
}

export function exportPublicBinding(apiBase, slugOrId, target) {
  return requestJson(apiBase, `/api/public/catalog/bindings/${encodeURIComponent(slugOrId)}/export`, {
    searchParams: { target }
  });
}

// --- Your workspace (requires a token from `bindry login`) ---

export function listMyStacks(apiBase, token, { includeArchived } = {}) {
  return requestJson(apiBase, '/api/stacks', { token, searchParams: { includeArchived } });
}

export function getMyStack(apiBase, token, stackId) {
  return requestJson(apiBase, `/api/stacks/${encodeURIComponent(stackId)}`, { token });
}

export function exportMyStack(apiBase, token, stackId, target) {
  return requestJson(apiBase, `/api/stacks/${encodeURIComponent(stackId)}/export`, {
    token,
    searchParams: { target }
  });
}

export function getMyBinding(apiBase, token, bindingId) {
  return requestJson(apiBase, `/api/bindings/${encodeURIComponent(bindingId)}`, { token });
}

export function exportMyBinding(apiBase, token, bindingId, target) {
  return requestJson(apiBase, `/api/bindings/${encodeURIComponent(bindingId)}/export`, {
    token,
    searchParams: { target }
  });
}

export const GUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Resolves a Stack's detail by GUID or slug, the same "yours first, then public" order the plugin
// compilers already use: a token only ever helps here, it never blocks a public Stack.
export async function resolveStackDetail(apiBase, token, slugOrId) {
  if (token && GUID_PATTERN.test(slugOrId)) {
    try {
      return { source: 'private', detail: await getMyStack(apiBase, token, slugOrId) };
    } catch (err) {
      if (!(err instanceof BindryApiError) || (err.status !== 401 && err.status !== 403 && err.status !== 404)) {
        throw err;
      }
      // Falls through to the public route below — same reasoning as compile-stack.mjs's fetchLive.
    }
  }
  return { source: 'public', detail: await getPublicStack(apiBase, slugOrId) };
}

export async function resolveStackExport(apiBase, token, slugOrId, target) {
  if (token && GUID_PATTERN.test(slugOrId)) {
    try {
      return { source: 'private', stack: await exportMyStack(apiBase, token, slugOrId, target) };
    } catch (err) {
      if (!(err instanceof BindryApiError) || (err.status !== 401 && err.status !== 403 && err.status !== 404)) {
        throw err;
      }
    }
  }
  return { source: 'public', stack: await exportPublicStack(apiBase, slugOrId, target) };
}

// Same "yours first, then public" resolution as resolveStackDetail, for a standalone Binding.
export async function resolveBindingDetail(apiBase, token, slugOrId) {
  if (token && GUID_PATTERN.test(slugOrId)) {
    try {
      return { source: 'private', detail: await getMyBinding(apiBase, token, slugOrId) };
    } catch (err) {
      if (!(err instanceof BindryApiError) || (err.status !== 401 && err.status !== 403 && err.status !== 404)) {
        throw err;
      }
    }
  }
  return { source: 'public', detail: await getPublicBinding(apiBase, slugOrId) };
}
