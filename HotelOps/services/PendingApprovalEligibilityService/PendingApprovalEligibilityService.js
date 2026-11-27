const { pool } = require("../../db");

const fail = (message, statusCode = 400) => ({ success: false, statusCode, message });
const normalize = (value) => String(value ?? "").trim().toUpperCase();
const FINANCE_STAGES = new Set(["FC", "FINANCE", "DOF", "RD-FC", "RD"]);

// This reads active Flow Builder rows; it does not contain a fixed dashboard
// role list. New configured ROLE assignments are evaluated automatically.
const getPendingApprovalEligibility = async (data) => {
  try {
    const userID = Number(data.UserID);
    if (!Number.isSafeInteger(userID) || userID <= 0) return fail("Authenticated UserID is required.", 401);
    const result = await pool.query(`
      WITH actor AS (
        SELECT um.UserID, um.UserType, um.LoginType, COALESCE(um.AllOrganizationAccess,FALSE) AS AllOrganizationAccess,
          UPPER(TRIM(COALESCE(dm.DepartmentName,''))) AS DepartmentName
        FROM user_master um LEFT JOIN department_master dm ON dm.DepartmentID=um.DepartmentID AND dm.IsDeleted=FALSE
        WHERE um.UserID=$1 AND um.IsActive=TRUE AND um.IsDeleted=FALSE AND um.IsLocked=FALSE
      ), orgs AS (
        SELECT om.OrganizationID,om.ParentOrganizationID FROM organization_master om CROSS JOIN actor a
        WHERE om.IsActive=TRUE AND om.ActivationStatus=TRUE AND om.IsDeleted=FALSE AND
          (COALESCE(a.LoginType='SuperAdmin' AND a.AllOrganizationAccess,FALSE) OR EXISTS(
            SELECT 1 FROM user_org_mapping u WHERE u.UserID=a.UserID AND u.OrganizationID=om.OrganizationID AND u.IsActive=TRUE AND u.IsDeleted=FALSE))
      )
      SELECT am.OrganizationID,am.ModuleName,amd.ApprovalID,amd.Level,amd.ApproverType,amd.Role,amd.ApprovalType,
        a.UserType,a.DepartmentName,
        EXISTS(SELECT 1 FROM user_primary_organization p WHERE p.UserID=a.UserID
          AND p.OrganizationID=COALESCE(org.ParentOrganizationID,org.OrganizationID) AND p.IsActive=TRUE AND p.IsDeleted=FALSE) AS regionaleligible,
        EXISTS(SELECT 1 FROM user_org_mapping c WHERE c.UserID=a.UserID AND c.OrganizationID=10 AND c.IsActive=TRUE AND c.IsDeleted=FALSE) AS centralorganizationaccess
      FROM approval_master am JOIN orgs org ON org.OrganizationID=am.OrganizationID
      JOIN approval_master_details amd ON amd.ApprovalMasterID=am.ApprovalMasterID CROSS JOIN actor a
      WHERE am.IsActive=TRUE AND am.IsDelete=FALSE AND amd.IsDelete=FALSE
        AND UPPER(TRIM(am.ModuleName)) IN ('CAPEX','OPEX','AMC','AMC RENEWAL','CREDIT APPLICATION','GATEPASS MANAGEMENT')
      ORDER BY am.OrganizationID,am.ModuleName,amd.Level,amd.ApprovalID;`, [userID]);

    const modules = new Map();
    for (const row of result.rows) {
      const configuredModule=normalize(row.modulename);
      const module=configuredModule==='AMC RENEWAL'?'AMC':configuredModule==='CREDIT APPLICATION'?'CREDIT_APPLICATION':configuredModule==='GATEPASS MANAGEMENT'?'GATEPASS':configuredModule;
      const type=normalize(row.approvertype||'ROLE'), role=normalize(row.role), stage=normalize(row.approvaltype||role);
      const userType=normalize(row.usertype), financeHod=userType==='HOD'&&normalize(row.departmentname)==='FINANCE';
      let eligible=false;
      if ((type==='USER'||type==='REGIONAL')&&String(row.role??'').trim()===String(userID)) eligible=type==='USER'||row.regionaleligible===true;
      if (type==='ROLE') {
        eligible=role===userType;
        if (FINANCE_STAGES.has(role)||(role==='HOD'&&FINANCE_STAGES.has(stage))) eligible=financeHod;
        if (module==='OPEX'&&stage==='RD-FC') eligible=financeHod&&row.centralorganizationaccess===true;
        if (module==='AMC'&&(role==='RD'||stage==='RD')) eligible=financeHod&&row.centralorganizationaccess===true;
      }
      if (!eligible) continue;
      if (!modules.has(module)) modules.set(module,{Module:module,OrganizationIDs:new Set(),Stages:[]});
      const item=modules.get(module); item.OrganizationIDs.add(Number(row.organizationid));
      item.Stages.push({OrganizationID:Number(row.organizationid),ApprovalID:Number(row.approvalid),Level:Number(row.level),ApprovalType:stage||null,ApproverType:type,Role:role||null});
    }
    return {success:true,message:"Pending approval eligibility fetched successfully.",data:[...modules.values()].map(item=>({...item,OrganizationIDs:[...item.OrganizationIDs].sort((a,b)=>a-b)}))};
  } catch (error) {
    console.error("Get pending approval eligibility error:",error.message);
    return fail("Unable to fetch pending approval eligibility.",500);
  }
};
module.exports={getPendingApprovalEligibility};
