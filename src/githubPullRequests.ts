import * as vscode from "vscode";
import path from "path";
import spawn from "cross-spawn";
import type { RepoHandle } from "./repoHandle";
import type { BookmarkedCommit, BookmarkRef, FileStatus } from "./types";
import { logger } from "./logger";
import {
  bookmarkCreate,
  bookmarkTrack,
  exactPattern,
  getBookmarkRefs,
  getGitRemotes,
  getGitRoot,
  getNearestBookmarkedAncestor,
  gitFetch,
  gitFetchRemote,
  gitPushBookmark,
  gitRemoteAdd,
  gitRemoteRemove,
  gitRemoteRename,
  jjNew,
  log,
  rebaseOnto,
  revsetSymbol,
} from "./services/Repository";

const PULL_REQUEST_EXTENSION_ID = "GitHub.vscode-pull-request-github";

export const RefType = { Head: 0, RemoteHead: 1 } as const;

export const Status = {
  INDEX_ADDED: 1,
  INDEX_RENAMED: 3,
  INDEX_COPIED: 4,
  MODIFIED: 5,
  DELETED: 6,
  UNTRACKED: 7,
} as const;

export interface UpstreamRef {
  readonly remote: string;
  readonly name: string;
}

export interface Ref {
  readonly type: number;
  readonly name?: string;
  readonly commit?: string;
  readonly remote?: string;
}

export interface Branch extends Ref {
  readonly upstream?: UpstreamRef;
  readonly ahead?: number;
  readonly behind?: number;
}

export interface Commit {
  readonly hash: string;
  readonly message: string;
  readonly parents: string[];
  readonly authorDate?: Date;
  readonly authorName?: string;
  readonly authorEmail?: string;
  readonly commitDate?: Date;
}

interface Remote {
  readonly name: string;
  readonly fetchUrl?: string;
  readonly pushUrl?: string;
  readonly isReadOnly: boolean;
}

export interface Change {
  readonly uri: vscode.Uri;
  readonly originalUri: vscode.Uri;
  readonly renameUri: vscode.Uri | undefined;
  readonly status: number;
}

interface RefQuery {
  readonly pattern?: string;
  readonly count?: number;
  readonly remote?: boolean;
}

interface LogOptions {
  readonly maxEntries?: number;
  readonly path?: string;
  readonly range?: string;
}

interface FetchOptions {
  readonly remote?: string;
  readonly ref?: string;
}

interface PullRequestsApi {
  registerGitProvider(provider: unknown): vscode.Disposable;
}

class GitCommandError extends Error {
  constructor(
    message: string,
    readonly stderr: string,
    readonly exitCode: number | null,
  ) {
    super(message);
  }
}

const GIT_LOG_FIELD_SEPARATOR = "\x00";
const GIT_LOG_RECORD_SEPARATOR = "\x1e";
export const GIT_LOG_FORMAT = [
  "%H",
  "%aN",
  "%aE",
  "%at",
  "%ct",
  "%P",
  "%B",
].join("%x00");

const isPushableRemote = (ref: BookmarkRef) =>
  ref.remote !== undefined && ref.remote !== "git";

