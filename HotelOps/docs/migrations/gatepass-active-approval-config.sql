-- Preserve historical configurations while keeping active approval orders unique.
BEGIN;
SET LOCAL lock_timeout = '5s';
ALTER TABLE Gatepass_RGP_Approval_Config
  DROP CONSTRAINT IF EXISTS uq_rgp_approval_config;
CREATE UNIQUE INDEX IF NOT EXISTS uq_gatepass_rgp_approval_config_active
  ON Gatepass_RGP_Approval_Config (OrganizationID, ApprovalOrder)
  WHERE IsDeleted = FALSE;
COMMIT;
