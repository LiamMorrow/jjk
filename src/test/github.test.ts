import * as assert from "assert";
import { getExtensionAPI } from "./extensionApi";
import type * as GitHubModule from "../github";
import type * as LineDiffUtilsModule from "../lineDiffUtils";
import type { LinesDiff } from "../vendor/vscode/editor/common/diff/linesDiffComputer";

const lineRange = (
  startLineNumber: number,
  endLineNumberExclusive: number,
) => ({
  startLineNumber,
  endLineNumberExclusive,
});

const linesDiff = (
  changes: {
    original: [number, number];
    modified: [number, number];
  }[],
) =>
  ({
    changes: changes.map((change) => ({
      original: lineRange(...change.original),
      modified: lineRange(...change.modified),
    })),
  }) as unknown as LinesDiff;

suite("github", () => {
  let github: typeof GitHubModule;
  let lineDiffUtils: typeof LineDiffUtilsModule;

  suiteSetup(async () => {
    ({ github, lineDiffUtils } = await getExtensionAPI());
  });

  suite("parseGitHubRemote", () => {
    const parse = (url: string) =>
      github.parseGitHubRemote({ name: "origin", url });

    test("parses https remotes with and without .git", () => {
      for (const url of [
        "https://github.com/keanemind/jjk",
        "https://github.com/keanemind/jjk.git",
        "https://user@github.com/keanemind/jjk/",
      ]) {
        assert.deepStrictEqual(parse(url), {
          owner: "keanemind",
          name: "jjk",
          remote: "origin",
          url: "https://github.com/keanemind/jjk",
        });
      }
    });

    test("parses ssh remotes and keeps dots in repository names", () => {
      assert.strictEqual(
        parse("git@github.com:owner/repo.js.git")?.name,
        "repo.js",
      );
      assert.strictEqual(
        parse("ssh://git@github.com/owner/repo")?.owner,
        "owner",
      );
    });

    test("ignores non-GitHub remotes", () => {
      assert.strictEqual(parse("https://gitlab.com/owner/repo.git"), undefined);
    });
  });

  suite("linkifyIssueReferences", () => {
    const repo = {
      owner: "keanemind",
      name: "jjk",
      remote: "origin",
      url: "https://github.com/keanemind/jjk",
    };

    test("links local and cross-repository references", () => {
      assert.strictEqual(
        github.linkifyIssueReferences(
          "fix crash (#955), see other/repo#3",
          repo,
        ),
        "fix crash ([#955](https://github.com/keanemind/jjk/issues/955)), see [other/repo#3](https://github.com/other/repo/issues/3)",
      );
    });

    test("leaves references inside words, entities and existing links alone", () => {
      const text = "abc#4 &#39; [#5](https://example.com)";
      assert.strictEqual(github.linkifyIssueReferences(text, repo), text);
    });
  });

  suite("findPullRequestNumberInMessage", () => {
    test("detects squash and merge commit subjects", () => {
      assert.strictEqual(
        github.findPullRequestNumberInMessage(
          "rewrite with effect-ts (#274)\n\nbody",
        ),
        274,
      );
      assert.strictEqual(
        github.findPullRequestNumberInMessage(
          "Merge pull request #12 from owner/branch",
        ),
        12,
      );
    });

    test("ignores references outside the subject line", () => {
      assert.strictEqual(
        github.findPullRequestNumberInMessage("fix bug\n\nCloses #3 (#4)"),
        undefined,
      );
    });
  });

  suite("permalinkUrl", () => {
    const repo = {
      owner: "owner",
      name: "repo",
      remote: "origin",
      url: "https://github.com/owner/repo",
    };

    test("builds file, line and range links", () => {
      assert.strictEqual(
        github.permalinkUrl(repo, "abc", "src/a b.ts"),
        "https://github.com/owner/repo/blob/abc/src/a%20b.ts",
      );
      assert.strictEqual(
        github.permalinkUrl(repo, "abc", "src/a.ts", { start: 3, end: 3 }),
        "https://github.com/owner/repo/blob/abc/src/a.ts#L3",
      );
      assert.strictEqual(
        github.permalinkUrl(repo, "abc", "src/a.ts", { start: 3, end: 5 }),
        "https://github.com/owner/repo/blob/abc/src/a.ts#L3-L5",
      );
    });

    test("uses plain view for line links into markdown", () => {
      assert.strictEqual(
        github.permalinkUrl(repo, "abc", "README.md", { start: 1, end: 2 }),
        "https://github.com/owner/repo/blob/abc/README.md?plain=1#L1-L2",
      );
    });
  });

  suite("mapModifiedLineToOriginal", () => {
    test("shifts lines after an insertion", () => {
      const diff = linesDiff([{ original: [2, 2], modified: [2, 4] }]);
      assert.deepStrictEqual(
        [1, 2, 3, 4, 5].map((line) =>
          lineDiffUtils.mapModifiedLineToOriginal(diff, line),
        ),
        [1, 2, 2, 2, 3],
      );
    });

    test("shifts lines after a deletion", () => {
      const diff = linesDiff([{ original: [2, 4], modified: [2, 2] }]);
      assert.deepStrictEqual(
        [1, 2, 3].map((line) =>
          lineDiffUtils.mapModifiedLineToOriginal(diff, line),
        ),
        [1, 4, 5],
      );
    });

    test("maps lines inside a modified block onto the original block", () => {
      const diff = linesDiff([{ original: [3, 4], modified: [3, 6] }]);
      assert.deepStrictEqual(
        [3, 4, 5, 6].map((line) =>
          lineDiffUtils.mapModifiedLineToOriginal(diff, line),
        ),
        [3, 3, 3, 4],
      );
    });
  });
});
