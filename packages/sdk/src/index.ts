import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  verify,
} from 'node:crypto';
import {
  canonicalJson,
  MARIS_VERSION,
  PLUGIN_FORMAT,
  PLUGIN_SIGNATURE_PREFIX,
  pluginManifestSchema,
  requiredPluginPermissions,
  satisfiesRange,
  type PluginManifest,
  type PluginManifestInput,
} from '@maris/contracts';

export { MARIS_VERSION, PLUGIN_FORMAT };
export type { PluginManifest, PluginManifestInput };

export class PluginFileError extends Error {
  constructor(
    readonly code:
      | 'PLUGIN_INVALID'
      | 'PLUGIN_CHECKSUM_MISMATCH'
      | 'PLUGIN_SIGNATURE_INVALID'
      | 'PLUGIN_KEY_INVALID',
    message: string,
  ) {
    super(message);
  }
}

/** Checks a plugin file's fields. Returns the manifest with defaults filled in. */
export function parsePlugin(input: unknown): PluginManifest {
  const r = pluginManifestSchema.safeParse(input);
  if (!r.success) {
    const msg = r.error.issues
      .slice(0, 5)
      .map((i) => `${i.path.join('.') || 'tệp'}: ${i.message}`)
      .join('; ');
    throw new PluginFileError('PLUGIN_INVALID', `Tệp Plugin không hợp lệ: ${msg}`);
  }
  return r.data;
}

/**
 * SHA-256 of the manifest as canonical JSON (keys sorted), without its checksum and signature.
 * The manifest is parsed first, so a field left at its default gives the same checksum as one
 * written out.
 */
export function pluginChecksum(manifest: PluginManifest): string {
  const { checksum: _c, signature: _s, ...rest } = manifest;
  return createHash('sha256').update(canonicalJson(rest)).digest('hex');
}

/** Fills in defaults and the checksum, and drops any old signature. */
export function definePlugin(input: PluginManifestInput): PluginManifest {
  const m = parsePlugin({ ...input, checksum: undefined, signature: undefined });
  return { ...m, checksum: pluginChecksum(m) };
}

/** Throws when the file's checksum is not the checksum of its content. */
export function assertChecksum(m: PluginManifest): string {
  const sum = pluginChecksum(m);
  if (m.checksum && m.checksum !== sum)
    throw new PluginFileError(
      'PLUGIN_CHECKSUM_MISMATCH',
      'Tệp Plugin đã bị sửa sau khi đóng gói (checksum không khớp)',
    );
  return sum;
}

/** A new Ed25519 key pair for a publisher, as PEM. Keep the private key out of any repository. */
export function generatePublisherKeys(): { publicKey: string; privateKey: string } {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  return { publicKey: publicKey.trim(), privateKey: privateKey.trim() };
}

/** First 16 hex characters of the SHA-256 of a public key, to compare it by eye. */
export function keyFingerprint(publicKeyPem: string): string {
  const der = publicKeyObject(publicKeyPem).export({ type: 'spki', format: 'der' });
  return createHash('sha256').update(der).digest('hex').slice(0, 16);
}

/** Signs a plugin: sets the checksum and an Ed25519 signature of it. */
export function signPlugin(
  input: PluginManifestInput,
  privateKeyPem: string,
  keyId: string,
): PluginManifest {
  const m = definePlugin(input);
  let key;
  try {
    key = createPrivateKey(privateKeyPem);
  } catch {
    throw new PluginFileError('PLUGIN_KEY_INVALID', 'Khóa riêng không đọc được (cần PEM Ed25519)');
  }
  if (key.asymmetricKeyType !== 'ed25519')
    throw new PluginFileError('PLUGIN_KEY_INVALID', 'Khóa riêng phải là Ed25519');
  const value = sign(null, Buffer.from(PLUGIN_SIGNATURE_PREFIX + m.checksum!), key).toString(
    'base64',
  );
  return { ...m, signature: { alg: 'ed25519', keyId, value } };
}

/** Whether the signature on a manifest was made by this public key over this content. */
export function verifyPluginSignature(m: PluginManifest, publicKeyPem: string): boolean {
  if (!m.signature) return false;
  const sum = pluginChecksum(m);
  try {
    return verify(
      null,
      Buffer.from(PLUGIN_SIGNATURE_PREFIX + sum),
      publicKeyObject(publicKeyPem),
      Buffer.from(m.signature.value, 'base64'),
    );
  } catch {
    return false;
  }
}

/** Throws unless the text is an Ed25519 public key in PEM. */
export function assertPublicKey(publicKeyPem: string): void {
  publicKeyObject(publicKeyPem);
}

function publicKeyObject(pem: string) {
  let key;
  try {
    key = createPublicKey(pem);
  } catch {
    throw new PluginFileError('PLUGIN_KEY_INVALID', 'Khóa công khai không đọc được (cần PEM)');
  }
  if (key.asymmetricKeyType !== 'ed25519')
    throw new PluginFileError('PLUGIN_KEY_INVALID', 'Khóa công khai phải là Ed25519');
  return key;
}

export interface PluginReport {
  key: string;
  version: string;
  checksum: string;
  signed: boolean;
  compatible: boolean;
  permissions: string[];
  parts: { skills: number; connectors: number; workflows: number };
  tests: number;
}

/**
 * What `maris-ext check` prints: the file's fields, checksum and compatibility. The tests in the
 * file run on the MARIS server when the plugin is installed and again when it is activated.
 */
export function checkPlugin(input: unknown): PluginReport {
  const m = parsePlugin(input);
  const checksum = assertChecksum(m);
  return {
    key: m.key,
    version: m.version,
    checksum,
    signed: !!m.signature,
    compatible: satisfiesRange(MARIS_VERSION, m.compatibility.maris),
    permissions: requiredPluginPermissions(m.contents),
    parts: {
      skills: m.contents.skills.length,
      connectors: m.contents.connectors.length,
      workflows: m.contents.workflows.length,
    },
    tests: m.tests.length,
  };
}
