const AppError = require("../../utils/AppError");

const normalized = value => String(value ?? "").trim().toUpperCase();
const statuses = { APPROVE: "Approved", REJECT: "Rejected", RETURN: "Returned", HOLD: "Hold" };

// Assignment and business stage are independent. A USER may approve a GM stage
// without holding the GM role; the persisted assignment is the authority.
const validUserID = value => /^[1-9]\d*$/.test(String(value ?? ""));
const isAssigned = (step, actor) => {
    if (!validUserID(actor?.userid)) return false;
    if (normalized(step.approvertype) === "USER") {
        return validUserID(step.assigneduserid) && String(step.assigneduserid) === String(actor.userid);
    }
    return normalized(step.approvertype) === "ROLE" && !!normalized(step.role) &&
        normalized(step.role) === normalized(actor.usertype);
};

const currentStep = steps => steps.find(step => normalized(step.status) !== "APPROVED") || null;

const canAct = (steps, step, action) => {
    const current = currentStep(steps);
    if (!current || !statuses[action]) return false;
    if (String(current.stepid) === String(step.stepid)) {
        return ["PENDING", "REJECTED", "RETURNED", "HOLD"].includes(normalized(step.status));
    }
    const index = steps.findIndex(row => String(row.stepid) === String(step.stepid));
    return ["REJECT", "RETURN"].includes(action) &&
        normalized(step.status) === "APPROVED" &&
        normalized(steps[index + 1]?.status) === "PENDING";
};

// These policies run only after persisted organization access is verified.
// Creation ownership grants edit/delete, never an implicit approval assignment.
const canModify = (record, actor) => !record.isdeleted &&
    validUserID(actor?.userid) && validUserID(record.createdby) &&
    String(record.createdby) === String(actor.userid);

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
        throw new AppError("You cannot perform this action on this CAPEX", 403);
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

const getActor = async (client, organizationID, userID) => {
    const result = await client.query(`
        SELECT um.userid, um.usertype FROM user_master um
        JOIN organization_master om ON om.organizationid = $2
        WHERE um.userid = $1
          AND um.isactive = TRUE AND um.isdeleted = FALSE AND um.islocked = FALSE
          AND om.isactive = TRUE AND om.isdeleted = FALSE AND om.activationstatus = TRUE
          AND ((um.logintype = 'SuperAdmin' AND um.allorganizationaccess = TRUE)
            OR EXISTS (SELECT 1 FROM user_org_mapping uom
                WHERE uom.userid = um.userid AND uom.organizationid = om.organizationid
                  AND uom.isactive = TRUE AND uom.isdeleted = FALSE))
    `, [userID, organizationID]);
    if (!result.rows.length) throw new AppError("You do not have access to this CAPEX organization", 403);
    return result.rows[0];
};

const loadSteps = async (client, capexID, lock = false) => {
    const result = await client.query(`
        SELECT * FROM capex_workflow_step WHERE capexid = $1
        ORDER BY level, stepid ${lock ? "FOR UPDATE" : ""}
    `, [capexID]);
    return result.rows;
};

