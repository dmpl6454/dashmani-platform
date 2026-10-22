// Creator-payout display logic for the staff pages. `_` keeps Next from routing it.
//
// The logic itself (statuses and what "Paid" means, hints, the queue's views, the action matrix, the timeline, the bank-reference check,
// how a failed money request is told apart from a refusal) is PURE and lives in packages/shared/src/payouts/staff-ui.ts, where
// apps/api's test suite can hold it against the engine's own rules (tests/payout-staff-ui-helpers.test.ts): apps/internal has no test
// runner. This file only re-exports it under the name the pages already import.
//
// ⚠️ THIS LOGIC DECIDES NOTHING ABOUT MONEY. The API's engine is the only thing that moves, holds, releases or reverses money, and it
// re-checks every condition on every click.
export * from "@dashmani/shared/src/payouts/staff-ui";
