const { pool } = require("../../db");
const {retryableDatabaseResponse,} = require("../../utils/retryableDatabaseError");
const { formatDate } = require("../../utils/dateFormatter");
const generateUrl = require("../../AzurConfigration/Gatepass/AzureGetData");
// ===============================================Pdf Helper
const { generatePdf, loadLogo } = require("../../utils/pdfHelper");
const PdfPrinter = require("pdfmake");
const path = require("path");
const  EQUIPMENT_DETAIL_PDF_FONTS = {
  Roboto: {
    normal: path.join(process.cwd(), "fonts/Roboto-Regular.ttf"),
    bold: path.join(process.cwd(), "fonts/Roboto-Medium.ttf"),
    italics: path.join(process.cwd(), "fonts/Roboto-SemiBold.ttf"),
    bolditalics: path.join(process.cwd(), "fonts/Roboto-Bold.ttf"),
  },
};

// =============================Response Helpers
const ok = (message, data, metadata) => ({
  success: true,
  message,

  ...(metadata !== undefined
    ? metadata
    : {}),

  ...(data !== undefined
    ? { data }
    : {}),
});
const fail = (message,statusCode = 400) => ({
  success: false,
  statusCode,
  message,
});
const databaseFailure = (
  error,
  action,
) => {
  console.error(
    `${action} Error:`,
    error.message,
  );

  const retryResponse =
    retryableDatabaseResponse(error);

  if (retryResponse) {
    return retryResponse;
  }

  return {
    success: false,
    statusCode: 500,
    message:
      `Unable to ${action.toLowerCase()}.`,
  };
};

