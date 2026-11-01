import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const fail = (message) => { throw new Error(message); };
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
const gh = (...args) => execFileSync('gh', args, { encoding: 'utf8' }).trim();
const json = (text) => JSON.parse(text);
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const versionFile = () => existsSync('release.json') ? 'release.json' : 'package.json';

export function parseVersion(value) {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?$/.exec(value);
  if (!match) fail(`Invalid release version: ${value}`);
  return { value, core: match.slice(1, 4).map(BigInt), prerelease: match[4] };
}

function versionAt(ref = 'HEAD') {
  const file = versionFile();
  const manifest = json(git('show', `${ref}:${file}`));
  const version = parseVersion(manifest.version);
  if (file === 'package.json' && git('ls-tree', '--name-only', ref, 'package-lock.json')) {
    const lock = json(git('show', `${ref}:package-lock.json`));
    if (lock.version !== version.value || lock.packages?.['']?.version !== version.value) {
      fail('package.json and package-lock.json release versions differ');
    }
  }
  return version;
}

function compareCore(a, b) {
  for (let i = 0; i < 3; i++) if (a.core[i] !== b.core[i]) return a.core[i] > b.core[i] ? 1 : -1;
  return 0;
}

function withoutVersion(text, file) {
  const value = json(text);
  delete value.version;
  if (file === 'package-lock.json' && value.packages?.['']) delete value.packages[''].version;
  return JSON.stringify(value);
}

export function validatePullRequest(event, repository, stableRef = 'origin/main') {
  const pr = event.pull_request;
  if (!pr || !['next', 'main'].includes(pr.base.ref)) fail('Expected a PR into next or main');
  const candidate = versionAt(pr.head.sha);
  const stable = versionFile() === 'release.json' && !git('ls-tree', '--name-only', stableRef, 'release.json')
    ? parseVersion('0.0.0') : versionAt(stableRef);
  if (compareCore(candidate, stable) < 0 || (compareCore(candidate, stable) === 0 && !stable.prerelease)) {
    fail('The next release must advance the stable version');
  }
  if (pr.base.ref === 'main') {
    if (pr.head.ref !== 'next' || pr.head.repo?.full_name !== repository) fail('main only accepts same-repository next -> main PRs');
    if (candidate.prerelease) fail('Cut the bare stable version on next before promotion');
    return;
  }
  if (candidate.prerelease) return;
  const previous = versionAt(pr.base.sha);
  if (!previous.prerelease || compareCore(candidate, previous) !== 0) fail('A stable release cut must remove the current prerelease suffix');
  const paths = git('diff', '--name-only', pr.base.sha, pr.head.sha).split('\n').filter(Boolean);
  const allowed = new Set([versionFile(), ...(versionFile() === 'package.json' ? ['package-lock.json'] : [])]);
  for (const file of paths) {
    if (!allowed.has(file) || withoutVersion(git('show', `${pr.base.sha}:${file}`), file) !== withoutVersion(git('show', `${pr.head.sha}:${file}`), file)) {
      fail('A stable release cut may change only release version fields');
    }
  }
}

export function validateMerge(event, repository) {
  const pr = event.pull_request;
  if (!pr?.merged) fail('Release requires a merged PR');
  if (pr.base.ref !== 'main') fail('Release requires next -> main');
  const merge = pr.merge_commit_sha;
  const parents = git('rev-list', '--parents', '-n', '1', merge).split(' ');
  if (parents.length !== 3 || parents[2] !== pr.head.sha) fail('Promotion must use Create a merge commit, preserving the exact next head');
  validatePullRequest(event, repository, parents[1]);
  git('merge-base', '--is-ancestor', merge, 'origin/main');
  if (git('rev-parse', `${merge}^{tree}`) !== git('rev-parse', `${pr.head.sha}^{tree}`)) fail('Promotion changed the tested next tree');
  return versionAt(merge).value;
}

