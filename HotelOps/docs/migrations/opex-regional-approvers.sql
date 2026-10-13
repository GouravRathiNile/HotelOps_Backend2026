-- Apply after opex-dynamic-workflow.sql. Existing snapshots remain unchanged.
BEGIN;
ALTER TABLE opex_workflow_step
    DROP CONSTRAINT IF EXISTS opex_workflow_step_approvertype_check,
    DROP CONSTRAINT IF EXISTS opex_workflow_step_check;
ALTER TABLE opex_workflow_step
    ADD CONSTRAINT opex_workflow_step_approvertype_check
        CHECK (approvertype IN ('ROLE', 'USER', 'REGIONAL')),
    ADD CONSTRAINT opex_workflow_step_check
        CHECK ((approvertype = 'ROLE' AND role IS NOT NULL AND assigneduserid IS NULL)
            OR (approvertype IN ('USER', 'REGIONAL') AND assigneduserid IS NOT NULL));
COMMIT;
