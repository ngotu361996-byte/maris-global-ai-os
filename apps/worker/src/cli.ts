#!/usr/bin/env node
import { HEARTBEAT_INTERVAL_SEC, PAIRING_PREFIX } from '@maris/contracts';
import { heartbeat, pair, ServerError } from './client';
import { configPath, loadConfig, normalizeServer, saveConfig } from './config';
import { capabilities, JobRunner } from './jobs';
import { dockerAvailable, prepareImages } from './sandbox';
import { AGENT_VERSION, collectInfo, Sampler } from './metrics';

const HELP = `MARIS Worker ${AGENT_VERSION}

  pair "<chuỗi ghép nối>" --server <địa chỉ MARIS>   Ghép nối máy này (chuỗi dùng được một lần)
  run                                                Chạy, báo cáo tài nguyên mỗi ${HEARTBEAT_INTERVAL_SEC} giây và nhận việc
  run --monitor-only                                 Chỉ báo cáo tài nguyên, không nhận việc
  run --allow-code                                   Nhận cả việc chạy mã trong sandbox Docker
                                                     (chỉ trên máy Code Runner, cần Docker đang chạy)
  status                                             Xem máy này đã ghép nối với đâu

Worker chỉ kết nối ra máy chủ MARIS. Nó không mở cổng và không chạy lệnh nào từ máy chủ:
nó chỉ làm các loại việc có sẵn trong chương trình (kiểm tra máy, AI cục bộ qua Ollama, xử lý ảnh,
việc thử). Việc xử lý ảnh chỉ tải được đúng ảnh và logo của việc đó, khi máy này đang làm việc đó.
Mã chỉ chạy khi chủ máy thêm --allow-code, và luôn chạy trong container Docker không mạng,
không ghi được đĩa của máy, giới hạn RAM, CPU và thời gian.`;

const time = () => new Date().toLocaleTimeString();
const say = (msg: string) => console.log(`[${time()}] ${msg}`);

function option(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

async function cmdPair(args: string[]): Promise<void> {
  const pairing = args.find((a) => a.startsWith(`${PAIRING_PREFIX}.`));
  const serverArg = option(args, '--server');
  if (!pairing || !serverArg)
    throw new Error('Cần chuỗi ghép nối và --server. Xem: maris-worker help');
  const server = normalizeServer(serverArg, args.includes('--insecure'));
  const r = await pair(server, pairing, await collectInfo());
  await saveConfig({
    server,
    tenantId: r.tenantId,
    deviceId: r.deviceId,
    name: r.name,
    token: r.token,
  });
  say(`Đã ghép nối "${r.name}". Khóa thiết bị lưu ở ${configPath()}`);
  say('Chạy tiếp lệnh: run');
}

async function cmdStatus(): Promise<void> {
  const c = await loadConfig();
  if (!c) return say('Máy này chưa ghép nối.');
  say(`Thiết bị "${c.name}" (${c.deviceId}) tại ${c.server}`);
}

async function cmdRun(args: string[]): Promise<void> {
  const c = await loadConfig();
  if (!c) throw new Error('Máy này chưa ghép nối. Chạy lệnh pair trước.');
  const sampler = new Sampler();
  const jobsOn = !args.includes('--monitor-only');
  const allowCode = jobsOn && args.includes('--allow-code');
  if (allowCode) {
    if (await dockerAvailable()) {
      const failed = await prepareImages(say);
      if (failed.length > 0) say(`Chưa tải được ảnh sandbox: ${failed.join(', ')}`);
    } else
      say('Có --allow-code nhưng Docker chưa chạy: chưa nhận việc chạy mã. Mở Docker Desktop.');
  }
  const runner = jobsOn ? new JobRunner(c.server, c.token, say) : null;
  let caps = jobsOn ? await capabilities({ allowCode }) : [];
  let capsCheckedAt = Date.now();
  let intervalSec = HEARTBEAT_INTERVAL_SEC;
  let failures = 0;
  let lastStatus = '';
  let stopping = false;
  let timer: NodeJS.Timeout | undefined;
  let wake: () => void = () => {};
  const stop = () => {
    stopping = true;
    say('Đang dừng Worker.');
    clearTimeout(timer);
    runner?.stop();
    wake();
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  say(`Worker "${c.name}" kết nối tới ${c.server}`);
  say(
    jobsOn ? `Nhận các loại việc: ${caps.join(', ')}` : 'Chỉ báo cáo tài nguyên, không nhận việc.',
  );
  let runnerStarted = false;

  while (!stopping) {
    let wait = intervalSec;
    try {
      if (jobsOn && Date.now() - capsCheckedAt > 5 * 60_000) {
        const next = await capabilities({ allowCode });
        if (next.join() !== caps.join()) say(`Nhận các loại việc: ${next.join(', ')}`);
        caps = next;
        capsCheckedAt = Date.now();
      }
      const r = await heartbeat(c.server, c.token, {
        ...(await sampler.sample()),
        capabilities: caps,
      });
      if (runner && !runnerStarted) {
        runner.start();
        runnerStarted = true;
      }
      intervalSec = Math.min(300, Math.max(5, r.heartbeatSec));
      wait = intervalSec;
      if (failures > 0) say('Đã kết nối lại.');
      failures = 0;
      if (r.status !== lastStatus) {
        say(r.status === 'paused' ? 'Thiết bị đang tạm dừng trên MARIS.' : 'Đang hoạt động.');
        lastStatus = r.status;
      }
    } catch (e) {
      if (e instanceof ServerError && e.status === 401) {
        say(
          'Khóa thiết bị đã bị thu hồi hoặc không đúng. Tạo chuỗi ghép nối mới trên trang Hạ tầng.',
        );
        process.exitCode = 2;
        runner?.stop();
        return;
      }
      failures++;
      wait = Math.min(60, intervalSec * 2 ** Math.min(failures - 1, 2));
      say(`Không gửi được báo cáo (${(e as Error).message}). Thử lại sau ${wait} giây.`);
    }
    await new Promise<void>((resolve) => {
      wake = resolve;
      timer = setTimeout(resolve, wait * 1000);
    });
  }
}

async function main(): Promise<void> {
  const [cmd, ...args] = process.argv.slice(2);
  if (cmd === 'pair') return cmdPair(args);
  if (cmd === 'run') return cmdRun(args);
  if (cmd === 'status') return cmdStatus();
  console.log(HELP);
}

main().catch((e: unknown) => {
  console.error(`Lỗi: ${(e as Error).message}`);
  process.exitCode = 1;
});
