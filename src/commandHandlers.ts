import type { GlobalCommandHandlers, InitCommandHandlers } from "./commands";
import type { CommandHandlerDeps } from "./commandHandlerShared";
import { createChangeActionInitHandlers } from "./changeActionCommandHandlers";
import {
  createNavigationInitHandlers,
  createWorkspaceCommandHandlers,
} from "./navigationCommandHandlers";
import { createSelectionSquashInitHandlers } from "./selectionSquashCommandHandlers";
import { createRevertChangeInitHandlers } from "./revertChangeCommandHandlers";

export type { CommandHandlerDeps } from "./commandHandlerShared";

export const createInitCommandHandlers = (
  deps: CommandHandlerDeps,
): InitCommandHandlers => ({
  ...createChangeActionInitHandlers(deps),
  ...createNavigationInitHandlers(deps),
  ...createSelectionSquashInitHandlers(deps),
  ...createRevertChangeInitHandlers(deps),
});

export const createGlobalCommandHandlers = (
  deps: CommandHandlerDeps,
): GlobalCommandHandlers => createWorkspaceCommandHandlers(deps);
