import { Effect } from "effect";
import type { InitCommandHandlers } from "./commands";
import type { CommandHandlerDeps } from "./commandHandlerShared";
import { readRepoState } from "./commandHandlerShared";
import { showQuickPick } from "./services/Vscode";
import type { RepoCommandEffect } from "./commandHandlerShared";
import { combineDescriptions, editDescription } from "./descriptionEditor";
import {
  getShow,
  jjDescribe,
  jjEdit,
  jjNew,
  jjRestore,
  jjSquash,
} from "./services/Repository";
import type { FileStatus, RepositoryConfig } from "./types";
import { pathEquals } from "./utils";

const maybePromptForSquashMessage = (
  config: RepositoryConfig,
  shouldPrompt: boolean,
  sourceRev: string,
  destinationRev: string,
): RepoCommandEffect<{
  readonly cancelled: boolean;
  readonly message: string | undefined;
}> =>
  Effect.gen(function* () {
    if (!shouldPrompt) {
      return { cancelled: false, message: undefined } as const;
    }

    const [source, destination] = yield* Effect.all([
      getShow(config, sourceRev),
      getShow(config, destinationRev),
    ]);
    const message = yield* editDescription({
      fileName: "squash.jjdescription",
      initialDescription: combineDescriptions(
        destination.change.description,
        source.change.description,
      ),
      instructions: [
        "Enter a description for the combined change.",
        "Save and close this tab to squash. Leave it empty to cancel.",
      ],
    });
    return message === ""
      ? ({ cancelled: true, message: undefined } as const)
      : ({ cancelled: false, message } as const);
  });

export const createChangeActionInitHandlers = (
  deps: CommandHandlerDeps,
): Pick<
  InitCommandHandlers,
  | "newChange"
  | "restoreResourceState"
  | "squashToParentResourceState"
  | "squashToWorkingCopyResourceState"
  | "describeChange"
  | "squashToParentResourceGroup"
  | "squashToWorkingCopyResourceGroup"
  | "restoreResourceGroup"
  | "editResourceGroup"
