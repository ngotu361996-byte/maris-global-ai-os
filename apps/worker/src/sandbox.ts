import { execFile, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { SANDBOX_LIMITS, type CodeLanguage, type CodeRunResult } from '@maris/contracts';

/**
 * The code sandbox (spec Part 26, Code Runner). Code from a job never touches this machine's shell
 * or files: it goes over stdin into a throw-away Docker container with no network, a read-only
 * file system (only an in-memory /tmp), no Linux capabilities, an unprivileged user, and limits on
 * memory, CPU and processes. The container is removed when the run ends and killed when the job
 * is cancelled or runs out of time.
 */

interface Runtime {
  image: string;
  /** A fixed start-up program (never the job's code) that reads the code, then runs it. */
  command: string[];
}

/**
 * Both start-up programs read "<byte length>\n<code>" from stdin and leave the rest of stdin to the
 * job's program, so the code and its input share one pipe and nothing goes on the command line.
 */
const PY_BOOT = [
  'import sys',
  'b=sys.stdin.buffer',
  'n=int(b.readline())',
  "src=b.read(n).decode('utf-8')",
  "sys.argv=['main.py']",
  "g={'__name__':'__main__','__file__':'main.py'}",
  'del b,n',
  "exec(compile(src,'main.py','exec'),g)",
].join('\n');

const NODE_BOOT = [
  "const fs=require('fs');",
  "let h='';const one=Buffer.alloc(1);",
  'while(fs.readSync(0,one,0,1)===1&&one[0]!==10)h+=String.fromCharCode(one[0]);',
  'const n=Number(h);const buf=Buffer.alloc(n);let o=0;',
  'while(o<n){const r=fs.readSync(0,buf,o,n-o);if(!r)break;o+=r}',
  "fs.writeFileSync('/tmp/main.js',buf);",
  "require('/tmp/main.js');",
].join('');

export const RUNTIMES: Record<CodeLanguage, Runtime> = {
  python: { image: 'python:3.12-alpine', command: ['python', '-I', '-c', PY_BOOT] },
  node: { image: 'node:22-alpine', command: ['node', '-e', NODE_BOOT] },
};

/** `docker run` arguments for one run. Exported for tests. */
export function sandboxArgs(name: string, language: CodeLanguage): string[] {
  const rt = RUNTIMES[language];
  return [
    'run',
    '--rm',
    '-i',
    '--name',
    name,
    '--network',
    'none',
    '--read-only',
    '--tmpfs',
    '/tmp:rw,nosuid,nodev,size=64m',
    '--memory',
    `${SANDBOX_LIMITS.memoryMb}m`,
    '--memory-swap',
    `${SANDBOX_LIMITS.memoryMb}m`,
    '--cpus',
    String(SANDBOX_LIMITS.cpus),
    '--pids-limit',
    String(SANDBOX_LIMITS.pids),
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    '--user',
    '65534:65534',
    '--workdir',
    '/tmp',
    '--env',
    'HOME=/tmp',
    '--log-driver',
    'none',
    rt.image,
    ...rt.command,
  ];
}

/** What goes into the container's stdin. Exported for tests. */
export function sandboxPayload(code: string, stdin: string): Buffer {
  const src = Buffer.from(code, 'utf8');
  return Buffer.concat([Buffer.from(`${src.length}\n`), src, Buffer.from(stdin, 'utf8')]);
}

/** Keeps the first `max` bytes of a stream and notes whether there was more. */
class Capped {
  private parts: Buffer[] = [];
  private size = 0;
  truncated = false;
  constructor(private readonly max: number) {}
  push(chunk: Buffer): void {
    const room = this.max - this.size;
    if (room <= 0) {
      this.truncated = true;
      return;
    }
    const part = chunk.length > room ? chunk.subarray(0, room) : chunk;
    if (part.length < chunk.length) this.truncated = true;
    this.parts.push(part);
    this.size += part.length;
  }
  text(): string {
    // A multi-byte character cut at the limit decodes as U+FFFD, which is fine for display.
    return Buffer.concat(this.parts).toString('utf8');
  }
}

const docker = (args: string[], timeoutMs: number) =>
  new Promise<{ ok: boolean; out: string }>((resolve) =>
    execFile('docker', args, { timeout: timeoutMs, windowsHide: true }, (err, out) =>
      resolve({ ok: !err, out: String(out).trim() }),
    ),
  );

/** Is Docker installed and its engine running? */
export async function dockerAvailable(): Promise<boolean> {
  const r = await docker(['version', '--format', '{{.Server.Version}}'], 10_000);
  return r.ok && r.out.length > 0;
}

/** Pulls the sandbox images ahead of the first job. Returns the ones that failed. */
export async function prepareImages(say: (msg: string) => void): Promise<string[]> {
  const failed: string[] = [];
  for (const rt of Object.values(RUNTIMES)) {
    if ((await docker(['image', 'inspect', rt.image], 15_000)).ok) continue;
    say(`Tải ảnh sandbox ${rt.image}…`);
    if (!(await docker(['pull', rt.image], 10 * 60_000)).ok) failed.push(rt.image);
  }
  return failed;
}

export interface SandboxOptions {
  signal: AbortSignal;
  /** Stop the program after this long and report a time-out. */
  timeoutMs: number;
}

export type SandboxOutcome = CodeRunResult & { cancelled: boolean };

/** Runs one program in a new container and returns what it printed and how it ended. */
export function runSandbox(
  input: { language: CodeLanguage; code: string; stdin: string },
  opts: SandboxOptions,
): Promise<SandboxOutcome> {
  const name = `maris-sandbox-${randomBytes(6).toString('hex')}`;
  const stdout = new Capped(SANDBOX_LIMITS.outputMaxBytes);
  const stderr = new Capped(SANDBOX_LIMITS.outputMaxBytes);
  const t0 = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawn('docker', sandboxArgs(name, input.language), {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let timedOut = false;
    let cancelled = false;
    let killed = false;
    const kill = () => {
      if (killed) return;
      killed = true;
      // Killing the docker client alone can leave the container running; kill it by name.
      void docker(['kill', name], 15_000).then(() => child.kill());
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, opts.timeoutMs);
    const onAbort = () => {
      cancelled = true;
      kill();
    };
    if (opts.signal.aborted) onAbort();
    else opts.signal.addEventListener('abort', onAbort, { once: true });

    child.stdout.on('data', (c: Buffer) => stdout.push(c));
    child.stderr.on('data', (c: Buffer) => stderr.push(c));
    child.stdin.on('error', () => {
      /* the program may exit before reading all of its input */
    });
    child.stdin.end(sandboxPayload(input.code, input.stdin));
    child.on('error', (e) => {
      clearTimeout(timer);
      opts.signal.removeEventListener('abort', onAbort);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      opts.signal.removeEventListener('abort', onAbort);
      resolve({
        language: input.language,
        exitCode: timedOut || cancelled ? null : code,
        timedOut,
        cancelled,
        durationMs: Date.now() - t0,
        stdout: stdout.text(),
        stderr: stderr.text(),
        stdoutTruncated: stdout.truncated,
        stderrTruncated: stderr.truncated,
      });
    });
  });
}
