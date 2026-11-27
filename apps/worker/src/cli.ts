#!/usr/bin/env node
import { HEARTBEAT_INTERVAL_SEC, PAIRING_PREFIX } from '@maris/contracts';
import { heartbeat, pair, ServerError } from './client';
import { configPath, loadConfig, normalizeServer, saveConfig } from './config';
import { AGENT_VERSION, collectInfo, Sampler } from './metrics';

const HELP = `MARIS Worker ${AGENT_VERSION}

  pair "<chuỗi ghép nối>" --server <địa chỉ MARIS>   Ghép nối máy này (chuỗi dùng được một lần)
  run                                                Chạy và báo cáo tài nguyên mỗi ${HEARTBEAT_INTERVAL_SEC} giây
  status                                             Xem máy này đã ghép nối với đâu

Worker chỉ kết nối ra máy chủ MARIS. Nó không mở cổng và không chạy lệnh nào từ máy chủ.`;

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

async function cmdRun(): Promise<void> {
  const c = await loadConfig();
  if (!c) throw new Error('Máy này chưa ghép nối. Chạy lệnh pair trước.');
  const sampler = new Sampler();
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
    wake();
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  say(`Worker "${c.name}" kết nối tới ${c.server}`);

  while (!stopping) {
    let wait = intervalSec;
    try {
      const r = await heartbeat(c.server, c.token, await sampler.sample());
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
  if (cmd === 'run') return cmdRun();
  if (cmd === 'status') return cmdStatus();
  console.log(HELP);
}

main().catch((e: unknown) => {
  console.error(`Lỗi: ${(e as Error).message}`);
  process.exitCode = 1;
});
