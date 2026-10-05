import { mkdir, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
await mkdir('secrets', { recursive: true, mode: 0o700 });
try {
  await writeFile('secrets/host_key.txt', randomBytes(32).toString('base64url') + '\n', { flag: 'wx', mode: 0o600 });
  console.log('Created secrets/host_key.txt. Enter its contents in the host form. Keep this file private.');
} catch (error) {
  if (error.code !== 'EEXIST') throw error;
  console.log('secrets/host_key.txt already exists; kept the existing key.');
}
