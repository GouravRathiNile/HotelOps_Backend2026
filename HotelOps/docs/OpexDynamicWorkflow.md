# OPEX dynamic approval workflow

## Storage and rollout

Apply `docs/migrations/opex-dynamic-workflow.sql` before restarting the API and
OPEX consumer. The migration is additive/idempotent and has been applied to the
configured development database. It creates `opex_workflow`,
`opex_workflow_step`, and `opex_workflow_action`; no existing requests are migrated.

New submissions require one active organization OPEX flow. Its ordered details
are copied under the same master lock used by Builder Save. Changes to Builder
configuration affect new requests, not in-flight snapshots. Historical requests
without a snapshot continue through the existing legacy processor, including
Finance HOD -> FC automatic approval and central organization 10 RD-FC rules.

## Assignment and progression

- ROLE HOD + HOD stage: same-organization request department HOD.
- ROLE HOD + FC stage (or legacy FC role): property Finance HOD, excluding the
  central-org Finance HOD as in the existing OPEX rules.
- ROLE RD-FC: central organization 10 Finance HOD with request-organization access.
- USER: the persisted Builder `role` field contains the selected user ID;
  it is snapshotted into `assigneduserid`, independent of business stage/user type.
- Other ROLE assignments match persisted user type. All actors must be active,
  unlocked, and mapped to the request organization (existing superadmin access
  still controls reading; it does not grant unconfigured approval permission).
- Optional steps remain visible as Skipped, without fabricated human actions.
  The next mandatory step receives the task. All-optional requests finish at creation.
- Only the current Pending step may act once. Approve advances; Reject/Return/Hold
  stop progression. Requests cannot implicitly reopen an acted-on step.
- CanAction permits creator or same-organization department HOD before any action;
  CanApprove/AllowedActions are supplied at record and per-step level as appropriate.
- ApprovalStepID and Revision are sent by the frontend; the backend checks the
  locked persisted step, assignment and revision, and records action history.

## Reads, reports and communication

OpexWorkflowRead supplies list/detail, status filters, summaries and all PDF reads.
ApprovalColumns come from current active configuration in configured order, stable
across status/date filters and empty pages. ColumnKey pairs stage with occurrence,
so repeated stages survive and old configuration detail IDs do not duplicate headers.
Historical records without a displayed stage show Not applicable. Detail/history
always retain the request's actual snapshot. Central-org global views remain limited
to mapped organizations. Table, Excel and PDF use the same configured headers.

Notification recipients are resolved with the same assignment predicate, deduplicated,
and passed to the existing OPEX notification/email dispatcher only after commit.
Next approvers and the creator receive approval updates; rejection/return/hold retain
creator/other applicable approvers and exclude the acting user. Queue/email failures
cannot undo a committed request. Existing email templates and transport are unchanged.
No real test notifications or emails were sent.

## Verification

- `node --test tests/opex/*.test.js` (DB integration test opt-in)
- `OPEX_WORKFLOW_DB_TEST=1 node --test tests/opex/OpexWorkflow.integration.test.js`
  exercises the configured five-step flow, real service creation, legacy Finance
  auto-approval, all-optional completion, history, wrong/future actors, isolation,
  and commit/notification behavior in a rolled-back transaction.
- Frontend `npm run build` and `node --test tests/opex-permissions.test.cjs`.
- Real read-only list, department, organization and detail PDFs were validated as PDF
  buffers. Browser login/button visibility and real RabbitMQ/email delivery were
  not exercised interactively.

## Changed files

Backend (relative to HotelOps):
- controllers/OpexController/OpexController.js
- services/OpexService/OpexService.js
- services/OpexService/OpexWorkflow.js
- services/OpexService/OpexWorkflowRead.js
- docs/migrations/opex-dynamic-workflow.sql
- docs/OpexDynamicWorkflow.md
- tests/opex/OpexSummary.test.js
- tests/opex/OpexEmailTemplate.test.js
- tests/opex/OpexWorkflow.test.js
- tests/opex/OpexWorkflow.integration.test.js
- tests/opex/OpexPdfController.test.js

Frontend (relative to IT_Admin_Frontend/super-admin-panel):
- app/Hotelops/Pages/Opex/Common/permissions.ts
- app/Hotelops/Pages/Opex/Pages/page.tsx
- app/Hotelops/Pages/Opex/Pages/Details/page.tsx
- app/Hotelops/Pages/Opex/Pages/AddNewOpex/page.tsx
- app/Hotelops/Pages/Opex/Pages/Report/page.tsx
- app/Hotelops/Redux/Opex/OpexOperationsSlice.jsx
- app/Hotelops/Server/Opex/Service.jsx
- tests/opex-permissions.test.cjs
