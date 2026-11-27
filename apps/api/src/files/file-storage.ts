import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';

/** Where file bytes live. Local disk now; S3/MinIO can implement the same interface later. */
export interface FileStorage {
  put(key: string, data: Buffer): Promise<void>;
  get(key: string): Promise<Buffer>;
  remove(key: string): Promise<void>;
}

/** Keys are built by MARIS from UUIDs; anything else is refused so a key can never leave the folder. */
const KEY = /^[0-9a-f-]{36}\/[0-9a-f-]{36}$/;

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
