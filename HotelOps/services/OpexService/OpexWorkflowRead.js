const { pool } = require("../../db");
const AppError = require("../../utils/AppError");
const { formatDate } = require("../../utils/dateFormatter");
const documentUrl = require("../../AzurConfigration/Opex/AzureGetData");
const { permissions, allowedActions, currentStep, hasActionSQL, regionalAccessSQL, regionalEligibilitySQL } = require("./OpexWorkflow");

// Legacy rows are projected, never rewritten. This is the same configuration
// precedence used by legacy approval processing: configured stages, else defaults.
const effectiveSteps = `
    SELECT s.stepid::text, s.level, s.level AS sortorder, s.approvertype,
        s.role, s.assigneduserid, s.approvaltype, s.ismandatory,
        CASE WHEN s.ismandatory = FALSE AND s.status = 'Pending' THEN 'Skipped' ELSE s.status END AS status,
        s.approvedquantity, s.remarks, s.actionby, s.actiondatetime, s.revision,
        s.sourceapprovalid::text AS sourceid
    FROM opex_workflow_step s WHERE s.opexid = cm.opexid
    UNION ALL
    SELECT 'legacy:' || cfg.role, cfg.level, cfg.sortorder, 'ROLE',
        cfg.role, NULL::bigint, cfg.role, cfg.ismandatory,
        COALESCE(to_jsonb(ca)->>(lower(REPLACE(cfg.role, '-', '')) || 'status'), 'Pending'),
        (to_jsonb(ca)->>(lower(REPLACE(cfg.role, '-', '')) || 'approvedquantity'))::numeric,
        to_jsonb(ca)->>(lower(REPLACE(cfg.role, '-', '')) || 'remarks'),
        (to_jsonb(ca)->>(lower(REPLACE(cfg.role, '-', '')) || 'statusapprovedby'))::bigint,
        (to_jsonb(ca)->>(lower(REPLACE(cfg.role, '-', '')) || 'statusdatetime'))::timestamp,
        0, 'legacy:' || cfg.role
    FROM opex_approval ca
    CROSS JOIN LATERAL (
        SELECT approvallevel AS level, approvalorder AS sortorder,
            UPPER(TRIM(approvalrole)) AS role, TRUE AS ismandatory
        FROM opex_approval_config WHERE organizationid=cm.organizationid AND NOT isdeleted
        UNION ALL
        SELECT level,level,role,TRUE
        FROM (VALUES (1,'HOD'),(2,'FC'),(3,'GM'),(4,'RD-FC'),(5,'CEO')) defaults(level,role)
        WHERE NOT EXISTS(SELECT 1 FROM opex_approval_config WHERE organizationid=cm.organizationid AND NOT isdeleted)
    ) cfg
    WHERE ca.opexid = cm.opexid AND ca.isdeleted = FALSE
      AND NOT EXISTS (SELECT 1 FROM opex_workflow WHERE opexid = cm.opexid)
`;

