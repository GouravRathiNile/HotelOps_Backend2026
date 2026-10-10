const { pool } = require("../../db");
const CapexWorkflow = require("./CapexWorkflow");
const CapexWorkflowRead = require("./CapexWorkflowRead");
const {retryableDatabaseResponse,} = require("../../utils/retryableDatabaseError");
const { formatDate } = require("../../utils/dateFormatter");
// ===============================================Pdf Helper
const { generatePdf, loadLogo } = require("../../utils/pdfHelper");
const PdfPrinter = require("pdfmake");
const path = require("path");
const CAPEX_NOTIFICATION_MODULE = "Capex";

const notificationUserIds = (values) => [...new Set((Array.isArray(values) ? values : [values])
  .filter((value) => value != null && /^[1-9]\d*$/.test(String(value).trim()))
  .map((value) => String(value).trim()))].sort();

// Resolve only active users mapped to the CAPEX record's organization. Roles
// come from the effective approval configuration; direct IDs are used for the creator.
const resolveCapexNotificationRecipients = async ({ organizationID, roles = [], directUserIds = [], excludeUserID = null, actorUserID = null }) => {
  const normalizedRoles = [...new Set(roles.map((role) => String(role || "").trim().toUpperCase()).filter(Boolean))];
  const normalizedUserIds = notificationUserIds(directUserIds);
  const result = await pool.query(`
    SELECT DISTINCT um.userid,
      COALESCE(NULLIF(TRIM(om.shortname), ''), om.organizationname) AS organization_short_name,
      COALESCE(NULLIF(TRIM(actor.fullname), ''), NULLIF(TRIM(actor.username), '')) AS actor_name
    FROM user_master um
    INNER JOIN user_org_mapping uom ON uom.userid = um.userid
    INNER JOIN organization_master om ON om.organizationid = uom.organizationid
    LEFT JOIN user_master actor ON actor.userid::text = $5::text
    WHERE uom.organizationid = $1
      AND uom.isactive = TRUE AND uom.isdeleted = FALSE
      AND om.isactive = TRUE AND om.activationstatus = TRUE AND om.isdeleted = FALSE
      AND um.isactive = TRUE AND um.isdeleted = FALSE AND um.islocked = FALSE
      AND (UPPER(TRIM(um.usertype)) = ANY($2::text[]) OR um.userid::text = ANY($3::text[]))
      AND ($4::text IS NULL OR um.userid::text <> $4::text)`,
    [organizationID, normalizedRoles, normalizedUserIds,
      excludeUserID == null ? null : String(excludeUserID),
      actorUserID == null ? null : String(actorUserID)]);
  return {
    userIds: notificationUserIds(result.rows.map((row) => row.userid)),
    organizationShortName: String(result.rows[0]?.organization_short_name || "").trim(),
    actorName: String(result.rows[0]?.actor_name || "").trim(),
  };
};

// Build only notification presentation text here; workflow and recipients stay
// independent so content changes cannot alter CAPEX approval behavior.
const capexNotificationContent = ({ kind, item, qty, department, description,
  organizationShortName, actorName, approverRole, title, message }) => {
  if (kind === "CREATE") {
    return {
      title: `CAPEX - ${String(item || "").trim()} (${String(qty ?? "").trim()}) - ${String(department || "").trim()} - ${organizationShortName}`,
      message: String(description || "").trim(),
    };
  }
  if (kind === "APPROVE") {
    return {
      title: `CAPEX - ${String(item || "").trim()} - ${String(department || "").trim()} - ${organizationShortName}`,
      message: `Approved by ${actorName || approverRole}`,
    };
  }
  if (["REJECT", "RETURN", "HOLD"].includes(kind)) {
    const actionLabel = { REJECT: "Rejected", RETURN: "Returned", HOLD: "Hold" }[kind];
    return {
      title: `CAPEX - ${String(item || "").trim()} - ${String(department || "").trim()} - ${organizationShortName}`,
      message: `${actionLabel} by ${actorName || approverRole}`,
    };
  }
  return { title, message };
};

// CAPEX owns its recipient and content rules; the shared notification service
// receives only the final generic command for persistence and Firebase delivery.
const notifyCapex = async ({ organizationID, capexID, roles, directUserIds,
  excludeUserID, actorUserID, kind, item, qty, department, description,
  rate, total, actionQuantity, remark, actionDate,
  approverRole, title, message, action }) => {
  const recipientContext = await resolveCapexNotificationRecipients({
    organizationID, roles, directUserIds, excludeUserID, actorUserID,
  });
  const { userIds } = recipientContext;
  if (!userIds.length) return;
  const content = capexNotificationContent({
    kind, item, qty, department, description, approverRole, title, message,
    organizationShortName: recipientContext.organizationShortName,
    actorName: recipientContext.actorName,
  });

  const { sendMessage } = require("../../producer/producer");
  const QUEUE = require("../../config/queue");
  const response = await sendMessage(QUEUE.NOTIFICATION.REQUEST, QUEUE.NOTIFICATION.RESPONSE, {
    action: "CREATE_NOTIFICATION",
    data: {
      organizationId: Number(organizationID), title: content.title, message: content.message, type: "info",
      moduleName: CAPEX_NOTIFICATION_MODULE, entityType: "Capex",
      entityId: String(capexID), action, priority: "normal", userIds,
      // Email-only presentation data travels with the existing notification
      // command; it is not persisted and does not alter notification content.
      emailData: {
        kind, item, department, quantity: qty, rate, total, description,
        actionQuantity, remark,
        actionBy: recipientContext.actorName || approverRole || "-",
        actionDate,
      },
    },
  });
  if (!response || response.success !== true) {
    console.error("CAPEX notification request unsuccessful:", response?.message || "No response");
  }
};

// Fire only after COMMIT. Notification failures must never fail or roll back CAPEX.
const notifyCommittedCapex = (event) => {
  Promise.resolve()
    .then(() => notifyCapex(event))
    .catch((error) => console.error("CAPEX notification failed:", error.message));
};
const CAPEX_DETAIL_PDF_FONTS = {
  Roboto: {
    normal: path.join(process.cwd(), "fonts/Roboto-Regular.ttf"),
    bold: path.join(process.cwd(), "fonts/Roboto-Medium.ttf"),
    italics: path.join(process.cwd(), "fonts/Roboto-SemiBold.ttf"),
    bolditalics: path.join(process.cwd(), "fonts/Roboto-Bold.ttf"),
  },
};
// ==============================================================Default roles
const DEFAULT_APPROVALS = Object.freeze([
  { LevelNo: 1, ApprovalRole: "GM" },
  { LevelNo: 2, ApprovalRole: "CEO" },
  { LevelNo: 3, ApprovalRole: "OWNER" },
]);
const APPROVAL_ROLES = new Set(["GM", "CEO", "OWNER"]);

