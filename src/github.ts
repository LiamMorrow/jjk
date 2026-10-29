import * as vscode from "vscode";
import { Effect } from "effect";
import { type } from "arktype";
import type { RepositoryConfig } from "./types";
import {
  getGitRemotes,
  getLatestPushedAncestor,
  type GitRemote,
} from "./services/Repository";

export interface GitHubRepo {
  readonly owner: string;
  readonly name: string;
  readonly remote: string;
  readonly url: string;
}

export interface PushedAncestor {
  readonly repo: GitHubRepo;
  readonly commitId: string | undefined;
}

export interface PullRequest {
  readonly number: number;
  readonly title?: string;
  readonly url: string;
}

const GITHUB_REMOTE_PATTERNS = [
  /^https?:\/\/(?:[^@/]+@)?github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/,
  /^(?:ssh:\/\/)?git@github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?\/?$/,
];

const PREFERRED_REMOTES = ["upstream", "origin"];

const MERGE_COMMIT_PATTERN = /^Merge pull request #(\d+) from /;
const SQUASH_MERGE_PATTERN = /\(#(\d+)\)\s*$/;
const ISSUE_REFERENCE_PATTERN =
  /(^|[\s(,;:])((?:([\w.-]+)\/([\w.-]+))?#(\d+))\b/g;

const PullRequestsResponse = type({
  number: "number",
  title: "string",
  html_url: "string",
  merged_at: "string | null",
}).array();

export const parseGitHubRemote = (
  remote: GitRemote,
): GitHubRepo | undefined => {
  for (const pattern of GITHUB_REMOTE_PATTERNS) {
    const match = pattern.exec(remote.url);
    if (match) {
      const [, owner, name] = match;
      return {
        owner,
        name,
        remote: remote.name,
        url: `https://github.com/${owner}/${name}`,
      };
    }
  }
  return undefined;
};

const remoteRank = (name: string) => {
  const index = PREFERRED_REMOTES.indexOf(name);
  return index === -1 ? PREFERRED_REMOTES.length : index;
};

export const getGitHubRepos = (config: RepositoryConfig) =>
  getGitRemotes(config).pipe(
    Effect.map((remotes) =>
      remotes
        .map(parseGitHubRemote)
        .filter((repo): repo is GitHubRepo => repo !== undefined)
        .sort(
          (left, right) => remoteRank(left.remote) - remoteRank(right.remote),
        ),
    ),
  );

export const findPushedAncestors = (config: RepositoryConfig, rev: string) =>
  Effect.gen(function* () {
    const repos = yield* getGitHubRepos(config);
    return yield* Effect.forEach(
      repos,
      (repo) =>
        getLatestPushedAncestor(config, rev, repo.remote).pipe(
          Effect.map((commitId): PushedAncestor => ({ repo, commitId })),
        ),
      { concurrency: "unbounded" },
    );
  });

export const linkifyIssueReferences = (text: string, repo: GitHubRepo) =>
  text.replace(
    ISSUE_REFERENCE_PATTERN,
    (_match, prefix: string, reference: string, owner, name, number) => {
      const repoUrl =
        owner && name ? `https://github.com/${owner}/${name}` : repo.url;
      return `${prefix}[${reference}](${repoUrl}/issues/${number})`;
    },
  );

export const findPullRequestNumberInMessage = (
  description: string,
): number | undefined => {
  const subject = description.split("\n")[0] ?? "";
  const match =
    MERGE_COMMIT_PATTERN.exec(subject) ?? SQUASH_MERGE_PATTERN.exec(subject);
  return match ? Number(match[1]) : undefined;
};

export const pullRequestUrl = (repo: GitHubRepo, number: number) =>
  `${repo.url}/pull/${number}`;

export const commitUrl = (repo: GitHubRepo, commitId: string) =>
  `${repo.url}/commit/${commitId}`;

export const permalinkUrl = (
  repo: GitHubRepo,
  commitId: string,
  relativePath: string,
  lines?: { readonly start: number; readonly end: number },
) => {
  const encodedPath = relativePath
    .split(/[\\/]/)
    .map(encodeURIComponent)
    .join("/");
  const plain = lines && /\.(md|mdx|markdown)$/i.test(relativePath);
  const fragment = !lines
    ? ""
    : lines.start === lines.end
      ? `#L${lines.start}`
      : `#L${lines.start}-L${lines.end}`;
  return `${repo.url}/blob/${commitId}/${encodedPath}${plain ? "?plain=1" : ""}${fragment}`;
};

const pullRequestCache = new Map<string, PullRequest | null>();

const getGitHubToken = Effect.promise(() =>
  Promise.resolve(
    vscode.authentication.getSession("github", ["repo"], { silent: true }),
  ).then(
    (session) => session?.accessToken,
    () => undefined,
  ),
);

const toError = (cause: unknown): Error =>
  cause instanceof Error ? cause : new Error(String(cause));

export const lookupPullRequest = (
  repo: GitHubRepo,
  commitId: string,
): Effect.Effect<PullRequest | undefined, Error> =>
  Effect.gen(function* () {
    const cacheKey = `${repo.owner}/${repo.name}@${commitId}`;
    const cached = pullRequestCache.get(cacheKey);
    if (cached !== undefined) {
      return cached ?? undefined;
    }

    const token = yield* getGitHubToken;
    const response = yield* Effect.tryPromise({
      try: () =>
        fetch(
          `https://api.github.com/repos/${repo.owner}/${repo.name}/commits/${commitId}/pulls`,
          {
            headers: {
              Accept: "application/vnd.github+json",
              ...(token ? { Authorization: `Bearer ${token}` } : {}),
            },
            signal: AbortSignal.timeout(3000),
          },
        ),
      catch: toError,
    });
    if (response.status === 404 || response.status === 422) {
      pullRequestCache.set(cacheKey, null);
      return undefined;
    }
    if (!response.ok) {
      return yield* Effect.fail(
        new Error(`GitHub API responded with ${response.status}`),
      );
    }

    const body: unknown = yield* Effect.tryPromise({
      try: () => response.json(),
      catch: toError,
    });
    const pulls = PullRequestsResponse(body);
    if (pulls instanceof type.errors) {
      return yield* Effect.fail(new Error(pulls.summary));
    }

    const pull = pulls.find((candidate) => candidate.merged_at) ?? pulls[0];
    const result = pull
      ? { number: pull.number, title: pull.title, url: pull.html_url }
      : null;
    pullRequestCache.set(cacheKey, result);
    return result ?? undefined;
  });
