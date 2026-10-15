const AppError = require("../../utils/AppError");

const normalized = value => String(value ?? "").trim().toUpperCase();
const statuses = { APPROVE: "Approved", REJECT: "Rejected", RETURN: "Returned", HOLD: "Hold" };

// Assignment and business stage are independent. A USER may approve a GM stage
// without holding the GM role; the persisted assignment is the authority.
const validUserID = value => /^[1-9]\d*$/.test(String(value ?? ""));
const regionalEligibilitySQL = (user = "um", organization = "om") => `EXISTS (
    SELECT 1 FROM user_primary_organization upo
    JOIN organization_master company ON company.organizationid = upo.organizationid
    WHERE upo.userid = ${user}.userid
      AND upo.organizationid = COALESCE(${organization}.parentorganizationid, ${organization}.organizationid)
      AND upo.isactive = TRUE AND upo.isdeleted = FALSE
      AND company.isactive = TRUE AND company.isdeleted = FALSE AND company.activationstatus = TRUE
)`;
const regionalAccessSQL = (user, organization, opexID) => `(
    ${regionalEligibilitySQL(user, organization)} AND EXISTS (
        SELECT 1 FROM opex_workflow_step regional_step
        WHERE regional_step.opexid = ${opexID} AND regional_step.approvertype = 'REGIONAL'
          AND regional_step.assigneduserid = ${user}.userid
          AND regional_step.ismandatory = TRUE
    )
)`;
const isAssigned = (step, actor) => {
    if (!validUserID(actor?.userid)) return false;
    if (normalized(step.approvertype) !== "REGIONAL" && actor.organizationaccess === false) return false;
    if (normalized(step.approvertype) === "REGIONAL" && actor.regionaleligible !== true) return false;
    if (["USER", "REGIONAL"].includes(normalized(step.approvertype))) {
        return validUserID(step.assigneduserid) && String(step.assigneduserid) === String(actor.userid);
    }
    if (normalized(step.approvertype) !== "ROLE") return false;
    const role = normalized(step.role), stage = normalized(step.approvaltype);
    if (role === "HOD" || ["FC", "RD-FC"].includes(role)) {
        if (normalized(actor.usertype) !== "HOD") return false;
        const finance = normalized(actor.departmentname) === "FINANCE";
        if (stage === "RD-FC") return finance && actor.centralfinance === true;
        if (stage === "FC") return finance && !actor.centralfinance &&
            String(actor.departmentorganizationid) === String(step.organizationid);
        return String(actor.departmentorganizationid) === String(step.organizationid) &&
            normalized(actor.departmentname) === normalized(step.requestdepartment);
    }
    return !!role && role === normalized(actor.usertype);
};

// Optional snapshot steps are skipped without fabricating approval actions/history.
const currentStep = steps => steps.find(step => step.ismandatory !== false && !["APPROVED", "SKIPPED"].includes(normalized(step.status))) || null;

const canAct = (steps, step, action) => {
    const current = currentStep(steps);
    if (!current || !statuses[action]) return false;
    if (String(current.stepid) === String(step.stepid)) {
        // Every action consumes this step. Rejected/returned/held requests stay
        // at that stage, but cannot be acted on again without an explicit reopen flow.
        return normalized(step.status) === "PENDING" && !(Number(step.revision) > 0) &&
            step.actionby == null && step.actiondatetime == null;
    }
    // Neither a future nor a previously completed stage may act.
    return false;
};

