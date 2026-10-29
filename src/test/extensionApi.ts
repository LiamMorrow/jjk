import * as assert from "assert";
import * as vscode from "vscode";
import type { WorkspaceSourceControlManager } from "../repoHandle";
import type * as UriModule from "../uri";
import type * as GraphWebviewModule from "../graphWebview";
import type * as GitHubModule from "../github";
import type * as GitHubPullRequestsModule from "../githubPullRequests";
import type * as DescriptionEditorModule from "../descriptionEditor";
import type * as LineDiffUtilsModule from "../lineDiffUtils";
import type * as ParsersModule from "../parsers";

type ExtensionAPI = {
  workspaceSCM: WorkspaceSourceControlManager;
  uri: typeof UriModule;
  repository: {
    parseRenamePaths: (
      input: string,
    ) => { fromPath: string; toPath: string } | null;
    resolveRepoPath: (workspaceRoot: string) => string;
    fakeEditorPath: string;
    ImmutableError: new (message: string) => Error;
  };
  graphWebview: typeof GraphWebviewModule;
  github: typeof GitHubModule;
  githubPullRequests: typeof GitHubPullRequestsModule;
  descriptionEditor: typeof DescriptionEditorModule;
  lineDiffUtils: typeof LineDiffUtilsModule;
  parsers: typeof ParsersModule;
};

export async function getExtensionAPI(): Promise<ExtensionAPI> {
  const extension = vscode.extensions.getExtension<ExtensionAPI>("jjk.jj-code");
  assert.ok(extension, "Extension not found");
  if (!extension.isActive) {
    return extension.activate();
  }
  return extension.exports;
}
