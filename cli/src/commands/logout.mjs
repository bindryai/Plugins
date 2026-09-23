import { clearConfig } from '../config.mjs';

export function logout() {
  clearConfig();
  console.log('bindry: logged out. The stored token was removed locally.');
  console.log('bindry: this does not revoke the key itself — do that from the workspace\'s Team page if it may be compromised.');
}
