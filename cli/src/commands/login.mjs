import { spawn } from 'node:child_process';
import { hostname } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import { writeConfig, readConfig, DEFAULT_API_BASE } from '../config.mjs';
import { listMyStacks, startDevicePairing, pollDeviceToken, BindryApiError } from '../api.mjs';

// RFC 8628 §3.5: add 5 seconds to the interval each time the server answers slow_down. Injectable
// only so the tests can assert the widening without actually waiting it out.
const SLOW_DOWN_STEP_MS = 5000;

/**
 * Two ways in.
 *
 * `bindry login` pairs through the browser (BIND-0202): the terminal shows a code, a human approves
 * it on the site, and the terminal collects a workspace key. Nothing is pasted, and signing UP
 * happens on a real page — where terms can be shown and anti-abuse works, neither of which a
 * terminal can do.
 *
 * `bindry login <token>` still takes a key directly, because CI has no browser and no human.
 */
export async function login({ token, apiBase, json, noBrowser, clientName, slowDownStepMs } = {}) {
  const resolvedApiBase = apiBase ?? readConfig().apiBase ?? DEFAULT_API_BASE;

  return token
    ? loginWithToken({ token, apiBase: resolvedApiBase, json })
    : loginByPairing({ apiBase: resolvedApiBase, json, noBrowser, clientName, slowDownStepMs });
}

async function loginWithToken({ token, apiBase, json }) {
  let stacks;
  try {
    stacks = await listMyStacks(apiBase, token);
  } catch (err) {
    if (err instanceof BindryApiError) {
      throw new Error(`could not verify that token: ${err.message}`);
    }
    throw err;
  }

  writeConfig({ ...readConfig(), apiBase, token });

  if (json) {
    emit({ event: 'logged_in', apiBase, method: 'token', stacks: stacks.length });
    return;
  }

  console.log(`bindry: logged in. ${stacks.length} Stack${stacks.length === 1 ? '' : 's'} in this workspace.`);
  console.log(`bindry: API base set to ${apiBase}.`);
}

async function loginByPairing({ apiBase, json, noBrowser, clientName, slowDownStepMs }) {
  const machine = clientName ?? safeHostname();
  const pairing = await startDevicePairing(apiBase, machine);
  const approvalUrl = pairing.verification_uri_complete ?? pairing.verification_uri;

  if (json) {
    // Newline-delimited JSON, emitted as it happens: an agent reads this line, relays the code and
    // the URL to the human it is working for, and waits for the second line rather than parsing
    // prose or watching a spinner it cannot see.
    emit({
      event: 'pairing_started',
      user_code: pairing.user_code,
      verification_uri: pairing.verification_uri,
      verification_uri_complete: pairing.verification_uri_complete,
      expires_in: pairing.expires_in,
      next_step: `Open ${approvalUrl} and approve the code ${pairing.user_code}.`
    });
  } else {
    console.log('');
    console.log(`  Your code:  ${pairing.user_code}`);
    console.log(`  Approve at: ${approvalUrl}`);
    console.log('');
    console.log(`bindry: waiting for approval — this code expires in ${Math.round((pairing.expires_in ?? 900) / 60)} minutes.`);
  }

  if (!noBrowser) openInBrowser(approvalUrl);

  const result = await waitForApproval({ apiBase, pairing, slowDownStepMs });

  writeConfig({
    ...readConfig(),
    apiBase,
    token: result.apiKey,
    apiKeyId: result.apiKeyId,
    tenantId: result.tenantId
  });

  if (json) {
    emit({ event: 'logged_in', apiBase, method: 'pairing', tenant_id: result.tenantId });
    return;
  }

  console.log('bindry: connected. The key is stored for this machine.');
  console.log(`bindry: API base set to ${apiBase}.`);
}

/**
 * Polls until the human decides. The interval comes from the server, and slow_down widens it —
 * RFC 8628 says add 5 seconds each time it is returned, and a client that ignores that gets
 * throttled rather than answered.
 */
async function waitForApproval({ apiBase, pairing, slowDownStepMs = SLOW_DOWN_STEP_MS }) {
  const deadline = Date.now() + (pairing.expires_in ?? 900) * 1000;
  let interval = (pairing.interval ?? 5) * 1000;

  while (Date.now() < deadline) {
    await sleep(interval);

    const result = await pollDeviceToken(apiBase, pairing.device_code);
    switch (result.status) {
      case 'approved':
        return result;
      case 'authorization_pending':
        break;
      case 'slow_down':
        interval += slowDownStepMs;
        break;
      case 'access_denied':
        throw new Error('that request was refused in the browser. Nothing was connected.');
      case 'expired_token':
        throw new Error('that code expired before it was approved. Run "bindry login" again.');
      default:
        throw new Error(`pairing failed (${result.status}). Run "bindry login" again.`);
    }
  }

  throw new Error('timed out waiting for approval. Run "bindry login" again.');
}

/** Best-effort. A terminal with no browser (SSH, a container) still has the URL printed above. */
function openInBrowser(url) {
  const command = process.platform === 'win32' ? 'cmd' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];

  try {
    spawn(command, args, { stdio: 'ignore', detached: true }).unref();
  } catch {
    // Nothing to report: the URL is already on screen, and failing to launch a browser is not a
    // failure to log in.
  }
}

function safeHostname() {
  try {
    return hostname();
  } catch {
    return 'terminal';
  }
}

function emit(payload) {
  console.log(JSON.stringify(payload));
}
