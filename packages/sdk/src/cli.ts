#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import {
  checkPlugin,
  definePlugin,
  generatePublisherKeys,
  keyFingerprint,
  parsePlugin,
  PluginFileError,
  signPlugin,
  verifyPluginSignature,
} from './index';

const HELP = `maris-ext: công cụ đóng gói Plugin cho MARIS

  maris-ext keygen <tên-tệp>                 Tạo cặp khóa Ed25519: <tên-tệp>.key (riêng) và <tên-tệp>.pub
  maris-ext pack <plugin.json> [ra.json]     Điền mặc định và checksum
  maris-ext sign <plugin.json> <khóa.key> <mã-khóa> [ra.json]
                                             Đóng gói và ký bằng khóa riêng
  maris-ext verify <plugin.json> <khóa.pub>  Kiểm tra chữ ký bằng khóa công khai
  maris-ext check <plugin.json>              Kiểm tra trường, checksum và tương thích

Khóa riêng (.key) không bao giờ đưa vào kho mã hay gửi cho ai.`;

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    throw new Error(`Không đọc được ${path}: ${(e as Error).message}`);
  }
}

function write(path: string, value: unknown) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
  console.log(`Đã ghi ${path}`);
}

function main(argv: string[]): number {
  const [cmd, ...args] = argv;
  switch (cmd) {
    case 'keygen': {
      if (!args[0]) break;
      const { publicKey, privateKey } = generatePublisherKeys();
      writeFileSync(`${args[0]}.key`, `${privateKey}\n`, { mode: 0o600 });
      writeFileSync(`${args[0]}.pub`, `${publicKey}\n`);
      console.log(`Đã tạo ${args[0]}.key và ${args[0]}.pub (vân tay ${keyFingerprint(publicKey)})`);
      return 0;
    }
    case 'pack': {
      if (!args[0]) break;
      write(args[1] ?? args[0], definePlugin(readJson(args[0]) as never));
      return 0;
    }
    case 'sign': {
      if (!args[0] || !args[1] || !args[2]) break;
      const signed = signPlugin(readJson(args[0]) as never, readFileSync(args[1], 'utf8'), args[2]);
      write(args[3] ?? args[0], signed);
      return 0;
    }
    case 'verify': {
      if (!args[0] || !args[1]) break;
      const ok = verifyPluginSignature(
        parsePlugin(readJson(args[0])),
        readFileSync(args[1], 'utf8'),
      );
      console.log(ok ? 'Chữ ký hợp lệ' : 'Chữ ký KHÔNG hợp lệ hoặc tệp chưa ký');
      return ok ? 0 : 1;
    }
    case 'check': {
      if (!args[0]) break;
      const r = checkPlugin(readJson(args[0]));
      console.log(JSON.stringify(r, null, 2));
      if (!r.compatible) console.log('Cảnh báo: Plugin không tương thích phiên bản MARIS này');
      return r.compatible ? 0 : 1;
    }
  }
  console.log(HELP);
  return cmd ? 2 : 0;
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (e) {
  console.error(e instanceof PluginFileError ? e.message : (e as Error).message);
  process.exitCode = 1;
}