const base = `
WITH actor AS (
    SELECT userid, usertype, logintype, allorganizationaccess, departmentid,
        EXISTS(SELECT 1 FROM user_org_mapping central WHERE central.userid=user_master.userid
            AND central.organizationid=10 AND central.isactive AND NOT central.isdeleted) AS centralfinance
        FROM user_master
    WHERE userid = $1 AND isactive = TRUE AND isdeleted = FALSE AND islocked = FALSE
), records AS (
    SELECT cm.*, om.shortname, ca.opexapprovalid, ca.finalstatus, a.usertype AS actorrole, a.centralfinance,
        access.organizationaccess AS actororganizationaccess, access.regionaleligible AS actorregionaleligible,
        dm.departmentname AS actordepartmentname, dm.organizationid AS actordepartmentorganizationid,
        ${hasActionSQL} AS hasaction,
        COALESCE(w.steps, '[]'::jsonb) AS steps, cs.currentstep,
        EXISTS (SELECT 1 FROM opex_workflow WHERE opexid = cm.opexid) AS dynamic,
        CASE WHEN cm.isvoid THEN 'Void'
             WHEN cs.currentstep IS NOT NULL THEN cs.currentstep->>'status'
             WHEN jsonb_array_length(COALESCE(w.steps, '[]'::jsonb)) > 0 THEN 'Approved'
             ELSE COALESCE(ca.finalstatus, 'Pending') END AS workflowstatus,
        EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(w.steps, '[]'::jsonb)) s
            WHERE COALESCE((s->>'ismandatory')::boolean, TRUE) = TRUE AND (
                (s->>'approvertype' = 'REGIONAL' AND access.regionaleligible AND s->>'assigneduserid' = a.userid::text)
               OR (access.organizationaccess AND s->>'approvertype' = 'USER' AND s->>'assigneduserid' = a.userid::text)
               OR (s->>'approvertype' = 'ROLE' AND access.organizationaccess AND (CASE WHEN UPPER(s->>'role') IN ('HOD','FC','RD-FC') THEN
    UPPER(TRIM(a.usertype))='HOD' AND CASE UPPER(s->>'approvaltype')
        WHEN 'RD-FC' THEN UPPER(TRIM(dm.departmentname))='FINANCE' AND a.centralfinance
        WHEN 'FC' THEN UPPER(TRIM(dm.departmentname))='FINANCE' AND NOT a.centralfinance AND dm.organizationid=cm.organizationid
        ELSE UPPER(TRIM(dm.departmentname))=UPPER(TRIM(cm.department)) AND dm.organizationid=cm.organizationid END
    ELSE UPPER(s->>'role')=UPPER(TRIM(a.usertype)) END)))) AS assigned
    FROM opex_master cm CROSS JOIN actor a
    JOIN organization_master om ON om.organizationid = cm.organizationid
        AND om.isactive = TRUE AND om.isdeleted = FALSE AND om.activationstatus = TRUE
    CROSS JOIN LATERAL (SELECT ${regionalEligibilitySQL("a", "om")} AS regionaleligible,
      (COALESCE(a.logintype='SuperAdmin' AND a.allorganizationaccess, FALSE) OR EXISTS (
        SELECT 1 FROM user_org_mapping membership WHERE membership.userid=a.userid AND membership.organizationid=cm.organizationid
          AND membership.isactive AND NOT membership.isdeleted)) AS organizationaccess) access
    LEFT JOIN opex_approval ca ON ca.opexid = cm.opexid AND ca.isdeleted = FALSE
    LEFT JOIN department_master dm ON dm.departmentid = a.departmentid AND dm.isdeleted = FALSE
    LEFT JOIN LATERAL (
        SELECT jsonb_agg(to_jsonb(s) ORDER BY s.sortorder, s.level, s.stepid) AS steps
        FROM (
            SELECT raw.*, 'stage:' || UPPER(TRIM(raw.approvaltype)) || ':' ||
                ROW_NUMBER() OVER (PARTITION BY UPPER(TRIM(raw.approvaltype))
                    ORDER BY raw.sortorder, raw.level, raw.stepid) AS columnkey
            FROM (${effectiveSteps}) raw
        ) s
    ) w ON TRUE
    LEFT JOIN LATERAL (
        SELECT s AS currentstep FROM jsonb_array_elements(w.steps) s
        WHERE UPPER(s->>'status') NOT IN ('APPROVED', 'SKIPPED')
            AND COALESCE((s->>'ismandatory')::boolean, TRUE) = TRUE LIMIT 1
    ) cs ON TRUE
    WHERE cm.isdeleted = FALSE AND (
      (a.logintype = 'SuperAdmin' AND a.allorganizationaccess = TRUE) OR EXISTS (
        SELECT 1 FROM user_org_mapping uom
        WHERE uom.userid = a.userid AND uom.organizationid = cm.organizationid
          AND uom.isactive = TRUE AND uom.isdeleted = FALSE
    ) OR ${regionalAccessSQL("a", "om", "cm.opexid")})
)
`;

