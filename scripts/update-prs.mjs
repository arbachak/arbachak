import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const GITHUB_USERNAME = 'arbachak';
const PULL_REQUESTS_PER_SECTION = 2;
const START_MARKER = '<!-- contributions:start -->';
const END_MARKER = '<!-- contributions:end -->';
const SECTIONS = [
  { state: 'merged', title: 'Merged' },
  { state: 'open', title: 'Open' },
];

function buildSearchQuery(state) {
  return `is:pr author:${GITHUB_USERNAME} is:public -user:${GITHUB_USERNAME} is:${state}`;
}

function escapeHtml(text) {
  return text
    .replace(/[\r\n\u2028\u2029]+/g, ' ')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function parsePullRequest(pullRequest, state) {
  const repositoryMatch = typeof pullRequest?.repository_url === 'string'
    ? /^https:\/\/api\.github\.com\/repos\/([A-Za-z0-9-]+)\/([A-Za-z0-9_.-]+)$/.exec(
      pullRequest.repository_url,
    )
    : null;

  if (!repositoryMatch) {
    throw new Error(`GitHub returned an invalid repository URL for a ${state} PR.`);
  }

  const [, owner, repositoryName] = repositoryMatch;
  if (owner.toLowerCase() === GITHUB_USERNAME) {
    throw new Error(`GitHub returned a ${state} PR from the profile owner's repository.`);
  }
  if (
    typeof pullRequest.user?.login !== 'string' ||
    pullRequest.user.login.toLowerCase() !== GITHUB_USERNAME
  ) {
    throw new Error(`GitHub returned a ${state} PR by an unexpected author.`);
  }
  if (!Number.isSafeInteger(pullRequest.number) || pullRequest.number < 1) {
    throw new Error(`GitHub returned an invalid ${state} PR number.`);
  }
  if (typeof pullRequest.title !== 'string' || !pullRequest.title.trim()) {
    throw new Error(`GitHub returned an invalid ${state} PR title.`);
  }

  const expectedState = state === 'open' ? 'open' : 'closed';
  if (pullRequest.state !== expectedState) {
    throw new Error(`GitHub returned a ${state} PR with an unexpected state.`);
  }

  const pullRequestUrl = `https://github.com/${owner}/${repositoryName}/pull/${pullRequest.number}`;
  if (
    pullRequest.html_url !== pullRequestUrl ||
    pullRequest.pull_request?.html_url !== pullRequestUrl
  ) {
    throw new Error(`GitHub returned an invalid ${state} PR URL.`);
  }

  const mergedAt = pullRequest.pull_request.merged_at;
  if (state === 'merged') {
    if (typeof mergedAt !== 'string' || !Number.isFinite(Date.parse(mergedAt))) {
      throw new Error('GitHub returned a merged PR without a valid merge date.');
    }
  } else if (mergedAt !== null) {
    throw new Error('GitHub returned an open PR with an unexpected merge date.');
  }

  return {
    repositoryName,
    number: pullRequest.number,
    title: pullRequest.title,
    url: pullRequestUrl,
  };
}

async function fetchPullRequests(state, { fetchImpl, token }) {
  const url = new URL('https://api.github.com/search/issues');
  url.searchParams.set('q', buildSearchQuery(state));
  url.searchParams.set('sort', 'updated');
  url.searchParams.set('order', 'desc');
  url.searchParams.set('per_page', String(PULL_REQUESTS_PER_SECTION));

  const headers = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': `${GITHUB_USERNAME}-profile`,
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const response = await fetchImpl(url, {
    headers,
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    throw new Error(`GitHub search for ${state} PRs failed (HTTP ${response.status}).`);
  }

  const searchResult = await response.json();
  if (!searchResult || searchResult.incomplete_results !== false) {
    throw new Error(`GitHub returned an incomplete ${state} PR list.`);
  }
  if (
    !Number.isSafeInteger(searchResult.total_count) ||
    searchResult.total_count < 0 ||
    !Array.isArray(searchResult.items)
  ) {
    throw new Error(`GitHub returned an invalid ${state} PR list.`);
  }

  const expectedCount = Math.min(PULL_REQUESTS_PER_SECTION, searchResult.total_count);
  if (searchResult.items.length !== expectedCount) {
    throw new Error(`GitHub returned an unexpected number of ${state} PRs.`);
  }

  const seenPullRequestUrls = new Set();
  const pullRequests = searchResult.items.map((item) => {
    const pullRequest = parsePullRequest(item, state);
    if (seenPullRequestUrls.has(pullRequest.url)) {
      throw new Error(`GitHub returned a duplicate ${state} PR.`);
    }

    seenPullRequestUrls.add(pullRequest.url);
    return pullRequest;
  });

  return { pullRequests, totalCount: searchResult.total_count };
}

function renderPullRequestCell(pullRequest) {
  if (!pullRequest) {
    return '    <td><sub>—</sub></td>';
  }

  const title = escapeHtml(pullRequest.title);
  const label = escapeHtml(`${pullRequest.repositoryName} #${pullRequest.number}`);

  return `    <td>
      <sub><a href="${pullRequest.url}" title="${title}">${label}</a></sub>
    </td>`;
}

function renderStatusRow({ state, title, pullRequests, totalCount }) {
  const searchUrl = new URL('https://github.com/pulls');
  searchUrl.searchParams.set('q', `${buildSearchQuery(state)} sort:updated-desc`);
  const cells = Array.from({ length: PULL_REQUESTS_PER_SECTION }, (_, index) =>
    renderPullRequestCell(pullRequests[index]),
  );

  return `  <tr>
    <th scope="row">
      <sub>${title} · <a href="${escapeHtml(searchUrl.href)}">All</a></sub>
    </th>
${cells.join('\n')}
    <td><sub>${totalCount}</sub></td>
  </tr>`;
}

function findContributionBlock(readme) {
  const start = readme.indexOf(START_MARKER);
  const end = readme.indexOf(END_MARKER);
  if (
    start === -1 ||
    end < start + START_MARKER.length ||
    readme.indexOf(START_MARKER, start + START_MARKER.length) !== -1 ||
    readme.indexOf(END_MARKER, end + END_MARKER.length) !== -1
  ) {
    throw new Error('README must contain exactly one ordered pair of contribution markers.');
  }

  return { contentStart: start + START_MARKER.length, contentEnd: end };
}

export async function updateReadme({
  readmePath = new URL('../README.md', import.meta.url),
  fetchImpl = fetch,
  token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN,
} = {}) {
  const readme = await readFile(readmePath, 'utf8');
  const { contentStart, contentEnd } = findContributionBlock(readme);

  const sections = await Promise.all(
    SECTIONS.map(async (section) => ({
      ...section,
      ...await fetchPullRequests(section.state, { fetchImpl, token }),
    })),
  );
  const table = [
    '<table>',
    ...sections.map(renderStatusRow),
    '</table>',
  ].join('\n');
  const newline = readme.includes('\r\n') ? '\r\n' : '\n';
  const block = `\n\n${table}\n\n`.replace(/\n/g, newline);
  const updatedReadme = readme.slice(0, contentStart) + block + readme.slice(contentEnd);
  if (updatedReadme === readme) {
    return false;
  }

  await writeFile(readmePath, updatedReadme, 'utf8');
  return true;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const changed = await updateReadme();
    console.log(changed ? 'Updated contribution tables.' : 'Contribution tables are unchanged.');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
