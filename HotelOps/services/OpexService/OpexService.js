const OpexWorkflow = require("./OpexWorkflow");
const OpexWorkflowRead = require("./OpexWorkflowRead");
const { pool } = require("../../db");
const {
  retryableDatabaseResponse,
} = require("../../utils/retryableDatabaseError");
const generateDocumentUrl = require("../../AzurConfigration/Opex/AzureGetData");
const { formatDate } = require("../../utils/dateFormatter");
const PdfPrinter = require("pdfmake");
const path = require("path");
const { generatePdf, loadLogo, } = require("../../utils/pdfHelper");
const { sendEmail } = require("../../utils/emailService");
const { buildOpexEmail } = require("./OpexEmailTemplate");
const generateOrganizationLogoUrl = require("../../AzurConfigration/ITAdmin/OrganizationMaster/AzureGetData");
const OPEX_DETAIL_PDF_FONTS = {
  Roboto: {
    normal: path.join(
      process.cwd(),
      "fonts/Roboto-Regular.ttf",
    ),

    bold: path.join(
      process.cwd(),
      "fonts/Roboto-Medium.ttf",
    ),

    italics: path.join(
      process.cwd(),
      "fonts/Roboto-SemiBold.ttf",
    ),

    bolditalics: path.join(
      process.cwd(),
      "fonts/Roboto-Bold.ttf",
    ),
  },
};

const OPEX_NOTIFICATION_MODULE = "Opex";


// ======================================================
const notificationUserIds = (values) => [...new Set((Array.isArray(values) ? values : [values])
  .filter((value) => value != null && /^[1-9]\d*$/.test(String(value).trim()))
  .map((value) => String(value).trim()))].sort();

// ==============================================================Default roles
const DEFAULT_APPROVALS = Object.freeze([
  { LevelNo: 1, ApprovalRole: "HOD" },
  { LevelNo: 2, ApprovalRole: "FC" },
  { LevelNo: 3, ApprovalRole: "GM" },
  { LevelNo: 4, ApprovalRole: "RD-FC" },
  { LevelNo: 5, ApprovalRole: "CEO" },
]);
const APPROVAL_ROLES = new Set(["HOD", "FC", "GM", "RD-FC", "CEO"]);
const CENTRAL_RDFC_ORGANIZATION_ID = 10;

// Returns true only when the OPEX creator is an active Finance HOD
// mapped to the same organization as the OPEX.
const isFinanceHodCreator = async (userID, organizationID) => {
  const normalizedUserID = Number(userID);
  const normalizedOrganizationID = Number(organizationID);

  if (
    !Number.isSafeInteger(normalizedUserID) ||
    normalizedUserID < 1 ||
    !Number.isSafeInteger(normalizedOrganizationID) ||
    normalizedOrganizationID < 1
  ) {
    return false;
  }

  const result = await pool.query(
    `
    SELECT 1
    FROM user_master um
    INNER JOIN department_master dm
      ON dm.departmentid = um.departmentid
    INNER JOIN user_org_mapping uom
      ON uom.userid = um.userid
    WHERE um.userid = $1
      AND uom.organizationid = $2
      AND UPPER(TRIM(um.usertype)) = 'HOD'
      AND UPPER(TRIM(COALESCE(dm.departmentname, ''))) = 'FINANCE'
      AND um.isactive = TRUE
      AND um.isdeleted = FALSE
      AND um.islocked = FALSE
      AND dm.isdeleted = FALSE
      AND uom.isactive = TRUE
      AND uom.isdeleted = FALSE
    LIMIT 1;
    `,
    [normalizedUserID, normalizedOrganizationID],
  );

  return result.rows.length > 0;
};
// Resolve recipients with the same effective-role rules used by OPEX approval:
// property/department HOD, property FC/GM/CEO, and central-org Finance HOD for RD-FC.
const resolveOpexNotificationRecipients = async ({ organizationID, department, roles = [],
  directUserIds = [], excludeUserID = null, actorUserID = null }) => {
  const normalizedRoles = [...new Set(roles.map((role) => String(role || "").trim().toUpperCase())
    .filter((role) => APPROVAL_ROLES.has(role)))];
  const normalizedUserIds = notificationUserIds(directUserIds);
  const result = await pool.query(`
    SELECT DISTINCT um.userid, um.email, om.organizationname,
      COALESCE(NULLIF(TRIM(om.shortname), ''), om.organizationname) AS organization_short_name,
      COALESCE(NULLIF(TRIM(actor.fullname), ''), NULLIF(TRIM(actor.username), '')) AS actor_name
    FROM user_master um
    INNER JOIN organization_master om ON om.organizationid = $1
    LEFT JOIN department_master dm ON dm.departmentid = um.departmentid
    LEFT JOIN user_master actor ON actor.userid::text = $5::text
    WHERE om.isactive = TRUE AND om.activationstatus = TRUE AND om.isdeleted = FALSE
      AND um.isactive = TRUE AND um.isdeleted = FALSE AND um.islocked = FALSE
      AND ($4::text IS NULL OR um.userid::text <> $4::text)
      AND (
        (um.userid::text = ANY($3::text[]) AND EXISTS (
          SELECT 1 FROM user_org_mapping direct_uom
          WHERE direct_uom.userid = um.userid AND direct_uom.organizationid = $1
            AND direct_uom.isactive = TRUE AND direct_uom.isdeleted = FALSE))
        OR ('HOD' = ANY($2::text[]) AND UPPER(TRIM(um.usertype)) = 'HOD'
          AND UPPER(TRIM(COALESCE(dm.departmentname, ''))) = UPPER(TRIM($6))
          AND dm.isdeleted = FALSE
          AND EXISTS (SELECT 1 FROM user_org_mapping hod_uom
            WHERE hod_uom.userid = um.userid AND hod_uom.organizationid = $1
              AND hod_uom.isactive = TRUE AND hod_uom.isdeleted = FALSE))
        OR ('FC' = ANY($2::text[]) AND UPPER(TRIM(um.usertype)) = 'HOD'
          AND UPPER(TRIM(COALESCE(dm.departmentname, ''))) = 'FINANCE'
          AND dm.organizationid = $1 AND dm.isdeleted = FALSE
          AND EXISTS (SELECT 1 FROM user_org_mapping fc_uom
            WHERE fc_uom.userid = um.userid AND fc_uom.organizationid = $1
              AND fc_uom.isactive = TRUE AND fc_uom.isdeleted = FALSE)
          AND NOT EXISTS (SELECT 1 FROM user_org_mapping central_fc_uom
            WHERE central_fc_uom.userid = um.userid AND central_fc_uom.organizationid = $7
              AND central_fc_uom.isactive = TRUE AND central_fc_uom.isdeleted = FALSE))
        OR ('GM' = ANY($2::text[]) AND UPPER(TRIM(um.usertype)) = 'GM'
          AND EXISTS (SELECT 1 FROM user_org_mapping gm_uom
            WHERE gm_uom.userid = um.userid AND gm_uom.organizationid = $1
              AND gm_uom.isactive = TRUE AND gm_uom.isdeleted = FALSE))
        OR ('CEO' = ANY($2::text[]) AND UPPER(TRIM(um.usertype)) = 'CEO'
          AND EXISTS (SELECT 1 FROM user_org_mapping ceo_uom
            WHERE ceo_uom.userid = um.userid AND ceo_uom.organizationid = $1
              AND ceo_uom.isactive = TRUE AND ceo_uom.isdeleted = FALSE))
        OR ('RD-FC' = ANY($2::text[]) AND UPPER(TRIM(um.usertype)) = 'HOD'
          AND UPPER(TRIM(COALESCE(dm.departmentname, ''))) = 'FINANCE'
          AND EXISTS (SELECT 1 FROM user_org_mapping rdfc_uom
            WHERE rdfc_uom.userid = um.userid AND rdfc_uom.organizationid = $7
              AND rdfc_uom.isactive = TRUE AND rdfc_uom.isdeleted = FALSE))
      )`,
    [organizationID, normalizedRoles, normalizedUserIds,
      excludeUserID == null ? null : String(excludeUserID),
      actorUserID == null ? null : String(actorUserID), String(department || ""),
      CENTRAL_RDFC_ORGANIZATION_ID]);
  return {
    userIds: notificationUserIds(result.rows.map((row) => row.userid)),
    emails: [...new Map(result.rows
      .map((row) => String(row.email || "").trim()).filter(Boolean)
      .map((email) => [email.toLowerCase(), email])).values()],
    organizationName: String(result.rows[0]?.organizationname || "").trim(),
    organizationShortName: String(result.rows[0]?.organization_short_name || "").trim(),
    actorName: String(result.rows[0]?.actor_name || "").trim(),
  };
};

// Email is explicitly orchestrated by OPEX after notification persistence;
// failures here cannot affect the committed OPEX or Firebase notification.
const sendOpexEmails = async ({ emails, organizationID, organizationName,
  notificationTitle, details }) => {
  if (!emails.length) return;
  try {
    const logoResult = await pool.query(`
      SELECT logoname
      FROM organization_master_logo
      WHERE organizationid = $1 AND isdeleted = FALSE
      ORDER BY logoid
      LIMIT 1`, [organizationID]);
    let logoUrl = process.env.NILE_OFFICIAL_LOGO_URL || null;
    if (logoResult.rows[0]?.logoname) {
      try { logoUrl = generateOrganizationLogoUrl(logoResult.rows[0].logoname); }
      catch (error) { console.error("OPEX email logo URL failed:", error.message); }
    }
    const email = buildOpexEmail({ notificationTitle, organizationName, logoUrl, details });
    await Promise.all(emails.map(async (address) => {
      try { await sendEmail(address, email.subject, email.text, email.html); }
      catch (error) { console.error("OPEX email delivery failed:", error.message); }
    }));
  } catch (error) {
    console.error("OPEX email preparation failed:", error.message);
  }
};

// Presentation is separate from recipient selection so text changes cannot alter workflow.
const opexNotificationContent = ({ kind, item, qty, department, description,
  organizationShortName, actorName, approverRole }) => {
  const title = kind === "CREATE"
    ? `OPEX - ${String(item || "").trim()} (${String(qty ?? "").trim()}) - ${String(department || "").trim()} - ${organizationShortName}`
    : `OPEX - ${String(item || "").trim()} - ${String(department || "").trim()} - ${organizationShortName}`;
  if (kind === "CREATE") return { title, message: String(description || "").trim() };
  if (kind === "AUTO_APPROVED") return {title,message:"Your OPEX is fully approved because no mandatory approval steps are configured."};
  const actionLabel = { APPROVE: "Approved", REJECT: "Rejected", RETURN: "Returned", HOLD: "Hold" }[kind];
  return { title, message: `${actionLabel} by ${actorName || approverRole}` };
};

// OPEX owns recipient/content rules; the shared service persists and pushes the final command.
const notifyOpex = async ({ organizationID, opexID, department, roles, directUserIds,
  excludeUserID, actorUserID, kind, item, qty, rate, total, description,
  actionQuantity, remark, actionDate, approverRole, action }) => {
  const context = await resolveOpexNotificationRecipients({
    organizationID, department,
    roles, directUserIds, excludeUserID, actorUserID
  });
  if (!context.userIds.length) return;
  const content = opexNotificationContent({
    kind, item, qty, department, description,
    approverRole, organizationShortName: context.organizationShortName, actorName: context.actorName
  });
  const { sendMessage } = require("../../producer/producer");
  const QUEUE = require("../../config/queue");
  const response = await sendMessage(QUEUE.NOTIFICATION.REQUEST, QUEUE.NOTIFICATION.RESPONSE, {
    action: "CREATE_NOTIFICATION",
    data: {
      organizationId: Number(organizationID), title: content.title, message: content.message,
      type: "info", moduleName: OPEX_NOTIFICATION_MODULE, entityType: "Opex",
      entityId: String(opexID), action, priority: "normal", userIds: context.userIds
    },
  });
  if (!response || response.success !== true) {
    console.error("OPEX notification request unsuccessful:", response?.message || "No response");
    return;
  }
  Promise.resolve().then(() => sendOpexEmails({
    emails: context.emails, organizationID, organizationName: context.organizationName,
    notificationTitle: content.title,
    details: {
      entityId: opexID, kind, item, department, quantity: qty, rate, total, description,
      actionQuantity, remark, actionBy: context.actorName || approverRole || "-", actionDate
    },
  })).catch((error) => console.error("OPEX email dispatch failed:", error.message));
};

// Notification failure is isolated from an OPEX transaction that already committed.
const notifyCommittedOpex = (event) => {
  Promise.resolve().then(() => notifyOpex(event))
    .catch((error) => console.error("OPEX notification failed:", error.message));
};

// ============================================================ Shared Response Helpers(Create Helpers)
const fail = (message, statusCode = 400) => ({
  success: false,
  statusCode,
  message,
});

// Resolve OPEX permissions from trusted JWT claims without changing the JWT.
// Organization 10 Finance HODs centrally perform RD-FC; other Finance HODs
// retain FC behavior and every non-Finance HOD remains department restricted.
const hasCentralRdfcMapping = async (queryable, userID) => {
  const normalizedUserID = Number(userID);
  if (!Number.isSafeInteger(normalizedUserID) || normalizedUserID < 1) {
    return false;
  }

  const result = await queryable.query(
    `
    SELECT 1
    FROM user_org_mapping uom
    INNER JOIN user_master um
      ON um.UserID = uom.UserID
    INNER JOIN organization_master om
      ON om.OrganizationID = uom.OrganizationID
    WHERE uom.UserID = $1
      AND uom.OrganizationID = $2
      AND uom.IsActive = TRUE
      AND uom.IsDeleted = FALSE
      AND um.IsActive = TRUE
      AND um.IsDeleted = FALSE
      AND um.IsLocked = FALSE
      AND om.IsActive = TRUE
      AND om.ActivationStatus = TRUE
      AND om.IsDeleted = FALSE
    LIMIT 1;
    `,
    [normalizedUserID, CENTRAL_RDFC_ORGANIZATION_ID],
  );

  return result.rows.length > 0;
};

const getRdfcMappedOrganizations = async (queryable, userID) => {
  const normalizedUserID = Number(userID);

  if (!Number.isSafeInteger(normalizedUserID) || normalizedUserID < 1) {
    return [];
  }

  const result = await queryable.query(
    `
    SELECT uom.OrganizationID
    FROM user_org_mapping uom
    INNER JOIN user_master um
      ON um.UserID = uom.UserID
    INNER JOIN organization_master om
      ON om.OrganizationID = uom.OrganizationID
    WHERE uom.UserID = $1
      AND uom.IsActive = TRUE
      AND uom.IsDeleted = FALSE
      AND um.IsActive = TRUE
      AND um.IsDeleted = FALSE
      AND um.IsLocked = FALSE
      AND om.IsActive = TRUE
      AND om.ActivationStatus = TRUE
      AND om.IsDeleted = FALSE
    ORDER BY uom.OrganizationID;
    `,
    [normalizedUserID],
  );

  return result.rows
    .map((row) => Number(row.organizationid))
    .filter((id) => Number.isSafeInteger(id) && id > 0);
};

// const resolveOpexAccess = async (
//   data = {},
//   queryable = pool,
//   { approvalAction = false } = {},
// ) => {
//   const jwtRole = String(data.UserType || "").trim().toUpperCase();
//   const departmentName = String(data.DepartmentName || "").trim();

//   if (jwtRole === "RD-FC") {
//     return {
//       error: fail(
//         "RD-FC OPEX access is assigned to the Organization 10 Finance HOD.",
//         403,
//       ),
//     };
//   }

//   if (jwtRole === "HOD" && !departmentName) {
//     return {
//       error: fail("Department information is required for HOD OPEX access.", 403),
//     };
//   }

