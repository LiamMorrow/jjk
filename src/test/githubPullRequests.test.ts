import * as assert from "assert";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import { getExtensionAPI } from "./extensionApi";
import { getJJPath } from "./utils";
import type * as GitHubPullRequestsModule from "../githubPullRequests";
import type * as ParsersModule from "../parsers";
import type { BookmarkRef } from "../types";

const execFileAsync = promisify(execFile);

const runJJ = async (cwd: string, args: string[]) =>
  (await execFileAsync(getJJPath(), args, { cwd, timeout: 10_000 })).stdout;

const bookmark = (overrides: Partial<BookmarkRef> & { name: string }) => ({
  remote: undefined,
  commitId: "aaaa",
  tracked: false,
  remoteAheadCount: undefined,
  remoteBehindCount: undefined,
  ...overrides,
});

suite("githubPullRequests", () => {
  let prs: typeof GitHubPullRequestsModule;
  let parsers: typeof ParsersModule;

  suiteSetup(async () => {
    ({ githubPullRequests: prs, parsers } = await getExtensionAPI());
  });

  suite("bookmark templates", () => {
    let repoPath: string;

    suiteSetup(async function () {
      this.timeout(30_000);
      repoPath = await fs.realpath(
        await fs.mkdtemp(path.join(os.tmpdir(), "jj-code-bookmarks-")),
      );
      await runJJ(repoPath, ["git", "init"]);
      await runJJ(repoPath, ["describe", "-m", "work"]);
      await runJJ(repoPath, [
        "bookmark",
        "create",
        '"fix/trailing-"',
        "-r",
        "@",
      ]);
      await runJJ(repoPath, ["bookmark", "create", "plain", "-r", "@"]);
    });

    suiteTeardown(async () => {
      await fs.rm(repoPath, { recursive: true, force: true });
    });

    test("bookmark list yields unquoted names", async () => {
      const output = await runJJ(repoPath, [
        "bookmark",
        "list",
        "--all-remotes",
        "-T",
        parsers.BOOKMARK_REFS_TEMPLATE,
      ]);
      const refs = parsers.parseBookmarkRefs(output);
      const local = refs.filter((ref) => ref.remote === undefined);
      assert.deepStrictEqual(
        local.map((ref) => ref.name),
        ["fix/trailing-", "plain"],
      );
      assert.ok(local.every((ref) => ref.commitId && !ref.tracked));
    });

    test("nearest bookmarked commit yields unquoted names", async () => {
      const output = await runJJ(repoPath, [
        "log",
        "--no-graph",
        "-r",
        "@",
        "-T",
        parsers.BOOKMARKED_COMMIT_TEMPLATE,
      ]);
      assert.deepStrictEqual(parsers.parseBookmarkedCommit(output)?.bookmarks, [
        "fix/trailing-",
        "plain",
      ]);
    });
  });

  suite("parsers", () => {
    test("parseBookmarkRefs reads tracking counts", () => {
      assert.deepStrictEqual(
        parsers.parseBookmarkRefs(
          "main\torigin\tabc\t1\t2\t3\nmain\t\tabc\t0\t\t\n",
        ),
        [
          {
            name: "main",
            remote: "origin",
            commitId: "abc",
            tracked: true,
            remoteAheadCount: 2,
            remoteBehindCount: 3,
          },
          {
            name: "main",
            remote: undefined,
            commitId: "abc",
            tracked: false,
            remoteAheadCount: undefined,
            remoteBehindCount: undefined,
          },
        ],
      );
    });

    test("parseGitRemotes reads names and urls", () => {
      assert.deepStrictEqual(
        parsers.parseGitRemotes(
          "origin https://github.com/a/b.git\nfork git@github.com:c/b.git\n",
        ),
        [
          { name: "origin", url: "https://github.com/a/b.git" },
          { name: "fork", url: "git@github.com:c/b.git" },
        ],
      );
    });

    test("parseGitLog reads multi-line messages and parents", () => {
      const record = (hash: string, parents: string, body: string) =>
        [
          hash,
          "Ada",
          "ada@example.com",
          "1700000000",
          "1700000060",
          parents,
          body,
        ].join("\0");
      const commits = prs.parseGitLog(
        `${record("a1", "p1 p2", "subject\n\nbody\n")}\x1e\n${record("b2", "", "root\n")}\x1e\n`,
      );
      assert.deepStrictEqual(
        commits.map((commit) => [commit.hash, commit.message, commit.parents]),
        [
          ["a1", "subject\n\nbody", ["p1", "p2"]],
          ["b2", "root", []],
        ],
      );
      assert.strictEqual(commits[0].authorDate?.getTime(), 1700000000 * 1000);
    });

    test("parseGitConfigList splits keys from multi-line values", () => {
      assert.deepStrictEqual(
        prs.parseGitConfigList("user.name\nAda\0core.bare\nfalse\0flag\0"),
        [
          { key: "user.name", value: "Ada" },
          { key: "core.bare", value: "false" },
          { key: "flag", value: "" },
        ],
      );
    });

    test("parseLsTree reads blob details", () => {
      assert.deepStrictEqual(
        prs.parseLsTree("100644 blob c4e1ef3d   10572\tsrc/main.ts\n"),
        { mode: "100644", object: "c4e1ef3d", size: 10572 },
      );
      assert.strictEqual(prs.parseLsTree(""), undefined);
    });

    test("parseNameStatus reads modifications and renames", () => {
      const changes = prs.parseNameStatus(
        "M\0src/a.ts\0A\0src/b.ts\0R100\0old.ts\0new.ts\0",
        "/repo",
      );
      assert.deepStrictEqual(
        changes.map((change) => [
          change.status,
          change.originalUri.fsPath,
          change.uri.fsPath,
        ]),
        [
          [
            prs.Status.MODIFIED,
            path.join("/repo", "src/a.ts"),
            path.join("/repo", "src/a.ts"),
          ],
          [
            prs.Status.INDEX_ADDED,
            path.join("/repo", "src/b.ts"),
            path.join("/repo", "src/b.ts"),
          ],
          [
            prs.Status.INDEX_RENAMED,
            path.join("/repo", "old.ts"),
            path.join("/repo", "new.ts"),
          ],
        ],
      );
    });

    test("parseFetchRef splits refspecs", () => {
      assert.deepStrictEqual(prs.parseFetchRef("feature"), {
        remoteBranch: "feature",
        localBranch: undefined,
      });
      assert.deepStrictEqual(prs.parseFetchRef("refs/heads/feature:pr/ada/1"), {
        remoteBranch: "feature",
        localBranch: "pr/ada/1",
      });
    });
  });

  suite("branches", () => {
    const bookmarks = [
      bookmark({ name: "feature", commitId: "local" }),
      bookmark({
        name: "feature",
        remote: "origin",
        commitId: "remote",
        tracked: true,
        remoteAheadCount: 2,
        remoteBehindCount: 1,
      }),
      bookmark({
        name: "feature",
        remote: "git",
        commitId: "local",
        tracked: true,
      }),
      bookmark({ name: "untracked", commitId: "u" }),
      bookmark({
        name: "main",
        remote: "origin",
        commitId: "m",
        tracked: true,
      }),
    ];

    test("toBranch reports git-style ahead and behind against the upstream", () => {
      assert.deepStrictEqual(prs.toBranch(bookmarks, "feature", "local"), {
        type: prs.RefType.Head,
        name: "feature",
        commit: "local",
        upstream: { remote: "origin", name: "feature" },
        ahead: 1,
        behind: 2,
      });
      assert.deepStrictEqual(prs.toBranch(bookmarks, "untracked", "u"), {
        type: prs.RefType.Head,
        name: "untracked",
        commit: "u",
      });
    });

    test("selectHeadBranch prefers a bookmark tracking a remote", () => {
      const head = prs.selectHeadBranch(
        bookmarks,
        { commitId: "local", bookmarks: ["untracked", "feature"] },
        undefined,
      );
      assert.strictEqual(head.name, "feature");
    });

    test("selectHeadBranch falls back to a detached head", () => {
      assert.deepStrictEqual(
        prs.selectHeadBranch(bookmarks, undefined, "parent"),
        {
          type: prs.RefType.Head,
          commit: "parent",
        },
      );
    });

    test("findBranch resolves local, qualified and remote names", () => {
      const head = { type: prs.RefType.Head, name: "feature" };
      assert.strictEqual(prs.findBranch(bookmarks, head, "HEAD"), head);
      assert.strictEqual(
        prs.findBranch(bookmarks, head, "refs/heads/feature")?.commit,
        "local",
      );
      assert.deepStrictEqual(
        prs.findBranch(bookmarks, head, "refs/remotes/origin/feature"),
        {
          type: prs.RefType.RemoteHead,
          name: "origin/feature",
          remote: "origin",
          commit: "remote",
        },
      );
      assert.strictEqual(
        prs.findBranch(bookmarks, head, "origin/main")?.commit,
        "m",
      );
      assert.strictEqual(prs.findBranch(bookmarks, head, "missing"), undefined);
    });

    test("parseRemoteRef handles branch names containing slashes", () => {
      assert.deepStrictEqual(
        prs.parseRemoteRef(bookmarks, "refs/remotes/origin/fix/new-thing"),
        { remote: "origin", name: "fix/new-thing" },
      );
      assert.strictEqual(prs.parseRemoteRef(bookmarks, "feature"), undefined);
    });

    test("listRefs excludes the git pseudo remote", () => {
      assert.deepStrictEqual(
        prs.listRefs(bookmarks, true, true).map((ref) => ref.name),
        ["feature", "origin/feature", "untracked", "origin/main"],
      );
    });
  });
});