// ===========================================================================================RGP
// ============================================================Helpers
// ======================== Default RGP Approval Levels
const DEFAULT_RGP_APPROVALS = Object.freeze([
  { LevelNo: 1, ApprovalRole: "HOD" },
  { LevelNo: 2, ApprovalRole: "FC" },
  { LevelNo: 3, ApprovalRole: "GM" },
]);
// ======================== Normalize RGP Approval Role
const normalizeRGPApprovalRole = (value) => {
  const role = String(value || "")
    .trim()
    .toUpperCase();

  return role === "FINANCE"
    ? "FC"
    : role;
};
// ======================= Approval Role Condition Helper
const resolveRGPApprovalRole = ({
  UserType,
  DepartmentName,
}) => {
  const userType = String(
    UserType || "",
  )
    .trim()
    .toUpperCase();

  const departmentName = String(
    DepartmentName || "",
  )
    .trim()
    .toUpperCase();

  // ============================================================
  // FC
  // FC approval = Finance HOD
  // ============================================================

  if (
    userType === "HOD" &&
    ["FC", "FINANCE"].includes(
      departmentName,
    )
  ) {
    return "FC";
  }

  // ============================================================
  // HOD
  // Other Department HOD
  // ============================================================

  if (userType === "HOD") {
    return "HOD";
  }

  // ============================================================
  // GM
  // ============================================================

  if (userType === "GM") {
    return "GM";
  }

  // ============================================================
  // Other Custom Config Roles
  // ============================================================

  if (userType) {
    return normalizeRGPApprovalRole(
      userType,
    );
  }

  return null;
};
// ============================Map RGP
const mapRGP = (row) => ({
  RGPID:
    Number(row.rgpid),

  RGPNumber:
    Number(row.rgpnumber),

  OrganizationID:
    Number(row.organizationid),

  ExpectedReturnDate:
    row.expectedreturndate
      ? formatDate(
          row.expectedreturndate,
        )
      : null,

  VendorName:
    row.vendorname,

  ContactNumber:
    row.contactnumber,

  Company:
    row.company,

  DepartmentID:
    row.departmentid !== null
      ? Number(row.departmentid)
      : null,

  DepartmentName:
    row.departmentname || null,

  Address:
    row.address,

  TakenBy:
    row.takenby,

  Status:
    row.status,


    
  CreatedDate:
    row.createddate
      ? formatDate(
          row.createddate,
        )
      : null
 
});
// ===========================Map RGP Item
const mapRGPItem = (row) => ({
  RGPItemID:
    Number(row.rgpitemid),

  RGPID:
    Number(row.rgpid),

  OrganizationID:
    Number(row.organizationid),

  ItemName:
    row.itemname,

  Specification:
    row.specification,

  Quantity:
    Number(row.quantity),

  Unit:
    row.unit,

  Rate:
    row.rate !== null
      ? Number(row.rate)
      : null,

  MakeModel:
    row.makemodel,

  SerialNumber:
    row.serialnumber,

  ReturnedQuantity:
    Number(
      row.returnedquantity || 0,
    ),

  RemainingQuantity:
    Number(
      row.remainingquantity || 0,
    ),

  IsReturned:
    Boolean(row.isreturned),

 CreatedDate:
    row.createddate
      ? formatDate(
          row.createddate,
        )
      : null

});
// ==========================Map RGP Document
const mapRGPDocument = (row) => ({
  RGPDocumentID:
    Number(row.rgpdocumentid),

  RGPID:
    Number(row.rgpid),

  FileName:
    row.filename,

  FilePath:
    row.filepath,

 
});
// ==========================Map RGP Approval
const mapRGPApproval = (row) => ({
  RGPApprovalConfigID:
    row.rgpapprovalconfigid == null
      ? null
      : Number(row.rgpapprovalconfigid),
  

  ApprovalLevel:
    Number(row.approvallevel),

  ApprovalRole:
    row.approvalrole,

  ApprovalOrder:
    Number(row.approvalorder),

  Status:
    row.status,

  
  Remarks:
    row.remarks,
});
// ==========================Attach RGP Related Data
const attachRGPRelatedData = async (
  rows,
) => {
  if (!rows.length) {
    return [];
  }

  const rgpIDs = rows.map(
    (row) => Number(row.rgpid),
  );

  // ==========================================================
  // Items
  // ==========================================================

  const itemResult =
    await pool.query(
      `
      SELECT
        RGPItemID,
        RGPID,
        OrganizationID,

        ItemName,
        Specification,
        Quantity,
        Unit,
        Rate,
        MakeModel,
        SerialNumber,

        ReturnedQuantity,
        RemainingQuantity,
        IsReturned,

        CreatedBy,
        CreatedDate,
        ModifiedBy,
        ModifiedDate

      FROM Gatepass_RGP_Entry_Item_Details

      WHERE RGPID =
        ANY($1::BIGINT[])

        AND IsDeleted = FALSE

      ORDER BY
        RGPItemID ASC;
      `,
      [rgpIDs],
    );

  // ==========================================================
  // Documents
  // ==========================================================

  const documentResult =
    await pool.query(
      `
      SELECT
        RGPDocumentID,
        RGPID,

        FileName,
        FilePath,
        FileType,
        FileSize,

        CreatedBy,
        CreatedDate

      FROM Gatepass_RGP_Entry_Master_Document

      WHERE RGPID =
        ANY($1::BIGINT[])

        AND IsDeleted = FALSE

      ORDER BY
        RGPDocumentID ASC;
      `,
      [rgpIDs],
    );

  // ==========================================================
  // Approvals
  // ==========================================================

  const approvalResult =
    await pool.query(
      `
      SELECT
        RGPApprovalID,
        RGPID,
        OrganizationID,

        RGPApprovalConfigID,
        ApprovalLevel,
        ApprovalRole,
        ApprovalOrder,

        Status,
        StatusDateTime,
        ActionBy,
        Remarks

      FROM Gatepass_RGP_Approval

      WHERE RGPID =
        ANY($1::BIGINT[])

        AND IsDeleted = FALSE

      ORDER BY
        ApprovalOrder ASC;
      `,
      [rgpIDs],
    );

  return rows.map((row) => {
    const rgp =
      mapRGP(row);

    const belongsToRGP = (related) => Number(related.rgpid) === rgp.RGPID;
    const omitParentIDs = ({ RGPID, OrganizationID, ...details }) => details;

    rgp.Items = itemResult.rows
      .filter(belongsToRGP)
      .map(mapRGPItem)
      .map(omitParentIDs);

    rgp.Documents = documentResult.rows
      .filter(belongsToRGP)
      .map(mapRGPDocument)
      .map(omitParentIDs);

    rgp.Approvals = approvalResult.rows
      .filter(belongsToRGP)
      .map(mapRGPApproval)
      .map(omitParentIDs);

    return rgp;
  });
};
// ============================================================ CREATE RGP
const createRGP = async (data) => {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    // ==========================================================
    // Check Organization
    // ==========================================================

    const organizationResult = await client.query(
      `
      SELECT
        OrganizationID

      FROM Organization_Master

      WHERE OrganizationID = $1

      LIMIT 1;
      `,
      [data.OrganizationID],
    );

    if (!organizationResult.rows.length) {
      await client.query("ROLLBACK");

      return fail(
        "Organization not found.",
        404,
      );
    }

    // ==========================================================
    // Get Organization Approval Configuration
    // ==========================================================

    const approvalConfigResult = await client.query(
      `
      SELECT
        RGPApprovalConfigID,
        OrganizationID,
        ApprovalLevel,
        ApprovalRole,
        ApprovalOrder,
        IsMandatory

      FROM Gatepass_RGP_Approval_Config

      WHERE OrganizationID = $1
        AND IsDeleted = FALSE

      ORDER BY
        ApprovalOrder ASC;
      `,
      [data.OrganizationID],
    );

    // ==========================================================
    // Resolve Approval Levels
    //
    // Config available -> Organization Config
    // Config not available -> Default HOD -> FC -> GM
    // ==========================================================

    let approvalLevels = [];

    if (approvalConfigResult.rows.length) {
      approvalLevels =
        approvalConfigResult.rows.map(
          (row) => ({
            RGPApprovalConfigID:
              Number(
                row.rgpapprovalconfigid,
              ),

            LevelNo:
              Number(
                row.approvallevel,
              ),

            ApprovalRole:
              row.approvalrole,

            ApprovalOrder:
              Number(
                row.approvalorder,
              ),

            IsMandatory:
              row.ismandatory,
          }),
        );
    } else {
      approvalLevels =
        DEFAULT_RGP_APPROVALS.map(
          (approval, index) => ({
            RGPApprovalConfigID:
              null,

            LevelNo:
              approval.LevelNo,

            ApprovalRole:
              approval.ApprovalRole,

            ApprovalOrder:
              index + 1,

            IsMandatory:
              true,
          }),
        );
    }

    // ==========================================================
    // Insert Master
    // ==========================================================

    const masterResult = await client.query(
      `
      INSERT INTO Gatepass_RGP_Entry_Master
      (
        OrganizationID,
        ExpectedReturnDate,
        VendorName,
        ContactNumber,
        Company,
        DepartmentID,
        Address,
        TakenBy,

        Status,

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

        'PENDING',

        FALSE,

        $9,
        CURRENT_TIMESTAMP
      )

      RETURNING
        RGPID,
        RGPNumber;
      `,
      [
        data.OrganizationID,
        data.ExpectedReturnDate,
        data.VendorName,
        data.ContactNumber,
        data.Company,
        data.DepartmentID,
        data.Address,
        data.TakenBy,

        data.UserID,
      ],
    );

    const rgpID =
      Number(
        masterResult.rows[0]
          .rgpid,
      );

    const rgpNumber =
      Number(
        masterResult.rows[0]
          .rgpnumber,
      );

    // ==========================================================
    // Insert Items
    // ==========================================================

    for (
      const item of
      data.Items || []
    ) {
      await client.query(
        `
        INSERT INTO Gatepass_RGP_Entry_Item_Details
        (
          RGPID,
          OrganizationID,

          ItemName,
          Specification,
          Quantity,
          Unit,
          Rate,
          MakeModel,
          SerialNumber,

          ReturnedQuantity,
          RemainingQuantity,
          IsReturned,

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

          0,
          $5,
          FALSE,

          FALSE,

          $10,
          CURRENT_TIMESTAMP
        );
        `,
        [
          rgpID,
          data.OrganizationID,

          item.ItemName,
          item.Specification,
          item.Quantity,
          item.Unit,
          item.Rate,
          item.MakeModel,
          item.SerialNumber,

          data.UserID,
        ],
      );
    }

    // ==========================================================
    // Insert Documents
    // ==========================================================

    for (
      const document of
      data.Documents || []
    ) {
      await client.query(
        `
        INSERT INTO Gatepass_RGP_Entry_Master_Document
        (
          RGPID,

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

          FALSE,

          $6,
          CURRENT_TIMESTAMP
        );
        `,
        [
          rgpID,

          document.FileName,
          document.FilePath,
          document.FileType,
          document.FileSize,

          data.UserID,
        ],
      );
    }

    // ==========================================================
    // Create Approval Rows
    // ==========================================================

    for (
      const approval of
      approvalLevels
    ) {
      await client.query(
        `
        INSERT INTO Gatepass_RGP_Approval
        (
          RGPID,
          OrganizationID,

          RGPApprovalConfigID,
          ApprovalLevel,
          ApprovalRole,
          ApprovalOrder,

          Status,

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

          'Pending',

          FALSE,

          $7,
          CURRENT_TIMESTAMP
        );
        `,
        [
          rgpID,
          data.OrganizationID,

          approval.RGPApprovalConfigID,
          approval.LevelNo,
          approval.ApprovalRole,
          approval.ApprovalOrder,

          data.UserID,
        ],
      );
    }

    // ==========================================================
    // Commit
    // ==========================================================

    await client.query("COMMIT");

    return ok(
      "RGP created successfully."
    );
  } catch (error) {
    await client.query(
      "ROLLBACK",
    );

    return databaseFailure(
      error,
      "Create RGP",
    );
  } finally {
    client.release();
  }
};
// ============================================================Get RGP List
const getRGPList = async (data) => {
  try {
    const page =
      Math.max(
        Number(data.page) || 1,
        1,
      );

    const pageSize =
      Math.min(
        Math.max(
          Number(data.PageSize) ||
            10,
          1,
        ),
        100,
      );

    const offset =
      (page - 1) * pageSize;

    const values = [];

    const conditions = [
      "m.IsDeleted = FALSE",
    ];

    // ==========================================================
    // Organization
    // ==========================================================

    values.push(
      data.OrganizationID,
    );

    conditions.push(
      `m.OrganizationID = $${values.length}`,
    );

    // ==========================================================
    // RGP Number
    // ==========================================================

    if (data.RGPNumber) {
      values.push(
        data.RGPNumber,
      );

      conditions.push(
        `m.RGPNumber = $${values.length}`,
      );
    }

    // ==========================================================
    // Status
    // ==========================================================

    if (data.Status) {
      values.push(
        data.Status,
      );

      conditions.push(
        `UPPER(m.Status) = UPPER($${values.length})`,
      );
    }

    // ==========================================================
    // Department
    // ==========================================================

    if (data.DepartmentID) {
      values.push(
        data.DepartmentID,
      );

      conditions.push(
        `m.DepartmentID = $${values.length}`,
      );
    }

    // ==========================================================
    // From Date
    // ==========================================================

    if (data.FromDate) {
      values.push(
        data.FromDate,
      );

      conditions.push(
        `m.CreatedDate::DATE >= $${values.length}::DATE`,
      );
    }

    // ==========================================================
    // To Date
    // ==========================================================

    if (data.ToDate) {
      values.push(
        data.ToDate,
      );

      conditions.push(
        `m.CreatedDate::DATE <= $${values.length}::DATE`,
      );
    }

    // ==========================================================
    // Search
    // ==========================================================

    if (data.Search) {
      values.push(
        `%${data.Search}%`,
      );

      const searchIndex =
        values.length;

      conditions.push(`
        (
          m.RGPNumber::TEXT
            ILIKE $${searchIndex}

          OR m.VendorName
            ILIKE $${searchIndex}

          OR COALESCE(
            m.ContactNumber,
            ''
          ) ILIKE $${searchIndex}

          OR COALESCE(
            m.Company,
            ''
          ) ILIKE $${searchIndex}

          OR COALESCE(
            m.TakenBy,
            ''
          ) ILIKE $${searchIndex}
        )
      `);
    }

    const whereClause =
      conditions.join(
        " AND ",
      );

    // ==========================================================
    // Count
    // ==========================================================

    const countResult =
      await pool.query(
        `
        SELECT
          COUNT(*)::BIGINT
            AS TotalCount

        FROM Gatepass_RGP_Entry_Master m

        WHERE ${whereClause};
        `,
        values,
      );

    const totalCount =
      Number(
        countResult.rows[0]
          .totalcount,
      );

    // ==========================================================
    // Pagination
    // ==========================================================

    const listValues = [
      ...values,
      pageSize,
      offset,
    ];

    const limitIndex =
      values.length + 1;

    const offsetIndex =
      values.length + 2;

    // ==========================================================
    // List Query
    // ==========================================================

    const result =
      await pool.query(
        `
        SELECT
          m.RGPID,
          m.RGPNumber,
          m.OrganizationID,

          m.ExpectedReturnDate,

          m.VendorName,
          m.ContactNumber,
          m.Company,

          m.DepartmentID,
          d.DepartmentName,

          m.Address,
          m.TakenBy,

          m.Status,

          m.CheckoutDateTime,
          m.CheckoutBy,
          m.CheckoutRemarks,

          m.CancelledBy,
          m.CancelledDateTime,
          m.CancellationRemarks,

          m.ReturnedBy,
          m.ReturnedDateTime,
          m.ReturnRemarks,

          m.CreatedBy,
          m.CreatedDate,
          m.ModifiedBy,
          m.ModifiedDate

        FROM Gatepass_RGP_Entry_Master m

        LEFT JOIN department_master d
          ON d.DepartmentID =
            m.DepartmentID

        WHERE ${whereClause}

        ORDER BY
          m.RGPID DESC

        LIMIT $${limitIndex}
        OFFSET $${offsetIndex};
        `,
        listValues,
      );

    const approvalsByRGP = new Map();
    if (result.rows.length) {
      const approvals = await pool.query(
        `SELECT RGPApprovalID, RGPID, OrganizationID,
                RGPApprovalConfigID, ApprovalLevel, ApprovalRole,
                ApprovalOrder, Status, StatusDateTime, ActionBy, Remarks
         FROM Gatepass_RGP_Approval
         WHERE RGPID = ANY($1::BIGINT[])
           AND IsDeleted = FALSE
         ORDER BY ApprovalOrder ASC, ApprovalLevel ASC, RGPApprovalID ASC;`,
        [result.rows.map((row) => row.rgpid)],
      );
      for (const approval of approvals.rows) {
        const id = String(approval.rgpid);
        if (!approvalsByRGP.has(id)) approvalsByRGP.set(id, []);
        approvalsByRGP.get(id).push(approval);
      }
    }

    const approvalRole = resolveRGPApprovalRole(data);
    const isSecurity = String(data.DepartmentName || "").trim().toUpperCase() === "SECURITY";
    const normalizeStatus = (status) => String(status || "Pending").trim().toUpperCase();
    const mappedData = result.rows.map((row) => {
      const approvals = approvalsByRGP.get(String(row.rgpid)) || [];
      const currentStage = approvals.find((approval) => normalizeStatus(approval.status) !== "APPROVED");
      const alreadyApproved = approvals.some((approval) =>
        normalizeStatus(approval.status) === "APPROVED" &&
        data.UserID != null && approval.actionby != null &&
        String(approval.actionby) === String(data.UserID),
      );
      const status = normalizeStatus(row.status);

      return {
        ...mapRGP(row),
        Approvals: approvals.map(mapRGPApproval),
        canappprove: Boolean(
          status === "PENDING" && approvalRole && currentStage &&
          normalizeStatus(currentStage.status) === "PENDING" &&
          normalizeRGPApprovalRole(currentStage.approvalrole) === approvalRole &&
          !alreadyApproved &&
          (approvalRole !== "HOD" ||
            (Number(data.UserDepartmentID) > 0 &&
              Number(data.UserDepartmentID) === Number(row.departmentid)))
        ),
        cancheckout: Boolean(
          isSecurity && status === "APPROVED" &&
          approvals.length > 0 && !currentStage
        ),
      };
    });

    return ok(
      "RGP list fetched successfully.",
      mappedData,
      {
        TotalCount:
          totalCount,

        page,

        PageSize:
          pageSize,

        TotalPages:
          Math.ceil(
            totalCount /
              pageSize,
          ),
      },
    );
  } catch (error) {
    return databaseFailure(
      error,
      "Fetch RGP list",
    );
  }
};
// ============================================================Get RGP By ID
const getRGPById = async (data) => {
  try {
    const masterResult =
      await pool.query(
        `
        SELECT
          m.RGPID,
          m.RGPNumber,
          m.OrganizationID,

          m.ExpectedReturnDate,

          m.VendorName,
          m.ContactNumber,
          m.Company,

          m.DepartmentID,
          d.DepartmentName,

          m.Address,
          m.TakenBy,

          m.Status,

          m.CheckoutDateTime,
          m.CheckoutBy,
          m.CheckoutRemarks,

          m.CancelledBy,
          m.CancelledDateTime,
          m.CancellationRemarks,

          m.ReturnedBy,
          m.ReturnedDateTime,
          m.ReturnRemarks,

          m.CreatedBy,
          m.CreatedDate,
          m.ModifiedBy,
          m.ModifiedDate

        FROM Gatepass_RGP_Entry_Master m

        LEFT JOIN department_master d
          ON d.DepartmentID =
            m.DepartmentID

        WHERE m.RGPID = $1
          AND m.IsDeleted = FALSE

        LIMIT 1;
        `,
        [data.RGPID],
      );

    if (
      !masterResult.rows.length
    ) {
      return fail(
        "RGP record not found.",
        404,
      );
    }

    const [rgp] =
      await attachRGPRelatedData(
        masterResult.rows,
      );

    rgp.Documents = rgp.Documents.map((document) => ({
      ...document,
      FilePath: document.FilePath ? generateUrl(document.FilePath) : null,
    }));

    return ok(
      "RGP record fetched successfully.",
      rgp,
    );
  } catch (error) {
    return databaseFailure(
      error,
      "Fetch RGP record",
    );
  }
};
// ============================================================Get RGP By RGP Number
const getRGPByNumber = async (data) => {
  try {
    const RGPNumber = String(
      data.RGPNumber || "",
    ).trim();

    // RGP Number nahi diya to empty response
    if (!RGPNumber) {
      return ok(
        "Enter RGP number to search.",
        null,
      );
    }

    const masterResult =
      await pool.query(
        `
        SELECT
          m.RGPID,
          m.RGPNumber,
          m.OrganizationID,

          m.ExpectedReturnDate,

          m.VendorName,
          m.ContactNumber,
          m.Company,

          m.DepartmentID,
          d.DepartmentName,

          m.Address,
          m.TakenBy,

          m.Status,

          m.CheckoutDateTime,
          m.CheckoutBy,
          m.CheckoutRemarks,

          m.CancelledBy,
          m.CancelledDateTime,
          m.CancellationRemarks,

          m.ReturnedBy,
          m.ReturnedDateTime,
          m.ReturnRemarks,

          m.CreatedBy,
          m.CreatedDate,
          m.ModifiedBy,
          m.ModifiedDate

        FROM Gatepass_RGP_Entry_Master m

        LEFT JOIN department_master d
          ON d.DepartmentID =
            m.DepartmentID

        WHERE m.RGPNumber = $1
          AND m.IsDeleted = FALSE

        LIMIT 1;
        `,
        [RGPNumber],
      );

    // RGP Number mila nahi
    if (!masterResult.rows.length) {
      return ok(
        "RGP record not found.",
        null,
      );
    }

    // Same related data as Get By ID
    const [rgp] =
      await attachRGPRelatedData(
        masterResult.rows,
      );

    // Generate document URLs
    rgp.Documents =
      rgp.Documents.map(
        (document) => ({
          ...document,
          FilePath:
            document.FilePath
              ? generateUrl(
                  document.FilePath,
                )
              : null,
        }),
      );

    return ok(
      "RGP record fetched successfully.",
      rgp,
    );
  } catch (error) {
    return databaseFailure(
      error,
      "Fetch RGP record by number",
    );
  }
};
// ============================================================Vendor Names
const getRGPVendorNames = async (data) => {
  try {
    const result = await pool.query(
      `
      SELECT DISTINCT
        TRIM(VendorName) AS VendorName

      FROM Gatepass_RGP_Entry_Master

      WHERE OrganizationID = $1
        AND IsDeleted = FALSE
        AND VendorName IS NOT NULL
        AND TRIM(VendorName) <> ''

      ORDER BY VendorName ASC;
      `,
      [data.OrganizationID],
    );

    const vendorNames = result.rows.map(
      (row) => ({ VendorName: row.vendorname }),
    );

    return ok(
      "RGP vendor names fetched successfully.",
      vendorNames,
      {
        Count: vendorNames.length,
      },
    );
  } catch (error) {
    return databaseFailure(
      error,
      "Fetch RGP vendor names",
    );
  }
};
// ============================================================Update RGP
const updateRGP = async (data) => {
  const client =
    await pool.connect();

  try {
    await client.query("BEGIN");

    // ==========================================================
    // Check Existing Master
    // ==========================================================

    const existing =
      await client.query(
        `
        SELECT
          RGPID,
          OrganizationID,
          Status

        FROM Gatepass_RGP_Entry_Master

        WHERE RGPID = $1
          AND IsDeleted = FALSE

        FOR UPDATE;
        `,
        [data.RGPID],
      );

    if (
      !existing.rows.length
    ) {
      await client.query(
        "ROLLBACK",
      );

      return fail(
        "RGP record not found.",
        404,
      );
    }

    // ==========================================================
    // Update Master
    // ==========================================================

    await client.query(
      `
      UPDATE Gatepass_RGP_Entry_Master

      SET
        OrganizationID = $1,
        ExpectedReturnDate = $2,
        VendorName = $3,
        ContactNumber = $4,
        Company = $5,
        DepartmentID = $6,
        Address = $7,
        TakenBy = $8,

        ModifiedBy = $9,
        ModifiedDate =
          CURRENT_TIMESTAMP

      WHERE RGPID = $10
        AND IsDeleted = FALSE;
      `,
      [
        data.OrganizationID,
        data.ExpectedReturnDate,
        data.VendorName,
        data.ContactNumber,
        data.Company,
        data.DepartmentID,
        data.Address,
        data.TakenBy,

        data.UserID,

        data.RGPID,
      ],
    );

    // ==========================================================
    // Keep Item Organization Same
    // ==========================================================

    await client.query(
      `
      UPDATE Gatepass_RGP_Entry_Item_Details

      SET
        OrganizationID = $1

      WHERE RGPID = $2
        AND IsDeleted = FALSE;
      `,
      [
        data.OrganizationID,
        data.RGPID,
      ],
    );

    // ==========================================================
    // Delete Selected Items
    // ==========================================================

    if (
      Array.isArray(
        data.DeleteItemIDs,
      ) &&
      data.DeleteItemIDs.length > 0
    ) {
      await client.query(
        `
        UPDATE Gatepass_RGP_Entry_Item_Details

        SET
          IsDeleted = TRUE,
          DeletedBy = $1,
          DeletedDate =
            CURRENT_TIMESTAMP

        WHERE RGPID = $2
          AND RGPItemID =
            ANY($3::BIGINT[])
          AND IsDeleted = FALSE;
        `,
        [
          data.UserID,
          data.RGPID,
          data.DeleteItemIDs,
        ],
      );
    }

    // ==========================================================
    // Update / Insert Items
    // ==========================================================

    for (
      const item of
      data.Items || []
    ) {
      // ========================================================
      // Existing Item
      // ========================================================

      if (item.RGPItemID) {
        const itemExisting =
          await client.query(
            `
            SELECT
              RGPItemID,
              Quantity,
              ReturnedQuantity

            FROM Gatepass_RGP_Entry_Item_Details

            WHERE RGPItemID = $1
              AND RGPID = $2
              AND IsDeleted = FALSE

            FOR UPDATE;
            `,
            [
              item.RGPItemID,
              data.RGPID,
            ],
          );

        if (
          !itemExisting.rows.length
        ) {
          await client.query(
            "ROLLBACK",
          );

          return fail(
            `RGP item ${item.RGPItemID} not found.`,
            400,
          );
        }

        const returnedQuantity =
          Number(
            itemExisting.rows[0]
              .returnedquantity || 0,
          );

        if (
          Number(item.Quantity) <
          returnedQuantity
        ) {
          await client.query(
            "ROLLBACK",
          );

          return fail(
            `Quantity cannot be less than returned quantity for RGP item ${item.RGPItemID}.`,
            400,
          );
        }

        const remainingQuantity =
          Number(item.Quantity) -
          returnedQuantity;

        const isReturned =
          remainingQuantity === 0;

        await client.query(
          `
          UPDATE Gatepass_RGP_Entry_Item_Details

          SET
            OrganizationID = $1,

            ItemName = $2,
            Specification = $3,
            Quantity = $4,
            Unit = $5,
            Rate = $6,
            MakeModel = $7,
            SerialNumber = $8,

            RemainingQuantity = $9,
            IsReturned = $10,

            ModifiedBy = $11,
            ModifiedDate =
              CURRENT_TIMESTAMP

          WHERE RGPItemID = $12
            AND RGPID = $13
            AND IsDeleted = FALSE;
          `,
          [
            data.OrganizationID,

            item.ItemName,
            item.Specification,
            item.Quantity,
            item.Unit,
            item.Rate,
            item.MakeModel,
            item.SerialNumber,

            remainingQuantity,
            isReturned,

            data.UserID,

            item.RGPItemID,
            data.RGPID,
          ],
        );
      }

      // ========================================================
      // New Item
      // ========================================================

      else {
        await client.query(
          `
          INSERT INTO Gatepass_RGP_Entry_Item_Details
          (
            RGPID,
            OrganizationID,

            ItemName,
            Specification,
            Quantity,
            Unit,
            Rate,
            MakeModel,
            SerialNumber,

            ReturnedQuantity,
            RemainingQuantity,
            IsReturned,

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

            0,
            $5,
            FALSE,

            FALSE,

            $10,
            CURRENT_TIMESTAMP
          );
          `,
          [
            data.RGPID,
            data.OrganizationID,

            item.ItemName,
            item.Specification,
            item.Quantity,
            item.Unit,
            item.Rate,
            item.MakeModel,
            item.SerialNumber,

            data.UserID,
          ],
        );
      }
    }

    // ==========================================================
    // Ensure At Least One Item
    // ==========================================================

    const itemCount =
      await client.query(
        `
        SELECT
          COUNT(*)::BIGINT
            AS ItemCount

        FROM Gatepass_RGP_Entry_Item_Details

        WHERE RGPID = $1
          AND IsDeleted = FALSE;
        `,
        [data.RGPID],
      );

    if (
      Number(
        itemCount.rows[0]
          .itemcount,
      ) === 0
    ) {
      await client.query(
        "ROLLBACK",
      );

      return fail(
        "At least one RGP item is required.",
        400,
      );
    }

    // ==========================================================
    // Delete Selected Documents
    // ==========================================================

    if (
      Array.isArray(
        data.DeleteDocumentIDs,
      ) &&
      data.DeleteDocumentIDs.length >
        0
    ) {
      await client.query(
        `
        UPDATE Gatepass_RGP_Entry_Master_Document

        SET
          IsDeleted = TRUE,
          DeletedBy = $1,
          DeletedDate =
            CURRENT_TIMESTAMP

        WHERE RGPID = $2
          AND RGPDocumentID =
            ANY($3::BIGINT[])
          AND IsDeleted = FALSE;
        `,
        [
          data.UserID,
          data.RGPID,
          data.DeleteDocumentIDs,
        ],
      );
    }

    // ==========================================================
    // Insert New Documents
    // ==========================================================

    for (
      const document of
      data.Documents || []
    ) {
      await client.query(
        `
        INSERT INTO Gatepass_RGP_Entry_Master_Document
        (
          RGPID,

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

          FALSE,

          $6,
          CURRENT_TIMESTAMP
        );
        `,
        [
          data.RGPID,

          document.FileName,
          document.FilePath,
          document.FileType,
          document.FileSize,

          data.UserID,
        ],
      );
    }

    await client.query("COMMIT");

    return ok(
      "RGP updated successfully.",
    );
  } catch (error) {
    await client.query(
      "ROLLBACK",
    );

    return databaseFailure(
      error,
      "Update RGP",
    );
  } finally {
    client.release();
  }
};
// ============================================================Delete RGP
const deleteRGP = async (data) => {
  const client =
    await pool.connect();

  try {
    await client.query("BEGIN");

    // ==========================================================
    // Check Existing
    // ==========================================================

    const existing =
      await client.query(
        `
        SELECT
          RGPID,
          OrganizationID,
          Status

        FROM Gatepass_RGP_Entry_Master

        WHERE RGPID = $1
          AND IsDeleted = FALSE

        FOR UPDATE;
        `,
        [data.RGPID],
      );

    if (
      !existing.rows.length
    ) {
      await client.query(
        "ROLLBACK",
      );

      return fail(
        "RGP record not found.",
        404,
      );
    }

    // ==========================================================
    // Delete Items
    // ==========================================================

    await client.query(
      `
      UPDATE Gatepass_RGP_Entry_Item_Details

      SET
        IsDeleted = TRUE,
        DeletedBy = $1,
        DeletedDate =
          CURRENT_TIMESTAMP

      WHERE RGPID = $2
        AND IsDeleted = FALSE;
      `,
      [
        data.UserID,
        data.RGPID,
      ],
    );

    // ==========================================================
    // Delete Documents
    // ==========================================================

    await client.query(
      `
      UPDATE Gatepass_RGP_Entry_Master_Document

      SET
        IsDeleted = TRUE,
        DeletedBy = $1,
        DeletedDate =
          CURRENT_TIMESTAMP

      WHERE RGPID = $2
        AND IsDeleted = FALSE;
      `,
      [
        data.UserID,
        data.RGPID,
      ],
    );

    // ==========================================================
    // Delete Approval Rows
    // ==========================================================

    await client.query(
      `
      UPDATE Gatepass_RGP_Approval

      SET
        IsDeleted = TRUE,
        DeletedBy = $1,
        DeletedDate =
          CURRENT_TIMESTAMP

      WHERE RGPID = $2
        AND IsDeleted = FALSE;
      `,
      [
        data.UserID,
        data.RGPID,
      ],
    );

    // ==========================================================
    // Delete Return Details
    // ==========================================================

    await client.query(
      `
      UPDATE Gatepass_RGP_Item_Return_Details

      SET
        IsDeleted = TRUE,
        DeletedBy = $1,
        DeletedDate =
          CURRENT_TIMESTAMP

      WHERE RGPID = $2
        AND IsDeleted = FALSE;
      `,
      [
        data.UserID,
        data.RGPID,
      ],
    );

    // ==========================================================
    // Delete Master
    // ==========================================================

    await client.query(
      `
      UPDATE Gatepass_RGP_Entry_Master

      SET
        IsDeleted = TRUE,
        DeletedBy = $1,
        DeletedDate =
          CURRENT_TIMESTAMP

      WHERE RGPID = $2
        AND IsDeleted = FALSE;
      `,
      [
        data.UserID,
        data.RGPID,
      ],
    );

    await client.query("COMMIT");

    return ok(
      "RGP deleted successfully.",
    );
  } catch (error) {
    await client.query(
      "ROLLBACK",
    );

    return databaseFailure(
      error,
      "Delete RGP",
    );
  } finally {
    client.release();
  }
};
// ============================================================RGP APPROVAL
const processRGPApproval = async (data) => {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const {
      RGPID,
      Action,
      Remarks,

      UserID,
      UserType,
      DepartmentName,
    } = data;

    // ============================================================
    // Logged-In Approval Role
    // ============================================================

    const approvalRole =
      resolveRGPApprovalRole({
        UserType,
        DepartmentName,
      });

    if (!approvalRole) {
      await client.query("ROLLBACK");

      return fail(
        "You are not authorized to approve RGP.",
        403,
      );
    }

    // ============================================================
    // Lock RGP Master
    // ============================================================

    const masterResult =
      await client.query(
        `
        SELECT
          RGPID,
          OrganizationID,
          RGPNumber,
          DepartmentID,
          Status

        FROM Gatepass_RGP_Entry_Master

        WHERE RGPID = $1
          AND IsDeleted = FALSE

        FOR UPDATE;
        `,
        [RGPID],
      );

    if (!masterResult.rows.length) {
      await client.query("ROLLBACK");

      return fail(
        "RGP record not found.",
        404,
      );
    }

    const master =
      masterResult.rows[0];

    if (approvalRole === "HOD" &&
        !(Number(data.UserDepartmentID) > 0 &&
          Number(data.UserDepartmentID) === Number(master.departmentid))) {
      await client.query("ROLLBACK");
      return fail("Only the HOD of the RGP department can approve or reject this RGP.", 403);
    }

    const currentMasterStatus =
      String(
        master.status || "",
      )
        .trim()
        .toUpperCase();

    // ============================================================
    // Final Status Check
    // ============================================================

    if (
      currentMasterStatus ===
      "APPROVED"
    ) {
      await client.query("ROLLBACK");

      return fail(
        "RGP is already fully approved.",
        400,
      );
    }

    if (
      currentMasterStatus ===
      "REJECTED"
    ) {
      await client.query("ROLLBACK");

      return fail(
        "Rejected RGP cannot be approved further.",
        400,
      );
    }

    if (
      [
        "CHECKED OUT",
        "RETURN PENDING",
        "RETURNED",
        "CANCELLED",
      ].includes(currentMasterStatus)
    ) {
      await client.query("ROLLBACK");

      return fail(
        `RGP approval cannot be processed when status is ${currentMasterStatus}.`,
        400,
      );
    }

    // ============================================================
    // Lock Approval Rows
    // ============================================================

    const approvalResult =
      await client.query(
        `
        SELECT
          RGPApprovalID,
          RGPID,
          OrganizationID,

          RGPApprovalConfigID,

          ApprovalLevel,
          ApprovalRole,
          ApprovalOrder,

          Status,
          StatusDateTime,
          ActionBy,
          Remarks

        FROM Gatepass_RGP_Approval

        WHERE RGPID = $1
          AND IsDeleted = FALSE

        ORDER BY
          ApprovalOrder ASC,
          ApprovalLevel ASC,
          RGPApprovalID ASC

        FOR UPDATE;
        `,
        [RGPID],
      );

    if (!approvalResult.rows.length) {
      await client.query("ROLLBACK");

      return fail(
        "RGP approval flow not found.",
        400,
      );
    }

    // ============================================================
    // Current Pending Stage
    //
    // First approval which is not Approved
    // ============================================================

    const currentStage =
      approvalResult.rows.find(
        (row) =>
          String(
            row.status ||
              "Pending",
          )
            .trim()
            .toUpperCase() !==
          "APPROVED",
      );

    if (!currentStage) {
      await client.query("ROLLBACK");

      return fail(
        "No pending RGP approval stage found.",
        400,
      );
    }

    const currentApprovalRole =
      normalizeRGPApprovalRole(
        currentStage.approvalrole,
      );

    // ============================================================
    // Logged-In User Must Be Current Approver
    // ============================================================

    if (
      currentApprovalRole !==
      approvalRole
    ) {
      await client.query("ROLLBACK");

      return fail(
        `RGP is currently pending for ${currentApprovalRole} approval.`,
        403,
      );
    }

    // ============================================================
    // Current Stage Must Be Pending
    // ============================================================

    const currentStageStatus =
      String(
        currentStage.status ||
          "Pending",
      )
        .trim()
        .toUpperCase();

    if (
      currentStageStatus !==
      "PENDING"
    ) {
      await client.query("ROLLBACK");

      return fail(
        `${currentApprovalRole} approval is already ${currentStageStatus}.`,
        400,
      );
    }

    // ============================================================
    // Action Status
    // ============================================================

    const newStatus =
      Action === "APPROVE"
        ? "Approved"
        : "Rejected";

    // ============================================================
    // Update Current Approval
    // ============================================================

    await client.query(
      `
      UPDATE Gatepass_RGP_Approval

      SET
        Status = $1,

        StatusDateTime =
          CURRENT_TIMESTAMP,

        ActionBy = $2,

        Remarks = $3,

        ModifiedBy = $2,
        ModifiedDate =
          CURRENT_TIMESTAMP

      WHERE RGPApprovalID = $4
        AND RGPID = $5
        AND IsDeleted = FALSE;
      `,
      [
        newStatus,
        UserID,
        Remarks || null,

        currentStage.rgpapprovalid,
        RGPID,
      ],
    );

    // ============================================================
    // REJECT
    // ============================================================

    if (Action === "REJECT") {
      await client.query(
        `
        UPDATE Gatepass_RGP_Entry_Master

        SET
          Status = 'REJECTED',

          ModifiedBy = $1,
          ModifiedDate =
            CURRENT_TIMESTAMP

        WHERE RGPID = $2
          AND IsDeleted = FALSE;
        `,
        [
          UserID,
          RGPID,
        ],
      );

      await client.query("COMMIT");

      return ok(
        "RGP rejected successfully.",
        {
          RGPID:
            Number(RGPID),

          RGPNumber:
            Number(
              master.rgpnumber,
            ),

          ApprovalRole:
            currentApprovalRole,

          Status:
            "REJECTED",
        },
      );
    }

    // ============================================================
    // APPROVE
    //
    // Check Next Pending Stage
    // ============================================================

    const nextStage =
      approvalResult.rows.find(
        (row) =>
          Number(
            row.rgpapprovalid,
          ) !==
            Number(
              currentStage.rgpapprovalid,
            ) &&
          String(
            row.status ||
              "Pending",
          )
            .trim()
            .toUpperCase() !==
            "APPROVED",
      );

    // ============================================================
    // No Next Stage
    // Fully Approved
    // ============================================================

    if (!nextStage) {
      await client.query(
        `
        UPDATE Gatepass_RGP_Entry_Master

        SET
          Status = 'APPROVED',

          ModifiedBy = $1,
          ModifiedDate =
            CURRENT_TIMESTAMP

        WHERE RGPID = $2
          AND IsDeleted = FALSE;
        `,
        [
          UserID,
          RGPID,
        ],
      );

      await client.query("COMMIT");

      return ok(
        "RGP fully approved successfully.",
        {
          RGPID:
            Number(RGPID),

          RGPNumber:
            Number(
              master.rgpnumber,
            ),

          ApprovalRole:
            currentApprovalRole,

          Status:
            "APPROVED",
        },
      );
    }

    // ============================================================
    // Next Approval Pending
    // Master remains PENDING
    // ============================================================

    await client.query(
      `
      UPDATE Gatepass_RGP_Entry_Master

      SET
        Status = 'PENDING',

        ModifiedBy = $1,
        ModifiedDate =
          CURRENT_TIMESTAMP

      WHERE RGPID = $2
        AND IsDeleted = FALSE;
      `,
      [
        UserID,
        RGPID,
      ],
    );

    await client.query("COMMIT");

    return ok(
      "RGP approval processed successfully.",
      {
        RGPID:
          Number(RGPID),

        RGPNumber:
          Number(
            master.rgpnumber,
          ),

        ApprovedByRole:
          currentApprovalRole,

        NextApprovalRole:
          normalizeRGPApprovalRole(
            nextStage.approvalrole,
          ),

        Status:
          "PENDING",
      },
    );
  } catch (error) {
    await client.query(
      "ROLLBACK",
    );

    return databaseFailure(
      error,
      "Process RGP approval",
    );
  } finally {
    client.release();
  }
};
// ============================================================PROCESS RGP GATE ACTION,CHECKOUT / CANCEL
const processRGPGateAction = async (data) => {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const {
      RGPID,
      Action,
      Remarks,
      UserID,
    } = data;

    // ============================================================
    // Validate RGP ID
    // ============================================================

    const rgpID =
      Number(RGPID);

    if (
      !Number.isSafeInteger(rgpID) ||
      rgpID <= 0
    ) {
      await client.query("ROLLBACK");

      return fail(
        "Valid RGPID is required.",
        400,
      );
    }

    // ============================================================
    // Validate Action
    // ============================================================

    const action = String(
      Action || "",
    )
      .trim()
      .toUpperCase();

    if (
      ![
        "CHECKOUT",
        "CANCEL",
      ].includes(action)
    ) {
      await client.query("ROLLBACK");

      return fail(
        "Action must be CHECKOUT or CANCEL.",
        400,
      );
    }

    // ============================================================
    // Lock RGP
    // ============================================================

    const result =
      await client.query(
        `
        SELECT
          RGPID,
          RGPNumber,
          OrganizationID,
          Status,

          CheckoutDateTime,
          CheckoutBy,

          CancelledBy,
          CancelledDateTime

        FROM Gatepass_RGP_Entry_Master

        WHERE RGPID = $1
          AND IsDeleted = FALSE

        FOR UPDATE;
        `,
        [
          rgpID,
        ],
      );

    // ============================================================
    // Not Found
    // ============================================================

    if (
      result.rows.length === 0
    ) {
      await client.query("ROLLBACK");

      return fail(
        "RGP record not found.",
        404,
      );
    }

    const row =
      result.rows[0];

    const currentStatus =
      String(
        row.status || "",
      )
        .trim()
        .toUpperCase();

    // ============================================================
    // Already Checkout
    // ============================================================

    if (
      currentStatus ===
      "CHECKED OUT"
    ) {
      await client.query("ROLLBACK");

      return fail(
        "RGP has already been checked out.",
        400,
      );
    }

    // ============================================================
    // Already Cancelled
    // ============================================================

    if (
      currentStatus ===
      "CANCELLED"
    ) {
      await client.query("ROLLBACK");

      return fail(
        "RGP has already been cancelled.",
        400,
      );
    }

    // ============================================================
    // Rejected
    // ============================================================

    if (
      currentStatus ===
      "REJECTED"
    ) {
      await client.query("ROLLBACK");

      return fail(
        "Rejected RGP cannot be checked out or cancelled.",
        400,
      );
    }

    // ============================================================
    // Return Already Started / Completed
    // ============================================================

    if (
      [
        "RETURN PENDING",
        "RETURNED",
      ].includes(currentStatus)
    ) {
      await client.query("ROLLBACK");

      return fail(
        "Gate action cannot be performed after RGP return has started.",
        400,
      );
    }

    // ============================================================
    // Must Be Fully Approved
    // ============================================================

    if (
      currentStatus !==
      "APPROVED"
    ) {
      await client.query("ROLLBACK");

      return fail(
        "RGP must be fully approved before Checkout or Cancel.",
        400,
      );
    }

    // ============================================================
    // Extra Approval Safety Check
    //
    // Master APPROVED ke saath saari active approval rows
    // bhi Approved honi chahiye.
    // ============================================================

    const pendingApprovalResult =
      await client.query(
        `
        SELECT COUNT(*)::INT AS PendingCount

        FROM Gatepass_RGP_Approval

        WHERE RGPID = $1
          AND IsDeleted = FALSE
          AND UPPER(
                COALESCE(Status, 'Pending')
              ) <> 'APPROVED';
        `,
        [
          rgpID,
        ],
      );

    const pendingApprovalCount =
      Number(
        pendingApprovalResult
          .rows[0]
          .pendingcount,
      );

    if (
      pendingApprovalCount > 0
    ) {
      await client.query("ROLLBACK");

      return fail(
        "RGP approval is not completed.",
        400,
      );
    }

    // ============================================================
    // CHECKOUT
    // ============================================================

    if (
      action === "CHECKOUT"
    ) {
      await client.query(
        `
        UPDATE Gatepass_RGP_Entry_Master

        SET
          Status = 'CHECKED OUT',

          CheckoutDateTime =
            CURRENT_TIMESTAMP,

          CheckoutBy = $1,

          CheckoutRemarks = $2,

          ModifiedBy = $1,
          ModifiedDate =
            CURRENT_TIMESTAMP

        WHERE RGPID = $3
          AND IsDeleted = FALSE;
        `,
        [
          UserID,
          Remarks || null,
          rgpID,
        ],
      );

      await client.query(
        "COMMIT",
      );

      return ok(
        "RGP checked out successfully.",
        {
          RGPID:
            rgpID,

          RGPNumber:
            Number(
              row.rgpnumber,
            ),

          Status:
            "CHECKED OUT",
        },
      );
    }

    // ============================================================
    // CANCEL
    // ============================================================

    await client.query(
      `
      UPDATE Gatepass_RGP_Entry_Master

      SET
        Status = 'CANCELLED',

        CancelledBy = $1,

        CancelledDateTime =
          CURRENT_TIMESTAMP,

        CancelRemarks = $2,

        ModifiedBy = $1,
        ModifiedDate =
          CURRENT_TIMESTAMP

      WHERE RGPID = $3
        AND IsDeleted = FALSE;
      `,
      [
        UserID,
        Remarks,
        rgpID,
      ],
    );

    await client.query(
      "COMMIT",
    );

    return ok(
      "RGP cancelled successfully.",
      {
        RGPID:
          rgpID,

        RGPNumber:
          Number(
            row.rgpnumber,
          ),

        Status:
          "CANCELLED",
      },
    );
  } catch (error) {
    await client.query(
      "ROLLBACK",
    );

    return databaseFailure(
      error,
      "Process RGP gate action",
    );
  } finally {
    client.release();
  }
};
// ============================================================PROCESS RGP ITEM RETURN
const processRGPItemReturn = async (data) => {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const {
      RGPID,
      Items,
      Remarks,
      UserID,
    } = data;

    const rgpID =
      Number(RGPID);

    // ============================================================
    // Validate RGP ID
    // ============================================================

    if (
      !Number.isSafeInteger(rgpID) ||
      rgpID <= 0
    ) {
      await client.query("ROLLBACK");

      return fail(
        "Valid RGPID is required.",
        400,
      );
    }

    // ============================================================
    // Validate Items
    // ============================================================

    if (
      !Array.isArray(Items) ||
      Items.length === 0
    ) {
      await client.query("ROLLBACK");

      return fail(
        "At least one return item is required.",
        400,
      );
    }

    // ============================================================
    // Lock RGP Master
    // ============================================================

    const masterResult =
      await client.query(
        `
        SELECT
          RGPID,
          RGPNumber,
          OrganizationID,
          Status

        FROM Gatepass_RGP_Entry_Master

        WHERE RGPID = $1
          AND IsDeleted = FALSE

        FOR UPDATE;
        `,
        [
          rgpID,
        ],
      );

    // ============================================================
    // Not Found
    // ============================================================

    if (
      masterResult.rows.length === 0
    ) {
      await client.query("ROLLBACK");

      return fail(
        "RGP record not found.",
        404,
      );
    }

    const master =
      masterResult.rows[0];

    const organizationID =
      Number(
        master.organizationid,
      );

    const currentStatus =
      String(
        master.status || "",
      )
        .trim()
        .toUpperCase();

    // ============================================================
    // Return Allowed Status
    // ============================================================

    if (
      ![
        "CHECKED OUT",
        "RETURN PENDING",
      ].includes(currentStatus)
    ) {
      await client.query("ROLLBACK");

      return fail(
        "RGP items can be returned only after Checkout.",
        400,
      );
    }

    // ============================================================
    // Process Every Returned Item
    // ============================================================

    for (
      let index = 0;
      index < Items.length;
      index++
    ) {
      const item =
        Items[index];

      const rgpItemID =
        Number(
          item.RGPItemID,
        );

      const quantityReceived =
        Number(
          item.QuantityReceived,
        );

      // ==========================================================
      // Validate Item
      // ==========================================================

      if (
        !Number.isSafeInteger(rgpItemID) ||
        rgpItemID <= 0
      ) {
        await client.query("ROLLBACK");

        return fail(
          `Valid RGPItemID is required for item ${index + 1}.`,
          400,
        );
      }

      if (
        !Number.isFinite(quantityReceived) ||
        quantityReceived <= 0
      ) {
        await client.query("ROLLBACK");

        return fail(
          `QuantityReceived must be greater than 0 for item ${index + 1}.`,
          400,
        );
      }

      // ==========================================================
      // Lock Item
      // ==========================================================

      const itemResult =
        await client.query(
          `
          SELECT
            RGPItemID,
            RGPID,
            OrganizationID,

            ItemName,

            Quantity,
            ReturnedQuantity,
            RemainingQuantity,
            IsReturned

          FROM Gatepass_RGP_Entry_Item_Details

          WHERE RGPItemID = $1
            AND RGPID = $2
            AND IsDeleted = FALSE

          FOR UPDATE;
          `,
          [
            rgpItemID,
            rgpID,
          ],
        );

      // ==========================================================
      // Item Not Found
      // ==========================================================

      if (
        itemResult.rows.length === 0
      ) {
        await client.query("ROLLBACK");

        return fail(
          `RGP item ${rgpItemID} not found.`,
          404,
        );
      }

      const existingItem =
        itemResult.rows[0];

      const totalQuantity =
        Number(
          existingItem.quantity,
        );

      const returnedQuantity =
        Number(
          existingItem.returnedquantity || 0,
        );

      const remainingQuantity =
        Number(
          existingItem.remainingquantity,
        );

      // ==========================================================
      // Already Fully Returned
      // ==========================================================

      if (
        Boolean(
          existingItem.isreturned,
        ) ||
        remainingQuantity <= 0
      ) {
        await client.query("ROLLBACK");

        return fail(
          `${existingItem.itemname} is already fully returned.`,
          400,
        );
      }

      // ==========================================================
      // Cannot Receive More Than Remaining
      // ==========================================================

      if (
        quantityReceived >
        remainingQuantity
      ) {
        await client.query("ROLLBACK");

        return fail(
          `QuantityReceived for ${existingItem.itemname} cannot exceed remaining quantity ${remainingQuantity}.`,
          400,
        );
      }

      // ==========================================================
      // Calculate New Quantity
      // ==========================================================

      const newReturnedQuantity =
        returnedQuantity +
        quantityReceived;

      const newRemainingQuantity =
        totalQuantity -
        newReturnedQuantity;

      const isReturned =
        newRemainingQuantity <= 0;

      // ==========================================================
      // Update Item
      // ==========================================================

      await client.query(
        `
        UPDATE Gatepass_RGP_Entry_Item_Details

        SET
          ReturnedQuantity = $1,
          RemainingQuantity = $2,
          IsReturned = $3,

          ModifiedBy = $4,
          ModifiedDate =
            CURRENT_TIMESTAMP

        WHERE RGPItemID = $5
          AND RGPID = $6
          AND IsDeleted = FALSE;
        `,
        [
          newReturnedQuantity,
          newRemainingQuantity,
          isReturned,

          UserID,

          rgpItemID,
          rgpID,
        ],
      );

      // ==========================================================
      // Insert Return History
      // ==========================================================

      await client.query(
        `
        INSERT INTO Gatepass_RGP_Item_Return_Details
        (
          RGPID,
          RGPItemID,
          OrganizationID,

          QuantityReceived,
          RemainingQuantity,

          ReturnDateTime,
          ReturnBy,

          Remarks,

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

          CURRENT_TIMESTAMP,
          $6,

          $7,

          FALSE,

          $6,
          CURRENT_TIMESTAMP
        );
        `,
        [
          rgpID,
          rgpItemID,
          organizationID,

          quantityReceived,
          newRemainingQuantity,

          UserID,

          item.Remarks || null,
        ],
      );
    }

    // ============================================================
    // Check Overall RGP Remaining Quantity
    // ============================================================

    const remainingResult =
      await client.query(
        `
        SELECT
          COUNT(*)::INT AS RemainingItemCount

        FROM Gatepass_RGP_Entry_Item_Details

        WHERE RGPID = $1
          AND IsDeleted = FALSE
          AND COALESCE(
                RemainingQuantity,
                0
              ) > 0;
        `,
        [
          rgpID,
        ],
      );

    const remainingItemCount =
      Number(
        remainingResult
          .rows[0]
          .remainingitemcount,
      );

    // ============================================================
    // All Items Returned
    // ============================================================

    if (
      remainingItemCount === 0
    ) {
      await client.query(
        `
        UPDATE Gatepass_RGP_Entry_Master

        SET
          Status = 'RETURNED',

          ReturnedBy = $1,
          ReturnedDateTime =
            CURRENT_TIMESTAMP,

          ReturnRemarks = $2,

          ModifiedBy = $1,
          ModifiedDate =
            CURRENT_TIMESTAMP

        WHERE RGPID = $3
          AND IsDeleted = FALSE;
        `,
        [
          UserID,
          Remarks || null,
          rgpID,
        ],
      );

      await client.query(
        "COMMIT",
      );

      return ok(
        "RGP items returned successfully. All items have been returned.",
        {
          RGPID:
            rgpID,

          RGPNumber:
            Number(
              master.rgpnumber,
            ),

          Status:
            "RETURNED",

          RemainingItemCount:
            0,
        },
      );
    }

    // ============================================================
    // Partial Return
    // ============================================================

    await client.query(
      `
      UPDATE Gatepass_RGP_Entry_Master

      SET
        Status = 'RETURN PENDING',

        ModifiedBy = $1,
        ModifiedDate =
          CURRENT_TIMESTAMP

      WHERE RGPID = $2
        AND IsDeleted = FALSE;
      `,
      [
        UserID,
        rgpID,
      ],
    );

    await client.query(
      "COMMIT",
    );

    return ok(
      "RGP items returned successfully. Some items are still pending.",
      {
        RGPID:
          rgpID,

        RGPNumber:
          Number(
            master.rgpnumber,
          ),

        Status:
          "RETURN PENDING",

        RemainingItemCount:
          remainingItemCount,
      },
    );
  } catch (error) {
    await client.query(
      "ROLLBACK",
    );

    return databaseFailure(
      error,
      "Process RGP item return",
    );
  } finally {
    client.release();
  }
};
// ============================================================GET RGP APPROVAL CONFIG
const getRGPApprovalConfig = async (data) => {
  try {
    const OrganizationID =
      Number(data.OrganizationID);

    // ============================================================
    // Validate Organization
    // ============================================================

    if (
      !Number.isSafeInteger(OrganizationID) ||
      OrganizationID <= 0
    ) {
      return fail(
        "Valid OrganizationID is required.",
        400,
      );
    }

    // ============================================================
    // Organization Check
    // ============================================================

    const organizationResult =
      await pool.query(
        `
        SELECT
          OrganizationID

        FROM Organization_Master

        WHERE OrganizationID = $1

        LIMIT 1;
        `,
        [
          OrganizationID,
        ],
      );

    if (
      organizationResult.rows.length === 0
    ) {
      return fail(
        "Organization not found.",
        404,
      );
    }

    // ============================================================
    // Get Custom Approval Config
    // ============================================================

    const result =
      await pool.query(
        `
        SELECT
          RGPApprovalConfigID,
          OrganizationID,
          ApprovalLevel,
          ApprovalRole,
          ApprovalOrder,
          IsMandatory

        FROM Gatepass_RGP_Approval_Config

        WHERE OrganizationID = $1
          AND IsDeleted = FALSE

        ORDER BY
          ApprovalOrder ASC,
          ApprovalLevel ASC,
          RGPApprovalConfigID ASC;
        `,
        [
          OrganizationID,
        ],
      );

    // ============================================================
    // Custom Configuration Available
    // ============================================================

    if (
      result.rows.length > 0
    ) {
      const approvalFlow =
        result.rows.map(
          (row) => ({
            RGPApprovalConfigID:
              Number(
                row.rgpapprovalconfigid,
              ),

            ApprovalLevel:
              Number(
                row.approvallevel,
              ),

            ApprovalRole:
              normalizeRGPApprovalRole(
                row.approvalrole,
              ),

            ApprovalOrder:
              Number(
                row.approvalorder,
              ),

            IsMandatory:
              Boolean(
                row.ismandatory,
              ),
          }),
        );

      return ok(
        "RGP approval configuration fetched successfully.",
        {
          OrganizationID,

          IsDefault:
            false,

          ApprovalFlow:
            approvalFlow,
        },
      );
    }

    // ============================================================
    // No Custom Config
    // Return Default HOD -> FC -> GM
    // ============================================================

    const defaultFlow =
      DEFAULT_RGP_APPROVALS.map(
        (item, index) => ({
          RGPApprovalConfigID:
            null,

          ApprovalLevel:
            item.LevelNo,

          ApprovalRole:
            item.ApprovalRole,

          ApprovalOrder:
            index + 1,

          IsMandatory:
            true,
        }),
      );

    return ok(
      "Default RGP approval configuration fetched successfully.",
      {
        OrganizationID,

        IsDefault:
          true,

        ApprovalFlow:
          defaultFlow,
      },
    );
  } catch (error) {
    return databaseFailure(
      error,
      "Get RGP approval configuration",
    );
  }
};
// ============================================================SAVE RGP APPROVAL CONFIG
const saveRGPApprovalConfig = async (data) => {
  const client =
    await pool.connect();

  try {
    await client.query(
      "BEGIN",
    );

    const {
      OrganizationID,
      ApprovalFlow,
      UserID,
    } = data;

    const organizationID =
      Number(
        OrganizationID,
      );

    // ============================================================
    // Validate Organization
    // ============================================================

    if (
      !Number.isSafeInteger(
        organizationID,
      ) ||
      organizationID <= 0
    ) {
      await client.query(
        "ROLLBACK",
      );

      return fail(
        "Valid OrganizationID is required.",
        400,
      );
    }

    // ============================================================
    // Validate Approval Flow
    // ============================================================

    if (
      !Array.isArray(
        ApprovalFlow,
      ) ||
      ApprovalFlow.length === 0
    ) {
      await client.query(
        "ROLLBACK",
      );

      return fail(
        "ApprovalFlow must contain at least one approval level.",
        400,
      );
    }

    // ============================================================
    // Organization Check
    // ============================================================

    const organizationResult =
      await client.query(
        `
        SELECT
          OrganizationID

        FROM Organization_Master

        WHERE OrganizationID = $1

        LIMIT 1
        FOR UPDATE;
        `,
        [
          organizationID,
        ],
      );

    if (
      organizationResult.rows.length === 0
    ) {
      await client.query(
        "ROLLBACK",
      );

      return fail(
        "Organization not found.",
        404,
      );
    }

    // ============================================================
    // Normalize + Validate Again
    // ============================================================

    const normalizedFlow = [];

    for (
      let index = 0;
      index < ApprovalFlow.length;
      index++
    ) {
      const item =
        ApprovalFlow[index];

      const approvalLevel =
        Number(
          item.ApprovalLevel,
        );

      const approvalOrder =
        Number(
          item.ApprovalOrder,
        );

      const approvalRole =
        normalizeRGPApprovalRole(
          item.ApprovalRole,
        );

      if (
        !Number.isInteger(
          approvalLevel,
        ) ||
        approvalLevel <= 0
      ) {
        await client.query(
          "ROLLBACK",
        );

        return fail(
          `Valid ApprovalLevel is required for approval ${index + 1}.`,
          400,
        );
      }

      if (
        !Number.isInteger(
          approvalOrder,
        ) ||
        approvalOrder <= 0
      ) {
        await client.query(
          "ROLLBACK",
        );

        return fail(
          `Valid ApprovalOrder is required for approval ${index + 1}.`,
          400,
        );
      }

      if (!approvalRole) {
        await client.query(
          "ROLLBACK",
        );

        return fail(
          `ApprovalRole is required for approval ${index + 1}.`,
          400,
        );
      }

      normalizedFlow.push({
        ApprovalLevel:
          approvalLevel,

        ApprovalRole:
          approvalRole,

        ApprovalOrder:
          approvalOrder,

        IsMandatory:
          item.IsMandatory !== false,
      });
    }

    // ============================================================
    // Duplicate Order Check
    // ============================================================

    const orders =
      normalizedFlow.map(
        (item) =>
          item.ApprovalOrder,
      );

    if (
      new Set(orders).size !==
      orders.length
    ) {
      await client.query(
        "ROLLBACK",
      );

      return fail(
        "Duplicate ApprovalOrder is not allowed.",
        400,
      );
    }

    // ============================================================
    // Duplicate Level Check
    // ============================================================

    const levels =
      normalizedFlow.map(
        (item) =>
          item.ApprovalLevel,
      );

    if (
      new Set(levels).size !==
      levels.length
    ) {
      await client.query(
        "ROLLBACK",
      );

      return fail(
        "Duplicate ApprovalLevel is not allowed.",
        400,
      );
    }

    // ============================================================
    // Reuse one existing row per order; prefer active rows, then the latest deleted row.
    const existingConfig = await client.query(
      `SELECT RGPApprovalConfigID, ApprovalOrder, IsDeleted
       FROM Gatepass_RGP_Approval_Config
       WHERE OrganizationID = $1
       ORDER BY IsDeleted ASC, RGPApprovalConfigID DESC
       FOR UPDATE;`, [organizationID],
    );
    const existingByOrder = new Map();
    for (const row of existingConfig.rows) {
      const order = Number(row.approvalorder);
      if (!existingByOrder.has(order)) existingByOrder.set(order, row);
    }
    await client.query(
      `UPDATE Gatepass_RGP_Approval_Config
       SET IsDeleted = TRUE, DeletedBy = $1, DeletedDate = CURRENT_TIMESTAMP,
           ModifiedBy = $1, ModifiedDate = CURRENT_TIMESTAMP
       WHERE OrganizationID = $2 AND IsDeleted = FALSE
         AND NOT (ApprovalOrder = ANY($3::INT[]));`,
      [UserID, organizationID, orders],
    );
    const savedFlow = [];
    const sortedFlow = [...normalizedFlow].sort((a, b) => a.ApprovalOrder - b.ApprovalOrder);
    for (const item of sortedFlow) {
      const existing = existingByOrder.get(item.ApprovalOrder);
      const result = existing
        ? await client.query(
            `UPDATE Gatepass_RGP_Approval_Config
             SET ApprovalLevel = $1, ApprovalRole = $2, IsMandatory = $3,
                 IsDeleted = FALSE, DeletedBy = NULL, DeletedDate = NULL,
                 ModifiedBy = $4, ModifiedDate = CURRENT_TIMESTAMP
             WHERE RGPApprovalConfigID = $5 AND OrganizationID = $6
             RETURNING RGPApprovalConfigID, OrganizationID, ApprovalLevel,
                       ApprovalRole, ApprovalOrder, IsMandatory;`,
            [item.ApprovalLevel, item.ApprovalRole, item.IsMandatory,
             UserID, existing.rgpapprovalconfigid, organizationID],
          )
        : await client.query(
          `
          INSERT INTO Gatepass_RGP_Approval_Config
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

          RETURNING
            RGPApprovalConfigID,
            OrganizationID,
            ApprovalLevel,
            ApprovalRole,
            ApprovalOrder,
            IsMandatory;
          `,
          [
            organizationID,

            item.ApprovalLevel,
            item.ApprovalRole,
            item.ApprovalOrder,

            item.IsMandatory,

            UserID,
          ],
        );

      const row =
        result.rows[0];

      savedFlow.push({
        RGPApprovalConfigID:
          Number(
            row.rgpapprovalconfigid,
          ),

        OrganizationID:
          Number(
            row.organizationid,
          ),

        ApprovalLevel:
          Number(
            row.approvallevel,
          ),

        ApprovalRole:
          row.approvalrole,

        ApprovalOrder:
          Number(
            row.approvalorder,
          ),

        IsMandatory:
          Boolean(
            row.ismandatory,
          ),
      });
    }

    await client.query(
      "COMMIT",
    );

    return ok(
      "RGP approval configuration saved successfully."
    );
  } catch (error) {
    await client.query(
      "ROLLBACK",
    );

    return databaseFailure(
      error,
      "Save RGP approval configuration",
    );
  } finally {
    client.release();
  }
};
// ============================================================DELETE RGP APPROVAL CONFIG
const deleteRGPApprovalConfig = async (data) => {
  const client =
    await pool.connect();

  try {
    await client.query(
      "BEGIN",
    );

    const {
      RGPApprovalConfigID,
      UserID,
    } = data;

    const configID =
      Number(
        RGPApprovalConfigID,
      );

    if (
      !Number.isSafeInteger(
        configID,
      ) ||
      configID <= 0
    ) {
      await client.query(
        "ROLLBACK",
      );

      return fail(
        "Valid RGPApprovalConfigID is required.",
        400,
      );
    }

    // ============================================================
    // Lock Existing Custom Config
    // ============================================================

    const existingResult =
      await client.query(
        `
        SELECT
          RGPApprovalConfigID

        FROM Gatepass_RGP_Approval_Config

        WHERE RGPApprovalConfigID = $1
          AND IsDeleted = FALSE

        FOR UPDATE;
        `,
        [
          configID,
        ],
      );

    if (
      existingResult.rows.length === 0
    ) {
      await client.query(
        "ROLLBACK",
      );

      return fail(
        "Custom RGP approval configuration not found.",
        404,
      );
    }

    // ============================================================
    // Soft Delete
    // ============================================================

    await client.query(
      `
      UPDATE Gatepass_RGP_Approval_Config

      SET
        IsDeleted = TRUE,

        DeletedBy = $1,
        DeletedDate =
          CURRENT_TIMESTAMP,

        ModifiedBy = $1,
        ModifiedDate =
          CURRENT_TIMESTAMP

      WHERE RGPApprovalConfigID = $2
        AND IsDeleted = FALSE;
      `,
      [
        UserID,
        configID,
      ],
    );

    await client.query(
      "COMMIT",
    );

    return ok(
      "RGP approval configuration row deleted successfully.",
      { RGPApprovalConfigID: configID },
    );
  } catch (error) {
    await client.query(
      "ROLLBACK",
    );

    return databaseFailure(
      error,
      "Delete RGP approval configuration",
    );
  } finally {
    client.release();
  }
};
// ========================================================================Reports
// ============================================================RGP List Report
// | Old Filter | New RGP me condition |
// |---|---|
// | **All RGP Open** | `PENDING` ya `APPROVED` |
// | **All RGP Out** | `CHECKED OUT` ya `RETURN PENDING` |
// | **All RGP Closed** | `RETURNED` |
// | **All RGP Cancelled** | `CANCELLED` ya `REJECTED` |
// | **All RGP Overdue** | Expected Return Date nikal chuki ho aur RGP abhi bahar ho |
const getRGPListReport = async (data) => {
  try {
    const page = Number(data.page) || 1;
    const pageSize = Math.min(
      Number(data.PageSize) || 10,
      100,
    );

    const offset = (page - 1) * pageSize;

    const values = [];
    const conditions = [
      "m.IsDeleted = FALSE",
    ];

    // ============================================================
    // Organization Filter
    // ============================================================

    if (data.OrganizationID) {
      values.push(data.OrganizationID);

      conditions.push(
        `m.OrganizationID = $${values.length}`,
      );
    }

    // ============================================================
    // From Date
    // ============================================================

    if (data.FromDate) {
      values.push(data.FromDate);

      conditions.push(
        `m.CreatedDate::DATE >= $${values.length}::DATE`,
      );
    }

    // ============================================================
    // To Date
    // ============================================================

    if (data.ToDate) {
      values.push(data.ToDate);

      conditions.push(
        `m.CreatedDate::DATE <= $${values.length}::DATE`,
      );
    }

    // ============================================================
    // Department Filter
    // ============================================================

    if (data.DepartmentID) {
      values.push(data.DepartmentID);

      conditions.push(
        `m.DepartmentID = $${values.length}`,
      );
    }

    // ============================================================
    // RGP Status Report Filter
    // ============================================================

    const reportStatus =
      String(data.Status || "").trim();

    switch (reportStatus) {
      case "All RGP Open":
        conditions.push(`
          UPPER(m.Status) IN (
            'PENDING',
            'APPROVED'
          )
        `);
        break;

      case "All RGP Out":
        conditions.push(`
          UPPER(m.Status) IN (
            'CHECKED OUT',
            'RETURN PENDING'
          )
        `);
        break;

      case "All RGP Closed":
        conditions.push(`
          UPPER(m.Status) = 'RETURNED'
        `);
        break;

      case "All RGP Cancelled":
        conditions.push(`
          UPPER(m.Status) IN (
            'CANCELLED',
            'REJECTED'
          )
        `);
        break;

      case "All RGP Overdue":
        conditions.push(`
          m.ExpectedReturnDate <
            (CURRENT_DATE - INTERVAL '30 days')

          AND UPPER(m.Status) IN (
            'CHECKED OUT',
            'RETURN PENDING'
          )
        `);
        break;
    }

    // ============================================================
    // RGP Number Filter
    // ============================================================

    if (data.RGPNumber) {
      values.push(data.RGPNumber);

      conditions.push(
        `m.RGPNumber = $${values.length}`,
      );
    }

    // ============================================================
    // Vendor Filter
    // ============================================================

    if (data.VendorName) {
      values.push(
        `%${String(data.VendorName).trim()}%`,
      );

      conditions.push(
        `m.VendorName ILIKE $${values.length}`,
      );
    }

    // ============================================================
    // Search
    // ============================================================

    if (data.Search) {
      values.push(
        `%${String(data.Search).trim()}%`,
      );

      const searchIndex = values.length;

      conditions.push(`
        (
          CAST(m.RGPNumber AS TEXT)
            ILIKE $${searchIndex}

          OR m.VendorName
            ILIKE $${searchIndex}

          OR m.Company
            ILIKE $${searchIndex}

          OR m.ContactNumber
            ILIKE $${searchIndex}

          OR m.TakenBy
            ILIKE $${searchIndex}

          OR d.DepartmentName
            ILIKE $${searchIndex}

          OR EXISTS (
            SELECT 1
            FROM Gatepass_RGP_Entry_Item_Details si
            WHERE si.RGPID = m.RGPID
              AND si.IsDeleted = FALSE
              AND si.ItemName
                ILIKE $${searchIndex}
          )
        )
      `);
    }

    const whereClause =
      conditions.length
        ? `WHERE ${conditions.join(" AND ")}`
        : "";

    // ============================================================
    // Total Count
    // ============================================================

    const countResult =
      await pool.query(
        `
        SELECT
          COUNT(*)::BIGINT AS TotalCount

        FROM Gatepass_RGP_Entry_Master m

        LEFT JOIN department_master d
          ON d.DepartmentID =
            m.DepartmentID

        ${whereClause};
        `,
        values,
      );

    const totalCount =
      Number(
        countResult.rows[0]?.totalcount || 0,
      );

    // ============================================================
    // Pagination
    // ============================================================

    const listValues = [...values];

    listValues.push(pageSize);
    const limitIndex = listValues.length;

    listValues.push(offset);
    const offsetIndex = listValues.length;

    // ============================================================
    // Report Data
    // Paginate RGP masters before attaching their items and approvals
    // ============================================================

    const result =
      await pool.query(
        `
        SELECT
          m.RGPID,
          m.RGPNumber,

          m.OrganizationID,

          m.VendorName,
          m.ContactNumber,
          m.Company,

          m.ExpectedReturnDate,

          m.DepartmentID,
          d.DepartmentName,

          m.TakenBy,

          m.Status,

          m.CreatedDate

        FROM Gatepass_RGP_Entry_Master m

        LEFT JOIN department_master d
          ON d.DepartmentID =
            m.DepartmentID

${whereClause}

        ORDER BY
          m.CreatedDate DESC,
          m.RGPID DESC

        LIMIT $${limitIndex}
        OFFSET $${offsetIndex};
        `,
        listValues,
      );

    const relatedRecords = await attachRGPRelatedData(result.rows);
    const reportData = result.rows.map((row, index) => ({
      ...row,
      expectedreturndate: formatDate(row.expectedreturndate),
      createddate: formatDate(row.createddate),
      Items: relatedRecords[index].Items,
      Approvals: relatedRecords[index].Approvals,
    }));

    return ok(
      "RGP list report fetched successfully.",
      reportData,
      {
        TotalCount: totalCount,
        Page: page,
        PageSize: pageSize,
        TotalPages:
          Math.ceil(
            totalCount / pageSize,
          ),
      },
    );
  } catch (error) {
    return databaseFailure(
      error,
      "Fetch RGP list report",
    );
  }
};
// ============================================================Department Wise Report
const getRGPDepartmentWiseReport = async (data) => {
  try {
    const page = Number(data.page) || 1;

    const pageSize = Math.min(
      Number(data.PageSize) || 10,
      100,
    );

    const offset =
      (page - 1) * pageSize;

    const values = [];

    const conditions = [
      "m.IsDeleted = FALSE",
    ];

    // ============================================================
    // Organization Filter
    // ============================================================

    if (data.OrganizationID) {
      values.push(
        data.OrganizationID,
      );

      conditions.push(
        `m.OrganizationID = $${values.length}`,
      );
    }

    // ============================================================
    // From Date
    // ============================================================

    if (data.FromDate) {
      values.push(
        data.FromDate,
      );

      conditions.push(
        `m.CreatedDate::DATE >= $${values.length}::DATE`,
      );
    }

    // ============================================================
    // To Date
    // ============================================================

    if (data.ToDate) {
      values.push(
        data.ToDate,
      );

      conditions.push(
        `m.CreatedDate::DATE <= $${values.length}::DATE`,
      );
    }

    // ============================================================
    // Department Filter
    // ============================================================

    if (data.DepartmentID) {
      values.push(
        data.DepartmentID,
      );

      conditions.push(
        `m.DepartmentID = $${values.length}`,
      );
    }

    // ============================================================
    // Search Department
    // ============================================================

    if (data.Search) {
      values.push(
        `%${String(data.Search).trim()}%`,
      );

      conditions.push(
        `d.DepartmentName ILIKE $${values.length}`,
      );
    }

    const whereClause =
      `WHERE ${conditions.join(" AND ")}`;

    // ============================================================
    // Count Departments
    // ============================================================

    const countResult =
      await pool.query(
        `
        SELECT
          COUNT(
            DISTINCT m.DepartmentID
          )::BIGINT AS TotalCount

        FROM Gatepass_RGP_Entry_Master m

        LEFT JOIN department_master d
          ON d.DepartmentID =
            m.DepartmentID

        ${whereClause};
        `,
        values,
      );

    const totalCount =
      Number(
        countResult.rows[0]
          ?.totalcount || 0,
      );

    // ============================================================
    // Pagination
    // ============================================================

    const reportValues = [
      ...values,
    ];

    reportValues.push(
      pageSize,
    );

    const limitIndex =
      reportValues.length;

    reportValues.push(
      offset,
    );

    const offsetIndex =
      reportValues.length;

    // ============================================================
    // Department Wise Report
    // ============================================================

    const result =
      await pool.query(
        `
        SELECT
          m.DepartmentID,

          COALESCE(
            d.DepartmentName,
            'Unknown'
          ) AS DepartmentName,

          COUNT(
            DISTINCT m.RGPID
          )::BIGINT AS TotalRGP,

          COUNT(
            DISTINCT m.RGPID
          ) FILTER (
            WHERE UPPER(m.Status)
              IN (
                'PENDING',
                'APPROVED'
              )
          )::BIGINT AS OpenRGP,

          COUNT(
            DISTINCT m.RGPID
          ) FILTER (
            WHERE UPPER(m.Status)
              IN (
                'CHECKED OUT',
                'RETURN PENDING'
              )
          )::BIGINT AS OutRGP,

          COUNT(
            DISTINCT m.RGPID
          ) FILTER (
            WHERE UPPER(m.Status)
              = 'RETURNED'
          )::BIGINT AS ClosedRGP,

          COUNT(
            DISTINCT m.RGPID
          ) FILTER (
            WHERE UPPER(m.Status)
              IN (
                'CANCELLED',
                'REJECTED'
              )
          )::BIGINT AS CancelledRGP,

          COUNT(
            DISTINCT m.RGPID
          ) FILTER (
            WHERE
              m.ExpectedReturnDate <
                (
                  CURRENT_DATE -
                  INTERVAL '30 days'
                )

              AND UPPER(m.Status)
                IN (
                  'CHECKED OUT',
                  'RETURN PENDING'
                )
          )::BIGINT AS OverdueRGP

        FROM Gatepass_RGP_Entry_Master m

        LEFT JOIN department_master d
          ON d.DepartmentID =
            m.DepartmentID

        ${whereClause}

        GROUP BY
          m.DepartmentID,
          d.DepartmentName

        ORDER BY
          TotalRGP DESC,
          d.DepartmentName ASC

        LIMIT $${limitIndex}
        OFFSET $${offsetIndex};
        `,
        reportValues,
      );

    const reportData =
      result.rows.map(
        (row) => ({
          DepartmentID:
            Number(
              row.departmentid,
            ),

          DepartmentName:
            row.departmentname,

          TotalRGP:
            Number(
              row.totalrgp,
            ),

          OpenRGP:
            Number(
              row.openrgp,
            ),

          OutRGP:
            Number(
              row.outrgp,
            ),

          ClosedRGP:
            Number(
              row.closedrgp,
            ),

          CancelledRGP:
            Number(
              row.cancelledrgp,
            ),

          OverdueRGP:
            Number(
              row.overduergp,
            ),
        }),
      );

    return ok(
      "RGP department wise report fetched successfully.",
      reportData,
      {
        TotalCount:
          totalCount,

        Page:
          page,

        PageSize:
          pageSize,

        TotalPages:
          Math.ceil(
            totalCount /
              pageSize,
          ),
      },
    );
  } catch (error) {
    return databaseFailure(
      error,
      "Fetch RGP department wise report",
    );
  }
};
// ============================================================RGP Vendor Wise Report
const getRGPVendorWiseReport = async (data) => {
  try {
    const page =
      Number(data.page) || 1;

    const pageSize =
      Math.min(
        Number(data.PageSize) || 10,
        100,
      );

    const offset =
      (page - 1) * pageSize;

    const values = [];

    const conditions = [
      "m.IsDeleted = FALSE",
    ];

    // ============================================================
    // Organization Filter
    // ============================================================

    if (data.OrganizationID) {
      values.push(
        data.OrganizationID,
      );

      conditions.push(
        `m.OrganizationID = $${values.length}`,
      );
    }

    // ============================================================
    // From Date - Created Date
    // ============================================================

    if (data.FromDate) {
      values.push(
        data.FromDate,
      );

      conditions.push(
        `m.CreatedDate::DATE >= $${values.length}::DATE`,
      );
    }

    // ============================================================
    // To Date - Created Date
    // ============================================================

    if (data.ToDate) {
      values.push(
        data.ToDate,
      );

      conditions.push(
        `m.CreatedDate::DATE <= $${values.length}::DATE`,
      );
    }

    // ============================================================
    // Vendor Filter
    // ============================================================

    if (data.VendorName) {
      values.push(
        `%${String(
          data.VendorName,
        ).trim()}%`,
      );

      conditions.push(
        `m.VendorName ILIKE $${values.length}`,
      );
    }

    // ============================================================
    // Search
    // ============================================================

    if (data.Search) {
      values.push(
        `%${String(
          data.Search,
        ).trim()}%`,
      );

      const searchIndex =
        values.length;

      conditions.push(`
        (
          m.VendorName
            ILIKE $${searchIndex}

          OR m.Company
            ILIKE $${searchIndex}
        )
      `);
    }

    const whereClause =
      `WHERE ${conditions.join(
        " AND ",
      )}`;

    // ============================================================
    // Total Vendor Count
    // ============================================================

    const countResult =
      await pool.query(
        `
        SELECT
          COUNT(
            DISTINCT m.VendorName
          )::BIGINT AS TotalCount

        FROM Gatepass_RGP_Entry_Master m

        ${whereClause};
        `,
        values,
      );

    const totalCount =
      Number(
        countResult.rows[0]
          ?.totalcount || 0,
      );

    // ============================================================
    // Pagination
    // ============================================================

    const reportValues = [
      ...values,
    ];

    reportValues.push(
      pageSize,
    );

    const limitIndex =
      reportValues.length;

    reportValues.push(
      offset,
    );

    const offsetIndex =
      reportValues.length;

    // ============================================================
    // Vendor Wise Report
    // ============================================================

    const result =
      await pool.query(
        `
        SELECT
          m.VendorName,

          COUNT(
            DISTINCT m.RGPID
          )::BIGINT AS TotalRGP,

          COUNT(
            DISTINCT m.RGPID
          ) FILTER (
            WHERE UPPER(m.Status)
              IN (
                'PENDING',
                'APPROVED'
              )
          )::BIGINT AS OpenRGP,

          COUNT(
            DISTINCT m.RGPID
          ) FILTER (
            WHERE UPPER(m.Status)
              IN (
                'CHECKED OUT',
                'RETURN PENDING'
              )
          )::BIGINT AS OutRGP,

          COUNT(
            DISTINCT m.RGPID
          ) FILTER (
            WHERE UPPER(m.Status)
              = 'RETURNED'
          )::BIGINT AS ClosedRGP,

          COUNT(
            DISTINCT m.RGPID
          ) FILTER (
            WHERE UPPER(m.Status)
              IN (
                'CANCELLED',
                'REJECTED'
              )
          )::BIGINT AS CancelledRGP,

          COUNT(
            DISTINCT m.RGPID
          ) FILTER (
            WHERE
              m.ExpectedReturnDate <
                (
                  CURRENT_DATE -
                  INTERVAL '30 days'
                )

              AND UPPER(m.Status)
                IN (
                  'CHECKED OUT',
                  'RETURN PENDING'
                )
          )::BIGINT AS OverdueRGP

        FROM Gatepass_RGP_Entry_Master m

        ${whereClause}

        GROUP BY
          m.VendorName

        ORDER BY
          TotalRGP DESC,
          m.VendorName ASC

        LIMIT $${limitIndex}
        OFFSET $${offsetIndex};
        `,
        reportValues,
      );

    const reportData =
      result.rows.map(
        (row) => ({
          VendorName:
            row.vendorname,

          TotalRGP:
            Number(
              row.totalrgp,
            ),

          OpenRGP:
            Number(
              row.openrgp,
            ),

          OutRGP:
            Number(
              row.outrgp,
            ),

          ClosedRGP:
            Number(
              row.closedrgp,
            ),

          CancelledRGP:
            Number(
              row.cancelledrgp,
            ),

          OverdueRGP:
            Number(
              row.overduergp,
            ),
        }),
      );

    return ok(
      "RGP vendor wise report fetched successfully.",
      reportData,
      {
        TotalCount:
          totalCount,

        Page:
          page,

        PageSize:
          pageSize,

        TotalPages:
          Math.ceil(
            totalCount /
              pageSize,
          ),
      },
    );
  } catch (error) {
    return databaseFailure(
      error,
      "Fetch RGP vendor wise report",
    );
  }
};
// ============================================================Pending Return Item Report
const getRGPPendingReturnReport = async (data) => {
  try {
    const page =
      Number(data.page) || 1;

    const pageSize =
      Math.min(
        Number(data.PageSize) || 10,
        100,
      );

    const offset =
      (page - 1) * pageSize;

    const values = [];

    const conditions = [
      "m.IsDeleted = FALSE",
      "i.IsDeleted = FALSE",

      // Only material which is currently outside
      `UPPER(m.Status) IN (
        'CHECKED OUT',
        'RETURN PENDING'
      )`,

      // Only pending items
      "i.RemainingQuantity > 0",
    ];

    // ============================================================
    // Organization Filter
    // ============================================================

    if (data.OrganizationID) {
      values.push(
        data.OrganizationID,
      );

      conditions.push(
        `m.OrganizationID = $${values.length}`,
      );
    }

    // ============================================================
    // From Date - Created Date
    // ============================================================

    if (data.FromDate) {
      values.push(
        data.FromDate,
      );

      conditions.push(
        `m.CreatedDate::DATE >= $${values.length}::DATE`,
      );
    }

    // ============================================================
    // To Date - Created Date
    // ============================================================

    if (data.ToDate) {
      values.push(
        data.ToDate,
      );

      conditions.push(
        `m.CreatedDate::DATE <= $${values.length}::DATE`,
      );
    }

    // ============================================================
    // Department Filter
    // ============================================================

    if (data.DepartmentID) {
      values.push(
        data.DepartmentID,
      );

      conditions.push(
        `m.DepartmentID = $${values.length}`,
      );
    }

    // ============================================================
    // RGP Number Filter
    // ============================================================

    if (data.RGPNumber) {
      values.push(
        data.RGPNumber,
      );

      conditions.push(
        `m.RGPNumber = $${values.length}`,
      );
    }

    // ============================================================
    // Vendor Filter
    // ============================================================

    if (data.VendorName) {
      values.push(
        `%${String(
          data.VendorName,
        ).trim()}%`,
      );

      conditions.push(
        `m.VendorName ILIKE $${values.length}`,
      );
    }

    // ============================================================
    // Search
    // ============================================================

    if (data.Search) {
      values.push(
        `%${String(
          data.Search,
        ).trim()}%`,
      );

      const searchIndex =
        values.length;

      conditions.push(`
        (
          CAST(m.RGPNumber AS TEXT)
            ILIKE $${searchIndex}

          OR m.VendorName
            ILIKE $${searchIndex}

          OR m.Company
            ILIKE $${searchIndex}

          OR d.DepartmentName
            ILIKE $${searchIndex}

          OR i.ItemName
            ILIKE $${searchIndex}

          OR i.MakeModel
            ILIKE $${searchIndex}

          OR i.SerialNumber
            ILIKE $${searchIndex}
        )
      `);
    }

    const whereClause =
      `WHERE ${conditions.join(
        " AND ",
      )}`;

    // ============================================================
    // Total Pending Item Count
    // ============================================================

    const countResult =
      await pool.query(
        `
        SELECT
          COUNT(*)::BIGINT
            AS TotalCount

        FROM Gatepass_RGP_Entry_Master m

        INNER JOIN Gatepass_RGP_Entry_Item_Details i
          ON i.RGPID = m.RGPID
          AND i.IsDeleted = FALSE

        LEFT JOIN department_master d
          ON d.DepartmentID =
            m.DepartmentID

        ${whereClause};
        `,
        values,
      );

    const totalCount =
      Number(
        countResult.rows[0]
          ?.totalcount || 0,
      );

    // ============================================================
    // Pagination
    // ============================================================

    const reportValues = [
      ...values,
    ];

    reportValues.push(
      pageSize,
    );

    const limitIndex =
      reportValues.length;

    reportValues.push(
      offset,
    );

    const offsetIndex =
      reportValues.length;

    // ============================================================
    // Pending Return Report
    // ============================================================

    const result =
      await pool.query(
        `
        SELECT
          m.RGPID,
          m.RGPNumber,

          m.OrganizationID,

          m.ExpectedReturnDate,

          m.VendorName,
          m.ContactNumber,
          m.Company,

          m.DepartmentID,
          d.DepartmentName,

          m.TakenBy,
          m.Status,

          m.CheckoutDateTime,
          m.CheckoutBy,

          m.CreatedDate,

          i.RGPItemID,
          i.ItemName,
          i.Specification,

          i.Quantity,
          i.Unit,
          i.Rate,

          i.MakeModel,
          i.SerialNumber,

          i.ReturnedQuantity,
          i.RemainingQuantity,
          i.IsReturned,

          CASE
            WHEN
              m.ExpectedReturnDate <
                CURRENT_DATE
            THEN
              (
                CURRENT_DATE -
                m.ExpectedReturnDate
              )
            ELSE 0
          END AS OverdueDays,

          CASE
            WHEN
              m.ExpectedReturnDate <
                (
                  CURRENT_DATE -
                  INTERVAL '30 days'
                )
            THEN TRUE
            ELSE FALSE
          END AS IsOverdue

        FROM Gatepass_RGP_Entry_Master m

        INNER JOIN Gatepass_RGP_Entry_Item_Details i
          ON i.RGPID =
            m.RGPID
          AND i.IsDeleted =
            FALSE

        LEFT JOIN department_master d
          ON d.DepartmentID =
            m.DepartmentID

        ${whereClause}

        ORDER BY
          m.ExpectedReturnDate ASC,
          m.RGPNumber DESC,
          i.RGPItemID ASC

        LIMIT $${limitIndex}
        OFFSET $${offsetIndex};
        `,
        reportValues,
      );

    const reportData =
      result.rows.map(
        (row) => ({
          RGPID:
            Number(row.rgpid),

          RGPNumber:
            Number(row.rgpnumber),

          OrganizationID:
            Number(
              row.organizationid,
            ),

          ExpectedReturnDate:
            row.expectedreturndate,

          VendorName:
            row.vendorname,

          ContactNumber:
            row.contactnumber,

          Company:
            row.company,

          DepartmentID:
            Number(
              row.departmentid,
            ),

          DepartmentName:
            row.departmentname,

          TakenBy:
            row.takenby,

          Status:
            row.status,

          CheckoutDateTime:
            row.checkoutdatetime,

          CheckoutBy:
            row.checkoutby,

          CreatedDate:
            row.createddate,

          RGPItemID:
            Number(
              row.rgpitemid,
            ),

          ItemName:
            row.itemname,

          Specification:
            row.specification,

          Quantity:
            Number(
              row.quantity,
            ),

          Unit:
            row.unit,

          Rate:
            row.rate !== null
              ? Number(row.rate)
              : null,

          MakeModel:
            row.makemodel,

          SerialNumber:
            row.serialnumber,

          ReturnedQuantity:
            Number(
              row.returnedquantity || 0,
            ),

          RemainingQuantity:
            Number(
              row.remainingquantity || 0,
            ),

          IsReturned:
            row.isreturned,

          OverdueDays:
            Number(
              row.overduedays || 0,
            ),

          IsOverdue:
            row.isoverdue,
        }),
      );

    return ok(
      "RGP pending return report fetched successfully.",
      reportData,
      {
        TotalCount:
          totalCount,

        Page:
          page,

        PageSize:
          pageSize,

        TotalPages:
          Math.ceil(
            totalCount /
              pageSize,
          ),
      },
    );
  } catch (error) {
    return databaseFailure(
      error,
      "Fetch RGP pending return report",
    );
  }
};


// ============================================================
// Exports
// ============================================================

module.exports = {
  createRGP,
  getRGPList,
  getRGPById,
  getRGPByNumber,
  getRGPVendorNames,
  updateRGP,
  deleteRGP,
  processRGPApproval,
  processRGPGateAction,
  processRGPItemReturn,
  getRGPApprovalConfig,
  saveRGPApprovalConfig,
  deleteRGPApprovalConfig,
  getRGPListReport,
  getRGPDepartmentWiseReport,
  getRGPVendorWiseReport,
  getRGPPendingReturnReport,

};