//   const financeHod =
//     jwtRole === "HOD" && departmentName.toUpperCase() === "FINANCE";

//   const centralContext =
//     financeHod &&
//     (approvalAction ||
//       Number(data.OrganizationID ?? data.Filters?.OrganizationID) ===
//       CENTRAL_RDFC_ORGANIZATION_ID);
//   let centralizedRdfc = false;

//   if (centralContext) {
//     centralizedRdfc = await hasCentralRdfcMapping(queryable, data.UserID);

//     if (!centralizedRdfc && !approvalAction) {
//       return {
//         error: fail(
//           "You are not authorized as the centralized RD-FC approver.",
//           403,
//         ),
//       };
//     }
//   }

//   return {
//     jwtRole,
//     effectiveRole: centralizedRdfc ? "RD-FC" : financeHod ? "FC" : jwtRole,
//     departmentName,
//     departmentScope: jwtRole === "HOD" && !financeHod ? departmentName : null,
//     financeHod,
//     centralizedRdfc,
//   };
// };

const resolveOpexAccess = async (
  data = {},
  queryable = pool,
  { approvalAction = false } = {},
) => {
  const jwtRole = String(data.UserType || "").trim().toUpperCase();
  const departmentName = String(data.DepartmentName || "").trim();

  if (jwtRole === "RD-FC") {
    return {
      error: fail(
        "RD-FC OPEX access is assigned to the Organization 10 Finance HOD.",
        403,
      ),
    };
  }

  if (jwtRole === "HOD" && !departmentName) {
    return {
      error: fail(
        "Department information is required for HOD OPEX access.",
        403,
      ),
    };
  }

  const financeHod =
    jwtRole === "HOD" &&
    departmentName.toUpperCase() === "FINANCE";

  let centralizedRdfc = false;
  let rdfcMappedOrganizations = [];

  if (financeHod) {
    centralizedRdfc = await hasCentralRdfcMapping(
      queryable,
      data.UserID,
    );

    if (centralizedRdfc) {
      rdfcMappedOrganizations = await getRdfcMappedOrganizations(
        queryable,
        data.UserID,
      );
    }
  }

  /*
   * Organization 10 Finance HOD acts as RD-FC.
   *
   * Organization selection:
   * - Organization 10 -> global RD view, but only mapped organizations
   * - Specific mapped organization -> only that organization
   * - Specific unmapped organization -> no access
   */
  let selectedOrganizationID = null;

  if (
    data.OrganizationID !== undefined &&
    data.OrganizationID !== null &&
    String(data.OrganizationID).trim() !== ""
  ) {
    selectedOrganizationID = Number(data.OrganizationID);
  }

  if (centralizedRdfc && selectedOrganizationID !== null) {
    if (
      selectedOrganizationID !== CENTRAL_RDFC_ORGANIZATION_ID &&
      !rdfcMappedOrganizations.includes(selectedOrganizationID)
    ) {
      return {
        error: fail(
          "You are not authorized for the selected organization.",
          403,
        ),
      };
    }
  }

  return {
    jwtRole,

    effectiveRole: centralizedRdfc
      ? "RD-FC"
      : financeHod
        ? "FC"
        : jwtRole,

    departmentName,

    departmentScope:
      jwtRole === "HOD" && !financeHod
        ? departmentName
        : null,

    financeHod,
    centralizedRdfc,

    rdfcMappedOrganizations,

    selectedOrganizationID,
  };
};
// Merge organization overrides with the HOD -> FC -> GM -> RD-FC -> CEO defaults.
const mergeApprovalConfiguration = (configuredRows) => {
  const approvals = new Map(
    DEFAULT_APPROVALS.map((approval) => [approval.LevelNo, approval]),
  );

  for (const row of configuredRows) {
    const levelNo = Number(row.levelno);
    const approvalRole = String(row.approvalrole || "").trim();

    if (Number.isSafeInteger(levelNo) && levelNo > 0 && approvalRole) {
      approvals.set(levelNo, {
        LevelNo: levelNo,
        ApprovalRole: approvalRole,
      });
    }
  }

  return [...approvals.values()].sort(
    (left, right) => left.LevelNo - right.LevelNo,
  );
};
// Opex currently supports HOD, FC, GM, RD-FC and CEO approval roles.
const approvalConfigurationIsValid = (approvals) =>
  approvals.length > 0 &&
  approvals.every((approval) =>
    APPROVAL_ROLES.has(
      String(approval.ApprovalRole || "")
        .trim()
        .toUpperCase(),
    ),
  );
// Roll back only when a transaction was successfully started.
const rollback = async (client, transactionStarted) => {
  if (!client || !transactionStarted) return;

  try {
    await client.query("ROLLBACK");
  } catch (error) {
    console.error("Opex Rollback Error:", error.message);
  }
};
// Roll back database work and return the requested failure response.
const cleanupAndFail = async (client, transactionStarted, response) => {
  await rollback(client, transactionStarted);
  return response;
};
// Reserve numeric IDs safely because the existing Opex ID columns have no defaults.
const reserveNumericIDs = async (client, tableName, columnName, count = 1) => {
  if (count < 1) return [];

  const allowedColumns = {
    Opex_Master: "OpexID",
    Opex_Documents: "OpexDocumentID",
    Opex_Approval: "OpexApprovalID",
    Opex_Approval_Config: "OpexApprovalConfigID",
  };

  if (allowedColumns[tableName] !== columnName) {
    throw new Error("Invalid Opex ID reservation target");
  }

  const lockKey = `${tableName}.${columnName}`;
  await client.query("SELECT pg_advisory_xact_lock(hashtext($1));", [lockKey]);

  const result = await client.query(
    `SELECT COALESCE(MAX(${columnName}), 0) + 1 AS NextID FROM ${tableName};`,
  );
  const firstID = Number(result.rows[0].nextid);

  return Array.from({ length: count }, (_value, index) => firstID + index);
};
// ============================================================ Create Opex
const createOpex = async (data) => {
  let client;
  let transactionStarted = false;

  const documents = Array.isArray(data.Documents) ? data.Documents : [];

  try {
    client = await pool.connect();

    await client.query("BEGIN");
    transactionStarted = true;

    // ========================================================
    // 1. Generate Organization-wise Opex Number
    // ========================================================
    const sequenceResult = await client.query(
      `
      INSERT INTO Opex_Organization_Sequence
      (
        OrganizationID,
        LastOpexNumber
      )
      VALUES ($1, 1)

      ON CONFLICT (OrganizationID)
      DO UPDATE SET
        LastOpexNumber =
          Opex_Organization_Sequence.LastOpexNumber + 1

      RETURNING LastOpexNumber;
      `,
      [data.OrganizationID],
    );

    const OpexNumber = Number(sequenceResult.rows[0].lastopexnumber);

    // ========================================================
    // 2. Create Opex Master
    // OpexID = AUTO INCREMENT
    // ========================================================
    const masterResult = await client.query(
      `
      INSERT INTO Opex_Master
      (
        OrganizationID,
        OpexNumber,
        Department,
        Item,
        Description,
        Make,
        Qty,
        Rate,
        Total,
        IsVoid,
        IsDeleted,
        CreatedBy,
        CreatedDate
      )
      VALUES
      (
        $1,
        $2,
        $3,
        $4,
        $5,
        $6,
        $7,
        $8,
        $9,
        FALSE,
        FALSE,
        $10,
        CURRENT_TIMESTAMP
      )
      RETURNING OpexID, Total;
      `,
      [
        data.OrganizationID,
        OpexNumber,
        data.Department,
        data.Item,
        data.Description,
        data.Make,
        data.Qty,
        data.Rate,
        data.Total,
        data.CreatedBy,
      ],
    );

    // DB generated OpexID
    const OpexID = masterResult.rows[0].opexid;

    const total = Number(masterResult.rows[0].total);

    // ========================================================
    // 3. Create Documents
    // OpexDocumentID = AUTO INCREMENT
    // ========================================================
    for (const document of documents) {
      await client.query(
        `
        INSERT INTO Opex_Documents
        (
          OpexID,
          OpexNumber,
          FileName,
          FilePath,
          FileType,
          FileSize,
          IsDeleted,
          CreatedBy,
          CreatedDate
        )
        VALUES
        (
          $1,
          $2,
          $3,
          $4,
          $5,
          $6,
          FALSE,
          $7,
          CURRENT_TIMESTAMP
        );
        `,
        [
          OpexID,
          OpexNumber,
          document.FileName,
          document.FilePath,
          document.FileType,
          document.FileSize,
          data.CreatedBy,
        ],
      );
    }

    // ========================================================
    // 4. Approval Configuration
    // ========================================================
    await OpexWorkflow.getActor(client,data.OrganizationID,data.CreatedBy);
    const workflowSteps = await OpexWorkflow.snapshot(client,OpexID,data.OrganizationID);
    const firstStep = OpexWorkflow.currentStep(workflowSteps);
    const recipients = await OpexWorkflow.recipientIds(client,{organizationid:data.OrganizationID,
        department:data.Department,createdby:data.CreatedBy},firstStep);

    // ========================================================
    // 6. Create Approval
    // OpexApprovalID = AUTO INCREMENT
    // ========================================================
    await client.query(
      `
      INSERT INTO Opex_Approval
      (
        OpexID,
        HODStatus,
        FCStatus,
        GMStatus,
        RDFCStatus,
        CEOStatus,
        FinalStatus,
        IsDeleted,
        CreatedBy,
        CreatedDate
      )
      VALUES
      (
        $1,
        'Pending',
        'Pending',
        'Pending',
        'Pending',
        'Pending',
        'Pending',
        FALSE,
        $2,
        CURRENT_TIMESTAMP
      );
      `,
      [OpexID, data.CreatedBy],
    );

    if (!firstStep) await client.query(`UPDATE opex_approval SET finalstatus='Approved',
        finalstatusdatetime=CURRENT_TIMESTAMP WHERE opexid=$1 AND NOT isdeleted`,[OpexID]);

    // ========================================================
    // 7. Commit
    // ========================================================
    await client.query("COMMIT");
    transactionStarted = false;

    notifyCommittedOpex({
      organizationID: data.OrganizationID,
      opexID: OpexID,
      department: data.Department,
      roles: [],
      directUserIds: recipients,
      excludeUserID: null,
      actorUserID: data.CreatedBy,
      kind: firstStep ? "CREATE" : "AUTO_APPROVED",
      item: data.Item,
      qty: data.Qty,
      rate: data.Rate,
      total,
      description: data.Description,
      action: "CREATED",
    });

    return {
      success: true,
      message: "Opex created successfully.",
    };
  } catch (error) {
    await rollback(client, transactionStarted);

    console.error("Create Opex Error:", error.message);

    if (error.statusCode) return fail(error.message,error.statusCode);
    const retryResponse = retryableDatabaseResponse(error);

    if (retryResponse) return retryResponse;

    if (error.code === "23503") {
      return fail("Invalid Opex organization or related data.", 400);
    }

    if (error.code === "23505") {
      return fail("A Opex record with the same details already exists.", 409);
    }

    return fail("Unable to create Opex at this time.", 500);
  } finally {
    if (client) client.release();
  }
};
// ============================================================ Read Query and Mapping Helpers(Get Helpers)
// The lateral query derives the first non-approved stage for each Opex.
const normalizeOptionalOpexDate = (value) => {
  const normalized = String(value ?? "").trim();
  return normalized || null;
};

const isValidOpexDate = (value) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return (
    !Number.isNaN(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === value
  );
};