const stripHeadsPrefix = (ref: string) => ref.replace(/^refs\/heads\//, "");

export const parseGitCommit = (record: string): Commit => {
  const [hash, authorName, authorEmail, authorTime, commitTime, parents, body] =
    record.split(GIT_LOG_FIELD_SEPARATOR);
  return {
    hash: hash.trim(),
    authorName,
    authorEmail,
    authorDate: new Date(Number(authorTime) * 1000),
    commitDate: new Date(Number(commitTime) * 1000),
    parents: parents ? parents.split(" ") : [],
    message: (body ?? "").replace(/\n$/, ""),
  };
};

export const parseGitLog = (output: string): Commit[] =>
  output
    .split(GIT_LOG_RECORD_SEPARATOR)
    .map((record) => record.replace(/^\n/, ""))
    .filter((record) => record !== "")
    .map(parseGitCommit);

export const parseGitConfigList = (output: string) =>
  output
    .split("\0")
    .filter((entry) => entry !== "")
    .map((entry) => {
      const newline = entry.indexOf("\n");
      return newline === -1
        ? { key: entry, value: "" }
        : { key: entry.slice(0, newline), value: entry.slice(newline + 1) };
    });

export const parseLsTree = (output: string) => {
  const match = /^(\d+)\s+\w+\s+([0-9a-f]+)\s+(\d+|-)\t/.exec(output);
  return match
    ? {
        mode: match[1],
        object: match[2],
        size: match[3] === "-" ? 0 : Number(match[3]),
      }
    : undefined;
};

const toGitDiffStatus = (code: string) => {
  switch (code[0]) {
    case "A":
      return Status.INDEX_ADDED;
    case "D":
      return Status.DELETED;
    case "R":
      return Status.INDEX_RENAMED;
    case "C":
      return Status.INDEX_COPIED;
    default:
      return Status.MODIFIED;
  }
};

export const parseNameStatus = (output: string, root: string): Change[] => {
  const parts = output.split("\0").filter((part) => part !== "");
  const toUri = (file: string) => vscode.Uri.file(path.join(root, file));
  const changes: Change[] = [];
  for (let index = 0; index < parts.length; ) {
    const status = toGitDiffStatus(parts[index++]);
    if (status === Status.INDEX_RENAMED || status === Status.INDEX_COPIED) {
      const originalUri = toUri(parts[index++]);
      const uri = toUri(parts[index++]);
      changes.push({ uri, originalUri, renameUri: uri, status });
    } else {
      const uri = toUri(parts[index++]);
      changes.push({ uri, originalUri: uri, renameUri: undefined, status });
    }
  }
  return changes;
};

const toWorkingTreeStatus = (type: FileStatus["type"]) => {
  switch (type) {
    case "A":
      return Status.UNTRACKED;
    case "D":
      return Status.DELETED;
    case "R":
      return Status.INDEX_RENAMED;
    case "C":
      return Status.INDEX_COPIED;
    default:
      return Status.MODIFIED;
  }
};

export const toWorkingTreeChange = (
  fileStatus: FileStatus,
  root: string,
): Change => {
  const uri = vscode.Uri.file(fileStatus.path);
  return {
    uri,
    originalUri: fileStatus.renamedFrom
      ? vscode.Uri.file(path.join(root, fileStatus.renamedFrom))
      : uri,
    renameUri: fileStatus.renamedFrom ? uri : undefined,
    status: toWorkingTreeStatus(fileStatus.type),
  };
};

export const toBranch = (
  bookmarks: readonly BookmarkRef[],
  name: string,
  commit: string | undefined,
): Branch => {
  const remotes = bookmarks.filter(
    (ref) => ref.name === name && ref.tracked && isPushableRemote(ref),
  );
  const upstream = remotes.find((ref) => ref.commitId === commit) ?? remotes[0];
  if (!upstream?.remote) {
    return { type: RefType.Head, name, commit };
  }
  return {
    type: RefType.Head,
    name,
    commit,
    upstream: { remote: upstream.remote, name: upstream.name },
    ahead: upstream.remoteBehindCount,
    behind: upstream.remoteAheadCount,
  };
};

export const selectHeadBranch = (
  bookmarks: readonly BookmarkRef[],
  nearest: BookmarkedCommit | undefined,
  fallbackCommit: string | undefined,
): Branch => {
  if (!nearest) {
    return { type: RefType.Head, commit: fallbackCommit };
  }
  const name =
    nearest.bookmarks.find((candidate) =>
      bookmarks.some(
        (ref) => ref.name === candidate && ref.tracked && isPushableRemote(ref),
      ),
    ) ?? nearest.bookmarks[0];
  return toBranch(bookmarks, name, nearest.commitId);
};

export const parseRemoteRef = (
  bookmarks: readonly BookmarkRef[],
  ref: string,
): UpstreamRef | undefined => {
  const qualified = ref.replace(/^refs\/remotes\//, "");
  const match = bookmarks
    .filter(isPushableRemote)
    .find((candidate) => `${candidate.remote}/${candidate.name}` === qualified);
  if (match?.remote) {
    return { remote: match.remote, name: match.name };
  }
  if (qualified === ref) {
    return undefined;
  }
  const remotes = [
    ...new Set(
      bookmarks
        .filter(isPushableRemote)
        .map((candidate) => candidate.remote as string),
    ),
  ].sort((left, right) => right.length - left.length);
  const remote = remotes.find((candidate) =>
    qualified.startsWith(`${candidate}/`),
  );
  return remote
    ? { remote, name: qualified.slice(remote.length + 1) }
    : undefined;
};

export const findBranch = (
  bookmarks: readonly BookmarkRef[],
  head: Branch | undefined,
  name: string,
): Branch | undefined => {
  if (name === "HEAD") {
    return head;
  }
  const localName = stripHeadsPrefix(name);
  const local = bookmarks.find(
    (ref) => ref.name === localName && ref.remote === undefined,
  );
  if (local) {
    return toBranch(bookmarks, local.name, local.commitId);
  }
  const upstream = parseRemoteRef(bookmarks, name);
  const remote =
    upstream &&
    bookmarks.find(
      (ref) => ref.remote === upstream.remote && ref.name === upstream.name,
    );
  return remote
    ? {
        type: RefType.RemoteHead,
        name: `${upstream.remote}/${upstream.name}`,
        remote: upstream.remote,
        commit: remote.commitId,
      }
    : undefined;
};

export const listRefs = (
  bookmarks: readonly BookmarkRef[],
  includeLocal: boolean,
  includeRemote: boolean,
): Ref[] =>
  bookmarks
    .filter((ref) => ref.commitId !== undefined && ref.remote !== "git")
    .filter((ref) => (ref.remote === undefined ? includeLocal : includeRemote))
    .map((ref) =>
      ref.remote === undefined
        ? { type: RefType.Head, name: ref.name, commit: ref.commitId }
        : {
            type: RefType.RemoteHead,
            name: `${ref.remote}/${ref.name}`,
            remote: ref.remote,
            commit: ref.commitId,
          },
    );

export const parseFetchRef = (ref: string) => {
  const [source, destination] = ref.split(":");
  const remoteBranch = stripHeadsPrefix(source);
  return {
    remoteBranch,
    localBranch: destination ? stripHeadsPrefix(destination) : undefined,
  };
};

const remoteBookmarkRevset = (name: string, remote: string) =>
  `remote_bookmarks(${exactPattern(name)}, ${exactPattern(remote)})`;

const runGit = (
  gitDir: string,
  workTree: string,
  args: string[],
  input?: string,
): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    const child = spawn(
      "git",
      [`--git-dir=${gitDir}`, `--work-tree=${workTree}`, ...args],
      { cwd: workTree },
    );
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve(Buffer.concat(stdout));
        return;
      }
      const message = Buffer.concat(stderr).toString();
      reject(
        new GitCommandError(
          message || `git ${args[0]} exited with code ${code}`,
          message,
          code,
        ),
      );
    });
    child.stdin?.end(input);
  });

