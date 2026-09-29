/**
 * Pipeline service entry points shared by the routes, the boot sequence and tests.
 *
 * ⚠️ Every pipeline cache is module-level. Test files MUST call
 * `beforeEach(invalidatePipelineCaches)` — the documented cross-test cache-pollution class —
 * or `resetPipelineStateForTests()` when they also exercise the bulkhead or board bumps.
 */
import { invalidatePipelineSettings } from "./settings";
import { invalidatePipelineAccess } from "./access";
import { getBoardSnapshot, invalidatePhases, resetBoardStateForTests } from "./board";
import { resetPipelineSchemaCheck } from "./self-check";
import { resetPipelineBulkheadForTests } from "./tx";
import { installPipelineNotifier } from "./notify";
import { resetPipelineStatsForTests } from "./stats";
import { setBoardSnapshotProvider } from "./sync.service";

// The real notifier replaces the PR 7/8 no-op seam as soon as the pipeline services load.
installPipelineNotifier();
// The real board snapshot builder (route #6, §5.3) behind route #3's `board` field. Without
// it every board-mounted client gets `board: null` and its own v back forever — the HR
// board never leaves its loading skeleton.
setBoardSnapshotProvider(getBoardSnapshot);

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

/** Tests only: caches, the bulkhead, the pending board-bump flag and the stats window. */
export function resetPipelineStateForTests(): void {
  invalidatePipelineCaches();
  resetPipelineBulkheadForTests();
  resetBoardStateForTests();
  resetPipelineStatsForTests();
}

export { resetPipelineBulkheadForTests };
export { startPipelineSelfCheck } from "./self-check";
/** Boot only: the hourly `[pipeline] stats` line (spec §12 step 8). */
export { startPipelineStatsLog } from "./stats";
