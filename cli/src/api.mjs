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

async function request(apiBase, path, { token, searchParams, method, body } = {}) {
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
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  let response;
  try {
    response = await fetch(url, {
      method: method ?? (body === undefined ? 'GET' : 'POST'),
      headers,
      body: body === undefined ? undefined : JSON.stringify(body)
    });
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
    // The API answers a rejected write with ProblemDetails — a title, and a field-by-field errors
    // map. Without reading it, every validation failure reads as "400 Bad Request", which tells
    // the user nothing about which field the API objected to or why.
    const detail = await readProblemDetail(response);
    throw new BindryApiError(
      detail
        ? `${detail} (${response.status} from ${response.url})`
        : `request failed: ${response.status} ${response.statusText} (${response.url})`,
      { status: response.status, url: response.url }
    );
  }
  try {
    return await response.json();
  } catch (err) {
    throw new BindryApiError(`response from ${response.url} was not valid JSON (${err.message}).`, {
      url: response.url
    });
  }
}

// --- Device pairing: signing in without pasting a key (BIND-0202/0203) ---

/**
 * Asks for a pairing code. Anonymous — this is what a terminal calls before anyone is signed in.
 * Field names are RFC 8628's, because that is the shape the API speaks.
 */
export function startDevicePairing(apiBase, clientName) {
  return requestJson(apiBase, '/api/auth/device/code', { body: { clientName } });
}

/**
 * One poll. Unlike every other call here, a non-2xx is the NORMAL case: the terminal polls while it
 * waits for a human, and "not yet" arrives as a 400 carrying an RFC 8628 error code. So this
 * returns the outcome rather than throwing — only an unreachable or unintelligible API is
 * exceptional.
 */
export async function pollDeviceToken(apiBase, deviceCode) {
  const response = await request(apiBase, '/api/auth/device/token', { body: { deviceCode } });

  let payload = null;
  try {
    payload = await response.json();
  } catch {
    // Unreadable body — falls through to the throw below rather than being guessed at.
  }

  if (response.ok && payload?.api_key) {
    return {
      status: 'approved',
      apiKey: payload.api_key,
      apiKeyId: payload.api_key_id,
      tenantId: payload.tenant_id
    };
  }

  if (payload?.error) return { status: payload.error };

  throw new BindryApiError(
    `pairing failed: ${response.status} ${response.statusText} (${response.url})`,
    { status: response.status, url: response.url }
  );
}

/**
 * Revokes the key this CLI holds, server-side, using the key itself as proof (the API's
 * my-api-keys/self/revoke route). Without it, logout could only forget a credential that stayed
 * live in the workspace with nobody tracking it.
 */
export async function revokeOwnApiKey(apiBase, token) {
  const response = await request(apiBase, '/api/team/my-api-keys/self/revoke', { token, body: {} });

  if (response.status === 204) return true;
  if (response.status === 404) return false;
  if (response.status === 401 || response.status === 403) {
    throw new BindryApiError('that token is already invalid — there is nothing to revoke.', {
      status: response.status,
      url: response.url
    });
  }

  throw new BindryApiError(`could not revoke the key: ${response.status} ${response.statusText}`, {
    status: response.status,
    url: response.url
  });
}

/** The useful sentence out of a ProblemDetails body, or null when there isn't one. */
async function readProblemDetail(response) {
  try {
    const problem = await response.json();
    const fieldErrors = Object.values(problem?.errors ?? {}).flat().filter(Boolean);
    if (fieldErrors.length > 0) return fieldErrors.join(' ');
    return problem?.detail || problem?.title || null;
  } catch {
    return null;
  }
}

// --- Creating your own Skills (BIND-0205) ---

/**
 * The export targets a new Skill supports. Matches Bindry.Lib.Skills.SkillTarget's member
 * names exactly — the API rejects anything else — and covers every format the plugins and this CLI
 * can compile to, so an imported Skill is usable everywhere its owner already works.
 */
export const SkillApiTargets = ['Claude', 'Codex', 'GitHubCopilot', 'Mcp', 'Markdown', 'CopyPaste'];

/**
 * Creates one Skill as a private draft. Everything an import produces lands here: private, so
 * nothing internal leaks, and a draft, so publishing stays a separate deliberate act.
 */
export function createSkill(apiBase, token, draft) {
  return requestJson(apiBase, '/api/skills', { token, body: draft });
}

// --- Public Library (anonymous, no token) ---

export function searchPublicCatalog(apiBase, { q, kind, category, target, tags, skip, take } = {}) {
  return requestJson(apiBase, '/api/public/catalog', {
    searchParams: { q, kind, category, target, tags, skip, take }
  });
}

export function getPublicBinder(apiBase, slugOrId) {
  return requestJson(apiBase, `/api/public/catalog/binders/${encodeURIComponent(slugOrId)}`);
}

export function getPublicSkill(apiBase, slugOrId) {
  return requestJson(apiBase, `/api/public/catalog/skills/${encodeURIComponent(slugOrId)}`);
}