const unsupported = (operation: string) => () =>
  Promise.reject(new Error(`${operation} is not supported in jj repositories`));

class JJPullRequestRepository {
  readonly rootUri: vscode.Uri;
  readonly inputBox = { value: "" };
  readonly ui: {
    readonly selected: boolean;
    readonly onDidChange: vscode.Event<void>;
  };
  readonly state: {
    HEAD: Branch | undefined;
    remotes: Remote[];
    submodules: never[];
    worktrees: never[];
    rebaseCommit: undefined;
    mergeChanges: Change[];
    indexChanges: Change[];
    workingTreeChanges: Change[];
    untrackedChanges: Change[];
    onDidChange: vscode.Event<void>;
  };

  private readonly onDidChangeStateEmitter = new vscode.EventEmitter<void>();
  private readonly onDidChangeUiEmitter = new vscode.EventEmitter<void>();
  private bookmarks: BookmarkRef[] = [];
  private snapshot = "";
  private refreshing: Promise<void> | undefined;
  private queuedRefresh: Promise<void> | undefined;

  constructor(
    readonly handle: RepoHandle,
    private readonly gitDir: string,
  ) {
    this.rootUri = vscode.Uri.file(handle.config.repositoryRoot);
    this.ui = { selected: true, onDidChange: this.onDidChangeUiEmitter.event };
    this.state = {
      HEAD: undefined,
      remotes: [],
      submodules: [],
      worktrees: [],
      rebaseCommit: undefined,
      mergeChanges: [],
      indexChanges: [],
      workingTreeChanges: [],
      untrackedChanges: [],
      onDidChange: this.onDidChangeStateEmitter.event,
    };
  }