export function writeMetadata(directory, env = process.env) {
  mkdirSync(directory, { recursive: true });
  const payloads = readdirSync(directory).filter((file) => file.endsWith('.tar.gz')).sort();
  if (!payloads.includes('source.tar.gz')) fail('Candidate requires source.tar.gz');
  const metadata = {
    schema: 'guild.release_candidate.v1', repository: env.GITHUB_REPOSITORY,
    source: git('rev-parse', 'HEAD'), tree: git('rev-parse', 'HEAD^{tree}'),
    version: versionAt().value, runId: env.GITHUB_RUN_ID, runAttempt: env.GITHUB_RUN_ATTEMPT,
    files: Object.fromEntries(payloads.map((file) => [file, digest(readFileSync(resolve(directory, file)))])),
  };
  writeFileSync(resolve(directory, 'candidate.json'), JSON.stringify(metadata, null, 2) + '\n');
  const files = [...payloads, 'candidate.json'];
  writeFileSync(resolve(directory, 'SHA256SUMS'), files.map((file) => `${digest(readFileSync(resolve(directory, file)))}  ${file}\n`).join(''));
  return metadata;
}

export function verifyArtifact(directory, event, repository) {
  const metadata = json(readFileSync(resolve(directory, 'candidate.json'), 'utf8'));
  const pr = event.pull_request;
  if (metadata.schema !== 'guild.release_candidate.v1' || metadata.repository !== repository || metadata.source !== pr.head.sha || metadata.tree !== git('rev-parse', `${pr.merge_commit_sha}^{tree}`) || metadata.version !== versionAt(pr.merge_commit_sha).value) {
    fail('Candidate does not match the reviewed repository, commit, tree and version');
  }
  const files = Object.entries(metadata.files ?? {});
  if (!files.some(([file]) => file === 'source.tar.gz')) fail('Candidate has no source bundle');
  for (const [file, hash] of files) {
    if (!/^[a-z][a-z-]*\.tar\.gz$/.test(file) || digest(readFileSync(resolve(directory, file))) !== hash) fail(`Candidate checksum mismatch: ${file}`);
  }
  const expected = [...files.map(([file]) => file), 'candidate.json'].map((file) => `${digest(readFileSync(resolve(directory, file)))}  ${file}\n`).join('');
  if (readFileSync(resolve(directory, 'SHA256SUMS'), 'utf8') !== expected) fail('Candidate checksum manifest differs');
}

export function candidateRun(event, repository, workflow) {
  const sha = event.pull_request.head.sha;
  const runs = json(gh('api', '--method', 'GET', `repos/${repository}/actions/workflows/${workflow}/runs`, '-f', 'branch=next', '-f', 'event=push', '-f', `head_sha=${sha}`, '-f', 'status=success', '-f', 'per_page=100')).workflow_runs;
  for (const run of runs) {
    if (run.head_sha !== sha || run.head_branch !== 'next' || run.event !== 'push' || run.conclusion !== 'success') continue;
    const artifacts = json(gh('api', `repos/${repository}/actions/runs/${run.id}/artifacts`)).artifacts;
    const artifact = artifacts.find((item) => item.name === `candidate-${sha}` && !item.expired);
    if (artifact) return { run_id: String(run.id), artifact_id: String(artifact.id) };
  }
  fail('No successful next build with an unexpired candidate artifact for this exact commit; run CI on next before promoting');
}

