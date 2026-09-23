// Where `bindry login` stores its credential, and where every other command reads it back from.
// One file, one workspace's key at a time — the same shape as `gh`'s or `npm`'s own config file.
// Never printed in full: writeConfig chmods it 0600 where the platform supports it, and no command
// ever logs config.token.

import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const DEFAULT_API_BASE = 'https://api.bindry.ai';

export function configDir() {
  return process.env.BINDRY_CONFIG_DIR ?? join(homedir(), '.bindry');
}

export function configPath() {
  return join(configDir(), 'config.json');
}

export function readConfig() {
  const path = configPath();
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return {};
  }
}

export function writeConfig(config) {
  const dir = configDir();
  mkdirSync(dir, { recursive: true });
  const path = configPath();
  writeFileSync(path, JSON.stringify(config, null, 2) + '\n', 'utf8');
  try {
    // Best-effort: irrelevant on platforms (e.g. Windows) where chmod doesn't apply this way.
    chmodSync(path, 0o600);
  } catch {
    // ignore
  }
  return path;
}

export function clearConfig() {
  const path = configPath();
  if (existsSync(path)) unlinkSync(path);
}

// Resolution order for each setting, highest priority first: an explicit CLI flag, then an
// environment variable (for CI and scripting), then the persisted config from `bindry login`.
export function resolveSession({ apiBase, token } = {}) {
  const config = readConfig();
  return {
    apiBase: apiBase ?? process.env.BINDRY_API_BASE ?? config.apiBase ?? DEFAULT_API_BASE,
    token: token ?? process.env.BINDRY_API_TOKEN ?? config.token ?? null
  };
}