  dispose() {
    this.onDidChangeStateEmitter.dispose();
    this.onDidChangeUiEmitter.dispose();
  }

  refresh(): Promise<void> {
    if (!this.refreshing) {
      this.refreshing = this.loadState()
        .catch((error: unknown) => {
          logger.error(
            `Failed to refresh GitHub pull request state for ${this.handle.config.repositoryRoot}: ${String(error)}`,
          );
        })
        .finally(() => {
          this.refreshing = undefined;
        });
      return this.refreshing;
    }
    this.queuedRefresh ??= this.refreshing.then(() => {
      this.queuedRefresh = undefined;
      return this.refresh();
    });
    return this.queuedRefresh;
  }

  private get config() {
    return this.handle.config;
  }

  private async loadState() {
    const [remotes, bookmarks, nearest] = await Promise.all([
      this.handle.runPromise(getGitRemotes(this.config)),
      this.handle.runPromise(getBookmarkRefs(this.config)),
      this.handle.runPromise(getNearestBookmarkedAncestor(this.config)),
    ]);
    const status = this.handle.currentState.status;
    const head = selectHeadBranch(
      bookmarks,
      nearest,
      status?.parentChanges[0]?.commitId,
    );
    const workingTreeChanges = (status?.fileStatuses ?? []).map((fileStatus) =>
      toWorkingTreeChange(fileStatus, this.config.repositoryRoot),
    );

    this.bookmarks = bookmarks;
    this.state.HEAD = head;
    this.state.remotes = remotes.map((remote) => ({
      name: remote.name,
      fetchUrl: remote.url,
      pushUrl: remote.url,
      isReadOnly: false,
    }));
    this.state.workingTreeChanges = workingTreeChanges;

    const snapshot = JSON.stringify([
      head,
      remotes,
      workingTreeChanges.map((change) => [change.uri.fsPath, change.status]),
    ]);
    if (snapshot !== this.snapshot) {
      this.snapshot = snapshot;
      this.onDidChangeStateEmitter.fire();
    }
  }

  private toRelativePath(filePath: string) {
    const relative = path.isAbsolute(filePath)
      ? path.relative(this.config.repositoryRoot, filePath)
      : filePath;
    return relative.split(path.sep).join("/");
  }

  private git(args: string[], input?: string) {
    return runGit(this.gitDir, this.config.repositoryRoot, args, input);
  }

  private async gitText(args: string[], input?: string) {
    return (await this.git(args, input)).toString();
  }

  private async optionalGitText(args: string[]) {
    try {
      return (await this.gitText(args)).trim();
    } catch {
      return "";
    }
  }

  private headCommit() {
    return this.state.HEAD?.commit ?? "HEAD";
  }

  private hasLocalBookmark(name: string) {
    return this.bookmarks.some(
      (ref) => ref.name === name && ref.remote === undefined,
    );
  }

  private toRevset(ref: string) {
    if (/^[0-9a-f]{7,40}$/.test(ref)) {
      return ref;
    }
    const remote = parseRemoteRef(this.bookmarks, ref);
    return remote
      ? remoteBookmarkRevset(remote.name, remote.remote)
      : revsetSymbol(stripHeadsPrefix(ref));
  }

  private async isAncestorOfBoth(commit: string, left: string, right: string) {
    const output = await this.handle.runPromise(
      log(
        this.config,
        `${commit} & ::(${left}) & ::(${right})`,
        "commit_id",
        1,
        true,
      ),
    );
    return output.trim() !== "";
  }

