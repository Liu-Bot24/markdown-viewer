#!/usr/bin/env node
// Print a value for MDV_PASSWORD_HASH. The password is read from standard input so it
// never appears in a command line or shell history:
//   docker run --rm -i <image> node packages/web/src/server/hash-password.js
import readline from 'node:readline';
import { hashPassword, MIN_PASSWORD } from './auth.js';

const rl = readline.createInterface({ input: process.stdin, output: process.stderr, terminal: process.stdin.isTTY });
if (process.stdin.isTTY) process.stderr.write('密码：');
rl.once('line', (line) => {
  rl.close();
  const pw = line.replace(/\r$/, '');
  if (pw.length < MIN_PASSWORD) {
    process.stderr.write(`\n密码至少 ${MIN_PASSWORD} 个字符\n`);
    process.exit(1);
  }
  process.stdout.write((process.stdin.isTTY ? '\n' : '') + hashPassword(pw) + '\n');
});