const getAllOpex = async data => {
  try {return await OpexWorkflowRead.list(data);} catch(error){return fail(error.message,error.statusCode||503);}
};
const getOpexById = async data => {
  try {return await OpexWorkflowRead.detail(data);} catch(error){return fail(error.message,error.statusCode||503);}
};
const getMergedApprovals = async (client, organizationID) => {
  const result = await client.query(
    `
    SELECT 
      OpexApprovalConfigID,
      ApprovalLevel,
      ApprovalRole,
      ApprovalOrder,
      IsMandatory
    FROM Opex_Approval_Config
    WHERE OrganizationID = $1
      AND IsDeleted = FALSE
    ORDER BY 
      ApprovalOrder ASC,
      ApprovalLevel ASC,
      OpexApprovalConfigID ASC;
    `,
    [organizationID],
  );

  // Organization-specific configuration exists
  if (result.rows.length > 0) {
    return result.rows.map((row) => ({
      LevelNo: Number(row.approvallevel),
      ApprovalRole: String(row.approvalrole || "")
        .trim()
        .toUpperCase(),
      ApprovalOrder: Number(row.approvalorder),
      IsMandatory: row.ismandatory,
    }));
  }

  // No organization-specific configuration
  // Use default GM -> CEO -> OWNER
  return DEFAULT_APPROVALS.map((approval, index) => ({
    LevelNo: approval.LevelNo,
    ApprovalRole: approval.ApprovalRole,
    ApprovalOrder: index + 1,
    IsMandatory: true,
  }));
};
// Distinguish not-found records from authorization failures.
const OpexExists = async (client, OpexID) => {
  const result = await client.query(
    `SELECT 1 FROM Opex_Master WHERE OpexID = $1 AND IsDeleted = FALSE LIMIT 1;`,
    [OpexID],
  );
  return result.rows.length > 0;
};
// ============================================================ Partial Update Opex
const updateOpex = async (data) => {
  let client;
  let transactionStarted = false;

  try {
    client = await pool.connect();

    await client.query("BEGIN");
    transactionStarted = true;
    await OpexWorkflow.authorizeModify(client,data.OpexID,data.UserID);

    // ============================================================
    // Changes
    // ============================================================

    const changes = data.Changes || {};

    const assignments = [];
    const values = [];

    const addValue = (column, value) => {
      values.push(value);
      assignments.push(`${column} = $${values.length}`);
    };

    // ============================================================
    // OPEX Fields
    // OrganizationID and OpexNumber are not updated
    // ============================================================

    if (changes.Department !== undefined) {
      addValue("Department", changes.Department);
    }

    if (changes.Item !== undefined) {
      addValue("Item", changes.Item);
    }

    if (changes.Description !== undefined) {
      addValue("Description", changes.Description);
    }

    if (changes.Make !== undefined) {
      addValue("Make", changes.Make);
    }

    if (changes.Qty !== undefined) {
      addValue("Qty", changes.Qty);
    }

    if (changes.Rate !== undefined) {
      addValue("Rate", changes.Rate);
    }

    if (changes.Total !== undefined) {
      addValue("Total", changes.Total);
    }

    if (changes.IsVoid !== undefined) {
      addValue("IsVoid", changes.IsVoid);
    }

    if (changes.VoidRemarks !== undefined) {
      addValue("VoidRemarks", changes.VoidRemarks);
    }

    // ============================================================
    // Modified Information
    // ============================================================

    addValue("ModifiedBy", data.UserID);
    assignments.push("ModifiedDate = CURRENT_TIMESTAMP");

    // ============================================================
    // Update OPEX
    // ============================================================

    values.push(data.OpexID);

    const opexIDParameter = values.length;

    const updateResult = await client.query(
      `
      UPDATE Opex_Master
      SET ${assignments.join(", ")}
      WHERE OpexID = $${opexIDParameter}
        AND IsDeleted = FALSE
      RETURNING
        OpexID,
        OrganizationID,
        OpexNumber,
        Department,
        Item,
        Description,
        Make,
        Qty,
        Rate,
        Total,
        IsVoid,
        VoidRemarks,
        ModifiedBy,
        ModifiedDate;
      `,
      values,
    );

    // ============================================================
    // OPEX Not Found
    // ============================================================

    if (updateResult.rows.length === 0) {
      await client.query("ROLLBACK");
      transactionStarted = false;

      return fail("OPEX record not found.", 404);
    }

    // ============================================================
    // DOCUMENT UPDATE RULES
    //
    // Documents === undefined:
    //   Documents unchanged
    //
    // Documents === null:
    //   All existing documents soft deleted
    //
    // Documents === []:
    //   All existing documents soft deleted
    //
    // Document with OpexDocumentID:
    //   Existing document, so it remains unchanged
    //
    // Document without OpexDocumentID:
    //   New document, so it will be inserted
    //
    // Existing document missing from Documents:
    //   Soft deleted
    // ============================================================

    if (data.Documents !== undefined) {
      if (
        data.Documents !== null &&
        !Array.isArray(data.Documents)
      ) {
        await client.query("ROLLBACK");
        transactionStarted = false;

        return fail("Documents must be an array or null.", 400);
      }

      const incomingDocuments = Array.isArray(data.Documents)
        ? data.Documents
        : [];

      const opexInfo = updateResult.rows[0];
      const opexNumber = Number(opexInfo.opexnumber);

      // ==========================================================
      // Get Current Active Documents
      // ==========================================================

      const existingDocumentsResult = await client.query(
        `
        SELECT
          OpexDocumentID,
          FileName,
          FilePath,
          FileType,
          FileSize
        FROM Opex_Documents
        WHERE OpexID = $1
          AND IsDeleted = FALSE
        FOR UPDATE;
        `,
        [data.OpexID],
      );

      const existingDocuments = existingDocumentsResult.rows;

      const existingDocumentIDs = new Set(
        existingDocuments.map((document) =>
          String(document.opexdocumentid),
        ),
      );

      // ==========================================================
      // Separate Existing and New Documents
      // ==========================================================

      const receivedExistingDocuments = [];
      const newDocuments = [];

      for (const document of incomingDocuments) {
        if (!document || typeof document !== "object") {
          await client.query("ROLLBACK");
          transactionStarted = false;

          return fail("Invalid OPEX document data.", 400);
        }

        const hasDocumentID =
          document.OpexDocumentID !== undefined &&
          document.OpexDocumentID !== null &&
          String(document.OpexDocumentID).trim() !== "";

        if (hasDocumentID) {
          receivedExistingDocuments.push(document);
        } else {
          newDocuments.push(document);
        }
      }

      // ==========================================================
      // Validate Existing Document IDs
      // ==========================================================

      const receivedExistingDocumentIDs = [
        ...new Set(
          receivedExistingDocuments.map((document) =>
            String(document.OpexDocumentID),
          ),
        ),
      ];

      const invalidDocumentID = receivedExistingDocumentIDs.find(
        (documentID) => !existingDocumentIDs.has(documentID),
      );

      if (invalidDocumentID) {
        await client.query("ROLLBACK");
        transactionStarted = false;

        return fail(
          "One or more existing OPEX documents are invalid.",
          400,
        );
      }

      // ==========================================================
      // Soft Delete Missing Existing Documents
      //
      // Documents null or []:
      // All current documents will be deleted.
      // ==========================================================

      const receivedDocumentIDSet = new Set(
        receivedExistingDocumentIDs,
      );

      const documentIDsToDelete = existingDocuments
        .filter(
          (document) =>
            !receivedDocumentIDSet.has(
              String(document.opexdocumentid),
            ),
        )
        .map((document) => document.opexdocumentid);

      if (documentIDsToDelete.length > 0) {
        await client.query(
          `
          UPDATE Opex_Documents
          SET
            IsDeleted = TRUE,
            DeletedBy = $1,
            DeletedDate = CURRENT_TIMESTAMP,
            ModifiedBy = $1,
            ModifiedDate = CURRENT_TIMESTAMP
          WHERE OpexID = $2
            AND OpexDocumentID = ANY($3::bigint[])
            AND IsDeleted = FALSE;
          `,
          [
            data.UserID,
            data.OpexID,
            documentIDsToDelete,
          ],
        );
      }

      // ==========================================================
      // Existing FilePaths That Will Remain Active
      // ==========================================================

      const activeFilePaths = new Set(
        existingDocuments
          .filter((document) =>
            receivedDocumentIDSet.has(
              String(document.opexdocumentid),
            ),
          )
          .map((document) => document.filepath)
          .filter(Boolean),
      );

      // ==========================================================
      // Validate and Remove Duplicate New Documents
      // ==========================================================

      const uniqueNewDocuments = [];

      for (const document of newDocuments) {
        if (
          document.FileName === undefined ||
          document.FileName === null ||
          String(document.FileName).trim() === ""
        ) {
          await client.query("ROLLBACK");
          transactionStarted = false;

          return fail(
            "FileName is required for new OPEX documents.",
            400,
          );
        }

        if (
          document.FilePath === undefined ||
          document.FilePath === null ||
          String(document.FilePath).trim() === ""
        ) {
          await client.query("ROLLBACK");
          transactionStarted = false;

          return fail(
            "FilePath is required for new OPEX documents.",
            400,
          );
        }

        const filePath = String(document.FilePath).trim();

        // Do not insert the same file path again
        if (activeFilePaths.has(filePath)) {
          continue;
        }

        activeFilePaths.add(filePath);

        uniqueNewDocuments.push({
          ...document,
          FileName: String(document.FileName).trim(),
          FilePath: filePath,
        });
      }

      // ==========================================================
      // Insert Only New Unique Documents
      // ==========================================================

      if (uniqueNewDocuments.length > 0) {
        const newDocumentIDs = await reserveNumericIDs(
          client,
          "Opex_Documents",
          "OpexDocumentID",
          uniqueNewDocuments.length,
        );

        for (
          let index = 0;
          index < uniqueNewDocuments.length;
          index += 1
        ) {
          const document = uniqueNewDocuments[index];

          await client.query(
            `
            INSERT INTO Opex_Documents
            (
              OpexDocumentID,
              OpexID,
              OpexNumber,
              FileName,
              FilePath,
              FileType,
              FileSize,
              IsDeleted,
              CreatedBy,
              CreatedDate
            )
            VALUES
            (
              $1,
              $2,
              $3,
              $4,
              $5,
              $6,
              $7,
              FALSE,
              $8,
              CURRENT_TIMESTAMP
            );
            `,
            [
              newDocumentIDs[index],
              data.OpexID,
              opexNumber,
              document.FileName,
              document.FilePath,
              document.FileType || null,
              document.FileSize ?? null,
              data.UserID,
            ],
          );
        }
      }
    }

    // ============================================================
    // COMMIT
    // ============================================================

    await client.query("COMMIT");
    transactionStarted = false;

    return {
      success: true,
      message: "OPEX updated successfully.",
    };
  } catch (error) {
    if (client && transactionStarted) {
      await client.query("ROLLBACK");
      transactionStarted = false;
    }

    console.error("Update OPEX Error:", error.message);

    if (error.statusCode) return fail(error.message,error.statusCode);
    const retryResponse = retryableDatabaseResponse(error);

    if (retryResponse) {
      return retryResponse;
    }

    if (error.code === "23503") {
      return fail("Invalid OPEX related data.", 400);
    }

    if (error.code === "23505") {
      return fail(
        "OPEX organization number or document already exists.",
        409,
      );
    }

    if (error.code === "22P02") {
      return fail("Invalid OPEX or document ID.", 400);
    }

    return fail("Unable to update OPEX at this time.", 500);
  } finally {
    if (client) {
      client.release();
    }
  }
};
// ============================================================ Soft Delete Opex
const deleteOpex = async (data) => {
  let client;
  let transactionStarted = false;

  try {
    client = await pool.connect();

    await client.query("BEGIN");
    transactionStarted = true;
    await OpexWorkflow.authorizeModify(client,data.OpexID,data.UserID);

    // ============================================================
    // SOFT DELETE Opex
    // ============================================================

    const OpexResult = await client.query(
      `
      UPDATE Opex_Master
      SET
        IsDeleted = TRUE,
        DeletedBy = $1,
        DeletedDate = CURRENT_TIMESTAMP,
        ModifiedBy = $1,
        ModifiedDate = CURRENT_TIMESTAMP
      WHERE OpexID = $2
        AND IsDeleted = FALSE
      RETURNING OpexID;
      `,
      [data.UserID, data.OpexID],
    );

    // ============================================================
    // Opex NOT FOUND / ALREADY DELETED
    // ============================================================

    if (OpexResult.rows.length === 0) {
      await client.query("ROLLBACK");
      transactionStarted = false;

      return fail("Opex record not found or already deleted.", 404);
    }

    // ============================================================
    // SOFT DELETE DOCUMENTS
    // ============================================================

    await client.query(
      `
      UPDATE Opex_Documents
      SET
        IsDeleted = TRUE,
        DeletedBy = $1,
        DeletedDate = CURRENT_TIMESTAMP,
        ModifiedBy = $1,
        ModifiedDate = CURRENT_TIMESTAMP
      WHERE OpexID = $2
        AND IsDeleted = FALSE;
      `,
      [data.UserID, data.OpexID],
    );

    // ============================================================
    // SOFT DELETE APPROVALS
    // ============================================================

    await client.query(
      `
      UPDATE Opex_Approval
      SET
        IsDeleted = TRUE,
        DeletedBy = $1,
        DeletedDate = CURRENT_TIMESTAMP,
        ModifiedBy = $1,
        ModifiedDate = CURRENT_TIMESTAMP
      WHERE OpexID = $2
        AND IsDeleted = FALSE;
      `,
      [data.UserID, data.OpexID],
    );

    // ============================================================
    // COMMIT
    // ============================================================

    await client.query("COMMIT");
    transactionStarted = false;

    return {
      success: true,
      message: "Opex deleted successfully.",
    };
  } catch (error) {
    if (client && transactionStarted) {
      await client.query("ROLLBACK");
    }

    console.error("Delete Opex Error:", error.message);

    if (error.statusCode) return fail(error.message,error.statusCode);
    const retryResponse = retryableDatabaseResponse(error);

    if (retryResponse) {
      return retryResponse;
    }

    return fail("Unable to delete Opex at this time.", 500);
  } finally {
    if (client) {
      client.release();
    }
  }
};
// ============================================================ Approval Workflow
const processOpexApproval = async (data) => {
  let client;
  let transactionStarted = false;

  // console.log("PROCESS Opex APPROVAL DATA:", JSON.stringify(data));

  try {
    // ============================================================
    // 1. NORMALIZE INPUT
    // ============================================================

    let access, approverRole;

    const action = String(data.Action || "")
      .trim()
      .toUpperCase();

    const remarks = String(data.Remarks || "").trim();
    const approvedQuantity =
      data.Quantity === undefined || data.Quantity === null
        ? null
        : Number(data.Quantity);

    // ============================================================
    // 2. VALIDATE ACTION
    // ============================================================

    if (!["APPROVE", "REJECT", "RETURN", "HOLD"].includes(action)) {
      return fail("Invalid Opex approval action.", 400);
    }

    // ============================================================
    // 3. REMARKS REQUIRED
    // ============================================================

    if (["REJECT", "RETURN", "HOLD"].includes(action) && !remarks) {
      return fail(`Remarks are required when the action is ${action}.`, 400);
    }

    if (
      approvedQuantity !== null &&
      (!Number.isFinite(approvedQuantity) || approvedQuantity <= 0)
    ) {
      return fail("Quantity must be a number greater than zero.", 400);
    }

    // ============================================================
    // 4. VALIDATE ROLE
    // ============================================================

    // ============================================================
    // 5. DB CONNECTION
    // ============================================================

    client = await pool.connect();

    await client.query("BEGIN");
    transactionStarted = true;

    // ============================================================
    // 6. GET Opex MASTER
    // ============================================================

    const masterResult = await client.query(
      `
      SELECT
        cm.OpexID,
        cm.OpexNumber,
        cm.OrganizationID,
        cm.CreatedBy,
        cm.Department,
        cm.Item,
        cm.Qty,
        cm.Rate,
        cm.Total,
        cm.Description,
        cm.IsVoid,
        cm.ModifiedDate
      FROM Opex_Master cm
      WHERE cm.OpexID = $1
        AND cm.IsDeleted = FALSE
      LIMIT 1
      FOR UPDATE OF cm;
      `,
      [data.OpexID],
    );

    // ============================================================
    // 7. Opex NOT FOUND
    // ============================================================

    if (masterResult.rows.length === 0) {
      const exists = await OpexExists(client, data.OpexID);

      await rollback(client, transactionStarted);

      transactionStarted = false;

      return exists
        ? fail("Opex record is not available for approval.", 400)
        : fail("Opex record not found.", 404);
    }

    const Opex = masterResult.rows[0];
    const actor=await OpexWorkflow.getActor(client,Opex.organizationid,data.UserID);
    const dynamic=await OpexWorkflow.applyAction(client,Opex,data,actor);
    if(dynamic) {
      const target=dynamic.change.action === "APPROVE" ? dynamic.next : dynamic.step;
      const recipients=[...new Set([...(target ? await OpexWorkflow.recipientIds(client,Opex,target) : []),String(Opex.createdby)])];
      await client.query("COMMIT");
      transactionStarted=false;
      notifyCommittedOpex({organizationID:Opex.organizationid,opexID:Opex.opexid,
        department:Opex.department,roles:[],directUserIds:recipients,actorUserID:data.UserID,
        excludeUserID:dynamic.change.action === "APPROVE" ? null : data.UserID,
        kind:dynamic.change.action,item:Opex.item,qty:Opex.qty,rate:Opex.rate,total:Opex.total,
        description:Opex.description,actionQuantity:dynamic.change.quantity,remark:dynamic.change.remarks,
        actionDate:new Date().toISOString(),approverRole:dynamic.step.approvaltype,action:dynamic.change.status.toUpperCase()});
      return {success:true,message:dynamic.finalStatus === "Approved" ? "OPEX finally approved successfully." : "OPEX action recorded successfully."};
    }
    // Existing requests retain Finance auto-approval and central RD-FC rules.
    access=await resolveOpexAccess({...data,UserType:actor.usertype,DepartmentName:actor.departmentname},client,{approvalAction:true});
    if(access.error) return await cleanupAndFail(client,transactionStarted,access.error);
    approverRole=access.effectiveRole;
    if(!APPROVAL_ROLES.has(approverRole)) return await cleanupAndFail(client,transactionStarted,fail("Not authorized for OPEX approval",403));


    if (Opex.isvoid === true) {
      await rollback(client, transactionStarted);
      transactionStarted = false;
      return fail("Void Opex cannot be processed for approval.", 400);
    }

    // ============================================================
    // 8. GET APPROVAL CONFIGURATION
    //
    // getMergedApprovals():
    // 1. Organization-specific configuration
    // 2. If organization config not found -> DEFAULT
    // ============================================================

    const configuredStages = await getMergedApprovals(
      client,
      Opex.organizationid,
    );

    if (!configuredStages || configuredStages.length === 0) {
      await rollback(client, transactionStarted);

      transactionStarted = false;

      return fail("Opex approval configuration not found.", 400);
    }

    if (!approvalConfigurationIsValid(configuredStages)) {
      await rollback(client, transactionStarted);

      transactionStarted = false;

      return fail(
        "Opex approval configuration contains an invalid approval role.",
        400,
      );
    }

    // ============================================================
    // 9. GET Opex APPROVAL
    // ============================================================

    const approvalResult = await client.query(
      `
      SELECT
        OpexApprovalID,

       HODStatus,
HODApprovedQuantity,
HODStatusDateTime,
HODStatusApprovedBy,
HODRemarks,

FCStatus,
FCApprovedQuantity,
FCStatusDateTime,
FCStatusApprovedBy,
FCRemarks,

GMStatus,
GMApprovedQuantity,
GMStatusDateTime,
GMStatusApprovedBy,
GMRemarks,

RDFCStatus,
RDFCApprovedQuantity,
RDFCStatusDateTime,
RDFCStatusApprovedBy,
RDFCRemarks,

CEOStatus,
CEOApprovedQuantity,
CEOStatusDateTime,
CEOStatusApprovedBy,
CEORemarks,

        FinalStatus,
        FinalStatusDateTime

      FROM Opex_Approval

      WHERE OpexID = $1
        AND IsDeleted = FALSE

      LIMIT 1

      FOR UPDATE;
      `,
      [data.OpexID],
    );

    // ============================================================
    // 10. APPROVAL ROW NOT FOUND
    // ============================================================

    if (approvalResult.rows.length === 0) {
      await rollback(client, transactionStarted);

      transactionStarted = false;

      return fail("Opex approval record not found.", 404);
    }

    const approval = approvalResult.rows[0];

    // ============================================================
    // 11. ROLE DATA HELPER
    // ============================================================

    const getRoleData = (role) => {
      switch (String(role).trim().toUpperCase()) {
        case "HOD":
          return {
            status: approval.hodstatus,
            approvedQuantity: approval.hodapprovedquantity,
            statusDateTime: approval.hodstatusdatetime,
            approvedBy: approval.hodstatusapprovedby,
            remarks: approval.hodremarks,
          };

        case "FC":
          return {
            status: approval.fcstatus,
            approvedQuantity: approval.fcapprovedquantity,
            statusDateTime: approval.fcstatusdatetime,
            approvedBy: approval.fcstatusapprovedby,
            remarks: approval.fcremarks,
          };

        case "GM":
          return {
            status: approval.gmstatus,
            approvedQuantity: approval.gmapprovedquantity,
            statusDateTime: approval.gmstatusdatetime,
            approvedBy: approval.gmstatusapprovedby,
            remarks: approval.gmremarks,
          };

        case "RD-FC":
          return {
            status: approval.rdfcstatus,
            approvedQuantity: approval.rdfcapprovedquantity,
            statusDateTime: approval.rdfcstatusdatetime,
            approvedBy: approval.rdfcstatusapprovedby,
            remarks: approval.rdfcremarks,
          };

        case "CEO":
          return {
            status: approval.ceostatus,
            approvedQuantity: approval.ceoapprovedquantity,
            statusDateTime: approval.ceostatusdatetime,
            approvedBy: approval.ceostatusapprovedby,
            remarks: approval.ceoremarks,
          };

        default:
          return null;
      }
    };

    // ============================================================
    // 12. BUILD APPROVAL STAGES
    // ============================================================

    const stages = configuredStages.map((stage) => {
      const role = String(stage.ApprovalRole).trim().toUpperCase();

      const roleData = getRoleData(role);

      return {
        configured: stage,
        role,
        approval: roleData,

        status: String(roleData?.status || "Pending")
          .trim()
          .toUpperCase(),
      };
    });

    // console.log("Opex APPROVAL STAGES:", JSON.stringify(stages));

    // ============================================================
    // 13. FIND CURRENT STAGE
    //
    // IMPORTANT:
    //
    // APPROVED  -> skip
    // PENDING   -> current
    // RETURNED  -> current
    // HOLD      -> current
    // REJECTED  -> current
    //
    // This means:
    //
    // GM REJECTED
    // CEO PENDING
    //
    // GM is current again and can APPROVE.
    // ============================================================

    const currentIndex = stages.findIndex(
      (stage) => stage.status !== "APPROVED",
    );

    // ============================================================
    // 14. ALL APPROVED
    // ============================================================

    if (currentIndex === -1) {
      await rollback(client, transactionStarted);

      transactionStarted = false;

      return fail("This Opex record is already finally approved.", 400);
    }

    const currentStage = stages[currentIndex];

    const currentRole = currentStage.role;

    const currentStatus = currentStage.status;

    // Finance HOD and FC are the same user for Finance department OPEX.
    // When the current stage is HOD, this Finance HOD must act as HOD first.
    // FC will be auto-approved in the APPROVE flow below.
    const isFinanceOpexSameUser = (
      access.financeHod === true &&
      String(Opex.department || "").trim().toUpperCase() === "FINANCE"
    );

    if (isFinanceOpexSameUser && currentStage.role === "HOD") {
      approverRole = "HOD";
    }

    // Finance HOD is the effective HOD only for its own Finance OPEX while
    // that configured stage is current. Later FC/RD-FC stages remain unchanged.
    if (
      access.financeHod &&
      currentRole === "HOD" &&
      String(Opex.department || "").trim().toUpperCase() === "FINANCE"
    ) {
      approverRole = "HOD";
    }

    // Build one notification from the locked OPEX row and effective configured stage.
    const notifyApprovalCommitted = ({ kind, notificationAction, roles = [],
      includeCreator = false, excludeActor = false, actionDate: committedActionDate }) => notifyCommittedOpex({
        organizationID: Opex.organizationid, opexID: Opex.opexid,
        department: Opex.department, roles,
        directUserIds: includeCreator ? [Opex.createdby] : [],
        excludeUserID: excludeActor ? data.UserID : null, actorUserID: data.UserID,
        kind, item: Opex.item, qty: Opex.qty, rate: Opex.rate, total: Opex.total,
        description: Opex.description, actionQuantity: approvedQuantity, remark: remarks,
        actionDate: committedActionDate,
        approverRole, action: notificationAction,
      });

    // ============================================================
    // 15. FIND USER'S STAGE
    // ============================================================

    OpexWorkflow.authorizeApproval(Opex, stages.map(stage => ({...stage,
      stepid:"legacy:"+stage.role,approvertype:"ROLE",approvaltype:stage.role,
      organizationid:Opex.organizationid,requestdepartment:Opex.department,
      actionby:stage.approval?.approvedBy,actiondatetime:stage.approval?.statusDateTime,
      ismandatory:true})), actor, action, data.ApprovalStepID || "legacy:"+currentRole);

    const userStageIndex = stages.findIndex(
      (stage) => stage.role === approverRole,
    );

    if (userStageIndex === -1) {
      await rollback(client, transactionStarted);

      transactionStarted = false;

      return fail(
        `Approval stage not configured for role ${approverRole}.`,
        403,
      );
    }

    const userStage = stages[userStageIndex];

    const userStatus = userStage.status;

    // ============================================================
    // 16. CHECK PERMISSION
    //
    // RULES
    //
    // ------------------------------------------------------------
    // CASE 1:
    // Current role can APPROVE / REJECT / RETURN
    //
    // Pending:
    // GM -> APPROVE
    // GM -> REJECT
    // GM -> RETURN
    //
    // ------------------------------------------------------------
    // CASE 2:
    // Rejected current role can APPROVE again
    //
    // GM REJECTED
    // ->
    // GM APPROVE
    //
    // ------------------------------------------------------------
    // CASE 3:
    // Previous APPROVED role can REJECT / RETURN
    // while next role is PENDING.
    //
    // GM APPROVED
    // CEO PENDING
    //
    // GM:
    // APPROVE  -> NO
    // REJECT   -> YES
    // RETURN   -> YES
    //
    // CEO:
    // APPROVE  -> YES
    // REJECT   -> YES
    // RETURN   -> YES
    // ============================================================

    let canPerformAction = false;

    // ------------------------------------------------------------
    // CASE 1:
    // USER IS CURRENT STAGE
    //
    // PENDING / RETURNED / REJECTED / HOLD
    // ------------------------------------------------------------

    if (
      userStageIndex === currentIndex &&
      ["PENDING", "RETURNED", "REJECTED", "HOLD"].includes(userStatus)
    ) {
      canPerformAction = true;
    }

    // ------------------------------------------------------------
    // CASE 2:
    // PREVIOUS APPROVED STAGE
    //
    // Can only REJECT / RETURN
    // while next stage is pending.
    // ------------------------------------------------------------

    const nextStage = stages[userStageIndex + 1];

    if (
      userStageIndex < currentIndex &&
      userStatus === "APPROVED" &&
      nextStage &&
      nextStage.status === "PENDING" &&
      ["REJECT", "RETURN"].includes(action)
    ) {
      canPerformAction = true;
    }

    // ============================================================
    // 17. PERMISSION DENIED
    // ============================================================

    if (!canPerformAction) {
      await rollback(client, transactionStarted);

      transactionStarted = false;

      if (userStageIndex !== currentIndex) {
        return fail(
          `OPEX is ${currentStatus.toLowerCase()} from ${currentRole}.`,
          403,
        );
      }

      return fail(
        `The ${currentRole} approval stage is currently ${currentStatus.toLowerCase()} and cannot perform ${action.toLowerCase()} again.`,
        403,
      );
    }

    // ============================================================
    // 18. UPDATE ROLE APPROVAL HELPER
    // ============================================================

    const updateRoleApproval = async (
      role,
      status,
      userId,
      roleRemarks,
      approvedQuantity = null,
    ) => {
      let query = "";

      const params = [
        status,
        userId,
        roleRemarks || null,
        approvedQuantity !== undefined &&
          approvedQuantity !== null &&
          approvedQuantity !== ""
          ? Number(approvedQuantity)
          : null,
        approval.opexapprovalid,
      ];
      switch (role) {
        case "HOD":
          query = `
    UPDATE Opex_Approval
    SET
      HODStatus = $1,
      HODStatusDateTime = CURRENT_TIMESTAMP,
      HODStatusApprovedBy = $2,
      HODRemarks = $3,
      HODApprovedQuantity = $4,
      ModifiedBy = $2,
      ModifiedDate = CURRENT_TIMESTAMP
    WHERE OpexApprovalID = $5
      AND IsDeleted = FALSE
    RETURNING HODStatusDateTime AS ActionDate;
  `;
          break;

        case "FC":
          query = `
    UPDATE Opex_Approval
    SET
      FCStatus = $1,
      FCStatusDateTime = CURRENT_TIMESTAMP,
      FCStatusApprovedBy = $2,
      FCRemarks = $3,
      FCApprovedQuantity = $4,
      ModifiedBy = $2,
      ModifiedDate = CURRENT_TIMESTAMP
    WHERE OpexApprovalID = $5
      AND IsDeleted = FALSE
    RETURNING FCStatusDateTime AS ActionDate;
  `;
          break;
        case "GM":
          query = `
    UPDATE Opex_Approval
    SET
      GMStatus = $1,
      GMStatusDateTime = CURRENT_TIMESTAMP,
      GMStatusApprovedBy = $2,
      GMRemarks = $3,
      GMApprovedQuantity = $4,
      ModifiedBy = $2,
      ModifiedDate = CURRENT_TIMESTAMP
    WHERE OpexApprovalID = $5
      AND IsDeleted = FALSE
    RETURNING GMStatusDateTime AS ActionDate;
  `;
          break;

        case "RD-FC":
          query = `
    UPDATE Opex_Approval
    SET
      RDFCStatus = $1,
      RDFCStatusDateTime = CURRENT_TIMESTAMP,
      RDFCStatusApprovedBy = $2,
      RDFCRemarks = $3,
      RDFCApprovedQuantity = $4,
      ModifiedBy = $2,
      ModifiedDate = CURRENT_TIMESTAMP
    WHERE OpexApprovalID = $5
      AND IsDeleted = FALSE
    RETURNING RDFCStatusDateTime AS ActionDate;
  `;
          break;

        case "CEO":
          query = `
    UPDATE Opex_Approval
    SET
      CEOStatus = $1,
      CEOStatusDateTime = CURRENT_TIMESTAMP,
      CEOStatusApprovedBy = $2,
      CEORemarks = $3,
      CEOApprovedQuantity = $4,
      ModifiedBy = $2,
      ModifiedDate = CURRENT_TIMESTAMP
    WHERE OpexApprovalID = $5
      AND IsDeleted = FALSE
    RETURNING CEOStatusDateTime AS ActionDate;
  `;
          break;

        default:
          throw new Error(`Unsupported approval role: ${role}`);
      }

      const result = await client.query(query, params);
      return result.rows[0]?.actiondate || null;
    };

    // ============================================================
    // 19. APPROVE
    //
    // APPROVE ONLY CURRENT STAGE
    // ============================================================

    if (action === "APPROVE") {
      if (userStageIndex !== currentIndex) {
        await rollback(client, transactionStarted);

        transactionStarted = false;

        return fail(
          `Only the current ${currentRole} approval stage can approve this Opex.`,
          403,
        );
      }

      // ----------------------------------------------------------
      // Update current role
      // ----------------------------------------------------------

      const committedActionDate = await updateRoleApproval(
        approverRole,
        "Approved",
        data.UserID,
        remarks,
        approvedQuantity,
      );

      // ----------------------------------------------------------
      // Find next stage
      // ----------------------------------------------------------

      // const followingStage = stages[currentIndex + 1];
      // ----------------------------------------------------------
      // Find next stage
      // ----------------------------------------------------------

      const followingStage = stages[currentIndex + 1];

      // ----------------------------------------------------------
      // FINANCE HOD + FC SAME USER
      //
      // For Finance OPEX:
      // HOD approval automatically approves FC.
      // The workflow then moves directly to GM.
      // No separate FC approval/notification.
      // ----------------------------------------------------------

      const autoApproveFinanceFC =
        isFinanceOpexSameUser &&
        approverRole === "HOD" &&
        followingStage?.role === "FC";

      if (autoApproveFinanceFC) {
        await updateRoleApproval(
          "FC",
          "Approved",
          data.UserID,
          null,
          approvedQuantity,
        );
      }

      // If FC was auto-approved, skip FC and move to the next stage.
      // Normally this will be GM.
      const nextStage = autoApproveFinanceFC
        ? stages[currentIndex + 2]
        : followingStage;



      // ----------------------------------------------------------
      // NEXT APPROVAL EXISTS
      // ----------------------------------------------------------

      if (nextStage) {
        await client.query(
          `
          UPDATE Opex_Approval
          SET
            FinalStatus = NULL,
            FinalStatusDateTime = NULL,
            ModifiedBy = $1,
            ModifiedDate = CURRENT_TIMESTAMP
          WHERE OpexApprovalID = $2
            AND IsDeleted = FALSE;
          `,
          [data.UserID, approval.opexapprovalid],
        );

        await client.query("COMMIT");

        transactionStarted = false;

        notifyApprovalCommitted({
          kind: "APPROVE", notificationAction: "APPROVED",
          roles: [nextStage.role], excludeActor: true,
          actionDate: committedActionDate
        });

        return {
          success: true,

          message: "Opex approved successfully.",

          // data: {
          //   OpexID: Number(Opex.Opexid),

          //   OpexNumber: Number(Opex.Opexnumber),

          //   CurrentStatus: "Pending",

          //   CurrentApprovalRole: nextStage.role,

          //   Action: "APPROVE",
          // },
        };
      }

      // ----------------------------------------------------------
      // FINAL APPROVAL
      // ----------------------------------------------------------

      await client.query(
        `
        UPDATE Opex_Approval
        SET
          FinalStatus = 'Approved',
          FinalStatusDateTime = CURRENT_TIMESTAMP,
          ModifiedBy = $1,
          ModifiedDate = CURRENT_TIMESTAMP
        WHERE OpexApprovalID = $2
          AND IsDeleted = FALSE;
        `,
        [data.UserID, approval.opexapprovalid],
      );

      await client.query("COMMIT");

      transactionStarted = false;

      notifyApprovalCommitted({
        kind: "APPROVE", notificationAction: "APPROVED",
        excludeActor: true, actionDate: committedActionDate
      });

      return {
        success: true,

        message: "Opex approved successfully.",

        // data: {
        //   OpexID: Number(Opex.Opexid),

        //   OpexNumber: Number(Opex.Opexnumber),

        //   CurrentStatus: "Approved",

        //   CurrentApprovalRole: null,

        //   Action: "APPROVE",
        // },
      };
    }

    // ============================================================
    // 20. REJECT
    //
    // Current stage can reject.
    //
    // Previous approved stage can also reject
    // while next stage is pending.
    //
    // Example:
    //
    // GM APPROVED
    // CEO PENDING
    //
    // GM REJECT
    //
    // GM -> REJECTED
    // FinalStatus -> REJECTED
    //
    // Later GM can APPROVE again.
    // ============================================================

    if (action === "REJECT") {
      const committedActionDate = await updateRoleApproval(
        approverRole,
        "Rejected",
        data.UserID,
        remarks,
        approvedQuantity,
      );

      await client.query(
        `
        UPDATE Opex_Approval
        SET
          FinalStatus = 'Rejected',
          FinalStatusDateTime = CURRENT_TIMESTAMP,
          ModifiedBy = $1,
          ModifiedDate = CURRENT_TIMESTAMP
        WHERE OpexApprovalID = $2
          AND IsDeleted = FALSE;
        `,
        [data.UserID, approval.opexapprovalid],
      );

      await client.query("COMMIT");

      transactionStarted = false;

      notifyApprovalCommitted({
        kind: "REJECT", notificationAction: "REJECTED",
        roles: [approverRole], includeCreator: true, excludeActor: true,
        actionDate: committedActionDate
      });

      return {
        success: true,

        message: "Opex rejected successfully.",

        // data: {
        //   OpexID: Number(Opex.Opexid),

        //   OpexNumber: Number(Opex.Opexnumber),

        //   CurrentStatus: "Rejected",

        //   CurrentApprovalRole: approverRole,

        //   Action: "REJECT",
        // },
      };
    }

    // ============================================================
    // 21. RETURN
    // ============================================================

    if (action === "RETURN") {
      // ----------------------------------------------------------
      // If previous approved role returns
      //
      // Example:
      //
      // GM APPROVED
      // CEO PENDING
      //
      // GM RETURN
      //
      // GM becomes RETURNED
      // GM becomes current stage
      // ----------------------------------------------------------

      const committedActionDate = await updateRoleApproval(
        approverRole,
        "Returned",
        data.UserID,
        remarks,
        approvedQuantity,
      );

      await client.query(
        `
        UPDATE Opex_Approval
        SET
          FinalStatus = 'Returned',
          FinalStatusDateTime = CURRENT_TIMESTAMP,
          ModifiedBy = $1,
          ModifiedDate = CURRENT_TIMESTAMP
        WHERE OpexApprovalID = $2
          AND IsDeleted = FALSE;
        `,
        [data.UserID, approval.opexapprovalid],
      );

      await client.query("COMMIT");

      transactionStarted = false;

      notifyApprovalCommitted({
        kind: "RETURN", notificationAction: "RETURNED",
        roles: [approverRole], includeCreator: true, excludeActor: true,
        actionDate: committedActionDate
      });

      return {
        success: true,

        message: "Opex returned successfully.",

        // data: {
        //   OpexID: Number(Opex.Opexid),

        //   OpexNumber: Number(Opex.Opexnumber),

        //   CurrentStatus: "Returned",

        //   CurrentApprovalRole: approverRole,

        //   Action: "RETURN",
        // },
      };
    }

    // ============================================================
    // 22. HOLD
    // Keep the current stage actionable for the same approver.
    // ============================================================

    if (action === "HOLD") {
      if (userStageIndex !== currentIndex) {
        await rollback(client, transactionStarted);
        transactionStarted = false;

        return fail(
          `Only the current ${currentRole} approval stage can hold this Opex.`,
          403,
        );
      }

      const committedActionDate = await updateRoleApproval(
        approverRole,
        "Hold",
        data.UserID,
        remarks,
        approvedQuantity,
      );

      await client.query(
        `
        UPDATE Opex_Approval
        SET
          FinalStatus = 'Hold',
          FinalStatusDateTime = CURRENT_TIMESTAMP,
          ModifiedBy = $1,
          ModifiedDate = CURRENT_TIMESTAMP
        WHERE OpexApprovalID = $2
          AND IsDeleted = FALSE;
        `,
        [data.UserID, approval.opexapprovalid],
      );

      await client.query("COMMIT");
      transactionStarted = false;

      notifyApprovalCommitted({
        kind: "HOLD", notificationAction: "HOLD",
        roles: [currentRole], includeCreator: true, excludeActor: true,
        actionDate: committedActionDate
      });

      return {
        success: true,
        message: "Opex put on hold successfully.",
      };
    }

    // ============================================================
    // 23. FALLBACK
    // ============================================================

    await rollback(client, transactionStarted);

    transactionStarted = false;

    return fail("Unable to process Opex approval.", 400);
  } catch (error) {
    await rollback(client, transactionStarted);

    console.error("Opex Approval Error:", error.message);

    if (error.statusCode) return fail(error.message,error.statusCode);
    const retryResponse = retryableDatabaseResponse(error);

    if (retryResponse) {
      return retryResponse;
    }

    return fail("Unable to process Opex approval at this time.", 500);
  } finally {
    if (client) {
      client.release();
    }
  }
};