// The JSON-envelope route (BinderExportResult: { content, contentType, fileName, ... }), not
// /export/file — that one returns the raw compiled bytes with a target-dependent content type
// (text/markdown for Markdown/AgentsMd, application/json for SkillBundle), which only `.json()`
// parses correctly for one of the three targets. The envelope always parses, and pull.mjs decides
// what to do with .content based on the target it asked for.
export function exportPublicBinder(apiBase, slugOrId, target, version) {
  return requestJson(apiBase, `/api/public/catalog/binders/${encodeURIComponent(slugOrId)}/export`, {
    searchParams: { target, version }
  });
}

export function exportPublicSkill(apiBase, slugOrId, target) {
  return requestJson(apiBase, `/api/public/catalog/skills/${encodeURIComponent(slugOrId)}/export`, {
    searchParams: { target }
  });
}

// --- Your workspace (requires a token from `bindry login`) ---

/**
 * Pushes a repository's rules folder to a Binder (BIND-0197). Reconciliation happens server-side: this
 * sends the whole folder and gets back a per-file report of what was created, versioned, left alone, or
 * no longer present.
 */
export function publishFromSource(apiBase, token, payload) {
  return requestJson(apiBase, '/api/binders/from-source', { token, body: payload });
}

export function listMyBinders(apiBase, token, { includeArchived } = {}) {
  return requestJson(apiBase, '/api/binders', { token, searchParams: { includeArchived } });
}

export function getMyBinder(apiBase, token, binderId) {
  return requestJson(apiBase, `/api/binders/${encodeURIComponent(binderId)}`, { token });
}

export function exportMyBinder(apiBase, token, binderId, target, version) {
  return requestJson(apiBase, `/api/binders/${encodeURIComponent(binderId)}/export`, {
    token,
    searchParams: { target, version }
  });
}

export function getMySkill(apiBase, token, skillId) {
  return requestJson(apiBase, `/api/skills/${encodeURIComponent(skillId)}`, { token });
}

export function exportMySkill(apiBase, token, skillId, target) {
  return requestJson(apiBase, `/api/skills/${encodeURIComponent(skillId)}/export`, {
    token,
    searchParams: { target }
  });
}

export const GUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Resolves a Binder's detail by GUID or slug, the same "yours first, then public" order the plugin
// compilers already use: a token only ever helps here, it never blocks a public Binder.
export async function resolveBinderDetail(apiBase, token, slugOrId) {
  if (token && GUID_PATTERN.test(slugOrId)) {
    try {
      return { source: 'private', detail: await getMyBinder(apiBase, token, slugOrId) };
    } catch (err) {
      if (!(err instanceof BindryApiError) || (err.status !== 401 && err.status !== 403 && err.status !== 404)) {
        throw err;
      }
      // Falls through to the public route below — same reasoning as compile-binder.mjs's fetchLive.
    }
  }
  return { source: 'public', detail: await getPublicBinder(apiBase, slugOrId) };
}

// `version` pins to a published Binder version (BIND-0252/BIND-0196). Both routes answer a version
// that does not exist with a 400 naming the ones that do, which requestJson surfaces verbatim — so a
// typo'd version reads as a list of real choices rather than "request failed".
//
// Note the 404 fallthrough below is about the Binder, not the version: a 400 from an unknown version
// is rethrown rather than retried publicly, because retrying would turn "no such version of your
// Binder" into "no such Binder", which sends the user looking for the wrong problem.
export async function resolveBinderExport(apiBase, token, slugOrId, target, version) {
  if (token && GUID_PATTERN.test(slugOrId)) {
    try {
      return { source: 'private', binder: await exportMyBinder(apiBase, token, slugOrId, target, version) };
    } catch (err) {
      if (!(err instanceof BindryApiError) || (err.status !== 401 && err.status !== 403 && err.status !== 404)) {
        throw err;
      }
    }
  }
  return { source: 'public', binder: await exportPublicBinder(apiBase, slugOrId, target, version) };
}

// Same "yours first, then public" resolution as resolveBinderExport, for a standalone Skill.
export async function resolveSkillExport(apiBase, token, slugOrId, target) {
  if (token && GUID_PATTERN.test(slugOrId)) {
    try {
      return { source: 'private', skill: await exportMySkill(apiBase, token, slugOrId, target) };
    } catch (err) {
      if (!(err instanceof BindryApiError) || (err.status !== 401 && err.status !== 403 && err.status !== 404)) {
        throw err;
      }
    }
  }
  return { source: 'public', skill: await exportPublicSkill(apiBase, slugOrId, target) };
}

// Same "yours first, then public" resolution as resolveBinderDetail, for a standalone Skill.
export async function resolveSkillDetail(apiBase, token, slugOrId) {
  if (token && GUID_PATTERN.test(slugOrId)) {
    try {
      return { source: 'private', detail: await getMySkill(apiBase, token, slugOrId) };
    } catch (err) {
      if (!(err instanceof BindryApiError) || (err.status !== 401 && err.status !== 403 && err.status !== 404)) {
        throw err;
      }
    }
  }
  return { source: 'public', detail: await getPublicSkill(apiBase, slugOrId) };
}