> => ({
  newChange: (sourceControl) => {
    const repo = deps.repoLocator.findRepoBySourceControl(sourceControl);
    if (!repo) {
      return;
    }

    const message = sourceControl.inputBox.value.trim() || undefined;
    return deps.runRepoCommand(
      repo,
      jjNew(repo.config, message).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            sourceControl.inputBox.value = "";
          }),
        ),
      ),
      "Failed to create change",
    );
  },
  restoreResourceState: (...resourceStates) => {
    const resourceGroup =
      deps.repoLocator.getSharedResourceGroup(resourceStates);
    const repo = deps.repoLocator.findRepoByResourceGroup(resourceGroup);
    if (!repo) {
      return;
    }

    return deps.runRepoCommand(
      repo,
      deps.withSourceControlProgress(
        Effect.gen(function* () {
          const state = readRepoState(repo);

          let statuses: FileStatus[];
          if (repo.workingCopyGroup === resourceGroup) {
            if (!state.status) {
              return;
            }
            statuses = resourceStates.map((resourceState) => {
              const found = state.status?.fileStatuses.find((status) =>
                pathEquals(status.path, resourceState.resourceUri.fsPath),
              );
              if (!found) {
                throw new Error("No file status found");
              }
              return found;
            });
          } else {
            const show = state.parentShowResults.get(resourceGroup.id);
            if (!show) {
              return;
            }
            statuses = resourceStates.map((resourceState) => {
              const found = show.fileStatuses.find((status) =>
                pathEquals(status.path, resourceState.resourceUri.fsPath),
              );
              if (!found) {
                throw new Error("No file status found");
              }
              return found;
            });
          }

          const paths = statuses.flatMap((status) => [
            status.path,
            ...(status.renamedFrom ? [status.renamedFrom] : []),
          ]);

          yield* deps.retryImmutable(
            jjRestore(repo.config, resourceGroup.id, paths),
            `${resourceGroup.id} is immutable, are you sure?`,
            jjRestore(repo.config, resourceGroup.id, paths, true),
          );
        }),
      ),
      "Failed to restore",
    );
  },
  squashToParentResourceState: (...resourceStates) => {
    const resourceGroup =
      deps.repoLocator.getSharedResourceGroup(resourceStates);
    const repo = deps.repoLocator.findRepoByResourceGroup(resourceGroup);
    if (!repo) {
      return;
    }

    return deps.runRepoCommand(
      repo,
      deps.withSourceControlProgress(
        Effect.gen(function* () {
          const state = readRepoState(repo);
          if (!state.status) {
            return;
          }

          let destinationParentChange = state.status.parentChanges[0];
          if (state.status.parentChanges.length > 1) {
            const parentOptions = state.status.parentChanges.map((parent) => ({
              label: parent.changeId,
              description: parent.description || "(no description)",
              parent,
            }));
            const selection = yield* showQuickPick(parentOptions, {
              placeHolder: "Select parent to squash into",
            });
            if (!selection) {
              return;
            }
            destinationParentChange = selection.parent;
          } else if (state.status.parentChanges.length === 0) {
            return;
          }

          const promptResult = yield* maybePromptForSquashMessage(
            repo.config,
            resourceGroup.resourceStates.length === resourceStates.length &&
              state.status.workingCopy.description !== "" &&
              destinationParentChange.description !== "",
            "@",
            destinationParentChange.changeId,
          );
          if (promptResult.cancelled) {
            return;
          }

          yield* deps.retryImmutable(
            jjSquash(repo.config, {
              fromRev: "@",
              toRev: destinationParentChange.changeId,
              message: promptResult.message,
              filepaths: resourceStates.map(
                (resourceState) => resourceState.resourceUri.fsPath,
              ),
            }),
            `${destinationParentChange.changeId} is immutable, are you sure?`,
            jjSquash(repo.config, {
              fromRev: "@",
              toRev: destinationParentChange.changeId,
              message: promptResult.message,
              filepaths: resourceStates.map(
                (resourceState) => resourceState.resourceUri.fsPath,
              ),
              ignoreImmutable: true,
            }),
          );
        }),
      ),
      "Failed to squash",
    );
  },
  squashToWorkingCopyResourceState: (...resourceStates) => {
    const resourceGroup =
      deps.repoLocator.getSharedResourceGroup(resourceStates);
    const repo = deps.repoLocator.findRepoByResourceGroup(resourceGroup);
    if (!repo) {
      return;
    }

    return deps.runRepoCommand(
      repo,
      deps.withSourceControlProgress(
        Effect.gen(function* () {
          const state = readRepoState(repo);
          if (!state.status) {
            return;
          }

          const parentChange = state.status.parentChanges.find(
            (change) => change.changeId === resourceGroup.id,
          );
          if (!parentChange) {
            return;
          }

          const promptResult = yield* maybePromptForSquashMessage(
            repo.config,
            resourceGroup.resourceStates.length === resourceStates.length &&
              state.status.workingCopy.description !== "" &&
              parentChange.description !== "",
            resourceGroup.id,
            "@",
          );
          if (promptResult.cancelled) {
            return;
          }

          yield* deps.retryImmutable(
            jjSquash(repo.config, {
              fromRev: resourceGroup.id,
              toRev: "@",
              message: promptResult.message,
              filepaths: resourceStates.map(
                (resourceState) => resourceState.resourceUri.fsPath,
              ),
            }),
            `${resourceGroup.id} is immutable, are you sure?`,
            jjSquash(repo.config, {
              fromRev: resourceGroup.id,
              toRev: "@",
              message: promptResult.message,
              filepaths: resourceStates.map(
                (resourceState) => resourceState.resourceUri.fsPath,
              ),
              ignoreImmutable: true,
            }),
          );
        }),
      ),
      "Failed to squash",
    );
  },
  describeChange: (resourceGroup) => {
    const repo = deps.repoLocator.findRepoByResourceGroup(resourceGroup);
    if (!repo) {
      return;
    }

    return deps.runRepoCommand(
      repo,
      Effect.gen(function* () {
        const showResult = yield* getShow(repo.config, resourceGroup.id);
        const currentDescription = showResult.change.description.trim();
        const message = yield* editDescription({
          fileName: "describe.jjdescription",
          initialDescription: currentDescription,
          instructions: [
            `Enter a description for ${showResult.change.changeId.substring(0, 8)}.`,
            "Save and close this tab to apply.",
          ],
        });
        if (message === currentDescription) {
          return;
        }

        yield* deps.retryImmutable(
          jjDescribe(repo.config, resourceGroup.id, message),
          `${resourceGroup.id} is immutable, are you sure?`,
          jjDescribe(repo.config, resourceGroup.id, message, true),
        );
      }),
      "Failed to update description",
    );
  },
  squashToParentResourceGroup: (resourceGroup) => {
    const repo = deps.repoLocator.findRepoByResourceGroup(resourceGroup);
    if (!repo) {
      return;
    }

    return deps.runRepoCommand(
      repo,
      deps.withSourceControlProgress(
        Effect.gen(function* () {
          const state = readRepoState(repo);
          if (!state.status) {
            return;
          }

          let destinationParentChange = state.status.parentChanges[0];
          if (state.status.parentChanges.length > 1) {
            const parentOptions = state.status.parentChanges.map((parent) => ({
              label: parent.changeId,
              description: parent.description || "(no description)",
              parent,
            }));
            const selection = yield* showQuickPick(parentOptions, {
              placeHolder: "Select parent to squash into",
            });
            if (!selection) {
              return;
            }
            destinationParentChange = selection.parent;
          } else if (state.status.parentChanges.length === 0) {
            return;
          }

          const promptResult = yield* maybePromptForSquashMessage(
            repo.config,
            state.status.workingCopy.description !== "" &&
              destinationParentChange.description !== "",
            "@",
            destinationParentChange.changeId,
          );
          if (promptResult.cancelled) {
            return;
          }

          yield* deps.retryImmutable(
            jjSquash(repo.config, {
              fromRev: "@",
              toRev: destinationParentChange.changeId,
              message: promptResult.message,
            }),
            `${destinationParentChange.changeId} is immutable, are you sure?`,
            jjSquash(repo.config, {
              fromRev: "@",
              toRev: destinationParentChange.changeId,
              message: promptResult.message,
              ignoreImmutable: true,
            }),
          );
        }),
      ),
      "Failed to squash",
    );
  },
  squashToWorkingCopyResourceGroup: (resourceGroup) => {
    const repo = deps.repoLocator.findRepoByResourceGroup(resourceGroup);
    if (!repo) {
      return;
    }

    return deps.runRepoCommand(
      repo,
      deps.withSourceControlProgress(
        Effect.gen(function* () {
          const state = readRepoState(repo);
          if (!state.status) {
            return;
          }

          const parentChange = state.status.parentChanges.find(
            (change) => change.changeId === resourceGroup.id,
          );
          if (!parentChange) {
            return;
          }

          const promptResult = yield* maybePromptForSquashMessage(
            repo.config,
            state.status.workingCopy.description !== "" &&
              parentChange.description !== "",
            resourceGroup.id,
            "@",
          );
          if (promptResult.cancelled) {
            return;
          }

          yield* deps.retryImmutable(
            jjSquash(repo.config, {
              fromRev: resourceGroup.id,
              toRev: "@",
              message: promptResult.message,
            }),
            `${resourceGroup.id} is immutable, are you sure?`,
            jjSquash(repo.config, {
              fromRev: resourceGroup.id,
              toRev: "@",
              message: promptResult.message,
              ignoreImmutable: true,
            }),
          );
        }),
      ),
      "Failed to squash",
    );
  },
  restoreResourceGroup: (resourceGroup) => {
    const repo = deps.repoLocator.findRepoByResourceGroup(resourceGroup);
    if (!repo) {
      return;
    }

    return deps.runRepoCommand(
      repo,
      deps.withSourceControlProgress(
        deps.retryImmutable(
          jjRestore(repo.config, resourceGroup.id, undefined),
          `${resourceGroup.id} is immutable, are you sure?`,
          jjRestore(repo.config, resourceGroup.id, undefined, true),
        ),
      ),
      "Failed to restore",
    );
  },
  editResourceGroup: (resourceGroup) => {
    const repo = deps.repoLocator.findRepoByResourceGroup(resourceGroup);
    if (!repo) {
      return;
    }

    return deps.runRepoCommand(
      repo,
      deps.retryImmutable(
        jjEdit(repo.config, resourceGroup.id),
        `${resourceGroup.id} is immutable, are you sure?`,
        jjEdit(repo.config, resourceGroup.id, true),
      ),
      "Failed to switch to change",
    );
  },
});