const buildQuery = (data = {}, visibility = true) => {
    if (!/^[1-9]\d*$/.test(String(data.UserID ?? ""))) throw new AppError("Authenticated UserID is required", 401);
    const input = { ...data, ...data.Filters };
    const values = [data.UserID];
    const conditions = [];
    const add = (sql, value) => { values.push(value); conditions.push(sql.replace("?", "$" + values.length)); };
    if (input.OrganizationID != null) {
        if (Number(input.OrganizationID) === 10) conditions.push("(r.organizationid=10 OR (r.centralfinance AND UPPER(TRIM(r.actorrole))='HOD' AND UPPER(TRIM(r.actordepartmentname))='FINANCE'))");
        else add("r.organizationid = ?", input.OrganizationID);
    }
    if (input.OpexID != null) add("r.opexid = ?", input.OpexID);
    if (input.Department) add("LOWER(TRIM(r.department)) = LOWER(TRIM(?))", input.Department);
    if (input.FromDate) add("r.createddate >= ?::date", input.FromDate);
    if (input.ToDate) add("r.createddate < (?::date + INTERVAL '1 day')", input.ToDate);
    const status = String(input.Status || "").trim().toUpperCase();
    const stage = String(input.ApprovalFlow || "").trim().toUpperCase();
    if (status && !["PENDING","APPROVED","REJECTED","RETURNED","HOLD","VOID"].includes(status)) {
        throw new AppError("Invalid OPEX status", 400);
    }
    // Assignment determines eligibility; business-stage filters never impersonate
    // that stage's approver or widen organization access.
    if (stage) {
        values.push(stage);
        const stageParam = "$" + values.length;
        let predicate = `UPPER(s->>'approvaltype') = ${stageParam}`;
        if (status) {
            values.push(status);
            predicate += ` AND UPPER(s->>'status') = $${values.length}`;
            if (status === "PENDING") predicate += " AND s->>'stepid' = r.currentstep->>'stepid'";
        }
        conditions.push(`EXISTS (SELECT 1 FROM jsonb_array_elements(r.steps) s WHERE ${predicate})`);
    } else if (status) {
        values.push(status);
        const param = "$" + values.length;
        conditions.push(visibility ? `(
            (NOT r.assigned AND UPPER(r.workflowstatus) = ${param})
            OR (r.assigned AND EXISTS (
                SELECT 1 FROM jsonb_array_elements(r.steps) s
                WHERE COALESCE((s->>'ismandatory')::boolean, TRUE) = TRUE
                  AND ((s->>'approvertype' = 'REGIONAL' AND r.actorregionaleligible AND s->>'assigneduserid' = $1::text)
                  OR (r.actororganizationaccess AND s->>'approvertype' = 'USER' AND s->>'assigneduserid' = $1::text)
                    OR (s->>'approvertype' = 'ROLE' AND r.actororganizationaccess AND (CASE WHEN UPPER(s->>'role') IN ('HOD','FC','RD-FC') THEN
    UPPER(TRIM(r.actorrole))='HOD' AND CASE UPPER(s->>'approvaltype')
        WHEN 'RD-FC' THEN UPPER(TRIM(r.actordepartmentname))='FINANCE' AND r.centralfinance
        WHEN 'FC' THEN UPPER(TRIM(r.actordepartmentname))='FINANCE' AND NOT r.centralfinance AND r.actordepartmentorganizationid=r.organizationid
        ELSE UPPER(TRIM(r.actordepartmentname))=UPPER(TRIM(r.department)) AND r.actordepartmentorganizationid=r.organizationid END
    ELSE UPPER(s->>'role')=UPPER(TRIM(r.actorrole)) END)))
                  AND UPPER(s->>'status') = ${param}
                  AND (${param} <> 'PENDING' OR s->>'stepid' = r.currentstep->>'stepid')
            ))
        )` : `UPPER(r.workflowstatus) = ${param}`);
    }
    // Department HOD visibility remains scoped; an explicit USER assignment may
    // grant that user a task in another department of an accessible organization.
    conditions.push("(UPPER(TRIM(r.actorrole)) <> 'HOD' OR UPPER(TRIM(r.actordepartmentname))='FINANCE' OR UPPER(TRIM(r.department))=UPPER(TRIM(r.actordepartmentname)) OR r.assigned OR r.createdby=$1)");
    if (visibility) conditions.push(`(NOT r.assigned OR EXISTS (
        SELECT 1 FROM jsonb_array_elements(r.steps) s
        WHERE COALESCE((s->>'ismandatory')::boolean, TRUE) = TRUE
                  AND ((s->>'approvertype' = 'REGIONAL' AND r.actorregionaleligible AND s->>'assigneduserid' = $1::text)
                  OR (r.actororganizationaccess AND s->>'approvertype' = 'USER' AND s->>'assigneduserid' = $1::text)
            OR (s->>'approvertype' = 'ROLE' AND r.actororganizationaccess AND (CASE WHEN UPPER(s->>'role') IN ('HOD','FC','RD-FC') THEN
    UPPER(TRIM(r.actorrole))='HOD' AND CASE UPPER(s->>'approvaltype')
        WHEN 'RD-FC' THEN UPPER(TRIM(r.actordepartmentname))='FINANCE' AND r.centralfinance
        WHEN 'FC' THEN UPPER(TRIM(r.actordepartmentname))='FINANCE' AND NOT r.centralfinance AND r.actordepartmentorganizationid=r.organizationid
        ELSE UPPER(TRIM(r.actordepartmentname))=UPPER(TRIM(r.department)) AND r.actordepartmentorganizationid=r.organizationid END
    ELSE UPPER(s->>'role')=UPPER(TRIM(r.actorrole)) END)))
          AND (UPPER(s->>'status') <> 'PENDING' OR s->>'stepid' = r.currentstep->>'stepid')
    ))`);
    return { cte: base, where: conditions.length ? " WHERE " + conditions.join(" AND ") : "", values };
};