// Shared by read responses and locked update/delete checks. History prevents
// edit rights returning if a stage is later reset to Pending.
const hasActionSQL = `(
    EXISTS (SELECT 1 FROM opex_workflow_step ws WHERE ws.opexid = cm.opexid
        AND (ws.revision > 0 OR ws.actionby IS NOT NULL OR ws.actiondatetime IS NOT NULL
            OR UPPER(TRIM(ws.status)) <> 'PENDING'))
    OR EXISTS (SELECT 1 FROM opex_workflow_action wa
        JOIN opex_workflow_step ws ON ws.stepid = wa.stepid WHERE ws.opexid = cm.opexid)
    OR EXISTS (SELECT 1 FROM jsonb_each_text(to_jsonb(ca)) field
        WHERE (field.key IN ('hodstatus','fcstatus','gmstatus','rdfcstatus','ceostatus','finalstatus')
               AND NULLIF(UPPER(TRIM(field.value)), '') IS NOT NULL
               AND UPPER(TRIM(field.value)) <> 'PENDING')
           OR (field.key IN ('hodstatusdatetime','fcstatusdatetime','rdfcstatusdatetime','gmstatusdatetime','ceostatusdatetime',
                'hodstatusapprovedby','fcstatusapprovedby','rdfcstatusapprovedby','gmstatusapprovedby','ceostatusapprovedby','finalstatusdatetime')
               AND field.value IS NOT NULL))
)`;

const canModify = (record, actor) => {
    if (actor?.organizationaccess === false) return false;
    if (record.isdeleted || record.isvoid || record.hasaction !== false || !validUserID(actor?.userid)) return false;
    const creator = validUserID(record.createdby) && String(record.createdby) === String(actor.userid);
    // Department comes from user_master.departmentid -> department_master;
    // OPEX currently stores the department name, not a department ID.
    const departmentHod = normalized(actor.usertype) === "HOD" &&
        String(actor.departmentorganizationid) === String(record.organizationid) &&
        !!normalized(record.department) && normalized(actor.departmentname) === normalized(record.department);
    return creator || departmentHod;
};

const allowedActions = (record, steps, step, actor) => {
    if (record.isvoid || record.isdeleted || normalized(record.finalstatus) === "APPROVED" ||
        !isAssigned(step, actor)) return [];
    return Object.keys(statuses).filter(action => canAct(steps, step, action));
};

const permissions = (record, steps, actor) => ({
    CanAction: canModify(record, actor),
    CanApprove: steps.some(step => allowedActions(record, steps, step, actor).includes("APPROVE"))
});

const authorizeApproval = (record, steps, actor, action, stepID) => {
    const step = chooseStep(steps, actor, action, stepID);
    if (!allowedActions(record, steps, step, actor).includes(action)) {
        throw new AppError("You cannot perform this action on this OPEX", 403);
    }
    return step;
};

const chooseStep = (steps, actor, action, stepID) => {
    if (stepID == null && steps.filter(step => isAssigned(step, actor)).length > 1) {
        throw new AppError("ApprovalStepID is required for repeated approver assignments", 400);
    }
    const candidates = steps.filter(step => isAssigned(step, actor) && canAct(steps, step, action) &&
        (stepID == null || String(step.stepid) === String(stepID)));
    if (candidates.length !== 1) {
        throw new AppError(candidates.length
            ? "ApprovalStepID is required when more than one step is actionable"
            : "You are not authorized to perform this action at this approval step", 403);
    }
    return candidates[0];
};

const validateAction = data => {
    const action = normalized(data.Action);
    if (!statuses[action]) throw new AppError("Action must be APPROVE, REJECT, RETURN, or HOLD", 400);
    const remarks = String(data.Remarks ?? "").trim();
    if (action !== "APPROVE" && !remarks) throw new AppError("Remarks are required for this action", 400);
    const quantity = data.Quantity == null ? null : Number(data.Quantity);
    if (quantity !== null && (!Number.isFinite(quantity) || quantity <= 0)) {
        throw new AppError("Quantity must be greater than zero", 400);
    }
    return { action, remarks, quantity, status: statuses[action] };
};

