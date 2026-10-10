# CAPEX centralized workflow integration

## Verified scope

The database inspected on 9 October 2026 has an active Capex flow for organization 20: mandatory ROLE GM at level 1, then mandatory ROLE CEO at level 2.

approval_master_details has approvertype, role, approvaltype and ismandatory, but no dedicated selected-user column. No active USER examples were found. Nonmandatory examples elsewhere do not establish their transition rules.

This workspace contains only the backend. The frontend and referenced screenshots were unavailable. UI wiring and USER/optional configuration contracts remain required before an end-to-end release.

## Migration and compatibility

Apply docs/migrations/capex-dynamic-workflow.sql before deploying this backend. It adds capex_workflow, capex_workflow_step and capex_workflow_action without backfilling existing requests. Rollback-only integration tests validate the migration but do not deploy it.

The migration was subsequently applied to the configured database on 9 October
2026. Existing CAPEX and approval rows were not converted or updated.

New requests require exactly one active CAPEX flow for their organization. Its master is locked while levels are copied in the request transaction. Later Builder edits/deactivation do not change these snapshots. Invalid configurations or roles with no eligible users reject creation instead of selecting defaults.

Existing requests without snapshots retain the legacy mutation processor and Capex_Approval_Config precedence. The read adapter projects existing role-column state without rewriting it. Retain legacy configuration and tables until pending requests finish or are explicitly migrated; do not edit legacy configuration during migration.

Once snapshot-based requests exist, rolling back to the old backend would lose their dynamic interpretation. Complete or explicitly migrate those requests first.

## Approval API

PUT /CapexApprovalSystem retains CapexID, Action, Remarks and Quantity. Add ApprovalStepID and Revision from the list/detail response. ApprovalStepID is required for repeated assignments; otherwise a single actionable assignment can be resolved. Revision detects stale actions.

APPROVE, REJECT, RETURN and HOLD remain supported. Nonapproval actions require remarks. Rejected/returned/held current stages can approve again. A previous approved stage can reject/return only while its immediate next stage is pending. Final approval means no unapproved snapshot step remains. Each action records previous/current status, actor, quantity, remarks and timestamp.

Authorization uses persisted active organization mappings and the existing SuperAdmin + AllOrganizationAccess rule. Organization access never substitutes for assignment eligibility. Creator/HOD/GM edit/delete permissions are checked independently.

## Frontend and response contract

Keep the existing design. List supplies ApprovalColumns with Key, Label and Level across all matching records, not only the current page. Render each column by matching its Key with Approvals.ColumnKey. A missing stage in a mixed-version row is not applicable, not Pending. Keys distinguish repeated stages and configuration revisions.

Existing master fields and Approvals remain. Approvals include ApprovalStepID, ColumnKey, Level, ApprovalRole, ApprovalType, ApproverType, Role, AssignedUserID, IsMandatory, Status, ApprovedQuantity, Remarks, ActionBy, ActionDateTime, Revision and AllowedActions. CapexApprovalID remains the legacy header ID, not the new step ID.

Master rows include CurrentApprovalStage, CurrentApprovalStepID, CurrentStatus, WorkflowSource (BUILDER/LEGACY), CanApprove and CanAction. Submit ApprovalStepID and Revision with actions and refresh after success. ApprovalFlow filters the business stage (ApprovalType), without changing actor identity or organization scope.

List/count/detail/summary/report/PDF queries share the same stage read model. Existing PDF layouts are retained.

## Notifications

Dispatch stays after COMMIT and failures remain isolated. Creation targets the first assignment; approval targets the next unapproved assignment; final approval targets the creator; reject/return/hold target the acting assignment plus creator, excluding the actor. Consecutive assignments can notify the same actor about the next task. Generic notification/email payloads and email templates are unchanged.

Delivery remains best-effort post-commit dispatch, not a durable outbox.

## Outstanding contracts

- USER: engine/storage support explicit assigned users, but snapshot creation rejects USER until the actual selected-user payload/storage is confirmed. Do not interpret display names or unverified Role values as IDs.
- IsMandatory=false: snapshot creation rejects it until skip/approval semantics are defined; no silent skipping.
- Frontend repository: required to implement and verify table/action wiring.

## Tests

Unit tests: node --test tests/capex/CapexWorkflow.test.js tests/capex/CapexSummary.test.js

Opt-in PostgreSQL integration test: set CAPEX_WORKFLOW_DB_TEST=1 and CAPEX_TEST_ORGANIZATION_ID=20, then run node --test tests/capex/CapexWorkflow.integration.test.js.

Integration migration/fixture/action writes are always rolled back and no notifications are sent. Use an organization with a verified mandatory ROLE configuration. Tests cover snapshots, hold/return/reject/reapproval/final approval, history, shared queries and legacy coexistence.

