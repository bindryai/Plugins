import { clearConfig, readConfig } from '../config.mjs';
import { revokeOwnApiKey, BindryApiError } from '../api.mjs';

/**
 * Revokes the key server-side, then forgets it locally (BIND-0203).
 *
 * It used to only forget it, and said so — which left a live credential in the workspace that
 * nobody was tracking. Revoking first is the right order: if revocation fails the key is still in
 * the config, so the user can retry or revoke it from the Team page, rather than being left holding
 * a working key they can no longer name.
 *
 * `--keep-key` forgets without revoking, for the case where the same key is deliberately shared
 * with CI or another machine.
 */
export async function logout({ apiBase, token, json, keepKey } = {}) {
  const stored = readConfig();
  const revocable = token ?? stored.token;

  let revoked = false;
  let revokeError = null;

  if (revocable && !keepKey) {
    try {
      revoked = await revokeOwnApiKey(apiBase ?? stored.apiBase, revocable);
    } catch (err) {
      if (!(err instanceof BindryApiError)) throw err;
      revokeError = err.message;
    }
  }

  if (revokeError) {
    // Deliberately keeps the config: a key that could not be revoked is one the user still needs to
    // be able to find and revoke by hand.
    if (json) {
      emit({ event: 'logout_failed', revoked: false, error: revokeError, tokenKept: true });
    } else {
      console.error(`bindry: could not revoke the key — ${revokeError}`);
      console.error('bindry: the stored token was left in place. Revoke it from the workspace\'s Team page, or retry.');
    }
    process.exitCode = 1;
    return;
  }

  clearConfig();

  if (json) {
    emit({ event: 'logged_out', revoked, tokenKept: false });
    return;
  }

  console.log('bindry: logged out. The stored token was removed from this machine.');
  if (revoked) {
    console.log('bindry: the key was revoked, so it no longer works anywhere.');
  } else if (keepKey) {
    console.log('bindry: the key itself was left active, as asked (--keep-key).');
  } else if (revocable) {
    console.log('bindry: that key was already inactive, so there was nothing to revoke.');
  }
}

function emit(payload) {
  console.log(JSON.stringify(payload));
}