const getActor = async (client, organizationID, userID, opexID = null) => {
    const result = await client.query(`
        SELECT um.userid, um.usertype, dm.departmentname,
            dm.organizationid AS departmentorganizationid,
            ${regionalEligibilitySQL()} AS regionaleligible,
            EXISTS (SELECT 1 FROM user_org_mapping membership WHERE membership.userid=um.userid
                AND membership.organizationid=om.organizationid AND membership.isactive AND NOT membership.isdeleted)
                OR COALESCE(um.logintype='SuperAdmin' AND um.allorganizationaccess, FALSE) AS organizationaccess,
            EXISTS (SELECT 1 FROM user_org_mapping central WHERE central.userid=um.userid
                AND central.organizationid=10 AND central.isactive AND NOT central.isdeleted) AS centralfinance
            FROM user_master um
        JOIN organization_master om ON om.organizationid = $2
        LEFT JOIN department_master dm ON dm.departmentid = um.departmentid AND dm.isdeleted = FALSE
        WHERE um.userid = $1
          AND um.isactive = TRUE AND um.isdeleted = FALSE AND um.islocked = FALSE
          AND om.isactive = TRUE AND om.isdeleted = FALSE AND om.activationstatus = TRUE
          AND ((um.logintype = 'SuperAdmin' AND um.allorganizationaccess = TRUE)
            OR EXISTS (SELECT 1 FROM user_org_mapping uom
                WHERE uom.userid = um.userid AND uom.organizationid = om.organizationid
                  AND uom.isactive = TRUE AND uom.isdeleted = FALSE)
            OR ${regionalAccessSQL("um", "om", "$3")})
    `, [userID, organizationID, opexID]);
    if (!result.rows.length) throw new AppError("You do not have access to this OPEX organization", 403);
    return result.rows[0];
};

const loadSteps = async (client, opexID, lock = false) => {
    const result = await client.query(`
        SELECT s.*, m.department AS requestdepartment, m.organizationid
        FROM opex_workflow_step s JOIN opex_master m ON m.opexid=s.opexid WHERE s.opexid = $1
        ORDER BY s.level, s.stepid ${lock ? "FOR UPDATE OF s" : ""}
    `, [opexID]);
    return result.rows;
};

