import * as vscode from "vscode";
import { Effect } from "effect";
import {
  applyWorkspaceEdit,
  getVisibleTextEditors,
  openTextDocument,
  saveTextDocument,
  showErrorMessage,
  type Vscode,
} from "./services/Vscode";
import type { InitCommandHandlers } from "./commands";
import type { CommandHandlerDeps } from "./commandHandlerShared";
import { applyLineChanges, type LineChange } from "./lineDiffUtils";
import { provideOriginalResource } from "./jjUtils";

const revertChangeEffect = (
  deps: CommandHandlerDeps,
  uri: vscode.Uri,
  changes: readonly LineChange[],
  index: number,
): Effect.Effect<void, Error, Vscode> =>
  Effect.gen(function* () {
    const change = changes[index];
    if (uri.scheme !== "file" || !change) {
      return;
    }

    if (!deps.repoLocator.findRepoByUri(uri)) {
      return;
    }

    const originalUri = provideOriginalResource(uri);
    if (!originalUri) {
      return;
    }

    const editor = (yield* getVisibleTextEditors()).find(
      (candidate) => candidate.document.uri.toString() === uri.toString(),
    );
    if (!editor) {
      return;
    }

    const modifiedDocument = editor.document;
    const originalDocument = yield* openTextDocument(originalUri);
    const reverted = applyLineChanges(originalDocument, modifiedDocument, [
      ...changes.slice(0, index),
      ...changes.slice(index + 1),
    ]);

    const visibleRange = editor.visibleRanges[0];
    const edit = new vscode.WorkspaceEdit();
    edit.replace(
      uri,
      new vscode.Range(
        new vscode.Position(0, 0),
        modifiedDocument.lineAt(modifiedDocument.lineCount - 1).range.end,
      ),
      reverted,
    );

    if (!(yield* applyWorkspaceEdit(edit))) {
      yield* showErrorMessage("Failed to revert change.");
      return;
    }
    yield* saveTextDocument(modifiedDocument);

    const line = change.modifiedStartLineNumber;
    editor.selections = [new vscode.Selection(line, 0, line, 0)];
    if (visibleRange) {
      editor.revealRange(visibleRange);
    }
  });

export const createRevertChangeInitHandlers = (
  deps: CommandHandlerDeps,
): Pick<InitCommandHandlers, "revertChange"> => ({
  revertChange: (uri, changes, index) => {
    if (!uri) {
      return;
    }
    deps.dispatchExtensionEffect(
      revertChangeEffect(deps, uri, changes, index),
      "Failed to revert change",
    );
  },
});
