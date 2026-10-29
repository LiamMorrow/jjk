import * as vscode from "vscode";
import path from "path";
import { Effect, Option } from "effect";
import {
  getActiveTextEditor,
  openExternal,
  showErrorMessage,
  showInformationMessage,
  writeClipboard,
  type Vscode,
} from "./services/Vscode";
import { getOriginalPath, getPathAtRev, readFile } from "./services/Repository";
import type { InitCommandHandlers } from "./commands";
import type { CommandHandlerDeps } from "./commandHandlerShared";
import { findPushedAncestors, permalinkUrl } from "./github";
import { mapModifiedLineToOriginal } from "./lineDiffUtils";
import { linesDiffComputers } from "./vendor/vscode/editor/common/diff/linesDiffComputers";
import { getContentRev, getParams } from "./uri";

const toLines = (text: string) => text.split(/\r?\n/);

const getSelectedLines = (editor: vscode.TextEditor) => {
  const { start, end } = editor.selection;
  const endLine =
    end.line > start.line && end.character === 0 ? end.line - 1 : end.line;
  return { start: start.line + 1, end: endLine + 1 };
};

const copyGitHubPermalinkEffect = (
  deps: CommandHandlerDeps,
  uri: vscode.Uri | undefined,
  includeLines: boolean,
): Effect.Effect<void, Error, Vscode> =>
  Effect.gen(function* () {
    const editor = yield* getActiveTextEditor();
    const targetUri = uri ?? editor?.document.uri;
    if (!targetUri || !["file", "jj"].includes(targetUri.scheme)) {
      return;
    }

    const repo = deps.repoLocator.findRepoByUri(targetUri);
    if (!repo) {
      yield* showErrorMessage("This file is not in a Jujutsu repository.");
      return;
    }

    const rev = getContentRev(targetUri);
    const params = targetUri.scheme === "jj" ? getParams(targetUri) : undefined;
    const filePath = yield* deps.runRepoEffect(
      repo,
      params && "diffOriginalRev" in params
        ? getOriginalPath(repo.config, params.diffOriginalRev, targetUri.fsPath)
        : Effect.succeed(targetUri.fsPath),
    );

    const ancestors = yield* deps.runRepoEffect(
      repo,
      findPushedAncestors(repo.config, rev),
    );
    if (ancestors.length === 0) {
      yield* showErrorMessage("This repository has no GitHub remotes.");
      return;
    }
    const pushed = ancestors.find((ancestor) => ancestor.commitId);
    if (!pushed?.commitId) {
      yield* showErrorMessage(
        "No ancestor of this revision has been pushed to GitHub.",
      );
      return;
    }
    const commitId = pushed.commitId;

    const pathAtCommit = yield* deps.runRepoEffect(
      repo,
      getPathAtRev(repo.config, commitId, rev, filePath),
    );
    const relativePath = path.relative(
      repo.config.repositoryRoot,
      pathAtCommit,
    );
    const pushedContent = yield* deps
      .runRepoEffect(repo, readFile(repo.config, commitId, pathAtCommit))
      .pipe(Effect.option);
    if (Option.isNone(pushedContent)) {
      yield* showErrorMessage(
        `${relativePath} has not been pushed to ${pushed.repo.owner}/${pushed.repo.name}.`,
      );
      return;
    }

    const lineEditor =
      includeLines &&
      editor &&
      editor.document.uri.toString() === targetUri.toString()
        ? editor
        : undefined;
    const lines = lineEditor
      ? yield* Effect.sync(() => {
          const diff = linesDiffComputers
            .getDefault()
            .computeDiff(
              toLines(pushedContent.value.toString()),
              toLines(lineEditor.document.getText()),
              {
                ignoreTrimWhitespace: false,
                maxComputationTimeMs: 1000,
                computeMoves: false,
              },
            );
          const selected = getSelectedLines(lineEditor);
          const start = mapModifiedLineToOriginal(diff, selected.start);
          const end = mapModifiedLineToOriginal(diff, selected.end);
          return { start, end: Math.max(start, end) };
        })
      : undefined;

    const url = permalinkUrl(pushed.repo, commitId, relativePath, lines);
    yield* writeClipboard(url);
    const choice = yield* showInformationMessage(
      `Copied GitHub permalink for ${pushed.repo.owner}/${pushed.repo.name}@${commitId.substring(0, 8)}`,
      "Open",
    );
    if (choice === "Open") {
      yield* openExternal(vscode.Uri.parse(url, true));
    }
  });

export const createGitHubInitHandlers = (
  deps: CommandHandlerDeps,
): Pick<
  InitCommandHandlers,
  "copyGitHubPermalink" | "copyGitHubFilePermalink"
> => ({
  copyGitHubPermalink: (uri) => {
    deps.dispatchExtensionEffect(
      copyGitHubPermalinkEffect(deps, uri, true),
      "Failed to copy GitHub permalink",
    );
  },
  copyGitHubFilePermalink: (uri) => {
    deps.dispatchExtensionEffect(
      copyGitHubPermalinkEffect(deps, uri, false),
      "Failed to copy GitHub permalink",
    );
  },
});