const snapshot = async (client, opexID, organizationID) => {
    // Lock the master first, matching Builder Save's lock order. A concurrent
    // edit cannot leave the new request with levels from different revisions.
    const master = await client.query(`
        SELECT approvalmasterid, flowname FROM approval_master
        WHERE organizationid = $1 AND UPPER(TRIM(modulename)) = 'OPEX'
          AND isactive = TRUE AND isdelete = FALSE FOR SHARE
    `, [organizationID]);
    if (master.rows.length !== 1) throw new AppError("Exactly one active OPEX approval flow is required", 400);
    const flow = master.rows[0];
    const result = await client.query(`
        SELECT approvalid, level, approvertype, role, approvaltype, ismandatory
        FROM approval_master_details WHERE approvalmasterid = $1 AND isdelete = FALSE
        ORDER BY level, approvalid
    `, [flow.approvalmasterid]);
    const steps = result.rows;
    if (!steps.length) throw new AppError("OPEX approval flow has no steps", 400);
    const levels = new Set();
    let candidates; // All steps share one organization roster during this transaction.
    for (const step of steps) {
        if (!Number.isInteger(step.level) || step.level <= 0 || levels.has(step.level)) {
            throw new AppError("OPEX approval levels must be unique positive integers", 400);
        }
        levels.add(step.level);
        step.approvertype = normalized(step.approvertype);
        if (!["ROLE", "USER", "REGIONAL"].includes(step.approvertype) || !String(step.approvaltype || "").trim()) {
            throw new AppError("Invalid OPEX approval assignment or business stage", 400);
        }
        // Builder stores the selected user's ID in Role for USER/REGIONAL steps.
        // Snapshot it separately; ApprovalType remains the business stage label.
        const assignment = String(step.role ?? "").trim();
        step.assigneduserid = ["USER", "REGIONAL"].includes(step.approvertype) ? assignment : null;
        if (step.assigneduserid !== null && !validUserID(assignment)) {
            throw new AppError(step.approvertype + " approval requires a valid selected user ID", 400);
        }
        step.role = step.approvertype === "ROLE" ? normalized(assignment) : null;
        if (step.approvertype === "ROLE" && !step.role) throw new AppError("Approval role is required", 400);
        // Optional stages are retained for display but never require an eligible recipient.
        if (step.ismandatory === false) continue;
        if (!candidates) candidates = await client.query(`
            SELECT um.userid,um.usertype,dm.departmentname,dm.organizationid AS departmentorganizationid,
                ${regionalEligibilitySQL()} AS regionaleligible,
                EXISTS (SELECT 1 FROM user_org_mapping uom WHERE uom.userid=um.userid AND uom.organizationid=$1
                  AND uom.isactive AND NOT uom.isdeleted) AS organizationaccess,
                EXISTS(SELECT 1 FROM user_org_mapping central WHERE central.userid=um.userid
                    AND central.organizationid=10 AND central.isactive AND NOT central.isdeleted) AS centralfinance,
                m.department AS requestdepartment
            FROM user_master um JOIN organization_master om ON om.organizationid=$1
            JOIN opex_master m ON m.opexid=$2
            LEFT JOIN department_master dm ON dm.departmentid=um.departmentid AND NOT dm.isdeleted
            WHERE om.isactive AND NOT om.isdeleted AND om.activationstatus
                AND (EXISTS (SELECT 1 FROM user_org_mapping uom WHERE uom.userid=um.userid AND uom.organizationid=$1
                  AND uom.isactive AND NOT uom.isdeleted) OR ${regionalEligibilitySQL()})
                AND um.isactive AND NOT um.isdeleted AND NOT um.islocked
        `,[organizationID,opexID]);
        const recipients = {rows:candidates.rows.filter(actor => isAssigned({ ...step,
            organizationid:organizationID,requestdepartment:actor.requestdepartment },actor))};
        if (!recipients.rows.length) throw new AppError(
            step.approvertype === "USER"
                ? "Selected OPEX approver is unavailable or not mapped to this organization"
                : "No eligible approver for OPEX role " + step.role, 400);
    }
    await client.query(`
        INSERT INTO opex_workflow (opexid, organizationid, approvalmasterid, flowname)
        VALUES ($1, $2, $3, $4)
    `, [opexID, organizationID, flow.approvalmasterid, flow.flowname]);
    for (const step of steps) {
        await client.query(`
            INSERT INTO opex_workflow_step
                (opexid, sourceapprovalid, level, approvertype, role, approvaltype, ismandatory, assigneduserid)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        `, [opexID, step.approvalid, step.level, step.approvertype, step.role,
            step.approvaltype, step.ismandatory, step.assigneduserid]);
    }
    return loadSteps(client, opexID);
};

const applyAction = async (client, opex, data, verifiedActor) => {
    const actor = verifiedActor || await getActor(client, opex.organizationid, data.UserID, opex.opexid);
    const steps = await loadSteps(client, opex.opexid, true);
    if (!steps.length) return null; // Legacy request: leave its state and mapping untouched.
    if (opex.isvoid) throw new AppError("Void OPEX cannot be processed for approval", 400);
    const change = validateAction(data);
    const step = authorizeApproval(opex, steps, actor, change.action, data.ApprovalStepID);
    if (data.Revision != null && Number(data.Revision) !== step.revision) {
        throw new AppError("Approval step changed; refresh before submitting again", 409);
    }
    let actingStep = step;
    do {
    const result = await client.query(`
        UPDATE opex_workflow_step SET status = $1, approvedquantity = $2,
            remarks = $3, actionby = $4, actiondatetime = CURRENT_TIMESTAMP, revision = revision + 1
        WHERE stepid = $5 RETURNING revision, actiondatetime
    `, [change.status, change.quantity, change.remarks || null, actor.userid, actingStep.stepid]);
    await client.query(`
        INSERT INTO opex_workflow_action
            (stepid, revision, action, previousstatus, status, actionby, approvedquantity, remarks)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
    `, [actingStep.stepid, result.rows[0].revision, change.action, actingStep.status,
        change.status, actor.userid, change.quantity, change.remarks || null]);
    actingStep.status = change.status;
    actingStep.revision = result.rows[0].revision;
    actingStep.actionby = actor.userid;
    actingStep.actiondatetime = result.rows[0].actiondatetime;
    const candidate = currentStep(steps);
    // One approval covers consecutive assignments belonging to the acting user.
    // Each stage retains its own audit row; other actions never cascade.
    actingStep = change.action === "APPROVE" && candidate &&
        allowedActions(opex, steps, candidate, actor).includes("APPROVE") ? candidate : null;
    } while (actingStep);
    const next = currentStep(steps);
    const finalStatus = change.action === "APPROVE" ? (next ? null : "Approved") : change.status;
    // FinalStatus remains available to legacy consumers during rollout.
    await client.query(`
        UPDATE opex_approval SET finalstatus = $1::text,
            finalstatusdatetime = CASE WHEN $1::text IS NULL THEN NULL ELSE CURRENT_TIMESTAMP END,
            modifiedby = $2, modifieddate = CURRENT_TIMESTAMP
        WHERE opexid = $3 AND isdeleted = FALSE
    `, [finalStatus, actor.userid, opex.opexid]);
    const target = change.action === "APPROVE" ? next : step;
    return {
        change, step, next, finalStatus, actor,
        roles: target?.approvertype === "ROLE" ? [target.role] : [],
        directUserIds: [
            ...(["USER", "REGIONAL"].includes(target?.approvertype) ? [target.assigneduserid] : []),
            ...(change.action !== "APPROVE" || !next ? [opex.createdby] : [])
        ]
    };
};