  private async diffChanges(args: string[]) {
    return parseNameStatus(
      await this.gitText(["diff", "--name-status", "-z", ...args]),
      this.config.repositoryRoot,
    );
  }

  private diffAgainst(ref: string, filePath?: string) {
    return filePath === undefined
      ? this.diffChanges([ref])
      : this.gitText(["diff", ref, "--", this.toRelativePath(filePath)]);
  }

  getConfigs = async () =>
    parseGitConfigList(await this.gitText(["config", "--list", "-z"]));

  getConfig = (key: string) => this.optionalGitText(["config", "--get", key]);

  getGlobalConfig = (key: string) =>
    this.optionalGitText(["config", "--global", "--get", key]);

  setConfig = (key: string, value: string) =>
    this.gitText(["config", "--local", key, value]);

  unsetConfig = (key: string) =>
    this.gitText(["config", "--local", "--unset", key]);

  getObjectDetails = async (treeish: string, filePath: string) => {
    const details = parseLsTree(
      await this.gitText([
        "ls-tree",
        "-l",
        treeish,
        "--",
        this.toRelativePath(filePath),
      ]),
    );
    if (!details) {
      throw new GitCommandError(
        `${filePath} does not exist in ${treeish}`,
        "",
        null,
      );
    }
    return details;
  };

  detectObjectType = () => Promise.resolve({ mimetype: "text/plain" });

  buffer = (ref: string, filePath: string) =>
    this.git(["show", `${ref}:${this.toRelativePath(filePath)}`]);

  show = async (ref: string, filePath: string) =>
    (await this.buffer(ref, filePath)).toString();

  getCommit = async (ref: string) =>
    parseGitCommit(
      await this.gitText(["show", "-s", `--format=${GIT_LOG_FORMAT}`, ref]),
    );

  log = async (options?: LogOptions) =>
    parseGitLog(
      await this.gitText([
        "log",
        `--format=${GIT_LOG_FORMAT}%x1e`,
        `-n${options?.maxEntries ?? 32}`,
        ...(options?.range ? [options.range] : []),
        ...(options?.path ? ["--", this.toRelativePath(options.path)] : []),
      ]),
    );

  getMergeBase = async (ref1: string, ref2: string) =>
    (await this.optionalGitText(["merge-base", ref1, ref2])) || undefined;

  diff = () => this.gitText(["diff", this.headCommit()]);

  diffWith = (ref: string, filePath?: string) =>
    this.diffAgainst(ref, filePath);

  diffWithHEAD = (filePath?: string) =>
    this.diffAgainst(this.headCommit(), filePath);

  diffIndexWith = (ref: string, filePath?: string) =>
    this.diffAgainst(ref, filePath);

  diffIndexWithHEAD = (filePath?: string) =>
    this.diffAgainst(this.headCommit(), filePath);

  diffBetween = (ref1: string, ref2: string, filePath?: string) =>
    filePath === undefined
      ? this.diffChanges([`${ref1}...${ref2}`])
      : this.gitText([
          "diff",
          `${ref1}...${ref2}`,
          "--",
          this.toRelativePath(filePath),
        ]);

  diffBlobs = (object1: string, object2: string) =>
    this.gitText(["diff", object1, object2]);

  hashObject = async (data: string) =>
    (await this.gitText(["hash-object", "-w", "--stdin"], data)).trim();

  getBranch = (name: string) => {
    const branch = findBranch(this.bookmarks, this.state.HEAD, name);
    return branch
      ? Promise.resolve(branch)
      : Promise.reject(new GitCommandError(`No such branch: ${name}`, "", 1));
  };

  getBranches = (query?: RefQuery) =>
    Promise.resolve(
      listRefs(this.bookmarks, true, query?.remote ?? false).slice(
        0,
        query?.count,
      ),
    );

  getRefs = (query?: RefQuery) => {
    const pattern = query?.pattern ?? "";
    const refs = listRefs(
      this.bookmarks,
      pattern === "" || pattern.startsWith("refs/heads"),
      pattern === "" || pattern.startsWith("refs/remotes"),
    );
    return Promise.resolve(refs.slice(0, query?.count));
  };

  getBranchBase = () => Promise.resolve(undefined);