export function publish(event, repository, directory) {
  const sha = event.pull_request.merge_commit_sha;
  const tag = `v${versionAt(sha).value}`;
  const notes = resolve(directory, 'release-notes.md');
  writeFileSync(notes, event.pull_request.body || event.pull_request.title);
  const tags = json(gh('api', '--method', 'GET', `repos/${repository}/git/matching-refs/tags/${tag}`));
  const existing = tags.find((item) => item.ref === `refs/tags/${tag}`);
  if (existing) {
    let object = existing.object;
    while (object.type === 'tag') object = json(gh('api', `repos/${repository}/git/tags/${object.sha}`)).object;
    if (object.type !== 'commit' || object.sha !== sha) fail(`Existing ${tag} points to another commit`);
  }
  const releases = json(gh('api', '--paginate', '--slurp', `repos/${repository}/releases?per_page=100`)).flat();
  let release = releases.find((item) => item.tag_name === tag);
  if (!existing && release && release.target_commitish !== sha) fail('Existing draft release targets another commit');
  if (!release) {
    gh('release', 'create', tag, '--repo', repository, '--target', sha, '--title', tag, '--notes-file', notes, '--draft');
    release = json(gh('api', `repos/${repository}/releases/tags/${tag}`));
  }
  const files = readdirSync(directory).filter((file) => file.endsWith('.tar.gz') || ['candidate.json', 'SHA256SUMS'].includes(file));
  for (const file of files) {
    const asset = release.assets.find((item) => item.name === file);
    if (asset) {
      const bytes = execFileSync('gh', ['api', '-H', 'Accept: application/octet-stream', `repos/${repository}/releases/assets/${asset.id}`]);
      if (digest(bytes) !== digest(readFileSync(resolve(directory, file)))) fail(`Published asset differs: ${file}`);
    } else {
      if (!release.draft) fail(`Published release is missing ${file}; refusing to mutate it`);
      gh('release', 'upload', tag, resolve(directory, file), '--repo', repository);
    }
  }
  const newer = releases.some((item) => !item.draft && !item.prerelease && /^v\d+\.\d+\.\d+$/.test(item.tag_name) && compareCore(parseVersion(item.tag_name.slice(1)), versionAt(sha)) > 0);
  if (release.draft) gh('release', 'edit', tag, '--repo', repository, '--draft=false', `--latest=${!newer}`);
  return tag;
}

export function downloadRelease(tag, repository, directory) {
  if (!/^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(tag)) fail('Rollback requires an existing stable vX.Y.Z tag');
  const release = json(gh('api', `repos/${repository}/releases/tags/${tag}`));
  if (release.draft || release.prerelease) fail('Rollback requires a published stable release');
  const merge = git('rev-parse', `${tag}^{commit}`);
  git('merge-base', '--is-ancestor', merge, 'origin/main');
  mkdirSync(directory, { recursive: true });
  gh('release', 'download', tag, '--repo', repository, '--dir', directory,
    '--pattern', '*.tar.gz', '--pattern', 'candidate.json', '--pattern', 'SHA256SUMS');
  const metadata = json(readFileSync(resolve(directory, 'candidate.json'), 'utf8'));
  git('merge-base', '--is-ancestor', metadata.source, merge);
  if (`v${versionAt(merge).value}` !== tag) fail('Release tag and manifest version differ');
  verifyArtifact(directory, { pull_request: { head: { sha: metadata.source }, merge_commit_sha: merge } }, repository);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const [command, argument = 'release'] = process.argv.slice(2);
    const repository = process.env.GITHUB_REPOSITORY;
    const event = process.env.GITHUB_EVENT_PATH ? json(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8')) : {};
    let output = {};
    if (command === 'policy') validatePullRequest(event, repository);
    else if (command === 'verify-merge') output.version = validateMerge(event, repository);
    else if (command === 'metadata') writeMetadata(argument);
    else if (command === 'site-marker') {
      mkdirSync(resolve(argument, '.well-known'), { recursive: true });
      writeFileSync(resolve(argument, '.well-known/guild-release.json'), JSON.stringify({
        schema: 'guild.deployment.v1', repository, source: git('rev-parse', 'HEAD'),
        tree: git('rev-parse', 'HEAD^{tree}'), version: versionAt().value,
      }, null, 2) + '\n');
    }
    else if (command === 'verify-artifact') verifyArtifact(argument, event, repository);
    else if (command === 'candidate-run') output = candidateRun(event, repository, argument);
    else if (command === 'publish') output.tag = publish(event, repository, argument);
    else if (command === 'download-release') downloadRelease(process.env.INPUT_TAG, repository, argument);
    else fail(`Unknown command: ${command}`);
    for (const [key, value] of Object.entries(output)) {
      if (process.env.GITHUB_OUTPUT) writeFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`, { flag: 'a' });
      else console.log(`${key}=${value}`);
    }
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