// ============================================================ Report SQL (Summary and other reports Helpers)
// PostgreSQL derives effective status and aggregates authorized Opex records.
const validateOpexReportDates = (data) => {
  const filters = data.Filters || data || {};
  const fromDate = normalizeOptionalOpexDate(filters.FromDate);
  const toDate = normalizeOptionalOpexDate(filters.ToDate);

  if (fromDate && !isValidOpexDate(fromDate)) {
    return fail("FromDate must be a valid date in YYYY-MM-DD format.", 400);
  }
  if (toDate && !isValidOpexDate(toDate)) {
    return fail("ToDate must be a valid date in YYYY-MM-DD format.", 400);
  }
  if (fromDate && toDate && fromDate > toDate) {
    return fail("FromDate cannot be greater than ToDate.", 400);
  }

  return null;
};
// Read/report failures return synchronously; they are not background-retried.
const reportFailure = (error, reportName) => {
  console.error(`${reportName} Error:`, error.message);

  return fail(`Unable to generate ${reportName} at this time.`, 503);
};
// Keep role-scoped and organization-wide summaries on the same response shape.
const opexSummaryData = (row) => ({
  TotalOpex: Number(row.totalopex),
  TotalAmount: Number(row.totalamount),
  PendingCount: Number(row.pendingcount),
  PendingAmount: Number(row.pendingamount),
  ApprovedCount: Number(row.approvedcount),
  ApprovedAmount: Number(row.approvedamount),
  RejectedCount: Number(row.rejectedcount),
  RejectedAmount: Number(row.rejectedamount),
  HoldCount: Number(row.holdcount),
  HoldAmount: Number(row.holdamount),
  ReturnedCount: Number(row.returnedcount),
  ReturnedAmount: Number(row.returnedamount),
  VoidCount: Number(row.voidcount),
  VoidAmount: Number(row.voidamount),
});
// ============================================================ Summary Report
const getOpexSummaryReport = async data => {
  try { const [row]=await OpexWorkflowRead.report(data);
    return {success:true,data:opexSummaryData({...row,totalopex:row.count})};
  } catch(error){return fail(error.message,error.statusCode||503);}
};
const groupedReportRows = (rows, groupField) =>
  rows.map((row) => ({
    [groupField]:
      groupField === "OrganizationID"
        ? Number(row.organizationid)
        : row.department,
    Count: Number(row.count),
    TotalAmount: Number(row.totalamount),
    ApprovedCount: Number(row.approvedcount),
    PendingCount: Number(row.pendingcount),
    RejectedCount: Number(row.rejectedcount),
    HoldCount: Number(row.holdcount),
    ReturnedCount: Number(row.returnedcount),
  }));
