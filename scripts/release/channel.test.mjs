import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, chmodSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseVersion, validatePullRequest, validateMerge, writeMetadata, verifyArtifact, candidateRun, publish, downloadRelease } from './channel.mjs';

const repository = 'test/repository';
const initialCwd = process.cwd();
let directory, stable;
const originalPath = process.env.PATH;
const git = (...args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
function commit(version, code = 'initial') {
  writeFileSync('release.json', JSON.stringify({ version }));
  writeFileSync('code.txt', code);
  git('add', '.'); git('commit', '-qm', version);
  return git('rev-parse', 'HEAD');
}
function event(head, base = 'next', extra = {}) {
  return { pull_request: { title: 'Release candidate', body: 'Reviewed changes.', base: { ref: base, sha: stable }, head: { ref: 'feature/test', sha: head, repo: { full_name: repository } }, ...extra } };
}
beforeEach(() => {
  directory = realpathSync(mkdtempSync(join(tmpdir(), 'channel-test-'))); process.chdir(directory);
  git('init', '-q', '-b', 'main'); git('config', 'user.name', 'test'); git('config', 'user.email', 'test@example.invalid');
  stable = commit('1.0.0'); git('update-ref', 'refs/remotes/origin/main', stable);
  git('checkout', '-qb', 'next');
});
afterEach(() => { process.env.PATH = originalPath; process.chdir(initialCwd); rmSync(directory, { recursive: true, force: true }); });

test('feature prerelease advances stable', () => validatePullRequest(event(commit('1.1.0-beta.1', 'feature')), repository));
test('stable and older prereleases cannot masquerade as the next version', () => {
  assert.throws(() => validatePullRequest(event(commit('1.0.0-beta.1')), repository), /advance/);
});
test('main rejects a feature branch and a fork named next', () => {
  const head = commit('1.1.0');
  assert.throws(() => validatePullRequest(event(head, 'main'), repository), /same-repository/);
  const e = event(head, 'main'); e.pull_request.head.ref = 'next'; e.pull_request.head.repo.full_name = 'fork/repository';
  assert.throws(() => validatePullRequest(e, repository), /same-repository/);
});
test('main rejects a prerelease', () => {
  const e = event(commit('1.1.0-beta.1'), 'main'); e.pull_request.head.ref = 'next';
  assert.throws(() => validatePullRequest(e, repository), /bare stable/);
});
test('version-only stable cut passes', () => {
  const base = commit('1.1.0-beta.1', 'feature');
  const e = event(commit('1.1.0', 'feature')); e.pull_request.base.sha = base;
  validatePullRequest(e, repository);
});
test('stable cut rejects hidden code and manifest changes', () => {
  const base = commit('1.1.0-beta.1');
  const e = event(commit('1.1.0', 'hidden feature')); e.pull_request.base.sha = base;
  assert.throws(() => validatePullRequest(e, repository), /only release version/);
});
test('stable cut cannot change target release', () => {
  const base = commit('1.1.0-beta.1');
  const e = event(commit('2.0.0')); e.pull_request.base.sha = base;
  assert.throws(() => validatePullRequest(e, repository), /current prerelease/);
});
test('development after release needs a new prerelease', () => {
  const base = commit('1.1.0'); git('update-ref', 'refs/remotes/origin/main', base);
  assert.throws(() => validatePullRequest(event(commit('1.1.0', 'feature')), repository), /advance/);
  validatePullRequest(event(commit('1.2.0-beta.1', 'feature')), repository);
});
function promotion() {
  const head = commit('1.1.0', 'feature');
  git('checkout', '-q', 'main'); git('merge', '--no-ff', '-qm', 'release', 'next');
  const merge = git('rev-parse', 'HEAD'); git('update-ref', 'refs/remotes/origin/main', merge);
  const e = event(head, 'main', { merged: true, merge_commit_sha: merge }); e.pull_request.head.ref = 'next';
  return e;
}
test('merged promotion preserves next ancestry and tree after main advances', () => {
  assert.equal(validateMerge(promotion(), repository), '1.1.0');
});
test('squash promotion is refused', () => {
  const head = commit('1.1.0'); git('checkout', '-q', 'main'); git('merge', '--squash', 'next'); git('commit', '-qm', 'squash');
  const e = event(head, 'main', { merged: true, merge_commit_sha: git('rev-parse', 'HEAD') }); e.pull_request.head.ref = 'next';
  assert.throws(() => validateMerge(e, repository), /merge commit/);
});
test('merge resolution cannot alter the tested tree', () => {
  const e = promotion(); writeFileSync('unexpected.txt', 'change'); git('add', '.'); git('commit', '--amend', '--no-edit', '-q');
  e.pull_request.merge_commit_sha = git('rev-parse', 'HEAD'); git('update-ref', 'refs/remotes/origin/main', e.pull_request.merge_commit_sha);
  assert.throws(() => validateMerge(e, repository), /tested next tree/);
});
test('metadata binds source, tree, version, repository and payload bytes', () => {
  const e = promotion(); git('checkout', '-q', e.pull_request.head.sha);
  mkdirSync('release'); writeFileSync('release/source.tar.gz', 'payload');
  writeMetadata('release', { GITHUB_REPOSITORY: repository, GITHUB_RUN_ID: '1', GITHUB_RUN_ATTEMPT: '1' });
  verifyArtifact('release', e, repository);
  assert.throws(() => verifyArtifact('release', e, 'other/repo'), /does not match/);
  writeFileSync('release/source.tar.gz', 'tampered');
  assert.throws(() => verifyArtifact('release', e, repository), /checksum/);
});
test('package lock identity must match the package manifest', () => {
  rmSync('release.json');
  writeFileSync('package.json', JSON.stringify({ version: '1.1.0-beta.1' }));
  writeFileSync('package-lock.json', JSON.stringify({ version: '1.1.0-beta.1', packages: { '': { version: '1.0.0' } } }));
  git('add', '.'); git('commit', '-qm', 'package');
  assert.throws(() => validatePullRequest(event(git('rev-parse', 'HEAD')), repository), /versions differ/);
});
test('SemVer rejects path and output injection and leading zeroes', () => {
  for (const value of ['1.0.0\noutput=bad', '../escape', '01.0.0', '1.0.0-01', '1.0.0-', '1.0.0-beta..1']) assert.throws(() => parseVersion(value));
  for (const value of ['0.1.0-beta.1', '1.0.0', '1.0.0-alpha-beta', '1.0.0-0']) assert.equal(parseVersion(value).value, value);
});

function fakeGh(responses) {
  mkdirSync('bin');
  writeFileSync('responses.json', JSON.stringify(responses));
  writeFileSync('bin/gh', `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2).join(' ');
fs.appendFileSync('gh-calls.log', args + '\\n');
const response = JSON.parse(fs.readFileSync('responses.json', 'utf8'))[args];
if (response === undefined) { console.error('Unmocked gh command: ' + args); process.exit(1); }
process.stdout.write(response.__raw === undefined ? JSON.stringify(response) : response.__raw);
`);
  chmodSync('bin/gh', 0o755); process.env.PATH = `${join(directory, 'bin')}:${originalPath}`;
}
test('candidate lookup refuses failed, unrelated and expired next builds', () => {
  const head = commit('1.1.0');
  const e = event(head, 'main');
  const command = `api --method GET repos/${repository}/actions/workflows/ci.yml/runs -f branch=next -f event=push -f head_sha=${head} -f status=success -f per_page=100`;
  fakeGh({
    [command]: { workflow_runs: [
      { id: 1, head_sha: 'other', head_branch: 'next', event: 'push', conclusion: 'success' },
      { id: 2, head_sha: head, head_branch: 'next', event: 'push', conclusion: 'failure' },
      { id: 3, head_sha: head, head_branch: 'next', event: 'push', conclusion: 'success' },
    ] },
    [`api repos/${repository}/actions/runs/3/artifacts`]: { artifacts: [{ id: 30, name: `candidate-${head}`, expired: true }] },
  });
  assert.throws(() => candidateRun(e, repository, 'ci.yml'), /No successful next build/);
  const responses = JSON.parse(readFileSync('responses.json'));
  responses[`api repos/${repository}/actions/runs/3/artifacts`].artifacts[0].expired = false;
  writeFileSync('responses.json', JSON.stringify(responses));
  assert.deepEqual(candidateRun(e, repository, 'ci.yml'), { run_id: '3', artifact_id: '30' });
});
test('stable publication refuses to move an existing version tag', () => {
  const e = promotion(); mkdirSync('release');
  fakeGh({ [`api --method GET repos/${repository}/git/matching-refs/tags/v1.1.0`]: [{ ref: 'refs/tags/v1.1.0', object: { type: 'commit', sha: stable } }] });
  assert.throws(() => publish(e, repository, 'release'), /another commit/);
});
test('re-running a published release never creates or edits it', () => {
  const e = promotion(); mkdirSync('release');
  fakeGh({
    [`api --method GET repos/${repository}/git/matching-refs/tags/v1.1.0`]: [{ ref: 'refs/tags/v1.1.0', object: { type: 'commit', sha: e.pull_request.merge_commit_sha } }],
    [`api --paginate --slurp repos/${repository}/releases?per_page=100`]: [[{ tag_name: 'v1.1.0', draft: false, prerelease: false, assets: [] }]],
  });
  assert.equal(publish(e, repository, 'release'), 'v1.1.0');
  assert.doesNotMatch(readFileSync('gh-calls.log', 'utf8'), /release (create|edit|upload)/);
});
test('workspace bootstraps versioning when main predates release.json', () => {
  git('checkout', '-q', 'main'); git('rm', 'release.json'); git('commit', '-qm', 'pre-versioning');
  git('update-ref', 'refs/remotes/origin/main', 'HEAD'); git('checkout', '-qb', 'bootstrap');
  validatePullRequest(event(commit('0.1.0-beta.1')), repository);
});
test('a new stable release is uploaded as a draft before publication', () => {
  const e = promotion(); mkdirSync('release'); writeFileSync('release/source.tar.gz', 'payload');
  const notes = join(directory, 'release/release-notes.md');
  fakeGh({
    [`api --method GET repos/${repository}/git/matching-refs/tags/v1.1.0`]: [],
    [`api --paginate --slurp repos/${repository}/releases?per_page=100`]: [[]],
    [`release create v1.1.0 --repo ${repository} --target ${e.pull_request.merge_commit_sha} --title v1.1.0 --notes-file ${notes} --draft`]: '',
    [`api repos/${repository}/releases/tags/v1.1.0`]: { target_commitish: e.pull_request.merge_commit_sha, draft: true, assets: [] },
    [`release upload v1.1.0 ${join(directory, 'release/source.tar.gz')} --repo ${repository}`]: '',
    [`release edit v1.1.0 --repo ${repository} --draft=false --latest=true`]: '',
  });
  assert.equal(publish(e, repository, 'release'), 'v1.1.0');
  const calls = readFileSync('gh-calls.log', 'utf8');
  assert.ok(calls.indexOf('release upload') < calls.indexOf('release edit'));
});
test('publication refuses to replace an existing asset with different bytes', () => {
  const e = promotion(); mkdirSync('release'); writeFileSync('release/source.tar.gz', 'new payload');
  fakeGh({
    [`api --method GET repos/${repository}/git/matching-refs/tags/v1.1.0`]: [{ ref: 'refs/tags/v1.1.0', object: { type: 'commit', sha: e.pull_request.merge_commit_sha } }],
    [`api --paginate --slurp repos/${repository}/releases?per_page=100`]: [[{ tag_name: 'v1.1.0', draft: false, assets: [{ id: 1, name: 'source.tar.gz' }] }]],
    [`api -H Accept: application/octet-stream repos/${repository}/releases/assets/1`]: { __raw: 'old payload' },
  });
  assert.throws(() => publish(e, repository, 'release'), /Published asset differs/);
  assert.doesNotMatch(readFileSync('gh-calls.log', 'utf8'), /release (edit|upload)/);
});
test('rollback rejects arbitrary refs and unpublished candidates before download', () => {
  for (const tag of ['main', 'next', '--clobber', 'v1.0.0-beta.1', 'v01.0.0']) assert.throws(() => downloadRelease(tag, repository, 'release'), /stable vX.Y.Z/);
  fakeGh({ [`api repos/${repository}/releases/tags/v1.0.0`]: { draft: true, prerelease: false } });
  assert.throws(() => downloadRelease('v1.0.0', repository, 'release'), /published stable/);
});
test('pre-push hook blocks both channels and permits feature and tag pushes', () => {
  const hook = join(initialCwd, '.githooks/pre-push');
  for (const branch of ['main', 'next']) {
    assert.throws(() => execFileSync('sh', [hook], { input: `refs/heads/feature 123 refs/heads/${branch} 456\n`, stdio: ['pipe', 'pipe', 'pipe'] }));
  }
  for (const ref of ['refs/heads/codex/feature', 'refs/tags/v1.0.0']) {
    execFileSync('sh', [hook], { input: `refs/heads/feature 123 ${ref} 456\n`, stdio: ['pipe', 'pipe', 'pipe'] });
  }
});
