/**
 * Pipeline service entry points shared by the routes, the boot sequence and tests.
 *
 * ⚠️ Every pipeline cache is module-level. Test files MUST call
 * `beforeEach(invalidatePipelineCaches)` — the documented cross-test cache-pollution class —
 * or `resetPipelineStateForTests()` when they also exercise the bulkhead or board bumps.
 */
import { invalidatePipelineSettings } from "./settings";
import { invalidatePipelineAccess } from "./access";
import { invalidatePhases, resetBoardStateForTests } from "./board";
import { resetPipelineSchemaCheck } from "./self-check";
import { resetPipelineBulkheadForTests } from "./tx";
import { installPipelineNotifier } from "./notify";

// The real notifier replaces the PR 7/8 no-op seam as soon as the pipeline services load.
installPipelineNotifier();

/**
 * Drop every memo: settings, access, directory and phases, and the schema verdict (the
 * next gated request re-runs the cheap self-check). Safe in production.
 */
export function invalidatePipelineCaches(): void {
  invalidatePipelineSettings();
  invalidatePipelineAccess();
  invalidatePhases();
  resetPipelineSchemaCheck();
}

/** Tests only: caches, the bulkhead and the pending board-bump flag. */
export function resetPipelineStateForTests(): void {
  invalidatePipelineCaches();
  resetPipelineBulkheadForTests();
  resetBoardStateForTests();
}

export { resetPipelineBulkheadForTests };
export { startPipelineSelfCheck } from "./self-check";