// ============================================================ Shared Response Helpers(Create Helpers)
const fail = (message, statusCode = 400) => ({
  success: false,
  statusCode,
  message,
});
// CAPEX currently supports only these three business approval roles.
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
    console.error("CAPEX Rollback Error:", error.message);
  }
};
// Roll back database work and return the requested failure response.
const cleanupAndFail = async (client, transactionStarted, response) => {
  await rollback(client, transactionStarted);
  return response;
};
// Reserve numeric IDs safely because the existing CAPEX ID columns have no defaults.
const reserveNumericIDs = async (client, tableName, columnName, count = 1) => {
  if (count < 1) return [];

  const allowedColumns = {
    Capex_Master: "CapexID",
    Capex_Documents: "CapexDocumentID",
    Capex_Approval: "CapexApprovalID",
  };

  if (allowedColumns[tableName] !== columnName) {
    throw new Error("Invalid CAPEX ID reservation target");
  }

  const lockKey = `${tableName}.${columnName}`;
  await client.query("SELECT pg_advisory_xact_lock(hashtext($1));", [lockKey]);

  const result = await client.query(
    `SELECT COALESCE(MAX(${columnName}), 0) + 1 AS NextID FROM ${tableName};`,
  );
  const firstID = Number(result.rows[0].nextid);

  return Array.from({ length: count }, (_value, index) => firstID + index);
};
// ============================================================ Create CAPEX
const createCapex = async (data) => {
  let client;
  let transactionStarted = false;
  const documents = Array.isArray(data.Documents) ? data.Documents : [];

  try {
    client = await pool.connect();
    await client.query("BEGIN");
    transactionStarted = true;

    await CapexWorkflow.getActor(client, data.OrganizationID, data.CreatedBy);

    const sequenceResult = await client.query(
      `
      INSERT INTO Capex_Organization_Sequence
      (
        OrganizationID,
        LastCapexNumber
      )
      VALUES ($1, 1)
      ON CONFLICT (OrganizationID)
      DO UPDATE SET
        LastCapexNumber = Capex_Organization_Sequence.LastCapexNumber + 1
      RETURNING LastCapexNumber;
      `,
      [data.OrganizationID],
    );

    const capexNumber = Number(sequenceResult.rows[0].lastcapexnumber);
    const [capexID] = await reserveNumericIDs(
      client,
      "Capex_Master",
      "CapexID",
    );

    const masterResult = await client.query(
      `
      INSERT INTO Capex_Master
      (
        CapexID,
        OrganizationID,
        CapexNumber,
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
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
        FALSE, FALSE, $11, CURRENT_TIMESTAMP
      )
      RETURNING CapexID, Total;
      `,
      [
        capexID,
        data.OrganizationID,
        capexNumber,
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

    const total = Number(masterResult.rows[0].total);

    const documentIDs = await reserveNumericIDs(
      client,
      "Capex_Documents",
      "CapexDocumentID",
      documents.length,
    );
    for (const [index, document] of documents.entries()) {
      await client.query(
        `
        INSERT INTO Capex_Documents
        (
          CapexDocumentID,
          CapexID,
          CapexNumber,
          FileName,
          FilePath,
          FileType,
          FileSize,
          IsDeleted,
          CreatedBy,
          CreatedDate
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, FALSE, $8, CURRENT_TIMESTAMP);
        `,
        [
          documentIDs[index],
          capexID,
          capexNumber,
          document.FileName,
          document.FilePath,
          document.FileType,
          document.FileSize,
          data.CreatedBy,
        ],
      );
    }

    const workflowSteps = await CapexWorkflow.snapshot(client, capexID, data.OrganizationID);

    const [approvalID] = await reserveNumericIDs(
      client,
      "Capex_Approval",
      "CapexApprovalID",
    );
    await client.query(
      `
      INSERT INTO Capex_Approval
      (
        CapexApprovalID,
        CapexID,
        GMStatus,
        CEOStatus,
        OwnerStatus,
        FinalStatus,
        IsDeleted,
        CreatedBy,
        CreatedDate
      )
      VALUES ($1, $2, 'Pending', 'Pending', 'Pending', 'Pending', FALSE, $3, CURRENT_TIMESTAMP);
      `,
      [approvalID, capexID, data.CreatedBy],
    );

    await client.query("COMMIT");
    transactionStarted = false;

    const firstApprovalRole = workflowSteps[0]?.approvertype === "ROLE" ? workflowSteps[0].role : null;
    notifyCommittedCapex({
      organizationID: data.OrganizationID,
      capexID,
      roles: firstApprovalRole ? [firstApprovalRole] : [],
      directUserIds: workflowSteps[0]?.assigneduserid ? [workflowSteps[0].assigneduserid] : [],
      kind: "CREATE",
      item: data.Item,
      qty: data.Qty,
      department: data.Department,
      description: data.Description,
      rate: data.Rate,
      total,
      action: "CREATED",
    });

    return {
      success: true,
      message: "CAPEX created successfully.",
      // data: {
      //   CapexID: capexID,
      //   CapexNumber: capexNumber,
      //   Total: total,
      //   DocumentCount: documents.length,
      //   Approvals: approvals.map((approval) => ({
      //     ...approval,
      //     Status: "Pending",
      //   })),
      // },
    };
  } catch (error) {
    await rollback(client, transactionStarted);

    console.error("Create CAPEX Error:", error.message);

    if (error.statusCode) return fail(error.message, error.statusCode);
    const retryResponse = retryableDatabaseResponse(error);
    if (retryResponse) return retryResponse;

    if (error.code === "23503") {
      return fail("Invalid CAPEX organization or related data.", 400);
    }

    if (error.code === "23505") {
      return fail("A CAPEX record with the same details already exists.", 409);
    }

    return fail("Unable to create CAPEX at this time.", 500);
  } finally {
    if (client) client.release();
  }
};

// Shared workflow reads serve screens and exports.
const getAllCapex = async (data) => {
  try { return await CapexWorkflowRead.list(data); }
  catch (error) { return fail(error.message, error.statusCode || 503); }
};
// ============================================================ Get CAPEX By ID
const getCapexById = async (data) => {
  try { return await CapexWorkflowRead.detail(data); }
  catch (error) { return fail(error.message, error.statusCode || 503); }
};

// ============================================================ Mutation Helpers (Update ,Delete,Approval Helpers)
// Read the effective approval configuration for one organization.
const getMergedApprovals = async (client, organizationID) => {
  const result = await client.query(
    `
    SELECT 
      CapexApprovalConfigID,
      ApprovalLevel,
      ApprovalRole,
      ApprovalOrder,
      IsMandatory
    FROM Capex_Approval_Config
    WHERE OrganizationID = $1
      AND IsDeleted = FALSE
    ORDER BY 
      ApprovalOrder ASC,
      ApprovalLevel ASC,
      CapexApprovalConfigID ASC;
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
const capexExists = async (client, capexID) => {
  const result = await client.query(
    `SELECT 1 FROM Capex_Master WHERE CapexID = $1 AND IsDeleted = FALSE LIMIT 1;`,
    [capexID],
  );
  return result.rows.length > 0;
};
// ============================================================ Partial Update CAPEX
const updateCapex = async (data) => {
  let client;
  let transactionStarted = false;

  try {
    client = await pool.connect();

    await client.query("BEGIN");
    transactionStarted = true;
    const accessResult = await client.query(
      "SELECT organizationid, createdby FROM capex_master WHERE capexid = $1 AND isdeleted = FALSE FOR UPDATE",
      [data.CapexID]
    );
    if (!accessResult.rows.length) return await cleanupAndFail(client, transactionStarted, fail("CAPEX record not found", 404));
    const record = accessResult.rows[0];
    const actor = await CapexWorkflow.getActor(client, record.organizationid, data.UserID);
    if (!CapexWorkflow.canModify(record, actor)) {
      return await cleanupAndFail(client, transactionStarted, fail("You cannot modify this CAPEX", 403));
    }


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
    // CAPEX Fields
    // OrganizationID and CapexNumber are not updated
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
    // Update CAPEX
    // ============================================================

    values.push(data.CapexID);
    const capexIDParameter = values.length;

    const updateResult = await client.query(
      `
      UPDATE Capex_Master
      SET ${assignments.join(", ")}
      WHERE CapexID = $${capexIDParameter}
        AND IsDeleted = FALSE
      RETURNING
        CapexID,
        OrganizationID,
        CapexNumber,
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
    // CAPEX Not Found
    // ============================================================

    if (updateResult.rows.length === 0) {
      await client.query("ROLLBACK");
      transactionStarted = false;

      return fail("CAPEX record not found.", 404);
    }

    // ============================================================
    // DOCUMENT UPDATE RULES
    // Documents contains only newly uploaded files. Existing documents remain
    // active unless their IDs are explicitly supplied in DeleteDocumentIDs.
    // ============================================================

    if (data.Documents !== undefined && data.Documents !== null && !Array.isArray(data.Documents)) {
      await client.query("ROLLBACK");
      transactionStarted = false;

      return fail("Documents must be an array or null.", 400);
    }

    if (
      data.DeleteDocumentIDs !== undefined &&
      data.DeleteDocumentIDs !== null &&
      !Array.isArray(data.DeleteDocumentIDs)
    ) {
      await client.query("ROLLBACK");
      transactionStarted = false;

      return fail("DeleteDocumentIDs must be an array.", 400);
    }

    const incomingDocuments = Array.isArray(data.Documents)
      ? data.Documents
      : [];
    const deleteDocumentIDs = [
      ...new Set(
        (Array.isArray(data.DeleteDocumentIDs)
          ? data.DeleteDocumentIDs
          : []
        ).map(Number),
      ),
    ];

    if (
      deleteDocumentIDs.some(
        (documentID) => !Number.isSafeInteger(documentID) || documentID < 1,
      )
    ) {
      await client.query("ROLLBACK");
      transactionStarted = false;

      return fail(
        "DeleteDocumentIDs must contain only positive integers.",
        400,
      );
    }

    if (incomingDocuments.length > 0 || deleteDocumentIDs.length > 0) {
      for (const document of incomingDocuments) {
        if (!document || typeof document !== "object") {
          await client.query("ROLLBACK");
          transactionStarted = false;

          return fail("Invalid CAPEX document data.", 400);
        }

        if (
          document.CapexDocumentID !== undefined &&
          document.CapexDocumentID !== null
        ) {
          await client.query("ROLLBACK");
          transactionStarted = false;

          return fail(
            "Documents must contain only newly uploaded CAPEX documents.",
            400,
          );
        }
      }

      const capexInfo = updateResult.rows[0];
      const capexNumber = Number(capexInfo.capexnumber);

      const existingDocumentsResult = await client.query(
        `
        SELECT
          CapexDocumentID,
          FileName,
          FilePath,
          FileType,
          FileSize
        FROM Capex_Documents
        WHERE CapexID = $1
          AND IsDeleted = FALSE
        FOR UPDATE;
        `,
        [data.CapexID],
      );

      const existingDocuments = existingDocumentsResult.rows;
      const existingDocumentIDs = new Set(
        existingDocuments.map((document) => Number(document.capexdocumentid)),
      );
      const invalidDeleteDocumentID = deleteDocumentIDs.find(
        (documentID) => !existingDocumentIDs.has(documentID),
      );

      if (invalidDeleteDocumentID !== undefined) {
        await client.query("ROLLBACK");
        transactionStarted = false;

        return fail(
          "One or more CAPEX documents selected for deletion are invalid.",
          400,
        );
      }

      if (deleteDocumentIDs.length > 0) {
        await client.query(
          `
          UPDATE Capex_Documents
          SET
            IsDeleted = TRUE,
            DeletedBy = $1,
            DeletedDate = CURRENT_TIMESTAMP,
            ModifiedBy = $1,
            ModifiedDate = CURRENT_TIMESTAMP
          WHERE CapexID = $2
            AND CapexDocumentID = ANY($3::bigint[])
            AND IsDeleted = FALSE;
          `,
          [data.UserID, data.CapexID, deleteDocumentIDs],
        );
      }

      // ==========================================================
      // Create Set of FilePaths That Will Remain Active
      // Used to prevent duplicate documents
      // ==========================================================

      const activeFilePaths = new Set(
        existingDocuments
          .filter(
            (document) =>
              !deleteDocumentIDs.includes(Number(document.capexdocumentid)),
          )
          .map((document) => document.filepath)
          .filter(Boolean),
      );

      // ==========================================================
      // Validate and Remove Duplicate New Documents
      // ==========================================================

      const uniqueNewDocuments = [];

      for (const document of incomingDocuments) {
        if (
          document.FileName === undefined ||
          document.FileName === null ||
          String(document.FileName).trim() === ""
        ) {
          await client.query("ROLLBACK");
          transactionStarted = false;

          return fail("FileName is required for new CAPEX documents.", 400);
        }

        if (
          document.FilePath === undefined ||
          document.FilePath === null ||
          String(document.FilePath).trim() === ""
        ) {
          await client.query("ROLLBACK");
          transactionStarted = false;

          return fail("FilePath is required for new CAPEX documents.", 400);
        }

        const filePath = String(document.FilePath).trim();

        // Existing or incoming duplicate FilePath is not inserted again
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
          "Capex_Documents",
          "CapexDocumentID",
          uniqueNewDocuments.length,
        );

        for (let index = 0; index < uniqueNewDocuments.length; index += 1) {
          const document = uniqueNewDocuments[index];

          await client.query(
            `
            INSERT INTO Capex_Documents
            (
              CapexDocumentID,
              CapexID,
              CapexNumber,
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
              data.CapexID,
              capexNumber,
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
      message: "CAPEX updated successfully.",
    };
  } catch (error) {
    if (client && transactionStarted) {
      await client.query("ROLLBACK");
      transactionStarted = false;
    }

    console.error("Update CAPEX Error:", error.message);

    if (error.statusCode) return fail(error.message, error.statusCode);
    const retryResponse = retryableDatabaseResponse(error);

    if (retryResponse) {
      return retryResponse;
    }

    if (error.code === "23503") {
      return fail("Invalid CAPEX related data.", 400);
    }

    if (error.code === "23505") {
      return fail("CAPEX organization number or document already exists.", 409);
    }

    if (error.code === "22P02") {
      return fail("Invalid CAPEX or document ID.", 400);
    }

    return fail("Unable to update CAPEX at this time.", 500);
  } finally {
    if (client) {
      client.release();
    }
  }
};
// ============================================================ Soft Delete CAPEX
const deleteCapex = async (data) => {
  let client;
  let transactionStarted = false;

  try {
    client = await pool.connect();

    await client.query("BEGIN");
    transactionStarted = true;
    const accessResult = await client.query(
      "SELECT organizationid, createdby FROM capex_master WHERE capexid = $1 AND isdeleted = FALSE FOR UPDATE",
      [data.CapexID]
    );
    if (!accessResult.rows.length) return await cleanupAndFail(client, transactionStarted, fail("CAPEX record not found", 404));
    const record = accessResult.rows[0];
    const actor = await CapexWorkflow.getActor(client, record.organizationid, data.UserID);
    if (!CapexWorkflow.canModify(record, actor)) {
      return await cleanupAndFail(client, transactionStarted, fail("You cannot modify this CAPEX", 403));
    }


    // ============================================================
    // SOFT DELETE CAPEX
    // ============================================================

    const capexResult = await client.query(
      `
      UPDATE Capex_Master
      SET
        IsDeleted = TRUE,
        DeletedBy = $1,
        DeletedDate = CURRENT_TIMESTAMP,
        ModifiedBy = $1,
        ModifiedDate = CURRENT_TIMESTAMP
      WHERE CapexID = $2
        AND IsDeleted = FALSE
      RETURNING CapexID;
      `,
      [data.UserID, data.CapexID],
    );

    // ============================================================
    // CAPEX NOT FOUND / ALREADY DELETED
    // ============================================================

    if (capexResult.rows.length === 0) {
      await client.query("ROLLBACK");
      transactionStarted = false;

      return fail("Capex record not found or already deleted.", 404);
    }

    // ============================================================
    // SOFT DELETE DOCUMENTS
    // ============================================================

    await client.query(
      `
      UPDATE Capex_Documents
      SET
        IsDeleted = TRUE,
        DeletedBy = $1,
        DeletedDate = CURRENT_TIMESTAMP,
        ModifiedBy = $1,
        ModifiedDate = CURRENT_TIMESTAMP
      WHERE CapexID = $2
        AND IsDeleted = FALSE;
      `,
      [data.UserID, data.CapexID],
    );

    // ============================================================
    // SOFT DELETE APPROVALS
    // ============================================================

    await client.query(
      `
      UPDATE Capex_Approval
      SET
        IsDeleted = TRUE,
        DeletedBy = $1,
        DeletedDate = CURRENT_TIMESTAMP,
        ModifiedBy = $1,
        ModifiedDate = CURRENT_TIMESTAMP
      WHERE CapexID = $2
        AND IsDeleted = FALSE;
      `,
      [data.UserID, data.CapexID],
    );

    // ============================================================
    // COMMIT
    // ============================================================

    await client.query("COMMIT");
    transactionStarted = false;

    return {
      success: true,
      message: "Capex deleted successfully.",
    };
  } catch (error) {
    if (client && transactionStarted) {
      await client.query("ROLLBACK");
    }

    console.error("Delete CAPEX Error:", error.message);

    if (error.statusCode) return fail(error.message, error.statusCode);
    const retryResponse = retryableDatabaseResponse(error);

    if (retryResponse) {
      return retryResponse;
    }

    return fail("Unable to delete CAPEX at this time.", 500);
  } finally {
    if (client) {
      client.release();
    }
  }
};
// ============================================================ Approval Workflow
const processCapexApproval = async (data) => {
  let client;
  let transactionStarted = false;

  console.log("PROCESS CAPEX APPROVAL DATA:", JSON.stringify(data));

  try {
    // ============================================================
    // 1. NORMALIZE INPUT
    // ============================================================

    let approverRole = String(data.UserType || "")
      .trim()
      .toUpperCase();

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
      return fail("Invalid CAPEX approval action.", 400);
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
    // 6. GET CAPEX MASTER
    // ============================================================

    const masterResult = await client.query(
      `
      SELECT
        cm.CapexID,
        cm.CapexNumber,
        cm.OrganizationID,
        cm.CreatedBy,
        cm.Department,
        cm.Item,
        cm.Qty,
        cm.Rate,
        cm.Total,
        cm.Description,
        cm.IsVoid,
        cm.ModifiedDate,
        (SELECT ca.finalstatus FROM capex_approval ca
         WHERE ca.capexid = cm.capexid AND ca.isdeleted = FALSE LIMIT 1) AS FinalStatus
      FROM Capex_Master cm
      WHERE cm.CapexID = $1
        AND cm.IsDeleted = FALSE
      LIMIT 1
      FOR UPDATE OF cm;
      `,
      [data.CapexID],
    );

    // ============================================================
    // 7. CAPEX NOT FOUND
    // ============================================================

    if (masterResult.rows.length === 0) {
      const exists = await capexExists(client, data.CapexID);

      await rollback(client, transactionStarted);

      transactionStarted = false;

      return exists
        ? fail("CAPEX record is not available for approval.", 400)
        : fail("CAPEX record not found.", 404);
    }

    const capex = masterResult.rows[0];

    const verifiedActor = await CapexWorkflow.getActor(client, capex.organizationid, data.UserID);
    approverRole = CapexWorkflow.normalized(verifiedActor.usertype);
    const dynamicAction = await CapexWorkflow.applyAction(client, capex, data);
    if (dynamicAction) {
      await client.query("COMMIT");
      transactionStarted = false;
      const { change, step, next, roles, directUserIds } = dynamicAction;
      notifyCommittedCapex({
        organizationID: capex.organizationid, capexID: capex.capexid,
        roles, directUserIds,
        // A user assigned consecutive dynamic steps still needs the next task.
        excludeUserID: change.action === "APPROVE" ? null : data.UserID,
        actorUserID: data.UserID, kind: change.action,
        item: capex.item, qty: capex.qty, department: capex.department,
        description: capex.description, rate: capex.rate, total: capex.total,
        actionQuantity: change.quantity, remark: change.remarks,
        actionDate: new Date().toISOString(), approverRole: step.approvaltype,
        action: change.status.toUpperCase()
      });
      return { success: true, message: change.action === "APPROVE" && !next
        ? "CAPEX finally approved successfully." : "CAPEX " + change.status.toLowerCase() + " successfully." };
    }



    if (capex.isvoid === true) {
      await rollback(client, transactionStarted);
      transactionStarted = false;
      return fail("Void CAPEX cannot be processed for approval.", 400);
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
      capex.organizationid,
    );

    if (!configuredStages || configuredStages.length === 0) {
      await rollback(client, transactionStarted);

      transactionStarted = false;

      return fail("CAPEX approval configuration not found.", 400);
    }

    if (!approvalConfigurationIsValid(configuredStages)) {
      await rollback(client, transactionStarted);

      transactionStarted = false;

      return fail(
        "CAPEX approval configuration contains an invalid approval role.",
        400,
      );
    }

    // ============================================================
    // 9. GET CAPEX APPROVAL
    // ============================================================

    const approvalResult = await client.query(
      `
      SELECT
        CapexApprovalID,

       GMStatus,
       GMApprovedQuantity,
       GMStatusDateTime,
       GMStatusApprovedBy,
       GMRemarks,

       CEOStatus,
       CEOApprovedQuantity,
       CEOStatusDateTime,
       CEOStatusApprovedBy,
       CEORemarks,

       OwnerStatus,
       OwnerApprovedQuantity,
       OwnerStatusDateTime,
       OwnerStatusApprovedBy,
       OwnerRemarks,

        FinalStatus,
        FinalStatusDateTime

      FROM Capex_Approval

      WHERE CapexID = $1
        AND IsDeleted = FALSE

      LIMIT 1

      FOR UPDATE;
      `,
      [data.CapexID],
    );

    // ============================================================
    // 10. APPROVAL ROW NOT FOUND
    // ============================================================

    if (approvalResult.rows.length === 0) {
      await rollback(client, transactionStarted);

      transactionStarted = false;

      return fail("CAPEX approval record not found.", 404);
    }

    const approval = approvalResult.rows[0];

    // ============================================================
    // 11. ROLE DATA HELPER
    // ============================================================

    const getRoleData = (role) => {
      switch (String(role).trim().toUpperCase()) {
        case "GM":
          return {
            status: approval.gmstatus,
            approvedQuantity: approval.gmapprovedquantity,
            statusDateTime: approval.gmstatusdatetime,
            approvedBy: approval.gmstatusapprovedby,
            remarks: approval.gmremarks,
          };

        case "CEO":
          return {
            status: approval.ceostatus,
            approvedQuantity: approval.ceoapprovedquantity,
            statusDateTime: approval.ceostatusdatetime,
            approvedBy: approval.ceostatusapprovedby,
            remarks: approval.ceoremarks,
          };

        case "OWNER":
          return {
            status: approval.ownerstatus,
            approvedQuantity: approval.ownerapprovedquantity,
            statusDateTime: approval.ownerstatusdatetime,
            approvedBy: approval.ownerstatusapprovedby,
            remarks: approval.ownerremarks,
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
        stepid: "legacy:" + role,
        approvertype: "ROLE",
        role,
        approval: roleData,

        status: String(roleData?.status || "Pending")
          .trim()
          .toUpperCase(),
      };
    });

    // console.log("CAPEX APPROVAL STAGES:", JSON.stringify(stages));

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

      return fail("This CAPEX record is already finally approved.", 400);
    }

    const currentStage = stages[currentIndex];

    const currentRole = currentStage.role;

    const currentStatus = currentStage.status;

    // Build one post-commit notification from the already locked CAPEX and
    // effective workflow stages; no request-supplied organization is trusted.
    const notifyApprovalCommitted = ({ kind, title, message, notificationAction,
      roles = [], includeCreator = false, excludeActor = false }) => {
      notifyCommittedCapex({
        organizationID: capex.organizationid,
        capexID: capex.capexid,
        roles,
        directUserIds: includeCreator ? [capex.createdby] : [],
        excludeUserID: excludeActor ? data.UserID : null,
        actorUserID: data.UserID,
        kind,
        item: capex.item,
        qty: capex.qty,
        rate: capex.rate,
        total: capex.total,
        department: capex.department,
        description: capex.description,
        actionQuantity: approvedQuantity,
        remark: remarks,
        actionDate: new Date().toISOString(),
        approverRole,
        title,
        message,
        action: notificationAction,
      });
    };

    // Legacy storage keeps its fixed columns, but authorization uses the same
    // assignment/state policy as snapshot workflows and list/detail flags.
    const authorizedStep = CapexWorkflow.authorizeApproval(
      { ...capex, finalstatus: approval.finalstatus }, stages, verifiedActor,
      action, data.ApprovalStepID
    );
    const userStageIndex = stages.indexOf(authorizedStep);

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
        approvedQuantity !== undefined && approvedQuantity !== null
          ? Number(approvedQuantity)
          : null,
        approval.capexapprovalid,
      ];

      switch (role) {
        case "GM":
          query = `
        UPDATE Capex_Approval
        SET
          GMStatus = $1,
          GMStatusDateTime = CURRENT_TIMESTAMP,
          GMStatusApprovedBy = $2,
          GMRemarks = $3,
          GMApprovedQuantity = $4,
          ModifiedBy = $2,
          ModifiedDate = CURRENT_TIMESTAMP
        WHERE CapexApprovalID = $5
          AND IsDeleted = FALSE;
      `;
          break;

        case "CEO":
          query = `
        UPDATE Capex_Approval
        SET
          CEOStatus = $1,
          CEOStatusDateTime = CURRENT_TIMESTAMP,
          CEOStatusApprovedBy = $2,
          CEORemarks = $3,
          CEOApprovedQuantity = $4,
          ModifiedBy = $2,
          ModifiedDate = CURRENT_TIMESTAMP
        WHERE CapexApprovalID = $5
          AND IsDeleted = FALSE;
      `;
          break;

        case "OWNER":
          query = `
        UPDATE Capex_Approval
        SET
          OwnerStatus = $1,
          OwnerStatusDateTime = CURRENT_TIMESTAMP,
          OwnerStatusApprovedBy = $2,
          OwnerRemarks = $3,
          OwnerApprovedQuantity = $4,
          ModifiedBy = $2,
          ModifiedDate = CURRENT_TIMESTAMP
        WHERE CapexApprovalID = $5
          AND IsDeleted = FALSE;
      `;
          break;

        default:
          throw new Error(`Unsupported approval role: ${role}`);
      }

      await client.query(query, params);
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
          `Only the current ${currentRole} approval stage can approve this CAPEX.`,
          403,
        );
      }

      // ----------------------------------------------------------
      // Update current role
      // ----------------------------------------------------------

      await updateRoleApproval(
        approverRole,
        "Approved",
        data.UserID,
        remarks,
        approvedQuantity,
      );

      // ----------------------------------------------------------
      // Find next stage
      // ----------------------------------------------------------

      const followingStage = stages[currentIndex + 1];

      // ----------------------------------------------------------
      // NEXT APPROVAL EXISTS
      // ----------------------------------------------------------

      if (followingStage) {
        await client.query(
          `
          UPDATE Capex_Approval
          SET
            FinalStatus = NULL,
            FinalStatusDateTime = NULL,
            ModifiedBy = $1,
            ModifiedDate = CURRENT_TIMESTAMP
          WHERE CapexApprovalID = $2
            AND IsDeleted = FALSE;
          `,
          [data.UserID, approval.capexapprovalid],
        );

        await client.query("COMMIT");

        transactionStarted = false;

        notifyApprovalCommitted({
          kind: "APPROVE",
          notificationAction: "APPROVED",
          roles: [followingStage.role],
          // includeCreator: true,
          excludeActor: true,
        });

        return {
          success: true,

          message: "CAPEX approved successfully.",

          // data: {
          //   CapexID: Number(capex.capexid),

          //   CapexNumber: Number(capex.capexnumber),

          //   CurrentStatus: "Pending",

          //   CurrentApprovalRole: followingStage.role,

          //   Action: "APPROVE",
          // },
        };
      }

      // ----------------------------------------------------------
      // FINAL APPROVAL
      // ----------------------------------------------------------

      await client.query(
        `
        UPDATE Capex_Approval
        SET
          FinalStatus = 'Approved',
          FinalStatusDateTime = CURRENT_TIMESTAMP,
          ModifiedBy = $1,
          ModifiedDate = CURRENT_TIMESTAMP
        WHERE CapexApprovalID = $2
          AND IsDeleted = FALSE;
        `,
        [data.UserID, approval.capexapprovalid],
      );

      await client.query("COMMIT");

      transactionStarted = false;

      notifyApprovalCommitted({
        kind: "APPROVE",
        notificationAction: "APPROVED",
        includeCreator: true,
      });

      return {
        success: true,

        message: "CAPEX finally approved successfully.",

        // data: {
        //   CapexID: Number(capex.capexid),

        //   CapexNumber: Number(capex.capexnumber),

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
      await updateRoleApproval(
        approverRole,
        "Rejected",
        data.UserID,
        remarks,
        approvedQuantity,
      );

      await client.query(
        `
        UPDATE Capex_Approval
        SET
          FinalStatus = 'Rejected',
          FinalStatusDateTime = CURRENT_TIMESTAMP,
          ModifiedBy = $1,
          ModifiedDate = CURRENT_TIMESTAMP
        WHERE CapexApprovalID = $2
          AND IsDeleted = FALSE;
        `,
        [data.UserID, approval.capexapprovalid],
      );

      await client.query("COMMIT");

      transactionStarted = false;

      notifyApprovalCommitted({
        kind: "REJECT",
        notificationAction: "REJECTED",
        roles: [approverRole],
        includeCreator: true,
        excludeActor: true,
      });

      return {
        success: true,

        message: "CAPEX rejected successfully.",

        // data: {
        //   CapexID: Number(capex.capexid),

        //   CapexNumber: Number(capex.capexnumber),

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

      await updateRoleApproval(
        approverRole,
        "Returned",
        data.UserID,
        remarks,
        approvedQuantity,
      );

      await client.query(
        `
        UPDATE Capex_Approval
        SET
          FinalStatus = 'Returned',
          FinalStatusDateTime = CURRENT_TIMESTAMP,
          ModifiedBy = $1,
          ModifiedDate = CURRENT_TIMESTAMP
        WHERE CapexApprovalID = $2
          AND IsDeleted = FALSE;
        `,
        [data.UserID, approval.capexapprovalid],
      );

      await client.query("COMMIT");

      transactionStarted = false;

      notifyApprovalCommitted({
        kind: "RETURN",
        notificationAction: "RETURNED",
        roles: [approverRole],
        includeCreator: true,
        excludeActor: true,
      });

      return {
        success: true,

        message: "CAPEX returned successfully.",

        // data: {
        //   CapexID: Number(capex.capexid),

        //   CapexNumber: Number(capex.capexnumber),

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
          `Only the current ${currentRole} approval stage can hold this CAPEX.`,
          403,
        );
      }

      await updateRoleApproval(
        approverRole,
        "Hold",
        data.UserID,
        remarks,
        approvedQuantity,
      );

      await client.query(
        `
        UPDATE Capex_Approval
        SET
          FinalStatus = 'Hold',
          FinalStatusDateTime = CURRENT_TIMESTAMP,
          ModifiedBy = $1,
          ModifiedDate = CURRENT_TIMESTAMP
        WHERE CapexApprovalID = $2
          AND IsDeleted = FALSE;
        `,
        [data.UserID, approval.capexapprovalid],
      );

      await client.query("COMMIT");
      transactionStarted = false;

      notifyApprovalCommitted({
        kind: "HOLD",
        notificationAction: "HOLD",
        roles: [currentRole],
        includeCreator: true,
        excludeActor: true,
      });

      return {
        success: true,
        message: "CAPEX put on hold successfully.",
      };
    }

    // ============================================================
    // 23. FALLBACK
    // ============================================================

    await rollback(client, transactionStarted);

    transactionStarted = false;

    return fail("Unable to process CAPEX approval.", 400);
  } catch (error) {
    await rollback(client, transactionStarted);

    console.error("CAPEX Approval Error:", error.message);

    if (error.statusCode) return fail(error.message, error.statusCode);
    const retryResponse = retryableDatabaseResponse(error);

    if (retryResponse) {
      return retryResponse;
    }

    return fail("Unable to process CAPEX approval at this time.", 500);
  } finally {
    if (client) {
      client.release();
    }
  }
};

const capexSummaryData = (row) => ({
  TotalCapex: Number(row.totalcapex),
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
const getCapexSummaryReport = async (data) => {
  try {
    const [row] = await CapexWorkflowRead.report(data);
    return { success: true, message: "CAPEX summary report fetched successfully.",
      data: capexSummaryData({ ...row, totalcapex: row.count }) };
  } catch (error) { return fail(error.message, error.statusCode || 503); }
};
// ===========================================================================(Department and Organization Reports Helpers)
// Normalize grouped PostgreSQL results into the public API response shape.
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
const getCapexDepartmentReport = async (data) => {
  try {
    const rows = await CapexWorkflowRead.report(data, "department");
    return { success: true, message: "CAPEX department report fetched successfully.",
      data: groupedReportRows(rows, "Department") };
  } catch (error) { return fail(error.message, error.statusCode || 503); }
};
// ============================================================ Organization Report
const getCapexOrganizationReport = async (data) => {
  try {
    const rows = await CapexWorkflowRead.report(data, "organization");
    return { success: true, message: "CAPEX organization report fetched successfully.",
      data: groupedReportRows(rows, "OrganizationID").map((row, i) => ({ ...row, ShortName: rows[i].shortname })) };
  } catch (error) { return fail(error.message, error.statusCode || 503); }
};

// ============================================================ Get Approval Config
const getApprovalConfig = async (data) => {
  try {
    const { OrganizationID } = data;

    let query = `
      SELECT
        CapexApprovalConfigID,
        OrganizationID,
        ApprovalLevel,
        ApprovalRole,
        ApprovalOrder,
        IsMandatory,
        CreatedBy,
        CreatedDate,
        ModifiedBy,
        ModifiedDate
      FROM Capex_Approval_Config
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
        CapexApprovalConfigID ASC;
    `;

    const result = await pool.query(query, params);

    return {
      success: true,
      message: "CAPEX approval configuration fetched successfully.",
      data: result.rows.map((row) => ({
        CapexApprovalConfigID: Number(row.capexapprovalconfigid),
        OrganizationID: Number(row.organizationid),
        ApprovalLevel: Number(row.approvallevel),
        ApprovalRole: row.approvalrole,
        ApprovalOrder: Number(row.approvalorder),
        IsMandatory: row.ismandatory,

        CreatedDate: formatDate(row.createddate),
      })),
    };
  } catch (error) {
    console.error("Get CAPEX Approval Config Error:", error.message);

    if (error.statusCode) return fail(error.message, error.statusCode);
    const retryResponse = retryableDatabaseResponse(error);
    if (retryResponse) return retryResponse;

    return fail(
      "Unable to fetch CAPEX approval configuration at this time.",
      500,
    );
  }
};
// ============================================================Create Approval Config
const createApprovalConfig = async (data) => {
  let client;
  let transactionStarted = false;

  try {
    console.log("SAVE CAPEX DATA =>", JSON.stringify(data, null, 2));

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
        return fail("ApprovalRole must be GM, CEO, or OWNER.", 400);
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
        CapexApprovalConfigID AS "CapexApprovalConfigID",
        OrganizationID AS "OrganizationID",
        ApprovalLevel AS "ApprovalLevel",
        ApprovalRole AS "ApprovalRole",
        ApprovalOrder AS "ApprovalOrder",
        IsMandatory AS "IsMandatory",
        IsDeleted AS "IsDeleted"
      FROM Capex_Approval_Config
      WHERE OrganizationID = $1
      ORDER BY ApprovalLevel ASC, CapexApprovalConfigID ASC
      FOR UPDATE;
      `,
      [OrganizationID],
    );

    const existingConfigs = existingResult.rows;

    console.log(
      "EXISTING CAPEX CONFIGS =>",
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
        const ConfigID = Number(existing.CapexApprovalConfigID);

        if (!Number.isInteger(ConfigID)) {
          throw new Error(
            `Invalid CapexApprovalConfigID: ${existing.CapexApprovalConfigID}`,
          );
        }

        // --------------------------------------------------------
        // RESTORE SOFT DELETED RECORD
        // --------------------------------------------------------

        if (existing.IsDeleted === true) {
          await client.query(
            `
            UPDATE Capex_Approval_Config
            SET
              ApprovalRole = $1,
              ApprovalOrder = $2,
              IsMandatory = $3,
              IsDeleted = FALSE,
              ModifiedBy = $4,
              ModifiedDate = CURRENT_TIMESTAMP
            WHERE CapexApprovalConfigID = $5
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
            UPDATE Capex_Approval_Config
            SET
              ApprovalRole = $1,
              ApprovalOrder = $2,
              IsMandatory = $3,
              ModifiedBy = $4,
              ModifiedDate = CURRENT_TIMESTAMP
            WHERE CapexApprovalConfigID = $5
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
        const result = await client.query(
          `
          INSERT INTO Capex_Approval_Config
          (
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
            FALSE,
            $6,
            CURRENT_TIMESTAMP
          )
          RETURNING CapexApprovalConfigID;
          `,
          [
            OrganizationID,
            ApprovalLevel,
            ApprovalRole,
            ApprovalOrder,
            IsMandatory,
            data.UserID,
          ],
        );

        const ConfigID = Number(result.rows[0].CapexApprovalConfigID);

        inserted.push(ConfigID);
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
        const ConfigID = Number(existing.CapexApprovalConfigID);

        if (!Number.isInteger(ConfigID)) {
          throw new Error(
            `Invalid CapexApprovalConfigID: ${existing.CapexApprovalConfigID}`,
          );
        }

        await client.query(
          `
          UPDATE Capex_Approval_Config
          SET
            IsDeleted = TRUE,
            ModifiedBy = $1,
            ModifiedDate = CURRENT_TIMESTAMP
          WHERE CapexApprovalConfigID = $2
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
      message: "CAPEX approval configuration saved successfully.",
    };
  } catch (error) {
    if (client && transactionStarted) {
      await client.query("ROLLBACK");
    }

    console.error("Save CAPEX Approval Config Error:", error.message);

    if (error.statusCode) return fail(error.message, error.statusCode);
    const retryResponse = retryableDatabaseResponse(error);

    if (retryResponse) return retryResponse;

    if (error.code === "23505") {
      return fail("CAPEX approval configuration already exists.", 409);
    }

    if (error.code === "23503") {
      return fail("Invalid organization or user.", 400);
    }

    return fail(
      "Unable to save CAPEX approval configuration at this time.",
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
    const ConfigID = Number(data.CapexApprovalConfigID);

    if (!ConfigID) {
      return fail("CapexApprovalConfigID is required.", 400);
    }

    client = await pool.connect();

    await client.query("BEGIN");
    transactionStarted = true;

    const result = await client.query(
      `
      UPDATE Capex_Approval_Config
      SET
        IsDeleted = TRUE,
        DeletedBy = $1,
        DeletedDate = CURRENT_TIMESTAMP,
        ModifiedBy = $1,
        ModifiedDate = CURRENT_TIMESTAMP
      WHERE CapexApprovalConfigID = $2
        AND IsDeleted = FALSE
      RETURNING
        CapexApprovalConfigID,
        OrganizationID;
      `,
      [data.UserID, ConfigID],
    );

    if (result.rows.length === 0) {
      await client.query("ROLLBACK");
      transactionStarted = false;

      return fail("CAPEX approval configuration not found.", 404);
    }

    await client.query("COMMIT");
    transactionStarted = false;

    return {
      success: true,
      message: "CAPEX approval configuration deleted successfully.",
    };
  } catch (error) {
    if (client && transactionStarted) {
      await client.query("ROLLBACK");
    }

    console.error("Delete CAPEX Approval Config Error:", error.message);

    if (error.statusCode) return fail(error.message, error.statusCode);
    const retryResponse = retryableDatabaseResponse(error);
    if (retryResponse) return retryResponse;

    return fail(
      "Unable to delete CAPEX approval configuration at this time.",
      500,
    );
  } finally {
    if (client) client.release();
  }
};
// ===================================================================Pdf Apis
// ============================================================Generate CAPEX List PDF
const generateCapexListPdfDocument = async (data) => {
  try {
    const approvalStatus = data.Status || null;
    const approvalFlow = data.ApprovalFlow || null;
    if (!Array.isArray(data.PreparedRows)) throw new Error("Prepared CAPEX rows are required");
    const capexRows = data.PreparedRows;

    const organizationId =
      data.OrganizationID || capexRows[0]?.OrganizationID || null;

    // ============================================================
    // PDF COLUMNS
    // ============================================================

    const approvalRoles = [];

    for (const row of capexRows) {
      for (const approval of row.Approvals || []) {
        const role = approval.ColumnKey || String(approval.ApprovalRole || "").trim().toUpperCase();
        if (role && !approvalRoles.includes(role)) approvalRoles.push(role);
      }
    }

    const pdfRows = capexRows.map((row, index) => ({
      ...row,
      ExportSerialNumber: index + 1,
    }));

    const approvalValue = (row, role) => {
      const approval = (row.Approvals || []).find(
        (item) =>
          (item.ColumnKey || String(item.ApprovalRole || "").trim().toUpperCase()) === role,
      );

      if (!approval) return "-";

      const details = [approval.Status || "Pending"];
      details.push(
        `Qty - ${
          approval.ApprovedQuantity === null ||
          approval.ApprovedQuantity === undefined
            ? "-"
            : approval.ApprovedQuantity
        }`,
      );
      if (approval.Remarks) details.push(approval.Remarks);
      return details.join("\n");
    };

    const columns = [
      {
        header: "#",
        value: (row) => row.ExportSerialNumber,
        width: 24,
        align: "center",
      },
      {
        header: "HTL",
        value: (row) => row.OrganizationShortName,
        width: 38,
      },
      {
        header: "DEPT",
        value: (row) => row.Department,
        width: 55,
      },
      {
        header: "ITEM DETAILS",
        value: (row) =>
          [row.Item, row.Description].filter(Boolean).join("\n"),
        width: "*",
      },
      {
        header: "QTY",
        value: (row) => row.Qty,
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
        width: 62,
        align: "left",
      },
      {
        header: "TOTAL",
        value: (row) =>
          Number(row.Total || 0).toLocaleString("en-IN", {
            minimumFractionDigits: 0,
            maximumFractionDigits: 2,
          }),
        width: 72,
        align: "left",
      },
      ...approvalRoles.map((role) => ({
        header: capexRows.flatMap(row => row.Approvals || []).find(item => item.ColumnKey === role)?.ApprovalType || role,
        value: (row) => approvalValue(row, role),
        width: 72,
        align: "left",
      })),
    ];
// ============================================================
// METADATA
// ============================================================

let organizationName =
  capexRows[0]?.OrganizationName || data.OrganizationName || null;

if (!organizationName && organizationId) {
  const organizationResult = await pool.query(
    `SELECT OrganizationName
     FROM Organization_Master
     WHERE OrganizationID = $1
       AND IsDeleted = FALSE
     LIMIT 1`,
    [organizationId],
  );

  organizationName =
    organizationResult.rows[0]?.organizationname || null;
}

organizationName ||= "All Organizations";
    // ============================================================
    // METADATA
    // ============================================================

    let organizationShortName =
      capexRows[0]?.OrganizationShortName || data.OrganizationShortName || null;

    if (!organizationShortName && organizationId) {
      const organizationResult = await pool.query(
        `SELECT ShortName
         FROM Organization_Master
         WHERE OrganizationID = $1
           AND IsDeleted = FALSE
         LIMIT 1`,
        [organizationId],
      );
      organizationShortName = organizationResult.rows[0]?.shortname || null;
    }

    organizationShortName ||= "All Organizations";

    const metadata = [
      { label: "Organization", value: organizationName  },
      { label: "Department", value: data.Department || "All" },
      {
        label: "From Date",
        value: data.FromDate ? formatDate(data.FromDate) : "All",
      },
      {
        label: "To Date",
        value: data.ToDate ? formatDate(data.ToDate) : "All",
      },
      { label: "Status", value: approvalStatus || "All" },
      { label: "Approval Flow", value: approvalFlow || "All" },
      {
        label: "Total Records",
        value: capexRows.length,
      },
    ];

    // ============================================================
    // GENERATE PDF
    // ============================================================

    const pdfBuffer = await generatePdf({
      title: "CAPEX LIST REPORT",
      reportName: "CAPEX List Report",
      organizationId,
      logoUrl: data.logoUrl,
      orientation: "landscape",
      metadata,
      columns,
      rows: pdfRows,
      pageMargins: [20, 25, 20, 35],
    });

    return {
      success: true,
      message: "CAPEX list PDF generated successfully.",
      data: pdfBuffer,
      fileName: `CAPEX_List_Report_${Date.now()}.pdf`,
      contentType: "application/pdf",
    };
  } catch (error) {
    console.error("Get All CAPEX PDF Error:", error);

    return {
      success: false,
      message: "Unable to generate CAPEX list PDF.",
      statusCode: 503,
    };
  }
};
// Export the exact same records as getAllCapex. Keeping list visibility in one
// place prevents configured-flow differences (for example, a flow without
// OWNER) from making the screen and PDF disagree.
const generateCapexListPdf = async (data) => {
  try {
    const rows = [];
    const exportPageSize = 1000;
    let page = 1;
    let totalPages = 1;

    do {
      const response = await getAllCapex({
        ...data,
        page,
        PageSize: exportPageSize,
      });

      if (!response.success) return response;

      rows.push(...response.data);
      totalPages = response.TotalPages;
      page += 1;
    } while (page <= totalPages);

    return generateCapexListPdfDocument({
      ...data,
      PreparedRows: rows,
    });
  } catch (error) {
    console.error("Generate CAPEX List PDF Error:", error.message);
    return fail("Unable to generate CAPEX list PDF.", 503);
  }
};
// ===============================================================Department Report PDF
const getCapexDepartmentReportPdf = async (data) => {
  try {
    // Same report query as Department Report API
    const result = { rows: await CapexWorkflowRead.report(data, "department") };

    const rows = result.rows;
const organizationId = data?.Filters?.OrganizationID || null;

let organizationName = "All Organizations";

if (organizationId) {
  const organizationResult = await pool.query(
    `SELECT OrganizationName
     FROM Organization_Master
     WHERE OrganizationID = $1
       AND IsDeleted = FALSE
     LIMIT 1`,
    [organizationId],
  );

  organizationName =
    organizationResult.rows[0]?.organizationname || "All Organizations";
}
    const pdfBuffer = await generatePdf({
      title: "CAPEX Department Report",
      reportName: "CAPEX Department Report",

      // Agar organization filter hai to yahan pass kar sakte ho
      organizationId: data?.Filters?.OrganizationID || null,

      orientation: "landscape",

      metadata: [
        {
      label: "Organization",
      value: organizationName,
    },
        {
          label: "Department",
          value: data?.Filters?.Department || "All",
        },
        {
          label: "From Date",
          value: data?.Filters?.FromDate
            ? formatDate(data.Filters.FromDate)
            : "All",
        },
        {
          label: "To Date",
          value: data?.Filters?.ToDate
            ? formatDate(data.Filters.ToDate)
            : "All",
        },
      ],

      columns: [
        {
          header: "Department",
          key: "department",
          width: "*",
        },
        {
          header: "Total Count",
          key: "count",
          width: 90,
          align: "center",
        },

        {
          header: "Approved",
          key: "approvedcount",
          width: 90,
          align: "center",
        },
        {
          header: "Pending",
          key: "pendingcount",
          width: 90,
          align: "center",
        },
        {
          header: "Rejected",
          key: "rejectedcount",
          width: 90,
          align: "center",
        },
         {
          header: "Returned",
          key: "returnedcount",
          width: 90,
          align: "center",
        },
        {
          header: "Hold",
          key: "holdcount",
          width: 90,
          align: "center",
        },
       
      ],

      rows,
    });

    return {
      success: true,
      message: "CAPEX department report PDF generated successfully.",
      pdfBuffer,
      fileName: "CAPEX_Department_Report.pdf",
    };
  } catch (error) {
    console.error("CAPEX Department Report PDF Error:", error);

    return {
      success: false,
      message: "Unable to generate CAPEX department report PDF.",
      statusCode: 500,
    };
  }
};
// ============================================================ Organization Report PDF
const getCapexOrganizationReportPdf = async (data) => {
  try {
    const result = { rows: await CapexWorkflowRead.report(data, "organization") };

    const rows = result.rows;

    const pdfBuffer = await generatePdf({
      title: "CAPEX Organization Report",
      reportName: "CAPEX Organization Report",

      organizationId: data?.Filters?.OrganizationID || null,

      orientation: "landscape",

      metadata: [
        {
          label: "From Date",
          value: data?.Filters?.FromDate
            ? formatDate(data.Filters.FromDate)
            : "All",
        },
        {
          label: "To Date",
          value: data?.Filters?.ToDate
            ? formatDate(data.Filters.ToDate)
            : "All",
        },
      ],

      columns: [
        {
          header: "Organization",
          key: "shortname",
          width: "*",
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
      message: "CAPEX organization report PDF generated successfully.",
      pdfBuffer,
      fileName: "CAPEX_Organization_Report.pdf",
    };
  } catch (error) {
    console.error("CAPEX Organization Report PDF Error:", error.message);

    return {
      success: false,
      message: "Unable to generate CAPEX organization report PDF.",
      statusCode: 500,
    };
  }
};
// ============================================================== Single Capex Report PDF
// ========================Helper
const formatCapexAmount = (value) => {
  const amount = Number(value);

  if (!Number.isFinite(amount)) {
    return "0.00";
  }

  return amount.toLocaleString("en-IN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
};
const formatCapexFileSize = (value) => {
  const bytes = Number(value);

  if (!Number.isFinite(bytes) || bytes <= 0) {
    return "-";
  }

  if (bytes < 1024) {
    return `${bytes} Bytes`;
  }

  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(2)} KB`;
  }

  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
};
const capexPdfValue = (value) => {
  if (
    value === undefined ||
    value === null ||
    String(value).trim() === ""
  ) {
    return "-";
  }

  return String(value);
};
// ========================Api
const generateCapexByIdPdf = async (data) => {
  try {
    // ==========================================================
    // VALIDATE CAPEX ID
    // ==========================================================
    const capexID = Number(data.CapexID);

    if (!Number.isInteger(capexID) || capexID <= 0) {
      return fail("Valid CAPEX ID is required.", 400);
    }

    // ==========================================================
    // FETCH CAPEX
    // ==========================================================
    const detailResponse = await getCapexById({ ...data, CapexID: capexID });
    if (!detailResponse.success) return detailResponse;
    const capex = detailResponse.data;

    const approvals = Array.isArray(capex.Approvals)
      ? capex.Approvals
      : [];

    // ==========================================================
    // COLORS
    // ==========================================================
    const COLORS = {
      mainHeader: "#082B5C",
      label: "#082B5C",
      value: "#172033",
      icon: "#0D3B7A",

      labelBackground: "#F4F6F9",
      tableHeaderBackground: "#F4F6F9",

      border: "#CFD7E3",
      white: "#FFFFFF",

      approved: "#15803D",
      approvedBackground: "#DCFCE7",

      pending: "#D97706",
      pendingBackground: "#FEF3C7",

      rejected: "#B91C1C",
      rejectedBackground: "#FEE2E2",

      returned: "#7C3AED",
      returnedBackground: "#EDE9FE",

      hold: "#B45309",
      holdBackground: "#FEF3C7",

      muted: "#64748B",
    };

    // ==========================================================
    // COMMON LABEL WIDTH
    // All label boxes will use same width
    // ==========================================================
    const LABEL_WIDTH = 90;

    // ==========================================================
    // LOGO / GENERATED DATE
    // ==========================================================
    const logo = await loadLogo(capex.OrganizationID);

    const generatedOn = formatDate(
      new Date(),
      "DD MMM YYYY hh:mm A",
    );

    // ==========================================================
    // SVG STYLE ICONS
    // ==========================================================
    const fieldIcon = (type) => {
      const stroke = COLORS.icon;

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
        lineColor: stroke,
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
        lineColor: stroke,
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
        lineColor: stroke,
      });

      const icons = {
        organization: [
          rect(5, 3, 10, 15, 1),
          line(2, 18, 18, 18),
          line(8, 7, 8, 8),
          line(12, 7, 12, 8),
          line(8, 11, 8, 12),
          line(12, 11, 12, 12),
          line(10, 15, 10, 18),
        ],

        capex: [
          rect(4, 2, 11, 16, 1),
          line(7, 6, 12, 6),
          line(7, 9, 12, 9),
          line(7, 12, 12, 12),
          line(7, 15, 11, 15),
        ],

        calendar: [
          rect(2, 4, 16, 14, 1),
          line(2, 8, 18, 8),
          line(6, 2, 6, 6),
          line(14, 2, 14, 6),

          line(6, 11, 8, 11),
          line(11, 11, 13, 11),
          line(6, 14, 8, 14),
          line(11, 14, 13, 14),
        ],

        department: [
          ellipse(10, 5, 2.5),
          ellipse(4, 7, 2),
          ellipse(16, 7, 2),

          line(6, 18, 6, 13),
          line(14, 18, 14, 13),
          line(6, 13, 14, 13),
          line(2, 18, 18, 18),
        ],

        item: [
          {
            type: "polyline",
            points: [
              { x: 2, y: 8 },
              { x: 9, y: 1 },
              { x: 18, y: 10 },
              { x: 10, y: 18 },
              { x: 2, y: 10 },
            ],
            closePath: true,
            lineWidth: 1.25,
            lineColor: stroke,
          },
          ellipse(8, 6, 1.2),
        ],

        make: [
          ellipse(10, 10, 5),
          ellipse(10, 10, 2),

          line(10, 1, 10, 5),
          line(10, 15, 10, 19),

          line(1, 10, 5, 10),
          line(15, 10, 19, 10),

          line(4, 4, 7, 7),
          line(13, 13, 16, 16),

          line(16, 4, 13, 7),
          line(4, 16, 7, 13),
        ],

        quantity: [
          {
            type: "polyline",
            points: [
              { x: 10, y: 1 },
              { x: 18, y: 5 },
              { x: 10, y: 9 },
              { x: 2, y: 5 },
            ],
            closePath: true,
            lineWidth: 1.25,
            lineColor: stroke,
          },

          line(2, 5, 2, 14),
          line(18, 5, 18, 14),

          line(2, 14, 10, 19),
          line(18, 14, 10, 19),

          line(10, 9, 10, 19),
        ],

        rate: [
          line(5, 3, 15, 3),
          line(5, 7, 15, 7),
          line(8, 3, 8, 17),
          line(8, 7, 16, 18),
          line(8, 7, 11, 7),
        ],

        total: [
          ellipse(10, 5, 7, 3),
          ellipse(10, 10, 7, 3),
          ellipse(10, 15, 7, 3),

          line(3, 5, 3, 15),
          line(17, 5, 17, 15),
        ],

        description: [
          rect(4, 2, 12, 16, 1),

          line(7, 7, 13, 7),
          line(7, 10, 13, 10),
          line(7, 13, 12, 13),
        ],
      };

      const iconScale = 0.8;

      return (icons[type] || icons.capex).map((shape) => {
        const scaledShape = {
          ...shape,
          lineWidth: (shape.lineWidth || 1) * iconScale,
        };

        for (const coordinate of [
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
        ]) {
          if (typeof scaledShape[coordinate] === "number") {
            scaledShape[coordinate] *= iconScale;
          }
        }

        if (Array.isArray(scaledShape.points)) {
          scaledShape.points = scaledShape.points.map(
            (point) => ({
              x: point.x * iconScale,
              y: point.y * iconScale,
            }),
          );
        }

        return scaledShape;
      });
    };

    // ==========================================================
    // LABEL CELL
    // Same height / same padding for every label
    // ==========================================================
    const labelCell = (text, icon) => ({
      columns: [
        {
          width: 22,
          canvas: fieldIcon(icon),
          margin: [0, 0, 0, 0],
        },
        {
          width: "*",
          text,
          style: "fieldLabel",
          margin: [3, 0, 0, 0],
        },
      ],

      fillColor: COLORS.labelBackground,

      margin: [8, 6, 6, 6],
    });

    // ==========================================================
    // VALUE CELL
    // ==========================================================
    const valueCell = (value) => ({
      text: capexPdfValue(value),
      style: "fieldValue",
      margin: [8, 6, 6, 6],
    });

    // ==========================================================
    // COMMON TABLE BORDER
    // ==========================================================
    const borderedLayout = {
      hLineColor: () => COLORS.border,
      vLineColor: () => COLORS.border,

      hLineWidth: () => 0.7,
      vLineWidth: () => 0.7,

      paddingLeft: () => 0,
      paddingRight: () => 0,
      paddingTop: () => 0,
      paddingBottom: () => 0,
    };

    // ==========================================================
    // STATUS CELL
    // ==========================================================
    const statusCell = (statusValue) => ({
      text: capexPdfValue(statusValue),
      style: "approvalValue",
      margin: [4, 5, 4, 5],
    });

    // ==========================================================
    // APPROVAL ROWS
    // ==========================================================
    const approvalRows = [];

    approvals.forEach((approval) => {
      if (
        approval.ApprovalRole === undefined ||
        approval.ApprovalRole === null ||
        String(approval.ApprovalRole).trim() === ""
      ) {
        return;
      }

      const approvalRole = String(
        approval.ApprovalRole,
      ).trim();

      const approvedQuantity =
        approval.ApprovedQuantity !== null &&
        approval.ApprovedQuantity !== undefined &&
        String(approval.ApprovedQuantity).trim() !== ""
          ? formatCapexAmount(
              approval.ApprovedQuantity,
            )
          : "-";

      approvalRows.push([
        {
          text: approvalRole,
          style: "approvalRole",
          margin: [4, 5, 4, 5],
        },

        statusCell(approval.Status),

        {
          text: approvedQuantity,
          style: "approvalValue",
          margin: [4, 5, 4, 5],
        },

        {
          text: capexPdfValue(
            approval.Remarks,
          ),
          style: "approvalValue",
          margin: [4, 5, 4, 5],
        },
      ]);
    });

    if (approvalRows.length === 0) {
      approvalRows.push([
        {
          text: "No approval details available",
          colSpan: 4,
          alignment: "center",
          color: COLORS.muted,
          margin: [0, 7, 0, 7],
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

      pageOrientation: "portrait",

      pageMargins: [
        22,
        26,
        22,
        72,
      ],

      defaultStyle: {
        font: "Roboto",
        fontSize: 9,
        color: COLORS.value,
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
                      image: logo,

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
                  text: "CAPEX Detail Report",

                  style: "title",

                  alignment: "center",

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

          layout: "noBorders",
        },

        // ======================================================
        // HEADER LINE
        // ======================================================
        {
          canvas: [
            {
              type: "line",

              x1: 0,
              y1: 0,

              x2: 551,
              y2: 0,

              lineWidth: 0.8,

              lineColor: COLORS.mainHeader,
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
        // ORGANIZATION + CAPEX NO.
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
              [
                labelCell(
                  "Organization",
                  "organization",
                ),

                valueCell(
                  capex.OrganizationShortName ||
                    capex.OrganizationID,
                ),

                labelCell(
                  "CAPEX No.",
                  "capex",
                ),

                valueCell(
                  capex.CapexNumber,
                ),
              ],

              [
                labelCell(
                  "Created On",
                  "calendar",
                ),

                valueCell(
                  capex.CreatedDate,
                ),

                labelCell(
                  "Department",
                  "department",
                ),

                valueCell(
                  capex.Department,
                ),
              ],
            ],
          },

          layout: borderedLayout,

          // No bottom gap
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
                  capex.Item,
                ),

                labelCell(
                  "Make",
                  "make",
                ),

                valueCell(
                  capex.Make,
                ),
              ],
            ],
          },

          layout: borderedLayout,

          // No gap
          margin: [
            0,
            0,
            0,
            0,
          ],
        },

        // ======================================================
        // QUANTITY + RATE + TOTAL
        // All 3 labels have same width
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
                labelCell(
                  "Quantity",
                  "quantity",
                ),

                valueCell(
                  formatCapexAmount(
                    capex.Qty,
                  ),
                ),

                labelCell(
                  "Rate",
                  "rate",
                ),

                valueCell(
                  `INR ${formatCapexAmount(
                    capex.Rate,
                  )}`,
                ),

                labelCell(
                  "Total",
                  "total",
                ),

                {
                  text: `INR ${formatCapexAmount(
                    capex.Total,
                  )}`,

                  style: "totalValue",

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

          layout: borderedLayout,

          // No gap
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
                  text: capexPdfValue(
                    capex.Description,
                  ),

                  style: "descriptionValue",

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

          layout: borderedLayout,

          // No gap
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
              [
                {
                  text: "Approval",
                  style: "tableHeader",
                },

                {
                  text: "Status",
                  style: "tableHeader",
                },

                {
                  text: "Qty",
                  style: "tableHeader",
                },

                {
                  text: "Remarks",
                  style: "tableHeader",
                },
              ],

              ...approvalRows,
            ],
          },

          layout: {
            hLineColor: () =>
              COLORS.border,

            vLineColor: () =>
              COLORS.border,

            hLineWidth: () =>
              0.7,

            vLineWidth: () =>
              0.7,

            fillColor: (
              rowIndex,
            ) =>
              rowIndex === 0
                ? COLORS.tableHeaderBackground
                : COLORS.white,

            paddingLeft: () =>
              8,

            paddingRight: () =>
              8,

            paddingTop: () =>
              6,

            paddingBottom: () =>
              6,
          },

          // No gap above approval
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
          {
            canvas: [
              {
                type: "line",

                x1: 0,
                y1: 0,

                x2: 551,
                y2: 0,

                lineWidth: 0.7,

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

                    fontSize: 8,
                  },
                ],
              },

              {
                width: 130,

                stack: [
                  {
                    text: `Generated On   :  ${generatedOn}`,

                    fontSize: 7,

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
          fontSize: 18,

          bold: true,

          color:
            COLORS.mainHeader,
        },

        fieldLabel: {
          fontSize: 9,

          bold: true,

          color:
            COLORS.label,
        },

        fieldValue: {
          fontSize: 9,

          color:
            COLORS.value,
        },

        descriptionValue: {
          fontSize: 9,

          lineHeight: 1.25,

          color:
            COLORS.value,
        },

        totalValue: {
          fontSize: 9,

          bold: true,

          color:
            COLORS.value,
        },

        tableHeader: {
          fontSize: 9,

          bold: true,

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
          fontSize: 9,

          bold: true,

          color:
            COLORS.value,
        },

        approvalValue: {
          fontSize: 9,

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
                CAPEX_DETAIL_PDF_FONTS,
              ).createPdfKitDocument(
                documentDefinition,
              );

            const chunks = [];

            pdfDocument.on(
              "data",
              (chunk) =>
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
        "CAPEX PDF generated successfully.",

      FileName: `CAPEX-${capex.CapexNumber}.pdf`,

      ContentType:
        "application/pdf",

      PdfBuffer:
        pdfBuffer,
    };
  } catch (error) {
    console.error(
      "Generate CAPEX PDF Service Error:",
      error.message,
    );

    const retryResponse =
      retryableDatabaseResponse(
        error,
      );

    if (retryResponse) {
      return retryResponse;
    }

    return fail(
      "Unable to generate CAPEX PDF at this time.",
      500,
    );
  }
};

// ============================================================ Exports
module.exports = {
  createCapex,
  getAllCapex,
  getCapexById,
  updateCapex,
  deleteCapex,
  processCapexApproval,
  getCapexSummaryReport,
  getCapexDepartmentReport,
  getCapexOrganizationReport,
  getApprovalConfig,
  createApprovalConfig,
  deleteApprovalConfig,
  generateCapexListPdf,
  getCapexDepartmentReportPdf,
  getCapexOrganizationReportPdf,
  generateCapexByIdPdf
};