  status = () => this.refresh();

  fetch = async (
    optionsOrRemote?: FetchOptions | string,
    refArgument?: string,
  ): Promise<void> => {
    const remote =
      typeof optionsOrRemote === "string"
        ? optionsOrRemote
        : optionsOrRemote?.remote;
    const ref =
      typeof optionsOrRemote === "string" ? refArgument : optionsOrRemote?.ref;
    if (!remote) {
      await this.handle.runPromise(gitFetch(this.config));
      await this.refresh();
      return;
    }

    const target = ref ? parseFetchRef(ref) : undefined;
    await this.handle.runPromise(
      gitFetchRemote(this.config, remote, target?.remoteBranch),
    );
    await this.refresh();
    if (
      target?.localBranch &&
      target.localBranch !== target.remoteBranch &&
      !this.hasLocalBookmark(target.localBranch)
    ) {
      await this.handle.runPromise(
        bookmarkCreate(
          this.config,
          target.localBranch,
          remoteBookmarkRevset(target.remoteBranch, remote),
        ),
      );
      await this.refresh();
    }
  };

  checkout = async (treeish: string) => {
    await this.handle.runPromise(
      jjNew(this.config, undefined, [this.toRevset(treeish)]),
    );
    await this.refresh();
  };

  createBranch = async (name: string, checkout: boolean, ref?: string) => {
    const rev =
      !ref || ref === "HEAD"
        ? (this.state.HEAD?.commit ?? "@-")
        : this.toRevset(ref);
    await this.handle.runPromise(bookmarkCreate(this.config, name, rev));
    if (checkout) {
      await this.handle.runPromise(
        jjNew(this.config, undefined, [revsetSymbol(name)]),
      );
    }
    await this.refresh();
  };

  setBranchUpstream = async (name: string, upstream: string) => {
    const target = parseRemoteRef(this.bookmarks, upstream);
    if (!target) {
      throw new Error(`Unknown remote branch: ${upstream}`);
    }
    await this.setConfig(`branch.${name}.remote`, target.remote);
    await this.setConfig(`branch.${name}.merge`, `refs/heads/${target.name}`);
    if (target.name === name) {
      await this.handle.runPromise(
        bookmarkTrack(this.config, name, target.remote),
      );
    }
    await this.refresh();
  };

  pull = async () => {
    const head = this.state.HEAD;
    if (!head?.name || !head.upstream) {
      await this.fetch();
      return;
    }

    const name = head.name;
    const before = head.commit;
    await this.fetch(head.upstream.remote, head.upstream.name);
    const after = findBranch(this.bookmarks, this.state.HEAD, name)?.commit;
    if (!before || !after || before === after) {
      return;
    }
    if (!(await this.isAncestorOfBoth(before, "@", after))) {
      return;
    }

    const workingCopy = this.handle.currentState.status?.workingCopy.commitId;
    await this.handle.runPromise(
      workingCopy === before
        ? jjNew(this.config, undefined, [revsetSymbol(name)])
        : rebaseOnto(this.config, `roots(${before}..@)`, revsetSymbol(name)),
    );
    await this.refresh();
  };

  push = async (remoteName?: string, branchName?: string) => {
    const name = branchName
      ? stripHeadsPrefix(branchName.split(":")[0])
      : this.state.HEAD?.name;
    if (!name) {
      throw new Error("There is no bookmark to push");
    }
    await this.handle.runPromise(
      gitPushBookmark(this.config, name, remoteName),
    );
    await this.refresh();
  };

  addRemote = async (name: string, url: string) => {
    await this.handle.runPromise(gitRemoteAdd(this.config, name, url));
    await this.refresh();
  };

  removeRemote = async (name: string) => {
    await this.handle.runPromise(gitRemoteRemove(this.config, name));
    await this.refresh();
  };

  renameRemote = async (name: string, newName: string) => {
    await this.handle.runPromise(gitRemoteRename(this.config, name, newName));
    await this.refresh();
  };