const mapRow = (row, userID) => {
    const actor = { userid: userID, usertype: row.actorrole,
        organizationaccess: row.actororganizationaccess, regionaleligible: row.actorregionaleligible,
        departmentname: row.actordepartmentname, departmentorganizationid: row.actordepartmentorganizationid, centralfinance: row.centralfinance };
    const steps = (row.steps || []).map(step => ({...step, organizationid:row.organizationid, requestdepartment:row.department}));
    // Configuration detail IDs change on every save. Display columns identify
    // a business stage and its occurrence, while actions retain the real step ID.
    const stageOccurrences = new Map();
    const current = currentStep(steps);
    return {
        OpexID: Number(row.opexid), OrganizationID: Number(row.organizationid),
        OrganizationShortName: row.shortname, OpexNumber: Number(row.opexnumber),
        Department: row.department, Item: row.item, Description: row.description, Make: row.make,
        Qty: Number(row.qty), Rate: Number(row.rate), Total: Number(row.total),
        IsVoid: row.isvoid, VoidRemarks: row.voidremarks, CreatedDate: formatDate(row.createddate),
        WorkflowSource: row.dynamic ? "BUILDER" : "LEGACY",
        CurrentStatus: row.workflowstatus,
        CurrentApprovalStage: current?.approvaltype || null,
        CurrentApprovalStepID: current?.stepid || null,
        ...permissions(row, steps, actor),
        Documents: [],
        Approvals: steps.map(step => {
            const stage = String(step.approvaltype || '').trim().toUpperCase();
            const occurrence = (stageOccurrences.get(stage) || 0) + 1;
            stageOccurrences.set(stage, occurrence);
            const actions = allowedActions(row, steps, step, actor);
            return {
            OpexApprovalID: row.opexapprovalid == null ? null : Number(row.opexapprovalid),
            ApprovalStepID: step.stepid, ColumnKey: `stage:${stage}:${occurrence}`,
            Level: step.level, ApprovalRole: step.approvaltype, ApprovalType: step.approvaltype,
            ApproverType: step.approvertype, Role: step.role, AssignedUserID: step.assigneduserid,
            IsMandatory: step.ismandatory, Status: step.ismandatory === false && step.status === "Pending" ? "Skipped" : step.status,
            ApprovedQuantity: step.approvedquantity == null ? null : Number(step.approvedquantity),
            Remarks: step.remarks, ActionBy: step.actionby, ActionDateTime: step.actiondatetime, StatusDateTime: step.actiondatetime, StatusApprovedBy: step.actionby,
            Revision: step.revision,
            // Per-card flag: the record-level flag must not enable every stage.
            CanApprove: actions.includes("APPROVE"),
            AllowedActions: actions
        }; })
    };
};

