const { pool } = require("../../db");
const {retryableDatabaseResponse,} = require("../../utils/retryableDatabaseError");
const { formatDate } = require("../../utils/dateFormatter");
const generateUrl = require("../../AzurConfigration/Gatepass/AzureGetData");
// ===============================================Pdf Helper
const { generatePdf, loadLogo } = require("../../utils/pdfHelper");
const PdfPrinter = require("pdfmake");
const path = require("path");
const  RGP_DETAIL_PDF_FONTS = {
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
const normalizeRGPApprovalRole = (role) => {
  const normalizedRole =
    String(role || "")
      .trim()
      .toUpperCase();

  // FC and DOF are treated as the same approval role
  if (
    normalizedRole === "FC" ||
    normalizedRole === "DOF"
  ) {
    return "FC";
  }

  return normalizedRole;
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
  Remarks: row.remarks ?? null,
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
  // Internal use only.
  // Final API response se remove kar denge.
  RGPApprovalID:
    Number(row.rgpapprovalid),

  RGPApprovalConfigID:
    row.rgpapprovalconfigid == null
      ? null
      : Number(
          row.rgpapprovalconfigid,
        ),

  ApprovalLevel:
    Number(
      row.approvallevel,
    ),

  ApprovalRole:
    row.approvalrole,

  Status:
    row.status,

  Remarks:
    row.remarks,
});

// ==========================Map RGP Approval Flow
const mapRGPApprovalFlow = (approvalRows) => {
  let flowStopped = false;

  return approvalRows.map((row) => {
    const mappedApproval =
      mapRGPApproval(row);

    // Reject / Cancel ke baad ke approval stages blank
    if (flowStopped) {
      return {
        ...mappedApproval,
        Status: "",
        Remarks: "",
      };
    }

    const status =
      String(row.status || "")
        .trim()
        .toUpperCase();

    // Current Reject / Cancel row actual data ke saath rahegi.
    // Iske baad wali rows blank hongi.
    if (
      status === "REJECTED" ||
      status === "CANCELLED"
    ) {
      flowStopped = true;
    }

    return mappedApproval;
  });
};
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

        Remarks,

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

   const rgpApprovalRows =
  approvalResult.rows
    .filter(belongsToRGP);

rgp.Approvals =
  mapRGPApprovalFlow(
    rgpApprovalRows,
  ).map(omitParentIDs);

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
    // ==========================================================
    // Pagination
    // ==========================================================

    const page =
      Math.max(
        Number(data.page) || 1,
        1,
      );

    const pageSize =
      Math.min(
        Math.max(
          Number(data.PageSize) || 10,
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
    // Department Filter
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

    // ==========================================================
    // Logged-In User Role
    // ==========================================================

    const approvalRole =
      normalizeRGPApprovalRole(
        resolveRGPApprovalRole(
          data,
        ),
      );

    const departmentName =
      String(
        data.DepartmentName || "",
      )
        .trim()
        .toUpperCase();

    const isSecurity =
      departmentName ===
      "SECURITY";

    const isCEO =
      approvalRole ===
      "CEO";

    // ==========================================================
    // Role Wise Visibility
    //
    // SECURITY / CEO
    //   -> All records
    //
    // HOD
    //   -> Own department
    //
    // FC / DOF
    //   -> Both treated as same role
    //
    // GM / Other
    //   -> Own approval stage
    //
    // Previous stages must be APPROVED.
    // ==========================================================

    if (
      !isSecurity &&
      !isCEO
    ) {
      if (!approvalRole) {
        conditions.push(
          "1 = 0",
        );
      } else {
        // ======================================================
        // HOD Department Restriction
        // ======================================================

        if (
          approvalRole === "HOD"
        ) {
          const userDepartmentID =
            Number(
              data.UserDepartmentID,
            );

          if (
            !Number.isInteger(
              userDepartmentID,
            ) ||
            userDepartmentID <= 0
          ) {
            return fail(
              "User DepartmentID is required for HOD.",
              400,
            );
          }

          values.push(
            userDepartmentID,
          );

          conditions.push(
            `m.DepartmentID = $${values.length}`,
          );
        }

        // ======================================================
        // Current Approval Role
        // ======================================================

        values.push(
          approvalRole,
        );

        const roleIndex =
          values.length;

        // ======================================================
        // Sequential Visibility
        // ======================================================

        conditions.push(`
          EXISTS (
            SELECT 1

            FROM Gatepass_RGP_Approval myApproval

            WHERE myApproval.RGPID =
                    m.RGPID

              AND myApproval.IsDeleted =
                    FALSE

              AND (
                CASE
                  WHEN UPPER(
                    TRIM(
                      myApproval.ApprovalRole
                    )
                  ) IN ('FC', 'DOF')
                    THEN 'FC'

                  ELSE UPPER(
                    TRIM(
                      myApproval.ApprovalRole
                    )
                  )
                END
              )
              =
              (
                CASE
                  WHEN UPPER(
                    TRIM(
                      $${roleIndex}
                    )
                  ) IN ('FC', 'DOF')
                    THEN 'FC'

                  ELSE UPPER(
                    TRIM(
                      $${roleIndex}
                    )
                  )
                END
              )

              AND NOT EXISTS (
                SELECT 1

                FROM Gatepass_RGP_Approval previousApproval

                WHERE previousApproval.RGPID =
                        myApproval.RGPID

                  AND previousApproval.IsDeleted =
                        FALSE

                  AND previousApproval.ApprovalOrder <
                        myApproval.ApprovalOrder

                  AND UPPER(
                    TRIM(
                      COALESCE(
                        previousApproval.Status,
                        'PENDING'
                      )
                    )
                  ) <> 'APPROVED'
              )
          )
        `);
      }
    }

    // ==========================================================
    // Status Filter
    //
    // SECURITY / CEO
    //   -> Overall approval status
    //
    // HOD / FC / DOF / GM
    //   -> Own approval status
    // ==========================================================

    if (data.Status) {
      const filterStatus =
        String(
          data.Status,
        )
          .trim()
          .toUpperCase();

      // ========================================================
      // SECURITY / CEO
      // ========================================================

      if (
        isSecurity ||
        isCEO
      ) {
        // ======================================================
        // APPROVED
        // ======================================================

        if (
          filterStatus ===
          "APPROVED"
        ) {
          conditions.push(`
            EXISTS (
              SELECT 1

              FROM Gatepass_RGP_Approval a

              WHERE a.RGPID =
                      m.RGPID

                AND a.IsDeleted =
                    FALSE
            )

            AND NOT EXISTS (
              SELECT 1

              FROM Gatepass_RGP_Approval a

              WHERE a.RGPID =
                      m.RGPID

                AND a.IsDeleted =
                    FALSE

                AND UPPER(
                  TRIM(
                    COALESCE(
                      a.Status,
                      'PENDING'
                    )
                  )
                ) <> 'APPROVED'
            )
          `);
        }

        // ======================================================
        // REJECTED
        // ======================================================

        else if (
          filterStatus ===
          "REJECTED"
        ) {
          conditions.push(`
            EXISTS (
              SELECT 1

              FROM Gatepass_RGP_Approval a

              WHERE a.RGPID =
                      m.RGPID

                AND a.IsDeleted =
                    FALSE

                AND UPPER(
                  TRIM(
                    COALESCE(
                      a.Status,
                      'PENDING'
                    )
                  )
                ) = 'REJECTED'
            )
          `);
        }

        // ======================================================
        // CANCELLED
        // ======================================================

        else if (
          filterStatus ===
          "CANCELLED"
        ) {
          conditions.push(`
            EXISTS (
              SELECT 1

              FROM Gatepass_RGP_Approval a

              WHERE a.RGPID =
                      m.RGPID

                AND a.IsDeleted =
                    FALSE

                AND UPPER(
                  TRIM(
                    COALESCE(
                      a.Status,
                      'PENDING'
                    )
                  )
                ) = 'CANCELLED'
            )
          `);
        }

        // ======================================================
        // PENDING
        // ======================================================

        else if (
          filterStatus ===
          "PENDING"
        ) {
          conditions.push(`
            EXISTS (
              SELECT 1

              FROM Gatepass_RGP_Approval a

              WHERE a.RGPID =
                      m.RGPID

                AND a.IsDeleted =
                    FALSE

                AND UPPER(
                  TRIM(
                    COALESCE(
                      a.Status,
                      'PENDING'
                    )
                  )
                ) = 'PENDING'
            )

            AND NOT EXISTS (
              SELECT 1

              FROM Gatepass_RGP_Approval a

              WHERE a.RGPID =
                      m.RGPID

                AND a.IsDeleted =
                    FALSE

                AND UPPER(
                  TRIM(
                    COALESCE(
                      a.Status,
                      'PENDING'
                    )
                  )
                ) IN (
                  'REJECTED',
                  'CANCELLED'
                )
            )
          `);
        }

        // ======================================================
        // Other RGP Lifecycle Status
        // ======================================================

        else {
          values.push(
            filterStatus,
          );

          conditions.push(
            `UPPER(m.Status) = $${values.length}`,
          );
        }
      }

      // ========================================================
      // HOD / FC / DOF / GM / Other Approver
      // ========================================================

      else if (
        approvalRole
      ) {
        if (
          [
            "PENDING",
            "APPROVED",
            "REJECTED",
            "CANCELLED",
          ].includes(
            filterStatus,
          )
        ) {
          values.push(
            approvalRole,
          );

          const filterRoleIndex =
            values.length;

          values.push(
            filterStatus,
          );

          const filterStatusIndex =
            values.length;

          conditions.push(`
            EXISTS (
              SELECT 1

              FROM Gatepass_RGP_Approval filterApproval

              WHERE filterApproval.RGPID =
                      m.RGPID

                AND filterApproval.IsDeleted =
                    FALSE

                AND (
                  CASE
                    WHEN UPPER(
                      TRIM(
                        filterApproval.ApprovalRole
                      )
                    ) IN ('FC', 'DOF')
                      THEN 'FC'

                    ELSE UPPER(
                      TRIM(
                        filterApproval.ApprovalRole
                      )
                    )
                  END
                )
                =
                (
                  CASE
                    WHEN UPPER(
                      TRIM(
                        $${filterRoleIndex}
                      )
                    ) IN ('FC', 'DOF')
                      THEN 'FC'

                    ELSE UPPER(
                      TRIM(
                        $${filterRoleIndex}
                      )
                    )
                  END
                )

                AND UPPER(
                  TRIM(
                    COALESCE(
                      filterApproval.Status,
                      'PENDING'
                    )
                  )
                ) = $${filterStatusIndex}
            )
          `);
        }

        // ======================================================
        // Other Lifecycle Status
        // ======================================================

        else {
          values.push(
            filterStatus,
          );

          conditions.push(
            `UPPER(m.Status) = $${values.length}`,
          );
        }
      }
    }

    // ==========================================================
    // Where Clause
    // ==========================================================

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
          COUNT(*)::BIGINT AS TotalCount

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

    // ==========================================================
    // Get Approvals
    // ==========================================================

    const approvalsByRGP =
      new Map();

    if (
      result.rows.length > 0
    ) {
      const rgpIDs =
        result.rows.map(
          (row) =>
            row.rgpid,
        );

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

            AND IsDeleted =
              FALSE

          ORDER BY
            RGPID ASC,
            ApprovalOrder ASC,
            ApprovalLevel ASC,
            RGPApprovalID ASC;
          `,
          [rgpIDs],
        );

      for (
        const approval
        of approvalResult.rows
      ) {
        const rgpID =
          String(
            approval.rgpid,
          );

        if (
          !approvalsByRGP.has(
            rgpID,
          )
        ) {
          approvalsByRGP.set(
            rgpID,
            [],
          );
        }

        approvalsByRGP
          .get(rgpID)
          .push(approval);
      }
    }

    // ==========================================================
    // Status Helper
    // ==========================================================

    const normalizeStatus = (
      status,
    ) =>
      String(
        status || "Pending",
      )
        .trim()
        .toUpperCase();

    // ==========================================================
    // Map Result
    // ==========================================================

    const mappedData =
      result.rows.map(
        (row) => {
          const approvals =
            approvalsByRGP.get(
              String(
                row.rgpid,
              ),
            ) || [];

          const masterStatus =
            normalizeStatus(
              row.status,
            );

          // ====================================================
          // Current Sequential Stage
          // ====================================================

          const currentStage =
            approvals.find(
              (approval) =>
                normalizeStatus(
                  approval.status,
                ) !==
                "APPROVED",
            );

          // ====================================================
          // Current User Already Approved
          // ====================================================

          const alreadyApproved =
            approvals.some(
              (approval) =>
                normalizeStatus(
                  approval.status,
                ) ===
                  "APPROVED" &&

                data.UserID !=
                  null &&

                approval.actionby !=
                  null &&

                String(
                  approval.actionby,
                ) ===
                  String(
                    data.UserID,
                  ),
            );

          // ====================================================
          // Approval Status
          // ====================================================

          let approvalStatus =
            "PENDING";

          // ====================================================
          // SECURITY / CEO
          // Overall Approval Status
          // ====================================================

          if (
            isSecurity ||
            isCEO
          ) {
            const hasCancelled =
              approvals.some(
                (approval) =>
                  normalizeStatus(
                    approval.status,
                  ) ===
                  "CANCELLED",
              );

            const hasRejected =
              approvals.some(
                (approval) =>
                  normalizeStatus(
                    approval.status,
                  ) ===
                  "REJECTED",
              );

            const allApproved =
              approvals.length > 0 &&
              approvals.every(
                (approval) =>
                  normalizeStatus(
                    approval.status,
                  ) ===
                  "APPROVED",
              );

            if (hasCancelled) {
              approvalStatus =
                "CANCELLED";
            } else if (
              hasRejected
            ) {
              approvalStatus =
                "REJECTED";
            } else if (
              allApproved
            ) {
              approvalStatus =
                "APPROVED";
            } else {
              approvalStatus =
                "PENDING";
            }
          }

          // ====================================================
          // HOD / FC / DOF / GM / Other
          // Own Approval Status
          // ====================================================

          else if (
            approvalRole
          ) {
            const myApproval =
              approvals.find(
                (approval) =>
                  normalizeRGPApprovalRole(
                    approval.approvalrole,
                  ) ===
                  approvalRole,
              );

            if (myApproval) {
              approvalStatus =
                normalizeStatus(
                  myApproval.status,
                );
            } else {
              approvalStatus =
                "PENDING";
            }
          }

          // ====================================================
          // Can Approve
          // ====================================================

          const canApprove =
            Boolean(
              masterStatus ===
                "PENDING" &&

              approvalRole &&

              currentStage &&

              normalizeStatus(
                currentStage.status,
              ) ===
                "PENDING" &&

              normalizeRGPApprovalRole(
                currentStage.approvalrole,
              ) ===
                approvalRole &&

              !alreadyApproved &&

              (
                approvalRole !==
                  "HOD" ||

                (
                  Number(
                    data.UserDepartmentID,
                  ) > 0 &&

                  Number(
                    data.UserDepartmentID,
                  ) ===
                    Number(
                      row.departmentid,
                    )
                )
              )
            );

          // ====================================================
          // Can Checkout
          // Security Only + All Approvals Approved
          // ====================================================

          const canCheckout =
            Boolean(
              isSecurity &&

              masterStatus ===
                "APPROVED" &&

              approvals.length >
                0 &&

              approvals.every(
                (approval) =>
                  normalizeStatus(
                    approval.status,
                  ) ===
                  "APPROVED",
              )
            );

          // ====================================================
          // Can Action
          //
          // TRUE only when:
          // RGP CreatedBy === Logged-In UserID
          // and approvals are not all approved.
          // ====================================================

          const canAction =
            Boolean(
              !(
                approvals.length > 0 &&
                approvals.every(
                  (approval) =>
                    normalizeStatus(
                      approval.status,
                    ) ===
                    "APPROVED",
                )
              ) &&

              row.createdby !=
                null &&

              data.UserID !=
                null &&

              String(
                row.createdby,
              ) ===
                String(
                  data.UserID,
                )
            );

          // ====================================================
          // Response
          // ====================================================

          return {
            ...mapRGP(row),

             Approvals:
    mapRGPApprovalFlow(
      approvals,
    ),

            ApprovalStatus:
              approvalStatus,

            canappprove:
              canApprove,

            cancheckout:
              canCheckout,

            canaction:
              canAction,
          };
        },
      );

    // ==========================================================
    // Response
    // ==========================================================

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
// ============================================================Get RGP Total List
const getRGPTotalList = async (data) => {
  try {
    // ============================================================
    // Pagination
    // ============================================================

    const page =
      Math.max(
        Number(data.page) || 1,
        1,
      );

    const pageSize =
      Math.min(
        Math.max(
          Number(data.PageSize) || 10,
          1,
        ),
        100,
      );

    const offset =
      (page - 1) * pageSize;

    // ============================================================
    // Conditions
    // ============================================================

    const values = [];

    const conditions = [
      "m.IsDeleted = FALSE",
    ];

    // ============================================================
    // Organization
    // ============================================================

    const organizationID =
      Number(data.OrganizationID);

    if (
      !Number.isInteger(
        organizationID,
      ) ||
      organizationID <= 0
    ) {
      return fail(
        "Valid OrganizationID is required.",
        400,
      );
    }

    values.push(
      organizationID,
    );

    conditions.push(
      `m.OrganizationID = $${values.length}`,
    );

    // ============================================================
    // RGP Number
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
    // Department
    // ============================================================

    if (data.DepartmentID) {
      values.push(
        data.DepartmentID,
      );

      conditions.push(
        `m.DepartmentID = $${values.length}`,
      );
    }

    // Month and Year accept single values, comma-separated values, or arrays.
    for (const [field, max] of [["Month", 12], ["Year", 9999]]) {
      const input = data[field];
      if (input === undefined || input === null) continue;

      const entries = (Array.isArray(input) ? input : [input])
        .flatMap((value) => String(value).split(","))
        .map((value) => value.trim());

      if (
        entries.length === 0 ||
        entries.some((value) =>
          !/^\d+$/.test(value) ||
          Number(value) < 1 ||
          Number(value) > max
        )
      ) {
        return fail(
          `${field} must contain integers between 1 and ${max}.`,
          400,
        );
      }

      values.push([...new Set(entries.map(Number))]);
      conditions.push(
        `EXTRACT(${field.toUpperCase()} FROM m.CreatedDate)::INTEGER = ANY($${values.length}::INTEGER[])`,
      );
    }

    // ============================================================
    // Status
    //
    // Direct master lifecycle status:
    // PENDING
    // APPROVED
    // CHECKED OUT
    // RETURN PENDING
    // RETURNED
    // CANCELLED
    // REJECTED
    // ============================================================

    if (data.Status) {
      values.push(
        String(
          data.Status,
        )
          .trim()
          .toUpperCase(),
      );

      conditions.push(
        `UPPER(TRIM(m.Status)) = $${values.length}`,
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

          OR COALESCE(
            m.Address,
            ''
          ) ILIKE $${searchIndex}

          OR COALESCE(
            d.DepartmentName,
            ''
          ) ILIKE $${searchIndex}
        )
      `);
    }

    // ============================================================
    // Where Clause
    // ============================================================

    const whereClause =
      conditions.join(
        " AND ",
      );

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

        WHERE ${whereClause};
        `,
        values,
      );

    const totalCount =
      Number(
        countResult.rows[0]
          .totalcount,
      );

    // ============================================================
    // Pagination Values
    // ============================================================

    const listValues = [
      ...values,
      pageSize,
      offset,
    ];

    const limitIndex =
      values.length + 1;

    const offsetIndex =
      values.length + 2;

    // ============================================================
    // Get RGP List
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

          m.Address,
          m.TakenBy,

          m.Status,

          -- ================================================
          -- Checkout
          -- ================================================

          m.CheckoutDateTime,
          m.CheckoutBy,
          checkoutUser.FullName
            AS CheckoutByName,
          m.CheckoutRemarks,

          -- ================================================
          -- Cancellation
          -- ================================================

          m.CancelledBy,
          cancelledUser.FullName
            AS CancelledByName,
          m.CancelledDateTime,
          m.CancellationRemarks,

          -- ================================================
          -- Return Completion
          -- ================================================

          m.ReturnedBy,
          returnedUser.FullName
            AS ReturnedByName,
          m.ReturnedDateTime,
          m.ReturnRemarks,

          -- ================================================
          -- Created By
          -- ================================================

          m.CreatedBy,
          createdUser.FullName
            AS CreatedByName,
          m.CreatedDate,

          m.ModifiedBy,
          m.ModifiedDate

        FROM Gatepass_RGP_Entry_Master m

        LEFT JOIN department_master d
          ON d.DepartmentID =
            m.DepartmentID

        LEFT JOIN user_master createdUser
          ON createdUser.UserID =
            m.CreatedBy

        LEFT JOIN user_master checkoutUser
          ON checkoutUser.UserID =
            m.CheckoutBy

        LEFT JOIN user_master cancelledUser
          ON cancelledUser.UserID =
            m.CancelledBy

        LEFT JOIN user_master returnedUser
          ON returnedUser.UserID =
            m.ReturnedBy

        WHERE ${whereClause}

        ORDER BY
          m.RGPID DESC

        LIMIT $${limitIndex}
        OFFSET $${offsetIndex};
        `,
        listValues,
      );

    // ============================================================
    // Get Approvals
    // ============================================================

    const approvalsByRGP =
      new Map();

    if (
      result.rows.length > 0
    ) {
      const rgpIDs =
        result.rows.map(
          (row) =>
            Number(row.rgpid),
        );

      const approvalResult =
        await pool.query(
          `
          SELECT
            a.RGPApprovalID,
            a.RGPID,
            a.OrganizationID,
            a.RGPApprovalConfigID,
            a.ApprovalLevel,
            a.ApprovalRole,
            a.ApprovalOrder,
            a.Status,
            a.StatusDateTime,
            a.ActionBy,

            actionUser.FullName
              AS ActionByName,

            a.Remarks

          FROM Gatepass_RGP_Approval a

          LEFT JOIN user_master actionUser
            ON actionUser.UserID =
              a.ActionBy

          WHERE a.RGPID =
            ANY($1::BIGINT[])

            AND a.IsDeleted =
              FALSE

          ORDER BY
            a.RGPID ASC,
            a.ApprovalOrder ASC,
            a.ApprovalLevel ASC,
            a.RGPApprovalID ASC;
          `,
          [rgpIDs],
        );

      for (
        const approval
        of approvalResult.rows
      ) {
        const rgpID =
          String(
            approval.rgpid,
          );

        if (
          !approvalsByRGP.has(
            rgpID,
          )
        ) {
          approvalsByRGP.set(
            rgpID,
            [],
          );
        }

        approvalsByRGP
          .get(rgpID)
          .push({
            RGPApprovalID:
              Number(
                approval.rgpapprovalid,
              ),

            RGPApprovalConfigID:
              approval.rgpapprovalconfigid !==
                null &&
              approval.rgpapprovalconfigid !==
                undefined
                ? Number(
                    approval.rgpapprovalconfigid,
                  )
                : null,

            ApprovalLevel:
              Number(
                approval.approvallevel,
              ),

            ApprovalRole:
              approval.approvalrole,

            ApprovalOrder:
              Number(
                approval.approvalorder,
              ),

            Status:
              approval.status,

            StatusDateTime:
              approval.statusdatetime
                ? formatDate(
                    approval.statusdatetime,
                    "DD MMM YYYY",
                  )
                : null,

            ActionBy:
              approval.actionby !==
                null &&
              approval.actionby !==
                undefined
                ? Number(
                    approval.actionby,
                  )
                : null,

            ActionByName:
              approval.actionbyname ||
              null,

            Remarks:
              approval.remarks ??
              null,
          });
      }
    }

    // ============================================================
    // Map List
    // ============================================================

    const mappedData =
      result.rows.map(
        (row) => {
          const approvals =
            approvalsByRGP.get(
              String(
                row.rgpid,
              ),
            ) || [];

          // ========================================================
          // Approval Flow
          //
          // If any approval is REJECTED / CANCELLED:
          //
          // Current REJECTED / CANCELLED approval:
          //   -> Keep actual data
          //
          // All approvals after that:
          //   -> Status blank
          //   -> StatusDateTime null
          //   -> ActionBy null
          //   -> ActionByName null
          //   -> Remarks blank
          //
          // ApprovalRole / Level / Order remain unchanged.
          // ========================================================

          let approvalFlowStopped =
            false;

          const mappedApprovals =
            approvals.map(
              (approval) => {
                if (
                  approvalFlowStopped
                ) {
                  return {
                    ...approval,

                    Status:
                      "",

                    StatusDateTime:
                      null,

                    ActionBy:
                      null,

                    ActionByName:
                      null,

                    Remarks:
                      "",
                  };
                }

                const approvalStatus =
                  String(
                    approval.Status ||
                      "",
                  )
                    .trim()
                    .toUpperCase();

                if (
                  approvalStatus ===
                    "REJECTED" ||
                  approvalStatus ===
                    "CANCELLED"
                ) {
                  approvalFlowStopped =
                    true;
                }

                return approval;
              },
            );

          return {
            RGPID:
              Number(
                row.rgpid,
              ),

            RGPNumber:
              Number(
                row.rgpnumber,
              ),

            OrganizationID:
              Number(
                row.organizationid,
              ),

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
              Number(
                row.departmentid,
              ),

            DepartmentName:
              row.departmentname ||
              null,

            Address:
              row.address,

            TakenBy:
              row.takenby,

            // ==================================================
            // Current RGP Lifecycle Status
            // ==================================================

            Status:
              row.status,

            // ==================================================
            // Approvals
            // ==================================================

            Approvals:
              mappedApprovals,

            // ==================================================
            // Checkout
            // ==================================================

            CheckoutDateTime:
              row.checkoutdatetime
                ? formatDate(
                    row.checkoutdatetime,
                    "DD MMM YYYY",
                  )
                : null,

            CheckoutBy:
              row.checkoutby !==
                null &&
              row.checkoutby !==
                undefined
                ? Number(
                    row.checkoutby,
                  )
                : null,

            CheckoutByName:
              row.checkoutbyname ||
              null,

            CheckoutRemarks:
              row.checkoutremarks ??
              null,

            // ==================================================
            // Cancellation
            // ==================================================

            CancelledBy:
              row.cancelledby !==
                null &&
              row.cancelledby !==
                undefined
                ? Number(
                    row.cancelledby,
                  )
                : null,

            CancelledByName:
              row.cancelledbyname ||
              null,

            CancelledDateTime:
              row.cancelleddatetime
                ? formatDate(
                    row.cancelleddatetime,
                    "DD MMM YYYY",
                  )
                : null,

            CancellationRemarks:
              row.cancellationremarks ??
              null,

            // ==================================================
            // Return Completion
            // ==================================================

            ReturnedBy:
              row.returnedby !==
                null &&
              row.returnedby !==
                undefined
                ? Number(
                    row.returnedby,
                  )
                : null,

            ReturnedByName:
              row.returnedbyname ||
              null,

            ReturnedDateTime:
              row.returneddatetime
                ? formatDate(
                    row.returneddatetime,
                    "DD MMM YYYY",
                  )
                : null,

            ReturnRemarks:
              row.returnremarks ??
              null,

            // ==================================================
            // Created
            // ==================================================

            CreatedBy:
              row.createdby !==
                null &&
              row.createdby !==
                undefined
                ? Number(
                    row.createdby,
                  )
                : null,

            CreatedByName:
              row.createdbyname ||
              null,

            CreatedDate:
              row.createddate
                ? formatDate(
                    row.createddate,
                  )
                : null,
          };
        },
      );

    // ============================================================
    // Response
    // ============================================================

    return ok(
      "RGP total list fetched successfully.",
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
      "Fetch RGP total list",
    );
  }
};
// ============================================================Get RGP By ID
const getRGPById = async (data) => {
  try {
    // ============================================================
    // Validate
    // ============================================================

    const RGPID =
      Number(data.RGPID);

    if (
      !Number.isInteger(RGPID) ||
      RGPID <= 0
    ) {
      return fail(
        "Valid RGPID is required.",
        400,
      );
    }

    // ============================================================
    // Get Master
    // ============================================================

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

          -- ======================================================
          -- Checkout
          -- ======================================================

          m.CheckoutDateTime,
          m.CheckoutBy,
          checkoutUser.FullName AS CheckoutByName,
          m.CheckoutRemarks,

          -- ======================================================
          -- Cancel
          -- ======================================================

          m.CancelledBy,
          cancelledUser.FullName AS CancelledByName,
          m.CancelledDateTime,
          m.CancellationRemarks,

          -- ======================================================
          -- Return
          -- ======================================================

          m.ReturnedBy,
          m.ReturnedDateTime,
          m.ReturnRemarks,

          -- ======================================================
          -- Created
          -- ======================================================

          m.CreatedBy,
          createdUser.FullName AS CreatedByName,
          m.CreatedDate,

          m.ModifiedBy,
          m.ModifiedDate

        FROM Gatepass_RGP_Entry_Master m

        LEFT JOIN department_master d
          ON d.DepartmentID =
            m.DepartmentID

        LEFT JOIN user_master createdUser
          ON createdUser.UserID =
            m.CreatedBy

        LEFT JOIN user_master checkoutUser
          ON checkoutUser.UserID =
            m.CheckoutBy

        LEFT JOIN user_master cancelledUser
          ON cancelledUser.UserID =
            m.CancelledBy

        WHERE m.RGPID = $1
          AND m.IsDeleted = FALSE

        LIMIT 1;
        `,
        [RGPID],
      );

    // ============================================================
    // Not Found
    // ============================================================

    if (
      masterResult.rows.length === 0
    ) {
      return fail(
        "RGP record not found.",
        404,
      );
    }

    // ============================================================
    // Keep Master Data
    // ============================================================

    const masterRow =
      masterResult.rows[0];

    // ============================================================
    // Created By
    // ============================================================

    const createdBy =
      masterRow.createdby;

    const createdByName =
      masterRow.createdbyname;

    // ============================================================
    // Checkout Details
    // ============================================================

    const checkoutDateTime =
      masterRow.checkoutdatetime;

    const checkoutBy =
      masterRow.checkoutby;

    const checkoutByName =
      masterRow.checkoutbyname;

    const checkoutRemarks =
      masterRow.checkoutremarks;

    // ============================================================
    // Cancellation Details
    // ============================================================

    const cancelledBy =
      masterRow.cancelledby;

    const cancelledByName =
      masterRow.cancelledbyname;

    const cancelledDateTime =
      masterRow.cancelleddatetime;

    const cancellationRemarks =
      masterRow.cancellationremarks;

    // ============================================================
    // Attach Existing Related Data
    //
    // Items
    // Documents
    // Approvals
    // ============================================================

    const [rgp] =
      await attachRGPRelatedData(
        masterResult.rows,
      );

    // ============================================================
    // Get Return Details
    //
    // Every return transaction remains a separate row.
    //
    // Example:
    // Original Qty = 994
    // Return 1 = 100
    // Return 2 = 194
    //
    // Output:
    // 100 Returned
    // 194 Returned
    // 700 Pending
    // ============================================================

    const returnResult =
      await pool.query(
        `
        SELECT
          RGPReturnDetailID,
          RGPItemID,
          QuantityReceived,
          RemainingQuantity,
          ReturnDateTime,
          ReturnBy,
          ActualDate,
          IsReturn,
          Remarks

        FROM Gatepass_RGP_Item_Return_Details

        WHERE RGPID = $1
          AND IsDeleted = FALSE

        ORDER BY
          ReturnDateTime ASC,
          RGPReturnDetailID ASC;
        `,
        [RGPID],
      );

    // ============================================================
    // Group Return Transactions By Item
    // ============================================================

    const returnsByItem =
      new Map();

    for (
      const row
      of returnResult.rows
    ) {
      const itemID =
        Number(
          row.rgpitemid,
        );

      if (
        !returnsByItem.has(
          itemID,
        )
      ) {
        returnsByItem.set(
          itemID,
          [],
        );
      }

      returnsByItem
        .get(itemID)
        .push({
          RGPReturnDetailID:
            Number(
              row.rgpreturndetailid,
            ),

          QuantityReceived:
            Number(
              row.quantityreceived,
            ) || 0,

          RemainingQuantity:
            Number(
              row.remainingquantity,
            ) || 0,

          ReturnDateTime:
            row.returndatetime
              ? formatDate(
                  row.returndatetime,
                  "DD MMM YYYY HH:mm:ss",
                )
              : null,

          ReturnBy:
            row.returnby === null ||
            row.returnby === undefined
              ? null
              : Number(
                  row.returnby,
                ),

          ActualDate:
            row.actualdate
              ? formatDate(
                  row.actualdate,
                )
              : null,

          IsReturn:
            row.isreturn === true,

          Remarks:
            row.remarks ?? null,
        });
    }

    // ============================================================
    // Build Item Rows
    //
    // Each saved return = separate Returned row
    // Remaining quantity = one last Pending row
    // ============================================================

    rgp.Items =
      Array.isArray(
        rgp.Items,
      )
        ? rgp.Items.flatMap(
            (item) => {
              const itemID =
                Number(
                  item.RGPItemID,
                );

              const originalQuantity =
                Number(
                  item.Quantity,
                ) || 0;

              const returns =
                returnsByItem.get(
                  itemID,
                ) || [];

              // ==================================================
              // Total Quantity Already Returned
              // ==================================================

              const totalReturned =
                returns.reduce(
                  (
                    total,
                    detail,
                  ) =>
                    total +
                    Number(
                      detail.QuantityReceived ||
                        0,
                    ),
                  0,
                );

              // ==================================================
              // Calculate Remaining From Original Quantity
              //
              // 994 - (100 + 194) = 700
              // ==================================================

              const remainingQuantity =
                Math.max(
                  originalQuantity -
                    totalReturned,
                  0,
                );

              const itemRows =
                [];

              // ==================================================
              // Returned Rows
              // ==================================================

              for (
                const detail
                of returns
              ) {
                itemRows.push({
                  ...item,

                  RGPReturnDetailID:
                    detail.RGPReturnDetailID,

                  Quantity:
                    detail.QuantityReceived,

                  ReturnedQuantity:
                    detail.QuantityReceived,

                  RemainingQuantity:
                    0,

                  IsReturned:
                    true,

                  QuantityReceived:
                    detail.QuantityReceived,

                  ReturnDateTime:
                    detail.ReturnDateTime,

                  ReturnBy:
                    detail.ReturnBy,

                  ActualDate:
                    detail.ActualDate,

                  IsReturn:
                    detail.IsReturn,

                  Remarks:
                    detail.Remarks,
                });
              }

              // ==================================================
              // Pending / Remaining Row
              //
              // Always last.
              // Only add when quantity is still pending.
              // ==================================================

              if (
                remainingQuantity > 0
              ) {
                itemRows.push({
                  ...item,

                  Quantity:
                    remainingQuantity,

                  ReturnedQuantity:
                    0,

                  RemainingQuantity:
                    remainingQuantity,

                  IsReturned:
                    false,

                  RGPReturnDetailID:
                    null,

                  QuantityReceived:
                    0,

                  ReturnDateTime:
                    null,

                  ReturnBy:
                    null,

                  ActualDate:
                    null,

                  IsReturn:
                    false,

                  Remarks:
                    null,
                });
              }

              // ==================================================
              // Safety
              //
              // If original quantity itself is 0 and there are
              // no returns, preserve original item.
              // ==================================================

              if (
                itemRows.length === 0
              ) {
                itemRows.push({
                  ...item,

                  Quantity:
                    originalQuantity,

                  ReturnedQuantity:
                    0,

                  RemainingQuantity:
                    originalQuantity,

                  IsReturned:
                    false,

                  RGPReturnDetailID:
                    null,

                  QuantityReceived:
                    0,

                  ReturnDateTime:
                    null,

                  ReturnBy:
                    null,

                  ActualDate:
                    null,

                  IsReturn:
                    false,

                  Remarks:
                    null,
                });
              }

              return itemRows;
            },
          )
        : [];

    // ============================================================
    // Explicitly Attach Created By
    // ============================================================

    rgp.CreatedBy =
      createdBy !== null &&
      createdBy !== undefined
        ? Number(
            createdBy,
          )
        : null;

    rgp.CreatedByName =
      createdByName || null;

    // ============================================================
    // Explicitly Attach Checkout Details
    // ============================================================

    rgp.CheckoutDateTime =
      checkoutDateTime
        ? formatDate(
            checkoutDateTime,
            "DD MMM YYYY",
          )
        : null;

    rgp.CheckoutBy =
      checkoutBy !== null &&
      checkoutBy !== undefined
        ? Number(
            checkoutBy,
          )
        : null;

    rgp.CheckoutByName =
      checkoutByName || null;

    rgp.CheckoutRemarks =
      checkoutRemarks || null;

    // ============================================================
    // Explicitly Attach Cancellation Details
    // ============================================================

    rgp.CancelledBy =
      cancelledBy !== null &&
      cancelledBy !== undefined
        ? Number(
            cancelledBy,
          )
        : null;

    rgp.CancelledByName =
      cancelledByName || null;

    rgp.CancelledDateTime =
      cancelledDateTime
        ? formatDate(
            cancelledDateTime,
            "DD MMM YYYY HH:mm:ss",
          )
        : null;

    rgp.CancellationRemarks =
      cancellationRemarks || null;

    // ============================================================
    // Get Approval Action User Names
    //
    // APPROVED
    // REJECTED
    // CANCELLED
    //
    // ActionBy -> user_master.UserID
    // ActionByName -> user_master.FullName
    // ============================================================

    const approvalNameResult =
      await pool.query(
        `
        SELECT
          a.RGPApprovalID,
          a.ApprovalRole,
          a.ApprovalOrder,
          a.Status,
          a.ActionBy,

          u.FullName AS ActionByName

        FROM Gatepass_RGP_Approval a

        LEFT JOIN user_master u
          ON u.UserID =
            a.ActionBy

        WHERE a.RGPID = $1
          AND a.IsDeleted = FALSE

        ORDER BY
          a.ApprovalOrder ASC,
          a.RGPApprovalID ASC;
        `,
        [RGPID],
      );

    // ============================================================
    // Approval Action User Map
    //
    // IMPORTANT:
    // Map using RGPApprovalID.
    // ============================================================

    const approvalUserMap =
      new Map();

    for (
      const approval
      of approvalNameResult.rows
    ) {
      approvalUserMap.set(
        Number(
          approval.rgpapprovalid,
        ),
        {
          ActionByName:
            approval.actionbyname ||
            null,
        },
      );
    }

    // ============================================================
    // Attach ActionByName To Existing Approvals
    //
    // Final response DOES NOT contain:
    //
    // RGPApprovalID
    // ApprovalOrder
    // ActionBy
    //
    // Final response DOES contain:
    //
    // ActionByName
    // ============================================================

    rgp.Approvals =
      Array.isArray(
        rgp.Approvals,
      )
        ? rgp.Approvals.map(
            (approval) => {
              const actionUser =
                approvalUserMap.get(
                  Number(
                    approval.RGPApprovalID,
                  ),
                );

              const {
                RGPApprovalID,
                ApprovalOrder,
                ActionBy,
                ...approvalData
              } = approval;

              return {
                ...approvalData,

                ActionByName:
                  actionUser?.ActionByName ??
                  null,
              };
            },
          )
        : [];

    // ============================================================
    // Approval Names
    //
    // Keep this because existing frontend/PDF may already use it.
    //
    // Names can come from:
    //
    // APPROVED
    // REJECTED
    // CANCELLED
    // ============================================================

    let HODName =
      null;

    let FC_DOFName =
      null;

    let GMName =
      null;

    for (
      const approval
      of approvalNameResult.rows
    ) {
      const role =
        String(
          approval.approvalrole ||
            "",
        )
          .trim()
          .toUpperCase();

      const status =
        String(
          approval.status ||
            "",
        )
          .trim()
          .toUpperCase();

      // ==========================================================
      // Ignore Pending / Blank
      // ==========================================================

      if (
        ![
          "APPROVED",
          "REJECTED",
          "CANCELLED",
        ].includes(
          status,
        )
      ) {
        continue;
      }

      const actionByName =
        approval.actionbyname ||
        null;

      // ==========================================================
      // HOD
      // ==========================================================

      if (
        role === "HOD"
      ) {
        HODName =
          actionByName;
      }

      // ==========================================================
      // FC / DOF
      // ==========================================================

      else if (
        role === "FC" ||
        role === "DOF"
      ) {
        FC_DOFName =
          actionByName;
      }

      // ==========================================================
      // GM
      // ==========================================================

      else if (
        role === "GM"
      ) {
        GMName =
          actionByName;
      }
    }

    // ============================================================
    // Attach Approval Names
    // ============================================================

    rgp.ApprovalNames = {
      HODName,
      FC_DOFName,
      GMName,
    };

    // ============================================================
    // Documents URL
    // ============================================================

    rgp.Documents =
      Array.isArray(
        rgp.Documents,
      )
        ? rgp.Documents.map(
            (document) => ({
              ...document,

              FilePath:
                document.FilePath
                  ? generateUrl(
                      document.FilePath,
                    )
                  : null,
            }),
          )
        : [];

    // ============================================================
    // Response
    // ============================================================

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
// ============================================================Get RGP By Number
const getRGPByNumber = async (data) => {
  try {
    // ============================================================
    // RGP Number
    // ============================================================

    const RGPNumber = String(
      data.RGPNumber || "",
    ).trim();

    // ============================================================
    // Empty Search
    // ============================================================

    if (!RGPNumber) {
      return ok(
        "Enter RGP number to search.",
        null,
      );
    }

    // ============================================================
    // Get Master
    // ============================================================

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
          checkoutUser.FullName AS CheckoutByName,
          m.CheckoutRemarks,

          m.CancelledBy,
          m.CancelledDateTime,
          m.CancellationRemarks,

          m.ReturnedBy,
          m.ReturnedDateTime,
          m.ReturnRemarks,

          m.CreatedBy,
          createdUser.FullName AS CreatedByName,
          m.CreatedDate,

          m.ModifiedBy,
          m.ModifiedDate

        FROM Gatepass_RGP_Entry_Master m

        LEFT JOIN department_master d
          ON d.DepartmentID =
            m.DepartmentID

        LEFT JOIN user_master createdUser
          ON createdUser.UserID =
            m.CreatedBy

        LEFT JOIN user_master checkoutUser
          ON checkoutUser.UserID =
            m.CheckoutBy

        WHERE m.RGPNumber = $1
          AND m.IsDeleted = FALSE

          AND EXISTS (
            SELECT 1
            FROM Gatepass_RGP_Approval a
            WHERE a.RGPID = m.RGPID
              AND a.IsDeleted = FALSE
          )

          AND NOT EXISTS (
            SELECT 1
            FROM Gatepass_RGP_Approval a
            WHERE a.RGPID = m.RGPID
              AND a.IsDeleted = FALSE
              AND UPPER(
                TRIM(
                  COALESCE(
                    a.Status,
                    'Pending'
                  )
                )
              ) <> 'APPROVED'
          )

          AND EXISTS (
            SELECT 1
            FROM Gatepass_RGP_Entry_Item_Details i
            WHERE i.RGPID = m.RGPID
              AND i.IsDeleted = FALSE
              AND COALESCE(
                i.RemainingQuantity,
                0
              ) > 0
          )

        LIMIT 1;
        `,
        [RGPNumber],
      );

    // ============================================================
    // Not Found
    // ============================================================

    if (
      !masterResult.rows.length
    ) {
      return ok(
        "RGP record not found.",
        null,
      );
    }

    // ============================================================
    // Keep Master Data
    // ============================================================

    const masterRow =
      masterResult.rows[0];

    const RGPID =
      Number(
        masterRow.rgpid,
      );

    // ============================================================
    // Created By
    // ============================================================

    const createdBy =
      masterRow.createdby;

    const createdByName =
      masterRow.createdbyname;

    // ============================================================
    // Checkout Details
    // ============================================================

    const checkoutDateTime =
      masterRow.checkoutdatetime;

    const checkoutBy =
      masterRow.checkoutby;

    const checkoutByName =
      masterRow.checkoutbyname;

    const checkoutRemarks =
      masterRow.checkoutremarks;

    // ============================================================
    // Attach Related Data
    //
    // Items
    // Documents
    // Approvals
    // ============================================================

    const [rgp] =
      await attachRGPRelatedData(
        masterResult.rows,
      );

    // ============================================================
    // Get Item Return Details
    // ============================================================

    const returnResult =
      await pool.query(
        `
        SELECT
          RGPReturnDetailID,
          RGPItemID,
          QuantityReceived,
          RemainingQuantity,
          ReturnDateTime,
          ReturnBy,
          ActualDate,
          IsReturn,
          Remarks

        FROM Gatepass_RGP_Item_Return_Details

        WHERE RGPID = $1
          AND IsDeleted = FALSE

        ORDER BY
          ReturnDateTime ASC,
          RGPReturnDetailID ASC;
        `,
        [RGPID],
      );

    // ============================================================
    // Group Returns By Item
    // ============================================================

    const returnsByItem =
      new Map();

    for (
      const row
      of returnResult.rows
    ) {
      const itemID =
        Number(
          row.rgpitemid,
        );

      if (
        !returnsByItem.has(
          itemID,
        )
      ) {
        returnsByItem.set(
          itemID,
          [],
        );
      }

      returnsByItem
        .get(itemID)
        .push({
          RGPReturnDetailID:
            Number(
              row.rgpreturndetailid,
            ),

          QuantityReceived:
            Number(
              row.quantityreceived,
            ) || 0,

          RemainingQuantity:
            Number(
              row.remainingquantity,
            ) || 0,

          ReturnDateTime:
            row.returndatetime
              ? formatDate(
                  row.returndatetime,
                  "DD MMM YYYY HH:mm:ss",
                )
              : null,

          ReturnBy:
            row.returnby === null ||
            row.returnby === undefined
              ? null
              : Number(
                  row.returnby,
                ),

          ActualDate:
            row.actualdate
              ? formatDate(
                  row.actualdate,
                )
              : null,

          IsReturn:
            row.isreturn === true,

          Remarks:
            row.remarks ?? null,
        });
    }

    // ============================================================
    // Build Item Rows
    //
    // Example:
    //
    // Original = 994
    // Return   = 100
    // Return   = 194
    //
    // Result:
    // 100 Returned
    // 194 Returned
    // 700 Pending
    // ============================================================

    rgp.Items =
      Array.isArray(rgp.Items)
        ? rgp.Items.flatMap(
            (item) => {
              const itemID =
                Number(
                  item.RGPItemID,
                );

              // Original item quantity
              const originalQuantity =
                Number(
                  item.Quantity,
                ) || 0;

              const returns =
                returnsByItem.get(
                  itemID,
                ) || [];

              // ================================================
              // Total Returned
              // ================================================

              const totalReturned =
                returns.reduce(
                  (
                    total,
                    detail,
                  ) =>
                    total +
                    Number(
                      detail.QuantityReceived ||
                        0,
                    ),
                  0,
                );

              // ================================================
              // Remaining Quantity
              // ================================================

              const remainingQuantity =
                Math.max(
                  originalQuantity -
                    totalReturned,
                  0,
                );

              const itemRows = [];

              // ================================================
              // Returned Rows
              // ================================================

              for (
                const detail
                of returns
              ) {
                itemRows.push({
                  ...item,

                  RGPReturnDetailID:
                    detail.RGPReturnDetailID,

                  Quantity:
                    detail.QuantityReceived,

                  ReturnedQuantity:
                    detail.QuantityReceived,

                  RemainingQuantity:
                    0,

                  IsReturned:
                    true,

                  QuantityReceived:
                    detail.QuantityReceived,

                  ReturnDateTime:
                    detail.ReturnDateTime,

                  ReturnBy:
                    detail.ReturnBy,

                  ActualDate:
                    detail.ActualDate,

                  IsReturn:
                    detail.IsReturn,

                  Remarks:
                    detail.Remarks,
                });
              }

              // ================================================
              // Remaining / Pending Row
              // Always Last
              // ================================================

              if (
                remainingQuantity > 0
              ) {
                itemRows.push({
                  ...item,

                  RGPReturnDetailID:
                    null,

                  Quantity:
                    remainingQuantity,

                  ReturnedQuantity:
                    0,

                  RemainingQuantity:
                    remainingQuantity,

                  IsReturned:
                    false,

                  QuantityReceived:
                    0,

                  ReturnDateTime:
                    null,

                  ReturnBy:
                    null,

                  ActualDate:
                    null,

                  IsReturn:
                    false,

                  Remarks:
                    null,
                });
              }

              // ================================================
              // Safety
              // ================================================

              if (
                itemRows.length === 0
              ) {
                itemRows.push({
                  ...item,

                  RGPReturnDetailID:
                    null,

                  Quantity:
                    originalQuantity,

                  ReturnedQuantity:
                    0,

                  RemainingQuantity:
                    originalQuantity,

                  IsReturned:
                    false,

                  QuantityReceived:
                    0,

                  ReturnDateTime:
                    null,

                  ReturnBy:
                    null,

                  ActualDate:
                    null,

                  IsReturn:
                    false,

                  Remarks:
                    null,
                });
              }

              return itemRows;
            },
          )
        : [];

    // ============================================================
    // Created By
    // ============================================================

    rgp.CreatedBy =
      createdBy !== null &&
      createdBy !== undefined
        ? Number(
            createdBy,
          )
        : null;

    rgp.CreatedByName =
      createdByName || null;

    // ============================================================
    // Checkout Details
    // ============================================================

    rgp.CheckoutDateTime =
      checkoutDateTime
        ? formatDate(
            checkoutDateTime,
            "DD MMM YYYY",
          )
        : null;

    rgp.CheckoutBy =
      checkoutBy !== null &&
      checkoutBy !== undefined
        ? Number(
            checkoutBy,
          )
        : null;

    rgp.CheckoutByName =
      checkoutByName || null;

    rgp.CheckoutRemarks =
      checkoutRemarks || null;

    // ============================================================
    // Get Approval User Names
    // ============================================================

    const approvalNameResult =
      await pool.query(
        `
        SELECT
          a.RGPApprovalID,
          a.ApprovalRole,
          a.ApprovalOrder,
          a.Status,
          a.ActionBy,

          u.FullName AS ActionByName

        FROM Gatepass_RGP_Approval a

        LEFT JOIN user_master u
          ON u.UserID =
            a.ActionBy

        WHERE a.RGPID = $1
          AND a.IsDeleted = FALSE

        ORDER BY
          a.ApprovalOrder ASC,
          a.RGPApprovalID ASC;
        `,
        [RGPID],
      );

    // ============================================================
    // Approval Names
    // ============================================================

    let HODName =
      null;

    let FC_DOFName =
      null;

    let GMName =
      null;

    for (
      const approval
      of approvalNameResult.rows
    ) {
      const role =
        String(
          approval.approvalrole ||
            "",
        )
          .trim()
          .toUpperCase();

      const status =
        String(
          approval.status ||
            "",
        )
          .trim()
          .toUpperCase();

      if (
        status !==
        "APPROVED"
      ) {
        continue;
      }

      const actionByName =
        approval.actionbyname ||
        null;

      // HOD
      if (
        role === "HOD"
      ) {
        HODName =
          actionByName;
      }

      // FC / DOF
      else if (
        role === "FC" ||
        role === "DOF"
      ) {
        FC_DOFName =
          actionByName;
      }

      // GM
      else if (
        role === "GM"
      ) {
        GMName =
          actionByName;
      }
    }

    // ============================================================
    // Attach Approval Names
    // ============================================================

    rgp.ApprovalNames = {
      HODName,
      FC_DOFName,
      GMName,
    };

    // ============================================================
    // Generate Document URLs
    // ============================================================

    rgp.Documents =
      Array.isArray(
        rgp.Documents,
      )
        ? rgp.Documents.map(
            (document) => ({
              ...document,

              FilePath:
                document.FilePath
                  ? generateUrl(
                      document.FilePath,
                    )
                  : null,
            }),
          )
        : [];

    // ============================================================
    // Response
    // ============================================================

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
// ============================================================Update RGP Expected Return Date
const updateRGPExpectedReturnDate = async (data) => {
  try {
    const {
      RGPID,
      ExpectedReturnDate,
      ExpectedReturnDateRemarks,
      UserID,
    } = data;

    // ============================================================
    // RGP ID Validation
    // ============================================================

    if (
      !RGPID ||
      !Number.isInteger(Number(RGPID)) ||
      Number(RGPID) <= 0
    ) {
      return {
        success: false,
        statusCode: 400,
        message: "Valid RGPID is required.",
      };
    }

    // ============================================================
    // Expected Return Date Required
    // ============================================================

    if (!ExpectedReturnDate) {
      return {
        success: false,
        statusCode: 400,
        message: "ExpectedReturnDate is required.",
      };
    }

    // ============================================================
    // Date Format Validation
    // YYYY-MM-DD
    // ============================================================

    const dateRegex =
      /^\d{4}-\d{2}-\d{2}$/;

    if (
      !dateRegex.test(
        String(ExpectedReturnDate),
      )
    ) {
      return {
        success: false,
        statusCode: 400,
        message:
          "ExpectedReturnDate must be in YYYY-MM-DD format.",
      };
    }

    // ============================================================
    // Remarks Required
    // ============================================================

    if (
      !ExpectedReturnDateRemarks ||
      !String(
        ExpectedReturnDateRemarks,
      ).trim()
    ) {
      return {
        success: false,
        statusCode: 400,
        message:
          "ExpectedReturnDateRemarks is required.",
      };
    }

    // ============================================================
    // Check RGP Exists
    // ============================================================

    const existingResult =
      await pool.query(
        `
        SELECT
          RGPID,
          RGPNumber,
          ExpectedReturnDate,
          Status

        FROM Gatepass_RGP_Entry_Master

        WHERE RGPID = $1
          AND IsDeleted = FALSE

        LIMIT 1;
        `,
        [Number(RGPID)],
      );

    if (
      existingResult.rows.length === 0
    ) {
      return {
        success: false,
        statusCode: 404,
        message:
          "RGP record not found.",
      };
    }

    // ============================================================
    // Expected Return Date Validation
    //
    // New date MUST be greater than CURRENT_DATE
    // Database date used instead of server JS date
    // ============================================================

    const dateValidation =
      await pool.query(
        `
        SELECT
          $1::DATE > CURRENT_DATE
            AS IsValidDate;
        `,
        [ExpectedReturnDate],
      );

    if (
      dateValidation.rows[0]
        .isvaliddate !== true
    ) {
      return {
        success: false,
        statusCode: 400,
        message:
          "ExpectedReturnDate must be greater than the current date.",
      };
    }

    // ============================================================
    // Update Expected Return Date
    // ============================================================

    const result =
      await pool.query(
        `
        UPDATE Gatepass_RGP_Entry_Master

        SET
          ExpectedReturnDate = $1::DATE,

          ExpectedReturnDateRemarks = $2,

          ExpectedReturnDateUpdatedBy = $3,

          UpdatedBy = $3,

          UpdatedDate = CURRENT_TIMESTAMP

        WHERE RGPID = $4
          AND IsDeleted = FALSE

        RETURNING
          RGPID,
          RGPNumber,
          ExpectedReturnDate,
          ExpectedReturnDateRemarks,
          ExpectedReturnDateUpdatedBy,
          Status;
        `,
        [
          ExpectedReturnDate,
          String(
            ExpectedReturnDateRemarks,
          ).trim(),
          UserID,
          Number(RGPID),
        ],
      );

    return {
      success: true,
      statusCode: 200,
      message:
        "RGP expected return date updated successfully.",
      data: {
        RGPID:
          Number(
            result.rows[0].rgpid,
          ),

        RGPNumber:
          result.rows[0].rgpnumber,

        ExpectedReturnDate:
          formatDate(
            result.rows[0]
              .expectedreturndate,
          ),

        ExpectedReturnDateRemarks:
          result.rows[0]
            .expectedreturndateremarks,

        ExpectedReturnDateUpdatedBy:
          result.rows[0]
            .expectedreturndateupdatedby,

        Status:
          result.rows[0].status,
      },
    };
  } catch (error) {
    console.error(
      "Update RGP Expected Return Date Error:",
      error,
    );

    return databaseFailure(
      error,
      "Update RGP expected return date",
    );
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
    // Validate RGPID
    // ============================================================

    const rgpID =
      Number(RGPID);

    if (
      !Number.isInteger(rgpID) ||
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
    //
    // Supported:
    // APPROVE
    // REJECT
    // CANCEL
    // ============================================================

    const normalizedAction =
      String(Action || "")
        .trim()
        .toUpperCase();

    if (
      ![
        "APPROVE",
        "REJECT",
        "CANCEL",
      ].includes(
        normalizedAction,
      )
    ) {
      await client.query("ROLLBACK");

      return fail(
        "Action must be APPROVE, REJECT or CANCEL.",
        400,
      );
    }

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
        "You are not authorized to process RGP approval.",
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
        [rgpID],
      );

    // ============================================================
    // RGP Not Found
    // ============================================================

    if (
      !masterResult.rows.length
    ) {
      await client.query("ROLLBACK");

      return fail(
        "RGP record not found.",
        404,
      );
    }

    const master =
      masterResult.rows[0];

    // ============================================================
    // HOD Department Validation
    //
    // HOD can only take action on RGP of own department.
    // ============================================================

    if (
      approvalRole === "HOD" &&
      !(
        Number(
          data.UserDepartmentID,
        ) > 0 &&
        Number(
          data.UserDepartmentID,
        ) ===
          Number(
            master.departmentid,
          )
      )
    ) {
      await client.query("ROLLBACK");

      return fail(
        "Only the HOD of the RGP department can approve, reject or cancel this RGP.",
        403,
      );
    }

    // ============================================================
    // Current Master Status
    // ============================================================

    const currentMasterStatus =
      String(
        master.status || "",
      )
        .trim()
        .toUpperCase();

    // ============================================================
    // Final Status Checks
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
        "Rejected RGP cannot be processed further.",
        400,
      );
    }

    if (
      currentMasterStatus ===
      "CANCELLED"
    ) {
      await client.query("ROLLBACK");

      return fail(
        "Cancelled RGP cannot be processed further.",
        400,
      );
    }

    if (
      [
        "CHECKED OUT",
        "RETURN PENDING",
        "RETURNED",
      ].includes(
        currentMasterStatus,
      )
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
        [rgpID],
      );

    // ============================================================
    // Approval Flow Not Found
    // ============================================================

    if (
      !approvalResult.rows.length
    ) {
      await client.query("ROLLBACK");

      return fail(
        "RGP approval flow not found.",
        400,
      );
    }

    // ============================================================
    // Current Pending Stage
    //
    // First approval which is not Approved.
    //
    // Example:
    //
    // HOD = Approved
    // FC  = Pending   <-- Current
    // GM  = Pending
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

    // ============================================================
    // Current Approval Role
    // ============================================================

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
    // Approval Status From Action
    // ============================================================

    const approvalStatusMap = {
      APPROVE: "Approved",
      REJECT: "Rejected",
      CANCEL: "Cancelled",
    };

    const newStatus =
      approvalStatusMap[
        normalizedAction
      ];

    // ============================================================
    // Update Current Approval Row
    //
    // APPROVE -> Approved
    // REJECT  -> Rejected
    // CANCEL  -> Cancelled
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
        rgpID,
      ],
    );

    // ============================================================
    // CANCEL
    //
    // Current Approval Row:
    // Status = Cancelled
    //
    // Master:
    // Status = CANCELLED
    // CancelledBy = Current User
    // CancellationRemarks = Remarks
    //
    // Remaining approval rows stay Pending.
    // ============================================================

    if (
      normalizedAction ===
      "CANCEL"
    ) {
      await client.query(
        `
        UPDATE Gatepass_RGP_Entry_Master

        SET
          Status = 'CANCELLED',

          CancelledBy = $1,

          CancelledDateTime =
            CURRENT_TIMESTAMP,

          CancellationRemarks = $2,

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
        "RGP cancelled successfully.",
        {
          RGPID:
            Number(rgpID),

          RGPNumber:
            Number(
              master.rgpnumber,
            ),

          ApprovalRole:
            currentApprovalRole,

          ApprovalStatus:
            "CANCELLED",

          Status:
            "CANCELLED",
        },
      );
    }

    // ============================================================
    // REJECT
    //
    // Current Approval Row:
    // Status = Rejected
    //
    // Master:
    // Status = REJECTED
    // ============================================================

    if (
      normalizedAction ===
      "REJECT"
    ) {
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
          rgpID,
        ],
      );

      await client.query(
        "COMMIT",
      );

      return ok(
        "RGP rejected successfully.",
        {
          RGPID:
            Number(rgpID),

          RGPNumber:
            Number(
              master.rgpnumber,
            ),

          ApprovalRole:
            currentApprovalRole,

          ApprovalStatus:
            "REJECTED",

          Status:
            "REJECTED",
        },
      );
    }

    // ============================================================
    // APPROVE
    //
    // We reach here only when:
    // normalizedAction === "APPROVE"
    //
    // Find next approval stage.
    // ============================================================

    const currentApprovalID =
      Number(
        currentStage.rgpapprovalid,
      );

    const nextStage =
      approvalResult.rows.find(
        (row) =>
          Number(
            row.rgpapprovalid,
          ) !==
            currentApprovalID &&
          Number(
            row.approvalorder,
          ) >
            Number(
              currentStage.approvalorder,
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
    //
    // All Approvals Completed
    // Master = APPROVED
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
          rgpID,
        ],
      );

      await client.query(
        "COMMIT",
      );

      return ok(
        "RGP fully approved successfully.",
        {
          RGPID:
            Number(rgpID),

          RGPNumber:
            Number(
              master.rgpnumber,
            ),

          ApprovalRole:
            currentApprovalRole,

          ApprovalStatus:
            "APPROVED",

          Status:
            "APPROVED",
        },
      );
    }

    // ============================================================
    // Next Approval Pending
    //
    // Current approval = Approved
    // Next approval = Pending
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
        rgpID,
      ],
    );

    await client.query(
      "COMMIT",
    );

    return ok(
      "RGP approval processed successfully.",
      {
        RGPID:
          Number(rgpID),

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

        ApprovalStatus:
          "APPROVED",

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
      Documents = [],
      UserID,
    } = data;

    // ============================================================
    // Validate RGP ID
    // ============================================================

    const rgpID = Number(RGPID);

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
    // Validate Documents
    // ============================================================

    if (
      Documents !== undefined &&
      !Array.isArray(Documents)
    ) {
      await client.query("ROLLBACK");

      return fail(
        "Documents must be an array.",
        400,
      );
    }

    // ============================================================
    // Validate Each Document
    // Actual file upload already Controller/Azure side par hoga.
    // Service ko uploaded file information milegi.
    // ============================================================

    if (
      action === "CHECKOUT" &&
      Array.isArray(Documents) &&
      Documents.length > 0
    ) {
      for (
        let i = 0;
        i < Documents.length;
        i++
      ) {
        const document =
          Documents[i];

        if (
          !document ||
          typeof document !==
            "object"
        ) {
          await client.query(
            "ROLLBACK",
          );

          return fail(
            `Invalid document at index ${i}.`,
            400,
          );
        }

        const fileName =
          String(
            document.FileName ||
              "",
          ).trim();

        const filePath =
          String(
            document.FilePath ||
              "",
          ).trim();

        if (
          !fileName ||
          !filePath
        ) {
          await client.query(
            "ROLLBACK",
          );

          return fail(
            `FileName and FilePath are required for document ${i + 1}.`,
            400,
          );
        }
      }
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
    // Already Checked Out
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
      ].includes(
        currentStatus,
      )
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
    // Master APPROVED ke saath saari active approval rows
    // bhi Approved honi chahiye.
    // ============================================================

    const pendingApprovalResult =
      await client.query(
        `
        SELECT
          COUNT(*)::INT AS PendingCount

        FROM Gatepass_RGP_Approval

        WHERE RGPID = $1
          AND IsDeleted = FALSE

          AND UPPER(
                COALESCE(
                  Status,
                  'Pending'
                )
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
      // ==========================================================
      // Update RGP Master
      // ==========================================================

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
          Remarks
            ? String(
                Remarks,
              ).trim()
            : null,
          rgpID,
        ],
      );

      // ==========================================================
      // Insert Multiple Checkout Documents
      //
      // Documents example after Controller/Azure upload:
      //
      // [
      //   {
      //     FileName: "invoice.pdf",
      //     FilePath: "GatepassDocuments/abc.pdf",
      //     FileType: "application/pdf",
      //     FileSize: 125000,
      //     Remarks: "Invoice copy"
      //   },
      //   {
      //     FileName: "item.jpg",
      //     FilePath: "GatepassDocuments/xyz.jpg",
      //     FileType: "image/jpeg",
      //     FileSize: 85000,
      //     Remarks: "Item condition"
      //   }
      // ]
      // ==========================================================

      if (
        Array.isArray(Documents) &&
        Documents.length > 0
      ) {
        for (
          const document
          of Documents
        ) {
          const fileName =
            String(
              document.FileName ||
                "",
            ).trim();

          const filePath =
            String(
              document.FilePath ||
                "",
            ).trim();

          const fileType =
            document.FileType
              ? String(
                  document.FileType,
                ).trim()
              : null;

          // ======================================================
          // File Size
          // ======================================================

          let fileSize =
            null;

          if (
            document.FileSize !==
              undefined &&
            document.FileSize !==
              null &&
            document.FileSize !==
              ""
          ) {
            const parsedFileSize =
              Number(
                document.FileSize,
              );

            if (
              Number.isFinite(
                parsedFileSize,
              )
            ) {
              fileSize =
                parsedFileSize;
            }
          }

          // ======================================================
          // Individual Document Remark
          // ======================================================

          const documentRemarks =
            document.Remarks !==
              undefined &&
            document.Remarks !==
              null &&
            String(
              document.Remarks,
            ).trim() !== ""
              ? String(
                  document.Remarks,
                ).trim()
              : null;

          // ======================================================
          // Insert Document
          // ======================================================

          await client.query(
            `
            INSERT INTO Gatepass_RGP_Entry_Master_Document
            (
              RGPID,
              FileName,
              FilePath,
              FileType,
              FileSize,
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
              $6,
              FALSE,
              $7,
              CURRENT_TIMESTAMP
            );
            `,
            [
              rgpID,
              fileName,
              filePath,
              fileType,
              fileSize,
              documentRemarks,
              UserID,
            ],
          );
        }
      }

      // ==========================================================
      // Commit
      // ==========================================================

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

          DocumentsAdded:
            Array.isArray(
              Documents,
            )
              ? Documents.length
              : 0,
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

        Remarks
          ? String(
              Remarks,
            ).trim()
          : null,

        rgpID,
      ],
    );

    // ============================================================
    // Commit
    // ============================================================

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
          ActualDate,
          IsReturn,

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
          $8,
          $9,

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
          item.ActualDate ?? null,
          item.IsReturn ?? false,
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
        "RGP items returned successfully. All items have been returned."
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
  row.approvalrole,

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
  String(
    item.ApprovalRole || "",
  )
    .trim()
    .toUpperCase();

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

