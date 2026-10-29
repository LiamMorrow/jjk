import * as vscode from "vscode";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { Effect } from "effect";

export interface DescriptionEditorOptions {
  readonly fileName: string;
  readonly initialDescription: string;
  readonly instructions: readonly string[];
}

const toError = (cause: unknown): Error =>
  cause instanceof Error ? cause : new Error(String(cause));

export const stripDescriptionComments = (text: string) =>
  text
    .split(/\r?\n/)
    .filter((line) => !line.startsWith("JJ:"))
    .join("\n")
    .trim();

export const combineDescriptions = (
  destination: string,
  source: string,
): string =>
  [destination.trim(), source.trim()]
    .filter((description) => description !== "")
    .join("\n\n");

export const buildDescriptionFile = (
  description: string,
  instructions: readonly string[],
) =>
  [
    description,
    "",
    ...instructions.map((line) => `JJ: ${line}`),
    'JJ: Lines starting with "JJ:" are removed.',
    "",
  ].join("\n");

const isTabOpen = (uri: vscode.Uri) =>
  vscode.window.tabGroups.all.some((group) =>
    group.tabs.some(
      (tab) =>
        tab.input instanceof vscode.TabInputText &&
        tab.input.uri.toString() === uri.toString(),
    ),
  );

const waitForTabToClose = (uri: vscode.Uri) =>
  new Promise<void>((resolve) => {
    const subscription = vscode.window.tabGroups.onDidChangeTabs(() => {
      if (!isTabOpen(uri)) {
        subscription.dispose();
        resolve();
      }
    });
  });

export const editDescription = (
  options: DescriptionEditorOptions,
): Effect.Effect<string, Error> =>
  Effect.acquireUseRelease(
    Effect.tryPromise({
      try: () => fs.mkdtemp(path.join(os.tmpdir(), "jj-code-description-")),
      catch: toError,
    }),
    (directory) =>
      Effect.tryPromise({
        try: async () => {
          const filePath = path.join(directory, options.fileName);
          await fs.writeFile(
            filePath,
            buildDescriptionFile(
              options.initialDescription,
              options.instructions,
            ),
          );
          const uri = vscode.Uri.file(filePath);
          const document = await vscode.workspace.openTextDocument(uri);
          await vscode.window.showTextDocument(document, { preview: false });
          await waitForTabToClose(uri);
          return stripDescriptionComments(await fs.readFile(filePath, "utf8"));
        },
        catch: toError,
      }),
    (directory) =>
      Effect.promise(() => fs.rm(directory, { recursive: true, force: true })),
  );
