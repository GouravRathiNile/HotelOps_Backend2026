-- Apply after capex-dynamic-workflow.sql, before deploying Regional support.
-- Existing assignments, levels and action history remain unchanged.
BEGIN;
ALTER TABLE capex_workflow_step
    DROP CONSTRAINT IF EXISTS capex_workflow_step_approvertype_check,
    DROP CONSTRAINT IF EXISTS capex_workflow_step_check;
ALTER TABLE capex_workflow_step
    ADD CONSTRAINT capex_workflow_step_approvertype_check
        CHECK (approvertype IN ('ROLE', 'USER', 'REGIONAL')),
    ADD CONSTRAINT capex_workflow_step_check
        CHECK ((approvertype = 'ROLE' AND role IS NOT NULL AND assigneduserid IS NULL)
            OR (approvertype IN ('USER', 'REGIONAL') AND assigneduserid IS NOT NULL));
COMMIT;
