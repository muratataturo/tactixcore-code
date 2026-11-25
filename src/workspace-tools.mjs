import { lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { basename, join, relative, resolve, sep } from 'node:path';
import { Type } from 'typebox';
import { createEditToolDefinition, createReadToolDefinition, createWriteToolDefinition } from '@earendil-works/pi-coding-agent';

const privateName = /^(?:\.(?!github$|gitignore$|editorconfig$)|node_modules$|auth\.json$|credentials\.json$|artifacts$|data$|temp$)|\.(?:pem|key|p12|pfx|mp4|mov|zip|tgz|sqlite|db)$/i;
const credential = /sk-or-v1-[A-Za-z0-9_-]{20,}|-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----|"type"\s*:\s*"service_account"/;
const maxFileSize = 256 * 1024;

export function workspaceTools(directory, envFile) {
  const root = realpathSync(directory);
  const secret = envFile ? realpathSync(envFile) : null;

  function check(path, { directoryOnly = false, create = false } = {}) {
    const full = resolve(root, path);
    const rel = relative(root, full);
    if (rel === '..' || rel.startsWith('..' + sep)) throw new Error('Path is outside the coding workspace.');
    if (!rel && !directoryOnly) throw new Error('A workspace file is required.');
    let cursor = root;
    const parts = rel ? rel.split(sep) : [];
    for (const [index, part] of parts.entries()) {
      if (privateName.test(part)) throw new Error('Path is protected.');
      cursor = join(cursor, part);
      if (cursor === secret) throw new Error('Path is protected.');
      const info = lstatSync(cursor, { throwIfNoEntry: false });
      if (!info && create) continue;
      if (!info || info.isSymbolicLink()) throw new Error('File is unavailable or is a symbolic link.');
      const leaf = index === parts.length - 1;
      if (!leaf || directoryOnly) {
        if (!info.isDirectory()) throw new Error('A workspace directory is required.');
      } else {
        if (!info.isFile() || info.nlink !== 1 || info.size > maxFileSize) throw new Error('File is outside the allowed type or size.');
        const data = readFileSync(cursor);
        if (data.includes(0) || credential.test(data.toString('utf8'))) throw new Error('File is binary or contains protected credentials.');
      }
    }
    return full;
  }

  const fileTools = [
    [createReadToolDefinition(root), 'workspace_read'],
    [createEditToolDefinition(root), 'workspace_edit'],
    [createWriteToolDefinition(root), 'workspace_write']
  ].map(([tool, name]) => ({
    ...tool, name,
    async execute(id, params, signal, update, context) {
      const path = check(params.path, { create: name === 'workspace_write' });
      const content = params.content ?? params.edits?.map(edit => edit.newText).join('\n') ?? '';
      if (Buffer.byteLength(content) > maxFileSize || credential.test(content)) {
        throw new Error('Content is too large or contains protected credentials.');
      }
      return tool.execute(id, { ...params, path }, signal, update, context);
    }
  }));
  return [...fileTools, {
    name: 'workspace_list', label: 'List workspace directory',
    description: 'List visible entries in a directory inside the coding workspace.',
    parameters: Type.Object({ path: Type.Optional(Type.String()) }, { additionalProperties: false }),
    async execute(_id, { path }) {
      const directory = check(path ?? '.', { directoryOnly: true });
      const names = readdirSync(directory, { withFileTypes: true })
        .filter(entry => !entry.isSymbolicLink() && !privateName.test(entry.name)
          && !(directory === (secret && resolve(secret, '..')) && entry.name === basename(secret)))
        .map(entry => entry.name + (entry.isDirectory() ? '/' : '')).sort().slice(0, 200);
      return { content: [{ type: 'text', text: JSON.stringify(names) }], details: {} };
    }
  }];
}
