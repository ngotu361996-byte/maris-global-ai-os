import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, type ReadStream } from 'node:fs';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import type { Readable } from 'node:stream';
import { dirname, join, resolve, sep } from 'node:path';

/** Where file bytes live. Local disk now; S3/MinIO can implement the same interface later. */
export interface FileStorage {
  put(key: string, data: Buffer): Promise<void>;
  get(key: string): Promise<Buffer>;
  remove(key: string): Promise<void>;
}

/** Keys are built by MARIS from UUIDs; anything else is refused so a key can never leave the folder. */
const KEY = /^[0-9a-f-]{36}\/[0-9a-f-]{36}$/;

/** Bytes kept from the start of an upload for type detection. */
const HEAD_BYTES = 64 * 1024;

export class FileTooLargeError extends Error {}

export interface StagedFile {
  size: number;
  sha256: string;
  /** The first bytes, for detecting the type. */
  head: Buffer;
  commit(): Promise<void>;
  discard(): Promise<void>;
}

export class LocalFileStorage implements FileStorage {
  private readonly root: string;

  constructor(dir: string) {
    this.root = resolve(dir);
  }

  async put(key: string, data: Buffer): Promise<void> {
    const path = this.path(key);
    await mkdir(dirname(path), { recursive: true });
    // Write to a temporary name first so a crash never leaves half a file under the real name.
    const tmp = `${path}.tmp`;
    await writeFile(tmp, data, { flag: 'wx' });
    await rename(tmp, path);
  }

  async get(key: string): Promise<Buffer> {
    return readFile(this.path(key));
  }

  /**
   * Streams a body to a temporary file, hashing it and stopping at maxBytes. Nothing is stored under
   * the key until commit(), so the caller can check the type and look for duplicates first.
   */
  async putStream(key: string, body: Readable, maxBytes: number): Promise<StagedFile> {
    const path = this.path(key);
    await mkdir(dirname(path), { recursive: true });
    const tmp = `${path}.tmp`;
    const out = createWriteStream(tmp, { flags: 'wx' });
    const hash = createHash('sha256');
    const head: Buffer[] = [];
    let headSize = 0;
    let size = 0;
    let tooLarge = false;
    try {
      for await (const chunk of body) {
        const buf = chunk as Buffer;
        size += buf.length;
        if (size > maxBytes) {
          tooLarge = true;
          break;
        }
        hash.update(buf);
        if (headSize < HEAD_BYTES) {
          head.push(buf);
          headSize += buf.length;
        }
        if (!out.write(buf)) await new Promise<void>((r) => out.once('drain', () => r()));
      }
    } finally {
      await new Promise<void>((resolve, reject) => out.end((e?: Error | null) => (e ? reject(e) : resolve())));
    }
    if (tooLarge) {
      body.destroy();
      await rm(tmp, { force: true });
      throw new FileTooLargeError();
    }
    return {
      size,
      sha256: hash.digest('hex'),
      head: Buffer.concat(head).subarray(0, HEAD_BYTES),
      commit: () => rename(tmp, path),
      discard: () => rm(tmp, { force: true }),
    };
  }

  /** A stream of a stored file and its size. */
  async open(key: string): Promise<{ stream: ReadStream; size: number }> {
    const path = this.path(key);
    const { size } = await stat(path);
    return { stream: createReadStream(path), size };
  }

  async remove(key: string): Promise<void> {
    await rm(this.path(key), { force: true });
  }

  private path(key: string): string {
    if (!KEY.test(key)) throw new Error('invalid storage key');
    const path = join(this.root, key);
    if (!path.startsWith(this.root + sep)) throw new Error('invalid storage key');
    return path;
  }
}