// RGP List Report
//
// All RGP Open
//   -> APPROVED
//
// All RGP Out
//   -> CHECKED OUT
//
// All RGP Closed
//   -> RETURNED
//
// All RGP Cancelled
//   -> CANCELLED
//
// All RGP Overdue
//   -> ExpectedReturnDate < CURRENT_DATE
//   -> Status = CHECKED OUT
//
// Date Filter Removed
// ============================================================
const getRGPListReport = async (data) => {
  try {
    // ============================================================
    // Pagination
    // ============================================================

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

    // Inclusive date range on the RGP creation date.
    const dateFilters = {};
    for (const [field, operator] of [["FromDate", ">="], ["ToDate", "<="]]) {
      const input = data[field];
      if (input === undefined || input === null || input === "") continue;

      if (typeof input !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(input)) {
        return fail(`${field} must be a valid date in YYYY-MM-DD format.`, 400);
      }

      const parsed = new Date(`${input}T00:00:00.000Z`);
      if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== input) {
        return fail(`${field} must be a valid date in YYYY-MM-DD format.`, 400);
      }

      dateFilters[field] = input;
      values.push(input);
      conditions.push(`m.CreatedDate::DATE ${operator} $${values.length}::DATE`);
    }

    if (dateFilters.FromDate && dateFilters.ToDate && dateFilters.FromDate > dateFilters.ToDate) {
      return fail("FromDate must be on or before ToDate.", 400);
    }

    // ============================================================
    // RGP Status Report Filter
    // ============================================================

    const reportStatus =
      String(
        data.Status || "",
      ).trim();

    switch (reportStatus) {
      // ==========================================================
      // All RGP Open
      // Pending and approved RGP awaiting checkout
      // ==========================================================

      case "All RGP Open":
        conditions.push(`
          UPPER(
            TRIM(
              COALESCE(
                m.Status,
                ''
              )
            )
          ) IN ('PENDING', 'APPROVED')
        `);
        break;

      // ==========================================================
      // All RGP Out
      // Only Checked Out RGP
      // ==========================================================

      case "All RGP Out":
        conditions.push(`
          UPPER(
            TRIM(
              COALESCE(
                m.Status,
                ''
              )
            )
          ) = 'CHECKED OUT'
        `);
        break;

      // ==========================================================
      // All RGP Closed
      // Only Returned RGP
      // ==========================================================

      case "All RGP Closed":
        conditions.push(`
          UPPER(
            TRIM(
              COALESCE(
                m.Status,
                ''
              )
            )
          ) = 'RETURNED'
        `);
        break;

      // ==========================================================
      // All RGP Cancelled
      // Only Cancelled RGP
      // ==========================================================

      case "All RGP Cancelled":
        conditions.push(`
          UPPER(
            TRIM(
              COALESCE(
                m.Status,
                ''
              )
            )
          ) = 'CANCELLED'
        `);
        break;

      // ==========================================================
      // All RGP Overdue
      //
      // Expected Return Date nikal chuki ho
      // AND
      // RGP abhi Checked Out ho
      // ==========================================================

      case "All RGP Overdue":
        conditions.push(`
          m.ExpectedReturnDate::DATE < CURRENT_DATE

          AND UPPER(
            TRIM(
              COALESCE(
                m.Status,
                ''
              )
            )
          ) = 'CHECKED OUT'
        `);
        break;
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
          CAST(
            m.RGPNumber AS TEXT
          ) ILIKE $${searchIndex}

          OR COALESCE(
            m.VendorName,
            ''
          ) ILIKE $${searchIndex}

          OR COALESCE(
            m.Company,
            ''
          ) ILIKE $${searchIndex}

          OR COALESCE(
            m.ContactNumber,
            ''
          ) ILIKE $${searchIndex}

          OR COALESCE(
            m.TakenBy,
            ''
          ) ILIKE $${searchIndex}

          OR COALESCE(
            d.DepartmentName,
            ''
          ) ILIKE $${searchIndex}

          OR EXISTS (
            SELECT 1

            FROM Gatepass_RGP_Entry_Item_Details si

            WHERE si.RGPID =
                    m.RGPID

              AND si.IsDeleted =
                    FALSE

              AND COALESCE(
                si.ItemName,
                ''
              ) ILIKE $${searchIndex}
          )
        )
      `);
    }

    // ============================================================
    // Where Clause
    // ============================================================

    const whereClause =
      conditions.length
        ? `WHERE ${conditions.join(
            " AND ",
          )}`
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
        countResult.rows[0]
          ?.totalcount || 0,
      );

    // ============================================================
    // Pagination
    // ============================================================

    const listValues = [
      ...values,
    ];

    listValues.push(
      pageSize,
    );

    const limitIndex =
      listValues.length;

    listValues.push(
      offset,
    );

    const offsetIndex =
      listValues.length;

    // ============================================================
    // Report Data
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

          m.CreatedDate,
          m.ModifiedDate,
          pendingApproval.ApprovalRole AS PendingApprovalRole,
          GREATEST(
            CURRENT_DATE - COALESCE(
              (
                SELECT MAX(previousApproval.StatusDateTime)::DATE
                FROM Gatepass_RGP_Approval previousApproval
                WHERE previousApproval.RGPID = m.RGPID
                  AND previousApproval.IsDeleted = FALSE
                  AND UPPER(TRIM(previousApproval.Status)) = 'APPROVED'
                  AND previousApproval.ApprovalOrder < pendingApproval.ApprovalOrder
              ),
              m.CreatedDate::DATE
            ),
            0
          ) AS PendingApprovalDays

        FROM Gatepass_RGP_Entry_Master m

        LEFT JOIN department_master d
          ON d.DepartmentID =
            m.DepartmentID

        LEFT JOIN LATERAL (
          SELECT a.ApprovalRole, a.ApprovalOrder
          FROM Gatepass_RGP_Approval a
          WHERE a.RGPID = m.RGPID
            AND a.IsDeleted = FALSE
            AND UPPER(TRIM(COALESCE(a.Status, 'Pending'))) = 'PENDING'
          ORDER BY a.ApprovalOrder ASC, a.ApprovalLevel ASC, a.RGPApprovalID ASC
          LIMIT 1
        ) pendingApproval ON TRUE

        ${whereClause}

        ORDER BY
          m.CreatedDate DESC,
          m.RGPID DESC

        LIMIT $${limitIndex}
        OFFSET $${offsetIndex};
        `,
        listValues,
      );

    // ============================================================
    // Attach Items + Approvals
    // ============================================================

    const relatedRecords =
      await attachRGPRelatedData(
        result.rows,
      );

    // ============================================================
    // Map Report Data
    // ============================================================

    const reportData =
  result.rows.map(
    (row, index) => {
      let displayStatus =
        row.status;

      const normalizedStatus =
        String(row.status || "")
          .trim()
          .toUpperCase();

      if (
        normalizedStatus === "CHECKED OUT" &&
        row.expectedreturndate
      ) {
        const expectedDate =
          new Date(row.expectedreturndate);

        const today =
          new Date();

        expectedDate.setHours(0, 0, 0, 0);
        today.setHours(0, 0, 0, 0);

        if (expectedDate < today) {
          displayStatus =
            "OVERDUE";
        }
      }

      let approvalStatus = {
        PENDING: "Pending",
        APPROVED: "Approved",
        "CHECKED OUT": "Approved",
        "RETURN PENDING": "Approved",
        RETURNED: "Approved",
        OVERDUE: "Approved",
        REJECTED: "Rejected",
        CANCELLED: "Cancelled",
      }[normalizedStatus] || row.status;

      if (normalizedStatus === "PENDING" && row.pendingapprovalrole) {
        approvalStatus = `Pending from ${String(row.pendingapprovalrole).trim()} since ${Number(row.pendingapprovaldays) || 0} day(s)`;
      }

      const { pendingapprovalrole, pendingapprovaldays, ...reportRow } = row;

      const rgpStatus = {
        PENDING: "Open",
        APPROVED: "Open",
        "CHECKED OUT": "Checkout",
        "RETURN PENDING": "Return Pending",
        RETURNED: "Returned",
        OVERDUE: "Overdue",
        REJECTED: "Rejected",
        CANCELLED: "Cancelled",
      }[String(displayStatus || "").trim().toUpperCase()] || displayStatus;

      return {
        ...reportRow,

        ApprovalStatus: approvalStatus,
        RGPStatus: rgpStatus,

        status:
          displayStatus,

        expectedreturndate:
          formatDate(
            row.expectedreturndate,
          ),

        createddate:
          formatDate(
            row.createddate,
          ),

        modifieddate:
          formatDate(
            row.modifieddate,
          ),

        Items:
          relatedRecords[index]
            .Items,

        Approvals:
          relatedRecords[index]
            .Approvals,
      };
    },
  );

    // ============================================================
    // Response
    // ============================================================

    return ok(
      "RGP list report fetched successfully.",
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
      "Fetch RGP list report",
    );
  }
};
// ============================================================Department Wise Report
const getRGPDepartmentWiseReport = async (data) => {
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
        `%${String(
          data.Search,
        ).trim()}%`,
      );

      conditions.push(
        `d.DepartmentName ILIKE $${values.length}`,
      );
    }

    const whereClause =
      `WHERE ${conditions.join(
        " AND ",
      )}`;

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

          -- ======================================================
          -- Total RGP
          -- ======================================================

          COUNT(
            DISTINCT m.RGPID
          )::BIGINT AS TotalRGP,

          -- ======================================================
          -- Pending RGP
          --
          -- At least one approval Pending hona chahiye.
          -- Rejected / Cancelled pending me count nahi honge.
          -- ======================================================

          COUNT(
            DISTINCT m.RGPID
          ) FILTER (
            WHERE
              EXISTS (
                SELECT 1

                FROM Gatepass_RGP_Approval a

                WHERE a.RGPID =
                        m.RGPID

                  AND a.IsDeleted =
                        FALSE

                  AND UPPER(
                    TRIM(
                      COALESCE(
                        a.Status,
                        'PENDING'
                      )
                    )
                  ) = 'PENDING'
              )

              AND NOT EXISTS (
                SELECT 1

                FROM Gatepass_RGP_Approval a

                WHERE a.RGPID =
                        m.RGPID

                  AND a.IsDeleted =
                        FALSE

                  AND UPPER(
                    TRIM(
                      COALESCE(
                        a.Status,
                        'PENDING'
                      )
                    )
                  ) IN (
                    'REJECTED',
                    'CANCELLED'
                  )
              )
          )::BIGINT AS PendingRGP,

          -- ======================================================
          -- Approved RGP
          --
          -- 1. Approval rows honi chahiye.
          -- 2. Saare approval stages APPROVED hone chahiye.
          -- 3. Master Status APPROVED hona chahiye.
          --
          -- CHECKED OUT / RETURN PENDING / RETURNED yahan
          -- count nahi honge.
          -- ======================================================

          COUNT(
            DISTINCT m.RGPID
          ) FILTER (
            WHERE

              UPPER(
                TRIM(
                  COALESCE(
                    m.Status,
                    ''
                  )
                )
              ) = 'APPROVED'

              AND EXISTS (
                SELECT 1

                FROM Gatepass_RGP_Approval a

                WHERE a.RGPID =
                        m.RGPID

                  AND a.IsDeleted =
                        FALSE
              )

              AND NOT EXISTS (
                SELECT 1

                FROM Gatepass_RGP_Approval a

                WHERE a.RGPID =
                        m.RGPID

                  AND a.IsDeleted =
                        FALSE

                  AND UPPER(
                    TRIM(
                      COALESCE(
                        a.Status,
                        'PENDING'
                      )
                    )
                  ) <> 'APPROVED'
              )
          )::BIGINT AS ApprovedRGP,

          -- ======================================================
          -- Rejected RGP
          -- ======================================================

          COUNT(
            DISTINCT m.RGPID
          ) FILTER (
            WHERE
              EXISTS (
                SELECT 1

                FROM Gatepass_RGP_Approval a

                WHERE a.RGPID =
                        m.RGPID

                  AND a.IsDeleted =
                        FALSE

                  AND UPPER(
                    TRIM(
                      COALESCE(
                        a.Status,
                        ''
                      )
                    )
                  ) = 'REJECTED'
              )
          )::BIGINT AS RejectedRGP,

          -- ======================================================
          -- Cancelled RGP
          -- ======================================================

          COUNT(
            DISTINCT m.RGPID
          ) FILTER (
            WHERE
              EXISTS (
                SELECT 1

                FROM Gatepass_RGP_Approval a

                WHERE a.RGPID =
                        m.RGPID

                  AND a.IsDeleted =
                        FALSE

                  AND UPPER(
                    TRIM(
                      COALESCE(
                        a.Status,
                        ''
                      )
                    )
                  ) = 'CANCELLED'
              )
          )::BIGINT AS CancelledRGP,

          -- ======================================================
          -- Out RGP
          -- Checkout completed
          -- ======================================================

          COUNT(
            DISTINCT m.RGPID
          ) FILTER (
            WHERE
              UPPER(
                TRIM(
                  COALESCE(
                    m.Status,
                    ''
                  )
                )
              ) = 'CHECKED OUT'
          )::BIGINT AS OutRGP,

          -- ======================================================
          -- Closed / Returned RGP
          -- ======================================================

          COUNT(
            DISTINCT m.RGPID
          ) FILTER (
            WHERE
              UPPER(
                TRIM(
                  COALESCE(
                    m.Status,
                    ''
                  )
                )
              ) = 'RETURNED'
          )::BIGINT AS ClosedRGP,

          -- ======================================================
          -- Overdue RGP
          -- Existing 30 Days Condition
          -- ======================================================

          COUNT(
            DISTINCT m.RGPID
          ) FILTER (
            WHERE
              m.ExpectedReturnDate <
                (
                  CURRENT_DATE -
                  INTERVAL '30 days'
                )

              AND UPPER(
                TRIM(
                  COALESCE(
                    m.Status,
                    ''
                  )
                )
              ) IN (
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

    // ============================================================
    // Map Response
    // ============================================================

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

          PendingRGP:
            Number(
              row.pendingrgp,
            ),

          ApprovedRGP:
            Number(
              row.approvedrgp,
            ),

          RejectedRGP:
            Number(
              row.rejectedrgp,
            ),

          CancelledRGP:
            Number(
              row.cancelledrgp,
            ),

          OutRGP:
            Number(
              row.outrgp,
            ),

          ClosedRGP:
            Number(
              row.closedrgp,
            ),

          OverdueRGP:
            Number(
              row.overduergp,
            ),
        }),
      );

    // ============================================================
    // Response
    // ============================================================

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

          -- ======================================================
          -- Total RGP
          -- ======================================================

          COUNT(
            DISTINCT m.RGPID
          )::BIGINT AS TotalRGP,

          -- ======================================================
          -- Pending RGP
          -- ======================================================

          COUNT(
            DISTINCT m.RGPID
          ) FILTER (
            WHERE
              EXISTS (
                SELECT 1

                FROM Gatepass_RGP_Approval a

                WHERE a.RGPID =
                        m.RGPID

                  AND a.IsDeleted =
                        FALSE

                  AND UPPER(
                    TRIM(
                      COALESCE(
                        a.Status,
                        'PENDING'
                      )
                    )
                  ) = 'PENDING'
              )

              AND NOT EXISTS (
                SELECT 1

                FROM Gatepass_RGP_Approval a

                WHERE a.RGPID =
                        m.RGPID

                  AND a.IsDeleted =
                        FALSE

                  AND UPPER(
                    TRIM(
                      COALESCE(
                        a.Status,
                        'PENDING'
                      )
                    )
                  ) IN (
                    'REJECTED',
                    'CANCELLED'
                  )
              )
          )::BIGINT AS PendingRGP,

          -- ======================================================
          -- Approved RGP
          --
          -- All approval stages APPROVED hone chahiye
          -- AND
          -- Master status APPROVED hona chahiye.
          --
          -- Checkout ke baad master CHECKED OUT ho jayega,
          -- isliye ApprovedRGP me count nahi hoga.
          -- ======================================================

          COUNT(
            DISTINCT m.RGPID
          ) FILTER (
            WHERE

              UPPER(
                TRIM(
                  COALESCE(
                    m.Status,
                    ''
                  )
                )
              ) = 'APPROVED'

              AND EXISTS (
                SELECT 1

                FROM Gatepass_RGP_Approval a

                WHERE a.RGPID =
                        m.RGPID

                  AND a.IsDeleted =
                        FALSE
              )

              AND NOT EXISTS (
                SELECT 1

                FROM Gatepass_RGP_Approval a

                WHERE a.RGPID =
                        m.RGPID

                  AND a.IsDeleted =
                        FALSE

                  AND UPPER(
                    TRIM(
                      COALESCE(
                        a.Status,
                        'PENDING'
                      )
                    )
                  ) <> 'APPROVED'
              )
          )::BIGINT AS ApprovedRGP,

          -- ======================================================
          -- Rejected RGP
          -- ======================================================

          COUNT(
            DISTINCT m.RGPID
          ) FILTER (
            WHERE
              EXISTS (
                SELECT 1

                FROM Gatepass_RGP_Approval a

                WHERE a.RGPID =
                        m.RGPID

                  AND a.IsDeleted =
                        FALSE

                  AND UPPER(
                    TRIM(
                      COALESCE(
                        a.Status,
                        ''
                      )
                    )
                  ) = 'REJECTED'
              )
          )::BIGINT AS RejectedRGP,

          -- ======================================================
          -- Cancelled RGP
          -- ======================================================

          COUNT(
            DISTINCT m.RGPID
          ) FILTER (
            WHERE
              EXISTS (
                SELECT 1

                FROM Gatepass_RGP_Approval a

                WHERE a.RGPID =
                        m.RGPID

                  AND a.IsDeleted =
                        FALSE

                  AND UPPER(
                    TRIM(
                      COALESCE(
                        a.Status,
                        ''
                      )
                    )
                  ) = 'CANCELLED'
              )
          )::BIGINT AS CancelledRGP,

          -- ======================================================
          -- Out RGP
          -- ======================================================

          COUNT(
            DISTINCT m.RGPID
          ) FILTER (
            WHERE
              UPPER(
                TRIM(
                  COALESCE(
                    m.Status,
                    ''
                  )
                )
              ) = 'CHECKED OUT'
          )::BIGINT AS OutRGP,

          -- ======================================================
          -- Closed RGP
          -- ======================================================

          COUNT(
            DISTINCT m.RGPID
          ) FILTER (
            WHERE
              UPPER(
                TRIM(
                  COALESCE(
                    m.Status,
                    ''
                  )
                )
              ) = 'RETURNED'
          )::BIGINT AS ClosedRGP,

          -- ======================================================
          -- Overdue RGP
          -- Existing 30 Days Condition
          -- ======================================================

          COUNT(
            DISTINCT m.RGPID
          ) FILTER (
            WHERE
              m.ExpectedReturnDate <
                (
                  CURRENT_DATE -
                  INTERVAL '30 days'
                )

              AND UPPER(
                TRIM(
                  COALESCE(
                    m.Status,
                    ''
                  )
                )
              ) IN (
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

    // ============================================================
    // Map Response
    // ============================================================

    const reportData =
      result.rows.map(
        (row) => ({
          VendorName:
            row.vendorname,

          TotalRGP:
            Number(
              row.totalrgp,
            ),

          PendingRGP:
            Number(
              row.pendingrgp,
            ),

          ApprovedRGP:
            Number(
              row.approvedrgp,
            ),

          RejectedRGP:
            Number(
              row.rejectedrgp,
            ),

          CancelledRGP:
            Number(
              row.cancelledrgp,
            ),

          OutRGP:
            Number(
              row.outrgp,
            ),

          ClosedRGP:
            Number(
              row.closedrgp,
            ),

          OverdueRGP:
            Number(
              row.overduergp,
            ),
        }),
      );

    // ============================================================
    // Response
    // ============================================================

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
ExpectedReturnDate:
  row.expectedreturndate
    ? formatDate(row.expectedreturndate)
    : null,

CheckoutDateTime:
  row.checkoutdatetime
    ? formatDate(row.checkoutdatetime)
    : null,

CreatedDate:
  row.createddate
    ? formatDate(row.createddate)
    : null,

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
// ============================================================RGP Red Flag Report
const getRGPRedFlagReport = async (data) => {
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

      // RGP bahar hona chahiye
      `
      UPPER(
        TRIM(
          COALESCE(
            m.Status,
            ''
          )
        )
      ) IN (
        'CHECKED OUT',
        'RETURN PENDING'
      )
      `,

      // Item fully returned nahi hona chahiye
      `
      COALESCE(
        i.IsReturned,
        FALSE
      ) = FALSE
      `,

      // Quantity abhi pending honi chahiye
      `
      COALESCE(
        i.RemainingQuantity,
        0
      ) > 0
      `,

      // Expected Return Date + 30 Days cross
      `
      m.ExpectedReturnDate IS NOT NULL
      AND m.ExpectedReturnDate::DATE <=
        (
          CURRENT_DATE -
          INTERVAL '30 days'
        )
      `,
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
          CAST(
            m.RGPNumber AS TEXT
          ) ILIKE $${searchIndex}

          OR COALESCE(
            m.VendorName,
            ''
          ) ILIKE $${searchIndex}

          OR COALESCE(
            m.Company,
            ''
          ) ILIKE $${searchIndex}

          OR COALESCE(
            m.ContactNumber,
            ''
          ) ILIKE $${searchIndex}

          OR COALESCE(
            m.TakenBy,
            ''
          ) ILIKE $${searchIndex}

          OR COALESCE(
            d.DepartmentName,
            ''
          ) ILIKE $${searchIndex}

          OR COALESCE(
            i.ItemName,
            ''
          ) ILIKE $${searchIndex}

          OR COALESCE(
            i.Specification,
            ''
          ) ILIKE $${searchIndex}

          OR COALESCE(
            i.SerialNumber,
            ''
          ) ILIKE $${searchIndex}
        )
      `);
    }

    // ============================================================
    // Where Clause
    // ============================================================

    const whereClause =
      `WHERE ${conditions.join(
        " AND ",
      )}`;

    // ============================================================
    // Total Count
    // Item Wise Count
    // ============================================================

    const countResult =
      await pool.query(
        `
        SELECT
          COUNT(*)::BIGINT AS TotalCount

        FROM Gatepass_RGP_Entry_Master m

        INNER JOIN Gatepass_RGP_Entry_Item_Details i
          ON i.RGPID =
            m.RGPID

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
    // Red Flag Report Data
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

          m.DepartmentID,
          d.DepartmentName,

          m.TakenBy,

          m.ExpectedReturnDate,

          m.Status,

          m.CheckoutDateTime,

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

          (
            CURRENT_DATE -
            m.ExpectedReturnDate::DATE
          )::INTEGER AS OverdueDays

        FROM Gatepass_RGP_Entry_Master m

        INNER JOIN Gatepass_RGP_Entry_Item_Details i
          ON i.RGPID =
            m.RGPID

        LEFT JOIN department_master d
          ON d.DepartmentID =
            m.DepartmentID

        ${whereClause}

        ORDER BY
          OverdueDays DESC,
          m.RGPNumber DESC,
          i.RGPItemID ASC

        LIMIT $${limitIndex}
        OFFSET $${offsetIndex};
        `,
        reportValues,
      );

    // ============================================================
    // Map Response
    // ============================================================

    const reportData =
      result.rows.map(
        (row) => ({
          RGPID:
            Number(
              row.rgpid,
            ),

          RGPNumber:
            Number(
              row.rgpnumber,
            ),

          OrganizationID:
            Number(
              row.organizationid,
            ),

          VendorName:
            row.vendorname,

          ContactNumber:
            row.contactnumber,

          Company:
            row.company,

          DepartmentID:
            row.departmentid
              ? Number(
                  row.departmentid,
                )
              : null,

          DepartmentName:
            row.departmentname,

          TakenBy:
            row.takenby,

          ExpectedReturnDate:
            row.expectedreturndate
              ? formatDate(
                  row.expectedreturndate,
                )
              : null,

          Status:
            row.status,

          CheckoutDateTime:
            row.checkoutdatetime
              ? formatDate(
                  row.checkoutdatetime,
                )
              : null,

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
              row.quantity || 0,
            ),

          Unit:
            row.unit,

          Rate:
            Number(
              row.rate || 0,
            ),

          MakeModel:
            row.makemodel,

          SerialNumber:
            row.serialnumber,

          ReturnedQuantity:
            Number(
              row.returnedquantity ||
                0,
            ),

          RemainingQuantity:
            Number(
              row.remainingquantity ||
                0,
            ),

          IsReturned:
            Boolean(
              row.isreturned,
            ),

          OverdueDays:
            Number(
              row.overduedays ||
                0,
            ),
        }),
      );

    // ============================================================
    // Response
    // ============================================================

    return ok(
      "RGP red flag report fetched successfully.",
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
      "Fetch RGP red flag report",
    );
  }
};
// ========================================================================PDF
const getRGPReportOrganizationName = async (organizationID) => {
  if (!organizationID) return "All Organizations";
  const result = await pool.query(
    `SELECT OrganizationName FROM Organization_Master WHERE OrganizationID = $1 LIMIT 1;`,
    [organizationID],
  );
  return result.rows[0]?.organizationname || "-";
};
// ============================================================RGP List Report PDF
const getRGPListReportPdf = async (data) => {
  try {
    // ============================================================
    // Organization Name
    // ============================================================

    const organizationName =
      await getRGPReportOrganizationName(
        data.OrganizationID,
      );

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

    // Inclusive date range on the RGP creation date.
    const dateFilters = {};
    for (const [field, operator] of [["FromDate", ">="], ["ToDate", "<="]]) {
      const input = data[field];
      if (input === undefined || input === null || input === "") continue;

      if (typeof input !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(input)) {
        return fail(`${field} must be a valid date in YYYY-MM-DD format.`, 400);
      }

      const parsed = new Date(`${input}T00:00:00.000Z`);
      if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== input) {
        return fail(`${field} must be a valid date in YYYY-MM-DD format.`, 400);
      }

      dateFilters[field] = input;
      values.push(input);
      conditions.push(`m.CreatedDate::DATE ${operator} $${values.length}::DATE`);
    }

    if (dateFilters.FromDate && dateFilters.ToDate && dateFilters.FromDate > dateFilters.ToDate) {
      return fail("FromDate must be on or before ToDate.", 400);
    }

    // ============================================================
    // RGP Status Report Filter
    // ============================================================

    const reportStatus =
      String(
        data.Status || "",
      ).trim();

    switch (reportStatus) {
      // ==========================================================
      // All RGP Open
      // Pending and approved RGP awaiting checkout
      // ==========================================================

      case "All RGP Open":
        conditions.push(`
          UPPER(
            TRIM(
              COALESCE(
                m.Status,
                ''
              )
            )
          ) IN ('PENDING', 'APPROVED')
        `);
        break;

      // ==========================================================
      // All RGP Out
      // Only CHECKED OUT
      // ==========================================================

      case "All RGP Out":
        conditions.push(`
          UPPER(
            TRIM(
              COALESCE(
                m.Status,
                ''
              )
            )
          ) = 'CHECKED OUT'
        `);
        break;

      // ==========================================================
      // All RGP Closed
      // Only RETURNED
      // ==========================================================

      case "All RGP Closed":
        conditions.push(`
          UPPER(
            TRIM(
              COALESCE(
                m.Status,
                ''
              )
            )
          ) = 'RETURNED'
        `);
        break;

      // ==========================================================
      // All RGP Cancelled
      // Only CANCELLED
      // ==========================================================

      case "All RGP Cancelled":
        conditions.push(`
          UPPER(
            TRIM(
              COALESCE(
                m.Status,
                ''
              )
            )
          ) = 'CANCELLED'
        `);
        break;

      // ==========================================================
      // All RGP Overdue
      // Expected Return Date Passed + Still Checked Out
      // ==========================================================

      case "All RGP Overdue":
        conditions.push(`
          m.ExpectedReturnDate::DATE <
            CURRENT_DATE

          AND UPPER(
            TRIM(
              COALESCE(
                m.Status,
                ''
              )
            )
          ) = 'CHECKED OUT'
        `);
        break;
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
          CAST(
            m.RGPNumber AS TEXT
          ) ILIKE $${searchIndex}

          OR COALESCE(
            m.VendorName,
            ''
          ) ILIKE $${searchIndex}

          OR COALESCE(
            m.Company,
            ''
          ) ILIKE $${searchIndex}

          OR COALESCE(
            m.ContactNumber,
            ''
          ) ILIKE $${searchIndex}

          OR COALESCE(
            m.TakenBy,
            ''
          ) ILIKE $${searchIndex}

          OR COALESCE(
            d.DepartmentName,
            ''
          ) ILIKE $${searchIndex}

          OR EXISTS (
            SELECT 1

            FROM Gatepass_RGP_Entry_Item_Details si

            WHERE si.RGPID =
                    m.RGPID

              AND si.IsDeleted =
                    FALSE

              AND COALESCE(
                    si.ItemName,
                    ''
                  ) ILIKE $${searchIndex}
          )
        )
      `);
    }

    // ============================================================
    // Where Clause
    // ============================================================

    const whereClause =
      conditions.length
        ? `WHERE ${conditions.join(
            " AND ",
          )}`
        : "";

    // ============================================================
    // Get RGP Records
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

          m.CreatedDate,
          m.ModifiedDate,
          pendingApproval.ApprovalRole AS PendingApprovalRole,
          GREATEST(
            CURRENT_DATE - COALESCE(
              (
                SELECT MAX(previousApproval.StatusDateTime)::DATE
                FROM Gatepass_RGP_Approval previousApproval
                WHERE previousApproval.RGPID = m.RGPID
                  AND previousApproval.IsDeleted = FALSE
                  AND UPPER(TRIM(previousApproval.Status)) = 'APPROVED'
                  AND previousApproval.ApprovalOrder < pendingApproval.ApprovalOrder
              ),
              m.CreatedDate::DATE
            ),
            0
          ) AS PendingApprovalDays,
          lastApproval.Remarks AS LastApprovalRemarks

        FROM Gatepass_RGP_Entry_Master m

        LEFT JOIN department_master d
          ON d.DepartmentID =
            m.DepartmentID

        LEFT JOIN LATERAL (
          SELECT a.ApprovalRole, a.ApprovalOrder
          FROM Gatepass_RGP_Approval a
          WHERE a.RGPID = m.RGPID
            AND a.IsDeleted = FALSE
            AND UPPER(TRIM(COALESCE(a.Status, 'Pending'))) = 'PENDING'
          ORDER BY a.ApprovalOrder ASC, a.ApprovalLevel ASC, a.RGPApprovalID ASC
          LIMIT 1
        ) pendingApproval ON TRUE

        LEFT JOIN LATERAL (
          SELECT a.Remarks
          FROM Gatepass_RGP_Approval a
          WHERE a.RGPID = m.RGPID
            AND a.IsDeleted = FALSE
            AND UPPER(TRIM(a.Status)) IN ('APPROVED', 'REJECTED', 'CANCELLED')
          ORDER BY a.StatusDateTime DESC NULLS LAST,
                   a.ApprovalOrder DESC, a.RGPApprovalID DESC
          LIMIT 1
        ) lastApproval ON TRUE

        ${whereClause}

        ORDER BY
          m.CreatedDate DESC,
          m.RGPID DESC;
        `,
        values,
      );

    // ============================================================
    // Attach RGP Items + Approvals
    // ============================================================

    const relatedRecords =
      await attachRGPRelatedData(
        result.rows,
      );

    // ============================================================
    // Format Report Data
    // ============================================================

    const reportData =
  result.rows.map(
    (row, index) => {
      let displayStatus =
        row.status;

      const normalizedStatus =
        String(row.status || "")
          .trim()
          .toUpperCase();

      if (
        normalizedStatus === "CHECKED OUT" &&
        row.expectedreturndate
      ) {
        const expectedDate =
          new Date(row.expectedreturndate);

        const today =
          new Date();

        expectedDate.setHours(0, 0, 0, 0);
        today.setHours(0, 0, 0, 0);

        if (expectedDate < today) {
          displayStatus =
            "OVERDUE";
        }
      }

      let approvalStatus = {
        PENDING: "Pending",
        APPROVED: "Approved",
        "CHECKED OUT": "Approved",
        "RETURN PENDING": "Approved",
        RETURNED: "Approved",
        OVERDUE: "Approved",
        REJECTED: "Rejected",
        CANCELLED: "Cancelled",
      }[normalizedStatus] || row.status;

      if (normalizedStatus === "PENDING" && row.pendingapprovalrole) {
        approvalStatus = `Pending from ${String(row.pendingapprovalrole).trim()} since ${Number(row.pendingapprovaldays) || 0} day(s)`;
      }

      const lastApprovalRemarks = String(row.lastapprovalremarks || "").trim();
      if (lastApprovalRemarks) {
        approvalStatus += `\nRemarks: ${lastApprovalRemarks}`;
      }

      const { pendingapprovalrole, pendingapprovaldays, lastapprovalremarks, ...reportRow } = row;

      const rgpStatus = {
        PENDING: "Open",
        APPROVED: "Open",
        "CHECKED OUT": "Checkout",
        "RETURN PENDING": "Return Pending",
        RETURNED: "Returned",
        OVERDUE: "Overdue",
        REJECTED: "Rejected",
        CANCELLED: "Cancelled",
      }[String(displayStatus || "").trim().toUpperCase()] || displayStatus;

      return {
        ...reportRow,

        ApprovalStatus: approvalStatus,
        RGPStatus: rgpStatus,

        status:
          displayStatus,

        expectedreturndate:
          formatDate(
            row.expectedreturndate,
          ),

        createddate:
          formatDate(
            row.createddate,
          ),

        modifieddate:
          formatDate(
            row.modifieddate,
          ),

        Items:
          relatedRecords[index]
            .Items,

        Approvals:
          relatedRecords[index]
            .Approvals,
      };
    },
  );

    // ============================================================
    // Total Records
    //
    // IMPORTANT:
    // This is RGP record count, NOT flattened item row count.
    // ============================================================

    const totalRecords =
      result.rows.length;

    // ============================================================
    // PDF Rows
    //
    // UI Fields:
    // #SR
    // RGP No.
    // Vendor / Company
    // Contact
    // Department
    // Taken By
    // Expected Return
    // Items
    // Status
    // Created On
    //
    // Multiple Items:
    // Parent details only on first item row.
    // ============================================================

    let srNo = 1;

    const pdfRows =
      reportData.flatMap(
        (rgp) => {
          const items =
            Array.isArray(
              rgp.Items,
            ) &&
            rgp.Items.length > 0
              ? rgp.Items
              : [{}];

          return items.map(
            (item, index) => {
              const quantity =
                item.Quantity ??
                item.quantity;

              return {
                SR:
                  index === 0
                    ? srNo++
                    : "",

                RGPNumber:
                  index === 0
                    ? rgp.rgpnumber ??
                      "-"
                    : "",

                VendorCompany:
                  index === 0
                    ? [
                        rgp.vendorname,
                        rgp.company,
                      ]
                        .filter(
                          (value) =>
                            value !==
                              null &&
                            value !==
                              undefined &&
                            String(
                              value,
                            ).trim() !==
                              "",
                        )
                        .join(" / ") ||
                      "-"
                    : "",

                Contact:
                  index === 0
                    ? rgp.contactnumber ||
                      "-"
                    : "",

                DepartmentName:
                  index === 0
                    ? rgp.departmentname ||
                      "-"
                    : "",

                TakenBy:
                  index === 0
                    ? rgp.takenby ||
                      "-"
                    : "",

                ExpectedReturnDate:
                  index === 0
                    ? rgp.expectedreturndate ||
                      "-"
                    : "",

                Item:
                  `${
                    item.ItemName ??
                    item.itemname ??
                    "-"
                  }${
                    quantity !==
                      null &&
                    quantity !==
                      undefined &&
                    quantity !==
                      ""
                      ? ` - ${quantity}`
                      : ""
                  }`,

                ApprovalStatus:
                  index === 0 ? rgp.ApprovalStatus || "-" : "",

                RGPStatus:
                  index === 0 ? rgp.RGPStatus || "-" : "",

                ModifiedOn:
                  index === 0 ? rgp.modifieddate || "-" : "",

                CreatedOn:
                  index === 0
                    ? rgp.createddate ||
                      "-"
                    : "",
              };
            },
          );
        },
      );

    // ============================================================
    // PDF Metadata
    // ============================================================

    const metadata = [
      {
        label:
          "Organization",

        value:
          organizationName,
      },
      {
        label:
          "Status",

        value:
          reportStatus ||
          "All",
      },
      {
        label:
          "Department",

        value:
          data.DepartmentName ||
          "All Department",
      },
      {
        label:
          "Total Records",

        value:
          totalRecords,
      },
    ];

    // ============================================================
    // Generate PDF
    // ============================================================

    const pdfBuffer =
      await generatePdf({
        title:
          "RGP LIST REPORT",

        reportName:
          "RGP List Report",

        organizationId:
          data.OrganizationID,

        orientation:
          "landscape",

        metadata,

        columns: [
          {
                    "header": "SR#",
                    "key": "SR",
                    "width": 20
          },
          {
                    "header": "RGP No.",
                    "key": "RGPNumber",
                    "width": 35
          },
          {
                    "header": "Vendor / Company",
                    "key": "VendorCompany",
                    "width": 70
          },
          {
                    "header": "Contact",
                    "key": "Contact",
                    "width": 50
          },
          {
                    "header": "Department",
                    "key": "DepartmentName",
                    "width": 50
          },
          {
                    "header": "Taken By",
                    "key": "TakenBy",
                    "width": 45
          },
          {
                    "header": "Items - Qty",
                    "key": "Item",
                    "width": "*"
          },
          {
                    "header": "Approval Status",
                    "key": "ApprovalStatus",
                    "width": 95
          },
          {
                    "header": "RGP Status",
                    "key": "RGPStatus",
                    "width": 50
          },
          {
                    "header": "Expected Return",
                    "key": "ExpectedReturnDate",
                    "width": 55
          },
          {
                    "header": "Last Updated",
                    "key": "ModifiedOn",
                    "width": 55
          },
          {
                    "header": "Created On",
                    "key": "CreatedOn",
                    "width": 55
          }
],

        rows:
          pdfRows,
      });

    // ============================================================
    // Response
    // ============================================================

    return {
      success:
        true,

      message:
        "RGP list report PDF generated successfully.",

      data:
        pdfBuffer,
    };
  } catch (error) {
    console.error(
      "RGP List Report PDF Error:",
      error,
    );

    return databaseFailure(
      error,
      "Generate RGP list report PDF",
    );
  }
};
// ============================================================Department Wise Report PDF
const getRGPDepartmentWiseReportPdf = async (data) => {
  try {
    const organizationName =
      await getRGPReportOrganizationName(
        data.OrganizationID,
      );

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
        `%${String(
          data.Search,
        ).trim()}%`,
      );

      conditions.push(
        `d.DepartmentName ILIKE $${values.length}`,
      );
    }

    const whereClause =
      `WHERE ${conditions.join(" AND ")}`;

    // ============================================================
    // Department Wise Report
    // SAME CONDITIONS AS GET API
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

          -- ======================================================
          -- Total RGP
          -- ======================================================

          COUNT(
            DISTINCT m.RGPID
          )::BIGINT AS TotalRGP,

          -- ======================================================
          -- Pending RGP
          --
          -- At least one approval is Pending
          -- AND no approval is Rejected / Cancelled
          -- ======================================================

          COUNT(
            DISTINCT m.RGPID
          ) FILTER (
            WHERE
              EXISTS (
                SELECT 1

                FROM Gatepass_RGP_Approval a

                WHERE a.RGPID =
                        m.RGPID

                  AND a.IsDeleted =
                        FALSE

                  AND UPPER(
                    TRIM(
                      COALESCE(
                        a.Status,
                        'PENDING'
                      )
                    )
                  ) = 'PENDING'
              )

              AND NOT EXISTS (
                SELECT 1

                FROM Gatepass_RGP_Approval a

                WHERE a.RGPID =
                        m.RGPID

                  AND a.IsDeleted =
                        FALSE

                  AND UPPER(
                    TRIM(
                      COALESCE(
                        a.Status,
                        'PENDING'
                      )
                    )
                  ) IN (
                    'REJECTED',
                    'CANCELLED'
                  )
              )
          )::BIGINT AS PendingRGP,

          -- ======================================================
          -- Approved RGP
          --
          -- Approval rows must exist
          -- AND every active approval must be APPROVED
          -- AND master status must still be APPROVED
          -- CHECKED OUT RGP will not be counted here
          -- ======================================================

          COUNT(
            DISTINCT m.RGPID
          ) FILTER (
            WHERE
              UPPER(
                TRIM(
                  COALESCE(
                    m.Status,
                    ''
                  )
                )
              ) = 'APPROVED'

              AND EXISTS (
                SELECT 1

                FROM Gatepass_RGP_Approval a

                WHERE a.RGPID =
                        m.RGPID

                  AND a.IsDeleted =
                        FALSE
              )

              AND NOT EXISTS (
                SELECT 1

                FROM Gatepass_RGP_Approval a

                WHERE a.RGPID =
                        m.RGPID

                  AND a.IsDeleted =
                        FALSE

                  AND UPPER(
                    TRIM(
                      COALESCE(
                        a.Status,
                        'PENDING'
                      )
                    )
                  ) <> 'APPROVED'
              )
          )::BIGINT AS ApprovedRGP,

          -- ======================================================
          -- Rejected RGP
          -- ======================================================

          COUNT(
            DISTINCT m.RGPID
          ) FILTER (
            WHERE EXISTS (
              SELECT 1

              FROM Gatepass_RGP_Approval a

              WHERE a.RGPID =
                      m.RGPID

                AND a.IsDeleted =
                      FALSE

                AND UPPER(
                  TRIM(
                    COALESCE(
                      a.Status,
                      ''
                    )
                  )
                ) = 'REJECTED'
            )
          )::BIGINT AS RejectedRGP,

          -- ======================================================
          -- Cancelled RGP
          -- ======================================================

          COUNT(
            DISTINCT m.RGPID
          ) FILTER (
            WHERE EXISTS (
              SELECT 1

              FROM Gatepass_RGP_Approval a

              WHERE a.RGPID =
                      m.RGPID

                AND a.IsDeleted =
                      FALSE

                AND UPPER(
                  TRIM(
                    COALESCE(
                      a.Status,
                      ''
                    )
                  )
                ) = 'CANCELLED'
            )
          )::BIGINT AS CancelledRGP,

          -- ======================================================
          -- Out RGP
          -- ======================================================

          COUNT(
            DISTINCT m.RGPID
          ) FILTER (
            WHERE UPPER(
              TRIM(
                COALESCE(
                  m.Status,
                  ''
                )
              )
            ) = 'CHECKED OUT'
          )::BIGINT AS OutRGP,

          -- ======================================================
          -- Closed RGP
          -- ======================================================

          COUNT(
            DISTINCT m.RGPID
          ) FILTER (
            WHERE UPPER(
              TRIM(
                COALESCE(
                  m.Status,
                  ''
                )
              )
            ) = 'RETURNED'
          )::BIGINT AS ClosedRGP,

          -- ======================================================
          -- Overdue RGP
          -- SAME 30 DAYS CONDITION AS GET API
          -- ======================================================

          COUNT(
            DISTINCT m.RGPID
          ) FILTER (
            WHERE
              m.ExpectedReturnDate <
                (
                  CURRENT_DATE -
                  INTERVAL '30 days'
                )

              AND UPPER(
                TRIM(
                  COALESCE(
                    m.Status,
                    ''
                  )
                )
              ) IN (
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
          d.DepartmentName ASC;
        `,
        values,
      );

    // ============================================================
    // Response Mapping
    // ============================================================

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

          PendingRGP:
            Number(
              row.pendingrgp,
            ),

          ApprovedRGP:
            Number(
              row.approvedrgp,
            ),

          RejectedRGP:
            Number(
              row.rejectedrgp,
            ),

          CancelledRGP:
            Number(
              row.cancelledrgp,
            ),

          OutRGP:
            Number(
              row.outrgp,
            ),

          ClosedRGP:
            Number(
              row.closedrgp,
            ),

          OverdueRGP:
            Number(
              row.overduergp,
            ),
        }),
      );

    // ============================================================
    // PDF Generate
    // ============================================================

    const pdfBuffer =
      await generatePdf({
        title:
          "RGP DEPARTMENT WISE REPORT",

        reportName:
          "RGP Department Wise Report",

        organizationId:
          data.OrganizationID,

        orientation:
          "landscape",

        metadata: [
          {
            label:
              "Organization",

            value:
              organizationName,
          },
          {
            label:
              "From Date",

            value:
              data.FromDate
                ? formatDate(
                    data.FromDate,
                  )
                : "All",
          },
          {
            label:
              "To Date",

            value:
              data.ToDate
                ? formatDate(
                    data.ToDate,
                  )
                : "All",
          },
          {
            label:
              "Department",

            value:
              data.DepartmentName ||
              "All Department",
          },
        ],

        columns: [
          {
            header:
              "Department",
            key:
              "DepartmentName",
            width:
              "*",
          },
          {
            header:
              "Total RGP",
            key:
              "TotalRGP",
            width:
              55,
            align:
              "center",
          },
          {
            header:
              "Pending",
            key:
              "PendingRGP",
            width:
              55,
            align:
              "center",
          },
          {
            header:
              "Approved",
            key:
              "ApprovedRGP",
            width:
              60,
            align:
              "center",
          },
          {
            header:
              "Rejected",
            key:
              "RejectedRGP",
            width:
              60,
            align:
              "center",
          },
          {
            header:
              "Cancelled",
            key:
              "CancelledRGP",
            width:
              60,
            align:
              "center",
          },
          {
            header:
              "Out",
            key:
              "OutRGP",
            width:
              45,
            align:
              "center",
          },
          {
            header:
              "Closed",
            key:
              "ClosedRGP",
            width:
              50,
            align:
              "center",
          },
          {
            header:
              "Overdue",
            key:
              "OverdueRGP",
            width:
              55,
            align:
              "center",
          },
        ],

        rows:
          reportData,
      });

    return {
      success:
        true,

      message:
        "RGP department wise report PDF generated successfully.",

      data:
        pdfBuffer,
    };

  } catch (error) {
    console.error(
      "RGP Department Wise Report PDF Error:",
      error,
    );

    return databaseFailure(
      error,
      "Generate RGP department wise report PDF",
    );
  }
};
// ============================================================RGP Vendor Wise Report PDF
const getRGPVendorWiseReportPdf = async (data) => {
  try {
    const organizationName =
      await getRGPReportOrganizationName(
        data.OrganizationID,
      );

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
    // Vendor Wise Report
    // SAME CONDITIONS AS UPDATED GET API
    // ============================================================

    const result =
      await pool.query(
        `
        SELECT
          m.VendorName,

          -- ======================================================
          -- Total RGP
          -- ======================================================

          COUNT(
            DISTINCT m.RGPID
          )::BIGINT AS TotalRGP,

          -- ======================================================
          -- Pending RGP
          -- ======================================================

          COUNT(
            DISTINCT m.RGPID
          ) FILTER (
            WHERE
              EXISTS (
                SELECT 1

                FROM Gatepass_RGP_Approval a

                WHERE a.RGPID =
                        m.RGPID

                  AND a.IsDeleted =
                        FALSE

                  AND UPPER(
                    TRIM(
                      COALESCE(
                        a.Status,
                        'PENDING'
                      )
                    )
                  ) = 'PENDING'
              )

              AND NOT EXISTS (
                SELECT 1

                FROM Gatepass_RGP_Approval a

                WHERE a.RGPID =
                        m.RGPID

                  AND a.IsDeleted =
                        FALSE

                  AND UPPER(
                    TRIM(
                      COALESCE(
                        a.Status,
                        'PENDING'
                      )
                    )
                  ) IN (
                    'REJECTED',
                    'CANCELLED'
                  )
              )
          )::BIGINT AS PendingRGP,

          -- ======================================================
          -- Approved RGP
          --
          -- All active approvals APPROVED hone chahiye
          -- AND master status APPROVED hona chahiye.
          -- Checkout ho chuka RGP Approved me count nahi hoga.
          -- ======================================================

          COUNT(
            DISTINCT m.RGPID
          ) FILTER (
            WHERE
              UPPER(
                TRIM(
                  COALESCE(
                    m.Status,
                    ''
                  )
                )
              ) = 'APPROVED'

              AND EXISTS (
                SELECT 1

                FROM Gatepass_RGP_Approval a

                WHERE a.RGPID =
                        m.RGPID

                  AND a.IsDeleted =
                        FALSE
              )

              AND NOT EXISTS (
                SELECT 1

                FROM Gatepass_RGP_Approval a

                WHERE a.RGPID =
                        m.RGPID

                  AND a.IsDeleted =
                        FALSE

                  AND UPPER(
                    TRIM(
                      COALESCE(
                        a.Status,
                        'PENDING'
                      )
                    )
                  ) <> 'APPROVED'
              )
          )::BIGINT AS ApprovedRGP,

          -- ======================================================
          -- Rejected RGP
          -- ======================================================

          COUNT(
            DISTINCT m.RGPID
          ) FILTER (
            WHERE EXISTS (
              SELECT 1

              FROM Gatepass_RGP_Approval a

              WHERE a.RGPID =
                      m.RGPID

                AND a.IsDeleted =
                      FALSE

                AND UPPER(
                  TRIM(
                    COALESCE(
                      a.Status,
                      ''
                    )
                  )
                ) = 'REJECTED'
            )
          )::BIGINT AS RejectedRGP,

          -- ======================================================
          -- Cancelled RGP
          -- ======================================================

          COUNT(
            DISTINCT m.RGPID
          ) FILTER (
            WHERE EXISTS (
              SELECT 1

              FROM Gatepass_RGP_Approval a

              WHERE a.RGPID =
                      m.RGPID

                AND a.IsDeleted =
                      FALSE

                AND UPPER(
                  TRIM(
                    COALESCE(
                      a.Status,
                      ''
                    )
                  )
                ) = 'CANCELLED'
            )
          )::BIGINT AS CancelledRGP,

          -- ======================================================
          -- Out RGP
          -- ======================================================

          COUNT(
            DISTINCT m.RGPID
          ) FILTER (
            WHERE UPPER(
              TRIM(
                COALESCE(
                  m.Status,
                  ''
                )
              )
            ) = 'CHECKED OUT'
          )::BIGINT AS OutRGP,

          -- ======================================================
          -- Closed RGP
          -- ======================================================

          COUNT(
            DISTINCT m.RGPID
          ) FILTER (
            WHERE UPPER(
              TRIM(
                COALESCE(
                  m.Status,
                  ''
                )
              )
            ) = 'RETURNED'
          )::BIGINT AS ClosedRGP,

          -- ======================================================
          -- Overdue RGP
          -- SAME EXISTING 30 DAYS CONDITION
          -- ======================================================

          COUNT(
            DISTINCT m.RGPID
          ) FILTER (
            WHERE
              m.ExpectedReturnDate <
                (
                  CURRENT_DATE -
                  INTERVAL '30 days'
                )

              AND UPPER(
                TRIM(
                  COALESCE(
                    m.Status,
                    ''
                  )
                )
              ) IN (
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
          m.VendorName ASC;
        `,
        values,
      );

    // ============================================================
    // SAME DATA MAPPING AS UPDATED GET API
    // ============================================================

    const reportData =
      result.rows.map(
        (row) => ({
          VendorName:
            row.vendorname,

          TotalRGP:
            Number(
              row.totalrgp,
            ),

          PendingRGP:
            Number(
              row.pendingrgp,
            ),

          ApprovedRGP:
            Number(
              row.approvedrgp,
            ),

          RejectedRGP:
            Number(
              row.rejectedrgp,
            ),

          CancelledRGP:
            Number(
              row.cancelledrgp,
            ),

          OutRGP:
            Number(
              row.outrgp,
            ),

          ClosedRGP:
            Number(
              row.closedrgp,
            ),

          OverdueRGP:
            Number(
              row.overduergp,
            ),
        }),
      );

    // ============================================================
    // Generate PDF
    // ============================================================

    const pdfBuffer =
      await generatePdf({
        title:
          "RGP VENDOR WISE REPORT",

        reportName:
          "RGP Vendor Wise Report",

        organizationId:
          data.OrganizationID,

        orientation:
          "landscape",

        metadata: [
          {
            label:
              "Organization",

            value:
              organizationName,
          },
          {
            label:
              "From Date",

            value:
              data.FromDate
                ? formatDate(
                    data.FromDate,
                  )
                : "All",
          },
          {
            label:
              "To Date",

            value:
              data.ToDate
                ? formatDate(
                    data.ToDate,
                  )
                : "All",
          },
          {
            label:
              "Vendor",

            value:
              data.VendorName ||
              "All Vendor",
          },
        ],

        columns: [
          {
            header:
              "Vendor Name",
            key:
              "VendorName",
            width:
              "*",
          },
          {
            header:
              "Total RGP",
            key:
              "TotalRGP",
            width:
              55,
            align:
              "center",
          },
          {
            header:
              "Pending",
            key:
              "PendingRGP",
            width:
              55,
            align:
              "center",
          },
          {
            header:
              "Approved",
            key:
              "ApprovedRGP",
            width:
              60,
            align:
              "center",
          },
          {
            header:
              "Rejected",
            key:
              "RejectedRGP",
            width:
              60,
            align:
              "center",
          },
          {
            header:
              "Cancelled",
            key:
              "CancelledRGP",
            width:
              60,
            align:
              "center",
          },
          {
            header:
              "Out",
            key:
              "OutRGP",
            width:
              45,
            align:
              "center",
          },
          {
            header:
              "Closed",
            key:
              "ClosedRGP",
            width:
              50,
            align:
              "center",
          },
          {
            header:
              "Overdue",
            key:
              "OverdueRGP",
            width:
              55,
            align:
              "center",
          },
        ],

        rows:
          reportData,
      });

    return {
      success:
        true,

      message:
        "RGP vendor wise report PDF generated successfully.",

      data:
        pdfBuffer,
    };

  } catch (error) {
    console.error(
      "RGP Vendor Wise Report PDF Error:",
      error,
    );

    return databaseFailure(
      error,
      "Generate RGP vendor wise report PDF",
    );
  }
};
// ============================================================Pending Return Item Report PDF
const getRGPPendingReturnReportPdf = async (data) => {
  try {
    const organizationName = await getRGPReportOrganizationName(data.OrganizationID);
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
    // Pending Return Report
    // SAME QUERY / SAME CONDITIONS AS GET API
    // Only LIMIT / OFFSET removed for PDF
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
          i.RGPItemID ASC;
        `,
        values,
      );

    // ============================================================
    // SAME DATA MAPPING AS GET API
    // ============================================================

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

    // ============================================================
    // PDF Generate
    // ============================================================

    const pdfBuffer =
      await generatePdf({
        title:
          "RGP PENDING RETURN REPORT",

        reportName:
          "RGP Pending Return Report",

        organizationId:
          data.OrganizationID,

        orientation:
          "landscape",

        metadata: [
          { label: "Organization", value: organizationName },
          {
            label: "From Date",
            value:
              data.FromDate
                ? formatDate(
                    data.FromDate,
                  )
                : "All",
          },
          {
            label: "To Date",
            value:
              data.ToDate
                ? formatDate(
                    data.ToDate,
                  )
                : "All",
          },
          {
            label: "Vendor",
            value:
              data.VendorName ||
              "All Vendor",
          },
          {
            label: "RGP No.",
            value:
              data.RGPNumber ||
              "All",
          },
        ],

        columns: [
          {
            header: "RGP No.",
            key: "RGPNumber",
            width: 40,
          },
          {
            header: "Vendor Name",
            key: "VendorName",
            width: 70,
          },
          {
            header: "Company",
            key: "Company",
            width: 70,
          },
          {
            header: "Department",
            key: "DepartmentName",
            width: 70,
          },
          {
            header: "Exp. Return",
            key: "ExpectedReturnDate",
            width: 62,
            value: (row) =>
              row.ExpectedReturnDate
                ? formatDate(
                    row.ExpectedReturnDate,
                  )
                : "-",
          },
          {
            header: "Item Name",
            key: "ItemName",
            width: 75,
          },
          {
            header: "Qty.",
            key: "Quantity",
            width: 35,
            align: "center",
          },
          {
            header: "Returned",
            key: "ReturnedQuantity",
            width: 40,
            align: "center",
          },
          {
            header: "Remaining",
            key: "RemainingQuantity",
            width: 52,
            align: "center",
          },
          {
            header: "Unit",
            key: "Unit",
            width: 35,
          },
          {
            header: "Status",
            key: "Status",
            width: 62,
          },
          {
            header: "Overdue Days",
            key: "OverdueDays",
            width: 55,
            align: "center",
          },
        ],

        rows:
          reportData,
      });

    return {
      success: true,
      message:
        "RGP pending return report PDF generated successfully.",
      data: pdfBuffer,
    };
  } catch (error) {
    console.error(
      "RGP Pending Return Report PDF Error:",
      error,
    );

    return databaseFailure(
      error,
      "Generate RGP pending return report PDF",
    );
  }
};
// ============================================================RGP Details PDF
const generateRGPDetailPdf = async (data) => {
  try {
    // ============================================================
    // Validate
    // ============================================================

    const rgpID =
      Number(data.RGPID);

    if (
      !Number.isInteger(rgpID) ||
      rgpID <= 0
    ) {
      return fail(
        "Valid RGPID is required.",
        400,
      );
    }

    // ============================================================
    // SAME GET BY ID API
    // No Duplicate SQL
    // ============================================================

    const rgpResult =
      await getRGPById({
        RGPID: rgpID,
      });

    if (!rgpResult.success) {
      return rgpResult;
    }

    const detail =
      rgpResult.data;

    // ============================================================
    // PDF Design
    // ============================================================

    const COLORS = {
      navy: "#082B5C",
      label: "#082B5C",
      text: "#172033",
      muted: "#64748B",
      border: "#CFD7E3",
      labelBackground: "#F4F6F9",
    };

    const displayValue = (
      value,
    ) =>
      value === null ||
      value === undefined ||
      String(value).trim() === ""
        ? "-"
        : String(value);

    const displayDate = (
      value,
      format = "DD MMM YYYY",
    ) =>
      value
        ? formatDate(
            value,
            format,
          )
        : "-";

    // ============================================================
    // Canvas Helpers
    // ============================================================

    const line = (
      x1,
      y1,
      x2,
      y2,
      lineWidth = 1.1,
    ) => ({
      type: "line",
      x1,
      y1,
      x2,
      y2,
      lineWidth,
      lineColor:
        COLORS.navy,
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
      lineWidth: 1.1,
      lineColor:
        COLORS.navy,
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
      lineWidth: 1.1,
      lineColor:
        COLORS.navy,
    });

    // ============================================================
    // Icons
    // ============================================================

    const fieldIcon = (
      type,
    ) => {
      const icons = {
        number: [
          rect(
            2,
            3,
            14,
            12,
            1,
          ),
          line(
            5,
            7,
            13,
            7,
          ),
          line(
            5,
            11,
            13,
            11,
          ),
        ],

        organization: [
          rect(
            4,
            2,
            10,
            15,
            1,
          ),
          line(
            1,
            17,
            17,
            17,
          ),
          line(
            7,
            6,
            7,
            8,
          ),
          line(
            11,
            6,
            11,
            8,
          ),
          line(
            7,
            11,
            7,
            13,
          ),
          line(
            11,
            11,
            11,
            13,
          ),
        ],

        calendar: [
          rect(
            1,
            4,
            16,
            13,
            1,
          ),
          line(
            1,
            8,
            17,
            8,
          ),
          line(
            5,
            2,
            5,
            6,
          ),
          line(
            13,
            2,
            13,
            6,
          ),
        ],

        vendor: [
          ellipse(
            9,
            6,
            4,
          ),
          line(
            3,
            17,
            15,
            17,
          ),
          line(
            5,
            17,
            5,
            13,
          ),
          line(
            13,
            17,
            13,
            13,
          ),
        ],

        phone: [
          rect(
            3,
            1,
            12,
            17,
            2,
          ),
          line(
            7,
            15,
            11,
            15,
          ),
        ],

        department: [
          rect(
            2,
            4,
            14,
            13,
            1,
          ),
          line(
            6,
            1,
            12,
            1,
          ),
          line(
            9,
            1,
            9,
            4,
          ),
        ],

        location: [
          ellipse(
            9,
            7,
            5,
          ),
          ellipse(
            9,
            7,
            1.5,
          ),
          {
            type:
              "polyline",

            points: [
              {
                x: 5,
                y: 10,
              },
              {
                x: 9,
                y: 18,
              },
              {
                x: 13,
                y: 10,
              },
            ],

            lineWidth:
              1.1,

            lineColor:
              COLORS.navy,
          },
        ],

        status: [
          ellipse(
            9,
            9,
            7,
          ),
          line(
            5,
            9,
            8,
            12,
          ),
          line(
            8,
            12,
            13,
            6,
          ),
        ],

        quantity: [
          rect(
            2,
            3,
            14,
            12,
            1,
          ),
          line(
            5,
            7,
            13,
            7,
          ),
          line(
            5,
            11,
            13,
            11,
          ),
        ],
      };

      const iconScale =
        0.82;

      return (
        icons[type] ||
        icons.quantity
      ).map(
        (shape) => {
          const scaledShape = {
            ...shape,

            lineWidth:
              (
                shape.lineWidth ||
                1
              ) *
              iconScale,
          };

          for (
            const coordinate
            of [
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
                (point) => ({
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

    // ============================================================
    // Cell Helpers
    // ============================================================

    const labelCell = (
      label,
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

          text:
            label,

          style:
            "fieldLabel",

          margin: [
            2,
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
        5,
        6,
      ],
    });

    const valueCell = (
      value,
    ) => ({
      text:
        displayValue(
          value,
        ),

      style:
        "fieldValue",

      margin: [
        9,
        8,
        7,
        7,
      ],
    });

    const tableLayout = {
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

      paddingLeft:
        () =>
          0,

      paddingRight:
        () =>
          0,

      paddingTop:
        () =>
          0,

      paddingBottom:
        () =>
          0,
    };

    const sectionHeading = (
      title,
    ) => ({
      text:
        title,

      fontSize:
        11,

      bold:
        true,

      color:
        COLORS.navy,

      margin: [
        0,
        4,
        0,
        7,
      ],
    });

    // ============================================================
    // Logo
    // ============================================================

    const logo =
      await loadLogo(
        detail.OrganizationID,
        data.logoUrl,
      );

    const generatedOn =
      formatDate(
        new Date(),
        "DD MMM YYYY hh:mm A",
      );

    // ============================================================
    // RGP Item Details
    // ============================================================

    const itemDetailsBody = [
      [
        {
          text:
            "Sr.No.",

          style:
            "tableHeader",

          alignment:
            "center",
        },

        {
          text:
            "Item Name",

          style:
            "tableHeader",
        },

        {
          text:
            "Specification",

          style:
            "tableHeader",
        },

        {
          text:
            "Qty.",

          style:
            "tableHeader",

          alignment:
            "center",
        },

        {
          text:
            "Unit",

          style:
            "tableHeader",

          alignment:
            "center",
        },

        {
          text:
            "Rate",

          style:
            "tableHeader",

          alignment:
            "center",
        },

        {
          text:
            "Make / Model",

          style:
            "tableHeader",
        },

        {
          text:
            "Serial No.",

          style:
            "tableHeader",
        },
      ],
    ];

    if (
      Array.isArray(
        detail.Items,
      ) &&
      detail.Items.length > 0
    ) {
      detail.Items.forEach(
        (
          item,
          index,
        ) => {
          itemDetailsBody.push([
            {
              text:
                index + 1,

              style:
                "tableValue",

              alignment:
                "center",
            },

            {
              text:
                displayValue(
                  item.ItemName,
                ),

              style:
                "tableValue",
            },

            {
              text:
                displayValue(
                  item.Specification,
                ),

              style:
                "tableValue",
            },

            {
              text:
                displayValue(
                  item.Quantity,
                ),

              style:
                "tableValue",

              alignment:
                "center",
            },

            {
              text:
                displayValue(
                  item.Unit,
                ),

              style:
                "tableValue",

              alignment:
                "center",
            },

            {
              text:
                item.Rate !==
                  null &&
                item.Rate !==
                  undefined
                  ? Number(
                      item.Rate,
                    ).toFixed(
                      2,
                    )
                  : "-",

              style:
                "tableValue",

              alignment:
                "center",
            },

            {
              text:
                displayValue(
                  item.MakeModel,
                ),

              style:
                "tableValue",
            },

            {
              text:
                displayValue(
                  item.SerialNumber,
                ),

              style:
                "tableValue",
            },
          ]);
        },
      );
    } else {
      itemDetailsBody.push([
        {
          text:
            "No RGP item details found.",

          colSpan:
            8,

          alignment:
            "center",

          color:
            COLORS.muted,

          margin: [
            0,
            8,
            0,
            8,
          ],
        },

        {},
        {},
        {},
        {},
        {},
        {},
        {},
      ]);
    }

    // ============================================================
    // Approval / Rejection / Cancellation Details
    // ============================================================
// ============================================================
// Approval / Rejection / Cancellation Details
// ============================================================

const approvalActionStack = [];

const approvals =
  Array.isArray(
    detail.Approvals,
  )
    ? detail.Approvals
    : [];

// ============================================================
// Approval Rows
//
// Directly using getRGPById response:
//
// ApprovalLevel
// ApprovalRole
// Status
// Remarks
// ActionByName
// ============================================================

approvals.forEach(
  (approval) => {
    const status =
      String(
        approval.Status || "",
      )
        .trim()
        .toUpperCase();

    // ========================================================
    // Only actual completed actions
    //
    // Blank / Pending approval stages PDF me show nahi honge.
    // ========================================================

    if (
      ![
        "APPROVED",
        "REJECTED",
        "CANCELLED",
      ].includes(
        status,
      )
    ) {
      return;
    }

    const role =
      String(
        approval.ApprovalRole ||
          "",
      ).trim();

    const actionByName =
      String(
        approval.ActionByName ||
          "",
      ).trim();

    // ========================================================
    // Role and ActionByName required
    // ========================================================

    if (
      !role ||
      !actionByName
    ) {
      return;
    }

    // ========================================================
    // Action Label
    // ========================================================

    let actionLabel = "";

    if (
      status === "APPROVED"
    ) {
      actionLabel =
        "Approved";
    } else if (
      status === "REJECTED"
    ) {
      actionLabel =
        "Rejected";
    } else if (
      status === "CANCELLED"
    ) {
      actionLabel =
        "Cancelled";
    }

    // ========================================================
    // Output Examples:
    //
    // Approved by HOD - Kailash Garg
    // Rejected by HOD - Kailash Garg
    // Cancelled by HOD - Kailash Garg
    // ========================================================

    approvalActionStack.push({
      text: [
        {
          text:
            `${actionLabel} by ${role} - `,

          bold:
            true,
        },

        {
          text:
            actionByName,
        },
      ],

      fontSize:
        9,

      margin: [
        0,
        0,
        0,
        5,
      ],
    });
  },
);

// ============================================================
// No Approval Action
// ============================================================

if (
  approvalActionStack.length ===
  0
) {
  approvalActionStack.push({
    text:
      "-",

    fontSize:
      9,
  });
}

// ============================================================
// Prepare By
// ============================================================

const preparedBy =
  displayValue(
    detail.CreatedByName ||
      detail.CreatedBy,
  );

    // ============================================================
    // Master Level Cancellation
    //
    // RGP CANCEL is stored on RGP Master.
    // Show it separately when RGP is cancelled.
    // ============================================================

  

    // ============================================================
    // Document Definition
    // ============================================================

    const documentDefinition = {
      pageSize:
        "A4",

      pageOrientation:
        "portrait",

      pageMargins: [
        22,
        26,
        22,
        72,
      ],

      defaultStyle: {
        font:
          "Roboto",

        fontSize:
          9,

        color:
          COLORS.text,
      },

      content: [
        // ========================================================
        // Header
        // ========================================================

        {
          table: {
            widths: [
              130,
              "*",
              80,
            ],

            body: [
              [
                logo
                  ? {
                      image:
                        logo,

                      fit: [
                        88,
                        50,
                      ],

                      border: [
                        false,
                        false,
                        false,
                        false,
                      ],
                    }
                  : {
                      text:
                        "",

                      border: [
                        false,
                        false,
                        false,
                        false,
                      ],
                    },

                {
                  text:
                    "RETURNABLE GATE PASS",

                  style:
                    "title",

                  alignment:
                    "center",

                  margin: [
                    0,
                    18,
                    0,
                    0,
                  ],

                  border: [
                    false,
                    false,
                    false,
                    false,
                  ],
                },

                {
                  text:
                    "",

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

        // ========================================================
        // Header Line
        // ========================================================

        {
          canvas: [
            {
              type:
                "line",

              x1:
                0,

              y1:
                0,

              x2:
                551,

              y2:
                0,

              lineWidth:
                0.8,

              lineColor:
                COLORS.navy,
            },
          ],

          margin: [
            0,
            7,
            0,
            14,
          ],
        },

        // ========================================================
        // RGP Details
        // ========================================================

        sectionHeading(
          "RGP Details",
        ),

        {
          table: {
            widths: [
              105,
              "*",
              105,
              "*",
            ],

            body: [
              // ==================================================
              // Row 1
              // ==================================================

              [
                labelCell(
                  "RGP No.",
                  "number",
                ),

                valueCell(
                  detail.RGPNumber,
                ),

                labelCell(
                  "Expected Return",
                  "calendar",
                ),

                valueCell(
                  displayDate(
                    detail.ExpectedReturnDate,
                  ),
                ),
              ],

              // ==================================================
              // Row 2
              // Department + Created Date
              // ==================================================

              [
                labelCell(
                  "Department",
                  "department",
                ),

                valueCell(
                  detail.DepartmentName,
                ),

                labelCell(
                  "Created Date",
                  "calendar",
                ),

                valueCell(
                  displayDate(
                    detail.CreatedDate,
                  ),
                ),
              ],

              // ==================================================
              // Row 3
              // ==================================================

              [
                labelCell(
                  "Vendor Name",
                  "vendor",
                ),

                valueCell(
                  detail.VendorName,
                ),

                labelCell(
                  "Contact No.",
                  "phone",
                ),

                valueCell(
                  detail.ContactNumber,
                ),
              ],

              // ==================================================
              // Row 4
              // ==================================================

              [
                labelCell(
                  "Company",
                  "organization",
                ),

                valueCell(
                  detail.Company,
                ),

                labelCell(
                  "Taken By",
                  "vendor",
                ),

                valueCell(
                  detail.TakenBy,
                ),
              ],

              // ==================================================
              // Row 5 - Checkout Date
              // ==================================================

              [
                labelCell(
                  "Checkout Date",
                  "calendar",
                ),

                {
                  ...valueCell(
                    detail.CheckoutDateTime
                      ? displayDate(
                          detail.CheckoutDateTime,
                          "DD MMM YYYY",
                        )
                      : "-",
                  ),

                  colSpan:
                    3,
                },

                {},
                {},
              ],

              // ==================================================
              // Row 6 - Address
              // ==================================================

              [
                labelCell(
                  "Address",
                  "location",
                ),

                {
                  ...valueCell(
                    detail.Address,
                  ),

                  colSpan:
                    3,
                },

                {},
                {},
              ],
            ],
          },

          layout:
            tableLayout,

          margin: [
            0,
            0,
            0,
            15,
          ],
        },

        // ========================================================
        // RGP Item Details
        // ========================================================

        sectionHeading(
          "RGP Item Details",
        ),

        {
          table: {
            headerRows:
              1,

            dontBreakRows:
              true,

            widths: [
              28,
              120,
              105,
              32,
              35,
              42,
              75,
              45,
            ],

            body:
              itemDetailsBody,
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

            paddingLeft:
              () =>
                4,

            paddingRight:
              () =>
                4,

            paddingTop:
              () =>
                6,

            paddingBottom:
              () =>
                6,
          },

          margin: [
            0,
            0,
            0,
            10,
          ],
        },

        // ========================================================
        // Signature / Approval Section
        // ========================================================

        {
          unbreakable:
            true,

          margin: [
            8,
            38,
            8,
            0,
          ],

          columns: [
            // ====================================================
            // LEFT SIDE
            // ====================================================

            {
              width:
                "*",

              stack: [
                // ================================================
                // Signature
                // ================================================

                {
                  text:
                    "Signature of Person Taking Item",

                  bold:
                    true,

                  fontSize:
                    9,

                  margin: [
                    0,
                    0,
                    0,
                    18,
                  ],
                },

                // ================================================
                // Taken By
                // ================================================

                {
                  text: [
                    {
                      text:
                        "Taken By: ",

                      bold:
                        true,
                    },

                    {
                      text:
                        displayValue(
                          detail.TakenBy,
                        ),
                    },
                  ],

                  fontSize:
                    9,

                  margin: [
                    0,
                    0,
                    0,
                    38,
                  ],
                },

                // ================================================
                // Approval Details
                // ================================================

                {
                  text:
                    "Checked & Approved By",

                  bold:
                    true,

                  fontSize:
                    9,

                  margin: [
                    0,
                    0,
                    0,
                    10,
                  ],
                },

                // ================================================
                // Approved / Rejected / Cancelled By
                // ================================================

                {
                  stack:
                    approvalActionStack,
                },
              ],
            },

            // ====================================================
            // RIGHT SIDE
            // ====================================================

            {
              width:
                200,

              stack: [
                // ================================================
                // Prepare By
                // ================================================

                {
                  text: [
                    {
                      text:
                        "Prepare By:- ",

                      bold:
                        true,
                    },

                    {
                      text:
                        preparedBy,
                    },
                  ],

                  alignment:
                    "left",

                  fontSize:
                    9,

                  margin: [
                    20,
                    18,
                    0,
                    100,
                  ],
                },

                // ================================================
                // Security Sign & Seal
                // ================================================

                {
                  text:
                    "Security Sign & Seal",

                  bold:
                    true,

                  alignment:
                    "left",

                  fontSize:
                    9,

                  margin: [
                    20,
                    0,
                    0,
                    0,
                  ],
                },
              ],
            },
          ],
        },
      ],

      // ==========================================================
      // Footer
      // ==========================================================

      footer:
        () => ({
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
                  type:
                    "line",

                  x1:
                    0,

                  y1:
                    0,

                  x2:
                    551,

                  y2:
                    0,

                  lineWidth:
                    0.7,

                  lineColor:
                    COLORS.navy,
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

                      bold:
                        true,

                      color:
                        COLORS.navy,

                      fontSize:
                        8,
                    },
                  ],
                },

                {
                  width:
                    130,

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

      // ==========================================================
      // Styles
      // ==========================================================

      styles: {
        title: {
          fontSize:
            18,

          bold:
            true,

          color:
            COLORS.navy,
        },

        fieldLabel: {
          fontSize:
            8.5,

          bold:
            true,

          color:
            COLORS.label,
        },

        fieldValue: {
          fontSize:
            9,

          color:
            COLORS.text,
        },

        tableHeader: {
          fontSize:
            8,

          bold:
            true,

          color:
            COLORS.navy,

          fillColor:
            COLORS.labelBackground,

          margin: [
            0,
            2,
            0,
            2,
          ],
        },

        tableValue: {
          fontSize:
            8,

          color:
            COLORS.text,

          margin: [
            0,
            2,
            0,
            2,
          ],
        },
      },
    };

    // ============================================================
    // Generate PDF Buffer
    // ============================================================

    const pdfBuffer =
      await new Promise(
        (
          resolve,
          reject,
        ) => {
          try {
            const pdfDocument =
              new PdfPrinter(
                RGP_DETAIL_PDF_FONTS,
              )
                .createPdfKitDocument(
                  documentDefinition,
                );

            const chunks =
              [];

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

    // ============================================================
    // Return
    // ============================================================

    return {
      success:
        true,

      message:
        "RGP detail PDF generated successfully.",

      data:
        pdfBuffer,

      fileName:
        `RGP-Detail-${detail.RGPNumber || rgpID}.pdf`,

      contentType:
        "application/pdf",
    };

  } catch (error) {
    console.error(
      "Generate RGP detail PDF error:",
      error,
    );

    return databaseFailure(
      error,
      "Generate RGP detail PDF",
    );
  }
};
// ============================================================RGP Red Flag Report PDF
const getRGPRedFlagReportPdf = async (data) => {
  try {
    const organizationName =
      await getRGPReportOrganizationName(
        data.OrganizationID,
      );

    const values = [];

    const conditions = [
      "m.IsDeleted = FALSE",
      "i.IsDeleted = FALSE",

      // ==========================================================
      // RGP bahar hona chahiye
      // ==========================================================

      `
      UPPER(
        TRIM(
          COALESCE(
            m.Status,
            ''
          )
        )
      ) IN (
        'CHECKED OUT',
        'RETURN PENDING'
      )
      `,

      // ==========================================================
      // Item fully returned nahi hona chahiye
      // ==========================================================

      `
      COALESCE(
        i.IsReturned,
        FALSE
      ) = FALSE
      `,

      // ==========================================================
      // Remaining Quantity > 0
      // ==========================================================

      `
      COALESCE(
        i.RemainingQuantity,
        0
      ) > 0
      `,

      // ==========================================================
      // Expected Return Date + 30 Days Cross
      // ==========================================================

      `
      m.ExpectedReturnDate IS NOT NULL

      AND m.ExpectedReturnDate::DATE <=
        (
          CURRENT_DATE -
          INTERVAL '30 days'
        )
      `,
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
          CAST(
            m.RGPNumber AS TEXT
          ) ILIKE $${searchIndex}

          OR COALESCE(
            m.VendorName,
            ''
          ) ILIKE $${searchIndex}

          OR COALESCE(
            m.Company,
            ''
          ) ILIKE $${searchIndex}

          OR COALESCE(
            m.ContactNumber,
            ''
          ) ILIKE $${searchIndex}

          OR COALESCE(
            m.TakenBy,
            ''
          ) ILIKE $${searchIndex}

          OR COALESCE(
            d.DepartmentName,
            ''
          ) ILIKE $${searchIndex}

          OR COALESCE(
            i.ItemName,
            ''
          ) ILIKE $${searchIndex}

          OR COALESCE(
            i.Specification,
            ''
          ) ILIKE $${searchIndex}

          OR COALESCE(
            i.SerialNumber,
            ''
          ) ILIKE $${searchIndex}
        )
      `);
    }

    // ============================================================
    // Where Clause
    // ============================================================

    const whereClause =
      conditions.length
        ? `WHERE ${conditions.join(
            " AND ",
          )}`
        : "";

    // ============================================================
    // Red Flag Report Data
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

          m.DepartmentID,
          d.DepartmentName,

          m.TakenBy,

          m.ExpectedReturnDate,

          m.Status,

          m.CheckoutDateTime,

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

          (
            CURRENT_DATE -
            m.ExpectedReturnDate::DATE
          )::INTEGER AS OverdueDays

        FROM Gatepass_RGP_Entry_Master m

        INNER JOIN Gatepass_RGP_Entry_Item_Details i
          ON i.RGPID =
            m.RGPID

        LEFT JOIN department_master d
          ON d.DepartmentID =
            m.DepartmentID

        ${whereClause}

        ORDER BY
          OverdueDays DESC,
          m.RGPNumber DESC,
          i.RGPItemID ASC;
        `,
        values,
      );

    // ============================================================
    // PDF Rows
    // ============================================================

    const pdfRows =
      result.rows.map(
        (row) => ({
          RGPNumber:
            row.rgpnumber ??
            "-",

          VendorName:
            row.vendorname ||
            "-",

          DepartmentName:
            row.departmentname ||
            "-",

          ItemName:
            row.itemname ||
            "-",

          Quantity:
            row.quantity != null
              ? Number(
                  row.quantity,
                )
              : "-",

          ReturnedQuantity:
            Number(
              row.returnedquantity ||
                0,
            ),

          RemainingQuantity:
            Number(
              row.remainingquantity ||
                0,
            ),

          ExpectedReturnDate:
            row.expectedreturndate
              ? formatDate(
                  row.expectedreturndate,
                )
              : "-",

          OverdueDays:
            Number(
              row.overduedays ||
                0,
            ),

          Status:
            row.status ||
            "-",
        }),
      );

    // ============================================================
    // PDF Metadata / Applied Filters
    // ============================================================

    const metadata = [
      {
        label:
          "Organization",

        value:
          organizationName,
      },
      {
        label:
          "Department",

        value:
          data.DepartmentName ||
          "All Department",
      },
      {
        label:
          "RGP Number",

        value:
          data.RGPNumber ||
          "All",
      },
      {
        label:
          "Vendor",

        value:
          data.VendorName ||
          "All Vendor",
      },
      
    ];

    // ============================================================
    // Generate PDF
    // ============================================================

    const pdfBuffer =
      await generatePdf({
        title:
          "RGP RED FLAG REPORT",

        reportName:
          "RGP Red Flag Report",

        organizationId:
          data.OrganizationID,

        orientation:
          "landscape",

        metadata,

        columns: [
          {
            header:
              "RGP No.",
            key:
              "RGPNumber",
            width:
              50,
          },
          {
            header:
              "Vendor",
            key:
              "VendorName",
            width:
              75,
          },
          {
            header:
              "Department",
            key:
              "DepartmentName",
            width:
              75,
          },
          {
            header:
              "Item Name",
            key:
              "ItemName",
            width:
              "*",
          },
          {
            header:
              "Qty.",
            key:
              "Quantity",
            width:
              40,
            align:
              "center",
          },
          {
            header:
              "Returned",
            key:
              "ReturnedQuantity",
            width:
              55,
            align:
              "center",
          },
          {
            header:
              "Pending",
            key:
              "RemainingQuantity",
            width:
              50,
            align:
              "center",
          },
          {
            header:
              "Exp. Return",
            key:
              "ExpectedReturnDate",
            width:
              70,
          },
          {
            header:
              "Overdue Days",
            key:
              "OverdueDays",
            width:
              55,
            align:
              "center",
          },
          {
            header:
              "Status",
            key:
              "Status",
            width:
              65,
          },
        ],

        rows:
          pdfRows,
      });

    // ============================================================
    // Response
    // ============================================================

    return {
      success:
        true,

      message:
        "RGP red flag report PDF generated successfully.",

      data:
        pdfBuffer,
    };
  } catch (error) {
    console.error(
      "RGP Red Flag Report PDF Error:",
      error,
    );

    return databaseFailure(
      error,
      "Generate RGP red flag report PDF",
    );
  }
};

// ===========================================================================================NRGP
// ============================================================Helpers
// ======================== Default NRGP Approval Levels
const DEFAULT_NRGP_APPROVALS = Object.freeze([
  {
    LevelNo: 1,
    ApprovalRole: "HOD",
  },
  {
    LevelNo: 2,
    ApprovalRole: "DOF",
  },
  {
    LevelNo: 3,
    ApprovalRole: "GM",
  },
]);
// ======================== NRGP Mapping Helpers
const mapNRGPMaster = (row) => ({
  NRGPID:
    Number(row.nrgpid),

  NRGPNumber:
    Number(row.nrgpnumber),

  OrganizationID:
    Number(row.organizationid),

  VendorName:
    row.vendorname,

  ContactNumber:
    row.contactnumber,

  Company:
    row.company,

  SendTo:
    row.sendto,

  DepartmentID:
    row.departmentid
      ? Number(row.departmentid)
      : null,

  DepartmentName:
    row.departmentname,

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
      : null,
CreatedBy:
    row.createdby
      ? Number(row.createdby)
      : null,

 CreatedByName:
    row.createdbyname || null,
});
// ========================NRGP Item Mapping
const mapNRGPItem = (row) => ({
  NRGPItemID:
    Number(row.nrgpitemid),

  NRGPID:
    Number(row.nrgpid),

  OrganizationID:
    Number(row.organizationid),

  ItemName:
    row.itemname,

  Specification:
    row.specification,

  Quantity:
    Number(row.quantity),

  Rate:
    row.rate !== null
      ? Number(row.rate)
      : null,

  MakeModel:
    row.makemodel,

  SerialNumber:
    row.serialnumber,
  
CreatedDate:
    row.createddate
      ? formatDate(
          row.createddate,
        )
      : null,

  

 
});
// ========================NRGP Approval Mapping
const mapNRGPApproval = (row) => ({
 

  NRGPApprovalConfigID:
    row.nrgpapprovalconfigid
      ? Number(row.nrgpapprovalconfigid)
      : null,

  ApprovalLevel:
    Number(row.approvallevel),

  ApprovalRole:
    row.approvalrole,



  Status:
    row.status,
ActionBy:
    row.actionby
      ? Number(row.actionby)
      : null,
 
ActionByName:
    row.actionbyname || null,
  Remarks:
    row.remarks,
});
const mapNRGPApprovalFlow = (approvalRows) => {
  let flowStopped = false;

  return approvalRows.map((row) => {
    const mappedApproval =
      mapNRGPApproval(row);

    // Previous stage was Rejected / Cancelled
    if (flowStopped) {
      return {
        ...mappedApproval,

        Status: null,

        ActionBy: null,

        ActionByName: null,

        Remarks: null,
      };
    }

    const status =
      String(row.status || "")
        .trim()
        .toUpperCase();

    // Current rejected/cancelled stage itself
    // will show its actual details.
    if (
      status === "REJECTED" ||
      status === "CANCELLED"
    ) {
      flowStopped = true;
    }

    return mappedApproval;
  });
};
const normalizeNRGPApprovalRole = (role) => {
  const normalizedRole =
    String(role || "")
      .trim()
      .toUpperCase();

  if (
    normalizedRole === "FC" ||
    normalizedRole === "DOF"
  ) {
    return "FC";
  }

  return normalizedRole;
};
const getNRGPUserApprovalRole = (
  userType,
  departmentName,
) => {
  const normalizedUserType =
    String(userType || "")
      .trim()
      .toUpperCase();

  const normalizedDepartment =
    String(departmentName || "")
      .trim()
      .toUpperCase();

  // ============================================================
  // Finance Controller
  //
  // Project condition:
  // UserType = HOD
  // DepartmentName = Finance
  //
  // FC and DOF are same approval role
  // ============================================================

  if (
    normalizedUserType === "HOD" &&
    normalizedDepartment === "FINANCE"
  ) {
    return "FC";
  }

  return normalizeNRGPApprovalRole(
    normalizedUserType,
  );
};
// ========================Attach NRGP Related Datax`
const attachNRGPRelatedData = async (rows) => {
  if (!rows.length) {
    return [];
  }

  const NRGPIDs =
    rows.map((row) =>
      Number(row.nrgpid),
    );

  // ============================================================
  // Items
  // ============================================================

  const itemResult =
    await pool.query(
      `
      SELECT
        NRGPItemID,
        NRGPID,
        OrganizationID,

        ItemName,
        Specification,
        Quantity,
        Rate,
        MakeModel,
        SerialNumber,

        CreatedBy,
        CreatedDate,
        ModifiedBy,
        ModifiedDate

      FROM Gatepass_NRGP_Entry_Item_Details

      WHERE NRGPID =
        ANY($1::BIGINT[])

        AND IsDeleted =
          FALSE

      ORDER BY
        NRGPItemID ASC;
      `,
      [
        NRGPIDs,
      ],
    );

  // ============================================================
  // Approvals
  // ActionByName added from user_master
  // ============================================================

  const approvalResult =
    await pool.query(
      `
      SELECT
        a.NRGPApprovalID,
        a.NRGPID,
        a.NRGPApprovalConfigID,

        a.ApprovalLevel,
        a.ApprovalRole,
        a.ApprovalOrder,

        a.Status,
        a.StatusDateTime,

        a.ActionBy,

        actionUser.FullName
          AS ActionByName,

        a.Remarks,

        a.CreatedBy,
        a.CreatedDate,
        a.ModifiedBy,
        a.ModifiedDate

      FROM Gatepass_NRGP_Approval a

      LEFT JOIN user_master actionUser
        ON actionUser.UserID =
          a.ActionBy

      WHERE a.NRGPID =
        ANY($1::BIGINT[])

        AND a.IsDeleted =
          FALSE

      ORDER BY
        a.NRGPID ASC,
        a.ApprovalOrder ASC;
      `,
      [
        NRGPIDs,
      ],
    );

  // ============================================================
  // Mapping
  // ============================================================

  const items =
    itemResult.rows.map(
      mapNRGPItem,
    );

  // ============================================================
  // Attach
  // ============================================================

  return rows.map(
    (row) => {
      const record =
        mapNRGPMaster(
          row,
        );

      record.Items =
        items.filter(
          (item) =>
            item.NRGPID ===
            record.NRGPID,
        );

    const recordApprovals =
  approvalResult.rows.filter(
    (approval) =>
      String(
        approval.nrgpid,
      ) ===
      String(
        row.nrgpid,
      ),
  );

record.Approvals =
  mapNRGPApprovalFlow(
    recordApprovals,
  );

      return record;
    },
  );
};
// ============================================================Create NRGP
const createNRGP = async (data) => {
  const client = await pool.connect();

  try {
    // ============================================================
    // Validate Organization
    // ============================================================

    const organizationID = Number(data.OrganizationID);

    if (
      !Number.isInteger(organizationID) ||
      organizationID <= 0
    ) {
      return fail(
        "Valid OrganizationID is required.",
        400,
      );
    }

    // ============================================================
    // Validate Vendor
    // ============================================================

    if (
      !data.VendorName ||
      !String(data.VendorName).trim()
    ) {
      return fail(
        "VendorName is required.",
        400,
      );
    }

    // ============================================================
    // Validate Department
    // ============================================================

    const departmentID = Number(data.DepartmentID);

    if (
      !Number.isInteger(departmentID) ||
      departmentID <= 0
    ) {
      return fail(
        "Valid DepartmentID is required.",
        400,
      );
    }

    // ============================================================
    // Validate Items
    // ============================================================

    if (
      !Array.isArray(data.Items) ||
      data.Items.length === 0
    ) {
      return fail(
        "At least one item is required.",
        400,
      );
    }

    for (
      let index = 0;
      index < data.Items.length;
      index++
    ) {
      const item = data.Items[index];

      if (
        !item.ItemName ||
        !String(item.ItemName).trim()
      ) {
        return fail(
          `ItemName is required for item ${index + 1}.`,
          400,
        );
      }

      const quantity = Number(item.Quantity);

      if (
        !Number.isFinite(quantity) ||
        quantity <= 0
      ) {
        return fail(
          `Valid Quantity is required for item ${index + 1}.`,
          400,
        );
      }

      if (
        item.Rate !== undefined &&
        item.Rate !== null &&
        item.Rate !== ""
      ) {
        const rate = Number(item.Rate);

        if (
          !Number.isFinite(rate) ||
          rate < 0
        ) {
          return fail(
            `Valid Rate is required for item ${index + 1}.`,
            400,
          );
        }
      }
    }

    // ============================================================
    // Begin Transaction
    // ============================================================

    await client.query("BEGIN");

    // ============================================================
    // Insert Master
    // ============================================================

    const masterResult = await client.query(
      `
      INSERT INTO Gatepass_NRGP_Entry_Master
      (
        OrganizationID,
        VendorName,
        ContactNumber,
        Company,
        SendTo,
        DepartmentID,
        Address,
        TakenBy,
        Status,
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
        $9,
        CURRENT_TIMESTAMP
      )
      RETURNING
        NRGPID,
        NRGPNumber;
      `,
      [
        organizationID,
        String(data.VendorName).trim(),

        data.ContactNumber
          ? String(data.ContactNumber).trim()
          : null,

        data.Company
          ? String(data.Company).trim()
          : null,

        data.SendTo
          ? String(data.SendTo).trim()
          : null,

        departmentID,

        data.Address
          ? String(data.Address).trim()
          : null,

        data.TakenBy
          ? String(data.TakenBy).trim()
          : null,

        data.UserID || null,
      ],
    );

    const NRGPID =
      Number(masterResult.rows[0].nrgpid);

    const NRGPNumber =
      Number(masterResult.rows[0].nrgpnumber);

    // ============================================================
    // Insert Items
    // ============================================================

    for (const item of data.Items) {
      await client.query(
        `
        INSERT INTO Gatepass_NRGP_Entry_Item_Details
        (
          NRGPID,
          OrganizationID,
          ItemName,
          Specification,
          Quantity,
          Rate,
          MakeModel,
          SerialNumber,
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
          CURRENT_TIMESTAMP
        );
        `,
        [
          NRGPID,
          organizationID,
          String(item.ItemName).trim(),

          item.Specification
            ? String(item.Specification).trim()
            : null,

          Number(item.Quantity),

          item.Rate !== undefined &&
          item.Rate !== null &&
          item.Rate !== ""
            ? Number(item.Rate)
            : null,

          item.MakeModel
            ? String(item.MakeModel).trim()
            : null,

          item.SerialNumber
            ? String(item.SerialNumber).trim()
            : null,

          data.UserID || null,
        ],
      );
    }

    // ============================================================
    // Get Approval Config
    // ============================================================

    const configResult = await client.query(
      `
      SELECT
        NRGPApprovalConfigID,
        ApprovalLevel,
        ApprovalRole,
        ApprovalOrder
      FROM Gatepass_NRGP_Approval_Config
      WHERE OrganizationID = $1
        AND IsDeleted = FALSE
      ORDER BY ApprovalOrder ASC;
      `,
      [organizationID],
    );

    // ============================================================
    // Config / Default Approvals
    // ============================================================

    let approvalFlow = [];

    if (configResult.rows.length > 0) {
      approvalFlow = configResult.rows.map(
        (row) => ({
          NRGPApprovalConfigID:
            Number(row.nrgpapprovalconfigid),

          ApprovalLevel:
            Number(row.approvallevel),

          ApprovalRole:
            row.approvalrole,

          ApprovalOrder:
            Number(row.approvalorder),
        }),
      );
    } else {
      approvalFlow =
        DEFAULT_NRGP_APPROVALS.map(
          (approval, index) => ({
            NRGPApprovalConfigID: null,

            ApprovalLevel:
              Number(approval.LevelNo),

            ApprovalRole:
              approval.ApprovalRole,

            ApprovalOrder:
              index + 1,
          }),
        );
    }

    // ============================================================
    // Insert Approval Flow
    // ============================================================

    for (const approval of approvalFlow) {
      await client.query(
        `
        INSERT INTO Gatepass_NRGP_Approval
        (
          NRGPID,
          NRGPApprovalConfigID,
          ApprovalLevel,
          ApprovalRole,
          ApprovalOrder,
          Status,
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
          'Pending',
          $6,
          CURRENT_TIMESTAMP
        );
        `,
        [
          NRGPID,
          approval.NRGPApprovalConfigID,
          approval.ApprovalLevel,
          approval.ApprovalRole,
          approval.ApprovalOrder,
          data.UserID || null,
        ],
      );
    }

    // ============================================================
    // Commit
    // ============================================================

    await client.query("COMMIT");

    return ok(
      "NRGP created successfully."
    );

  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackError) {
      console.error(
        "Create NRGP Rollback Error:",
        rollbackError.message,
      );
    }

    return databaseFailure(
      error,
      "Create NRGP",
    );
  } finally {
    client.release();
  }
};
// ============================================================NRGP List
const getNRGPList = async (data) => {
  try {
    // ============================================================
    // Pagination
    // ============================================================

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
    // Organization
    // ============================================================

    if (!data.OrganizationID) {
      return fail(
        "OrganizationID is required.",
        400,
      );
    }

    const organizationID =
      Number(data.OrganizationID);

    if (
      !Number.isInteger(organizationID) ||
      organizationID <= 0
    ) {
      return fail(
        "Valid OrganizationID is required.",
        400,
      );
    }

    values.push(
      organizationID,
    );

    conditions.push(
      `m.OrganizationID = $${values.length}`,
    );


    // ============================================================
    // Logged-In User
    // ============================================================

    const loggedInUserID =
      Number(data.UserID);

    const rawUserType =
      String(data.UserType || "")
        .trim()
        .toUpperCase();

    const departmentName =
      String(data.DepartmentName || "")
        .trim()
        .toUpperCase();


    // ============================================================
    // Effective Approval Role
    //
    // HOD + Finance => FC
    // FC / DOF      => FC
    // HOD            => HOD
    // GM             => GM
    // ============================================================

    const userApprovalRole =
      getNRGPUserApprovalRole(
        data.UserType,
        data.DepartmentName,
      );


    // ============================================================
    // Full List Users
    //
    // Security and CEO can see all NRGP records.
    // ============================================================

    const canViewAll =
      rawUserType === "SECURITY" ||
      rawUserType === "CEO";


    // ============================================================
    // Approver Detection
    //
    // Security / CEO => Full list
    // Others         => Approval-based list
    // ============================================================

    const isApprover =
      !canViewAll &&
      Boolean(userApprovalRole);


    // ============================================================
    // NRGP Number
    // ============================================================

    if (data.NRGPNumber) {
      const nrgpNumber =
        Number(data.NRGPNumber);

      if (
        !Number.isInteger(nrgpNumber) ||
        nrgpNumber <= 0
      ) {
        return fail(
          "Valid NRGPNumber is required.",
          400,
        );
      }

      values.push(
        nrgpNumber,
      );

      conditions.push(
        `m.NRGPNumber = $${values.length}`,
      );
    }


    // ============================================================
    // Department
    // ============================================================

    if (data.DepartmentID) {
      const departmentID =
        Number(data.DepartmentID);

      if (
        !Number.isInteger(departmentID) ||
        departmentID <= 0
      ) {
        return fail(
          "Valid DepartmentID is required.",
          400,
        );
      }

      values.push(
        departmentID,
      );

      conditions.push(
        `m.DepartmentID = $${values.length}`,
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
    // Search
    // ============================================================

    if (
      data.Search &&
      String(data.Search).trim()
    ) {
      values.push(
        `%${String(data.Search).trim()}%`,
      );

      const searchIndex =
        values.length;

      conditions.push(`
        (
          CAST(m.NRGPNumber AS TEXT) ILIKE $${searchIndex}
          OR m.VendorName ILIKE $${searchIndex}
          OR m.ContactNumber ILIKE $${searchIndex}
          OR m.Company ILIKE $${searchIndex}
          OR m.SendTo ILIKE $${searchIndex}
          OR m.Address ILIKE $${searchIndex}
          OR m.TakenBy ILIKE $${searchIndex}
          OR d.DepartmentName ILIKE $${searchIndex}
        )
      `);
    }


    // ============================================================
    // Approver Visibility
    //
    // IMPORTANT:
    //
    // Approver ko NRGP tabhi dikhna chahiye jab:
    //
    // 1. Logged-in approver ka approval stage NRGP me exist kare.
    //
    // 2. Logged-in approver ke ApprovalOrder se pehle ke
    //    SAARE approval stages APPROVED hon.
    //
    // Example:
    //
    // HOD -> DOF -> GM
    //
    // HOD Pending
    // => DOF ko nahi dikhega
    //
    // HOD Approved
    // => DOF ko dikhega
    //
    // DOF Pending
    // => GM ko nahi dikhega
    //
    // HOD Approved + DOF Approved
    // => GM ko dikhega
    //
    // FC / DOF are treated as same Finance role.
    // ============================================================

    if (isApprover) {
      values.push(
        userApprovalRole,
      );

      const roleIndex =
        values.length;

      conditions.push(`
        EXISTS (
          SELECT 1

          FROM Gatepass_NRGP_Approval ua

          WHERE ua.NRGPID = m.NRGPID
            AND ua.IsDeleted = FALSE

            -- ==================================================
            -- Logged-In Approver Role
            -- ==================================================

            AND (
              CASE
                WHEN UPPER(
                  TRIM(
                    COALESCE(
                      ua.ApprovalRole,
                      ''
                    )
                  )
                ) IN ('FC', 'DOF')
                  THEN 'FC'

                ELSE UPPER(
                  TRIM(
                    COALESCE(
                      ua.ApprovalRole,
                      ''
                    )
                  )
                )
              END
            ) = $${roleIndex}

            -- ==================================================
            -- Previous Approval Stages
            --
            -- Agar logged-in approver ke stage se pehle
            -- koi bhi stage APPROVED nahi hai,
            -- record visible nahi hoga.
            -- ==================================================

            AND NOT EXISTS (
              SELECT 1

              FROM Gatepass_NRGP_Approval prev

              WHERE prev.NRGPID =
                      ua.NRGPID

                AND prev.IsDeleted =
                      FALSE

                AND prev.ApprovalOrder <
                    ua.ApprovalOrder

                AND UPPER(
                  TRIM(
                    COALESCE(
                      prev.Status,
                      'PENDING'
                    )
                  )
                ) <> 'APPROVED'
            )
        )
      `);
    }


    // ============================================================
    // Status Filter
    //
    // Security / CEO:
    //   Status filter works on Master Status.
    //
    // Approver:
    //   Status filter works on HIS approval status.
    // ============================================================

    if (
      data.Status &&
      String(data.Status).trim()
    ) {
      const normalizedStatus =
        String(data.Status)
          .trim()
          .toUpperCase();

      const reportStatuses = {
        "ALL NRGP OPEN": ["PENDING"],
        "ALL NRGP CLOSED": ["APPROVED"],
        "ALL NRGP CANCELLED": ["CANCELLED", "REJECTED"],
      };
      const masterStatuses = reportStatuses[normalizedStatus];

      if (["ALL", "ALL NRGP"].includes(normalizedStatus)) {
        // No status restriction; visibility and other filters still apply.
      } else if (masterStatuses) {
        values.push(masterStatuses);
        conditions.push(
          `UPPER(TRIM(COALESCE(m.Status, ''))) = ANY($${values.length}::TEXT[])`,
        );
      } else if (canViewAll || !isApprover) {
        values.push(
          normalizedStatus,
        );

        conditions.push(
          `UPPER(TRIM(COALESCE(m.Status, ''))) = $${values.length}`,
        );

      } else if (isApprover) {
        values.push(
          normalizedStatus,
        );

        const statusIndex =
          values.length;

        values.push(
          userApprovalRole,
        );

        const statusRoleIndex =
          values.length;

        conditions.push(`
          EXISTS (
            SELECT 1

            FROM Gatepass_NRGP_Approval sa

            WHERE sa.NRGPID = m.NRGPID
              AND sa.IsDeleted = FALSE

              AND (
                CASE
                  WHEN UPPER(
                    TRIM(
                      COALESCE(
                        sa.ApprovalRole,
                        ''
                      )
                    )
                  ) IN ('FC', 'DOF')
                    THEN 'FC'

                  ELSE UPPER(
                    TRIM(
                      COALESCE(
                        sa.ApprovalRole,
                        ''
                      )
                    )
                  )
                END
              ) = $${statusRoleIndex}

              AND UPPER(
                TRIM(
                  COALESCE(
                    sa.Status,
                    'PENDING'
                  )
                )
              ) = $${statusIndex}
          )
        `);
      }
    }


    // ============================================================
    // Where Clause
    // ============================================================

    const whereClause =
      `WHERE ${conditions.join(" AND ")}`;


    // ============================================================
    // Count
    // Same conditions as list
    // ============================================================

    const countResult =
      await pool.query(
        `
          SELECT
            COUNT(*) AS TotalCount

          FROM Gatepass_NRGP_Entry_Master m

          LEFT JOIN department_master d
            ON d.DepartmentID = m.DepartmentID

          ${whereClause};
        `,
        values,
      );


    const totalCount =
      Number(
        countResult.rows[0]
          .totalcount,
      );


    // ============================================================
    // List
    // ============================================================

    const queryValues = [
      ...values,
      pageSize,
      offset,
    ];

    const limitIndex =
      values.length + 1;

    const offsetIndex =
      values.length + 2;


    const result =
      await pool.query(
        `
          SELECT
            m.NRGPID,
            m.NRGPNumber,
            m.OrganizationID,
            m.VendorName,
            m.ContactNumber,
            m.Company,
            m.SendTo,
            m.DepartmentID,
            d.DepartmentName,
            m.Address,
            m.TakenBy,
            m.Status,
            m.CreatedBy,
            m.CreatedDate,
            m.ModifiedBy,
            m.ModifiedDate

          FROM Gatepass_NRGP_Entry_Master m

          LEFT JOIN department_master d
            ON d.DepartmentID = m.DepartmentID

          ${whereClause}

          ORDER BY
            m.NRGPID DESC

          LIMIT $${limitIndex}
          OFFSET $${offsetIndex};
        `,
        queryValues,
      );


    // ============================================================
    // Get Approvals For Current Page
    // ============================================================

    const approvalsByNRGP =
      new Map();

    if (result.rows.length) {
      const approvalResult =
        await pool.query(
          `
            SELECT
              NRGPApprovalID,
              NRGPID,
              NRGPApprovalConfigID,
              ApprovalLevel,
              ApprovalRole,
              ApprovalOrder,
              Status,
              StatusDateTime,
              ActionBy,
              Remarks

            FROM Gatepass_NRGP_Approval

            WHERE NRGPID = ANY($1::BIGINT[])
              AND IsDeleted = FALSE

            ORDER BY
              NRGPID ASC,
              ApprovalOrder ASC,
              ApprovalLevel ASC,
              NRGPApprovalID ASC;
          `,
          [
            result.rows.map(
              (row) =>
                row.nrgpid,
            ),
          ],
        );


      for (
        const approval of
        approvalResult.rows
      ) {
        const id =
          String(
            approval.nrgpid,
          );

        if (
          !approvalsByNRGP.has(
            id,
          )
        ) {
          approvalsByNRGP.set(
            id,
            [],
          );
        }

        approvalsByNRGP
          .get(id)
          .push(approval);
      }
    }


    // ============================================================
    // Final Mapping
    // ============================================================

    const records =
      result.rows.map(
        (row) => {
          const rawApprovals =
            approvalsByNRGP.get(
              String(
                row.nrgpid,
              ),
            ) || [];


          // ========================================================
          // Current Sequential Pending Approval
          //
          // Approval rows are sorted by ApprovalOrder.
          // First Pending row = current actionable approval.
          // ========================================================

          const currentApproval =
            rawApprovals.find(
              (approval) =>
                String(
                  approval.status ||
                    "PENDING",
                )
                  .trim()
                  .toUpperCase() ===
                "PENDING",
            );


          // ========================================================
          // CanApprove
          //
          // TRUE only if:
          // - current approval is Pending
          // - current approval belongs to logged-in approver
          //
          // FC / DOF are treated as same role.
          // ========================================================

          let CanApprove =
            false;

          if (
            currentApproval &&
            isApprover
          ) {
            const currentRole =
              normalizeNRGPApprovalRole(
                currentApproval
                  .approvalrole,
              );

            CanApprove =
              currentRole ===
              userApprovalRole;
          }


          // ========================================================
          // CanAction
          //
          // Only creator gets TRUE.
          // ========================================================

          const CanAction =
            Number(
              row.createdby,
            ) ===
            loggedInUserID;


          // ========================================================
          // Response
          // ========================================================

          return {
            ...mapNRGPMaster(
              row,
            ),

            CanApprove,

            CanAction,

            Approvals:
              mapNRGPApprovalFlow(
                rawApprovals,
              ),
          };
        },
      );


    // ============================================================
    // Response
    // ============================================================

    return {
      success: true,

      message:
        "NRGP list fetched successfully.",

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

      data:
        records,
    };

  } catch (error) {
    return databaseFailure(
      error,
      "Fetch NRGP list",
    );
  }
};
// ============================================================Total NRGP
const getTotalNRGP = async (data) => {
  try {
    // ============================================================
    // Pagination
    // ============================================================

    const page =
      Number(data.page) || 1;

    const pageSize =
      Math.min(
        Number(data.PageSize) || 10,
        100,
      );

    const offset =
      (page - 1) * pageSize;


    // ============================================================
    // Organization Validation
    // ============================================================

    if (!data.OrganizationID) {
      return fail(
        "OrganizationID is required.",
        400,
      );
    }

    const organizationID =
      Number(data.OrganizationID);

    if (
      !Number.isInteger(organizationID) ||
      organizationID <= 0
    ) {
      return fail(
        "Valid OrganizationID is required.",
        400,
      );
    }


    // ============================================================
    // Conditions
    //
    // NO DATE FILTER
    // NO APPROVER VISIBILITY CONDITION
    // ============================================================

    const values = [
      organizationID,
    ];

    const conditions = [
      "m.IsDeleted = FALSE",
      `m.OrganizationID = $1`,
    ];


    // ============================================================
    // NRGP Number
    // ============================================================

    if (data.NRGPNumber) {
      const nrgpNumber =
        Number(data.NRGPNumber);

      if (
        !Number.isInteger(nrgpNumber) ||
        nrgpNumber <= 0
      ) {
        return fail(
          "Valid NRGPNumber is required.",
          400,
        );
      }

      values.push(
        nrgpNumber,
      );

      conditions.push(
        `m.NRGPNumber = $${values.length}`,
      );
    }


    // ============================================================
    // Department
    // ============================================================

    if (data.DepartmentID) {
      const departmentID =
        Number(data.DepartmentID);

      if (
        !Number.isInteger(departmentID) ||
        departmentID <= 0
      ) {
        return fail(
          "Valid DepartmentID is required.",
          400,
        );
      }

      values.push(
        departmentID,
      );

      conditions.push(
        `m.DepartmentID = $${values.length}`,
      );
    }


    // ============================================================
    // Status
    // ============================================================

    if (
      data.Status &&
      String(data.Status).trim()
    ) {
      values.push(
        String(data.Status)
          .trim()
          .toUpperCase(),
      );

      conditions.push(
        `UPPER(TRIM(COALESCE(m.Status, ''))) = $${values.length}`,
      );
    }


    // ============================================================
    // Search
    // ============================================================

    if (
      data.Search &&
      String(data.Search).trim()
    ) {
      values.push(
        `%${String(data.Search).trim()}%`,
      );

      const searchIndex =
        values.length;

      conditions.push(`
        (
          CAST(
            m.NRGPNumber AS TEXT
          ) ILIKE $${searchIndex}

          OR m.VendorName
            ILIKE $${searchIndex}

          OR m.ContactNumber
            ILIKE $${searchIndex}

          OR m.Company
            ILIKE $${searchIndex}

          OR m.SendTo
            ILIKE $${searchIndex}

          OR m.Address
            ILIKE $${searchIndex}

          OR m.TakenBy
            ILIKE $${searchIndex}

          OR d.DepartmentName
            ILIKE $${searchIndex}
        )
      `);
    }


    // ============================================================
    // Where Clause
    // ============================================================

    const whereClause =
      `WHERE ${conditions.join(
        " AND ",
      )}`;


    // ============================================================
    // Total Count
    // ============================================================

    const countResult =
      await pool.query(
        `
        SELECT
          COUNT(*) AS TotalCount

        FROM Gatepass_NRGP_Entry_Master m

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

    const queryValues = [
      ...values,
      pageSize,
      offset,
    ];

    const limitIndex =
      values.length + 1;

    const offsetIndex =
      values.length + 2;


    // ============================================================
    // Master Data
    // ============================================================

    const result =
      await pool.query(
        `
        SELECT
          m.NRGPID,
          m.NRGPNumber,
          m.OrganizationID,

          m.VendorName,
          m.ContactNumber,
          m.Company,
          m.SendTo,

          m.DepartmentID,
          d.DepartmentName,

          m.Address,
          m.TakenBy,

          m.Status,

          m.CreatedBy,
          m.CreatedDate,

          m.ModifiedBy,
          m.ModifiedDate

        FROM Gatepass_NRGP_Entry_Master m

        LEFT JOIN department_master d
          ON d.DepartmentID =
            m.DepartmentID

        ${whereClause}

        ORDER BY
          m.NRGPID DESC

        LIMIT $${limitIndex}
        OFFSET $${offsetIndex};
        `,
        queryValues,
      );


    // ============================================================
    // Approval Data
    // ============================================================

    const approvalsByNRGP =
      new Map();

    if (result.rows.length > 0) {
      const NRGPIDs =
        result.rows.map(
          (row) =>
            Number(row.nrgpid),
        );

      const approvalResult =
        await pool.query(
          `
          SELECT
            a.NRGPApprovalID,
            a.NRGPID,
            a.NRGPApprovalConfigID,

            a.ApprovalLevel,
            a.ApprovalRole,
            a.ApprovalOrder,

            a.Status,
            a.StatusDateTime,

            a.ActionBy,

            actionUser.FullName
              AS ActionByName,

            a.Remarks

          FROM Gatepass_NRGP_Approval a

          LEFT JOIN user_master actionUser
            ON actionUser.UserID =
              a.ActionBy

          WHERE a.NRGPID =
            ANY($1::BIGINT[])

            AND a.IsDeleted =
              FALSE

          ORDER BY
            a.NRGPID ASC,
            a.ApprovalOrder ASC,
            a.ApprovalLevel ASC,
            a.NRGPApprovalID ASC;
          `,
          [
            NRGPIDs,
          ],
        );


      // ==========================================================
      // Group Approvals By NRGP
      // ==========================================================

      for (
        const approval of
        approvalResult.rows
      ) {
        const NRGPID =
          String(
            approval.nrgpid,
          );

        if (
          !approvalsByNRGP.has(
            NRGPID,
          )
        ) {
          approvalsByNRGP.set(
            NRGPID,
            [],
          );
        }

        approvalsByNRGP
          .get(NRGPID)
          .push(approval);
      }
    }


    // ============================================================
    // Final Mapping
    // ============================================================

    const records =
      result.rows.map(
        (row) => {
          const rawApprovals =
            approvalsByNRGP.get(
              String(
                row.nrgpid,
              ),
            ) || [];

          return {
            ...mapNRGPMaster(
              row,
            ),

            // ====================================================
            // IMPORTANT
            //
            // If any approval is REJECTED / CANCELLED,
            // all approval stages AFTER that will return blank/null.
            //
            // DB data is NOT changed.
            // Only response is changed.
            // ====================================================

            Approvals:
              mapNRGPApprovalFlow(
                rawApprovals,
              ),
          };
        },
      );


    // ============================================================
    // Response
    // ============================================================

    return {
      success:
        true,

      message:
        "Total NRGP fetched successfully.",

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

      data:
        records,
    };

  } catch (error) {
    console.error(
      "Get Total NRGP Error:",
      error.message,
    );

    return databaseFailure(
      error,
      "Fetch total NRGP",
    );
  }
};
// ============================================================ Get NRGP By ID
const getNRGPById = async (data) => {
  try {
    // ============================================================
    // Validate
    // ============================================================

    const NRGPID =
      Number(data.NRGPID);

    if (
      !Number.isInteger(NRGPID) ||
      NRGPID <= 0
    ) {
      return fail(
        "Valid NRGPID is required.",
        400,
      );
    }

    // ============================================================
    // Get Master
    // ============================================================

    const masterResult =
      await pool.query(
        `
        SELECT
          m.NRGPID,
          m.NRGPNumber,
          m.OrganizationID,

          m.VendorName,
          m.ContactNumber,
          m.Company,
          m.SendTo,

          m.DepartmentID,
          d.DepartmentName,

          m.Address,
          m.TakenBy,

          m.Status,

          m.CreatedBy,
          createdUser.FullName
            AS CreatedByName,

          m.CreatedDate,
          m.ModifiedBy,
          m.ModifiedDate

        FROM Gatepass_NRGP_Entry_Master m

        LEFT JOIN department_master d
          ON d.DepartmentID =
            m.DepartmentID

        LEFT JOIN user_master createdUser
          ON createdUser.UserID =
            m.CreatedBy

        WHERE m.NRGPID = $1
          AND m.IsDeleted = FALSE

        LIMIT 1;
        `,
        [
          NRGPID,
        ],
      );

    // ============================================================
    // Not Found
    // ============================================================

    if (
      masterResult.rows.length === 0
    ) {
      return fail(
        "NRGP record not found.",
        404,
      );
    }

    // ============================================================
    // Attach Items + Approvals
    // ============================================================

    const [NRGP] =
      await attachNRGPRelatedData(
        masterResult.rows,
      );

    return ok(
      "NRGP record fetched successfully.",
      NRGP,
    );
  } catch (error) {
    return databaseFailure(
      error,
      "Fetch NRGP record",
    );
  }
};
// ============================================================ Vender Names
const getNRGPVendorNames = async (data) => {
  try {
    // ============================================================
    // Validation
    // ============================================================

    const organizationID = Number(data.OrganizationID);

    if (
      !Number.isInteger(organizationID) ||
      organizationID <= 0
    ) {
      return fail(
        "Valid OrganizationID is required.",
        400,
      );
    }


    // ============================================================
    // Query
    // ============================================================

    const result = await pool.query(
      `
      SELECT DISTINCT
        TRIM(VendorName) AS VendorName

      FROM Gatepass_NRGP_Entry_Master

      WHERE OrganizationID = $1
        AND IsDeleted = FALSE
        AND VendorName IS NOT NULL
        AND TRIM(VendorName) <> ''

      ORDER BY VendorName ASC;
      `,
      [organizationID],
    );


    // ============================================================
    // Mapping
    // ============================================================

    const vendors = result.rows.map((row) => ({
      VendorName: row.vendorname,
    }));


    // ============================================================
    // Response
    // ============================================================

    return {
      success: true,
      message:
        "NRGP vendor names fetched successfully.",
      Count: vendors.length,
      data: vendors,
    };

  } catch (error) {
    console.error(
      "Get NRGP Vendor Names By Organization Error:",
      error.message,
    );

    return databaseFailure(
      error,
      "Fetch NRGP vendor names",
    );
  }
};
// ============================================================ Update NRGP
const updateNRGP = async (data) => {
  const client = await pool.connect();

  try {
    const NRGPID = Number(data.NRGPID);
    const organizationID = Number(data.OrganizationID);
    const departmentID = Number(data.DepartmentID);

    // ============================================================
    // Validation
    // ============================================================

    if (!Number.isInteger(NRGPID) || NRGPID <= 0) {
      return fail("Valid NRGPID is required.", 400);
    }

    if (
      !Number.isInteger(organizationID) ||
      organizationID <= 0
    ) {
      return fail("Valid OrganizationID is required.", 400);
    }

    if (
      !data.VendorName ||
      !String(data.VendorName).trim()
    ) {
      return fail("VendorName is required.", 400);
    }

    if (
      !Number.isInteger(departmentID) ||
      departmentID <= 0
    ) {
      return fail("Valid DepartmentID is required.", 400);
    }

    if (
      data.Items !== undefined &&
      !Array.isArray(data.Items)
    ) {
      return fail("Items must be an array.", 400);
    }

    if (
      data.DeleteItemIDs !== undefined &&
      !Array.isArray(data.DeleteItemIDs)
    ) {
      return fail("DeleteItemIDs must be an array.", 400);
    }

    // ============================================================
    // Validate Items
    // ============================================================

    for (let index = 0; index < (data.Items || []).length; index++) {
      const item = data.Items[index];

      if (
        !item.ItemName ||
        !String(item.ItemName).trim()
      ) {
        return fail(
          `ItemName is required for item ${index + 1}.`,
          400,
        );
      }

      const quantity = Number(item.Quantity);

      if (
        !Number.isFinite(quantity) ||
        quantity <= 0
      ) {
        return fail(
          `Valid Quantity is required for item ${index + 1}.`,
          400,
        );
      }

      if (
        item.NRGPItemID !== undefined &&
        item.NRGPItemID !== null &&
        item.NRGPItemID !== ""
      ) {
        const itemID = Number(item.NRGPItemID);

        if (
          !Number.isInteger(itemID) ||
          itemID <= 0
        ) {
          return fail(
            `Valid NRGPItemID is required for item ${index + 1}.`,
            400,
          );
        }
      }

      if (
        item.Rate !== undefined &&
        item.Rate !== null &&
        item.Rate !== ""
      ) {
        const rate = Number(item.Rate);

        if (
          !Number.isFinite(rate) ||
          rate < 0
        ) {
          return fail(
            `Valid Rate is required for item ${index + 1}.`,
            400,
          );
        }
      }
    }

    // ============================================================
    // Validate Delete Item IDs
    // ============================================================

    for (const id of data.DeleteItemIDs || []) {
      const itemID = Number(id);

      if (
        !Number.isInteger(itemID) ||
        itemID <= 0
      ) {
        return fail(
          "DeleteItemIDs contains an invalid NRGPItemID.",
          400,
        );
      }
    }

    // ============================================================
    // Transaction
    // ============================================================

    await client.query("BEGIN");

    // ============================================================
    // Check NRGP
    // ============================================================

    const existingResult = await client.query(
      `
      SELECT
        NRGPID,
        Status
      FROM Gatepass_NRGP_Entry_Master
      WHERE NRGPID = $1
        AND OrganizationID = $2
        AND IsDeleted = FALSE
      LIMIT 1;
      `,
      [
        NRGPID,
        organizationID,
      ],
    );

    if (!existingResult.rows.length) {
      await client.query("ROLLBACK");

      return fail(
        "NRGP record not found.",
        404,
      );
    }

    // ============================================================
    // Update Master
    // ============================================================

    await client.query(
      `
      UPDATE Gatepass_NRGP_Entry_Master
      SET
        VendorName = $1,
        ContactNumber = $2,
        Company = $3,
        SendTo = $4,
        DepartmentID = $5,
        Address = $6,
        TakenBy = $7,
        ModifiedBy = $8,
        ModifiedDate = CURRENT_TIMESTAMP
      WHERE NRGPID = $9
        AND OrganizationID = $10
        AND IsDeleted = FALSE;
      `,
      [
        String(data.VendorName).trim(),

        data.ContactNumber
          ? String(data.ContactNumber).trim()
          : null,

        data.Company
          ? String(data.Company).trim()
          : null,

        data.SendTo
          ? String(data.SendTo).trim()
          : null,

        departmentID,

        data.Address
          ? String(data.Address).trim()
          : null,

        data.TakenBy
          ? String(data.TakenBy).trim()
          : null,

        data.UserID || null,

        NRGPID,
        organizationID,
      ],
    );

    // ============================================================
    // Delete Items
    // ============================================================

    if (
      Array.isArray(data.DeleteItemIDs) &&
      data.DeleteItemIDs.length > 0
    ) {
      const deleteItemIDs =
        data.DeleteItemIDs.map(Number);

      await client.query(
        `
        UPDATE Gatepass_NRGP_Entry_Item_Details
        SET
          IsDeleted = TRUE,
          DeletedBy = $1,
          DeletedDateTime = CURRENT_TIMESTAMP,
          ModifiedBy = $1,
          ModifiedDate = CURRENT_TIMESTAMP
        WHERE NRGPID = $2
          AND OrganizationID = $3
          AND NRGPItemID = ANY($4::BIGINT[])
          AND IsDeleted = FALSE;
        `,
        [
          data.UserID || null,
          NRGPID,
          organizationID,
          deleteItemIDs,
        ],
      );
    }

    // ============================================================
    // Update / Insert Items
    // ============================================================

    for (const item of data.Items || []) {
      if (item.NRGPItemID) {
        // ========================================================
        // Existing Item
        // ========================================================

        const itemResult = await client.query(
          `
          UPDATE Gatepass_NRGP_Entry_Item_Details
          SET
            ItemName = $1,
            Specification = $2,
            Quantity = $3,
            Rate = $4,
            MakeModel = $5,
            SerialNumber = $6,
            ModifiedBy = $7,
            ModifiedDate = CURRENT_TIMESTAMP
          WHERE NRGPItemID = $8
            AND NRGPID = $9
            AND OrganizationID = $10
            AND IsDeleted = FALSE
          RETURNING NRGPItemID;
          `,
          [
            String(item.ItemName).trim(),

            item.Specification
              ? String(item.Specification).trim()
              : null,

            Number(item.Quantity),

            item.Rate !== undefined &&
            item.Rate !== null &&
            item.Rate !== ""
              ? Number(item.Rate)
              : null,

            item.MakeModel
              ? String(item.MakeModel).trim()
              : null,

            item.SerialNumber
              ? String(item.SerialNumber).trim()
              : null,

            data.UserID || null,

            Number(item.NRGPItemID),
            NRGPID,
            organizationID,
          ],
        );

        if (!itemResult.rows.length) {
          await client.query("ROLLBACK");

          return fail(
            `NRGP item ${item.NRGPItemID} not found.`,
            404,
          );
        }
      } else {
        // ========================================================
        // New Item
        // ========================================================

        await client.query(
          `
          INSERT INTO Gatepass_NRGP_Entry_Item_Details
          (
            NRGPID,
            OrganizationID,
            ItemName,
            Specification,
            Quantity,
            Rate,
            MakeModel,
            SerialNumber,
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
            CURRENT_TIMESTAMP
          );
          `,
          [
            NRGPID,
            organizationID,

            String(item.ItemName).trim(),

            item.Specification
              ? String(item.Specification).trim()
              : null,

            Number(item.Quantity),

            item.Rate !== undefined &&
            item.Rate !== null &&
            item.Rate !== ""
              ? Number(item.Rate)
              : null,

            item.MakeModel
              ? String(item.MakeModel).trim()
              : null,

            item.SerialNumber
              ? String(item.SerialNumber).trim()
              : null,

            data.UserID || null,
          ],
        );
      }
    }

    // ============================================================
    // Ensure At Least One Active Item
    // ============================================================

    const itemCountResult = await client.query(
      `
      SELECT COUNT(*) AS TotalCount
      FROM Gatepass_NRGP_Entry_Item_Details
      WHERE NRGPID = $1
        AND OrganizationID = $2
        AND IsDeleted = FALSE;
      `,
      [
        NRGPID,
        organizationID,
      ],
    );

    if (
      Number(itemCountResult.rows[0].totalcount) === 0
    ) {
      await client.query("ROLLBACK");

      return fail(
        "At least one active item is required.",
        400,
      );
    }

    // ============================================================
    // Commit
    // ============================================================

    await client.query("COMMIT");

    return ok(
      "NRGP updated successfully."
    );
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackError) {
      console.error(
        "Update NRGP Rollback Error:",
        rollbackError.message,
      );
    }

    return databaseFailure(
      error,
      "Update NRGP",
    );
  } finally {
    client.release();
  }
};
// ============================================================ Delete NRGP
const deleteNRGP = async (data) => {
  const client = await pool.connect();

  try {
    const NRGPID = Number(data.NRGPID);

    if (
      !Number.isInteger(NRGPID) ||
      NRGPID <= 0
    ) {
      return fail(
        "Valid NRGPID is required.",
        400,
      );
    }

    // ============================================================
    // Transaction
    // ============================================================

    await client.query("BEGIN");

    // ============================================================
    // Check NRGP
    // ============================================================

    const existingResult =
      await client.query(
        `
        SELECT
          NRGPID,
          Status
        FROM Gatepass_NRGP_Entry_Master
        WHERE NRGPID = $1
          AND IsDeleted = FALSE
        LIMIT 1;
        `,
        [NRGPID],
      );

    if (!existingResult.rows.length) {
      await client.query("ROLLBACK");

      return fail(
        "NRGP record not found.",
        404,
      );
    }

    // ============================================================
    // Delete Items
    // ============================================================

    await client.query(
      `
      UPDATE Gatepass_NRGP_Entry_Item_Details
      SET
        IsDeleted = TRUE,
        DeletedBy = $1,
        DeletedDateTime = CURRENT_TIMESTAMP,
        ModifiedBy = $1,
        ModifiedDate = CURRENT_TIMESTAMP
      WHERE NRGPID = $2
        AND IsDeleted = FALSE;
      `,
      [
        data.UserID || null,
        NRGPID,
      ],
    );

    // ============================================================
    // Delete Approvals
    // ============================================================

    await client.query(
      `
      UPDATE Gatepass_NRGP_Approval
      SET
        IsDeleted = TRUE,
        DeletedBy = $1,
        DeletedDateTime = CURRENT_TIMESTAMP,
        ModifiedBy = $1,
        ModifiedDate = CURRENT_TIMESTAMP
      WHERE NRGPID = $2
        AND IsDeleted = FALSE;
      `,
      [
        data.UserID || null,
        NRGPID,
      ],
    );

    // ============================================================
    // Delete Master
    // ============================================================

    await client.query(
      `
      UPDATE Gatepass_NRGP_Entry_Master
      SET
        IsDeleted = TRUE,
        DeletedBy = $1,
        DeletedDateTime = CURRENT_TIMESTAMP,
        ModifiedBy = $1,
        ModifiedDate = CURRENT_TIMESTAMP
      WHERE NRGPID = $2
        AND IsDeleted = FALSE;
      `,
      [
        data.UserID || null,
        NRGPID,
      ],
    );

    // ============================================================
    // Commit
    // ============================================================

    await client.query("COMMIT");

    return ok(
      "NRGP deleted successfully.",
      {
        NRGPID,
      },
    );

  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackError) {
      console.error(
        "Delete NRGP Rollback Error:",
        rollbackError.message,
      );
    }

    return databaseFailure(
      error,
      "Delete NRGP",
    );
  } finally {
    client.release();
  }
};
// ============================================================ NRGP Approval
const processNRGPApproval = async (data) => {
  const client = await pool.connect();

  try {
    const NRGPID =
      Number(data.NRGPID);

    const action =
      String(data.Action || "")
        .trim()
        .toUpperCase();

    // ============================================================
    // Logged-In User Effective Approval Role
    //
    // HOD + Finance => FC
    // FC / DOF      => FC
    // HOD           => HOD
    // GM            => GM
    // ============================================================

    const userApprovalRole =
      getNRGPUserApprovalRole(
        data.UserType,
        data.DepartmentName,
      );

    // ============================================================
    // Validation
    // ============================================================

    if (
      !Number.isInteger(NRGPID) ||
      NRGPID <= 0
    ) {
      return fail(
        "Valid NRGPID is required.",
        400,
      );
    }

    if (
      ![
        "APPROVE",
        "REJECT",
        "CANCEL",
      ].includes(action)
    ) {
      return fail(
        "Action must be APPROVE, REJECT or CANCEL.",
        400,
      );
    }

    if (!userApprovalRole) {
      return fail(
        "User approval role is required.",
        400,
      );
    }

    // ============================================================
    // Begin Transaction
    // ============================================================

    await client.query(
      "BEGIN",
    );

    // ============================================================
    // Get NRGP
    // Lock master record while approval is processing
    // ============================================================

    const masterResult =
      await client.query(
        `
          SELECT
            NRGPID,
            NRGPNumber,
            OrganizationID,
            Status

          FROM Gatepass_NRGP_Entry_Master

          WHERE NRGPID = $1
            AND IsDeleted = FALSE

          FOR UPDATE;
        `,
        [
          NRGPID,
        ],
      );

    // ============================================================
    // NRGP Not Found
    // ============================================================

    if (
      !masterResult.rows.length
    ) {
      await client.query(
        "ROLLBACK",
      );

      return fail(
        "NRGP record not found.",
        404,
      );
    }

    const master =
      masterResult.rows[0];

    const currentStatus =
      String(
        master.status || "",
      )
        .trim()
        .toUpperCase();

    // ============================================================
    // Final Status Check
    // ============================================================

    if (
      [
        "APPROVED",
        "REJECTED",
        "CANCELLED",
      ].includes(
        currentStatus,
      )
    ) {
      await client.query(
        "ROLLBACK",
      );

      return fail(
        `NRGP is already ${currentStatus}.`,
        400,
      );
    }

    // ============================================================
    // Get Current Pending Approval
    //
    // Sequential approval:
    // Lowest pending ApprovalOrder is current approval.
    // ============================================================

    const currentApprovalResult =
      await client.query(
        `
          SELECT
            NRGPApprovalID,
            NRGPID,
            NRGPApprovalConfigID,
            ApprovalLevel,
            ApprovalRole,
            ApprovalOrder,
            Status

          FROM Gatepass_NRGP_Approval

          WHERE NRGPID = $1
            AND IsDeleted = FALSE
            AND UPPER(
                  TRIM(
                    COALESCE(
                      Status,
                      'PENDING'
                    )
                  )
                ) = 'PENDING'

          ORDER BY
            ApprovalOrder ASC

          LIMIT 1

          FOR UPDATE;
        `,
        [
          NRGPID,
        ],
      );

    // ============================================================
    // No Pending Approval
    // ============================================================

    if (
      !currentApprovalResult
        .rows.length
    ) {
      await client.query(
        "ROLLBACK",
      );

      return fail(
        "No pending approval found for this NRGP.",
        400,
      );
    }

    const currentApproval =
      currentApprovalResult
        .rows[0];

    // ============================================================
    // Normalize Current Approval Role
    //
    // FC  => FC
    // DOF => FC
    // HOD => HOD
    // GM  => GM
    // ============================================================

    const approvalRole =
      normalizeNRGPApprovalRole(
        currentApproval
          .approvalrole,
      );

    // ============================================================
    // Debug
    // ============================================================

    console.log(
      "========== NRGP APPROVAL ROLE CHECK ==========",
    );

    console.log(
      "JWT UserType:",
      data.UserType,
    );

    console.log(
      "JWT DepartmentName:",
      data.DepartmentName,
    );

    console.log(
      "Effective User Approval Role:",
      userApprovalRole,
    );

    console.log(
      "DB ApprovalRole:",
      currentApproval.approvalrole,
    );

    console.log(
      "Normalized DB ApprovalRole:",
      approvalRole,
    );

    console.log(
      "==============================================",
    );

    // ============================================================
    // Role Validation
    //
    // Examples:
    //
    // HOD + Finance => FC
    // DB DOF        => FC
    // FC === FC     => Allowed
    //
    // Normal HOD + other department => HOD
    // ============================================================

    if (
      approvalRole !==
      userApprovalRole
    ) {
      await client.query(
        "ROLLBACK",
      );

      return fail(
        `Current approval is pending with ${currentApproval.approvalrole}.`,
        403,
      );
    }

    // ============================================================
    // APPROVE
    // ============================================================

    if (
      action ===
      "APPROVE"
    ) {
      // ==========================================================
      // Approve Current Stage
      // ==========================================================

      await client.query(
        `
          UPDATE Gatepass_NRGP_Approval

          SET
            Status = 'Approved',

            StatusDateTime =
              CURRENT_TIMESTAMP,

            ActionBy = $1,

            Remarks = $2,

            ModifiedBy = $1,

            ModifiedDate =
              CURRENT_TIMESTAMP

          WHERE NRGPApprovalID = $3
            AND IsDeleted = FALSE;
        `,
        [
          data.UserID ||
            null,

          data.Remarks
            ? String(
                data.Remarks,
              ).trim()
            : null,

          currentApproval
            .nrgpapprovalid,
        ],
      );

      // ==========================================================
      // Check Remaining Pending Approvals
      // ==========================================================

      const pendingResult =
        await client.query(
          `
            SELECT
              NRGPApprovalID

            FROM Gatepass_NRGP_Approval

            WHERE NRGPID = $1
              AND IsDeleted = FALSE

              AND UPPER(
                    TRIM(
                      COALESCE(
                        Status,
                        'PENDING'
                      )
                    )
                  ) = 'PENDING'

            ORDER BY
              ApprovalOrder ASC

            LIMIT 1;
          `,
          [
            NRGPID,
          ],
        );

      // ==========================================================
      // No Pending Approval
      // All Approval Stages Completed
      // ==========================================================

      if (
        !pendingResult
          .rows.length
      ) {
        await client.query(
          `
            UPDATE Gatepass_NRGP_Entry_Master

            SET
              Status = 'APPROVED',

              ModifiedBy = $1,

              ModifiedDate =
                CURRENT_TIMESTAMP

            WHERE NRGPID = $2
              AND IsDeleted = FALSE;
          `,
          [
            data.UserID ||
              null,

            NRGPID,
          ],
        );
      }

      // ==========================================================
      // Commit
      // ==========================================================

      await client.query(
        "COMMIT",
      );

      // ==========================================================
      // Response
      // ==========================================================

      return ok(
        pendingResult.rows.length
          ? "NRGP approved successfully and moved to the next approval level."
          : "NRGP fully approved successfully.",
        {
          NRGPID,

          Action:
            "APPROVE",

          Status:
            pendingResult
              .rows.length
              ? "PENDING"
              : "APPROVED",
        },
      );
    }

    // ============================================================
    // REJECT
    // ============================================================

    if (
      action ===
      "REJECT"
    ) {
      // ==========================================================
      // Reject Current Approval Stage
      // ==========================================================

      await client.query(
        `
          UPDATE Gatepass_NRGP_Approval

          SET
            Status = 'Rejected',

            StatusDateTime =
              CURRENT_TIMESTAMP,

            ActionBy = $1,

            Remarks = $2,

            ModifiedBy = $1,

            ModifiedDate =
              CURRENT_TIMESTAMP

          WHERE NRGPApprovalID = $3
            AND IsDeleted = FALSE;
        `,
        [
          data.UserID ||
            null,

          data.Remarks
            ? String(
                data.Remarks,
              ).trim()
            : null,

          currentApproval
            .nrgpapprovalid,
        ],
      );

      // ==========================================================
      // Update Master Status
      // ==========================================================

      await client.query(
        `
          UPDATE Gatepass_NRGP_Entry_Master

          SET
            Status = 'REJECTED',

            ModifiedBy = $1,

            ModifiedDate =
              CURRENT_TIMESTAMP

          WHERE NRGPID = $2
            AND IsDeleted = FALSE;
        `,
        [
          data.UserID ||
            null,

          NRGPID,
        ],
      );

      // ==========================================================
      // Commit
      // ==========================================================

      await client.query(
        "COMMIT",
      );

      return ok(
        "NRGP rejected successfully.",
        {
          NRGPID,

          Action:
            "REJECT",

          Status:
            "REJECTED",
        },
      );
    }

    // ============================================================
    // CANCEL
    // ============================================================

    if (
      action ===
      "CANCEL"
    ) {
      // ==========================================================
      // Cancel Current Approval Stage
      // ==========================================================

      await client.query(
        `
          UPDATE Gatepass_NRGP_Approval

          SET
            Status = 'Cancelled',

            StatusDateTime =
              CURRENT_TIMESTAMP,

            ActionBy = $1,

            Remarks = $2,

            ModifiedBy = $1,

            ModifiedDate =
              CURRENT_TIMESTAMP

          WHERE NRGPApprovalID = $3
            AND IsDeleted = FALSE;
        `,
        [
          data.UserID ||
            null,

          data.Remarks
            ? String(
                data.Remarks,
              ).trim()
            : null,

          currentApproval
            .nrgpapprovalid,
        ],
      );

      // ==========================================================
      // Update Master Status
      // ==========================================================

      await client.query(
        `
          UPDATE Gatepass_NRGP_Entry_Master

          SET
            Status = 'CANCELLED',

            ModifiedBy = $1,

            ModifiedDate =
              CURRENT_TIMESTAMP

          WHERE NRGPID = $2
            AND IsDeleted = FALSE;
        `,
        [
          data.UserID ||
            null,

          NRGPID,
        ],
      );

      // ==========================================================
      // Commit
      // ==========================================================

      await client.query(
        "COMMIT",
      );

      return ok(
        "NRGP cancelled successfully.",
        {
          NRGPID,

          Action:
            "CANCEL",

          Status:
            "CANCELLED",
        },
      );
    }

    // ============================================================
    // Safety Rollback
    // Normally execution never reaches here
    // ============================================================

    await client.query(
      "ROLLBACK",
    );

    return fail(
      "Unable to process NRGP approval.",
      400,
    );
  } catch (error) {
    // ============================================================
    // Rollback
    // ============================================================

    try {
      await client.query(
        "ROLLBACK",
      );
    } catch (
      rollbackError
    ) {
      console.error(
        "Process NRGP Approval Rollback Error:",
        rollbackError.message,
      );
    }

    console.error(
      "Process NRGP Approval Error:",
      error,
    );

    return databaseFailure(
      error,
      "Process NRGP approval",
    );
  } finally {
    // ============================================================
    // Release DB Client
    // ============================================================

    client.release();
  }
};
// ============================================================ Get NRGP Approval Config List
const getNRGPApprovalConfig = async (data) => {
  try {
    const organizationID =
      Number(data.OrganizationID);

    if (
      !Number.isInteger(organizationID) ||
      organizationID <= 0
    ) {
      return fail(
        "Valid OrganizationID is required.",
        400,
      );
    }

    const result =
      await pool.query(
        `
        SELECT
          NRGPApprovalConfigID,
          OrganizationID,
          ApprovalLevel,
          ApprovalRole,
          ApprovalOrder,
          IsMandatory,
          CreatedBy,
          CreatedDate,
          ModifiedBy,
          ModifiedDate
        FROM Gatepass_NRGP_Approval_Config
        WHERE OrganizationID = $1
          AND IsDeleted = FALSE
        ORDER BY ApprovalOrder ASC;
        `,
        [organizationID],
      );

    const records =
      result.rows.map((row) => ({
        NRGPApprovalConfigID:
          Number(row.nrgpapprovalconfigid),

ApprovalLevel:
          Number(row.approvallevel),

        ApprovalRole:
          row.approvalrole,

        ApprovalOrder:
          Number(row.approvalorder),

        IsMandatory:
          row.ismandatory,

      

        


      }));

    return ok(
      "NRGP approval config fetched successfully.",
      {
        OrganizationID: organizationID,
        CreatedDate: result.rows[0]?.createddate
          ? formatDate(result.rows[0].createddate)
          : null,
        Approvals: records,
      },
    );

  } catch (error) {
    return databaseFailure(
      error,
      "Fetch NRGP approval config",
    );
  }
};
// ============================================================ Save NRGP Approval Config
const syncPendingNRGPApprovals = async (client, organizationID, approvals, userID) => {
  const masters = await client.query(
    `SELECT NRGPID FROM Gatepass_NRGP_Entry_Master
     WHERE OrganizationID = $1 AND IsDeleted = FALSE
       AND UPPER(TRIM(Status)) = 'PENDING'
     ORDER BY NRGPID FOR UPDATE;`,
    [organizationID],
  );
  let syncedCount = 0;
  for (const master of masters.rows) {
    const existing = await client.query(
      `SELECT * FROM Gatepass_NRGP_Approval WHERE NRGPID = $1
       ORDER BY IsDeleted ASC, NRGPApprovalID DESC FOR UPDATE;`,
      [master.nrgpid],
    );
    // Never reset approval history, including previously deleted actioned rows.
    if (existing.rows.some((row) =>
      String(row.status || "").trim().toUpperCase() !== "PENDING" ||
      row.actionby != null || row.statusdatetime != null
    )) continue;

    const byOrder = new Map();
    for (const row of existing.rows) {
      const order = Number(row.approvalorder);
      if (!byOrder.has(order)) byOrder.set(order, row);
    }
    const keepIDs = [];
    for (const approval of approvals) {
      const row = byOrder.get(approval.ApprovalOrder);
      if (row) {
        await client.query(
          `UPDATE Gatepass_NRGP_Approval
           SET NRGPApprovalConfigID = $1, ApprovalLevel = $2,
               ApprovalRole = $3, ApprovalOrder = $4,
               IsDeleted = FALSE, DeletedBy = NULL, DeletedDateTime = NULL,
               ModifiedBy = $5, ModifiedDate = CURRENT_TIMESTAMP
           WHERE NRGPApprovalID = $6;`,
          [approval.NRGPApprovalConfigID, approval.ApprovalLevel,
            approval.ApprovalRole, approval.ApprovalOrder, userID || null,
            row.nrgpapprovalid],
        );
        keepIDs.push(row.nrgpapprovalid);
      } else {
        const inserted = await client.query(
          `INSERT INTO Gatepass_NRGP_Approval
           (NRGPID, NRGPApprovalConfigID, ApprovalLevel, ApprovalRole,
            ApprovalOrder, Status, CreatedBy, CreatedDate)
           VALUES ($1, $2, $3, $4, $5, 'Pending', $6, CURRENT_TIMESTAMP)
           RETURNING NRGPApprovalID;`,
          [master.nrgpid, approval.NRGPApprovalConfigID, approval.ApprovalLevel,
            approval.ApprovalRole, approval.ApprovalOrder, userID || null],
        );
        keepIDs.push(inserted.rows[0].nrgpapprovalid);
      }
    }
    await client.query(
      `UPDATE Gatepass_NRGP_Approval
       SET IsDeleted = TRUE, DeletedBy = $1, DeletedDateTime = CURRENT_TIMESTAMP,
           ModifiedBy = $1, ModifiedDate = CURRENT_TIMESTAMP
       WHERE NRGPID = $2 AND IsDeleted = FALSE
         AND NOT (NRGPApprovalID = ANY($3::BIGINT[]));`,
      [userID || null, master.nrgpid, keepIDs],
    );
    syncedCount += 1;
  }
  return syncedCount;
};
const saveNRGPApprovalConfig = async (data) => {
  const client = await pool.connect();

  try {
    const organizationID =
      Number(data.OrganizationID);

    // ============================================================
    // Validation
    // ============================================================

    if (
      !Number.isInteger(organizationID) ||
      organizationID <= 0
    ) {
      return fail(
        "Valid OrganizationID is required.",
        400,
      );
    }

    if (
      !Array.isArray(data.Approvals) ||
      data.Approvals.length === 0
    ) {
      return fail(
        "At least one approval configuration is required.",
        400,
      );
    }

    // ============================================================
    // Validate Approval Rows
    // ============================================================

    const approvalOrders =
      new Set();

    for (
      let index = 0;
      index < data.Approvals.length;
      index++
    ) {
      const approval =
        data.Approvals[index];

      const approvalLevel =
        Number(approval.ApprovalLevel);

      const approvalOrder =
        Number(approval.ApprovalOrder);

      if (
        !Number.isInteger(approvalLevel) ||
        approvalLevel <= 0
      ) {
        return fail(
          `Valid ApprovalLevel is required for approval ${index + 1}.`,
          400,
        );
      }

      if (
        !approval.ApprovalRole ||
        !String(approval.ApprovalRole).trim()
      ) {
        return fail(
          `ApprovalRole is required for approval ${index + 1}.`,
          400,
        );
      }

      if (
        !Number.isInteger(approvalOrder) ||
        approvalOrder <= 0
      ) {
        return fail(
          `Valid ApprovalOrder is required for approval ${index + 1}.`,
          400,
        );
      }

      if (
        approvalOrders.has(
          approvalOrder,
        )
      ) {
        return fail(
          `Duplicate ApprovalOrder ${approvalOrder} is not allowed.`,
          400,
        );
      }

      approvalOrders.add(
        approvalOrder,
      );
    }

    // ============================================================
    // Begin Transaction
    // ============================================================

    await client.query(
      "BEGIN",
    );

    // ============================================================
    // Serialize saves for the organization, including its first configuration.
    const organization = await client.query(
      `SELECT OrganizationID FROM Organization_Master WHERE OrganizationID = $1 FOR UPDATE;`,
      [organizationID],
    );
    if (!organization.rows.length) {
      await client.query("ROLLBACK");
      return fail("Organization not found.", 404);
    }
    const existingConfig = await client.query(
      `SELECT NRGPApprovalConfigID, ApprovalOrder
       FROM Gatepass_NRGP_Approval_Config
       WHERE OrganizationID = $1 FOR UPDATE;`,
      [organizationID],
    );
    const existingByOrder = new Map(existingConfig.rows.map((row) => [Number(row.approvalorder), row]));

    // Soft-delete only orders omitted from the incoming flow.
    // ============================================================

    await client.query(
      `
      UPDATE Gatepass_NRGP_Approval_Config
      SET
        IsDeleted = TRUE,
        DeletedBy = $1,
        DeletedDateTime = CURRENT_TIMESTAMP,
        ModifiedBy = $1,
        ModifiedDate = CURRENT_TIMESTAMP
      WHERE OrganizationID = $2
        AND IsDeleted = FALSE
        AND NOT (ApprovalOrder = ANY($3::INT[]));
      `,
      [
        data.UserID || null,
        organizationID,
        [...approvalOrders],
      ],
    );

    // ============================================================
    // Insert New Config
    // ============================================================

    const savedApprovals = [];

    const sortedApprovals =
      [...data.Approvals].sort(
        (a, b) =>
          Number(a.ApprovalOrder) -
          Number(b.ApprovalOrder),
      );

    for (
      const approval
      of sortedApprovals
    ) {
      const existing = existingByOrder.get(Number(approval.ApprovalOrder));
      const result = existing
        ? await client.query(
            `UPDATE Gatepass_NRGP_Approval_Config
             SET ApprovalLevel = $1, ApprovalRole = $2, IsMandatory = $3,
                 IsDeleted = FALSE, DeletedBy = NULL, DeletedDateTime = NULL,
                 ModifiedBy = $4, ModifiedDate = CURRENT_TIMESTAMP
             WHERE NRGPApprovalConfigID = $5 AND OrganizationID = $6
             RETURNING NRGPApprovalConfigID, OrganizationID, ApprovalLevel,
                       ApprovalRole, ApprovalOrder, IsMandatory;`,
            [Number(approval.ApprovalLevel), String(approval.ApprovalRole).trim(),
             approval.IsMandatory !== false, data.UserID || null,
             existing.nrgpapprovalconfigid, organizationID],
          )
        : await client.query(
          `
          INSERT INTO Gatepass_NRGP_Approval_Config
          (
            OrganizationID,
            ApprovalLevel,
            ApprovalRole,
            ApprovalOrder,
            IsMandatory,
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
            CURRENT_TIMESTAMP
          )
          RETURNING
            NRGPApprovalConfigID,
            OrganizationID,
            ApprovalLevel,
            ApprovalRole,
            ApprovalOrder,
            IsMandatory;
          `,
          [
            organizationID,

            Number(
              approval.ApprovalLevel,
            ),

            String(
              approval.ApprovalRole,
            ).trim(),

            Number(
              approval.ApprovalOrder,
            ),

            approval.IsMandatory !== false,

            data.UserID || null,
          ],
        );

      const row =
        result.rows[0];

      savedApprovals.push({
        NRGPApprovalConfigID:
          Number(
            row.nrgpapprovalconfigid,
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
          row.ismandatory,
      });
    }

    await syncPendingNRGPApprovals(client, organizationID, savedApprovals, data.UserID);

    // ============================================================
    // Commit
    // ============================================================

    await client.query(
      "COMMIT",
    );

    return ok(
      "NRGP approval configuration saved successfully.",
    );

  } catch (error) {
    try {
      await client.query(
        "ROLLBACK",
      );
    } catch (rollbackError) {
      console.error(
        "Save NRGP Approval Config Rollback Error:",
        rollbackError.message,
      );
    }

    return databaseFailure(
      error,
      "Save NRGP approval config",
    );
  } finally {
    client.release();
  }
};
// ============================================================ Delete NRGP Approval Config
const deleteNRGPApprovalConfig = async (data) => {
  try {
    const configID =
      Number(data.NRGPApprovalConfigID);

    // ============================================================
    // Validation
    // ============================================================

    if (
      !Number.isInteger(configID) ||
      configID <= 0
    ) {
      return fail(
        "Valid NRGPApprovalConfigID is required.",
        400,
      );
    }

    // ============================================================
    // Check Config
    // ============================================================

    const existingResult =
      await pool.query(
        `
        SELECT
          NRGPApprovalConfigID,
          OrganizationID,
          ApprovalLevel,
          ApprovalRole,
          ApprovalOrder
        FROM Gatepass_NRGP_Approval_Config
        WHERE NRGPApprovalConfigID = $1
          AND IsDeleted = FALSE
        LIMIT 1;
        `,
        [configID],
      );

    if (!existingResult.rows.length) {
      return fail(
        "NRGP approval configuration not found.",
        404,
      );
    }

    // ============================================================
    // Soft Delete
    // ============================================================

    await pool.query(
      `
      UPDATE Gatepass_NRGP_Approval_Config
      SET
        IsDeleted = TRUE,
        DeletedBy = $1,
        DeletedDateTime = CURRENT_TIMESTAMP,
        ModifiedBy = $1,
        ModifiedDate = CURRENT_TIMESTAMP
      WHERE NRGPApprovalConfigID = $2
        AND IsDeleted = FALSE;
      `,
      [
        data.UserID || null,
        configID,
      ],
    );

    return ok(
      "NRGP approval configuration deleted successfully.",
      {
        NRGPApprovalConfigID:
          configID,
      },
    );

  } catch (error) {
    return databaseFailure(
      error,
      "Delete NRGP approval config",
    );
  }
};
// ========================================================================Reports
// ============================================================ NRGP List Report
const getNRGPListReport = async (data) => {
  try {
    // ============================================================
    // Pagination
    // ============================================================

    const page = Number(data.page) || 1;

    const pageSize = Math.min(
      Number(data.PageSize) || 10,
      100,
    );

    const offset = (page - 1) * pageSize;


    // ============================================================
    // Validation
    // ============================================================

    const organizationID = Number(data.OrganizationID);

    if (
      !Number.isInteger(organizationID) ||
      organizationID <= 0
    ) {
      return fail(
        "Valid OrganizationID is required.",
        400,
      );
    }


    // ============================================================
    // Conditions
    // ============================================================

    const values = [
      organizationID,
    ];

    const conditions = [
      "m.IsDeleted = FALSE",
      `m.OrganizationID = $${values.length}`,
    ];


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
    // Department
    // ============================================================

    if (data.DepartmentID) {
      const departmentID = Number(data.DepartmentID);

      if (
        !Number.isInteger(departmentID) ||
        departmentID <= 0
      ) {
        return fail(
          "Invalid DepartmentID.",
          400,
        );
      }

      values.push(departmentID);

      conditions.push(
        `m.DepartmentID = $${values.length}`,
      );
    }


    // ============================================================
    // Report Type / Status
    // ============================================================

    if (data.Status) {
      const status = String(data.Status)
        .trim()
        .toUpperCase();

      switch (status) {
        // ========================================================
        // Open
        // ========================================================

        case "ALL NRGP OPEN":
          conditions.push(
            `UPPER(m.Status) = 'PENDING'`,
          );
          break;


        // ========================================================
        // Closed
        // ========================================================

        case "ALL NRGP CLOSED":
          conditions.push(
            `UPPER(m.Status) = 'APPROVED'`,
          );
          break;


        // ========================================================
        // Cancelled / Rejected
        // ========================================================

        case "ALL NRGP CANCELLED":
          conditions.push(
            `UPPER(m.Status) IN ('CANCELLED', 'REJECTED')`,
          );
          break;


        default:
          return fail(
            "Invalid Status.",
            400,
          );
      }
    }


    // ============================================================
    // Where Clause
    // ============================================================

    const whereClause =
      conditions.join(" AND ");


    // ============================================================
    // Count Query
    // ============================================================

    const countResult = await pool.query(
      `
      SELECT
        COUNT(*)::INT AS TotalCount

      FROM Gatepass_NRGP_Entry_Master m

      LEFT JOIN department_master d
        ON d.DepartmentID = m.DepartmentID

      WHERE ${whereClause};
      `,
      values,
    );


    // ============================================================
    // Pagination Query Values
    // ============================================================

    const queryValues = [
      ...values,
      pageSize,
      offset,
    ];

    const limitPosition =
      queryValues.length - 1;

    const offsetPosition =
      queryValues.length;


    // ============================================================
    // Master Report Query
    // ============================================================

    const result = await pool.query(
      `
      SELECT
        m.NRGPID,
        m.NRGPNumber,
        m.OrganizationID,

        m.VendorName,
        m.ContactNumber,
        m.Company,
        m.SendTo,

        m.DepartmentID,
        d.DepartmentName,

        m.Address,
        m.TakenBy,

        m.Status,

        m.CreatedBy,
        m.CreatedDate

      FROM Gatepass_NRGP_Entry_Master m

      LEFT JOIN department_master d
        ON d.DepartmentID = m.DepartmentID

      WHERE ${whereClause}

      ORDER BY
        m.CreatedDate DESC,
        m.NRGPID DESC

      LIMIT $${limitPosition}
      OFFSET $${offsetPosition};
      `,
      queryValues,
    );


    // ============================================================
    // Get NRGP IDs
    // ============================================================

    const NRGPIDs = result.rows.map(
      (row) => Number(row.nrgpid),
    );


    // ============================================================
    // Get Items
    // ============================================================

    let itemRows = [];

    if (NRGPIDs.length > 0) {
      const itemResult = await pool.query(
        `
        SELECT
          NRGPItemID,
          NRGPID,
          ItemName,
          Quantity

        FROM Gatepass_NRGP_Entry_Item_Details

        WHERE NRGPID = ANY($1::BIGINT[])
          AND IsDeleted = FALSE

        ORDER BY
          NRGPID ASC,
          NRGPItemID ASC;
        `,
        [NRGPIDs],
      );

      itemRows = itemResult.rows;
    }


    // ============================================================
    // Mapping
    // ============================================================

    const reportData = result.rows.map((row) => {
      const NRGPID =
        Number(row.nrgpid);

      const Items = itemRows
        .filter(
          (item) =>
            Number(item.nrgpid) === NRGPID,
        )
        .map((item) => ({
          NRGPItemID:
            Number(item.nrgpitemid),

          ItemName:
            item.itemname,

          Quantity:
            item.quantity !== null
              ? Number(item.quantity)
              : 0,
        }));


      return {
        NRGPID:
          NRGPID,

        NRGPNumber:
          Number(row.nrgpnumber),

        OrganizationID:
          Number(row.organizationid),

        VendorName:
          row.vendorname,

        ContactNumber:
          row.contactnumber,

        Company:
          row.company,

        SendTo:
          row.sendto,

        DepartmentID:
          row.departmentid !== null
            ? Number(row.departmentid)
            : null,

        DepartmentName:
          row.departmentname,

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
            : null,

        Items:
          Items,
      };
    });


    // ============================================================
    // Total Count
    // ============================================================

    const totalCount = Number(
      countResult.rows[0]?.totalcount || 0,
    );


    // ============================================================
    // Response
    // ============================================================

    return {
      success: true,
      message:
        "NRGP list report fetched successfully.",

      page: page,
      PageSize: pageSize,
      TotalCount: totalCount,
      TotalPages:
        Math.ceil(
          totalCount / pageSize,
        ),

      data:
        reportData,
    };

  } catch (error) {
    console.error(
      "Get NRGP List Report Error:",
      error.message,
    );

    return databaseFailure(
      error,
      "Fetch NRGP list report",
    );
  }
};
// ============================================================ Department Wise NRGP Report
const getNRGPDepartmentWiseReport = async (data) => {
  try {
    // ============================================================
    // Pagination
    // ============================================================

    const page =
      Number(data.page) || 1;

    const pageSize =
      Math.min(
        Number(data.PageSize) || 10,
        100,
      );

    const offset =
      (page - 1) * pageSize;


    // ============================================================
    // Validation
    // ============================================================

    const organizationID =
      Number(data.OrganizationID);

    if (
      !Number.isInteger(organizationID) ||
      organizationID <= 0
    ) {
      return fail(
        "Valid OrganizationID is required.",
        400,
      );
    }


    // ============================================================
    // Conditions
    // ============================================================

    const values = [
      organizationID,
    ];

    const conditions = [
      "m.IsDeleted = FALSE",
      `m.OrganizationID = $${values.length}`,
    ];


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


    // Optional department filter applies to both totals and report rows.
    if (data.DepartmentID !== undefined && data.DepartmentID !== null && data.DepartmentID !== "") {
      const departmentID = Number(data.DepartmentID);
      if (!Number.isSafeInteger(departmentID) || departmentID <= 0) {
        return fail("Valid DepartmentID is required.", 400);
      }
      values.push(departmentID);
      conditions.push(`m.DepartmentID = $${values.length}`);
    }
    const whereClause =
      conditions.join(" AND ");


    // ============================================================
    // Total Department Count
    // ============================================================

    const countResult =
      await pool.query(
        `
        SELECT
          COUNT(DISTINCT m.DepartmentID)::INT
            AS TotalCount

        FROM Gatepass_NRGP_Entry_Master m

        WHERE ${whereClause};
        `,
        values,
      );


    // ============================================================
    // Pagination Values
    // ============================================================

    const queryValues = [
      ...values,
      pageSize,
      offset,
    ];

    const limitPosition =
      queryValues.length - 1;

    const offsetPosition =
      queryValues.length;


    // ============================================================
    // Department Wise Query
    // ============================================================

    const result =
      await pool.query(
        `
        SELECT
          m.DepartmentID,
          d.DepartmentName,

          COUNT(*)::INT
            AS TotalNRGP,

          COUNT(*) FILTER (
            WHERE UPPER(m.Status) = 'PENDING'
          )::INT
            AS PendingCount,

          COUNT(*) FILTER (
            WHERE UPPER(m.Status) = 'APPROVED'
          )::INT
            AS ApprovedCount,

          COUNT(*) FILTER (
            WHERE UPPER(m.Status) = 'REJECTED'
          )::INT
            AS RejectedCount,

          COUNT(*) FILTER (
            WHERE UPPER(m.Status) = 'CANCELLED'
          )::INT
            AS CancelledCount

        FROM Gatepass_NRGP_Entry_Master m

        LEFT JOIN department_master d
          ON d.DepartmentID = m.DepartmentID

        WHERE ${whereClause}

        GROUP BY
          m.DepartmentID,
          d.DepartmentName

        ORDER BY
          d.DepartmentName ASC

        LIMIT $${limitPosition}
        OFFSET $${offsetPosition};
        `,
        queryValues,
      );


    // ============================================================
    // Mapping
    // ============================================================

    const reportData =
      result.rows.map((row) => ({
        DepartmentID:
          row.departmentid
            ? Number(row.departmentid)
            : null,

        DepartmentName:
          row.departmentname,

        TotalNRGP:
          Number(row.totalnrgp || 0),

        PendingCount:
          Number(row.pendingcount || 0),

        ApprovedCount:
          Number(row.approvedcount || 0),

        RejectedCount:
          Number(row.rejectedcount || 0),

        CancelledCount:
          Number(row.cancelledcount || 0),
      }));


    // ============================================================
    // Response
    // ============================================================

    const totalCount =
      Number(
        countResult.rows[0]
          ?.totalcount || 0,
      );

    return {
      success: true,
      message:
        "NRGP department wise report fetched successfully.",

      page,
      PageSize: pageSize,
      TotalCount: totalCount,
      TotalPages: Math.ceil(totalCount / pageSize),

      data: reportData,
    };

  } catch (error) {
    console.error(
      "Get NRGP Department Wise Report Error:",
      error.message,
    );

    return databaseFailure(
      error,
      "Fetch NRGP department wise report",
    );
  }
};
// ============================================================ Vendor Wise NRGP Report
const getNRGPVendorWiseReport = async (data) => {
  try {
    // ============================================================
    // Pagination
    // ============================================================

    const page =
      Number(data.page) || 1;

    const pageSize =
      Math.min(
        Number(data.PageSize) || 10,
        100,
      );

    const offset =
      (page - 1) * pageSize;


    // ============================================================
    // Validation
    // ============================================================

    const organizationID =
      Number(data.OrganizationID);

    if (
      !Number.isInteger(organizationID) ||
      organizationID <= 0
    ) {
      return fail(
        "Valid OrganizationID is required.",
        400,
      );
    }


    // ============================================================
    // Conditions
    // ============================================================

    const values = [
      organizationID,
    ];

    const conditions = [
      "m.IsDeleted = FALSE",
      `m.OrganizationID = $${values.length}`,
    ];


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


    // Optional case-insensitive vendor name filter.
    const vendorName = String(data.VendorName || "").trim();
    if (vendorName) {
      values.push(`%${vendorName}%`);
      conditions.push(`m.VendorName ILIKE $${values.length}`);
    }
    const whereClause =
      conditions.join(" AND ");


    // ============================================================
    // Total Vendor Count
    // ============================================================

    const countResult =
      await pool.query(
        `
        SELECT
          COUNT(
            DISTINCT TRIM(m.VendorName)
          )::INT AS TotalCount

        FROM Gatepass_NRGP_Entry_Master m

        WHERE ${whereClause}
          AND m.VendorName IS NOT NULL
          AND TRIM(m.VendorName) <> '';
        `,
        values,
      );


    // ============================================================
    // Pagination Values
    // ============================================================

    const queryValues = [
      ...values,
      pageSize,
      offset,
    ];

    const limitPosition =
      queryValues.length - 1;

    const offsetPosition =
      queryValues.length;


    // ============================================================
    // Vendor Wise Query
    // ============================================================

    const result =
      await pool.query(
        `
        SELECT
          TRIM(m.VendorName)
            AS VendorName,

          COUNT(
            DISTINCT m.NRGPID
          )::INT
            AS TotalNRGP,

          COUNT(i.NRGPItemID)::INT
            AS TotalItems,

          COALESCE(
            SUM(i.Quantity),
            0
          )
            AS TotalQuantity,

          COALESCE(
            SUM(
              i.Quantity *
              COALESCE(i.Rate, 0)
            ),
            0
          )
            AS TotalValue

        FROM Gatepass_NRGP_Entry_Master m

        LEFT JOIN Gatepass_NRGP_Entry_Item_Details i
          ON i.NRGPID = m.NRGPID
          AND i.IsDeleted = FALSE

        WHERE ${whereClause}
          AND m.VendorName IS NOT NULL
          AND TRIM(m.VendorName) <> ''

        GROUP BY
          TRIM(m.VendorName)

        ORDER BY
          TRIM(m.VendorName) ASC

        LIMIT $${limitPosition}
        OFFSET $${offsetPosition};
        `,
        queryValues,
      );


    // ============================================================
    // Mapping
    // ============================================================

    const reportData =
      result.rows.map((row) => ({
        VendorName:
          row.vendorname,

        TotalNRGP:
          Number(row.totalnrgp || 0),

        TotalItems:
          Number(row.totalitems || 0),

        TotalQuantity:
          Number(row.totalquantity || 0),

        TotalValue:
          Number(row.totalvalue || 0),
      }));


    // ============================================================
    // Response
    // ============================================================

    const totalCount =
      Number(
        countResult.rows[0]
          ?.totalcount || 0,
      );

    return {
      success: true,
      message:
        "NRGP vendor wise report fetched successfully.",

      page,
      PageSize: pageSize,
      TotalCount: totalCount,
      TotalPages: Math.ceil(totalCount / pageSize),

      data: reportData,
    };

  } catch (error) {
    console.error(
      "Get NRGP Vendor Wise Report Error:",
      error.message,
    );

    return databaseFailure(
      error,
      "Fetch NRGP vendor wise report",
    );
  }
};
// ============================================================ Approval Status Report
const getNRGPApprovalStatusReport = async (data) => {
  try {
    // ============================================================
    // Pagination
    // ============================================================

    const page =
      Number(data.page) || 1;

    const pageSize =
      Math.min(
        Number(data.PageSize) || 10,
        100,
      );

    const offset =
      (page - 1) * pageSize;


    // ============================================================
    // Conditions
    // ============================================================

    const values = [];

    const conditions = [
      "m.IsDeleted = FALSE",
    ];


    // ============================================================
    // Organization Filter
    // ============================================================

    if (data.OrganizationID) {
      const organizationID =
        Number(data.OrganizationID);

      if (
        !Number.isInteger(organizationID) ||
        organizationID <= 0
      ) {
        return fail(
          "Invalid OrganizationID.",
          400,
        );
      }

      values.push(organizationID);

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


    const whereClause =
      conditions.join(" AND ");


    // ============================================================
    // Total Organization Count
    // ============================================================

    const countResult =
      await pool.query(
        `
        SELECT
          COUNT(
            DISTINCT m.OrganizationID
          )::INT AS TotalCount

        FROM Gatepass_NRGP_Entry_Master m

        WHERE ${whereClause};
        `,
        values,
      );


    // ============================================================
    // Pagination Values
    // ============================================================

    const queryValues = [
      ...values,
      pageSize,
      offset,
    ];

    const limitPosition =
      queryValues.length - 1;

    const offsetPosition =
      queryValues.length;


    // ============================================================
    // Approval Status Query
    // ============================================================

    const result =
      await pool.query(
        `
        SELECT
          m.OrganizationID,
          o.ShortName AS OrganizationName,

          COUNT(*)::INT
            AS TotalNRGP,

          COUNT(*) FILTER (
            WHERE UPPER(m.Status) = 'PENDING'
          )::INT
            AS PendingCount,

          COUNT(*) FILTER (
            WHERE UPPER(m.Status) = 'APPROVED'
          )::INT
            AS ApprovedCount,

          COUNT(*) FILTER (
            WHERE UPPER(m.Status) = 'REJECTED'
          )::INT
            AS RejectedCount,

          COUNT(*) FILTER (
            WHERE UPPER(m.Status) = 'CANCELLED'
          )::INT
            AS CancelledCount

        FROM Gatepass_NRGP_Entry_Master m

        LEFT JOIN Organization_Master o
          ON o.OrganizationID = m.OrganizationID

        WHERE ${whereClause}

        GROUP BY
          m.OrganizationID,
          o.ShortName

        ORDER BY
          o.ShortName ASC

        LIMIT $${limitPosition}
        OFFSET $${offsetPosition};
        `,
        queryValues,
      );


    // ============================================================
    // Mapping
    // ============================================================

    const reportData =
      result.rows.map((row) => ({
        OrganizationID:
          Number(row.organizationid),

        OrganizationName:
          row.organizationname,

        TotalNRGP:
          Number(row.totalnrgp || 0),

        PendingCount:
          Number(row.pendingcount || 0),

        ApprovedCount:
          Number(row.approvedcount || 0),

        RejectedCount:
          Number(row.rejectedcount || 0),

        CancelledCount:
          Number(row.cancelledcount || 0),
      }));


    // ============================================================
    // Response
    // ============================================================

    const totalCount =
      Number(
        countResult.rows[0]
          ?.totalcount || 0,
      );

    return {
      success: true,
      message:
        "NRGP approval status report fetched successfully.",

      page,
      PageSize: pageSize,
      TotalCount: totalCount,
      TotalPages: Math.ceil(totalCount / pageSize),

      data: reportData,
    };

  } catch (error) {
    console.error(
      "Get NRGP Approval Status Report Error:",
      error.message,
    );

    return databaseFailure(
      error,
      "Fetch NRGP approval status report",
    );
  }
};
// ========================================================================PDFs
// ============================================================ NRGP List Report PDF
const generateNRGPListReportPdf = async (data) => {
  try {
    // ============================================================
    // Validation
    // ============================================================

    const organizationID =
      Number(data.OrganizationID);

    if (
      !Number.isInteger(organizationID) ||
      organizationID <= 0
    ) {
      return fail(
        "Valid OrganizationID is required.",
        400,
      );
    }


    // ============================================================
    // Conditions
    // SAME AS GET API
    // ============================================================

    const values = [
      organizationID,
    ];

    const conditions = [
      "m.IsDeleted = FALSE",
      `m.OrganizationID = $${values.length}`,
    ];


    // ============================================================
    // From Date
    // SAME AS GET API
    // ============================================================

    if (data.FromDate) {
      values.push(data.FromDate);

      conditions.push(
        `m.CreatedDate::DATE >= $${values.length}::DATE`,
      );
    }


    // ============================================================
    // To Date
    // SAME AS GET API
    // ============================================================

    if (data.ToDate) {
      values.push(data.ToDate);

      conditions.push(
        `m.CreatedDate::DATE <= $${values.length}::DATE`,
      );
    }


    // ============================================================
    // Department
    // SAME AS GET API
    // ============================================================

    if (data.DepartmentID) {
      const departmentID =
        Number(data.DepartmentID);

      if (
        !Number.isInteger(departmentID) ||
        departmentID <= 0
      ) {
        return fail(
          "Invalid DepartmentID.",
          400,
        );
      }

      values.push(departmentID);

      conditions.push(
        `m.DepartmentID = $${values.length}`,
      );
    }


    // ============================================================
    // Report Type / Status
    // SAME AS GET API
    // ============================================================

    if (data.Status) {
      const Status =
        String(data.Status)
          .trim()
          .toUpperCase();

      switch (Status) {
        // ========================================================
        // Open
        // ========================================================

        case "ALL NRGP OPEN":
          conditions.push(
            `UPPER(m.Status) = 'PENDING'`,
          );
          break;


        // ========================================================
        // Closed
        // ========================================================

        case "ALL NRGP CLOSED":
          conditions.push(
            `UPPER(m.Status) = 'APPROVED'`,
          );
          break;


        // ========================================================
        // Cancelled / Rejected
        // ========================================================

        case "ALL NRGP CANCELLED":
          conditions.push(
            `UPPER(m.Status) IN ('CANCELLED', 'REJECTED')`,
          );
          break;


        default:
          return fail(
            "Invalid Status.",
            400,
          );
      }
    }


    // ============================================================
    // Where Clause
    // ============================================================

    const whereClause =
      conditions.join(" AND ");


    // ============================================================
    // Master Query
    // SAME AS GET API
    // ONLY PAGINATION REMOVED
    // ============================================================

    const result = await pool.query(
      `
      SELECT
        m.NRGPID,
        m.NRGPNumber,
        m.OrganizationID,

        m.VendorName,
        m.ContactNumber,
        m.Company,
        m.SendTo,

        m.DepartmentID,
        d.DepartmentName,

        m.Address,
        m.TakenBy,

        m.Status,

        m.CreatedBy,
        m.CreatedDate

      FROM Gatepass_NRGP_Entry_Master m

      LEFT JOIN department_master d
        ON d.DepartmentID = m.DepartmentID

      WHERE ${whereClause}

      ORDER BY
        m.CreatedDate DESC,
        m.NRGPID DESC;
      `,
      values,
    );


    // ============================================================
    // Get NRGP IDs
    // SAME ITEM LOGIC AS GET API
    // ============================================================

    const NRGPIDs =
      result.rows.map(
        (row) => Number(row.nrgpid),
      );


    // ============================================================
    // Get Items
    // ============================================================

    let itemRows = [];

    if (NRGPIDs.length > 0) {
      const itemResult =
        await pool.query(
          `
          SELECT
            NRGPItemID,
            NRGPID,
            ItemName,
            Quantity

          FROM Gatepass_NRGP_Entry_Item_Details

          WHERE NRGPID = ANY($1::BIGINT[])
            AND IsDeleted = FALSE

          ORDER BY
            NRGPID ASC,
            NRGPItemID ASC;
          `,
          [NRGPIDs],
        );

      itemRows =
        itemResult.rows;
    }


    // ============================================================
    // PDF Rows
    //
    // One NRGP can contain multiple items.
    // Therefore one PDF row is created for each item.
    // ============================================================

    const pdfRows = [];
    for (const row of result.rows) {
      const items = itemRows.filter((item) => String(item.nrgpid) === String(row.nrgpid));
      const displayItems = items.length ? items : [{}];
      displayItems.forEach((item, index) => {
        pdfRows.push({
          NRGPNumber: index === 0 ? (row.nrgpnumber != null ? Number(row.nrgpnumber) : "-") : "-",
          Name: index === 0 ? row.vendorname || "-" : "-",
          Company: index === 0 ? row.company || "-" : "-",
          Department: index === 0 ? row.departmentname || "-" : "-",
          CreatedDate: index === 0 && row.createddate ? formatDate(row.createddate) : "-",
          ItemName: item.itemname || "-",
          Quantity: item.quantity != null ? Number(item.quantity) : 0,
        });
      });
    }
    // PDF Metadata
    // ============================================================

    const organizationName = await getRGPReportOrganizationName(data.OrganizationID);
    const metadata = [
      { label: "Organization", value: organizationName },
      {
        label: "From Date",
        value:
          data.FromDate
            ? formatDate(data.FromDate)
            : "All",
      },
      {
        label: "To Date",
        value:
          data.ToDate
            ? formatDate(data.ToDate)
            : "All",
      },
      {
        label: "Status",
        value:
          data.Status || "All",
      },
      {
        label: "Department",
        value:
          data.DepartmentID
            ? (
                result.rows[0]
                  ?.departmentname ||
                "-"
              )
            : "All Department",
      },
    ];


    // ============================================================
    // Generate PDF
    // ============================================================

    const pdfBuffer =
      await generatePdf({
        title:
          "NRGP List Report",

        organizationId:
          organizationID,

        orientation:
          "landscape",

        metadata,

        columns: [
          {
            header: "NRGP No.",
            key: "NRGPNumber",
            width: 65,
          },
          {
            header: "Name",
            key: "Name",
            width: "*",
          },
          {
            header: "Company",
            key: "Company",
            width: "*",
          },
          {
            header: "Department",
            key: "Department",
            width: "*",
          },
          {
            header: "Created Date",
            key: "CreatedDate",
            width: 80,
          },
          {
            header: "Item Name",
            key: "ItemName",
            width: "*",
          },
          {
            header: "Qty.",
            key: "Quantity",
            width: 45,
            alignment: "right",
          },
        ],

        rows:
          pdfRows,
      });


    // ============================================================
    // Response
    // ============================================================

    return {
      success: true,
      message:
        "NRGP list report PDF generated successfully.",
      data:
        pdfBuffer,
    };

  } catch (error) {
    console.error(
      "Generate NRGP List Report PDF Error:",
      error.message,
    );

    return databaseFailure(
      error,
      "Generate NRGP list report PDF",
    );
  }
};
// ============================================================ Department Wise NRGP Report PDF
const generateNRGPDepartmentWiseReportPdf = async (data) => {
  try {
    // ============================================================
    // Validation
    // SAME AS GET API
    // ============================================================

    const organizationID =
      Number(data.OrganizationID);

    if (
      !Number.isInteger(organizationID) ||
      organizationID <= 0
    ) {
      return fail(
        "Valid OrganizationID is required.",
        400,
      );
    }


    // ============================================================
    // Conditions
    // SAME AS GET API
    // ============================================================

    const values = [
      organizationID,
    ];

    const conditions = [
      "m.IsDeleted = FALSE",
      `m.OrganizationID = $${values.length}`,
    ];


    // ============================================================
    // From Date
    // SAME AS GET API
    // ============================================================

    if (data.FromDate) {
      values.push(data.FromDate);

      conditions.push(
        `m.CreatedDate::DATE >= $${values.length}::DATE`,
      );
    }


    // ============================================================
    // To Date
    // SAME AS GET API
    // ============================================================

    if (data.ToDate) {
      values.push(data.ToDate);

      conditions.push(
        `m.CreatedDate::DATE <= $${values.length}::DATE`,
      );
    }


    // ============================================================
    // Department Filter
    // SAME AS GET API
    // ============================================================

    if (
      data.DepartmentID !== undefined &&
      data.DepartmentID !== null &&
      data.DepartmentID !== ""
    ) {
      const departmentID =
        Number(data.DepartmentID);

      if (
        !Number.isSafeInteger(departmentID) ||
        departmentID <= 0
      ) {
        return fail(
          "Valid DepartmentID is required.",
          400,
        );
      }

      values.push(departmentID);

      conditions.push(
        `m.DepartmentID = $${values.length}`,
      );
    }


    // ============================================================
    // Where Clause
    // SAME AS GET API
    // ============================================================

    const whereClause =
      conditions.join(" AND ");


    // ============================================================
    // Department Wise Query
    // EXACT SAME QUERY AS GET API
    // ONLY LIMIT / OFFSET REMOVED
    // ============================================================

    const result =
      await pool.query(
        `
        SELECT
          m.DepartmentID,
          d.DepartmentName,

          COUNT(*)::INT
            AS TotalNRGP,

          COUNT(*) FILTER (
            WHERE UPPER(m.Status) = 'PENDING'
          )::INT
            AS PendingCount,

          COUNT(*) FILTER (
            WHERE UPPER(m.Status) = 'APPROVED'
          )::INT
            AS ApprovedCount,

          COUNT(*) FILTER (
            WHERE UPPER(m.Status) = 'REJECTED'
          )::INT
            AS RejectedCount,

          COUNT(*) FILTER (
            WHERE UPPER(m.Status) = 'CANCELLED'
          )::INT
            AS CancelledCount

        FROM Gatepass_NRGP_Entry_Master m

        LEFT JOIN department_master d
          ON d.DepartmentID = m.DepartmentID

        WHERE ${whereClause}

        GROUP BY
          m.DepartmentID,
          d.DepartmentName

        ORDER BY
          d.DepartmentName ASC;
        `,
        values,
      );


    // ============================================================
    // Mapping
    // SAME DATA AS GET API
    // ============================================================

    const reportData =
      result.rows.map((row) => ({
        DepartmentID:
          row.departmentid
            ? Number(row.departmentid)
            : null,

        DepartmentName:
          row.departmentname,

        TotalNRGP:
          Number(
            row.totalnrgp || 0,
          ),

        PendingCount:
          Number(
            row.pendingcount || 0,
          ),

        ApprovedCount:
          Number(
            row.approvedcount || 0,
          ),

        RejectedCount:
          Number(
            row.rejectedcount || 0,
          ),

        CancelledCount:
          Number(
            row.cancelledcount || 0,
          ),
      }));


    // ============================================================
    // PDF Rows
    // ============================================================

    const pdfRows =
      reportData.map((row) => ({
        DepartmentName:
          row.DepartmentName || "-",

        TotalNRGP:
          row.TotalNRGP,

        PendingCount:
          row.PendingCount,

        ApprovedCount:
          row.ApprovedCount,

        RejectedCount:
          row.RejectedCount,

        CancelledCount:
          row.CancelledCount,
      }));


    // ============================================================
    // Metadata
    // ============================================================

    const organizationName = await getRGPReportOrganizationName(data.OrganizationID);
    const metadata = [
      { label: "Organization", value: organizationName },
      {
        label: "From Date",
        value:
          data.FromDate
            ? formatDate(data.FromDate)
            : "All",
      },
      {
        label: "To Date",
        value:
          data.ToDate
            ? formatDate(data.ToDate)
            : "All",
      },
      {
        label: "Department",
        value:
          data.DepartmentID
            ? (
                reportData[0]
                  ?.DepartmentName || "-"
              )
            : "All Department",
      },
    ];


    // ============================================================
    // Generate PDF
    // ============================================================

    const pdfBuffer =
      await generatePdf({
        title:
          "NRGP Department Wise Report",

        organizationId:
          organizationID,

        orientation:
          "landscape",

        metadata,

        columns: [
          {
            header: "Department",
            key: "DepartmentName",
            width: "*",
          },
          {
            header: "Total NRGP",
            key: "TotalNRGP",
            width: 80,
            alignment: "center",
          },
          {
            header: "Pending",
            key: "PendingCount",
            width: 75,
            alignment: "center",
          },
          {
            header: "Approved",
            key: "ApprovedCount",
            width: 75,
            alignment: "center",
          },
          {
            header: "Rejected",
            key: "RejectedCount",
            width: 75,
            alignment: "center",
          },
          {
            header: "Cancelled",
            key: "CancelledCount",
            width: 75,
            alignment: "center",
          },
        ],

        rows:
          pdfRows,
      });


    // ============================================================
    // Response
    // ============================================================

    return {
      success: true,
      message:
        "NRGP department wise report PDF generated successfully.",
      data:
        pdfBuffer,
    };

  } catch (error) {
    console.error(
      "Generate NRGP Department Wise Report PDF Error:",
      error.message,
    );

    return databaseFailure(
      error,
      "Generate NRGP department wise report PDF",
    );
  }
};
// ============================================================ Vendor Wise NRGP Report PDF
const generateNRGPVendorWiseReportPdf = async (data) => {
  try {
    // ============================================================
    // Validation
    // ============================================================

    const organizationID =
      Number(data.OrganizationID);

    if (
      !Number.isInteger(organizationID) ||
      organizationID <= 0
    ) {
      return fail(
        "Valid OrganizationID is required.",
        400,
      );
    }


    // ============================================================
    // Conditions
    // SAME AS GET API
    // ============================================================

    const values = [
      organizationID,
    ];

    const conditions = [
      "m.IsDeleted = FALSE",
      `m.OrganizationID = $${values.length}`,
    ];


    // ============================================================
    // From Date
    // SAME AS GET API
    // ============================================================

    if (data.FromDate) {
      values.push(data.FromDate);

      conditions.push(
        `m.CreatedDate::DATE >= $${values.length}::DATE`,
      );
    }


    // ============================================================
    // To Date
    // SAME AS GET API
    // ============================================================

    if (data.ToDate) {
      values.push(data.ToDate);

      conditions.push(
        `m.CreatedDate::DATE <= $${values.length}::DATE`,
      );
    }


    // ============================================================
    // Vendor Name
    // SAME AS GET API
    // ============================================================

    const vendorName =
      String(
        data.VendorName || "",
      ).trim();

    if (vendorName) {
      values.push(
        `%${vendorName}%`,
      );

      conditions.push(
        `m.VendorName ILIKE $${values.length}`,
      );
    }


    // ============================================================
    // Where Clause
    // SAME AS GET API
    // ============================================================

    const whereClause =
      conditions.join(" AND ");


    // ============================================================
    // Vendor Wise Query
    // SAME AS GET API
    // ONLY LIMIT / OFFSET REMOVED
    // ============================================================

    const result =
      await pool.query(
        `
        SELECT
          TRIM(m.VendorName)
            AS VendorName,

          COUNT(
            DISTINCT m.NRGPID
          )::INT
            AS TotalNRGP,

          COUNT(i.NRGPItemID)::INT
            AS TotalItems,

          COALESCE(
            SUM(i.Quantity),
            0
          )
            AS TotalQuantity,

          COALESCE(
            SUM(
              i.Quantity *
              COALESCE(i.Rate, 0)
            ),
            0
          )
            AS TotalValue

        FROM Gatepass_NRGP_Entry_Master m

        LEFT JOIN Gatepass_NRGP_Entry_Item_Details i
          ON i.NRGPID = m.NRGPID
          AND i.IsDeleted = FALSE

        WHERE ${whereClause}
          AND m.VendorName IS NOT NULL
          AND TRIM(m.VendorName) <> ''

        GROUP BY
          TRIM(m.VendorName)

        ORDER BY
          TRIM(m.VendorName) ASC;
        `,
        values,
      );


    // ============================================================
    // Mapping
    // SAME AS GET API
    // ============================================================

    const reportData =
      result.rows.map((row) => ({
        VendorName:
          row.vendorname,

        TotalNRGP:
          Number(
            row.totalnrgp || 0,
          ),

        TotalItems:
          Number(
            row.totalitems || 0,
          ),

        TotalQuantity:
          Number(
            row.totalquantity || 0,
          ),

        TotalValue:
          Number(
            row.totalvalue || 0,
          ),
      }));


    // ============================================================
    // PDF Rows
    // ============================================================

    const pdfRows =
      reportData.map((row) => ({
        VendorName:
          row.VendorName || "-",

        TotalNRGP:
          row.TotalNRGP,

        TotalItems:
          row.TotalItems,

        TotalQuantity:
          row.TotalQuantity,

        TotalValue:
          row.TotalValue,
      }));


    // ============================================================
    // Metadata
    // ============================================================

    const organizationName = await getRGPReportOrganizationName(data.OrganizationID);
    const metadata = [
      { label: "Organization", value: organizationName },
      {
        label: "From Date",
        value:
          data.FromDate
            ? formatDate(
                data.FromDate,
              )
            : "All",
      },
      {
        label: "To Date",
        value:
          data.ToDate
            ? formatDate(
                data.ToDate,
              )
            : "All",
      },
      {
        label: "Vendor",
        value:
          vendorName ||
          "All Vendor",
      },
    ];


    // ============================================================
    // Generate PDF
    // ============================================================

    const pdfBuffer =
      await generatePdf({
        title:
          "NRGP Vendor Wise Report",

        organizationId:
          organizationID,

        orientation:
          "landscape",

        metadata,

        columns: [
          {
            header: "Vendor Name",
            key: "VendorName",
            width: "*",
          },
          {
            header: "Total NRGP",
            key: "TotalNRGP",
            width: 85,
            alignment: "center",
          },
          {
            header: "Total Items",
            key: "TotalItems",
            width: 85,
            alignment: "center",
          },
          {
            header: "Total Quantity",
            key: "TotalQuantity",
            width: 95,
            alignment: "right",
          },
          {
            header: "Total Value",
            key: "TotalValue",
            width: 100,
            alignment: "right",
          },
        ],

        rows:
          pdfRows,
      });


    // ============================================================
    // Response
    // ============================================================

    return {
      success: true,
      message:
        "NRGP vendor wise report PDF generated successfully.",
      data:
        pdfBuffer,
    };

  } catch (error) {
    console.error(
      "Generate NRGP Vendor Wise Report PDF Error:",
      error.message,
    );

    return databaseFailure(
      error,
      "Generate NRGP vendor wise report PDF",
    );
  }
};
// ============================================================ Approval Status Report PDF
const generateNRGPApprovalStatusReportPdf = async (data) => {
  try {
    // ============================================================
    // Conditions
    // SAME AS GET API
    // ============================================================

    const values = [];

    const conditions = [
      "m.IsDeleted = FALSE",
    ];


    // ============================================================
    // Organization Filter
    // SAME AS GET API
    // ============================================================

    if (data.OrganizationID) {
      const organizationID =
        Number(data.OrganizationID);

      if (
        !Number.isInteger(organizationID) ||
        organizationID <= 0
      ) {
        return fail(
          "Invalid OrganizationID.",
          400,
        );
      }

      values.push(organizationID);

      conditions.push(
        `m.OrganizationID = $${values.length}`,
      );
    }


    // ============================================================
    // From Date
    // SAME AS GET API
    // ============================================================

    if (data.FromDate) {
      values.push(data.FromDate);

      conditions.push(
        `m.CreatedDate::DATE >= $${values.length}::DATE`,
      );
    }


    // ============================================================
    // To Date
    // SAME AS GET API
    // ============================================================

    if (data.ToDate) {
      values.push(data.ToDate);

      conditions.push(
        `m.CreatedDate::DATE <= $${values.length}::DATE`,
      );
    }


    // ============================================================
    // Where Clause
    // SAME AS GET API
    // ============================================================

    const whereClause =
      conditions.join(" AND ");


    // ============================================================
    // Approval Status Query
    // SAME AS GET API
    // ONLY LIMIT / OFFSET REMOVED
    // ============================================================

    const result =
      await pool.query(
        `
        SELECT
          m.OrganizationID,
          o.ShortName AS OrganizationName,

          COUNT(*)::INT
            AS TotalNRGP,

          COUNT(*) FILTER (
            WHERE UPPER(m.Status) = 'PENDING'
          )::INT
            AS PendingCount,

          COUNT(*) FILTER (
            WHERE UPPER(m.Status) = 'APPROVED'
          )::INT
            AS ApprovedCount,

          COUNT(*) FILTER (
            WHERE UPPER(m.Status) = 'REJECTED'
          )::INT
            AS RejectedCount,

          COUNT(*) FILTER (
            WHERE UPPER(m.Status) = 'CANCELLED'
          )::INT
            AS CancelledCount

        FROM Gatepass_NRGP_Entry_Master m

        LEFT JOIN Organization_Master o
          ON o.OrganizationID = m.OrganizationID

        WHERE ${whereClause}

        GROUP BY
          m.OrganizationID,
          o.ShortName

        ORDER BY
          o.ShortName ASC;
        `,
        values,
      );


    // ============================================================
    // Mapping
    // SAME AS GET API
    // ============================================================

    const reportData =
      result.rows.map((row) => ({
        OrganizationID:
          Number(row.organizationid),

        OrganizationName:
          row.organizationname,

        TotalNRGP:
          Number(
            row.totalnrgp || 0,
          ),

        PendingCount:
          Number(
            row.pendingcount || 0,
          ),

        ApprovedCount:
          Number(
            row.approvedcount || 0,
          ),

        RejectedCount:
          Number(
            row.rejectedcount || 0,
          ),

        CancelledCount:
          Number(
            row.cancelledcount || 0,
          ),
      }));


    // ============================================================
    // PDF Rows
    // ============================================================

    const pdfRows =
      reportData.map((row) => ({
        OrganizationName:
          row.OrganizationName || "-",

        TotalNRGP:
          row.TotalNRGP,

        PendingCount:
          row.PendingCount,

        ApprovedCount:
          row.ApprovedCount,

        RejectedCount:
          row.RejectedCount,

        CancelledCount:
          row.CancelledCount,
      }));


    // ============================================================
    // PDF Metadata
    // ============================================================

    const organizationName = await getRGPReportOrganizationName(data.OrganizationID);
    const metadata = [
      { label: "Organization", value: organizationName },
      {
        label: "From Date",
        value:
          data.FromDate
            ? formatDate(
                data.FromDate,
              )
            : "All",
      },
      {
        label: "To Date",
        value:
          data.ToDate
            ? formatDate(
                data.ToDate,
              )
            : "All",
      },

    ];


    // ============================================================
    // Generate PDF
    // ============================================================

    const pdfBuffer =
      await generatePdf({
        title:
          "NRGP Approval Status Report",

        organizationId:
          data.OrganizationID
            ? Number(
                data.OrganizationID,
              )
            : null,

        orientation:
          "landscape",

        metadata,

        columns: [
          {
            header: "Organization",
            key: "OrganizationName",
            width: "*",
          },
          {
            header: "Total NRGP",
            key: "TotalNRGP",
            width: 80,
            alignment: "center",
          },
          {
            header: "Pending",
            key: "PendingCount",
            width: 75,
            alignment: "center",
          },
          {
            header: "Approved",
            key: "ApprovedCount",
            width: 75,
            alignment: "center",
          },
          {
            header: "Rejected",
            key: "RejectedCount",
            width: 75,
            alignment: "center",
          },
          {
            header: "Cancelled",
            key: "CancelledCount",
            width: 75,
            alignment: "center",
          },
        ],

        rows:
          pdfRows,
      });


    // ============================================================
    // Response
    // ============================================================

    return {
      success: true,
      message:
        "NRGP approval status report PDF generated successfully.",
      data:
        pdfBuffer,
    };

  } catch (error) {
    console.error(
      "Generate NRGP Approval Status Report PDF Error:",
      error.message,
    );

    return databaseFailure(
      error,
      "Generate NRGP approval status report PDF",
    );
  }
};
// ============================================================ NRGP Details PDF
const generateNRGPDetailPdf = async (data) => {
  try {
    // ============================================================
    // Validate
    // ============================================================

    const nrgpID =
      Number(data.NRGPID);

    if (
      !Number.isInteger(nrgpID) ||
      nrgpID <= 0
    ) {
      return fail(
        "Valid NRGPID is required.",
        400,
      );
    }

    // ============================================================
    // SAME GET BY ID API
    // No Duplicate SQL
    // ============================================================

    const nrgpResult =
      await getNRGPById({
        NRGPID: nrgpID,
      });

    if (!nrgpResult.success) {
      return nrgpResult;
    }

    const detail =
      nrgpResult.data;

    // ============================================================
    // PDF Design
    // ============================================================

    const COLORS = {
      navy: "#082B5C",
      label: "#082B5C",
      text: "#172033",
      muted: "#64748B",
      border: "#CFD7E3",
      labelBackground: "#F4F6F9",
    };

    const displayValue = (value) =>
      value === null ||
      value === undefined ||
      String(value).trim() === ""
        ? "-"
        : String(value);

    // ============================================================
    // Canvas Helpers
    // ============================================================

    const line = (
      x1,
      y1,
      x2,
      y2,
      lineWidth = 1.1,
    ) => ({
      type: "line",
      x1,
      y1,
      x2,
      y2,
      lineWidth,
      lineColor: COLORS.navy,
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
      lineWidth: 1.1,
      lineColor: COLORS.navy,
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
      lineWidth: 1.1,
      lineColor: COLORS.navy,
    });

    // ============================================================
    // Icons
    // ============================================================

    const fieldIcon = (type) => {
      const icons = {
        number: [
          rect(2, 3, 14, 12, 1),
          line(5, 7, 13, 7),
          line(5, 11, 13, 11),
        ],

        organization: [
          rect(4, 2, 10, 15, 1),
          line(1, 17, 17, 17),
          line(7, 6, 7, 8),
          line(11, 6, 11, 8),
          line(7, 11, 7, 13),
          line(11, 11, 11, 13),
        ],

        vendor: [
          ellipse(9, 6, 4),
          line(3, 17, 15, 17),
          line(5, 17, 5, 13),
          line(13, 17, 13, 13),
        ],

        phone: [
          rect(3, 1, 12, 17, 2),
          line(7, 15, 11, 15),
        ],

        department: [
          rect(2, 4, 14, 13, 1),
          line(6, 1, 12, 1),
          line(9, 1, 9, 4),
        ],

        location: [
          ellipse(9, 7, 5),
          ellipse(9, 7, 1.5),

          {
            type: "polyline",

            points: [
              {
                x: 5,
                y: 10,
              },
              {
                x: 9,
                y: 18,
              },
              {
                x: 13,
                y: 10,
              },
            ],

            lineWidth: 1.1,
            lineColor: COLORS.navy,
          },
        ],

        status: [
          ellipse(9, 9, 7),
          line(5, 9, 8, 12),
          line(8, 12, 13, 6),
        ],

        quantity: [
          rect(2, 3, 14, 12, 1),
          line(5, 7, 13, 7),
          line(5, 11, 13, 11),
        ],
      };

      const iconScale =
        0.82;

      return (
        icons[type] ||
        icons.quantity
      ).map((shape) => {
        const scaledShape = {
          ...shape,

          lineWidth:
            (shape.lineWidth || 1) *
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
            ] === "number"
          ) {
            scaledShape[
              coordinate
            ] *= iconScale;
          }
        }

        if (
          Array.isArray(
            scaledShape.points,
          )
        ) {
          scaledShape.points =
            scaledShape.points.map(
              (point) => ({
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
      });
    };

    // ============================================================
    // Cell Helpers
    // ============================================================

    const labelCell = (
      label,
      icon,
    ) => ({
      columns: [
        {
          width: 22,

          canvas:
            fieldIcon(icon),

          margin: [
            0,
            0,
            0,
            0,
          ],
        },

        {
          width: "*",

          text:
            label,

          style:
            "fieldLabel",

          margin: [
            2,
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
        5,
        6,
      ],
    });

    const valueCell = (
      value,
    ) => ({
      text:
        displayValue(value),

      style:
        "fieldValue",

      margin: [
        9,
        8,
        7,
        7,
      ],
    });

    const tableLayout = {
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

    const sectionHeading = (
      title,
    ) => ({
      text:
        title,

      fontSize:
        11,

      bold:
        true,

      color:
        COLORS.navy,

      margin: [
        0,
        4,
        0,
        7,
      ],
    });

    // ============================================================
    // Logo
    // ============================================================

    const logo =
      await loadLogo(
        detail.OrganizationID,
        data.logoUrl,
      );

    const generatedOn =
      formatDate(
        new Date(),
        "DD MMM YYYY hh:mm A",
      );

    // ============================================================
    // NRGP Item Details
    // ============================================================

    const itemDetailsBody = [
      [
        {
          text:
            "Sr.No.",

          style:
            "tableHeader",

          alignment:
            "center",
        },

        {
          text:
            "Item Name",

          style:
            "tableHeader",
        },

        {
          text:
            "Specification",

          style:
            "tableHeader",
        },

        {
          text:
            "Qty.",

          style:
            "tableHeader",

          alignment:
            "center",
        },

        {
          text:
            "Rate",

          style:
            "tableHeader",

          alignment:
            "center",
        },

        {
          text:
            "Make / Model",

          style:
            "tableHeader",
        },

        {
          text:
            "Serial No.",

          style:
            "tableHeader",
        },
      ],
    ];

    if (
      Array.isArray(
        detail.Items,
      ) &&
      detail.Items.length > 0
    ) {
      detail.Items.forEach(
        (item, index) => {
          itemDetailsBody.push([
            {
              text:
                index + 1,

              style:
                "tableValue",

              alignment:
                "center",
            },

            {
              text:
                displayValue(
                  item.ItemName,
                ),

              style:
                "tableValue",
            },

            {
              text:
                displayValue(
                  item.Specification,
                ),

              style:
                "tableValue",
            },

            {
              text:
                displayValue(
                  item.Quantity,
                ),

              style:
                "tableValue",

              alignment:
                "center",
            },

            {
              text:
                item.Rate !== null &&
                item.Rate !== undefined
                  ? Number(
                      item.Rate,
                    ).toFixed(2)
                  : "-",

              style:
                "tableValue",

              alignment:
                "center",
            },

            {
              text:
                displayValue(
                  item.MakeModel,
                ),

              style:
                "tableValue",
            },

            {
              text:
                displayValue(
                  item.SerialNumber,
                ),

              style:
                "tableValue",
            },
          ]);
        },
      );
    } else {
      itemDetailsBody.push([
        {
          text:
            "No NRGP item details found.",

          colSpan:
            7,

          alignment:
            "center",

          color:
            COLORS.muted,

          margin: [
            0,
            8,
            0,
            8,
          ],
        },

        {},
        {},
        {},
        {},
        {},
        {},
      ]);
    }

    // ============================================================
    // Approval Details
    //
    // Only actioned approvals will show.
    // Pending approvals will not show.
    // ============================================================

    const approvalActionRows =
      [];

    if (
      Array.isArray(
        detail.Approvals,
      ) &&
      detail.Approvals.length > 0
    ) {
      detail.Approvals.forEach(
        (approval) => {
          const status =
            String(
              approval.Status || "",
            )
              .trim()
              .toUpperCase();

          // ======================================================
          // Do not show Pending approval stages
          // ======================================================

          if (
            ![
              "APPROVED",
              "REJECTED",
              "CANCELLED",
            ].includes(status)
          ) {
            return;
          }

          const role =
            displayValue(
              approval.ApprovalRole,
            );

          // ======================================================
          // Actual User Name
          // ======================================================

          const actionByName =
            displayValue(
              approval.ActionByName,
            );

          let actionText =
            "";

          // ======================================================
          // Approval Text
          // ======================================================

          if (
            status ===
            "APPROVED"
          ) {
            actionText =
              `Approved by ${role} - ${actionByName}`;
          } else if (
            status ===
            "REJECTED"
          ) {
            actionText =
              `Rejected by ${role} - ${actionByName}`;
          } else if (
            status ===
            "CANCELLED"
          ) {
            actionText =
              `Cancelled by ${role} - ${actionByName}`;
          }

          approvalActionRows.push({
            text:
              actionText,

            fontSize:
              9,

            color:
              COLORS.text,

            margin: [
              0,
              0,
              0,
              6,
            ],
          });
        },
      );
    }

    // ============================================================
    // Prepare By
    // Created By Name only
    // ============================================================

    const preparedBy =
      displayValue(
        detail.CreatedByName,
      );

    // ============================================================
    // Document Definition
    // ============================================================

    const documentDefinition = {
      pageSize:
        "A4",

      pageOrientation:
        "portrait",

      pageMargins: [
        22,
        26,
        22,
        72,
      ],

      defaultStyle: {
        font:
          "Roboto",

        fontSize:
          9,

        color:
          COLORS.text,
      },

      content: [
        // ========================================================
        // Header
        // ========================================================

        {
          table: {
            widths: [
              130,
              "*",
              80,
            ],

            body: [
              [
                logo
                  ? {
                      image:
                        logo,

                      fit: [
                        88,
                        50,
                      ],

                      border: [
                        false,
                        false,
                        false,
                        false,
                      ],
                    }
                  : {
                      text:
                        "",

                      border: [
                        false,
                        false,
                        false,
                        false,
                      ],
                    },

                {
                  text:
                    "Non Returnable Gate Pass ",

                  style:
                    "title",

                  alignment:
                    "center",

                  margin: [
                    0,
                    18,
                    0,
                    0,
                  ],

                  border: [
                    false,
                    false,
                    false,
                    false,
                  ],
                },

                {
                  text:
                    "",

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

        // ========================================================
        // Header Line
        // ========================================================

        {
          canvas: [
            {
              type:
                "line",

              x1:
                0,

              y1:
                0,

              x2:
                551,

              y2:
                0,

              lineWidth:
                0.8,

              lineColor:
                COLORS.navy,
            },
          ],

          margin: [
            0,
            7,
            0,
            14,
          ],
        },

        // ========================================================
        // NRGP Details
        // ========================================================

        sectionHeading(
          "NRGP Details",
        ),

        {
          table: {
            widths: [
              105,
              "*",
              105,
              "*",
            ],

            body: [
              // ==================================================
              // Row 1
              // ==================================================

              [
                labelCell(
                  "NRGP No.",
                  "number",
                ),

                valueCell(
                  detail.NRGPNumber,
                ),

                labelCell(
                  "Department",
                  "department",
                ),

                valueCell(
                  detail.DepartmentName,
                ),
              ],

              // ==================================================
              // Row 2
              // ==================================================

              [
                labelCell(
                  "Vendor Name",
                  "vendor",
                ),

                valueCell(
                  detail.VendorName,
                ),

                labelCell(
                  "Contact No.",
                  "phone",
                ),

                valueCell(
                  detail.ContactNumber,
                ),
              ],

              // ==================================================
              // Row 3
              // ==================================================

              [
                labelCell(
                  "Company",
                  "organization",
                ),

                valueCell(
                  detail.Company,
                ),

                labelCell(
                  "Send To",
                  "location",
                ),

                valueCell(
                  detail.SendTo,
                ),
              ],

              // ==================================================
              // Row 4
              // Status removed
              // Created Date added
              // ==================================================

              [
                labelCell(
                  "Taken By",
                  "vendor",
                ),

                valueCell(
                  detail.TakenBy,
                ),

                labelCell(
                  "Created Date",
                  "status",
                ),

                valueCell(
                  detail.CreatedDate,
                ),
              ],

              // ==================================================
              // Row 5
              // ==================================================

              [
                labelCell(
                  "Address",
                  "location",
                ),

                {
                  ...valueCell(
                    detail.Address,
                  ),

                  colSpan:
                    3,
                },

                {},
                {},
              ],
            ],
          },

          layout:
            tableLayout,

          margin: [
            0,
            0,
            0,
            15,
          ],
        },

        // ========================================================
        // NRGP Item Details
        // ========================================================

        sectionHeading(
          "NRGP Item Details",
        ),

        {
          table: {
            headerRows:
              1,

            dontBreakRows:
              true,

            widths: [
              30,
              80,
              95,
              42,
              55,
              90,
              "*",
            ],

            body:
              itemDetailsBody,
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

            paddingLeft: () =>
              4,

            paddingRight: () =>
              4,

            paddingTop: () =>
              6,

            paddingBottom: () =>
              6,
          },

          margin: [
            0,
            0,
            0,
            15,
          ],
        },

        // ========================================================
        // Signature / Approval Section
        // ========================================================

        {
          margin: [
            2,
            18,
            2,
            0,
          ],

          columns: [
            // ====================================================
            // Left Side
            // ====================================================

            {
              width:
                "*",

              stack: [
                {
                  text:
                    "Signature of Person Taking Item",

                  fontSize:
                    9,

                  bold:
                    true,

                  color:
                    COLORS.text,

                  margin: [
                    0,
                    0,
                    0,
                    18,
                  ],
                },

                {
                  text: [
                    {
                      text:
                        "Taken By: ",

                      bold:
                        true,
                    },

                    {
                      text:
                        displayValue(
                          detail.TakenBy,
                        ),
                    },
                  ],

                  fontSize:
                    9,

                  color:
                    COLORS.text,

                  margin: [
                    0,
                    0,
                    0,
                    34,
                  ],
                },

                // ==================================================
                // Checked & Approved By
                // NO UNDERLINE
                // ==================================================

                {
                  text:
                    "Checked & Approved By",

                  fontSize:
                    9,

                  bold:
                    true,

                  color:
                    COLORS.text,

                  margin: [
                    0,
                    0,
                    0,
                    10,
                  ],
                },

                // ==================================================
                // Actual Actioned Approval Stages
                // ==================================================

                ...(
                  approvalActionRows.length >
                  0
                    ? approvalActionRows
                    : [
                        {
                          text:
                            "Approval pending",

                          fontSize:
                            9,

                          color:
                            COLORS.muted,
                        },
                      ]
                ),
              ],
            },

            // ====================================================
            // Right Side
            // ====================================================

            {
              width:
                180,

              stack: [
                {
                  text: [
                    {
                      text:
                        "Prepare By:- ",

                      bold:
                        true,
                    },

                    {
                      text:
                        preparedBy,
                    },
                  ],

                  alignment:
                    "right",

                  fontSize:
                    9,

                  color:
                    COLORS.text,

                  margin: [
                    0,
                    20,
                    0,
                    70,
                  ],
                },

                {
                  text:
                    "Security Sign & Seal",

                  alignment:
                    "right",

                  fontSize:
                    9,

                  bold:
                    true,

                  color:
                    COLORS.text,
                },
              ],
            },
          ],
        },
      ],

      // ==========================================================
      // Footer
      // ==========================================================

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
                type:
                  "line",

                x1:
                  0,

                y1:
                  0,

                x2:
                  551,

                y2:
                  0,

                lineWidth:
                  0.7,

                lineColor:
                  COLORS.navy,
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

                    bold:
                      true,

                    color:
                      COLORS.navy,

                    fontSize:
                      8,
                  },
                ],
              },

              {
                width:
                  130,

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

      // ==========================================================
      // Styles
      // ==========================================================

      styles: {
        title: {
          fontSize:
            18,

          bold:
            true,

          color:
            COLORS.navy,
        },

        fieldLabel: {
          fontSize:
            8.5,

          bold:
            true,

          color:
            COLORS.label,
        },

        fieldValue: {
          fontSize:
            9,

          color:
            COLORS.text,
        },

        tableHeader: {
          fontSize:
            7,

          bold:
            true,

          color:
            COLORS.navy,

          fillColor:
            COLORS.labelBackground,

          margin: [
            0,
            2,
            0,
            2,
          ],
        },

        tableValue: {
          fontSize:
            7,

          color:
            COLORS.text,

          margin: [
            0,
            2,
            0,
            2,
          ],
        },
      },
    };

    // ============================================================
    // Generate PDF Buffer
    // ============================================================

    const pdfBuffer =
      await new Promise(
        (
          resolve,
          reject,
        ) => {
          try {
            const pdfDocument =
              new PdfPrinter(
                RGP_DETAIL_PDF_FONTS,
              ).createPdfKitDocument(
                documentDefinition,
              );

            const chunks =
              [];

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

    // ============================================================
    // Return
    // ============================================================

    return {
      success:
        true,

      message:
        "NRGP detail PDF generated successfully.",

      data:
        pdfBuffer,

      fileName:
        `NRGP-Detail-${detail.NRGPNumber || nrgpID}.pdf`,

      contentType:
        "application/pdf",
    };
  } catch (error) {
    console.error(
      "Generate NRGP detail PDF error:",
      error,
    );

    return databaseFailure(
      error,
      "Generate NRGP detail PDF",
    );
  }
};
// ============================================================
// Exports
// ============================================================

module.exports = {
  createRGP,
  getRGPList,
  getRGPTotalList,
  getRGPById,
  getRGPByNumber,
  getRGPVendorNames,
  updateRGP,
  updateRGPExpectedReturnDate,
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
  getRGPRedFlagReport,
  getRGPListReportPdf,
  getRGPDepartmentWiseReportPdf,
  getRGPVendorWiseReportPdf,
  getRGPPendingReturnReportPdf,
  generateRGPDetailPdf,
  getRGPRedFlagReportPdf,

  createNRGP,
  getNRGPList,
  getTotalNRGP,
  getNRGPById,
  getNRGPVendorNames,
  updateNRGP,
  deleteNRGP,
  processNRGPApproval,
  getNRGPApprovalConfig,
  saveNRGPApprovalConfig,
  deleteNRGPApprovalConfig,
  getNRGPListReport,
  getNRGPDepartmentWiseReport,
  getNRGPVendorWiseReport,
  getNRGPApprovalStatusReport,
  generateNRGPListReportPdf,
  generateNRGPDepartmentWiseReportPdf,
  generateNRGPVendorWiseReportPdf,
  generateNRGPApprovalStatusReportPdf,
  generateNRGPDetailPdf,
};
