-- Supports the set-based HLP entry-list lookup.  Run once against PostgreSQL.
-- The organization/date index may already exist as uq_hlpreport_entry_master_org_date.
CREATE INDEX IF NOT EXISTS idx_hlp_entry_details_entry_title_lower
  ON hlpreport_entry_details (entryid, LOWER(title), id DESC);

CREATE INDEX IF NOT EXISTS idx_hlp_master_list_organization_active_order
  ON hlpreport_master_list (organizationid, orderby, id)
  WHERE isactive = TRUE;
