import fs from 'node:fs/promises';
import path from 'node:path';

async function ensureSecureDir(dirPath) {
  await fs.mkdir(dirPath, { recursive: true, mode: 0o700 });
  try {
    await fs.chmod(dirPath, 0o700);
  } catch {}
}

async function writeAtomic(filePath, content) {
  const dir = path.dirname(filePath);
  const base = path.basename(filePath);
  const tmpPath = path.join(dir, `.${base}.tmp.${process.pid}.${Date.now()}`);

  // Atomic rename reduces the risk of store corruption on crash/power loss.
  await fs.writeFile(tmpPath, content, { mode: 0o600 });
  await fs.rename(tmpPath, filePath);

  try {
    await fs.chmod(filePath, 0o600);
  } catch {}
}

async function readJson(filePath) {
  const raw = await fs.readFile(filePath, 'utf8');
  const parsed = JSON.parse(raw);
  return parsed && typeof parsed === 'object' ? parsed : null;
}

export { ensureSecureDir, readJson, writeAtomic };
