-- Additive migration. Existing CAPEX remains on its legacy approval path.
BEGIN;
CREATE TABLE IF NOT EXISTS capex_workflow (
    capexid bigint PRIMARY KEY REFERENCES capex_master(capexid),
    organizationid bigint NOT NULL REFERENCES organization_master(organizationid),
    approvalmasterid bigint NOT NULL REFERENCES approval_master(approvalmasterid),
    flowname text NOT NULL,
    createddatetime timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS capex_workflow_step (
    stepid bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    capexid bigint NOT NULL REFERENCES capex_workflow(capexid),
    sourceapprovalid bigint NOT NULL REFERENCES approval_master_details(approvalid),
    level integer NOT NULL CHECK (level > 0),
    approvertype text NOT NULL CHECK (approvertype IN ('ROLE', 'USER')),
    role text,
    assigneduserid bigint REFERENCES user_master(userid),
    approvaltype text NOT NULL,
    ismandatory boolean NOT NULL,
    status text NOT NULL DEFAULT 'Pending'
        CHECK (status IN ('Pending', 'Approved', 'Rejected', 'Returned', 'Hold')),
    approvedquantity numeric,
    remarks text,
    actionby bigint REFERENCES user_master(userid),
    actiondatetime timestamp,
    revision integer NOT NULL DEFAULT 0,
    UNIQUE (capexid, level),
    CHECK ((approvertype = 'ROLE' AND role IS NOT NULL AND assigneduserid IS NULL)
        OR (approvertype = 'USER' AND assigneduserid IS NOT NULL))
);
CREATE TABLE IF NOT EXISTS capex_workflow_action (
    actionid bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    stepid bigint NOT NULL REFERENCES capex_workflow_step(stepid),
    revision integer NOT NULL,
    action text NOT NULL CHECK (action IN ('APPROVE', 'REJECT', 'RETURN', 'HOLD')),
    previousstatus text NOT NULL,
    status text NOT NULL,
    actionby bigint NOT NULL REFERENCES user_master(userid),
    approvedquantity numeric,
    remarks text,
    actiondatetime timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (stepid, revision)
);
CREATE INDEX IF NOT EXISTS capex_workflow_org_idx ON capex_workflow(organizationid);
CREATE INDEX IF NOT EXISTS capex_workflow_step_assignee_idx
    ON capex_workflow_step(assigneduserid, status) WHERE assigneduserid IS NOT NULL;
COMMIT;
