/**
 * Pipeline service entry points shared by the routes, the boot sequence and tests.
 *
 * ⚠️ Every pipeline cache is module-level. Test files MUST call
 * `beforeEach(invalidatePipelineCaches)` — the documented cross-test cache-pollution class.
 */
import { invalidatePipelineSettings } from "./settings";
import { invalidatePipelineAccess } from "./access";
import { invalidatePhases, resetBoardStateForTests } from "./board";
import { resetPipelineSchemaCheck } from "./self-check";
import { resetPipelineBulkheadForTests } from "./tx";

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