const attachDocuments = async rows => {
    if (!rows.length) return;
    const result = await pool.query(`SELECT opexid, opexdocumentid, filename, filepath
        FROM opex_documents WHERE opexid = ANY($1::bigint[]) AND isdeleted = FALSE`,
    [rows.map(row => row.OpexID)]);
    const byID = new Map(rows.map(row => [String(row.OpexID), row]));
    for (const document of result.rows) byID.get(String(document.opexid))?.Documents.push({
        OpexDocumentID: Number(document.opexdocumentid), FileName: document.filename,
        FilePath: document.filepath ? documentUrl(document.filepath) : null
    });
};

const list = async data => {
    const { cte, where, values } = buildQuery(data);
    const page = Number(data.page ?? 1), size = Number(data.PageSize ?? 10);
    if (!Number.isSafeInteger(page) || page < 1 || !Number.isSafeInteger(size) || size < 1) {
        throw new AppError("Invalid pagination", 400);
    }
    const [result, count, columns] = await Promise.all([
        pool.query(`${cte} SELECT r.* FROM records r ${where}
            ORDER BY r.createddate DESC, r.opexid DESC LIMIT $${values.length+1} OFFSET $${values.length+2}`,
        [...values, size, (page-1)*size]),
        pool.query(`${cte} SELECT COUNT(*) AS count FROM records r ${where}`, values),
        // Headers describe the current organization configuration, not the filtered
        // requests. Snapshot stage keys still supply each row's historical values.
        pool.query(`SELECT columnkey,label,MIN(level) AS level FROM (SELECT 'stage:' || UPPER(TRIM(d.approvaltype)) || ':' ||
                ROW_NUMBER() OVER (PARTITION BY am.organizationid, UPPER(TRIM(d.approvaltype))
                    ORDER BY d.level, d.approvalid) AS columnkey,
                UPPER(TRIM(d.approvaltype)) AS label, d.level
            FROM approval_master am
            JOIN approval_master_details d ON d.approvalmasterid = am.approvalmasterid
                AND d.isdelete = FALSE
            JOIN organization_master om ON om.organizationid = am.organizationid
                AND om.isactive = TRUE AND om.isdeleted = FALSE AND om.activationstatus = TRUE
            WHERE ($2::bigint IS NULL OR am.organizationid = $2 OR ($2=10 AND EXISTS(SELECT 1 FROM user_master centralactor JOIN department_master centraldept ON centraldept.departmentid=centralactor.departmentid JOIN user_org_mapping centralmap ON centralmap.userid=centralactor.userid WHERE centralactor.userid=$1 AND UPPER(TRIM(centralactor.usertype))='HOD' AND UPPER(TRIM(centraldept.departmentname))='FINANCE' AND centralmap.organizationid=10 AND centralmap.isactive AND NOT centralmap.isdeleted))) AND UPPER(TRIM(am.modulename)) = 'OPEX'
                AND am.isactive = TRUE AND am.isdelete = FALSE
                AND EXISTS (
                    SELECT 1 FROM user_master actor
                    WHERE actor.userid = $1 AND actor.isactive = TRUE
                        AND actor.isdeleted = FALSE AND actor.islocked = FALSE
                        AND ((actor.logintype = 'SuperAdmin' AND actor.allorganizationaccess = TRUE)
                            OR EXISTS (SELECT 1 FROM user_org_mapping uom
                                WHERE uom.userid = actor.userid AND uom.organizationid = am.organizationid
                                    AND uom.isactive = TRUE AND uom.isdeleted = FALSE))
                )
            ) configured_columns GROUP BY columnkey,label ORDER BY MIN(level),columnkey`,
        [data.UserID, data.Filters?.OrganizationID ?? data.OrganizationID ?? null])
    ]);
    const rows = result.rows.map(row => mapRow(row, data.UserID));
    await attachDocuments(rows);
    const total = Number(count.rows[0].count);
    return { success: true, message: "OPEX records fetched successfully.",
        TotalCount: total, PageCount: rows.length, CurrentPage: page, PageSize: size,
        TotalPages: Math.ceil(total/size),
        ApprovalColumns: columns.rows.map(col => ({
            Key: col.columnkey,
            Label: col.columnkey.endsWith(':1') ? col.label : `${col.label} (${col.columnkey.split(':').pop()})`,
            Level: col.level
        })), data: rows };
};

