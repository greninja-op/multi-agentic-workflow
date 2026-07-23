/**
 * Secure key material handling for the CLI (Req 5.1, 5.8, 5.9; design §8.2).
 *
 * Two kinds of Ed25519 keys are held here, both stored ONLY in the OS secret
 * store with the encrypted-file fallback via `@cfls/security` — never in a
 * `.coordination/*` file and never logged:
 *
 *   - the **admin** key pair (`cfls admin-init`), scoped by team id, used to
 *     sign `Signed_Invitation`s; and
 *   - this device's **Device_Key** (`cfls id`, `cfls agent`), scoped by repo id,
 *     shared with the {@link CoordinationAgent} so the same identity is reused.
 *
 * Both scopes fail closed when no secure backend is available (Req 5.9).
 */

import { createHash } from "node:crypto";

import { loadOrCreateDeviceKey } from "@cfls/agent";
import {
  createSecretStore,
  DEVICE_PRIVATE_KEY_SECRET,
  generateDeviceKey,
  SecureStorageUnavailableError,
  type DeviceKey,
} from "@cfls/security";

/** Secret name under which the Team_Admin key pair is stored. */
export const ADMIN_KEY_SECRET = "admin-device-key";

/**
 * Derive a bounded, opaque secret-store name for one repository identity.
 * The encrypted-file fallback stores each secret name in a separate file; a
 * single generic name therefore cannot safely serve several repositories with
 * different encryption entropy.
 */
export function deviceKeySecretName(repoId: string): string {
  const scope = createHash("sha256").update(repoId, "utf8").digest("hex");
  return `device-private-key-${scope}`;
}

/** True when `value` is a well-formed {@link DeviceKey}. */
function isDeviceKey(value: unknown): value is DeviceKey {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as DeviceKey).publicKey === "string" &&
    typeof (value as DeviceKey).privateKey === "string"
  );
}

/**
 * Generate a fresh admin key pair and persist it in the secret store, scoped by
 * `teamId` so multiple teams on one machine do not collide. Fails closed if no
 * secure backend is available (Req 5.9). Returns the new {@link DeviceKey}.
 */
export async function createAdminKey(teamId: string): Promise<DeviceKey> {
  const store = createSecretStore({ appSecret: `cfls-admin:${teamId}` });
  if (!(await store.isAvailable())) {
    throw new SecureStorageUnavailableError(
      "No secure secret store is available to hold the admin private key (Req 5.9).",
    );
  }
  const key = generateDeviceKey();
  await store.set(ADMIN_KEY_SECRET, JSON.stringify(key));
  return key;
}

/**
 * Load the previously-created admin key pair for `teamId`. Throws when no admin
 * key has been created yet (run `cfls admin-init` first) or the store is
 * unavailable (Req 5.9).
 */
export async function loadAdminKey(teamId: string): Promise<DeviceKey> {
  const store = createSecretStore({ appSecret: `cfls-admin:${teamId}` });
  if (!(await store.isAvailable())) {
    throw new SecureStorageUnavailableError(
      "No secure secret store is available to read the admin private key (Req 5.9).",
    );
  }
  const raw = await store.get(ADMIN_KEY_SECRET);
  if (raw === null) {
    throw new Error(
      `No admin key found for team "${teamId}". Run "cfls admin-init" first.`,
    );
  }
  const parsed: unknown = JSON.parse(raw);
  if (!isDeviceKey(parsed)) {
    throw new Error('Stored admin key is corrupt; re-run "cfls admin-init".');
  }
  return { publicKey: parsed.publicKey, privateKey: parsed.privateKey };
}

/**
 * Load-or-create this device's Device_Key, scoped by `repoId` so it matches the
 * key the {@link CoordinationAgent} loads at runtime. Delegates to the agent's
 * {@link loadOrCreateDeviceKey}, which fails closed on an unavailable store.
 */
export async function loadOrCreateThisDeviceKey(
  repoId: string,
): Promise<DeviceKey> {
  const store = createSecretStore({ appSecret: repoId });
  const scopedName = deviceKeySecretName(repoId);

  // Prefer the scoped record. It prevents an encrypted fallback record from a
  // different repository from being decrypted with this repository's entropy.
  let scoped: string | null = null;
  try {
    scoped = await store.get(scopedName);
  } catch {
    // A damaged scoped fallback record is regenerated below.
  }
  if (scoped !== null) {
    try {
      const parsed: unknown = JSON.parse(scoped);
      if (isDeviceKey(parsed)) {
        return { publicKey: parsed.publicKey, privateKey: parsed.privateKey };
      }
    } catch {
      // Delegate a malformed scoped record to the established regeneration path.
    }
  }

  // Migrate a readable legacy generic record so existing enrolled devices keep
  // their identity. A generic encrypted-file record from another repository
  // cannot authenticate under this repo's entropy; ignore it and make a clean
  // scoped identity instead.
  try {
    const legacy = await store.get(DEVICE_PRIVATE_KEY_SECRET);
    if (legacy !== null) {
      const parsed: unknown = JSON.parse(legacy);
      if (isDeviceKey(parsed)) {
        await store.set(scopedName, legacy);
        return { publicKey: parsed.publicKey, privateKey: parsed.privateKey };
      }
    }
  } catch {
    // Foreign or unreadable legacy fallback records must not prevent first use.
  }

  return loadOrCreateDeviceKey(store, scopedName);
}