const recipientIds = async (client, opex, step) => {
    if (!step) return [String(opex.createdby)];
    const users = await client.query(`SELECT u.userid,u.usertype,d.departmentname,
        d.organizationid AS departmentorganizationid,
        ${regionalEligibilitySQL("u", "om")} AS regionaleligible,
        EXISTS (SELECT 1 FROM user_org_mapping membership WHERE membership.userid=u.userid
          AND membership.organizationid=$1 AND membership.isactive AND NOT membership.isdeleted) AS organizationaccess,
        EXISTS(SELECT 1 FROM user_org_mapping central WHERE central.userid=u.userid
            AND central.organizationid=10 AND central.isactive AND NOT central.isdeleted) AS centralfinance
        FROM user_master u JOIN organization_master om ON om.organizationid=$1
        LEFT JOIN department_master d ON d.departmentid=u.departmentid AND NOT d.isdeleted
        WHERE om.isactive AND NOT om.isdeleted AND om.activationstatus
            AND (EXISTS (SELECT 1 FROM user_org_mapping m WHERE m.userid=u.userid AND m.organizationid=$1
                AND m.isactive AND NOT m.isdeleted) OR ${regionalEligibilitySQL("u", "om")})
            AND u.isactive AND NOT u.isdeleted AND NOT u.islocked`,[opex.organizationid]);
    const ids=users.rows.filter(actor=>isAssigned({...step,organizationid:opex.organizationid,
        requestdepartment:opex.department},actor)).map(actor=>String(actor.userid));
    return [...new Set(ids)];
};
const authorizeModify = async (client, id, userID) => {
    const result=await client.query(`SELECT cm.*, ${hasActionSQL} AS hasaction
        FROM opex_master cm LEFT JOIN opex_approval ca ON ca.opexid=cm.opexid AND NOT ca.isdeleted
        WHERE cm.opexid=$1 AND NOT cm.isdeleted FOR UPDATE OF cm`,[id]);
    if(!result.rows.length) throw new AppError("OPEX not found",404);
    const row=result.rows[0];
    const actor=await getActor(client,row.organizationid,userID);
    if(!canModify(row,actor)) throw new AppError("Only the creator or department HOD can edit/delete before any action",403);
};
module.exports = { normalized, currentStep, isAssigned, canAct, chooseStep, hasActionSQL,
    canModify, allowedActions, permissions, authorizeApproval,
    regionalEligibilitySQL, regionalAccessSQL, validateAction, getActor, loadSteps, snapshot, applyAction, recipientIds, authorizeModify };
