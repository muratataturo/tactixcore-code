import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

export function profileDirectory(env) {
  const base = env.XDG_CONFIG_HOME && isAbsolute(env.XDG_CONFIG_HOME)
    ? env.XDG_CONFIG_HOME : join(env.HOME || homedir(), '.config');
  return join(base, 'tactixcore-code');
}

export function selectEnvFile(explicit, env, cwd = process.cwd()) {
  if (explicit !== undefined) return explicit;
  if (env.OPENROUTER_API_KEY) return undefined;
  const profile = join(profileDirectory(env), 'config.json');
  if (existsSync(profile)) {
    if (!statSync(profile).isFile() || statSync(profile).size > 8192) throw new Error('Invalid profile');
    const { schema, env_file } = JSON.parse(readFileSync(profile, 'utf8'));
    if (schema !== 1 || typeof env_file !== 'string' || !isAbsolute(env_file)) throw new Error('Invalid profile');
    return env_file;
  }
  const local = join(cwd, '.env');
  return existsSync(local) ? local : undefined;
}

export function saveEnvFile(env, path) {
  const directory = profileDirectory(env);
  mkdirSync(directory, { mode: 0o700, recursive: true });
  const staging = join(directory, 'config-' + randomUUID() + '.tmp');
  try {
    writeFileSync(staging, JSON.stringify({ schema: 1, env_file: resolve(path) }, null, 2) + '\n', {
      mode: 0o600, flag: 'wx'
    });
    renameSync(staging, join(directory, 'config.json'));
  } finally {
    rmSync(staging, { force: true });
  }
}
