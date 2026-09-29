-- Default approvals have no organization-specific configuration row.
-- Keep the foreign key for approvals that reference a custom configuration.
BEGIN;
SET LOCAL lock_timeout = '5s';
ALTER TABLE Gatepass_RGP_Approval
  ALTER COLUMN RGPApprovalConfigID DROP NOT NULL;
COMMIT;
