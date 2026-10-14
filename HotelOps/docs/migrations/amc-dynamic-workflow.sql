-- Additive, idempotent migration. Back up AMC/config/equipment before applying.
BEGIN;
LOCK TABLE engineering_amc_master, engineering_amc_approval,
    engineering_amc_approval_config IN SHARE ROW EXCLUSIVE MODE;
ALTER TABLE engineering_amc_approval
    ADD COLUMN IF NOT EXISTS approvalmasterid bigint REFERENCES approval_master(approvalmasterid),
    ADD COLUMN IF NOT EXISTS flowname text;
CREATE TABLE IF NOT EXISTS engineering_amc_workflow_step (
    stepid bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    amcid bigint NOT NULL REFERENCES engineering_amc_approval(amcid),
    sourceapprovalid bigint REFERENCES approval_master_details(approvalid),
    level integer NOT NULL CHECK (level > 0),
    approvertype text NOT NULL CHECK (approvertype IN ('ROLE','USER','REGIONAL')),
    role text,
    assigneduserid bigint REFERENCES user_master(userid),
    approvaltype text NOT NULL CHECK (length(trim(approvaltype)) > 0),
    ismandatory boolean NOT NULL,
    status text NOT NULL DEFAULT 'Pending' CHECK (status IN ('Pending','Approved','Rejected','Returned')),
    remarks text,
    actionby bigint REFERENCES user_master(userid),
    actiondatetime timestamp,
    revision integer NOT NULL DEFAULT 0 CHECK (revision >= 0),
    UNIQUE (amcid, level),
    CHECK ((approvertype='ROLE' AND NULLIF(trim(role),'') IS NOT NULL AND assigneduserid IS NULL)
        OR (approvertype IN ('USER','REGIONAL') AND assigneduserid IS NOT NULL AND role IS NULL))
);
CREATE TABLE IF NOT EXISTS engineering_amc_workflow_action (
    actionid bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    stepid bigint NOT NULL REFERENCES engineering_amc_workflow_step(stepid),
    revision integer NOT NULL CHECK (revision > 0),
    action text NOT NULL CHECK (action IN ('APPROVE','REJECT','RETURN')),
    previousstatus text NOT NULL,
    status text NOT NULL CHECK (status IN ('Approved','Rejected','Returned')),
    actionby bigint NOT NULL REFERENCES user_master(userid),
    remarks text,
    actiondatetime timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (stepid,revision)
);
CREATE INDEX IF NOT EXISTS engineering_amc_step_assignee_idx
    ON engineering_amc_workflow_step(assigneduserid,status) WHERE assigneduserid IS NOT NULL;

DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM engineering_amc_approval_config
        WHERE NOT isdeleted AND UPPER(TRIM(approvalrole)) NOT IN ('FC','GM','RD','CEO'))
    OR EXISTS (SELECT 1 FROM engineering_amc_approval_config WHERE NOT isdeleted
        GROUP BY organizationid, UPPER(TRIM(approvalrole)) HAVING count(*) > 1) THEN
        RAISE EXCEPTION 'Invalid or repeated legacy AMC stage: reconcile before migration';
    END IF;
    IF EXISTS (SELECT 1 FROM approval_master WHERE UPPER(TRIM(modulename)) IN ('AMC','AMC RENEWAL')
        AND isactive AND NOT isdelete GROUP BY organizationid HAVING count(*) > 1) THEN
        RAISE EXCEPTION 'Multiple active AMC Builder flows: reconcile before migration';
    END IF;
END $$;

-- Seed Builder only for organizations without any existing AMC master.
-- Existing AMC snapshots never reference this seed: their original flow is frozen below.
WITH seeded AS (
INSERT INTO approval_master(organizationid,flowname,modulename,isactive,createdby)
SELECT m.organizationid,'AMC Approval Flow','AMC',TRUE,MIN(m.createdby)
FROM engineering_amc_master m
WHERE NOT EXISTS (SELECT 1 FROM approval_master am
    WHERE am.organizationid=m.organizationid AND UPPER(TRIM(am.modulename)) IN ('AMC','AMC RENEWAL') AND NOT am.isdelete)
GROUP BY m.organizationid RETURNING *
)
INSERT INTO approval_master_details(approvalmasterid,level,approvertype,role,approvaltype,createdby,ismandatory)
SELECT am.approvalmasterid,ROW_NUMBER() OVER(PARTITION BY am.approvalmasterid ORDER BY f.sortorder,f.level,f.role),
    'ROLE',f.role,f.role,am.createdby,TRUE
FROM seeded am
CROSS JOIN LATERAL (
    SELECT approvalorder AS sortorder,approvallevel AS level,UPPER(TRIM(approvalrole)) AS role
    FROM engineering_amc_approval_config WHERE organizationid=am.organizationid AND NOT isdeleted
    UNION ALL
    SELECT level,level,role FROM (VALUES(1,'FC'),(2,'GM'),(3,'RD'),(4,'CEO')) d(level,role)
    WHERE NOT EXISTS(SELECT 1 FROM engineering_amc_approval_config WHERE organizationid=am.organizationid AND NOT isdeleted)
) f
WHERE UPPER(TRIM(am.modulename)) IN ('AMC','AMC RENEWAL') AND am.isactive AND NOT am.isdelete
    AND NOT EXISTS(SELECT 1 FROM approval_master_details d WHERE d.approvalmasterid=am.approvalmasterid);

-- Freeze legacy flow, including available data for omitted stages (display-only).
-- Never manufacture historical actions or reapply approved contracts to equipment.
INSERT INTO engineering_amc_workflow_step(amcid,level,approvertype,role,approvaltype,
    ismandatory,status,remarks,actionby,actiondatetime)
SELECT a.amcid,ROW_NUMBER() OVER(PARTITION BY a.amcid ORDER BY f.displayonly,f.sortorder,f.level,f.role),
    'ROLE',f.role,f.role,NOT f.displayonly,
    COALESCE(to_jsonb(a)->>(lower(f.role)||'status'),'Pending'),
    to_jsonb(a)->>(lower(f.role)||'remarks'),
    (to_jsonb(a)->>(lower(f.role)||'statusapprovedby'))::bigint,
    (to_jsonb(a)->>(lower(f.role)||'statusdatetime'))::timestamp
FROM engineering_amc_approval a JOIN engineering_amc_master m USING(amcid)
CROSS JOIN LATERAL (
    SELECT approvalorder AS sortorder,approvallevel AS level,UPPER(TRIM(approvalrole)) AS role,FALSE AS displayonly
    FROM engineering_amc_approval_config WHERE organizationid=m.organizationid AND NOT isdeleted
    UNION ALL
    SELECT d.level,d.level,d.role,
        EXISTS(SELECT 1 FROM engineering_amc_approval_config WHERE organizationid=m.organizationid AND NOT isdeleted)
    FROM (VALUES(1,'FC'),(2,'GM'),(3,'RD'),(4,'CEO')) d(level,role)
    WHERE NOT EXISTS(SELECT 1 FROM engineering_amc_approval_config
        WHERE organizationid=m.organizationid AND NOT isdeleted AND UPPER(TRIM(approvalrole))=d.role)
) f
WHERE a.approvalmasterid IS NULL
    AND NOT EXISTS(SELECT 1 FROM engineering_amc_workflow_step s WHERE s.amcid=a.amcid);
COMMIT;
