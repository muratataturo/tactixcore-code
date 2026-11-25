import { spawnSync } from 'node:child_process';

function git(args) {
  const result = spawnSync('git', args, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  if (result.error || result.signal || result.status > 1 || (result.status === 1 && args[0] !== 'grep')) {
    throw new Error('Git index check failed');
  }
  return result.stdout;
}

const paths = git(['ls-files', '-z']).split('\0').filter(Boolean);
const forbiddenPaths = paths.filter(path => {
  const parts = path.toLowerCase().split('/');
  return parts.some(part => /^(?:\.env(?:\..*)?|\.pi|\.tactixcore|auth\.json|credentials\.json|artifacts|node_modules)$/.test(part))
    || /\.(?:pem|p12|key|tgz)$/i.test(path);
});
const tokenPattern = [
  'sk-' + 'or-v1-[a-zA-Z0-9_-]{20,}',
  '-----BEGIN (RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----',
  '"type"[[:space:]]*:[[:space:]]*"service_account"'
].join('|');
const matchedFiles = git(['grep', '--cached', '-I', '-l', '-z', '-E', '-e', tokenPattern, '--'])
  .split('\0').filter(Boolean);
if (forbiddenPaths.length || matchedFiles.length) {
  console.error(`Public tree check failed (${forbiddenPaths.length} restricted paths, ${matchedFiles.length} credential-pattern matches).`);
  process.exitCode = 1;
} else {
  console.log(`Public tree check passed (${paths.length} indexed paths).`);
}