// ============================================================ Department Report
const getOpexDepartmentReport = async data => {
  try {return {success:true,data:groupedReportRows(await OpexWorkflowRead.report(data,"department"),"Department")};}
  catch(error){return fail(error.message,error.statusCode||503);}
};
const getOpexOrganizationReport = async data => {
  try {const rows=await OpexWorkflowRead.report(data,"organization");
    return {success:true,data:groupedReportRows(rows,"OrganizationID").map((row,i)=>({...row,OrganizationID:Number(rows[i].organizationid),ShortName:rows[i].shortname}))};}
  catch(error){return fail(error.message,error.statusCode||503);}
};
const getApprovalConfig = async (data) => {
  try {
    const { OrganizationID } = data;

    let query = `
      SELECT
        OpexApprovalConfigID,
        OrganizationID,
        ApprovalLevel,
        ApprovalRole,
        ApprovalOrder,
        IsMandatory,
        CreatedBy,
        CreatedDate,
        ModifiedBy,
        ModifiedDate
      FROM Opex_Approval_Config
      WHERE IsDeleted = FALSE
    `;

    const params = [];

    if (OrganizationID !== null && OrganizationID !== undefined) {
      params.push(OrganizationID);

      query += `
        AND OrganizationID = $${params.length}
      `;
    }

    query += `
      ORDER BY
        OrganizationID ASC,
        ApprovalOrder ASC,
        ApprovalLevel ASC,
        OpexApprovalConfigID ASC;
    `;

    const result = await pool.query(query, params);

    return {
      success: true,
      message: "Opex approval configuration fetched successfully.",
      data: result.rows.map((row) => ({
        OpexApprovalConfigID: Number(row.opexapprovalconfigid),
        OrganizationID: Number(row.organizationid),
        ApprovalLevel: Number(row.approvallevel),
        ApprovalRole: row.approvalrole,
        ApprovalOrder: Number(row.approvalorder),
        IsMandatory: row.ismandatory,

        CreatedDate: formatDate(row.createddate),
      })),
    };
  } catch (error) {
    console.error("Get Opex Approval Config Error:", error.message);

    if (error.statusCode) return fail(error.message,error.statusCode);
    const retryResponse = retryableDatabaseResponse(error);
    if (retryResponse) return retryResponse;

    return fail(
      "Unable to fetch Opex approval configuration at this time.",
      500,
    );
  }
};
// ============================================================Create Approval Config
const createApprovalConfig = async (data) => {
  let client;
  let transactionStarted = false;

  try {
    console.log("SAVE Opex DATA =>", JSON.stringify(data, null, 2));

    const OrganizationID = Number(data.OrganizationID);

    const approvals = Array.isArray(data.Approvals) ? data.Approvals : [];

    if (!Number.isInteger(OrganizationID) || OrganizationID <= 0) {
      return fail("OrganizationID is required.", 400);
    }

    if (approvals.length === 0) {
      return fail("At least one approval configuration is required.", 400);
    }

    // ============================================================
    // NORMALIZE + VALIDATE
    // ============================================================

    const normalizedApprovals = approvals.map((approval) => ({
      ApprovalLevel: Number(approval.ApprovalLevel),

      ApprovalRole: String(approval.ApprovalRole || "")
        .trim()
        .toUpperCase(),

      ApprovalOrder: Number(approval.ApprovalOrder),

      IsMandatory:
        approval.IsMandatory === undefined
          ? true
          : Boolean(approval.IsMandatory),
    }));

    const levels = new Set();
    const roles = new Set();

    for (const approval of normalizedApprovals) {
      const { ApprovalLevel, ApprovalRole, ApprovalOrder } = approval;

      if (!Number.isInteger(ApprovalLevel) || ApprovalLevel < 1) {
        return fail("ApprovalLevel must be a positive integer.", 400);
      }

      if (!Number.isInteger(ApprovalOrder) || ApprovalOrder < 1) {
        return fail("ApprovalOrder must be a positive integer.", 400);
      }

      if (!APPROVAL_ROLES.has(ApprovalRole)) {
        return fail("ApprovalRole must be HOD, FC, GM, RD-FC, or CEO.", 400);
      }

      if (levels.has(ApprovalLevel)) {
        return fail(
          `Approval level ${ApprovalLevel} is duplicated in request.`,
          409,
        );
      }

      if (roles.has(ApprovalRole)) {
        return fail(
          `${ApprovalRole} approval stage is duplicated in request.`,
          409,
        );
      }

      levels.add(ApprovalLevel);
      roles.add(ApprovalRole);
    }

    // ============================================================
    // TRANSACTION
    // ============================================================

    client = await pool.connect();

    await client.query("BEGIN");
    transactionStarted = true;

    // ============================================================
    // GET ALL EXISTING CONFIGS
    // Active + Deleted
    // ============================================================

    const existingResult = await client.query(
      `
      SELECT
        OpexApprovalConfigID AS "OpexApprovalConfigID",
        OrganizationID AS "OrganizationID",
        ApprovalLevel AS "ApprovalLevel",
        ApprovalRole AS "ApprovalRole",
        ApprovalOrder AS "ApprovalOrder",
        IsMandatory AS "IsMandatory",
        IsDeleted AS "IsDeleted"
      FROM Opex_Approval_Config
      WHERE OrganizationID = $1
      ORDER BY ApprovalLevel ASC, OpexApprovalConfigID ASC
      FOR UPDATE;
      `,
      [OrganizationID],
    );

    const existingConfigs = existingResult.rows;

    console.log(
      "EXISTING Opex CONFIGS =>",
      JSON.stringify(existingConfigs, null, 2),
    );

    // ============================================================
    // MAP BY LEVEL
    // ============================================================

    const existingByLevel = new Map();

    for (const row of existingConfigs) {
      existingByLevel.set(Number(row.ApprovalLevel), row);
    }

    const processedLevels = new Set();

    const inserted = [];
    const updated = [];
    const restored = [];
    const deleted = [];

    // ============================================================
    // INSERT / UPDATE / RESTORE
    // ============================================================

    for (const approval of normalizedApprovals) {
      const { ApprovalLevel, ApprovalRole, ApprovalOrder, IsMandatory } =
        approval;

      const existing = existingByLevel.get(ApprovalLevel);

      // ==========================================================
      // EXISTING RECORD
      // ==========================================================

      if (existing) {
        const ConfigID = Number(existing.OpexApprovalConfigID);

        if (!Number.isInteger(ConfigID)) {
          throw new Error(
            `Invalid OpexApprovalConfigID: ${existing.OpexApprovalConfigID}`,
          );
        }

        // --------------------------------------------------------
        // RESTORE SOFT DELETED RECORD
        // --------------------------------------------------------

        if (existing.IsDeleted === true) {
          await client.query(
            `
            UPDATE Opex_Approval_Config
            SET
              ApprovalRole = $1,
              ApprovalOrder = $2,
              IsMandatory = $3,
              IsDeleted = FALSE,
              ModifiedBy = $4,
              ModifiedDate = CURRENT_TIMESTAMP
            WHERE OpexApprovalConfigID = $5
              AND OrganizationID = $6;
            `,
            [
              ApprovalRole,
              ApprovalOrder,
              IsMandatory,
              data.UserID,
              ConfigID,
              OrganizationID,
            ],
          );

          restored.push(ConfigID);
        }

        // --------------------------------------------------------
        // NORMAL UPDATE
        // --------------------------------------------------------
        else {
          await client.query(
            `
            UPDATE Opex_Approval_Config
            SET
              ApprovalRole = $1,
              ApprovalOrder = $2,
              IsMandatory = $3,
              ModifiedBy = $4,
              ModifiedDate = CURRENT_TIMESTAMP
            WHERE OpexApprovalConfigID = $5
              AND OrganizationID = $6
              AND IsDeleted = FALSE;
            `,
            [
              ApprovalRole,
              ApprovalOrder,
              IsMandatory,
              data.UserID,
              ConfigID,
              OrganizationID,
            ],
          );

          updated.push(ConfigID);
        }
      }

      // ==========================================================
      // NEW INSERT
      // ==========================================================
      else {
        const [ConfigID] = await reserveNumericIDs(
          client,
          "Opex_Approval_Config",
          "OpexApprovalConfigID",
        );

        const result = await client.query(
          `
          INSERT INTO Opex_Approval_Config
          (
            OpexApprovalConfigID,
            OrganizationID,
            ApprovalLevel,
            ApprovalRole,
            ApprovalOrder,
            IsMandatory,
            IsDeleted,
            CreatedBy,
            CreatedDate
          )
          VALUES
          (
            $1,
            $2,
            $3,
            $4,
            $5,
            $6,
            FALSE,
            $7,
            CURRENT_TIMESTAMP
          )
          RETURNING OpexApprovalConfigID AS "OpexApprovalConfigID";
          `,
          [
            ConfigID,
            OrganizationID,
            ApprovalLevel,
            ApprovalRole,
            ApprovalOrder,
            IsMandatory,
            data.UserID,
          ],
        );

        const savedConfigID = Number(result.rows[0].OpexApprovalConfigID);

        inserted.push(savedConfigID);
      }

      processedLevels.add(ApprovalLevel);
    }

    // ============================================================
    // SOFT DELETE
    // DB ME HAI BUT REQUEST ME NAHI HAI
    // ============================================================

    for (const existing of existingConfigs) {
      const level = Number(existing.ApprovalLevel);

      if (existing.IsDeleted === false && !processedLevels.has(level)) {
        const ConfigID = Number(existing.OpexApprovalConfigID);

        if (!Number.isInteger(ConfigID)) {
          throw new Error(
            `Invalid OpexApprovalConfigID: ${existing.OpexApprovalConfigID}`,
          );
        }

        await client.query(
          `
          UPDATE Opex_Approval_Config
          SET
            IsDeleted = TRUE,
            ModifiedBy = $1,
            ModifiedDate = CURRENT_TIMESTAMP
          WHERE OpexApprovalConfigID = $2
            AND OrganizationID = $3
            AND IsDeleted = FALSE;
          `,
          [data.UserID, ConfigID, OrganizationID],
        );

        deleted.push(ConfigID);
      }
    }

    // ============================================================
    // COMMIT
    // ============================================================

    await client.query("COMMIT");
    transactionStarted = false;

    return {
      success: true,
      message: "Opex approval configuration saved successfully.",
    };
  } catch (error) {
    if (client && transactionStarted) {
      await client.query("ROLLBACK");
    }

    console.error("Save Opex Approval Config Error:", error.message);

    if (error.statusCode) return fail(error.message,error.statusCode);
    const retryResponse = retryableDatabaseResponse(error);

    if (retryResponse) return retryResponse;

    if (error.code === "23505") {
      return fail("Opex approval configuration already exists.", 409);
    }

    if (error.code === "23503") {
      return fail("Invalid organization or user.", 400);
    }

    return fail(
      "Unable to save Opex approval configuration at this time.",
      500,
    );
  } finally {
    if (client) {
      client.release();
    }
  }
};
// ============================================================Delete Approval Config
const deleteApprovalConfig = async (data) => {
  let client;
  let transactionStarted = false;

  try {
    const ConfigID = Number(data.OpexApprovalConfigID);

    if (!ConfigID) {
      return fail("OpexApprovalConfigID is required.", 400);
    }

    client = await pool.connect();

    await client.query("BEGIN");
    transactionStarted = true;

    const result = await client.query(
      `
      UPDATE Opex_Approval_Config
      SET
        IsDeleted = TRUE,
        DeletedBy = $1,
        DeletedDate = CURRENT_TIMESTAMP,
        ModifiedBy = $1,
        ModifiedDate = CURRENT_TIMESTAMP
      WHERE OpexApprovalConfigID = $2
        AND IsDeleted = FALSE
      RETURNING
        OpexApprovalConfigID,
        OrganizationID;
      `,
      [data.UserID, ConfigID],
    );

    if (result.rows.length === 0) {
      await client.query("ROLLBACK");
      transactionStarted = false;

      return fail("Opex approval configuration not found.", 404);
    }

    await client.query("COMMIT");
    transactionStarted = false;

    return {
      success: true,
      message: "Opex approval configuration deleted successfully.",
    };
  } catch (error) {
    if (client && transactionStarted) {
      await client.query("ROLLBACK");
    }

    console.error("Delete Opex Approval Config Error:", error.message);

    if (error.statusCode) return fail(error.message,error.statusCode);
    const retryResponse = retryableDatabaseResponse(error);
    if (retryResponse) return retryResponse;

    return fail(
      "Unable to delete Opex approval configuration at this time.",
      500,
    );
  } finally {
    if (client) client.release();
  }
};
// ============================================================Opex List PDF
const generateLegacyOpexDetailPdf = async (Opex) => {
  const fonts = {
    Roboto: {
      normal: path.join(process.cwd(), "fonts/Roboto-Regular.ttf"),
      bold: path.join(process.cwd(), "fonts/Roboto-Medium.ttf"),
      italics: path.join(process.cwd(), "fonts/Roboto-SemiBold.ttf"),
      bolditalics: path.join(process.cwd(), "fonts/Roboto-Bold.ttf"),
    },
  };

  const printer = new PdfPrinter(fonts);

  // ============================================================
  // Opex DETAILS
  // ============================================================

  const OpexDetails = [
    [
      { text: "Opex Number", style: "label" },
      { text: String(Opex.OpexNumber ?? "-"), style: "value" },
      { text: "Opex ID", style: "label" },
      { text: String(Opex.OpexID ?? "-"), style: "value" },
    ],
    [
      { text: "Department", style: "label" },
      { text: Opex.Department || "-", style: "value" },
      { text: "Item", style: "label" },
      { text: Opex.Item || "-", style: "value" },
    ],
    [
      { text: "Description", style: "label" },
      {
        text: Opex.Description || "-",
        style: "value",
        colSpan: 3,
      },
      {},
      {},
    ],
    [
      { text: "Make", style: "label" },
      { text: Opex.Make || "-", style: "value" },
      { text: "Quantity", style: "label" },
      { text: String(Opex.Qty ?? "-"), style: "value" },
    ],
    [
      { text: "Rate", style: "label" },
      {
        text:
          Opex.Rate != null
            ? `₹ ${Number(Opex.Rate).toLocaleString("en-IN")}`
            : "-",
        style: "value",
      },
      { text: "Total", style: "label" },
      {
        text:
          Opex.Total != null
            ? `₹ ${Number(Opex.Total).toLocaleString("en-IN")}`
            : "-",
        style: "value",
      },
    ],
    [
      { text: "Status", style: "label" },
      { text: Opex.CurrentStatus || "-", style: "value" },
      { text: "Current Role", style: "label" },
      { text: Opex.CurrentApprovalRole || "-", style: "value" },
    ],
    [
      { text: "Created Date", style: "label" },
      {
        text: Opex.CreatedDate ? formatDate(Opex.CreatedDate) : "-",
        style: "value",
      },
      { text: "Created By", style: "label" },
      {
        text: Opex.CreatedBy != null ? String(Opex.CreatedBy) : "-",
        style: "value",
      },
    ],
    [
      { text: "Modified Date", style: "label" },
      {
        text: Opex.ModifiedDate ? formatDate(Opex.ModifiedDate) : "-",
        style: "value",
      },
      { text: "Modified By", style: "label" },
      {
        text: Opex.ModifiedBy != null ? String(Opex.ModifiedBy) : "-",
        style: "value",
      },
    ],
  ];

  // ============================================================
  // APPROVALS
  // ============================================================

  const approvalRows = [
    [
      { text: "Level", style: "tableHeader" },
      { text: "Role", style: "tableHeader" },
      { text: "Status", style: "tableHeader" },
      { text: "Date", style: "tableHeader" },
      { text: "Approved By", style: "tableHeader" },
      { text: "Remarks", style: "tableHeader" },
    ],
  ];

  if (Opex.Approvals?.length) {
    Opex.Approvals.forEach((approval) => {
      approvalRows.push([
        {
          text: String(approval.LevelNo ?? "-"),
          style: "tableCell",
        },
        {
          text: approval.ApprovalRole || "-",
          style: "tableCell",
        },
        {
          text: approval.Status || "-",
          style: "tableCell",
        },
        {
          text: approval.StatusDateTime
            ? formatDate(approval.StatusDateTime)
            : "-",
          style: "tableCell",
        },
        {
          text:
            approval.StatusApprovedBy != null
              ? String(approval.StatusApprovedBy)
              : "-",
          style: "tableCell",
        },
        {
          text: approval.Remarks || "-",
          style: "tableCell",
        },
      ]);
    });
  } else {
    approvalRows.push([
      {
        text: "No approval records found.",
        colSpan: 6,
        alignment: "center",
        style: "tableCell",
      },
      {},
      {},
      {},
      {},
      {},
    ]);
  }

  // ============================================================
  // DOCUMENTS
  // ============================================================

  const documentRows = [
    [
      { text: "Document ID", style: "tableHeader" },
      { text: "File Name", style: "tableHeader" },
      { text: "File Type", style: "tableHeader" },
      { text: "File Size", style: "tableHeader" },
    ],
  ];

  if (Opex.Documents?.length) {
    Opex.Documents.forEach((document) => {
      documentRows.push([
        {
          text: String(document.OpexDocumentID ?? "-"),
          style: "tableCell",
        },
        {
          text: document.FileName || "-",
          style: "tableCell",
        },
        {
          text: document.FileType || "-",
          style: "tableCell",
        },
        {
          text:
            document.FileSize != null
              ? `${Number(document.FileSize).toLocaleString("en-IN")} bytes`
              : "-",
          style: "tableCell",
        },
      ]);
    });
  } else {
    documentRows.push([
      {
        text: "No documents found.",
        colSpan: 4,
        alignment: "center",
        style: "tableCell",
      },
      {},
      {},
      {},
    ]);
  }

  // ============================================================
  // PDF
  // ============================================================

  const docDefinition = {
    pageSize: "A4",
    pageMargins: [30, 30, 30, 35],

    defaultStyle: {
      font: "Roboto",
      fontSize: 9,
    },

    content: [
      {
        table: {
          widths: ["*", "auto"],
          body: [
            [
              {
                text: "Opex DETAILS",
                style: "title",
                border: [false, false, false, false],
              },
              {
                text: Opex.CurrentStatus || "Pending",
                style: "status",
                border: [false, false, false, false],
              },
            ],
          ],
        },
        layout: "noBorders",
        marginBottom: 15,
      },

      {
        text: "Opex INFORMATION",
        style: "sectionTitle",
        marginBottom: 6,
      },

      {
        table: {
          widths: [85, "*", 85, "*"],
          body: OpexDetails,
        },
        layout: {
          fillColor: (rowIndex) => (rowIndex % 2 === 0 ? "#F5F7FA" : "#FFFFFF"),
          hLineWidth: () => 0.5,
          vLineWidth: () => 0.5,
          hLineColor: () => "#D0D7DE",
          vLineColor: () => "#D0D7DE",
          paddingLeft: () => 7,
          paddingRight: () => 7,
          paddingTop: () => 6,
          paddingBottom: () => 6,
        },
        marginBottom: 18,
      },

      {
        text: "APPROVAL DETAILS",
        style: "sectionTitle",
        marginBottom: 6,
      },

      {
        table: {
          headerRows: 1,
          widths: [35, 60, 65, 85, 65, "*"],
          body: approvalRows,
        },
        layout: {
          fillColor: (rowIndex) =>
            rowIndex === 0
              ? "#4472C4"
              : rowIndex % 2 === 0
                ? "#F2F5FA"
                : "#FFFFFF",

          hLineWidth: () => 0.5,
          vLineWidth: () => 0.5,
          hLineColor: () => "#C5D0E0",
          vLineColor: () => "#C5D0E0",
          paddingLeft: () => 5,
          paddingRight: () => 5,
          paddingTop: () => 5,
          paddingBottom: () => 5,
        },
        marginBottom: 18,
      },

      {
        text: "DOCUMENTS",
        style: "sectionTitle",
        marginBottom: 6,
      },

      {
        table: {
          headerRows: 1,
          widths: [65, "*", 100, 100],
          body: documentRows,
        },
        layout: {
          fillColor: (rowIndex) =>
            rowIndex === 0
              ? "#4472C4"
              : rowIndex % 2 === 0
                ? "#F2F5FA"
                : "#FFFFFF",

          hLineWidth: () => 0.5,
          vLineWidth: () => 0.5,
          hLineColor: () => "#C5D0E0",
          vLineColor: () => "#C5D0E0",
          paddingLeft: () => 5,
          paddingRight: () => 5,
          paddingTop: () => 5,
          paddingBottom: () => 5,
        },
      },
    ],

    footer: (currentPage, pageCount) => ({
      columns: [
        {
          text: "Opex Management",
          alignment: "left",
          fontSize: 8,
          color: "#666666",
        },
        {
          text: `Page ${currentPage} of ${pageCount}`,
          alignment: "right",
          fontSize: 8,
          color: "#666666",
        },
      ],
      margin: [30, 5, 30, 0],
    }),

    styles: {
      title: {
        fontSize: 18,
        bold: true,
        color: "#1F2937",
      },

      status: {
        fontSize: 10,
        bold: true,
        color: "#4472C4",
        alignment: "right",
      },

      sectionTitle: {
        fontSize: 11,
        bold: true,
        color: "#4472C4",
      },

      label: {
        fontSize: 8,
        bold: true,
        color: "#555555",
      },

      value: {
        fontSize: 9,
        color: "#222222",
      },

      tableHeader: {
        fontSize: 8,
        bold: true,
        color: "#FFFFFF",
      },

      tableCell: {
        fontSize: 8,
        color: "#222222",
      },
    },
  };

  // ============================================================
  // PDF -> Buffer
  // ============================================================

  return new Promise((resolve, reject) => {
    try {
      const pdfDoc = printer.createPdfKitDocument(docDefinition);

      const chunks = [];

      pdfDoc.on("data", (chunk) => {
        chunks.push(chunk);
      });

      pdfDoc.on("end", () => {
        resolve(Buffer.concat(chunks));
      });

      pdfDoc.on("error", reject);

      pdfDoc.end();
    } catch (error) {
      reject(error);
    }
  });
};
const generateOpexListPdf = async (data) => {
  try {
    const rows = [];
    let approvalColumns = [];
    const exportPageSize = 1000;
    let page = 1;
    let totalPages = 1;

    do {
      const response = await getAllOpex({
        ...data,
        page,
        PageSize: exportPageSize,
      });

      if (!response.success) return response;

      if(page===1) approvalColumns=response.ApprovalColumns || [];
      rows.push(...response.data);
      totalPages = response.TotalPages;
      page += 1;
    } while (page <= totalPages);

    const access = {effectiveRole:data.UserType || "User"}; // Presentation only; reads enforce persisted access.

    const organizationId = Number(data.OrganizationID);
    let organizationName = data.OrganizationName || null;

    if (
      !organizationName &&
      Number.isSafeInteger(organizationId) &&
      organizationId > 0
    ) {
      const organizationResult = await pool.query(
        `
        SELECT OrganizationName
        FROM Organization_Master
        WHERE OrganizationID = $1
          AND IsDeleted = FALSE
        LIMIT 1;
        `,
        [organizationId],
      );

      organizationName = organizationResult.rows[0]?.organizationname || null;
    }

    const formatFilterDate = (value) =>
      value !== null &&
        value !== undefined &&
        String(value).trim() !== ""
        ? formatDate(value)
        : "All";

    const pdfRows = rows.map((row, index) => ({
      ...row,
      ExportSerialNumber: index + 1,
    }));

    const approvalValue = (row, role) => {
      const approval = (row.Approvals || []).find(
        (item) =>
          item.ColumnKey === role,
      );

      if (!approval) return "-";

      const details = [approval.Status || "Pending"];
      details.push(
        `Qty - ${approval.ApprovedQuantity === null ||
          approval.ApprovedQuantity === undefined
          ? "-"
          : approval.ApprovedQuantity
        }`,
      );
      if (approval.Remarks) details.push(approval.Remarks);
      return details.join("\n");
    };

    // Build approval columns from the configured flow returned with the OPEX
    // records. Preserve workflow order and include each role only once.
    const approvalRoles=approvalColumns.map(column=>column.Key);
    const pdfBuffer = await generatePdf({
      title: "OPEX LIST REPORT",
      reportName: "OPEX List Report",
      organizationId: data.OrganizationID || null,
      orientation: "landscape",
      metadata: [
        {
          label: "Organization",
          value: organizationName || "All",
        },
        {
          label: "Department",
          value: data.Department || access.departmentScope || "All",
        },
        {
          label: "From Date",
          value: formatFilterDate(data.FromDate),
        },
        {
          label: "To Date",
          value: formatFilterDate(data.ToDate),
        },
        {
          label: "Status",
          value: data.Status || "All",
        },
        {
          label: "Approval Flow",
          value: data.ApprovalFlow
            ? String(data.ApprovalFlow).trim().toUpperCase()
            : "All",
        },
        { label: "Total Records", value: rows.length },
      ],
      columns: [
        {
          header: "#",
          value: (row) => row.ExportSerialNumber,
          width: 24,
          align: "left",
        },
        {
          key: "OrganizationShortName",
          header: "HTL",
          width: 38
        },
        {
          key: "Department",
          header: "DEPT",
          width: 50,
        },
        {
          header: "ITEM",
          value: (row) =>
            [row.Item, row.Description]
              .filter(
                (value) =>
                  value !== null &&
                  value !== undefined &&
                  String(value).trim() !== "",
              )
              .join("\n") || "-",
          width: "*",
        },
        {
          key: "Qty",
          header: "QTY",
          width: 32,
          align: "left",
        },
        {
          header: "RATE",
          value: (row) =>
            Number(row.Rate || 0).toLocaleString("en-IN", {
              minimumFractionDigits: 0,
              maximumFractionDigits: 2,
            }),
          width: 52,
          align: "left",
        },
        {
          header: "TOTAL",
          value: (row) =>
            Number(row.Total || 0).toLocaleString("en-IN", {
              minimumFractionDigits: 0,
              maximumFractionDigits: 2,
            }),
          width: 70,
          align: "left",
        },
        ...approvalRoles.map((role) => ({
          header: approvalColumns.find(column=>column.Key===role)?.Label || role,
          value: (row) => approvalValue(row, role),
          width: 75,
          align: "left",
        })),
      ],
      rows: pdfRows,
      pageMargins: [20, 25, 20, 35],
    });

    return {
      success: true,
      message: "OPEX list PDF generated successfully.",
      data: pdfBuffer,
      fileName: `OPEX_List_Report_${Date.now()}.pdf`,
      contentType: "application/pdf",
    };
  } catch (error) {
    console.error("Generate OPEX List PDF Error:", error.message);
    return fail("Unable to generate OPEX list PDF.", 503);
  }
};
// ============================================================ Department Report Pdf
const getOpexDepartmentReportPdf = async (data) => {
  try {
    const dateValidationError = validateOpexReportDates(data);
    if (dateValidationError) return dateValidationError;

    // Same query as OPEX Department Report GET API
    const result = {rows: await OpexWorkflowRead.report(data,"department")};

    const rows = result.rows;

    // ============================================================
    // Generate PDF
    // ============================================================

    const pdfBuffer = await generatePdf({
      title: "OPEX Department Report",
      reportName: "OPEX Department Report",

      organizationId:
        data?.Filters?.OrganizationID ||
        data?.OrganizationID ||
        null,

      orientation: "landscape",

      metadata: [
        {
          label: "Department",
          value: data?.Filters?.Department || data?.Department || "All",
        },
        {
          label: "From Date",
          value: data?.Filters?.FromDate
            ? formatDate(data.Filters.FromDate)
            : data?.FromDate
              ? formatDate(data.FromDate)
              : "All",
        },
        {
          label: "To Date",
          value: data?.Filters?.ToDate
            ? formatDate(data.Filters.ToDate)
            : data?.ToDate
              ? formatDate(data.ToDate)
              : "All",
        },
        {
          label: "Total Departments",
          value: rows.length,
        },
      ],

      columns: [
        {
          header: "Department",
          key: "department",
          width: 100,
          align: "center",
        },
        {
          header: "Total Count",
          key: "count",
          width: 100,
          align: "center",
        },


        {
          header: "Approved",
          key: "approvedcount",
          width: 100,
          align: "center",
        },
        {
          header: "Pending",
          key: "pendingcount",
          width: 100,
          align: "center",
        },
        {
          header: "Rejected",
          key: "rejectedcount",
          width: 100,
          align: "center",
        },

        {
          header: "Returned",
          key: "returnedcount",
          width: 100,
          align: "center",
        },
        {
          header: "Hold",
          key: "holdcount",
          width: 100,
          align: "center",
        },
      ],

      rows,
    });

    // ============================================================
    // Response
    // ============================================================

    return {
      success: true,
      message: "OPEX department report PDF generated successfully.",
      pdfBuffer,
      fileName: "OPEX_Department_Report.pdf",
    };
  } catch (error) {
    console.error("OPEX Department Report PDF Error:", error);

    return {
      success: false,
      message: "Unable to generate OPEX department report PDF.",
      statusCode: 500,
    };
  }
};
// ============================================================ Organization Report pdf
const getOpexOrganizationReportPdf = async (data) => {
  try {
    const dateValidationError = validateOpexReportDates(data);
    if (dateValidationError) return dateValidationError;

    // Same query as OPEX Organization Report GET API
    const result = {rows: await OpexWorkflowRead.report(data,"organization")};

    const rows = result.rows.map((row) => ({
      organizationid: Number(row.organizationid),
      shortname: row.shortname || "Unspecified",
      count: Number(row.count || 0),
      totalamount: Number(row.totalamount || 0),
      approvedcount: Number(row.approvedcount || 0),
      pendingcount: Number(row.pendingcount || 0),
      rejectedcount: Number(row.rejectedcount || 0),
      holdcount: Number(row.holdcount || 0),
      returnedcount: Number(row.returnedcount || 0),
    }));

    // ============================================================
    // Generate PDF
    // ============================================================

    const pdfBuffer = await generatePdf({
      title: "OPEX Organization Report",
      reportName: "OPEX Organization Report",

      organizationId: data.OrganizationID || null,

      orientation: "landscape",

      metadata: [
        {
          label: "From Date",
          value: data.FromDate ? formatDate(data.FromDate) : "All",
        },
        {
          label: "To Date",
          value: data.ToDate ? formatDate(data.ToDate) : "All",
        },

      ],

      columns: [

        {
          header: "Organization",
          key: "shortname",
          width: 100,
          align: "center",
        },
        {
          header: "Total Count",
          key: "count",
          width: 100,
          align: "center",
        },

        {
          header: "Approved",
          key: "approvedcount",
          width: 100,
          align: "center",
        },
        {
          header: "Pending",
          key: "pendingcount",
          width: 100,
          align: "center",
        },
        {
          header: "Rejected",
          key: "rejectedcount",
          width: 100,
          align: "center",
        },

        {
          header: "Returned",
          key: "returnedcount",
          width: 100,
          align: "center",
        },
        {
          header: "Hold",
          key: "holdcount",
          width: 100,
          align: "center",
        },
      ],

      rows,
    });

    return {
      success: true,
      message: "OPEX organization report PDF generated successfully.",
      pdfBuffer,
      fileName: "OPEX_Organization_Report.pdf",
    };
  } catch (error) {
    console.error("OPEX Organization Report PDF Error:", error);

    return {
      success: false,
      message: "Unable to generate OPEX organization report PDF.",
      statusCode: 500,
    };
  }
};
// ============================================================SINGLE OPEX DETAIL PDF
// ====================OPEX SINGLE DETAIL PDF HELPERS
const formatOpexAmount = (value) => {
  const amount = Number(value);

  if (!Number.isFinite(amount)) {
    return "0.00";
  }

  return amount.toLocaleString("en-IN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
};
const opexPdfValue = (value) => {
  if (
    value === undefined ||
    value === null ||
    String(value).trim() === ""
  ) {
    return "-";
  }

  return String(value);
};
const generateOpexByIdPdf = async (data) => {
  try {
    // ==========================================================
    // VALIDATE OPEX ID
    // ==========================================================

    const opexID = Number(data.OpexID);

    if (
      !Number.isInteger(opexID) ||
      opexID <= 0
    ) {
      return fail(
        "Valid OPEX ID is required.",
        400,
      );
    }

    // ==========================================================
    // FETCH OPEX
    // Same query as Get By ID API
    // ==========================================================

    const detail = await OpexWorkflowRead.detail({...data,OpexID:opexID});
    const opex = detail.data;

    const approvals =
      Array.isArray(
        opex.Approvals,
      )
        ? opex.Approvals
        : [];

    // ==========================================================
    // COLORS
    // ==========================================================

    const COLORS = {
      mainHeader: "#082B5C",

      label: "#082B5C",

      value: "#172033",

      icon: "#0D3B7A",

      labelBackground:
        "#F4F6F9",

      tableHeaderBackground:
        "#F4F6F9",

      border: "#CFD7E3",

      white: "#FFFFFF",

      approved: "#15803D",

      approvedBackground:
        "#DCFCE7",

      pending: "#D97706",

      pendingBackground:
        "#FEF3C7",

      rejected: "#B91C1C",

      rejectedBackground:
        "#FEE2E2",

      returned: "#7C3AED",

      returnedBackground:
        "#EDE9FE",

      hold: "#B45309",

      holdBackground:
        "#FEF3C7",

      muted: "#64748B",
    };

    // ==========================================================
    // COMMON LABEL WIDTH
    // ==========================================================

    const LABEL_WIDTH = 90;

    // ==========================================================
    // LOGO + GENERATED DATE
    // ==========================================================

    const logo =
      await loadLogo(
        opex.OrganizationID,
      );

    const generatedOn =
      formatDate(
        new Date(),
        "DD MMM YYYY hh:mm A",
      );

    // ==========================================================
    // SVG ICONS
    // ==========================================================

    const fieldIcon = (
      type,
    ) => {
      const stroke =
        COLORS.icon;

      const line = (
        x1,
        y1,
        x2,
        y2,
        lineWidth = 1.25,
      ) => ({
        type: "line",

        x1,
        y1,
        x2,
        y2,

        lineWidth,

        lineColor:
          stroke,
      });

      const rect = (
        x,
        y,
        w,
        h,
        r = 0,
      ) => ({
        type: "rect",

        x,
        y,
        w,
        h,
        r,

        lineWidth: 1.25,

        lineColor:
          stroke,
      });

      const ellipse = (
        x,
        y,
        r1,
        r2 = r1,
      ) => ({
        type: "ellipse",

        x,
        y,
        r1,
        r2,

        lineWidth: 1.25,

        lineColor:
          stroke,
      });

      const icons = {
        // -----------------------------------------------
        // Organization
        // -----------------------------------------------

        organization: [
          rect(
            5,
            3,
            10,
            15,
            1,
          ),

          line(
            2,
            18,
            18,
            18,
          ),

          line(
            8,
            7,
            8,
            8,
          ),

          line(
            12,
            7,
            12,
            8,
          ),

          line(
            8,
            11,
            8,
            12,
          ),

          line(
            12,
            11,
            12,
            12,
          ),

          line(
            10,
            15,
            10,
            18,
          ),
        ],

        // -----------------------------------------------
        // OPEX Number
        // -----------------------------------------------

        opex: [
          rect(
            4,
            2,
            11,
            16,
            1,
          ),

          line(
            7,
            6,
            12,
            6,
          ),

          line(
            7,
            9,
            12,
            9,
          ),

          line(
            7,
            12,
            12,
            12,
          ),

          line(
            7,
            15,
            11,
            15,
          ),
        ],

        // -----------------------------------------------
        // Calendar
        // -----------------------------------------------

        calendar: [
          rect(
            2,
            4,
            16,
            14,
            1,
          ),

          line(
            2,
            8,
            18,
            8,
          ),

          line(
            6,
            2,
            6,
            6,
          ),

          line(
            14,
            2,
            14,
            6,
          ),

          line(
            6,
            11,
            8,
            11,
          ),

          line(
            11,
            11,
            13,
            11,
          ),

          line(
            6,
            14,
            8,
            14,
          ),

          line(
            11,
            14,
            13,
            14,
          ),
        ],

        // -----------------------------------------------
        // Department
        // -----------------------------------------------

        department: [
          ellipse(
            10,
            5,
            2.5,
          ),

          ellipse(
            4,
            7,
            2,
          ),

          ellipse(
            16,
            7,
            2,
          ),

          line(
            6,
            18,
            6,
            13,
          ),

          line(
            14,
            18,
            14,
            13,
          ),

          line(
            6,
            13,
            14,
            13,
          ),

          line(
            2,
            18,
            18,
            18,
          ),
        ],

        // -----------------------------------------------
        // Item
        // -----------------------------------------------

        item: [
          {
            type:
              "polyline",

            points: [
              {
                x: 2,
                y: 8,
              },

              {
                x: 9,
                y: 1,
              },

              {
                x: 18,
                y: 10,
              },

              {
                x: 10,
                y: 18,
              },

              {
                x: 2,
                y: 10,
              },
            ],

            closePath: true,

            lineWidth:
              1.25,

            lineColor:
              stroke,
          },

          ellipse(
            8,
            6,
            1.2,
          ),
        ],

        // -----------------------------------------------
        // Make
        // -----------------------------------------------

        make: [
          ellipse(
            10,
            10,
            5,
          ),

          ellipse(
            10,
            10,
            2,
          ),

          line(
            10,
            1,
            10,
            5,
          ),

          line(
            10,
            15,
            10,
            19,
          ),

          line(
            1,
            10,
            5,
            10,
          ),

          line(
            15,
            10,
            19,
            10,
          ),

          line(
            4,
            4,
            7,
            7,
          ),

          line(
            13,
            13,
            16,
            16,
          ),

          line(
            16,
            4,
            13,
            7,
          ),

          line(
            4,
            16,
            7,
            13,
          ),
        ],

        // -----------------------------------------------
        // Quantity
        // -----------------------------------------------

        quantity: [
          {
            type:
              "polyline",

            points: [
              {
                x: 10,
                y: 1,
              },

              {
                x: 18,
                y: 5,
              },

              {
                x: 10,
                y: 9,
              },

              {
                x: 2,
                y: 5,
              },
            ],

            closePath: true,

            lineWidth:
              1.25,

            lineColor:
              stroke,
          },

          line(
            2,
            5,
            2,
            14,
          ),

          line(
            18,
            5,
            18,
            14,
          ),

          line(
            2,
            14,
            10,
            19,
          ),

          line(
            18,
            14,
            10,
            19,
          ),

          line(
            10,
            9,
            10,
            19,
          ),
        ],

        // -----------------------------------------------
        // Rate
        // -----------------------------------------------

        rate: [
          line(
            5,
            3,
            15,
            3,
          ),

          line(
            5,
            7,
            15,
            7,
          ),

          line(
            8,
            3,
            8,
            17,
          ),

          line(
            8,
            7,
            16,
            18,
          ),

          line(
            8,
            7,
            11,
            7,
          ),
        ],

        // -----------------------------------------------
        // Total
        // -----------------------------------------------

        total: [
          ellipse(
            10,
            5,
            7,
            3,
          ),

          ellipse(
            10,
            10,
            7,
            3,
          ),

          ellipse(
            10,
            15,
            7,
            3,
          ),

          line(
            3,
            5,
            3,
            15,
          ),

          line(
            17,
            5,
            17,
            15,
          ),
        ],

        // -----------------------------------------------
        // Description
        // -----------------------------------------------

        description: [
          rect(
            4,
            2,
            12,
            16,
            1,
          ),

          line(
            7,
            7,
            13,
            7,
          ),

          line(
            7,
            10,
            13,
            10,
          ),

          line(
            7,
            13,
            12,
            13,
          ),
        ],
      };

      const iconScale =
        0.8;

      return (
        icons[type] ||
        icons.opex
      ).map(
        (shape) => {
          const scaledShape =
          {
            ...shape,

            lineWidth:
              (
                shape.lineWidth ||
                1
              ) *
              iconScale,
          };

          for (
            const coordinate of [
              "x",
              "y",

              "x1",
              "y1",

              "x2",
              "y2",

              "w",
              "h",

              "r",

              "r1",
              "r2",
            ]
          ) {
            if (
              typeof scaledShape[
              coordinate
              ] ===
              "number"
            ) {
              scaledShape[
                coordinate
              ] *=
                iconScale;
            }
          }

          if (
            Array.isArray(
              scaledShape.points,
            )
          ) {
            scaledShape.points =
              scaledShape.points.map(
                (
                  point,
                ) => ({
                  x:
                    point.x *
                    iconScale,

                  y:
                    point.y *
                    iconScale,
                }),
              );
          }

          return scaledShape;
        },
      );
    };

    // ==========================================================
    // LABEL CELL
    // ==========================================================

    const labelCell = (
      text,
      icon,
    ) => ({
      columns: [
        {
          width: 22,

          canvas:
            fieldIcon(
              icon,
            ),

          margin: [
            0,
            0,
            0,
            0,
          ],
        },

        {
          width: "*",

          text,

          style:
            "fieldLabel",

          margin: [
            3,
            3,
            0,
            0,
          ],
        },
      ],

      fillColor:
        COLORS.labelBackground,

      margin: [
        8,
        6,
        6,
        6,
      ],
    });

    // ==========================================================
    // VALUE CELL
    // ==========================================================

    const valueCell = (
      value,
    ) => ({
      text:
        opexPdfValue(
          value,
        ),

      style:
        "fieldValue",

      margin: [
        8,
        6,
        6,
        6,
      ],
    });

    // ==========================================================
    // TABLE BORDER
    // ==========================================================

    const borderedLayout = {
      hLineColor: () =>
        COLORS.border,

      vLineColor: () =>
        COLORS.border,

      hLineWidth: () =>
        0.7,

      vLineWidth: () =>
        0.7,

      paddingLeft: () =>
        0,

      paddingRight: () =>
        0,

      paddingTop: () =>
        0,

      paddingBottom: () =>
        0,
    };

    // ==========================================================
    // STATUS CELL
    // ==========================================================

    const statusCell = (
      statusValue,
    ) => ({
      text:
        opexPdfValue(
          statusValue,
        ),

      style:
        "approvalValue",

      margin: [
        4,
        5,
        4,
        5,
      ],
    });

    // ==========================================================
    // APPROVAL ROWS
    //
    // Dynamic:
    // HOD
    // FC
    // GM
    // RD-FC
    // CEO
    //
    // Whatever attachRelatedData returns will be displayed.
    // ==========================================================

    const approvalRows = [];

    approvals.forEach(
      (approval) => {
        if (
          approval.ApprovalRole ===
          undefined ||
          approval.ApprovalRole ===
          null ||
          String(
            approval.ApprovalRole,
          ).trim() === ""
        ) {
          return;
        }

        const approvalRole =
          String(
            approval.ApprovalRole,
          ).trim();

        const approvedQuantity =
          approval.ApprovedQuantity !==
            null &&
            approval.ApprovedQuantity !==
            undefined &&
            String(
              approval.ApprovedQuantity,
            ).trim() !== ""
            ? formatOpexAmount(
              approval.ApprovedQuantity,
            )
            : "-";

        approvalRows.push([
          // -----------------------------------------
          // Approval Role
          // -----------------------------------------

          {
            text:
              approvalRole,

            style:
              "approvalRole",

            margin: [
              4,
              5,
              4,
              5,
            ],
          },

          // -----------------------------------------
          // Status
          // -----------------------------------------

          statusCell(
            approval.Status,
          ),

          // -----------------------------------------
          // Approved Qty
          // -----------------------------------------

          {
            text:
              approvedQuantity,

            style:
              "approvalValue",

            margin: [
              4,
              5,
              4,
              5,
            ],
          },

          // -----------------------------------------
          // Remarks
          // -----------------------------------------

          {
            text:
              opexPdfValue(
                approval.Remarks,
              ),

            style:
              "approvalValue",

            margin: [
              4,
              5,
              4,
              5,
            ],
          },
        ]);
      },
    );

    // ==========================================================
    // NO APPROVAL DATA
    // ==========================================================

    if (
      approvalRows.length ===
      0
    ) {
      approvalRows.push([
        {
          text:
            "No approval details available",

          colSpan: 4,

          alignment:
            "center",

          color:
            COLORS.muted,

          margin: [
            0,
            7,
            0,
            7,
          ],
        },

        {},

        {},

        {},
      ]);
    }

    // ==========================================================
    // DOCUMENT DEFINITION
    // ==========================================================

    const documentDefinition = {
      pageSize: "A4",

      pageOrientation:
        "portrait",

      pageMargins: [
        22,
        26,
        22,
        72,
      ],

      defaultStyle: {
        font: "Roboto",

        fontSize: 9,

        color:
          COLORS.value,
      },

      content: [
        // ======================================================
        // HEADER
        // ======================================================

        {
          table: {
            widths: [
              130,
              "*",
            ],

            body: [
              [
                logo
                  ? {
                    image:
                      logo,

                    fit: [
                      102,
                      58,
                    ],

                    border: [
                      false,
                      false,
                      false,
                      false,
                    ],
                  }
                  : {
                    text: "",

                    border: [
                      false,
                      false,
                      false,
                      false,
                    ],
                  },

                {
                  text:
                    "OPEX Detail Report",

                  style:
                    "title",

                  alignment:
                    "center",

                  margin: [
                    0,
                    18,
                    80,
                    0,
                  ],

                  border: [
                    false,
                    false,
                    false,
                    false,
                  ],
                },
              ],
            ],
          },

          layout:
            "noBorders",
        },

        // ======================================================
        // HEADER LINE
        // ======================================================

        {
          canvas: [
            {
              type:
                "line",

              x1: 0,

              y1: 0,

              x2: 551,

              y2: 0,

              lineWidth:
                0.8,

              lineColor:
                COLORS.mainHeader,
            },
          ],

          margin: [
            0,
            7,
            0,
            18,
          ],
        },

        // ======================================================
        // ORGANIZATION + OPEX NUMBER
        // CREATED DATE + DEPARTMENT
        // ======================================================

        {
          table: {
            widths: [
              LABEL_WIDTH,
              "*",

              LABEL_WIDTH,
              "*",
            ],

            body: [
              // -----------------------------------------------
              // Organization + OPEX No.
              // -----------------------------------------------

              [
                labelCell(
                  "Organization",
                  "organization",
                ),

                valueCell(
                  opex.OrganizationShortName ||
                  opex.OrganizationID,
                ),

                labelCell(
                  "OPEX No.",
                  "opex",
                ),

                valueCell(
                  opex.OpexNumber,
                ),
              ],

              // -----------------------------------------------
              // Date + Department
              // -----------------------------------------------

              [
                labelCell(
                  "Created On",
                  "calendar",
                ),

                valueCell(
                  opex.CreatedDate,
                ),

                labelCell(
                  "Department",
                  "department",
                ),

                valueCell(
                  opex.Department,
                ),
              ],
            ],
          },

          layout:
            borderedLayout,

          margin: [
            0,
            0,
            0,
            0,
          ],
        },

        // ======================================================
        // ITEM + MAKE
        // ======================================================

        {
          table: {
            widths: [
              LABEL_WIDTH,
              "*",

              LABEL_WIDTH,
              "*",
            ],

            body: [
              [
                labelCell(
                  "Item",
                  "item",
                ),

                valueCell(
                  opex.Item,
                ),

                labelCell(
                  "Make",
                  "make",
                ),

                valueCell(
                  opex.Make,
                ),
              ],
            ],
          },

          layout:
            borderedLayout,

          margin: [
            0,
            0,
            0,
            0,
          ],
        },

        // ======================================================
        // QUANTITY + RATE + TOTAL
        // ======================================================

        {
          table: {
            widths: [
              LABEL_WIDTH,
              "*",

              LABEL_WIDTH,
              "*",

              LABEL_WIDTH,
              "*",
            ],

            body: [
              [
                // -------------------------------------------
                // Quantity
                // -------------------------------------------

                labelCell(
                  "Quantity",
                  "quantity",
                ),

                valueCell(
                  formatOpexAmount(
                    opex.Qty,
                  ),
                ),

                // -------------------------------------------
                // Rate
                // -------------------------------------------

                labelCell(
                  "Rate",
                  "rate",
                ),

                valueCell(
                  `INR ${formatOpexAmount(
                    opex.Rate,
                  )}`,
                ),

                // -------------------------------------------
                // Total
                // -------------------------------------------

                labelCell(
                  "Total",
                  "total",
                ),

                {
                  text:
                    `INR ${formatOpexAmount(
                      opex.Total,
                    )}`,

                  style:
                    "totalValue",

                  margin: [
                    8,
                    6,
                    6,
                    6,
                  ],
                },
              ],
            ],
          },

          layout:
            borderedLayout,

          // Quantity row ke upar aur niche gap
          margin: [
            0,
            8,
            0,
            8,
          ],
        },

        // ======================================================
        // DESCRIPTION
        // ======================================================

        {
          table: {
            widths: [
              LABEL_WIDTH,
              "*",
            ],

            body: [
              [
                labelCell(
                  "Description",
                  "description",
                ),

                {
                  text:
                    opexPdfValue(
                      opex.Description,
                    ),

                  style:
                    "descriptionValue",

                  margin: [
                    8,
                    6,
                    6,
                    6,
                  ],
                },
              ],
            ],
          },

          layout:
            borderedLayout,

          margin: [
            0,
            0,
            0,
            0,
          ],
        },

        // ======================================================
        // APPROVAL TABLE
        // ======================================================

        {
          table: {
            headerRows: 1,

            widths: [
              100,
              120,
              80,
              "*",
            ],

            body: [
              // -----------------------------------------------
              // Header
              // -----------------------------------------------

              [
                {
                  text:
                    "Approval",

                  style:
                    "tableHeader",
                },

                {
                  text:
                    "Status",

                  style:
                    "tableHeader",
                },

                {
                  text:
                    "Qty",

                  style:
                    "tableHeader",
                },

                {
                  text:
                    "Remarks",

                  style:
                    "tableHeader",
                },
              ],

              // -----------------------------------------------
              // Dynamic OPEX Approvals
              // -----------------------------------------------

              ...approvalRows,
            ],
          },

          layout: {
            hLineColor:
              () =>
                COLORS.border,

            vLineColor:
              () =>
                COLORS.border,

            hLineWidth:
              () =>
                0.7,

            vLineWidth:
              () =>
                0.7,

            fillColor:
              (
                rowIndex,
              ) =>
                rowIndex ===
                  0
                  ? COLORS.tableHeaderBackground
                  : COLORS.white,

            paddingLeft:
              () => 8,

            paddingRight:
              () => 8,

            paddingTop:
              () => 6,

            paddingBottom:
              () => 6,
          },

          // Description ke baad approval table gap
          margin: [
            0,
            12,
            0,
            5,
          ],
        },
      ],

      // ========================================================
      // FOOTER
      // ========================================================

      footer: () => ({
        margin: [
          22,
          8,
          22,
          0,
        ],

        stack: [
          // ----------------------------------------------------
          // Footer Line
          // ----------------------------------------------------

          {
            canvas: [
              {
                type:
                  "line",

                x1: 0,

                y1: 0,

                x2: 551,

                y2: 0,

                lineWidth:
                  0.7,

                lineColor:
                  COLORS.mainHeader,
              },
            ],

            margin: [
              0,
              0,
              0,
              8,
            ],
          },

          // ----------------------------------------------------
          // Footer Text
          // ----------------------------------------------------

          {
            columns: [
              {
                stack: [
                  {
                    text:
                      "Powered by HotelOps",

                    bold: true,

                    color:
                      COLORS.mainHeader,

                    fontSize:
                      8,
                  },
                ],
              },

              {
                width: 130,

                stack: [
                  {
                    text:
                      `Generated On   :  ${generatedOn}`,

                    fontSize:
                      7,

                    color:
                      COLORS.label,
                  },
                ],
              },
            ],
          },
        ],
      }),

      // ========================================================
      // STYLES
      // ========================================================

      styles: {
        title: {
          fontSize:
            18,

          bold:
            true,

          color:
            COLORS.mainHeader,
        },

        fieldLabel: {
          fontSize:
            9,

          bold:
            true,

          color:
            COLORS.label,
        },

        fieldValue: {
          fontSize:
            9,

          color:
            COLORS.value,
        },

        descriptionValue: {
          fontSize:
            9,

          lineHeight:
            1.25,

          color:
            COLORS.value,
        },

        totalValue: {
          fontSize:
            9,

          bold:
            true,

          color:
            COLORS.value,
        },

        tableHeader: {
          fontSize:
            9,

          bold:
            true,

          color:
            COLORS.label,

          fillColor:
            COLORS.tableHeaderBackground,

          margin: [
            3,
            2,
            3,
            2,
          ],
        },

        approvalRole: {
          fontSize:
            9,

          bold:
            true,

          color:
            COLORS.value,
        },

        approvalValue: {
          fontSize:
            9,

          color:
            COLORS.value,
        },
      },
    };

    // ==========================================================
    // CREATE PDF
    // ==========================================================

    const pdfBuffer =
      await new Promise(
        (
          resolve,
          reject,
        ) => {
          try {
            const pdfDocument =
              new PdfPrinter(
                OPEX_DETAIL_PDF_FONTS,
              ).createPdfKitDocument(
                documentDefinition,
              );

            const chunks = [];

            pdfDocument.on(
              "data",
              (
                chunk,
              ) =>
                chunks.push(
                  chunk,
                ),
            );

            pdfDocument.on(
              "end",
              () =>
                resolve(
                  Buffer.concat(
                    chunks,
                  ),
                ),
            );

            pdfDocument.on(
              "error",
              reject,
            );

            pdfDocument.end();
          } catch (error) {
            reject(error);
          }
        },
      );

    // ==========================================================
    // SUCCESS
    // ==========================================================

    return {
      success: true,

      message:
        "OPEX PDF generated successfully.",

      FileName:
        `OPEX-${opex.OpexNumber}.pdf`,

      ContentType:
        "application/pdf",

      PdfBuffer:
        pdfBuffer,
    };
  } catch (error) {
    console.error(
      "Generate OPEX PDF Service Error:",
      error.message,
    );

    const retryResponse =
      retryableDatabaseResponse(
        error,
      );

    if (
      retryResponse
    ) {
      return retryResponse;
    }

    return fail(
      "Unable to generate OPEX PDF at this time.",
      500,
    );
  }
};
// ============================================================ Exports
module.exports = {
  createOpex,
  getAllOpex,
  getOpexById,
  updateOpex,
  deleteOpex,
  processOpexApproval,
  getOpexSummaryReport,
  getOpexDepartmentReport,
  getOpexOrganizationReport,
  getApprovalConfig,
  createApprovalConfig,
  deleteApprovalConfig,
  generateOpexListPdf,
  getOpexDepartmentReportPdf,
  getOpexOrganizationReportPdf,
  generateOpexByIdPdf
};