  clean = unsupported("clean");
  apply = unsupported("apply");
  deleteBranch = unsupported("deleteBranch");
  blame = unsupported("blame");
  commit = unsupported("commit");
  add = unsupported("add");
  merge = unsupported("merge");
  mergeAbort = unsupported("mergeAbort");
}

export interface GitHubPullRequestsDeps {
  readonly repos: () => readonly RepoHandle[];
  readonly isEnabled: () => boolean;
}

export interface GitHubPullRequestsIntegration {
  readonly reconcile: () => Promise<void>;
  readonly dispose: () => void;
}

export function setupGitHubPullRequests(
  deps: GitHubPullRequestsDeps,
): GitHubPullRequestsIntegration {
  const repositories = new Map<string, JJPullRequestRepository>();
  const repoSubscriptions = new Map<string, vscode.Disposable>();
  const onDidOpenRepository =
    new vscode.EventEmitter<JJPullRequestRepository>();
  const onDidCloseRepository =
    new vscode.EventEmitter<JJPullRequestRepository>();
  const onDidChangeState = new vscode.EventEmitter<string>();
  const provider = {
    get repositories() {
      return [...repositories.values()];
    },
    onDidOpenRepository: onDidOpenRepository.event,
    onDidCloseRepository: onDidCloseRepository.event,
    state: "initialized",
    onDidChangeState: onDidChangeState.event,
  };
  let registration: vscode.Disposable | undefined;
  let registering: Promise<void> | undefined;

  const closeRepository = (root: string) => {
    const repository = repositories.get(root);
    if (!repository) {
      return;
    }
    repositories.delete(root);
    repoSubscriptions.get(root)?.dispose();
    repoSubscriptions.delete(root);
    onDidCloseRepository.fire(repository);
    repository.dispose();
  };

  const openRepository = async (handle: RepoHandle) => {
    const root = handle.config.repositoryRoot;
    const gitDir = await handle
      .runPromise(getGitRoot(handle.config))
      .catch(() => undefined);
    if (!gitDir || repositories.has(root)) {
      return;
    }
    const repository = new JJPullRequestRepository(handle, gitDir);
    await repository.refresh();
    repositories.set(root, repository);
    repoSubscriptions.set(
      root,
      handle.onDidUpdateEmitter.event(() => {
        void repository.refresh();
      }),
    );
    onDidOpenRepository.fire(repository);
  };

  const syncRepositories = async () => {
    const handles = deps.repos();
    const roots = new Set(
      handles.map((handle) => handle.config.repositoryRoot),
    );
    for (const root of [...repositories.keys()]) {
      if (!roots.has(root)) {
        closeRepository(root);
      }
    }
    await Promise.all(
      handles
        .filter((handle) => !repositories.has(handle.config.repositoryRoot))
        .map(openRepository),
    );
  };

  const register = async () => {
    const extension = vscode.extensions.getExtension<PullRequestsApi>(
      PULL_REQUEST_EXTENSION_ID,
    );
    if (!extension) {
      return;
    }
    const api = extension.isActive
      ? extension.exports
      : await extension.activate();
    if (registration || typeof api?.registerGitProvider !== "function") {
      return;
    }
    await syncRepositories();
    registration = api.registerGitProvider(provider);
    logger.info("Registered jj repositories with GitHub Pull Requests");
  };

  const unregister = () => {
    registration?.dispose();
    registration = undefined;
    for (const root of [...repositories.keys()]) {
      closeRepository(root);
    }
  };

  const reconcile = async () => {
    if (!deps.isEnabled()) {
      unregister();
      return;
    }
    if (registration) {
      await syncRepositories();
      return;
    }
    registering ??= register()
      .catch((error: unknown) => {
        logger.error(
          `Failed to register with GitHub Pull Requests: ${String(error)}`,
        );
      })
      .finally(() => {
        registering = undefined;
      });
    await registering;
  };

  const extensionsSubscription = vscode.extensions.onDidChange(() => {
    if (!registration) {
      void reconcile();
    }
  });

  return {
    reconcile,
    dispose: () => {
      extensionsSubscription.dispose();
      unregister();
      onDidOpenRepository.dispose();
      onDidCloseRepository.dispose();
      onDidChangeState.dispose();
    },
  };
}