const detail = async data => {
    const { cte, where, values } = buildQuery(data, false);
    const result = await pool.query(`${cte} SELECT r.* FROM records r ${where}`, values);
    if (!result.rows.length) throw new AppError("OPEX record not found or not accessible", 404);
    const row = mapRow(result.rows[0], data.UserID);
    await attachDocuments([row]);
    return { success: true, message: "OPEX record fetched successfully.", data: row };
};

const report = async (data, grouping = null) => {
    const { cte, where, values } = buildQuery(data, grouping === null);
    const group = grouping === "department" ? "COALESCE(r.department, 'Unspecified') AS department," :
        grouping === "organization" ? "r.organizationid, r.shortname," : "";
    const groupBy = grouping === "department" ? "GROUP BY COALESCE(r.department, 'Unspecified') ORDER BY department" :
        grouping === "organization" ? "GROUP BY r.organizationid, r.shortname ORDER BY r.organizationid" : "";
    const statusExpression = grouping !== null ? "r.workflowstatus" : `CASE
        WHEN r.isvoid THEN 'Void'
        WHEN r.assigned THEN COALESCE((
            SELECT s->>'status' FROM jsonb_array_elements(r.steps) s
            WHERE COALESCE((s->>'ismandatory')::boolean, TRUE) = TRUE
                  AND ((s->>'approvertype' = 'REGIONAL' AND r.actorregionaleligible AND s->>'assigneduserid' = $1::text)
                  OR (r.actororganizationaccess AND s->>'approvertype' = 'USER' AND s->>'assigneduserid' = $1::text)
                OR (s->>'approvertype' = 'ROLE' AND r.actororganizationaccess AND (CASE WHEN UPPER(s->>'role') IN ('HOD','FC','RD-FC') THEN
    UPPER(TRIM(r.actorrole))='HOD' AND CASE UPPER(s->>'approvaltype')
        WHEN 'RD-FC' THEN UPPER(TRIM(r.actordepartmentname))='FINANCE' AND r.centralfinance
        WHEN 'FC' THEN UPPER(TRIM(r.actordepartmentname))='FINANCE' AND NOT r.centralfinance AND r.actordepartmentorganizationid=r.organizationid
        ELSE UPPER(TRIM(r.actordepartmentname))=UPPER(TRIM(r.department)) AND r.actordepartmentorganizationid=r.organizationid END
    ELSE UPPER(s->>'role')=UPPER(TRIM(r.actorrole)) END)))
              AND (UPPER(s->>'status') <> 'PENDING' OR s->>'stepid' = r.currentstep->>'stepid')
            ORDER BY (s->>'stepid' = r.currentstep->>'stepid') DESC NULLS LAST,
                (s->>'level')::integer DESC LIMIT 1
        ), r.workflowstatus)
        ELSE r.workflowstatus END`;
    const counts = ["Pending","Approved","Rejected","Returned","Hold","Void"].map(status =>
        `COUNT(*) FILTER (WHERE (${statusExpression}) = '${status}') AS ${status.toLowerCase()}count,
         COALESCE(SUM(r.total) FILTER (WHERE (${statusExpression}) = '${status}'),0) AS ${status.toLowerCase()}amount`).join(",");
    const result = await pool.query(`${cte} SELECT ${group} COUNT(*) AS count,
        COALESCE(SUM(r.total),0) AS totalamount, ${counts}
        FROM records r ${where} ${groupBy}`, values);
    return result.rows;
};

module.exports = { buildQuery, mapRow, list, detail, report };
