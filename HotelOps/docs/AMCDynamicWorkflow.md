# AMC Approval Flow Builder integration

Applied to the configured database on 13 October 2026: 22 legacy approvals
became 88 snapshot steps. Existing IDs, fields, current stages and linked
equipment reconciled exactly before commit. Final status counts remain 14
Pending, 4 Approved, 2 Rejected and 2 Returned. No historical actions were
fabricated. The deployment backup/verification is under
`../.local-backups/amc-2026-10-13T11-44-15-188Z/`.

AMC reuses `approval_master`/`approval_master_details` and the existing
`engineering_amc_approval` header. Runtime steps and future action history live
in `engineering_amc_workflow_step` and `engineering_amc_workflow_action`.
CAPEX/OPEX request tables are not reused. Equipment, documents and expiry jobs
keep their existing responsibilities.

## Deployment and backup

Pause AMC writes/configuration edits and deploy schema before restarting workers
with the new backend. Run from HotelOps:

`node scripts/migrateAMCWorkflow.js --apply`

The runner locks the affected tables, creates and checksum-verifies an ignored
local backup under `../.local-backups`, applies the additive migration, compares
every pre-existing AMC/header/document/config/equipment field, checks current
stages and imported actor/remark/timestamp values, then commits. A failed check
rolls back database changes and retains the backup. Keep that backup outside
source control. Identity sequence allocation can advance even when a dry run is
rolled back; existing IDs are never rewritten or sequences reset.

The SQL migration is `docs/migrations/amc-dynamic-workflow.sql`. It is idempotent,
keeps all legacy tables and seeds an AMC Builder flow only when an organization
has no existing nondeleted AMC master. Existing pending requests snapshot their
effective legacy ordering, independent of new Builder configuration. Legacy
omitted stages retain available data as display-only snapshot rows. Original
AMC code ignored the legacy mandatory flag during execution, so imported
configured stages remain mandatory. No historical action events are invented;
only the latest stored action fields are available. Migration sends no messages
and never replays equipment updates.

## Runtime behavior

New AMC contracts require exactly one active Builder flow with ModuleName `AMC` or the existing frontend label `AMC Renewal`.
Details snapshot Level, ApproverType, Role/selected user, ApprovalType and
IsMandatory. Later edits/reordering/deactivation do not rewrite existing
requests. Optional steps skip execution. If every step is optional, creation
finalizes the contract and atomically synchronizes equipment.

ROLE FC remains the property Finance HOD excluding central RD authority; ROLE
RD retains the existing centrally authorized Finance HOD rule. ROLE GM/CEO
match live account roles and organization access. New ROLE HOD matches the
equipment department. USER assignment is independent of the business-stage
label. REGIONAL selects a user whose active primary organization is the hotel's
parent/company (`COALESCE(parentorganizationid, organizationid)`). Organization,
user and mapping eligibility are rechecked for actions and notifications.
Regional/central access to a request never permits an unrelated ROLE/USER step.

APPROVE, REJECT and RETURN remain the only actions. Rejection/return consume the
step; the existing update API does not reopen/resubmit it. No HOLD or new edit/
delete policy is introduced. Approval writes step state, immutable action
history and legacy FinalStatus in one transaction. Unambiguous FC/GM/RD/CEO
stage labels continue to mirror their legacy columns. Repeated/custom labels
are represented by snapshot rows. Final approval alone updates equipment AMC
type, dates, yearly expense and status; a missing linked equipment row rolls
back approval.

Creation notifies the first mandatory assignment, intermediate approval the
next, final approval the creator, and reject/return the creator with the
existing actor exclusion. Explicit consecutive assignments may notify the same
actor about their next task. Existing Engineering/AMC event names and content
remain unchanged. Notification publishing stays after commit and best-effort.
The generic Firebase lookup now understands only the Engineering/AMC external
assignment scope; expiry summary delivery is unchanged.

## Compatible API and frontend contract

Existing `/api/Engineering/CreateAMC`, `/AMCList`, `/GetAMCById/:id`,
`/ApproveAMC`, `/AMCDetailPdf` and Engineering RabbitMQ commands are retained.
AMCID=0 continues to return the existing new-contract equipment form. Existing
master/equipment/document fields, response envelopes and approval aliases stay.

`ApproveAMC` optionally accepts `ApprovalStepID` (positive integer) and
`Revision` (non-negative integer). Repeated assignments require a step ID.
Stale revisions return 409. Server authorization always checks the persisted
current step and live user; client stage/role fields do not select authority.

Approvals add ApprovalStepID, Level, ApprovalType, ApproverType, Role,
AssignedUserID, IsMandatory, ColumnKey, Revision, ActionBy, ApprovedByName,
CanApprove and AllowedActions. Existing LevelNo, ApprovalRole, Status,
StatusDateTime and Remarks remain. Records add WorkflowSource and
CurrentApprovalStepID; lists add ApprovalColumns. Render approvals by ColumnKey
to distinguish repeated labels and mixed versions. Do not infer order from
FC/GM/RD/CEO columns. Use `/api/ApprovalFlow/Module-Configurations` for AMC
configuration; keep legacy AMC configuration endpoints for legacy compatibility.

No frontend repository exists in this workspace. The Builder module selector,
AMC list/detail approval cards, action client (step ID/revision), stage filter,
and old configuration screen need the above additive contract. Their exact file
paths and browser behavior cannot be verified here. Existing Builder routes
provide authentication without an explicit SuperAdmin-only route guard; that
shared permission policy is unchanged by this AMC integration.

## Tests

`node --test tests/engineering/EngineeringAMCWorkflow.test.js tests/engineering/AMCApprovalVisibility.test.js tests/engineering/AMCEquipmentSync.test.js tests/engineering/EngineeringAMCApprovalNotification.test.js`

Set `AMC_WORKFLOW_DB_TEST=1`, then run
`node --test tests/engineering/EngineeringAMCWorkflow.integration.test.js`.
The integration test rolls back migration, Builder edits, requests, membership
changes, actions and equipment updates; notification publishing is captured
locally. Test deployed worker/controller wiring separately after restart.

The snapshot lookup and migration recognize both AMC and AMC Renewal as the same module scope. Multiple active flows across these names still fail validation. Builder ROLE HOD with ApprovalType FC resolves the property Finance HOD, matching the existing FC semantics; other HOD stages match equipment department.
