import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

function clean(value) {
  const trimmed = value?.trim();
  return trimmed || null;
}

function git(...args) {
  try {
    return clean(execFileSync('git', args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }));
  } catch {
    return null;
  }
}

const revision = clean(process.env.WORKERS_CI_COMMIT_SHA) ?? git('rev-parse', 'HEAD');
const branch = clean(process.env.WORKERS_CI_BRANCH) ?? git('rev-parse', '--abbrev-ref', 'HEAD');

if (!revision || !/^[0-9a-f]{40}$/i.test(revision)) {
  throw new Error('Cannot determine an immutable 40-character build revision');
}

const metadata = {
  revision: revision.toLowerCase(),
  branch: branch ?? 'unknown',
};

const directory = join('dist', '__yuzhi-build');
mkdirSync(directory, { recursive: true });
const serialized = JSON.stringify(metadata) + '\n';

// The stable marker is for diagnostics. The revision-addressed marker is the
// release proof: a stale deployment cannot satisfy a request for a commit path
// that was never part of that deployment.
writeFileSync(join(directory, 'revision.json'), serialized);
writeFileSync(join(directory, metadata.revision + '.json'), serialized);

console.log(`[build-revision] ${metadata.revision} (${metadata.branch})`);
