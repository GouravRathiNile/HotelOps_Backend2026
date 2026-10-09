const { pool } = require("../../db");
const AppError = require("../../utils/AppError");
const { retryableDatabaseResponse } = require("../../utils/retryableDatabaseError");
const { normalizeIDs, normalizeSave, normalizeList } = require("../../utils/ApprovalFlowValidation");

const masterColumns = `am.approvalmasterid, am.organizationid, am.flowname,
    am.modulename, am.description, am.isactive, am.createddatetime`;

// Aggregate levels per master so pagination counts flows, never individual levels.
// Keep approvalid only as a stable sort key; it is not part of the response.
const detailsColumn = `COALESCE((
    SELECT jsonb_agg(to_jsonb(levels) - 'approvalid' ORDER BY levels.level, levels.approvalid)
    FROM (
        SELECT d.approvalid, d.level, d.approvertype,
            d.role, d.approvaltype, d.createddatetime, d.ismandatory
        FROM public.approval_master_details d
        WHERE d.approvalmasterid = am.approvalmasterid AND d.isdelete = FALSE
    ) levels
), '[]'::jsonb) AS details`;

const failure = (error) => retryableDatabaseResponse(error) || {
    success: false, statusCode: error.statusCode || 500, message: error.message
};
//========================================================================= Save or Update Approval Flow
const saveApprovalFlow = async (data = {}) => {
    let client;
    let inTransaction = false;
    try {
        // Validate here too: queue consumers can be called without the HTTP controller.
        const input = normalizeSave(data);
        const { OrganizationID, FlowName, ModuleName, Description, Details } = input;
        let { ApprovalMasterID } = input;
        const updating = ApprovalMasterID !== undefined;
        client = await pool.connect();
        await client.query("BEGIN");
        inTransaction = true;
        let existing;
        if (updating) {
            const result = await client.query(`
                SELECT approvalmasterid, isactive FROM public.approval_master
                WHERE approvalmasterid = $1 AND organizationid = $2 AND isdelete = FALSE
                FOR UPDATE`, [ApprovalMasterID, OrganizationID]);
            existing = result.rows[0];
            if (!existing) throw new AppError("Approval Flow Not Found", 404);
        }
        const duplicate = await client.query(`
            SELECT approvalmasterid FROM public.approval_master
            WHERE organizationid = $1 AND modulename = $2 AND isdelete = FALSE
                AND ($3::bigint IS NULL OR approvalmasterid <> $3)
            LIMIT 1`, [OrganizationID, ModuleName, ApprovalMasterID ?? null]);
        if (duplicate.rows.length) {
            throw new AppError("Approval Flow already exists for this module", 409);
        }
        // Omission preserves an existing status; new flows default to active.
        const IsActive = input.IsActive ?? existing?.isactive ?? true;
        if (updating) {
            await client.query(`
                UPDATE public.approval_master SET flowname = $1, modulename = $2,
                    description = $3, isactive = $4, modifiedby = $5,
                    modifieddatetime = CURRENT_TIMESTAMP
                WHERE approvalmasterid = $6 AND organizationid = $7 AND isdelete = FALSE
            `, [FlowName, ModuleName, Description, IsActive, data.UserID, ApprovalMasterID, OrganizationID]);
            // Preserve the existing replace-all semantics and audit history.
            await client.query(`
                UPDATE public.approval_master_details SET isdelete = TRUE,
                    deletedby = $1, deleteddatetime = CURRENT_TIMESTAMP
                WHERE approvalmasterid = $2 AND isdelete = FALSE
            `, [data.UserID, ApprovalMasterID]);
        } else {
            const result = await client.query(`
                INSERT INTO public.approval_master
                    (organizationid, flowname, modulename, description, isactive,
                     createdby, createddatetime, isdelete)
                VALUES ($1, $2, $3, $4, $5, $6, CURRENT_TIMESTAMP, FALSE)
                RETURNING approvalmasterid
            `, [OrganizationID, FlowName, ModuleName, Description, IsActive, data.UserID]);
            ApprovalMasterID = result.rows[0].approvalmasterid;
        }
        for (const detail of Details) {
            await client.query(`
                INSERT INTO public.approval_master_details
                    (approvalmasterid, level, approvertype, role, approvaltype,
                     createdby, createddatetime, isdelete, ismandatory)
                VALUES ($1, $2, $3, $4, $5, $6, CURRENT_TIMESTAMP, FALSE, $7)
            `, [ApprovalMasterID, detail.Level, detail.ApproverType, detail.Role,
                detail.ApprovalType, data.UserID, detail.IsMandatory]);
        }
        const result = await client.query(`
            SELECT ${masterColumns}, ${detailsColumn}
            FROM public.approval_master am
            WHERE am.approvalmasterid = $1 AND am.organizationid = $2 AND am.isdelete = FALSE
        `, [ApprovalMasterID, OrganizationID]);
        await client.query("COMMIT");
        inTransaction = false;
        return {
            success: true,
            message: updating ? "Approval Flow Updated Successfully" : "Approval Flow Created Successfully",
        };
    } catch (error) {
        if (inTransaction) {
            try { await client.query("ROLLBACK"); }
            catch (rollbackError) { console.error("Approval Flow rollback failed:", rollbackError); }
        }
        return failure(error);
    } finally {
        if (client) client.release();
    }
};
//=========================================================================Get Approval Flow List
const getApprovalFlowList = async (data = {}) => {
    try {
        const input = normalizeList(data);
        const { page, limit } = input;
        const values = [input.OrganizationID];
        const conditions = ["am.organizationid = $1", "am.isdelete = FALSE"];
        for (const [key, column, operator] of [
            ["ApprovalMasterID", "approvalmasterid", "="],
            ["FlowName", "flowname", "ILIKE"],
            ["ModuleName", "modulename", "ILIKE"],
            ["IsActive", "isactive", "="]
        ]) {
            if (input[key] === undefined || input[key] === "") continue;
            values.push(operator === "ILIKE" ? `%${input[key]}%` : input[key]);
            conditions.push(`am.${column} ${operator} $${values.length}`);
        }
        const where = conditions.join(" AND ");
        const [list, count] = await Promise.all([
            pool.query(`SELECT ${masterColumns}, ${detailsColumn}
                FROM public.approval_master am WHERE ${where}
                ORDER BY am.approvalmasterid DESC
                LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
            [...values, limit, (page - 1) * limit]),
            pool.query(`SELECT COUNT(*) AS totalcount
                FROM public.approval_master am WHERE ${where}`, values)
        ]);
        const TotalCount = Number(count.rows[0].totalcount);
        return {
            success: true, message: "Approval Flow List fetched successfully",
            TotalCount, PageCount: list.rows.length, CurrentPage: page,
            PageSize: limit, TotalPages: Math.ceil(TotalCount / limit), data: list.rows
        };
    } catch (error) { return failure(error); }
};

//=========================================================================
// Get Module-wise Approval Configurations
const getModuleApprovalConfigurations = async (data = {}) => {
    try {
        let { OrganizationID, ModuleName } = data;

        // Validate OrganizationID if provided
        if (
            OrganizationID !== undefined &&
            OrganizationID !== null &&
            OrganizationID !== ""
        ) {
            OrganizationID = String(OrganizationID).trim();

            if (!/^\d+$/.test(OrganizationID) || Number(OrganizationID) <= 0) {
                throw new AppError(
                    "OrganizationID must be a valid positive integer",
                    400
                );
            }
        } else {
            OrganizationID = null;
        }

        // Validate ModuleName if provided
        if (ModuleName !== undefined && ModuleName !== null) {
            ModuleName = String(ModuleName).trim();

            if (!ModuleName) {
                ModuleName = null;
            }
        } else {
            ModuleName = null;
        }

        const result = await pool.query(
            `
            SELECT
                am.organizationid AS "OrganizationID",
                am.modulename AS "ModuleName",
                am.flowname AS "FlowName",
                COALESCE(
                    jsonb_agg(
                        jsonb_build_object(
                            'Level', d.level,
                            'ApproverType', d.approvertype,
                            'Role', d.role,
                            'ApprovalType', d.approvaltype,
                            'IsMandatory', d.ismandatory
                        )
                        ORDER BY d.level ASC, d.approvalid ASC
                    ) FILTER (WHERE d.approvalid IS NOT NULL),
                    '[]'::jsonb
                ) AS "Details"
            FROM public.approval_master am
            LEFT JOIN public.approval_master_details d
                ON d.approvalmasterid = am.approvalmasterid
                AND d.isdelete = FALSE
            WHERE
                am.isdelete = FALSE
                AND ($1::BIGINT IS NULL OR am.organizationid = $1::BIGINT)
                AND (
                    $2::VARCHAR IS NULL
                    OR LOWER(TRIM(am.modulename)) = LOWER($2::VARCHAR)
                )
            GROUP BY
                am.approvalmasterid,
                am.organizationid,
                am.modulename,
                am.flowname
            ORDER BY
                am.organizationid ASC,
                am.modulename ASC,
                am.approvalmasterid DESC
            `,
            [OrganizationID, ModuleName]
        );

        return {
            success: true,
            message: "Module-wise approval configurations fetched successfully",
            data: result.rows
        };
    } catch (error) {
        return failure(error);
    }
};

//========================================================================= Delete Approval Flow
const deleteApprovalFlow = async (data = {}) => {
    try {
        const { OrganizationID, ApprovalMasterID } = normalizeIDs(data, true);
        const result = await pool.query(`
            UPDATE public.approval_master SET isdelete = TRUE, isactive = FALSE,
                deletedby = $1, deleteddatetime = CURRENT_TIMESTAMP
            WHERE approvalmasterid = $2 AND organizationid = $3 AND isdelete = FALSE
            RETURNING approvalmasterid
        `, [data.DeletedBy, ApprovalMasterID, OrganizationID]);
        if (!result.rows.length) throw new AppError("Approval Flow Not Found", 404);
        return { success: true, message: "Approval Flow Deleted Successfully" };
    } catch (error) { return failure(error); }
};

module.exports = { saveApprovalFlow, getApprovalFlowList, getModuleApprovalConfigurations, deleteApprovalFlow };