const snapshot = async (client, capexID, organizationID) => {
    // Lock the master first, matching Builder Save's lock order. A concurrent
    // edit cannot leave the new request with levels from different revisions.
    const master = await client.query(`
        SELECT approvalmasterid, flowname FROM approval_master
        WHERE organizationid = $1 AND UPPER(TRIM(modulename)) = 'CAPEX'
          AND isactive = TRUE AND isdelete = FALSE FOR SHARE
    `, [organizationID]);
    if (master.rows.length !== 1) throw new AppError("Exactly one active CAPEX approval flow is required", 400);
    const flow = master.rows[0];
    const result = await client.query(`
        SELECT approvalid, level, approvertype, role, approvaltype, ismandatory
        FROM approval_master_details WHERE approvalmasterid = $1 AND isdelete = FALSE
        ORDER BY level, approvalid
    `, [flow.approvalmasterid]);
    const steps = result.rows;
    if (!steps.length) throw new AppError("CAPEX approval flow has no steps", 400);
    const levels = new Set();
    for (const step of steps) {
        if (!Number.isInteger(step.level) || step.level <= 0 || levels.has(step.level)) {
            throw new AppError("CAPEX approval levels must be unique positive integers", 400);
        }
        levels.add(step.level);
        step.approvertype = normalized(step.approvertype);
        if (!["ROLE", "USER"].includes(step.approvertype) || !String(step.approvaltype || "").trim()) {
            throw new AppError("Invalid CAPEX approval assignment or business stage", 400);
        }
        // The existing schema has no selected-user column. Reject ambiguous
        // configuration until its storage contract is explicitly established.
        if (step.approvertype === "USER") {
            throw new AppError("USER approval configuration requires a verified selected-user mapping", 400);
        }
        if (!step.ismandatory) {
            throw new AppError("Optional CAPEX approval steps require an explicit progression policy", 400);
        }
        step.role = normalized(step.role);
        if (!step.role) throw new AppError("Approval role is required", 400);
        const recipients = await client.query(`
            SELECT 1 FROM user_master um
            JOIN user_org_mapping uom ON uom.userid = um.userid
            WHERE uom.organizationid = $1 AND UPPER(TRIM(um.usertype)) = $2
              AND uom.isactive = TRUE AND uom.isdeleted = FALSE
              AND um.isactive = TRUE AND um.isdeleted = FALSE AND um.islocked = FALSE
            LIMIT 1
        `, [organizationID, step.role]);
        if (!recipients.rows.length) throw new AppError("No eligible approver for CAPEX role " + step.role, 400);
    }
    await client.query(`
        INSERT INTO capex_workflow (capexid, organizationid, approvalmasterid, flowname)
        VALUES ($1, $2, $3, $4)
    `, [capexID, organizationID, flow.approvalmasterid, flow.flowname]);
    for (const step of steps) {
        await client.query(`
            INSERT INTO capex_workflow_step
                (capexid, sourceapprovalid, level, approvertype, role, approvaltype, ismandatory)
            VALUES ($1, $2, $3, $4, $5, $6, $7)
        `, [capexID, step.approvalid, step.level, step.approvertype, step.role, step.approvaltype, step.ismandatory]);
    }
    return loadSteps(client, capexID);
};

const applyAction = async (client, capex, data) => {
    const actor = await getActor(client, capex.organizationid, data.UserID);
    const steps = await loadSteps(client, capex.capexid, true);
    if (!steps.length) return null; // Legacy request: leave its state and mapping untouched.
    if (capex.isvoid) throw new AppError("Void CAPEX cannot be processed for approval", 400);
    const change = validateAction(data);
    const step = authorizeApproval(capex, steps, actor, change.action, data.ApprovalStepID);
    if (data.Revision != null && Number(data.Revision) !== step.revision) {
        throw new AppError("Approval step changed; refresh before submitting again", 409);
    }
    const result = await client.query(`
        UPDATE capex_workflow_step SET status = $1, approvedquantity = $2,
            remarks = $3, actionby = $4, actiondatetime = CURRENT_TIMESTAMP, revision = revision + 1
        WHERE stepid = $5 RETURNING revision, actiondatetime
    `, [change.status, change.quantity, change.remarks || null, actor.userid, step.stepid]);
    await client.query(`
        INSERT INTO capex_workflow_action
            (stepid, revision, action, previousstatus, status, actionby, approvedquantity, remarks)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
    `, [step.stepid, result.rows[0].revision, change.action, step.status,
        change.status, actor.userid, change.quantity, change.remarks || null]);
    step.status = change.status;
    const next = currentStep(steps);
    const finalStatus = change.action === "APPROVE" ? (next ? null : "Approved") : change.status;
    // FinalStatus remains available to legacy consumers during rollout.
    await client.query(`
        UPDATE capex_approval SET finalstatus = $1::text,
            finalstatusdatetime = CASE WHEN $1::text IS NULL THEN NULL ELSE CURRENT_TIMESTAMP END,
            modifiedby = $2, modifieddate = CURRENT_TIMESTAMP
        WHERE capexid = $3 AND isdeleted = FALSE
    `, [finalStatus, actor.userid, capex.capexid]);
    const target = change.action === "APPROVE" ? next : step;
    return {
        change, step, next, finalStatus, actor,
        roles: target?.approvertype === "ROLE" ? [target.role] : [],
        directUserIds: [
            ...(target?.approvertype === "USER" ? [target.assigneduserid] : []),
            ...(change.action !== "APPROVE" || !next ? [capex.createdby] : [])
        ]
    };
};

module.exports = { normalized, currentStep, isAssigned, canAct, chooseStep,
    canModify, allowedActions, permissions, authorizeApproval,
    validateAction, getActor, loadSteps, snapshot, applyAction };
