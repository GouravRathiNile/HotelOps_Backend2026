const { pool } = require("../../db");
const {retryableDatabaseResponse,} = require("../../utils/retryableDatabaseError");
const { formatDate } = require("../../utils/dateFormatter");
const generateUrl = require("../../AzurConfigration/CreditApplication/AzureGetData");
const { dispatchCommittedCreditApplicationEvent } = require("./CreditApplicationNotificationService");
// ===============================================Pdf Helper
const { generatePdf, loadLogo } = require("../../utils/pdfHelper");
const PdfPrinter = require("pdfmake");
const path = require("path");
const EQUIPMENT_DETAIL_PDF_FONTS = {
  Roboto: {
    normal: path.join(process.cwd(), "fonts/Roboto-Regular.ttf"),
    bold: path.join(process.cwd(), "fonts/Roboto-Medium.ttf"),
    italics: path.join(process.cwd(), "fonts/Roboto-SemiBold.ttf"),
    bolditalics: path.join(process.cwd(), "fonts/Roboto-Bold.ttf"),
  },
};

// ===================== Response Helpers
const ok = (message, data, metadata) => ({
  success: true,
  message,
  ...(metadata !== undefined ? metadata : {}),
  ...(data !== undefined ? { data } : {}),
});
const fail = (message, statusCode = 400) => ({
  success: false,
  statusCode,
  message,
});
const databaseFailure = (error, action) => {
  console.error(`${action} Error:`, error.message);

  const retryResponse =
    retryableDatabaseResponse(error);

  if (retryResponse) {
    return retryResponse;
  }

  return {
    success: false,
    statusCode: 500,
    message: `Unable to ${action.toLowerCase()}.`,
  };
};
// ======================== normalize Credit Application
const normalizeCreditApplicationApprovalRole = (value) => {
  const role = String(value || "").trim().toUpperCase();
  return role === "FINANCE" ? "FC" : role;
};
// ============================================================ CREATE CREDIT APPLICATION
const createCreditApplication = async (data) => {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const {
      OrganizationID,

      ApplicationDate,

      CompanyName,
      CompanyGSTIN,
      MSME,

      BusinessAddress,
      BillingAddress,

      AuthorisedPersonNamePosition,
      AuthorisedPersonMobileNo,
      AuthorisedPersonEmail,

      AccountsContactNamePosition,
      AccountsContactMobileNo,
      AccountsContactEmail,

      RecommendedBy,
      Position,

      CreditReferenceCheckedBy,
      CreditReferenceCheckedDate,

      CreditAmountAllowed,
      ExpectedBusinessFY,
      FinancialYear,

      Documents,

      UserID,
    } = data;


    // ============================================================
    // Approval Flow
    //
    // NO DEFAULT FLOW
    //
    // approval_master
    // approval_master_details
    // ============================================================

    const approvalFlow =
      await getCreditApplicationApprovalFlow(
        OrganizationID,
        client,
      );


    if (
      !Array.isArray(approvalFlow) ||
      approvalFlow.length === 0
    ) {
      await client.query("ROLLBACK");

      return fail(
        "Credit Application approval flow is not configured for this organization.",
        400,
      );
    }


    // ============================================================
    // Validate Approval Flow
    // ============================================================

    for (const approvalStep of approvalFlow) {
      const ApprovalID =
        Number(
          approvalStep.ApprovalID,
        );

      const ApprovalLevel =
        Number(
          approvalStep.LevelNo,
        );

      const ApprovalOrder =
        Number(
          approvalStep.ApprovalOrder,
        );

      const ApprovalRole =
        String(
          approvalStep.ApprovalRole ||
            "",
        ).trim();

      const ApproverType =
        String(
          approvalStep.ApproverType ||
            "",
        )
          .trim()
          .toUpperCase();

      const ApproverValue =
        String(
          approvalStep.ApproverValue ||
            "",
        ).trim();


      if (
        !Number.isSafeInteger(ApprovalID) ||
        ApprovalID <= 0
      ) {
        await client.query("ROLLBACK");

        return fail(
          "Invalid ApprovalID in Credit Application approval flow.",
          400,
        );
      }


      if (
        !Number.isInteger(ApprovalLevel) ||
        ApprovalLevel <= 0
      ) {
        await client.query("ROLLBACK");

        return fail(
          "Invalid approval level in Credit Application approval flow.",
          400,
        );
      }


      if (
        !Number.isInteger(ApprovalOrder) ||
        ApprovalOrder <= 0
      ) {
        await client.query("ROLLBACK");

        return fail(
          "Invalid approval order in Credit Application approval flow.",
          400,
        );
      }


      if (!ApprovalRole) {
        await client.query("ROLLBACK");

        return fail(
          "Approval role is required in Credit Application approval flow.",
          400,
        );
      }


      if (
  ![
    "USER",
    "ROLE",
    "REGIONAL",
  ].includes(
    ApproverType,
  )
) {
  await client.query("ROLLBACK");

  return fail(
    "ApproverType must be USER, ROLE, or REGIONAL.",
    400,
  );
}


      if (!ApproverValue) {
        await client.query("ROLLBACK");

        return fail(
          "Approver value is required in Credit Application approval flow.",
          400,
        );
      }
    }


    // ============================================================
    // Insert Credit Application Master
    //
    // ARID = NULL
    // Status = PENDING
    // ============================================================

    const masterResult =
      await client.query(
        `
        INSERT INTO Credit_Application_Entry_Master
        (
          OrganizationID,

          ApplicationDate,

          CompanyName,
          CompanyGSTIN,
          MSME,

          BusinessAddress,
          BillingAddress,

          AuthorisedPersonNamePosition,
          AuthorisedPersonMobileNo,
          AuthorisedPersonEmail,

          AccountsContactNamePosition,
          AccountsContactMobileNo,
          AccountsContactEmail,

          RecommendedBy,
          Position,

          CreditReferenceCheckedBy,
          CreditReferenceCheckedDate,

          CreditAmountAllowed,
          ExpectedBusinessFY,
          FinancialYear,

          ARID,

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
          $9,
          $10,

          $11,
          $12,
          $13,

          $14,
          $15,

          $16,
          $17,

          $18,
          $19,
          $20,

          NULL,

          'PENDING',

          FALSE,

          $21,
          CURRENT_TIMESTAMP
        )

        RETURNING
          CreditApplicationID;
        `,
        [
          OrganizationID,

          ApplicationDate,

          CompanyName,
          CompanyGSTIN,
          MSME,

          BusinessAddress,
          BillingAddress,

          AuthorisedPersonNamePosition,
          AuthorisedPersonMobileNo,
          AuthorisedPersonEmail,

          AccountsContactNamePosition,
          AccountsContactMobileNo,
          AccountsContactEmail,

          RecommendedBy,
          Position,

          CreditReferenceCheckedBy,
          CreditReferenceCheckedDate,

          CreditAmountAllowed,
          ExpectedBusinessFY,
          FinancialYear,

          UserID,
        ],
      );


    const CreditApplicationID =
      Number(
        masterResult.rows[0]
          .creditapplicationid,
      );


    // ============================================================
    // Insert Documents
    // ============================================================

    for (
      let i = 0;
      i < (Documents || []).length;
      i += 1
    ) {
      const document =
        Documents[i];

      await client.query(
        `
        INSERT INTO Credit_Application_Entry_Master_document
        (
          CreditApplicationID,

          DocumentType,

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
          CreditApplicationID,

          document.DocumentType ||
            null,

          document.FileName ||
            null,

          document.FilePath ||
            null,

          document.FileType ||
            null,

          document.FileSize ??
            null,

          UserID,
        ],
      );
    }


    // ============================================================
    // Insert Dynamic Approval Rows
    //
    // Approval Builder ka har step
    // Credit_Application_Approval me separate row banega.
    // ============================================================

    for (
      const approvalStep of
        approvalFlow
    ) {
      const ApprovalID =
        Number(
          approvalStep.ApprovalID,
        );

      const ApprovalLevel =
        Number(
          approvalStep.LevelNo,
        );

      const ApprovalOrder =
        Number(
          approvalStep.ApprovalOrder,
        );

      const ApprovalRole =
        String(
          approvalStep.ApprovalRole ||
            "",
        )
          .trim()
          .toUpperCase();

      const ApproverType =
        String(
          approvalStep.ApproverType ||
            "",
        )
          .trim()
          .toUpperCase();

      const ApproverValue =
        String(
          approvalStep.ApproverValue ||
            "",
        ).trim();


      await client.query(
        `
        INSERT INTO Credit_Application_Approval
        (
          CreditApplicationID,

          ApprovalID,

          ApprovalLevel,
          ApprovalRole,
          ApprovalOrder,

          ApproverType,
          ApproverValue,

          Status,
          StatusDateTime,

          ActionBy,
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
          $7,

          'Pending',
          NULL,

          NULL,
          NULL,

          FALSE,

          $8,
          CURRENT_TIMESTAMP
        );
        `,
        [
          CreditApplicationID,

          ApprovalID,

          ApprovalLevel,
          ApprovalRole,
          ApprovalOrder,

          ApproverType,
          ApproverValue,

          UserID,
        ],
      );
    }


    // ============================================================
    // First Approval Step
    // Notification ke liye existing behavior same rakha hai.
    // ============================================================

    const firstApprovalStep =
      approvalFlow[0];

    const firstApprovalRole =
      firstApprovalStep
        ?.ApprovalRole ||
      null;


    // ============================================================
    // Commit
    // ============================================================

    await client.query(
      "COMMIT",
    );


    // ============================================================
    // Notification / Event
    //
    // Existing notification behavior unchanged.
    // ============================================================

    dispatchCommittedCreditApplicationEvent({
      organizationID:
        OrganizationID,

      creditApplicationID:
        CreditApplicationID,

      companyName:
        CompanyName,

      roles:
        firstApprovalRole
          ? [
              firstApprovalRole,
            ]
          : [],

      kind:
        "CREATE",

      action:
        "CREATED",

      details: {
        applicationDate:
          ApplicationDate,

        creditAmountAllowed:
          CreditAmountAllowed,

        expectedBusinessFY:
          ExpectedBusinessFY,

        financialYear:
          FinancialYear,

        authorisedPerson:
          AuthorisedPersonNamePosition,

        accountsContact:
          AccountsContactNamePosition,
      },
    });


    // ============================================================
    // Response
    // ============================================================

    return ok(
      "Credit Application created successfully.",
      {
        CreditApplicationID,
      },
    );

  } catch (error) {
    await client.query(
      "ROLLBACK",
    );


    if (
      error.code === "23503"
    ) {
      return fail(
        "Invalid Credit Application related data.",
        400,
      );
    }


    if (
      error.code === "23505"
    ) {
      return fail(
        "Credit Application record already exists.",
        409,
      );
    }


    if (
      error.code === "22P02"
    ) {
      return fail(
        "Invalid Credit Application data.",
        400,
      );
    }


    return databaseFailure(
      error,
      "Create Credit Application",
    );

  } finally {
    client.release();
  }
};
// ============================================================ Get Apis Helper
// ============================================================
// GET CREDIT APPLICATION APPROVAL FLOW
// ============================================================
const getCreditApplicationApprovalFlow = async (
  OrganizationID,
  db = pool,
) => {
  const organizationID =
    Number(
      OrganizationID,
    );

  if (
    !Number.isSafeInteger(
      organizationID,
    ) ||
    organizationID <= 0
  ) {
    return [];
  }


  // ============================================================
  // Get Latest Active Credit Application Approval Flow
  // ============================================================

  const result =
    await db.query(
      `
        WITH selected_flow AS
        (
          SELECT
            am.approvalmasterid

          FROM approval_master am

          WHERE am.organizationid = $1

            AND REPLACE(
                  UPPER(
                    TRIM(
                      COALESCE(
                        am.modulename,
                        ''
                      )
                    )
                  ),
                  '_',
                  ' '
                ) = 'CREDIT APPLICATION'

            AND am.isactive = TRUE
            AND am.isdelete = FALSE

          ORDER BY
            am.modifieddatetime DESC NULLS LAST,
            am.createddatetime DESC,
            am.approvalmasterid DESC

          LIMIT 1
        )

        SELECT
          amd.approvalid,
          amd.approvalmasterid,
          amd.level,
          amd.approvertype,
          amd.role,
          amd.approvaltype,
          amd.ismandatory

        FROM approval_master_details amd

        INNER JOIN selected_flow sf
          ON sf.approvalmasterid =
             amd.approvalmasterid

        WHERE amd.isdelete = FALSE

        ORDER BY
          amd.level ASC,
          amd.approvalid ASC;
      `,
      [
        organizationID,
      ],
    );


  // ============================================================
  // No Approval Flow
  // ============================================================

  if (
    result.rows.length === 0
  ) {
    return [];
  }


  // ============================================================
  // Mapping
  // ============================================================

  return result.rows.map(
    (row) => {
      const approvalRole =
  normalizeCreditApplicationApprovalRole(
    row.approvaltype,
  );

      return {
        ApprovalMasterID:
          Number(
            row.approvalmasterid,
          ),

        ApprovalID:
          Number(
            row.approvalid,
          ),

        LevelNo:
          Number(
            row.level,
          ),

        ApprovalOrder:
          Number(
            row.level,
          ),

        ApprovalRole:
          approvalRole,

        ApproverType:
          String(
            row.approvertype || "",
          )
            .trim()
            .toUpperCase(),

        ApproverValue:
          String(
            row.role || "",
          ).trim(),

        IsMandatory:
          Boolean(
            row.ismandatory,
          ),
      };
    },
  );
};
// ============================================================
// GET LOGGED-IN CREDIT APPLICATION USER CONTEXT
//
// USER approver ke liye Username user_master se aayega.
// ROLE approver ke liye UserType / DepartmentName use honge.
// ============================================================
const getCreditApplicationUserContext = async (
  data,
  db = pool,
) => {
  const UserID =
    Number(
      data.UserID,
    );

  let Username = "";

  if (
    Number.isSafeInteger(UserID) &&
    UserID > 0
  ) {
    const result =
      await db.query(
        `
        SELECT
          UserID,
          Username

        FROM user_master

        WHERE UserID = $1
          AND IsDeleted = FALSE
          AND IsActive = TRUE

        LIMIT 1;
        `,
        [
          UserID,
        ],
      );

    Username =
      String(
        result.rows[0]?.username ||
          "",
      )
        .trim()
        .toUpperCase();
  }

  return {
    UserID,

    Username,

    UserType:
      String(
        data.UserType || "",
      )
        .trim()
        .toUpperCase(),

    DepartmentName:
      String(
        data.DepartmentName || "",
      )
        .trim()
        .toUpperCase(),
  };
};
// ============================================================
// CHECK CREDIT APPLICATION APPROVAL STEP ASSIGNMENT
//
// ApproverType = USER
// -> ApproverValue = UserID / Username
//
// ApproverType = REGIONAL
// -> ApproverValue = Selected Regional UserID / Username
//
// ApproverType = ROLE
// -> ApproverValue = UserType / DepartmentName
//
// IMPORTANT:
// ApprovalRole = FC
// -> Logged-in user DepartmentName must be FINANCE
// ============================================================
const isCreditApplicationApprovalStepAssignedToUser = (
  approvalStep,
  userContext,
) => {
  if (
    !approvalStep ||
    !userContext
  ) {
    return false;
  }


  // ============================================================
  // Approval Role
  //
  // FINANCE -> FC
  // ============================================================

  const approvalRole =
    normalizeCreditApplicationApprovalRole(
      approvalStep.ApprovalRole ||
        approvalStep.ApprovalType,
    );


  // ============================================================
  // Approver Type
  //
  // USER
  // ROLE
  // REGIONAL
  // ============================================================

  const approverType =
    String(
      approvalStep.ApproverType ||
        "",
    )
      .trim()
      .toUpperCase();


  // ============================================================
  // Approver Value
  //
  // USER
  // -> UserID / Username
  //
  // REGIONAL
  // -> Selected Regional UserID / Username
  //
  // ROLE
  // -> UserType / DepartmentName
  // ============================================================

  const approverValue =
    String(
      approvalStep.ApproverValue ||
        "",
    )
      .trim()
      .toUpperCase();


  if (!approverValue) {
    return false;
  }


  // ============================================================
  // Logged-In User Context
  // ============================================================

  const userID =
    String(
      userContext.UserID ||
        "",
    )
      .trim()
      .toUpperCase();


  const username =
    String(
      userContext.Username ||
        "",
    )
      .trim()
      .toUpperCase();


  const userType =
    String(
      userContext.UserType ||
        "",
    )
      .trim()
      .toUpperCase();


  const departmentName =
    String(
      userContext.DepartmentName ||
        "",
    )
      .trim()
      .toUpperCase();


  // ============================================================
  // FC Approval
  //
  // FC approver ka Department FINANCE hona compulsory hai.
  //
  // Example:
  // ApprovalRole = FC
  // ApproverType = ROLE
  // ApproverValue = HOD
  //
  // Agar HOD kisi aur department ka hai,
  // to wo FC approval nahi karega.
  // ============================================================

  if (
    approvalRole === "FC" &&
    departmentName !== "FINANCE"
  ) {
    return false;
  }


  // ============================================================
  // USER / REGIONAL APPROVER
  //
  // USER:
  // Selected user ko approval milega.
  //
  // REGIONAL:
  // Selected regional user ko approval milega.
  //
  // ApproverValue currently UserID ho sakta hai.
  // Username compatibility bhi rakhi hai.
  // ============================================================

  if (
    [
      "USER",
      "REGIONAL",
    ].includes(
      approverType,
    )
  ) {
    return (
      approverValue === userID ||
      approverValue === username
    );
  }


  // ============================================================
  // ROLE APPROVER
  //
  // Example:
  // HOD
  // GM
  // FINANCE
  // SECURITY
  // ============================================================

  if (
    approverType === "ROLE"
  ) {
    return (
      approverValue === userType ||
      approverValue === departmentName
    );
  }


  // ============================================================
  // Invalid Approver Type
  // ============================================================

  return false;
};
// ======================== Normalize Helper
const normalizeCreditApprovalStatus = (value) =>
  String(
    value || "Pending",
  )
    .trim()
    .toUpperCase();
// ======================== Row Mapper Helper
const mapCreditApplication = (row) => ({
  CreditApplicationID:
    Number(
      row.creditapplicationid,
    ),

  OrganizationID:
    Number(
      row.organizationid,
    ),

  OrganizationShortName:
    row.OrganizationShortName ??
    row.organizationshortname ??
    null,

  ApplicationDate:
    formatDate(
      row.applicationdate,
    ),

  CompanyName:
    row.companyname,

  CompanyGSTIN:
    row.companygstin,

  MSME:
    row.msme,

  BusinessAddress:
    row.businessaddress,

  BillingAddress:
    row.billingaddress,

  AuthorisedPersonNamePosition:
    row.authorisedpersonnameposition,

  AuthorisedPersonMobileNo:
    row.authorisedpersonmobileno,

  AuthorisedPersonEmail:
    row.authorisedpersonemail,

  AccountsContactNamePosition:
    row.accountscontactnameposition,

  AccountsContactMobileNo:
    row.accountscontactmobileno,

  AccountsContactEmail:
    row.accountscontactemail,

  RecommendedBy:
    row.recommendedby,

  Position:
    row.position,

  CreditReferenceCheckedBy:
    row.creditreferencecheckedby,

  CreditReferenceCheckedDate:
    formatDate(
      row.creditreferencecheckeddate,
    ),

  CreditAmountAllowed:
    row.creditamountallowed !== null
      ? Number(
          row.creditamountallowed,
        )
      : null,

  ExpectedBusinessFY:
    row.expectedbusinessfy !== null
      ? Number(
          row.expectedbusinessfy,
        )
      : null,

  FinancialYear:
    row.financialyear,

  ARID:
    row.arid || null,


  // ============================================================
  // Application Overall Status
  //
  // PENDING
  // APPROVED
  // REJECTED
  // ============================================================

  Status:
    String(
      row.status || "PENDING",
    )
      .trim()
      .toUpperCase(),


  // ============================================================
  // Existing Frontend Compatibility
  // FinalStatus ko ab Master.Status se derive karenge.
  // ============================================================

  FinalStatus:
    String(
      row.status || "PENDING",
    )
      .trim()
      .toUpperCase(),


  // ============================================================
  // Current Approval Stage
  // attach helper me populate hoga.
  // ============================================================

  CurrentApprovalRole:
    null,

  CurrentStatus:
    String(
      row.status || "PENDING",
    )
      .trim()
      .toUpperCase(),

  Approvals: [],

  Documents: [],

  CreatedDate:
    formatDate(
      row.createddate,
    ),
});
// ======================= Attach Documents + Approval Array Helper
const attachCreditApplicationRelatedData = async (
  rows,
) => {
  if (
    !Array.isArray(rows) ||
    rows.length === 0
  ) {
    return [];
  }


  // ============================================================
  // Credit Application IDs
  // ============================================================

  const CreditApplicationIDs =
    rows.map(
      (row) =>
        Number(
          row.creditapplicationid,
        ),
    );


  // ============================================================
  // Documents
  // ============================================================

  const documentsResult =
    await pool.query(
      `
        SELECT
          CreditApplicationDocumentID,
          CreditApplicationID,
          DocumentType,

          FileName,
          FilePath,
          FileType,
          FileSize,

          CreatedDate

        FROM Credit_Application_Entry_Master_document

        WHERE CreditApplicationID =
              ANY($1::bigint[])

          AND IsDeleted = FALSE

        ORDER BY
          CreditApplicationID ASC,
          CreditApplicationDocumentID ASC;
      `,
      [
        CreditApplicationIDs,
      ],
    );


  // ============================================================
  // Dynamic Approval Rows
  //
  // IMPORTANT:
  // approval_master ko yahan dobara query nahi karna.
  //
  // Application create ke time jo approval snapshot
  // Credit_Application_Approval me save hua tha,
  // wahi use hoga.
  // ============================================================

  const approvalsResult =
    await pool.query(
      `
        SELECT
          CreditApplicationApprovalID,
          CreditApplicationID,

          ApprovalID,

          ApprovalLevel,
          ApprovalRole,
          ApprovalOrder,

          ApproverType,
          ApproverValue,

          Status,
          StatusDateTime,

          ActionBy,
          Remarks,

          CreatedDate,
          ModifiedDate

        FROM Credit_Application_Approval

        WHERE CreditApplicationID =
              ANY($1::bigint[])

          AND IsDeleted = FALSE

        ORDER BY
          CreditApplicationID ASC,
          ApprovalOrder ASC,
          ApprovalLevel ASC,
          CreditApplicationApprovalID ASC;
      `,
      [
        CreditApplicationIDs,
      ],
    );


  // ============================================================
  // Map Main Rows
  // ============================================================

  const mapped =
    rows.map(
      (row) =>
        mapCreditApplication(
          row,
        ),
    );


  // ============================================================
  // Map By Credit Application ID
  // ============================================================

  const byID =
    new Map(
      mapped.map(
        (item) => [
          item.CreditApplicationID,
          item,
        ],
      ),
    );


  // ============================================================
  // Attach Approval Rows
  // ============================================================

  for (
    const row of approvalsResult.rows
  ) {
    const item =
      byID.get(
        Number(
          row.creditapplicationid,
        ),
      );

    if (!item) {
      continue;
    }


    const approvalRole =
      String(
        row.approvalrole || "",
      )
        .trim()
        .toUpperCase();


    const approverType =
      String(
        row.approvertype || "",
      )
        .trim()
        .toUpperCase();


    const status =
      String(
        row.status || "Pending",
      )
        .trim()
        .toUpperCase();


    item.Approvals.push({
      CreditApplicationApprovalID:
        Number(
          row.creditapplicationapprovalid,
        ),

      ApprovalID:
        row.approvalid !== null &&
        row.approvalid !== undefined
          ? Number(
              row.approvalid,
            )
          : null,

      LevelNo:
        Number(
          row.approvallevel,
        ),

      ApprovalLevel:
        Number(
          row.approvallevel,
        ),

      ApprovalOrder:
        Number(
          row.approvalorder,
        ),

      ApprovalRole:
        approvalRole,

      ApprovalType:
        approvalRole,

      ApproverType:
        approverType,

      ApproverValue:
        String(
          row.approvervalue || "",
        ).trim(),

      Status:
        status,

      StatusDateTime:
        row.statusdatetime ||
        null,

      ActionBy:
        row.actionby !== null &&
        row.actionby !== undefined
          ? Number(
              row.actionby,
            )
          : null,

      // Existing frontend compatibility
      ApprovedBy:
        row.actionby !== null &&
        row.actionby !== undefined
          ? Number(
              row.actionby,
            )
          : null,

      Remarks:
        row.remarks ||
        null,
    });
  }


  // ============================================================
  // Attach Documents
  // ============================================================

  for (
    const row of documentsResult.rows
  ) {
    const item =
      byID.get(
        Number(
          row.creditapplicationid,
        ),
      );

    if (!item) {
      continue;
    }


    item.Documents.push({
      CreditApplicationDocumentID:
        Number(
          row.creditapplicationdocumentid,
        ),

      DocumentType:
        row.documenttype,

      FileName:
        row.filename,

      FilePath:
        row.filepath
          ? generateUrl(
              row.filepath,
            )
          : null,

      FileType:
        row.filetype ||
        null,

      FileSize:
        row.filesize !== null &&
        row.filesize !== undefined
          ? Number(
              row.filesize,
            )
          : null,

      CreatedDate:
        row.createddate ||
        null,
    });
  }


  // ============================================================
  // Current Approval Stage
  // ============================================================

  for (
    const item of mapped
  ) {
    const overallStatus =
      normalizeCreditApprovalStatus(
        item.Status,
      );


    // ==========================================================
    // APPROVED
    // ==========================================================

    if (
      overallStatus === "APPROVED"
    ) {
      item.CurrentApprovalRole =
        null;

      item.CurrentStatus =
        "APPROVED";

      continue;
    }


    // ==========================================================
    // REJECTED
    //
    // Jis approval step ne reject kiya,
    // usko current role dikha denge.
    // ==========================================================

    if (
      overallStatus === "REJECTED"
    ) {
      const rejectedStage =
        item.Approvals.find(
          (approval) =>
            normalizeCreditApprovalStatus(
              approval.Status,
            ) === "REJECTED",
        );

      item.CurrentApprovalRole =
        rejectedStage
          ?.ApprovalRole ||
        null;

      item.CurrentStatus =
        "REJECTED";

      continue;
    }


    // ==========================================================
    // PENDING
    //
    // First approval row jo Approved nahi hai
    // wahi current stage hai.
    // ==========================================================

    const currentStage =
      item.Approvals.find(
        (approval) =>
          normalizeCreditApprovalStatus(
            approval.Status,
          ) !== "APPROVED",
      );


    item.CurrentApprovalRole =
      currentStage
        ?.ApprovalRole ||
      null;


    item.CurrentStatus =
      currentStage
        ?.Status ||
      "PENDING";
  }


  return mapped;
};
// ====================== Credit Application Query
const CREDIT_APPLICATION_BASE_FROM = `
  FROM Credit_Application_Entry_Master ca

  LEFT JOIN Organization_Master om
    ON om.OrganizationID = ca.OrganizationID
   AND om.IsDeleted = FALSE

  LEFT JOIN LATERAL
  (
    SELECT
      caa.CreditApplicationApprovalID,
      caa.CreditApplicationID,

      caa.ApprovalID,

      caa.ApprovalLevel,
      caa.ApprovalRole,
      caa.ApprovalOrder,

      caa.ApproverType,
      caa.ApproverValue,

      caa.Status,
      caa.StatusDateTime,

      caa.ActionBy,
      caa.Remarks

    FROM Credit_Application_Approval caa

    WHERE caa.CreditApplicationID =
          ca.CreditApplicationID

      AND caa.IsDeleted = FALSE

      AND UPPER(
            TRIM(
              COALESCE(
                caa.Status,
                'Pending'
              )
            )
          ) <> 'APPROVED'

    ORDER BY
      caa.ApprovalOrder ASC,
      caa.ApprovalLevel ASC,
      caa.CreditApplicationApprovalID ASC

    LIMIT 1

  ) current_stage
    ON TRUE
`;
// ============================================================Credit Applications List
const getCreditApplicationList = async (data) => {
  try {
    // ============================================================
    // Organization
    // ============================================================

    const OrganizationID =
      Number(
        data.OrganizationID,
      );

    if (
      !Number.isSafeInteger(
        OrganizationID,
      ) ||
      OrganizationID <= 0
    ) {
      return fail(
        "OrganizationID is required.",
        400,
      );
    }


    // ============================================================
    // Pagination
    // ============================================================

    const page =
      Number(data.page) || 1;

    const PageSize =
      Number(
        data.PageSize,
      ) || 10;

    if (
      !Number.isInteger(page) ||
      page <= 0
    ) {
      return fail(
        "page must be a positive integer.",
        400,
      );
    }

    if (
      !Number.isInteger(
        PageSize,
      ) ||
      PageSize <= 0 ||
      PageSize > 100
    ) {
      return fail(
        "PageSize must be between 1 and 100.",
        400,
      );
    }

    const offset =
      (page - 1) *
      PageSize;


    // ============================================================
    // Company Name
    // ============================================================

    const CompanyName =
      data.CompanyName !== undefined &&
      data.CompanyName !== null &&
      String(
        data.CompanyName,
      ).trim() !== ""
        ? String(
            data.CompanyName,
          ).trim()
        : null;


    // ============================================================
    // Status
    //
    // Only:
    // PENDING
    // APPROVED
    // REJECTED
    // ============================================================

    const Status =
      data.Status !== undefined &&
      data.Status !== null &&
      String(
        data.Status,
      ).trim() !== ""
        ? String(
            data.Status,
          )
            .trim()
            .toUpperCase()
        : null;

    const validStatuses = [
      "PENDING",
      "APPROVED",
      "REJECTED",
    ];

    if (
      Status &&
      !validStatuses.includes(
        Status,
      )
    ) {
      return fail(
        "Status must be Pending, Approved, or Rejected.",
        400,
      );
    }


    // ============================================================
    // Approval Flow Filter
    //
    // Dynamic:
    // FC / GM / CEO / etc.
    // ============================================================

  const ApprovalFlow =
  data.ApprovalFlow !== undefined &&
  data.ApprovalFlow !== null &&
  String(
    data.ApprovalFlow,
  ).trim() !== ""
    ? normalizeCreditApplicationApprovalRole(
        data.ApprovalFlow,
      )
    : null;


    // ============================================================
    // Application Date Range
    // ============================================================

    const normalizeDateFilter = (
      value,
    ) =>
      value !== undefined &&
      value !== null &&
      String(value).trim() !== ""
        ? String(value).trim()
        : null;

    const FromDate =
      normalizeDateFilter(
        data.FromDate,
      );

    const ToDate =
      normalizeDateFilter(
        data.ToDate,
      );

    const datePattern =
      /^\d{4}-\d{2}-\d{2}$/;

    const isValidDateFilter = (
      value,
    ) => {
      if (
        !value ||
        !datePattern.test(value)
      ) {
        return false;
      }

      const parsedDate =
        new Date(
          `${value}T00:00:00.000Z`,
        );

      return (
        !Number.isNaN(
          parsedDate.getTime(),
        ) &&
        parsedDate
          .toISOString()
          .slice(0, 10) ===
          value
      );
    };

    if (
      FromDate &&
      !isValidDateFilter(
        FromDate,
      )
    ) {
      return fail(
        "FromDate must be a valid date in YYYY-MM-DD format.",
        400,
      );
    }

    if (
      ToDate &&
      !isValidDateFilter(
        ToDate,
      )
    ) {
      return fail(
        "ToDate must be a valid date in YYYY-MM-DD format.",
        400,
      );
    }

    if (
      FromDate &&
      ToDate &&
      FromDate > ToDate
    ) {
      return fail(
        "FromDate cannot be greater than ToDate.",
        400,
      );
    }


    // ============================================================
    // Logged-In User Context
    // ============================================================

    const userContext =
      await getCreditApplicationUserContext(
        data,
      );

    const userID =
      String(
        userContext.UserID || "",
      ).trim();

    const username =
      String(
        userContext.Username || "",
      )
        .trim()
        .toUpperCase();

    const userType =
      String(
        userContext.UserType || "",
      )
        .trim()
        .toUpperCase();

    const departmentName =
      String(
        userContext.DepartmentName || "",
      )
        .trim()
        .toUpperCase();


    // ============================================================
    // Check Logged-In User Is Approver
    //
    // IMPORTANT:
    // Latest approval_master flow nahi dekhenge.
    //
    // Actual Credit_Application_Approval snapshot rows dekhenge.
    // ============================================================

    const approverCheckResult =
      await pool.query(
        `
          SELECT EXISTS
          (
            SELECT 1

            FROM Credit_Application_Approval caa

            INNER JOIN Credit_Application_Entry_Master ca_check
              ON ca_check.CreditApplicationID =
                 caa.CreditApplicationID

            WHERE ca_check.OrganizationID = $1

              AND ca_check.IsDeleted = FALSE
              AND caa.IsDeleted = FALSE

              AND
              (
                UPPER(
                  TRIM(
                    COALESCE(
                      caa.ApprovalRole,
                      ''
                    )
                  )
                ) <> 'FC'

                OR

                UPPER(
                  TRIM(
                    ($5)::text
                  )
                ) = 'FINANCE'
              )

              AND
              (
                (
                  UPPER(
  TRIM(
    COALESCE(
      caa.ApproverType,
      ''
    )
  )
) IN
(
  'USER',
  'REGIONAL'
)

                  AND
                  (
                    TRIM(
                      COALESCE(
                        caa.ApproverValue,
                        ''
                      )
                    ) =
                    TRIM(
                      ($2)::text
                    )

                    OR

                    UPPER(
                      TRIM(
                        COALESCE(
                          caa.ApproverValue,
                          ''
                        )
                      )
                    ) =
                    UPPER(
                      TRIM(
                        ($3)::text
                      )
                    )
                  )
                )

                OR

                (
                  UPPER(
                    TRIM(
                      COALESCE(
                        caa.ApproverType,
                        ''
                      )
                    )
                  ) = 'ROLE'

                  AND

                  UPPER(
                    TRIM(
                      COALESCE(
                        caa.ApproverValue,
                        ''
                      )
                    )
                  ) IN
                  (
                    UPPER(
                      TRIM(
                        ($4)::text
                      )
                    ),

                    UPPER(
                      TRIM(
                        ($5)::text
                      )
                    )
                  )
                )
              )
          ) AS IsApprover;
        `,
        [
          OrganizationID,
          userID,
          username,
          userType,
          departmentName,
        ],
      );


    const isApprover =
      Boolean(
        approverCheckResult
          .rows[0]
          ?.isapprover,
      );


    // ============================================================
    // User Types
    // ============================================================

    const isSalesDepartment =
      [
        "SALES",
        "SALES & MARKETING",
      ].includes(
        departmentName,
      );

    const salesViewer =
      !isApprover &&
      isSalesDepartment;

    const frontOfficeViewer =
      !isApprover &&
      (
        departmentName ===
          "FRONT OFFICE" ||

        departmentName ===
          "FO"
      );

    const completedOnlyViewer =
      !isApprover &&
      !salesViewer;

    const canFilter =
      isSalesDepartment ||
      isApprover;


    // ============================================================
    // Front Office Search Rule
    // ============================================================

    if (
      frontOfficeViewer &&
      !CompanyName
    ) {
      return ok(
        "Credit Application records fetched successfully.",
        {
          TotalCount: 0,
          PageCount: 0,
          CurrentPage: page,
          PageSize,
          TotalPages: 0,
          CanFilter:
            canFilter,
          data: [],
        },
      );
    }


    // ============================================================
    // Common WHERE
    // ============================================================

    let whereClause = `
      WHERE ca.IsDeleted = FALSE
        AND ca.OrganizationID = $1
    `;

    const params = [
      OrganizationID,
    ];


    // ============================================================
    // Company Search
    // ============================================================

    if (CompanyName) {
      params.push(
        CompanyName,
      );

      whereClause += `
        AND COALESCE(
              ca.CompanyName,
              ''
            ) ILIKE
            '%' || $${params.length} || '%'
      `;
    }


    // ============================================================
    // Date Filters
    // ============================================================

    if (FromDate) {
      params.push(
        FromDate,
      );

      whereClause += `
        AND ca.ApplicationDate >=
            $${params.length}::date
      `;
    }

    if (ToDate) {
      params.push(
        ToDate,
      );

      whereClause += `
        AND ca.ApplicationDate <=
            $${params.length}::date
      `;
    }


    // ============================================================
    // Approver SQL Parameters
    // ============================================================

    let assignedApprovalSql =
      null;

    let assignedCurrentStageSql =
      null;

    if (isApprover) {
      params.push(
        userID,
      );

      const userIDIndex =
        params.length;

      params.push(
        username,
      );

      const usernameIndex =
        params.length;

      params.push(
        userType,
      );

      const userTypeIndex =
        params.length;

      params.push(
        departmentName,
      );

      const departmentIndex =
        params.length;


      // ==========================================================
      // Reusable Approval Assignment SQL
      // ==========================================================

      const getAssignedApprovalSql = (
        alias,
      ) => `
        (
          (
            UPPER(
              TRIM(
                COALESCE(
                  ${alias}.ApprovalRole,
                  ''
                )
              )
            ) <> 'FC'

            OR

            UPPER(
              TRIM(
                ($${departmentIndex})::text
              )
            ) = 'FINANCE'
          )

          AND

          (
            (
             UPPER(
  TRIM(
    COALESCE(
      ${alias}.ApproverType,
      ''
    )
  )
) IN
(
  'USER',
  'REGIONAL'
)

              AND

              (
                TRIM(
                  COALESCE(
                    ${alias}.ApproverValue,
                    ''
                  )
                ) =
                TRIM(
                  ($${userIDIndex})::text
                )

                OR

                UPPER(
                  TRIM(
                    COALESCE(
                      ${alias}.ApproverValue,
                      ''
                    )
                  )
                ) =
                UPPER(
                  TRIM(
                    ($${usernameIndex})::text
                  )
                )
              )
            )

            OR

            (
              UPPER(
                TRIM(
                  COALESCE(
                    ${alias}.ApproverType,
                    ''
                  )
                )
              ) = 'ROLE'

              AND

              UPPER(
                TRIM(
                  COALESCE(
                    ${alias}.ApproverValue,
                    ''
                  )
                )
              ) IN
              (
                UPPER(
                  TRIM(
                    ($${userTypeIndex})::text
                  )
                ),

                UPPER(
                  TRIM(
                    ($${departmentIndex})::text
                  )
                )
              )
            )
          )
        )
      `;


      assignedApprovalSql =
        getAssignedApprovalSql(
          "caa_history",
        );

      assignedCurrentStageSql =
        getAssignedApprovalSql(
          "current_stage",
        );


      // ==========================================================
      // Approver Access
      // ==========================================================

      if (Status === "PENDING") {
        whereClause += `
          AND
          (
            (
              UPPER(
                TRIM(
                  COALESCE(
                    ca.Status,
                    'PENDING'
                  )
                )
              ) = 'PENDING'

              AND

              current_stage.CreditApplicationApprovalID
                IS NOT NULL

              AND

              UPPER(
                TRIM(
                  COALESCE(
                    current_stage.Status,
                    'Pending'
                  )
                )
              ) = 'PENDING'

              AND

              ${assignedCurrentStageSql}
            )

            OR

            (
              UPPER(
                TRIM(
                  COALESCE(
                    ca.Status,
                    'PENDING'
                  )
                )
              ) = 'APPROVED'

              AND

              NULLIF(
                TRIM(
                  COALESCE(
                    ca.ARID,
                    ''
                  )
                ),
                ''
              ) IS NULL

              AND EXISTS
              (
                SELECT 1

                FROM Credit_Application_Approval
                     caa_history

                WHERE caa_history.CreditApplicationID =
                      ca.CreditApplicationID

                  AND caa_history.IsDeleted = FALSE

                  AND UPPER(
                        TRIM(
                          COALESCE(
                            caa_history.ApprovalRole,
                            ''
                          )
                        )
                      ) = 'FC'

                  AND UPPER(
                        TRIM(
                          COALESCE(
                            caa_history.Status,
                            ''
                          )
                        )
                      ) = 'APPROVED'

                  AND ${assignedApprovalSql}
              )
            )
          )
        `;
      }


      // ==========================================================
      // APPROVED / REJECTED
      // Own Approval History
      // ==========================================================

      else if (
        [
          "APPROVED",
          "REJECTED",
        ].includes(
          Status,
        )
      ) {
        params.push(
          Status,
        );

        const statusIndex =
          params.length;

        whereClause += `
          AND EXISTS
          (
            SELECT 1

            FROM Credit_Application_Approval
                 caa_history

            WHERE caa_history.CreditApplicationID =
                  ca.CreditApplicationID

              AND caa_history.IsDeleted = FALSE

              AND ${assignedApprovalSql}

              AND UPPER(
                    TRIM(
                      COALESCE(
                        caa_history.Status,
                        ''
                      )
                    )
                  ) =
                  $${statusIndex}

              AND NOT
              (
                UPPER(
                  TRIM(
                    COALESCE(
                      caa_history.ApprovalRole,
                      ''
                    )
                  )
                ) = 'FC'

                AND

                $${statusIndex} = 'APPROVED'

                AND

                UPPER(
                  TRIM(
                    COALESCE(
                      ca.Status,
                      ''
                    )
                  )
                ) = 'APPROVED'

                AND

                NULLIF(
                  TRIM(
                    COALESCE(
                      ca.ARID,
                      ''
                    )
                  ),
                  ''
                ) IS NULL
              )
          )
        `;
      }


      // ==========================================================
      // No Status
      //
      // Current Pending Work
      // +
      // Own History
      // +
      // FC ARID Pending
      // ==========================================================

      else {
        whereClause += `
          AND
          (
            (
              UPPER(
                TRIM(
                  COALESCE(
                    ca.Status,
                    'PENDING'
                  )
                )
              ) = 'PENDING'

              AND

              current_stage.CreditApplicationApprovalID
                IS NOT NULL

              AND

              UPPER(
                TRIM(
                  COALESCE(
                    current_stage.Status,
                    'Pending'
                  )
                )
              ) = 'PENDING'

              AND

              ${assignedCurrentStageSql}
            )

            OR

            EXISTS
            (
              SELECT 1

              FROM Credit_Application_Approval
                   caa_history

              WHERE caa_history.CreditApplicationID =
                    ca.CreditApplicationID

                AND caa_history.IsDeleted = FALSE

                AND ${assignedApprovalSql}

                AND UPPER(
                      TRIM(
                        COALESCE(
                          caa_history.Status,
                          ''
                        )
                      )
                    ) IN
                    (
                      'APPROVED',
                      'REJECTED'
                    )

                AND NOT
                (
                  UPPER(
                    TRIM(
                      COALESCE(
                        caa_history.ApprovalRole,
                        ''
                      )
                    )
                  ) = 'FC'

                  AND

                  UPPER(
                    TRIM(
                      COALESCE(
                        caa_history.Status,
                        ''
                      )
                    )
                  ) = 'APPROVED'

                  AND

                  UPPER(
                    TRIM(
                      COALESCE(
                        ca.Status,
                        ''
                      )
                    )
                  ) = 'APPROVED'

                  AND

                  NULLIF(
                    TRIM(
                      COALESCE(
                        ca.ARID,
                        ''
                      )
                    ),
                    ''
                  ) IS NULL
                )
            )

            OR

            (
              UPPER(
                TRIM(
                  COALESCE(
                    ca.Status,
                    ''
                  )
                )
              ) = 'APPROVED'

              AND

              NULLIF(
                TRIM(
                  COALESCE(
                    ca.ARID,
                    ''
                  )
                ),
                ''
              ) IS NULL

              AND EXISTS
              (
                SELECT 1

                FROM Credit_Application_Approval
                     caa_history

                WHERE caa_history.CreditApplicationID =
                      ca.CreditApplicationID

                  AND caa_history.IsDeleted = FALSE

                  AND UPPER(
                        TRIM(
                          COALESCE(
                            caa_history.ApprovalRole,
                            ''
                          )
                        )
                      ) = 'FC'

                  AND UPPER(
                        TRIM(
                          COALESCE(
                            caa_history.Status,
                            ''
                          )
                        )
                      ) = 'APPROVED'

                  AND ${assignedApprovalSql}
              )
            )
          )
        `;
      }
    }


    // ============================================================
    // Completed-Only Viewer
    //
    // Front Office / CEO / Other non-approver users
    // ============================================================

    else if (completedOnlyViewer) {
      whereClause += `
        AND UPPER(
              TRIM(
                COALESCE(
                  ca.Status,
                  ''
                )
              )
            ) = 'APPROVED'

        AND NULLIF(
              TRIM(
                COALESCE(
                  ca.ARID,
                  ''
                )
              ),
              ''
            ) IS NOT NULL
      `;
    }


    // ============================================================
    // Sales Status Filter
    // ============================================================

    else if (Status) {
      params.push(
        Status,
      );

      const statusIndex =
        params.length;

      whereClause += `
        AND UPPER(
              TRIM(
                COALESCE(
                  ca.Status,
                  'PENDING'
                )
              )
            ) =
            $${statusIndex}
      `;
    }


    // ============================================================
    // Approval Flow Filter
    //
    // Dynamic ApprovalRole
    // ============================================================

    if (ApprovalFlow) {
      params.push(
        ApprovalFlow,
      );

      const flowIndex =
        params.length;


      // ==========================================================
      // Selected Flow + Pending
      // ==========================================================

      if (Status === "PENDING") {
        whereClause += `
          AND
          (
            (
              UPPER(
                TRIM(
                  COALESCE(
                    current_stage.ApprovalRole,
                    ''
                  )
                )
              ) =
              $${flowIndex}

              AND

              UPPER(
                TRIM(
                  COALESCE(
                    current_stage.Status,
                    'Pending'
                  )
                )
              ) = 'PENDING'
            )

            OR

            (
              $${flowIndex} = 'FC'

              AND

              UPPER(
                TRIM(
                  COALESCE(
                    ca.Status,
                    ''
                  )
                )
              ) = 'APPROVED'

              AND

              NULLIF(
                TRIM(
                  COALESCE(
                    ca.ARID,
                    ''
                  )
                ),
                ''
              ) IS NULL

              AND EXISTS
              (
                SELECT 1

                FROM Credit_Application_Approval
                     caa_flow

                WHERE caa_flow.CreditApplicationID =
                      ca.CreditApplicationID

                  AND caa_flow.IsDeleted = FALSE

                  AND UPPER(
                        TRIM(
                          COALESCE(
                            caa_flow.ApprovalRole,
                            ''
                          )
                        )
                      ) = 'FC'

                  AND UPPER(
                        TRIM(
                          COALESCE(
                            caa_flow.Status,
                            ''
                          )
                        )
                      ) = 'APPROVED'
              )
            )
          )
        `;
      }


      // ==========================================================
      // Selected Flow + Approved / Rejected
      // ==========================================================

      else if (
        Status === "APPROVED" ||
        Status === "REJECTED"
      ) {
        params.push(
          Status,
        );

        const flowStatusIndex =
          params.length;

        whereClause += `
          AND EXISTS
          (
            SELECT 1

            FROM Credit_Application_Approval
                 caa_flow

            WHERE caa_flow.CreditApplicationID =
                  ca.CreditApplicationID

              AND caa_flow.IsDeleted = FALSE

              AND UPPER(
                    TRIM(
                      COALESCE(
                        caa_flow.ApprovalRole,
                        ''
                      )
                    )
                  ) =
                  $${flowIndex}

              AND UPPER(
                    TRIM(
                      COALESCE(
                        caa_flow.Status,
                        ''
                      )
                    )
                  ) =
                  $${flowStatusIndex}
          )
        `;


        // ========================================================
        // FC Approved + ARID Blank
        // Pending AR task hai, Approved history nahi.
        // ========================================================

        if (
          ApprovalFlow === "FC" &&
          Status === "APPROVED"
        ) {
          whereClause += `
            AND NOT
            (
              UPPER(
                TRIM(
                  COALESCE(
                    ca.Status,
                    ''
                  )
                )
              ) = 'APPROVED'

              AND

              NULLIF(
                TRIM(
                  COALESCE(
                    ca.ARID,
                    ''
                  )
                ),
                ''
              ) IS NULL
            )
          `;
        }
      }


      // ==========================================================
      // Selected Flow Only
      // ==========================================================

      else {
        whereClause += `
          AND EXISTS
          (
            SELECT 1

            FROM Credit_Application_Approval
                 caa_flow

            WHERE caa_flow.CreditApplicationID =
                  ca.CreditApplicationID

              AND caa_flow.IsDeleted = FALSE

              AND UPPER(
                    TRIM(
                      COALESCE(
                        caa_flow.ApprovalRole,
                        ''
                      )
                    )
                  ) =
                  $${flowIndex}
          )
        `;
      }
    }


    // ============================================================
    // Count
    // ============================================================

    const countResult =
      await pool.query(
        `
          SELECT
            COUNT(*)::bigint
              AS TotalCount

          ${CREDIT_APPLICATION_BASE_FROM}

          ${whereClause};
        `,
        params,
      );


    const TotalCount =
      Number(
        countResult.rows[0]
          ?.totalcount || 0,
      );


    // ============================================================
    // Pagination Params
    // ============================================================

    const listParams = [
      ...params,
      PageSize,
      offset,
    ];

    const limitIndex =
      params.length + 1;

    const offsetIndex =
      params.length + 2;


    // ============================================================
    // List
    // ============================================================

    const result =
      await pool.query(
        `
          SELECT
            ca.CreditApplicationID,
            ca.OrganizationID,

            om.ShortName
              AS "OrganizationShortName",

            ca.ApplicationDate,

            ca.CompanyName,
            ca.CompanyGSTIN,
            ca.MSME,

            ca.BusinessAddress,
            ca.BillingAddress,

            ca.AuthorisedPersonNamePosition,
            ca.AuthorisedPersonMobileNo,
            ca.AuthorisedPersonEmail,

            ca.AccountsContactNamePosition,
            ca.AccountsContactMobileNo,
            ca.AccountsContactEmail,

            ca.RecommendedBy,
            ca.Position,

            ca.CreditReferenceCheckedBy,
            ca.CreditReferenceCheckedDate,

            ca.CreditAmountAllowed,
            ca.ExpectedBusinessFY,
            ca.FinancialYear,

            ca.ARID,

            ca.Status,

            ca.CreatedBy,
            ca.CreatedDate,
            ca.ModifiedBy,
            ca.ModifiedDate

          ${CREDIT_APPLICATION_BASE_FROM}

          ${whereClause}

          ORDER BY
            ca.CreatedDate DESC,
            ca.CreditApplicationID DESC

          LIMIT $${limitIndex}

          OFFSET $${offsetIndex};
        `,
        listParams,
      );


    // ============================================================
    // Attach Documents + Dynamic Approval Rows
    // ============================================================

    const records =
      await attachCreditApplicationRelatedData(
        result.rows,
      );


    // ============================================================
    // CanAction + CanApprove + FC ARID
    // ============================================================

    for (
      const record of records
    ) {
      record.CanAction =
        isSalesDepartment;


      // ==========================================================
      // Current Approval Stage
      // ==========================================================

      const currentStage =
        record.Approvals.find(
          (stage) =>
            normalizeCreditApprovalStatus(
              stage.Status,
            ) !==
            "APPROVED",
        );


      // ==========================================================
      // Current Stage Assigned To Logged-In User
      // ==========================================================

      const currentStageAssignedToUser =
        isCreditApplicationApprovalStepAssignedToUser(
          currentStage,
          userContext,
        );


      // ==========================================================
      // Can Approve
      // ==========================================================

      record.CanApprove =
        Boolean(
          normalizeCreditApprovalStatus(
            record.Status,
          ) === "PENDING" &&

          currentStage &&

          currentStageAssignedToUser &&

          normalizeCreditApprovalStatus(
            currentStage.Status,
          ) === "PENDING"
        );


      // ==========================================================
      // FC ARID Pending
      // ==========================================================

      const fcApproval =
        record.Approvals.find(
          (stage) =>
            String(
              stage.ApprovalRole ||
                "",
            )
              .trim()
              .toUpperCase() ===
            "FC",
        );


      const loggedInUserIsFCApprover =
        Boolean(
          fcApproval &&

          isCreditApplicationApprovalStepAssignedToUser(
            fcApproval,
            userContext,
          ),
        );


      const allApprovalsApproved =
        record.Approvals.length >
          0 &&

        record.Approvals.every(
          (stage) =>
            normalizeCreditApprovalStatus(
              stage.Status,
            ) ===
            "APPROVED",
        );


      const isFCARPending =
        loggedInUserIsFCApprover &&

        allApprovalsApproved &&

        normalizeCreditApprovalStatus(
          record.Status,
        ) === "APPROVED" &&

        String(
          record.ARID || "",
        ).trim() === "";


      if (isFCARPending) {
        record.CurrentApprovalRole =
          "FC";

        record.CurrentStatus =
          "PENDING";

        record.CanApprove =
          false;
      }
    }


    // ============================================================
    // Remove Internal Fields From List
    // ============================================================

    for (
      const record of records
    ) {
      for (
        const field of [
          "OrganizationName",
          "CreatedBy",
          "ModifiedDate",
          "Documents",
        ]
      ) {
        delete record[
          field
        ];
      }


      for (
        const approval of
          record.Approvals ||
          []
      ) {
        delete approval.ApprovalID;

        delete approval.LevelNo;
        delete approval.ApprovalLevel;
        delete approval.ApprovalOrder;

        delete approval.ApproverType;
        delete approval.ApproverValue;

        delete approval.ApprovalType;

        delete approval.StatusDateTime;

        delete approval.ActionBy;
        delete approval.ApprovedBy;
      }
    }


    // ============================================================
    // Pagination
    // ============================================================

    const TotalPages =
      TotalCount > 0
        ? Math.ceil(
            TotalCount /
              PageSize,
          )
        : 0;


    // ============================================================
    // Response
    // ============================================================

    return ok(
      "Credit Application records fetched successfully.",
      {
        TotalCount,

        PageCount:
          records.length,

        CurrentPage:
          page,

        PageSize,

        TotalPages,

        CanFilter:
          canFilter,

        data:
          records,
      },
    );

  } catch (error) {
    return databaseFailure(
      error,
      "Fetch Credit Application records",
    );
  }
};
// ============================================================Get Credit Application By ID
const getCreditApplicationById = async (data) => {
  try {
    // ============================================================
    // ID
    // ============================================================

    const CreditApplicationID =
      Number(
        data.CreditApplicationID,
      );

    if (
      !Number.isSafeInteger(
        CreditApplicationID,
      ) ||
      CreditApplicationID <= 0
    ) {
      return fail(
        "Valid CreditApplicationID is required.",
        400,
      );
    }


    // ============================================================
    // Query
    //
    // Overall Status:
    // Credit_Application_Entry_Master.Status
    //
    // Approval rows:
    // attachCreditApplicationRelatedData()
    // ============================================================

    const result =
      await pool.query(
        `
          SELECT
            ca.CreditApplicationID,
            ca.OrganizationID,

            om.OrganizationName
              AS "OrganizationName",

            om.ShortName
              AS "OrganizationShortName",

            ca.ApplicationDate,

            ca.CompanyName,
            ca.CompanyGSTIN,
            ca.MSME,

            ca.BusinessAddress,
            ca.BillingAddress,

            ca.AuthorisedPersonNamePosition,
            ca.AuthorisedPersonMobileNo,
            ca.AuthorisedPersonEmail,

            ca.AccountsContactNamePosition,
            ca.AccountsContactMobileNo,
            ca.AccountsContactEmail,

            ca.RecommendedBy,
            ca.Position,

            ca.CreditReferenceCheckedBy,
            ca.CreditReferenceCheckedDate,

            ca.CreditAmountAllowed,
            ca.ExpectedBusinessFY,
            ca.FinancialYear,

            ca.ARID,

            ca.Status,

            ca.CreatedBy,
            ca.CreatedDate,

            ca.ModifiedBy,
            ca.ModifiedDate

          ${CREDIT_APPLICATION_BASE_FROM}

          WHERE
            ca.CreditApplicationID = $1

            AND ca.IsDeleted = FALSE

          LIMIT 1;
        `,
        [
          CreditApplicationID,
        ],
      );


    // ============================================================
    // Not Found
    // ============================================================

    if (
      result.rows.length === 0
    ) {
      return fail(
        "Credit Application record not found.",
        404,
      );
    }


    // ============================================================
    // Attach Documents + Dynamic Approval Rows
    // ============================================================

    const records =
      await attachCreditApplicationRelatedData(
        result.rows,
      );

    const CreditApplication =
      records[0];


    // ============================================================
    // Approval Rows Must Exist
    //
    // Approval snapshot create time par save hua tha.
    // ============================================================

    if (
      !Array.isArray(
        CreditApplication.Approvals,
      ) ||
      CreditApplication.Approvals.length === 0
    ) {
      return fail(
        "Credit Application approval flow is not available for this application.",
        400,
      );
    }


    // ============================================================
    // Logged-In User Context
    // ============================================================

    const userContext =
      await getCreditApplicationUserContext(
        data,
      );

    const userType =
      userContext.UserType;

    const departmentName =
      userContext.DepartmentName;


    // ============================================================
    // Sales
    // ============================================================

    const isSalesDepartment =
      [
        "SALES",
        "SALES & MARKETING",
      ].includes(
        departmentName,
      );


    // ============================================================
    // Approval Steps Assigned To Logged-In User
    //
    // USER
    // ROLE
    // FC -> Department FINANCE compulsory
    // ============================================================

    const assignedApprovalSteps =
      CreditApplication.Approvals.filter(
        (stage) =>
          isCreditApplicationApprovalStepAssignedToUser(
            stage,
            userContext,
          ),
      );

    const isApprover =
      assignedApprovalSteps.length > 0;


    // ============================================================
    // Overall Status
    // ============================================================

    const overallStatus =
      normalizeCreditApprovalStatus(
        CreditApplication.Status,
      );


    // ============================================================
    // Current Approval Stage
    //
    // First stage which is not Approved.
    // ============================================================

    const currentStage =
      CreditApplication.Approvals.find(
        (stage) =>
          normalizeCreditApprovalStatus(
            stage.Status,
          ) !==
          "APPROVED",
      );


    // ============================================================
    // All Approvals Approved
    // ============================================================

    const allApprovalsApproved =
      CreditApplication.Approvals.length >
        0 &&

      CreditApplication.Approvals.every(
        (stage) =>
          normalizeCreditApprovalStatus(
            stage.Status,
          ) ===
          "APPROVED",
      );


    // ============================================================
    // ARID
    // ============================================================

    const hasARID =
      String(
        CreditApplication.ARID ||
          "",
      ).trim() !== "";


    // ============================================================
    // Completed-Only Viewer
    //
    // Sales:
    // workflow data dekh sakta hai.
    //
    // Approver:
    // assigned stage/history ke according access.
    //
    // Other non-approvers:
    // APPROVED + ARID available hone ke baad view.
    // ============================================================

    const completedOnlyViewer =
      !isApprover &&
      !isSalesDepartment;


    if (
      completedOnlyViewer &&
      (
        overallStatus !==
          "APPROVED" ||

        !allApprovalsApproved ||

        !hasARID
      )
    ) {
      return fail(
        "You are not authorized to view this Credit Application.",
        403,
      );
    }


    // ============================================================
    // FC Approval Step
    // ============================================================

    const fcApproval =
      CreditApplication.Approvals.find(
        (stage) =>
          normalizeCreditApplicationApprovalRole(
            stage.ApprovalRole,
          ) ===
          "FC",
      );


    // ============================================================
    // Logged-In User Is Configured FC Approver?
    // ============================================================

    const loggedInUserIsFCApprover =
      Boolean(
        fcApproval &&

        isCreditApplicationApprovalStepAssignedToUser(
          fcApproval,
          userContext,
        ),
      );


    // ============================================================
    // FC ARID Pending
    //
    // All approvals Approved
    // + Master Status APPROVED
    // + ARID blank
    // + logged-in user is FC approver
    // ============================================================

    const fcARPending =
      loggedInUserIsFCApprover &&

      allApprovalsApproved &&

      overallStatus ===
        "APPROVED" &&

      !hasARID;


    // ============================================================
    // Approver View Access
    // ============================================================

    if (isApprover) {
      // ==========================================================
      // Is Current Stage Assigned To Logged-In User?
      // ==========================================================

      const isCurrentStage =
        Boolean(
          currentStage &&

          isCreditApplicationApprovalStepAssignedToUser(
            currentStage,
            userContext,
          ),
        );


      // ==========================================================
      // User's Own Approval History
      //
      // Only:
      // APPROVED
      // REJECTED
      // ==========================================================

      const hasAlreadyActed =
        assignedApprovalSteps.some(
          (stage) =>
            [
              "APPROVED",
              "REJECTED",
            ].includes(
              normalizeCreditApprovalStatus(
                stage.Status,
              ),
            ),
        );


      // ==========================================================
      // Access
      // ==========================================================

      if (
        !isCurrentStage &&
        !hasAlreadyActed &&
        !fcARPending
      ) {
        return fail(
          "You are not authorized to view this Credit Application at the current approval stage.",
          403,
        );
      }
    }


    // ============================================================
    // Can Approve
    //
    // Application overall PENDING hona chahiye.
    //
    // Current approval row:
    // PENDING
    //
    // Current approval row logged-in user ko assigned honi chahiye.
    // ============================================================

    const currentStageAssignedToUser =
      Boolean(
        currentStage &&

        isCreditApplicationApprovalStepAssignedToUser(
          currentStage,
          userContext,
        ),
      );


    CreditApplication.CanApprove =
      Boolean(
        overallStatus ===
          "PENDING" &&

        currentStage &&

        currentStageAssignedToUser &&

        normalizeCreditApprovalStatus(
          currentStage.Status,
        ) ===
          "PENDING"
      );


    // ============================================================
    // FC ARID Pending
    //
    // Approval flow complete hai.
    // FC ko ab ARID update karni hai.
    //
    // Approval button nahi aayega.
    // ============================================================

    if (fcARPending) {
      CreditApplication.CurrentApprovalRole =
        "FC";

      CreditApplication.CurrentStatus =
        "PENDING";

      CreditApplication.CanApprove =
        false;
    }


    // ============================================================
    // Can Action
    //
    // Existing Sales behaviour
    // ============================================================

    CreditApplication.CanAction =
      isSalesDepartment;


    // ============================================================
    // Remove Internal Approval Fields
    //
    // Response me:
    // CreditApplicationApprovalID
    // ApprovalRole
    // Status
    // Remarks
    //
    // useful fields rahenge.
    // ============================================================

    for (
      const approval of
        CreditApplication.Approvals ||
        []
    ) {
      delete approval.ApprovalID;

      delete approval.LevelNo;
      delete approval.ApprovalLevel;
      delete approval.ApprovalOrder;

      delete approval.ApproverType;
      delete approval.ApproverValue;

      delete approval.ApprovalType;

      delete approval.StatusDateTime;

      delete approval.ActionBy;
      delete approval.ApprovedBy;
    }


    // ============================================================
    // Response
    // ============================================================

    return ok(
      "Credit Application record fetched successfully.",
      CreditApplication,
    );

  } catch (error) {
    return databaseFailure(
      error,
      "Fetch Credit Application record",
    );
  }
};
// ============================================================GET COMPANY NAMES
const getCompanyNames = async (data) => {
  try {
    // ============================================================
    // Organization
    // ============================================================

    const OrganizationID =
      Number(
        data.OrganizationID,
      );

    if (
      !Number.isSafeInteger(
        OrganizationID,
      ) ||
      OrganizationID <= 0
    ) {
      return fail(
        "Valid OrganizationID is required.",
        400,
      );
    }

    // ============================================================
    // Query
    // Case Insensitive Unique Company Names
    // ============================================================

    const result =
      await pool.query(
        `
        SELECT
          MIN(
            TRIM(
              CompanyName
            )
          ) AS CompanyName

        FROM Credit_Application_Entry_Master

        WHERE OrganizationID = $1

          AND IsDeleted = FALSE

          AND NULLIF(
            TRIM(
              COALESCE(
                CompanyName,
                ''
              )
            ),
            ''
          ) IS NOT NULL

        GROUP BY
          UPPER(
            TRIM(
              CompanyName
            )
          )

        ORDER BY
          CompanyName ASC;
        `,
        [
          OrganizationID,
        ],
      );

    // ============================================================
    // Mapping
    // Only Company Name Required
    // ============================================================

    const records =
  result.rows.map(
    (row) => ({
      CompanyName:
        row.companyname,
    }),
  );
    // ============================================================
    // Response
    // ============================================================

    return ok(
      "Company names fetched successfully.",
      {
        Count:
          records.length,

        data:
          records,
      },
    );

  } catch (error) {
    return databaseFailure(
      error,
      "Fetch company names",
    );
  }
};
// ============================================================UPDATE CREDIT APPLICATION
const updateCreditApplication = async (data) => {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const {
      CreditApplicationID,
      OrganizationID,

      ApplicationDate,

      CompanyName,
      CompanyGSTIN,
      MSME,

      BusinessAddress,
      BillingAddress,

      AuthorisedPersonNamePosition,
      AuthorisedPersonMobileNo,
      AuthorisedPersonEmail,

      AccountsContactNamePosition,
      AccountsContactMobileNo,
      AccountsContactEmail,

      RecommendedBy,
      Position,

      CreditReferenceCheckedBy,
      CreditReferenceCheckedDate,

      CreditAmountAllowed,
      ExpectedBusinessFY,
      FinancialYear,

      Documents,
      DeleteDocumentIDs,

      UserID,
    } = data;

    // ============================================================
    // Check Record
    // Lock record during update
    // ============================================================

    const existingResult =
  await client.query(
    `
      SELECT
        ca.CreditApplicationID,
        ca.Status

      FROM Credit_Application_Entry_Master ca

      WHERE ca.CreditApplicationID = $1
        AND ca.OrganizationID = $2
        AND ca.IsDeleted = FALSE

      FOR UPDATE;
    `,
    [
      CreditApplicationID,
      OrganizationID,
    ],
  );

    if (
      existingResult.rows.length === 0
    ) {
      await client.query("ROLLBACK");

      return fail(
        "Credit Application record not found.",
        404,
      );
    }

    // ============================================================
    // Approved record cannot be modified
    // ============================================================

    const applicationStatus =
  normalizeCreditApprovalStatus(
    existingResult.rows[0].status,
  );

if (
  applicationStatus === "APPROVED"
) {
  await client.query(
    "ROLLBACK",
  );

  return fail(
    "Approved Credit Application cannot be modified.",
    400,
  );
}

    // ============================================================
    // Update Master
    //
    // ARID intentionally not updated here.
    // ============================================================

    await client.query(
      `
      UPDATE Credit_Application_Entry_Master

      SET
        ApplicationDate = $1,

        CompanyName = $2,
        CompanyGSTIN = $3,
        MSME = $4,

        BusinessAddress = $5,
        BillingAddress = $6,

        AuthorisedPersonNamePosition = $7,
        AuthorisedPersonMobileNo = $8,
        AuthorisedPersonEmail = $9,

        AccountsContactNamePosition = $10,
        AccountsContactMobileNo = $11,
        AccountsContactEmail = $12,

        RecommendedBy = $13,
        Position = $14,

        CreditReferenceCheckedBy = $15,
        CreditReferenceCheckedDate = $16,

        CreditAmountAllowed = $17,
        ExpectedBusinessFY = $18,
        FinancialYear = $19,

        ModifiedBy = $20,
        ModifiedDate = CURRENT_TIMESTAMP

      WHERE CreditApplicationID = $21
        AND OrganizationID = $22
        AND IsDeleted = FALSE;
      `,
      [
        ApplicationDate,

        CompanyName,
        CompanyGSTIN,
        MSME,

        BusinessAddress,
        BillingAddress,

        AuthorisedPersonNamePosition,
        AuthorisedPersonMobileNo,
        AuthorisedPersonEmail,

        AccountsContactNamePosition,
        AccountsContactMobileNo,
        AccountsContactEmail,

        RecommendedBy,
        Position,

        CreditReferenceCheckedBy,
        CreditReferenceCheckedDate,

        CreditAmountAllowed,
        ExpectedBusinessFY,
        FinancialYear,

        UserID,

        CreditApplicationID,
        OrganizationID,
      ],
    );

    // ============================================================
    // Delete Selected Documents
    // Soft Delete
    // ============================================================

    if (
      Array.isArray(DeleteDocumentIDs) &&
      DeleteDocumentIDs.length > 0
    ) {
      await client.query(
        `
        UPDATE Credit_Application_Entry_Master_document

        SET
          IsDeleted = TRUE,
          DeletedBy = $1,
          DeletedDate = CURRENT_TIMESTAMP,
          ModifiedBy = $1,
          ModifiedDate = CURRENT_TIMESTAMP

        WHERE CreditApplicationID = $2

          AND CreditApplicationDocumentID =
              ANY($3::bigint[])

          AND IsDeleted = FALSE;
        `,
        [
          UserID,
          CreditApplicationID,
          DeleteDocumentIDs,
        ],
      );
    }

    // ============================================================
    // Insert New Documents
    // ============================================================

    for (
      let i = 0;
      i < (Documents || []).length;
      i++
    ) {
      const document =
        Documents[i];

      await client.query(
        `
        INSERT INTO Credit_Application_Entry_Master_document
        (
          CreditApplicationID,
          DocumentType,

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
          CreditApplicationID,

          document.DocumentType || null,

          document.FileName || null,
          document.FilePath || null,
          document.FileType || null,
          document.FileSize ?? null,

          UserID,
        ],
      );
    }

    // ============================================================
    // Commit
    // ============================================================

    await client.query("COMMIT");

    return ok(
      "Credit Application updated successfully.",
    );

  } catch (error) {
    await client.query("ROLLBACK");

    if (error.code === "23503") {
      return fail(
        "Invalid Credit Application related data.",
        400,
      );
    }

    if (error.code === "22P02") {
      return fail(
        "Invalid Credit Application data.",
        400,
      );
    }

    return databaseFailure(
      error,
      "Update Credit Application",
    );

  } finally {
    client.release();
  }
};
// ============================================================DELETE CREDIT APPLICATION
const deleteCreditApplication = async (data) => {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const {
      CreditApplicationID,
      UserID,
    } = data;

   const existingResult =
  await client.query(
    `
      SELECT
        ca.CreditApplicationID,
        ca.Status

      FROM Credit_Application_Entry_Master ca

      WHERE ca.CreditApplicationID = $1
        AND ca.IsDeleted = FALSE

      FOR UPDATE;
    `,
    [
      CreditApplicationID,
    ],
  );
    if (
      existingResult.rows.length === 0
    ) {
      await client.query("ROLLBACK");

      return fail(
        "Credit Application record not found.",
        404,
      );
    }

   const applicationStatus =
  normalizeCreditApprovalStatus(
    existingResult.rows[0].status,
  );

if (
  applicationStatus === "APPROVED"
) {
  await client.query(
    "ROLLBACK",
  );

  return fail(
    "Approved Credit Application cannot be deleted.",
    400,
  );
}

    await client.query(
      `
      UPDATE Credit_Application_Entry_Master
      SET
        IsDeleted = TRUE,
        DeletedBy = $1,
        DeletedDate = CURRENT_TIMESTAMP,
        ModifiedBy = $1,
        ModifiedDate = CURRENT_TIMESTAMP
      WHERE CreditApplicationID = $2
        AND IsDeleted = FALSE;
      `,
      [
        UserID,
        CreditApplicationID,
      ],
    );

    await client.query(
      `
      UPDATE Credit_Application_Entry_Master_document
      SET
        IsDeleted = TRUE,
        DeletedBy = $1,
        DeletedDate = CURRENT_TIMESTAMP,
        ModifiedBy = $1,
        ModifiedDate = CURRENT_TIMESTAMP
      WHERE CreditApplicationID = $2
        AND IsDeleted = FALSE;
      `,
      [
        UserID,
        CreditApplicationID,
      ],
    );

    await client.query(
      `
      UPDATE Credit_Application_Approval
      SET
        IsDeleted = TRUE,
        DeletedBy = $1,
        DeletedDate = CURRENT_TIMESTAMP,
        ModifiedBy = $1,
        ModifiedDate = CURRENT_TIMESTAMP
      WHERE CreditApplicationID = $2
        AND IsDeleted = FALSE;
      `,
      [
        UserID,
        CreditApplicationID,
      ],
    );

    await client.query("COMMIT");

    return ok(
      "Credit Application deleted successfully.",
    );

  } catch (error) {
    await client.query("ROLLBACK");

    return databaseFailure(
      error,
      "Delete Credit Application",
    );

  } finally {
    client.release();
  }
};
// ============================================================ CREDIT APPLICATION APPROVAL
const processCreditApplicationApproval = async (data) => {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const {
      CreditApplicationID,
      Action,
      Remarks,

      UserID,
      UserType,
      DepartmentName,
    } = data;


    // ============================================================
    // Validate Credit Application ID
    // ============================================================

    const creditApplicationID =
      Number(
        CreditApplicationID,
      );

    if (
      !Number.isSafeInteger(
        creditApplicationID,
      ) ||
      creditApplicationID <= 0
    ) {
      await client.query("ROLLBACK");

      return fail(
        "Valid CreditApplicationID is required.",
        400,
      );
    }


    // ============================================================
    // Validate Action
    //
    // Only:
    // APPROVE
    // REJECT
    // ============================================================

    const normalizedAction =
      String(
        Action || "",
      )
        .trim()
        .toUpperCase();


    if (
      ![
        "APPROVE",
        "REJECT",
      ].includes(
        normalizedAction,
      )
    ) {
      await client.query("ROLLBACK");

      return fail(
        "Action must be APPROVE or REJECT.",
        400,
      );
    }


    // ============================================================
    // Lock Credit Application Master
    // ============================================================

    const masterResult =
      await client.query(
        `
          SELECT
            ca.CreditApplicationID,
            ca.OrganizationID,

            ca.CompanyName,
            ca.ARID,

            ca.Status,

            ca.ApplicationDate,
            ca.CreditAmountAllowed,
            ca.ExpectedBusinessFY,
            ca.FinancialYear,

            ca.AuthorisedPersonNamePosition,
            ca.AccountsContactNamePosition,

            ca.CreatedBy

          FROM Credit_Application_Entry_Master ca

          WHERE ca.CreditApplicationID = $1
            AND ca.IsDeleted = FALSE

          FOR UPDATE;
        `,
        [
          creditApplicationID,
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
        "Credit Application record not found.",
        404,
      );
    }


    const row =
      masterResult.rows[0];


    const OrganizationID =
      Number(
        row.organizationid,
      );


    // ============================================================
    // Overall Status
    // ============================================================

    const applicationStatus =
      normalizeCreditApprovalStatus(
        row.status,
      );


    if (
      applicationStatus ===
      "APPROVED"
    ) {
      await client.query("ROLLBACK");

      return fail(
        "Credit Application is already fully approved.",
        400,
      );
    }


    if (
      applicationStatus ===
      "REJECTED"
    ) {
      await client.query("ROLLBACK");

      return fail(
        "Rejected Credit Application cannot be approved further.",
        400,
      );
    }


    // ============================================================
    // Lock Saved Approval Snapshot Rows
    //
    // IMPORTANT:
    // approval_master ko yahan dobara query nahi karna.
    //
    // Create ke time jo approval rows save hui hain,
    // wahi actual application approval flow hai.
    // ============================================================

    const approvalResult =
      await client.query(
        `
          SELECT
            CreditApplicationApprovalID,
            CreditApplicationID,

            ApprovalID,

            ApprovalLevel,
            ApprovalRole,
            ApprovalOrder,

            ApproverType,
            ApproverValue,

            Status,
            StatusDateTime,

            ActionBy,
            Remarks

          FROM Credit_Application_Approval

          WHERE CreditApplicationID = $1
            AND IsDeleted = FALSE

          ORDER BY
            ApprovalOrder ASC,
            ApprovalLevel ASC,
            CreditApplicationApprovalID ASC

          FOR UPDATE;
        `,
        [
          creditApplicationID,
        ],
      );


    // ============================================================
    // Approval Flow Not Available
    // ============================================================

    if (
      approvalResult.rows.length === 0
    ) {
      await client.query("ROLLBACK");

      return fail(
        "Credit Application approval flow is not available for this application.",
        400,
      );
    }


    // ============================================================
    // Map Approval Rows
    // ============================================================

    const approvalRows =
      approvalResult.rows.map(
        (approvalRow) => ({
          CreditApplicationApprovalID:
            Number(
              approvalRow
                .creditapplicationapprovalid,
            ),

          ApprovalID:
            approvalRow.approvalid !== null
              ? Number(
                  approvalRow.approvalid,
                )
              : null,

          ApprovalLevel:
            Number(
              approvalRow.approvallevel,
            ),

          LevelNo:
            Number(
              approvalRow.approvallevel,
            ),

          ApprovalOrder:
            Number(
              approvalRow.approvalorder,
            ),

          ApprovalRole:
            normalizeCreditApplicationApprovalRole(
              approvalRow.approvalrole,
            ),

          ApproverType:
            String(
              approvalRow.approvertype ||
                "",
            )
              .trim()
              .toUpperCase(),

          ApproverValue:
            String(
              approvalRow.approvervalue ||
                "",
            ).trim(),

          Status:
            normalizeCreditApprovalStatus(
              approvalRow.status,
            ),

          StatusDateTime:
            approvalRow.statusdatetime ||
            null,

          ActionBy:
            approvalRow.actionby !== null
              ? Number(
                  approvalRow.actionby,
                )
              : null,

          Remarks:
            approvalRow.remarks ||
            null,
        }),
      );


    // ============================================================
    // Defensive Rejected Check
    // ============================================================

    const rejectedStage =
      approvalRows.find(
        (stage) =>
          normalizeCreditApprovalStatus(
            stage.Status,
          ) ===
          "REJECTED",
      );


    if (rejectedStage) {
      await client.query("ROLLBACK");

      return fail(
        "Rejected Credit Application cannot be approved further.",
        400,
      );
    }


    // ============================================================
    // Current Approval Stage
    //
    // First row which is not Approved.
    // ============================================================

    const currentStage =
      approvalRows.find(
        (stage) =>
          normalizeCreditApprovalStatus(
            stage.Status,
          ) !==
          "APPROVED",
      );


    if (!currentStage) {
      await client.query("ROLLBACK");

      return fail(
        "No pending approval stage found.",
        400,
      );
    }


    // ============================================================
    // Current Stage Status
    // ============================================================

    const currentStatus =
      normalizeCreditApprovalStatus(
        currentStage.Status,
      );


    if (
      currentStatus !==
      "PENDING"
    ) {
      await client.query("ROLLBACK");

      return fail(
        `${currentStage.ApprovalRole} approval is already ${currentStatus}.`,
        400,
      );
    }


    // ============================================================
    // Logged-In User Context
    // ============================================================

    const userContext =
      await getCreditApplicationUserContext(
        {
          UserID,
          UserType,
          DepartmentName,
        },
        client,
      );


    // ============================================================
    // Current Approval Assignment
    //
    // USER
    // -> selected UserID / Username
    //
    // REGIONAL
    // -> selected Regional UserID / Username
    //
    // ROLE
    // -> UserType / DepartmentName
    //
    // FC
    // -> Finance Department compulsory
    // ============================================================

    const isCurrentUserApprover =
      isCreditApplicationApprovalStepAssignedToUser(
        currentStage,
        userContext,
      );


    if (
      !isCurrentUserApprover
    ) {
      await client.query("ROLLBACK");

      return fail(
        `Credit Application is currently pending for ${currentStage.ApprovalRole} approval and is not assigned to the logged-in user.`,
        403,
      );
    }


    // ============================================================
    // Notification
    //
    // Existing notification behavior same.
    // ============================================================

    let committedNotificationEvent =
      null;


    const notificationDetails = {
      applicationDate:
        row.applicationdate,

      creditAmountAllowed:
        row.creditamountallowed,

      expectedBusinessFY:
        row.expectedbusinessfy,

      financialYear:
        row.financialyear,

      authorisedPerson:
        row.authorisedpersonnameposition,

      accountsContact:
        row.accountscontactnameposition,
    };


    // ============================================================
    // REJECT
    // ============================================================

    if (
      normalizedAction ===
      "REJECT"
    ) {
      // ==========================================================
      // Reject Current Approval Row
      // ==========================================================

      await client.query(
        `
          UPDATE Credit_Application_Approval

          SET
            Status = 'Rejected',
            StatusDateTime = CURRENT_TIMESTAMP,

            ActionBy = $1,
            Remarks = $2,

            ModifiedBy = $1,
            ModifiedDate = CURRENT_TIMESTAMP

          WHERE CreditApplicationApprovalID = $3
            AND CreditApplicationID = $4
            AND IsDeleted = FALSE;
        `,
        [
          UserID,
          Remarks || null,
          currentStage
            .CreditApplicationApprovalID,
          creditApplicationID,
        ],
      );


      // ==========================================================
      // Master Rejected
      // ==========================================================

      await client.query(
        `
          UPDATE Credit_Application_Entry_Master

          SET
            Status = 'REJECTED',

            ModifiedBy = $1,
            ModifiedDate = CURRENT_TIMESTAMP

          WHERE CreditApplicationID = $2
            AND IsDeleted = FALSE;
        `,
        [
          UserID,
          creditApplicationID,
        ],
      );


      // ==========================================================
      // Existing GM Reject Notification
      // ==========================================================

      if (
        currentStage.ApprovalRole ===
        "GM"
      ) {
        committedNotificationEvent = {
          organizationID:
            OrganizationID,

          creditApplicationID:
            creditApplicationID,

          companyName:
            row.companyname,

          roles: [
            "FC",
          ],

          excludeUserIds: [
            UserID,
            row.createdby,
          ],

          kind:
            "GM_REJECT",

          action:
            "REJECTED",

          details:
            notificationDetails,
        };
      }
    }


    // ============================================================
    // APPROVE
    // ============================================================

    else if (
      normalizedAction ===
      "APPROVE"
    ) {
      // ==========================================================
      // Approve Current Approval Row
      // ==========================================================

      await client.query(
        `
          UPDATE Credit_Application_Approval

          SET
            Status = 'Approved',
            StatusDateTime = CURRENT_TIMESTAMP,

            ActionBy = $1,
            Remarks = $2,

            ModifiedBy = $1,
            ModifiedDate = CURRENT_TIMESTAMP

          WHERE CreditApplicationApprovalID = $3
            AND CreditApplicationID = $4
            AND IsDeleted = FALSE;
        `,
        [
          UserID,
          Remarks || null,
          currentStage
            .CreditApplicationApprovalID,
          creditApplicationID,
        ],
      );


      // ==========================================================
      // Current Row In-Memory Approved
      // ==========================================================

      currentStage.Status =
        "APPROVED";


      // ==========================================================
      // Find Next Stage
      // ==========================================================

      const nextStage =
        approvalRows.find(
          (stage) =>
            normalizeCreditApprovalStatus(
              stage.Status,
            ) !==
            "APPROVED",
        );


      // ==========================================================
      // No Next Stage
      //
      // Fully Approved
      // ==========================================================

      if (!nextStage) {
        await client.query(
          `
            UPDATE Credit_Application_Entry_Master

            SET
              Status = 'APPROVED',

              ModifiedBy = $1,
              ModifiedDate = CURRENT_TIMESTAMP

            WHERE CreditApplicationID = $2
              AND IsDeleted = FALSE;
          `,
          [
            UserID,
            creditApplicationID,
          ],
        );
      }


      // ==========================================================
      // Next Stage Available
      //
      // Overall application PENDING rahegi.
      // ==========================================================

      else {
        await client.query(
          `
            UPDATE Credit_Application_Entry_Master

            SET
              Status = 'PENDING',

              ModifiedBy = $1,
              ModifiedDate = CURRENT_TIMESTAMP

            WHERE CreditApplicationID = $2
              AND IsDeleted = FALSE;
          `,
          [
            UserID,
            creditApplicationID,
          ],
        );
      }


      // ==========================================================
      // Existing Notification Logic
      // ==========================================================

      if (
        currentStage.ApprovalRole ===
          "FC" &&
        nextStage
      ) {
        committedNotificationEvent = {
          organizationID:
            OrganizationID,

          creditApplicationID:
            creditApplicationID,

          companyName:
            row.companyname,

          roles: [
            nextStage.ApprovalRole,
          ],

          excludeUserIds: [
            UserID,
            row.createdby,
          ],

          kind:
            "FC_APPROVE",

          action:
            "APPROVED",

          details:
            notificationDetails,
        };
      }


      else if (
        currentStage.ApprovalRole ===
          "GM" &&
        !nextStage
      ) {
        committedNotificationEvent = {
          organizationID:
            OrganizationID,

          creditApplicationID:
            creditApplicationID,

          companyName:
            row.companyname,

          roles: [
            "FC",
          ],

          excludeUserIds: [
            UserID,
            row.createdby,
          ],

          kind:
            "GM_APPROVE",

          action:
            "APPROVED",

          details:
            notificationDetails,
        };
      }
    }


    // ============================================================
    // Commit
    // ============================================================

    await client.query(
      "COMMIT",
    );


    // ============================================================
    // Notification
    // ============================================================

    if (
      committedNotificationEvent
    ) {
      dispatchCommittedCreditApplicationEvent(
        committedNotificationEvent,
      );
    }


    // ============================================================
    // Response
    // ============================================================

    const responseStatus =
      normalizedAction ===
      "APPROVE"
        ? "approved"
        : "rejected";


    return ok(
      `Credit Application ${responseStatus} successfully.`,
    );

  } catch (error) {
    await client.query(
      "ROLLBACK",
    );

    return databaseFailure(
      error,
      "Process Credit Application approval",
    );

  } finally {
    client.release();
  }
};
// ============================================================UPDATE AR ID
const updateCreditApplicationARID = async (data) => {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const {
      CreditApplicationID,
      ARID,

      UserID,
      UserType,
      DepartmentName,
    } = data;


    // ============================================================
    // Validate Credit Application ID
    // ============================================================

    const creditApplicationID =
      Number(
        CreditApplicationID,
      );

    if (
      !Number.isSafeInteger(
        creditApplicationID,
      ) ||
      creditApplicationID <= 0
    ) {
      await client.query("ROLLBACK");

      return fail(
        "Valid CreditApplicationID is required.",
        400,
      );
    }


    // ============================================================
    // Validate AR ID
    // ============================================================

    const arID =
      String(
        ARID || "",
      ).trim();

    if (!arID) {
      await client.query("ROLLBACK");

      return fail(
        "AR ID is required.",
        400,
      );
    }


    // ============================================================
    // Lock Credit Application Master
    // ============================================================

    const masterResult =
      await client.query(
        `
          SELECT
            CreditApplicationID,
            OrganizationID,
            ARID,
            Status

          FROM Credit_Application_Entry_Master

          WHERE CreditApplicationID = $1
            AND IsDeleted = FALSE

          FOR UPDATE;
        `,
        [
          creditApplicationID,
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
        "Credit Application record not found.",
        404,
      );
    }


    const row =
      masterResult.rows[0];


    // ============================================================
    // AR ID Already Added
    // ============================================================

    if (
      String(
        row.arid || "",
      ).trim() !== ""
    ) {
      await client.query("ROLLBACK");

      return fail(
        "AR ID has already been added for this Credit Application.",
        400,
      );
    }


    // ============================================================
    // Master Must Be Approved
    // ============================================================

    const applicationStatus =
      normalizeCreditApprovalStatus(
        row.status,
      );


    if (
      applicationStatus !==
      "APPROVED"
    ) {
      await client.query("ROLLBACK");

      return fail(
        "Credit Application must be fully approved before updating AR ID.",
        400,
      );
    }


    // ============================================================
    // Lock Saved Approval Snapshot
    //
    // Live approval_master flow use nahi karna.
    // ============================================================

    const approvalResult =
      await client.query(
        `
          SELECT
            CreditApplicationApprovalID,

            ApprovalID,

            ApprovalLevel,
            ApprovalRole,
            ApprovalOrder,

            ApproverType,
            ApproverValue,

            Status,
            StatusDateTime,

            ActionBy,
            Remarks

          FROM Credit_Application_Approval

          WHERE CreditApplicationID = $1
            AND IsDeleted = FALSE

          ORDER BY
            ApprovalOrder ASC,
            ApprovalLevel ASC,
            CreditApplicationApprovalID ASC

          FOR UPDATE;
        `,
        [
          creditApplicationID,
        ],
      );


    // ============================================================
    // Approval Rows Required
    // ============================================================

    if (
      approvalResult.rows.length === 0
    ) {
      await client.query("ROLLBACK");

      return fail(
        "Credit Application approval flow is not available for this application.",
        400,
      );
    }


    // ============================================================
    // Map Approval Rows
    // ============================================================

    const approvalRows =
      approvalResult.rows.map(
        (approvalRow) => ({
          CreditApplicationApprovalID:
            Number(
              approvalRow
                .creditapplicationapprovalid,
            ),

          ApprovalID:
            approvalRow.approvalid !== null
              ? Number(
                  approvalRow.approvalid,
                )
              : null,

          ApprovalLevel:
            Number(
              approvalRow.approvallevel,
            ),

          LevelNo:
            Number(
              approvalRow.approvallevel,
            ),

          ApprovalOrder:
            Number(
              approvalRow.approvalorder,
            ),

          ApprovalRole:
            normalizeCreditApplicationApprovalRole(
              approvalRow.approvalrole,
            ),

          ApproverType:
            String(
              approvalRow.approvertype ||
                "",
            )
              .trim()
              .toUpperCase(),

          ApproverValue:
            String(
              approvalRow.approvervalue ||
                "",
            ).trim(),

          Status:
            normalizeCreditApprovalStatus(
              approvalRow.status,
            ),

          StatusDateTime:
            approvalRow.statusdatetime ||
            null,

          ActionBy:
            approvalRow.actionby !== null
              ? Number(
                  approvalRow.actionby,
                )
              : null,

          Remarks:
            approvalRow.remarks ||
            null,
        }),
      );


    // ============================================================
    // Every Approval Must Be Approved
    // ============================================================

    const pendingApproval =
      approvalRows.find(
        (stage) =>
          normalizeCreditApprovalStatus(
            stage.Status,
          ) !==
          "APPROVED",
      );


    if (pendingApproval) {
      await client.query("ROLLBACK");

      return fail(
        `${pendingApproval.ApprovalRole} approval is ${normalizeCreditApprovalStatus(
          pendingApproval.Status,
        )}. AR ID can be added only after all approvals are completed.`,
        400,
      );
    }


    // ============================================================
    // FC Approval Step Required
    //
    // AR ID sirf exact FC approver update karega.
    // RD-FC / Regional ko permission nahi milegi.
    // ============================================================

    const fcStage =
      approvalRows.find(
        (stage) =>
          normalizeCreditApplicationApprovalRole(
            stage.ApprovalRole,
          ) ===
          "FC",
      );


    if (!fcStage) {
      await client.query("ROLLBACK");

      return fail(
        "FC approval step is not available for this Credit Application.",
        400,
      );
    }


    // ============================================================
    // FC Approval Must Already Be Approved
    // ============================================================

    if (
      normalizeCreditApprovalStatus(
        fcStage.Status,
      ) !==
      "APPROVED"
    ) {
      await client.query("ROLLBACK");

      return fail(
        "FC approval must be completed before updating AR ID.",
        400,
      );
    }


    // ============================================================
    // Logged-In User Context
    // ============================================================

    const userContext =
      await getCreditApplicationUserContext(
        {
          UserID,
          UserType,
          DepartmentName,
        },
        client,
      );


    // ============================================================
    // Logged-In User Must Be Configured FC Approver
    //
    // Helper already ensures:
    // ApprovalRole FC -> Department FINANCE compulsory
    // ============================================================

    const isConfiguredFCApprover =
      isCreditApplicationApprovalStepAssignedToUser(
        fcStage,
        userContext,
      );


    if (
      !isConfiguredFCApprover
    ) {
      await client.query("ROLLBACK");

      return fail(
        "You are not authorized to update AR ID for this Credit Application.",
        403,
      );
    }


    // ============================================================
    // Update AR ID
    // ============================================================

    const updateResult =
      await client.query(
        `
          UPDATE Credit_Application_Entry_Master

          SET
            ARID = $1,

            ModifiedBy = $2,
            ModifiedDate = CURRENT_TIMESTAMP

          WHERE CreditApplicationID = $3
            AND IsDeleted = FALSE

          RETURNING
            CreditApplicationID,
            ARID;
        `,
        [
          arID,
          UserID,
          creditApplicationID,
        ],
      );


    // ============================================================
    // Safety Check
    // ============================================================

    if (
      updateResult.rows.length === 0
    ) {
      await client.query("ROLLBACK");

      return fail(
        "Unable to update AR ID.",
        400,
      );
    }


    // ============================================================
    // Commit
    // ============================================================

    await client.query(
      "COMMIT",
    );


    // ============================================================
    // Response
    // ============================================================

    return ok(
      "AR ID updated successfully.",
      {
        CreditApplicationID:
          Number(
            updateResult.rows[0]
              .creditapplicationid,
          ),

        ARID:
          updateResult.rows[0]
            .arid,
      },
    );

  } catch (error) {
    await client.query(
      "ROLLBACK",
    );

    return databaseFailure(
      error,
      "Update Credit Application AR ID",
    );

  } finally {
    client.release();
  }
};
// ============================================================================================This Approval Config in not in Current Use
// ============================================================ Create Approval Config
const createCreditApplicationApprovalConfig = async (data) => {
  let client;
  let transactionStarted = false;

  try {
    const OrganizationID =
      Number(
        data.OrganizationID,
      );

    const approvals =
      Array.isArray(
        data.Approvals,
      )
        ? data.Approvals
        : [];

    // ============================================================
    // VALIDATION
    // ============================================================

    if (
      !Number.isInteger(
        OrganizationID,
      ) ||
      OrganizationID <= 0
    ) {
      return fail(
        "OrganizationID is required.",
        400,
      );
    }

    if (
      approvals.length === 0
    ) {
      return fail(
        "At least one approval configuration is required.",
        400,
      );
    }

    // ============================================================
    // NORMALIZE
    // ============================================================

    const normalizedApprovals =
      approvals.map(
        (approval) => ({
          ApprovalLevel:
            Number(
              approval.ApprovalLevel,
            ),

          ApprovalRole:
            normalizeCreditApplicationApprovalRole(
              approval.ApprovalRole,
            ),

          ApprovalOrder:
            Number(
              approval.ApprovalOrder,
            ),

          // Backend se automatic TRUE
          IsMandatory: true,
        }),
      );

    // ============================================================
    // DUPLICATE + ROLE VALIDATION
    // ============================================================

    const levels =
      new Set();

    const roles =
      new Set();

    const orders =
      new Set();

    for (
      const approval of
      normalizedApprovals
    ) {
      const {
        ApprovalLevel,
        ApprovalRole,
        ApprovalOrder,
      } = approval;

      if (
        !Number.isInteger(
          ApprovalLevel,
        ) ||
        ApprovalLevel < 1
      ) {
        return fail(
          "ApprovalLevel must be a positive integer.",
          400,
        );
      }

      if (
        !Number.isInteger(
          ApprovalOrder,
        ) ||
        ApprovalOrder < 1
      ) {
        return fail(
          "ApprovalOrder must be a positive integer.",
          400,
        );
      }

      if (
        !CREDIT_APPLICATION_APPROVAL_ROLES.has(
          ApprovalRole,
        )
      ) {
        return fail(
          "ApprovalRole must be FC or GM.",
          400,
        );
      }

      if (
        levels.has(
          ApprovalLevel,
        )
      ) {
        return fail(
          `Approval level ${ApprovalLevel} is duplicated in request.`,
          409,
        );
      }

      if (
        roles.has(
          ApprovalRole,
        )
      ) {
        return fail(
          `${ApprovalRole} approval stage is duplicated in request.`,
          409,
        );
      }

      if (
        orders.has(
          ApprovalOrder,
        )
      ) {
        return fail(
          `Approval order ${ApprovalOrder} is duplicated in request.`,
          409,
        );
      }

      levels.add(
        ApprovalLevel,
      );

      roles.add(
        ApprovalRole,
      );

      orders.add(
        ApprovalOrder,
      );
    }

    // ============================================================
    // TRANSACTION
    // ============================================================

    client =
      await pool.connect();

    await client.query(
      "BEGIN",
    );

    transactionStarted =
      true;

    // ============================================================
    // GET EXISTING CONFIG
    // Active + Soft Deleted
    // ============================================================

    const existingResult =
      await client.query(
        `
        SELECT
          CreditApplicationApprovalConfigID
            AS "CreditApplicationApprovalConfigID",

          OrganizationID
            AS "OrganizationID",

          ApprovalLevel
            AS "ApprovalLevel",

          ApprovalRole
            AS "ApprovalRole",

          ApprovalOrder
            AS "ApprovalOrder",

          IsMandatory
            AS "IsMandatory",

          IsDeleted
            AS "IsDeleted"

        FROM Credit_Application_Approval_Config

        WHERE OrganizationID = $1

        ORDER BY
          ApprovalLevel ASC,
          CreditApplicationApprovalConfigID ASC

        FOR UPDATE;
        `,
        [
          OrganizationID,
        ],
      );

    const existingConfigs =
      existingResult.rows;

    // ============================================================
    // MAP EXISTING CONFIG BY LEVEL
    // ============================================================

    const existingByLevel =
      new Map();

    for (
      const row of
      existingConfigs
    ) {
      existingByLevel.set(
        Number(
          row.ApprovalLevel,
        ),
        row,
      );
    }

    const processedLevels =
      new Set();

    // ============================================================
    // INSERT / UPDATE / RESTORE
    // ============================================================

    for (
      const approval of
      normalizedApprovals
    ) {
      const {
        ApprovalLevel,
        ApprovalRole,
        ApprovalOrder,
        IsMandatory,
      } = approval;

      const existing =
        existingByLevel.get(
          ApprovalLevel,
        );

      // ==========================================================
      // EXISTING RECORD
      // ==========================================================

      if (existing) {
        const ConfigID =
          Number(
            existing
              .CreditApplicationApprovalConfigID,
          );

        if (
          !Number.isInteger(
            ConfigID,
          )
        ) {
          throw new Error(
            `Invalid CreditApplicationApprovalConfigID: ${existing.CreditApplicationApprovalConfigID}`,
          );
        }

        // ========================================================
        // RESTORE SOFT DELETED
        // ========================================================

        if (
          existing.IsDeleted ===
          true
        ) {
          await client.query(
            `
            UPDATE Credit_Application_Approval_Config

            SET
              ApprovalRole = $1,
              ApprovalOrder = $2,
              IsMandatory = $3,

              IsDeleted = FALSE,

              ModifiedBy = $4,
              ModifiedDate =
                CURRENT_TIMESTAMP,

              DeletedBy = NULL,
              DeletedDate = NULL

            WHERE
              CreditApplicationApprovalConfigID = $5

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
        }

        // ========================================================
        // NORMAL UPDATE
        // ========================================================

        else {
          await client.query(
            `
            UPDATE Credit_Application_Approval_Config

            SET
              ApprovalRole = $1,
              ApprovalOrder = $2,
              IsMandatory = $3,

              ModifiedBy = $4,
              ModifiedDate =
                CURRENT_TIMESTAMP

            WHERE
              CreditApplicationApprovalConfigID = $5

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
        }
      }

      // ==========================================================
      // NEW INSERT
      // ==========================================================

      else {
        await client.query(
          `
          INSERT INTO Credit_Application_Approval_Config
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
            TRUE,

            FALSE,

            $5,
            CURRENT_TIMESTAMP
          );
          `,
          [
            OrganizationID,
            ApprovalLevel,
            ApprovalRole,
            ApprovalOrder,
            data.UserID,
          ],
        );
      }

      processedLevels.add(
        ApprovalLevel,
      );
    }

    // ============================================================
    // SOFT DELETE
    //
    // DB me active hai
    // lekin new request me nahi hai
    // ============================================================

    for (
      const existing of
      existingConfigs
    ) {
      const level =
        Number(
          existing.ApprovalLevel,
        );

      if (
        existing.IsDeleted ===
          false &&
        !processedLevels.has(
          level,
        )
      ) {
        const ConfigID =
          Number(
            existing
              .CreditApplicationApprovalConfigID,
          );

        if (
          !Number.isInteger(
            ConfigID,
          )
        ) {
          throw new Error(
            `Invalid CreditApplicationApprovalConfigID: ${existing.CreditApplicationApprovalConfigID}`,
          );
        }

        await client.query(
          `
          UPDATE Credit_Application_Approval_Config

          SET
            IsDeleted = TRUE,

            DeletedBy = $1,
            DeletedDate =
              CURRENT_TIMESTAMP,

            ModifiedBy = $1,
            ModifiedDate =
              CURRENT_TIMESTAMP

          WHERE
            CreditApplicationApprovalConfigID = $2

            AND OrganizationID = $3

            AND IsDeleted = FALSE;
          `,
          [
            data.UserID,
            ConfigID,
            OrganizationID,
          ],
        );
      }
    }

    // ============================================================
    // COMMIT
    // ============================================================

    await client.query(
      "COMMIT",
    );

    transactionStarted =
      false;

    return ok(
      "Credit Application approval configuration saved successfully.",
    );

  } catch (error) {
    if (
      client &&
      transactionStarted
    ) {
      await client.query(
        "ROLLBACK",
      );
    }

    console.error(
      "Save Credit Application Approval Config Error:",
      error.message,
    );

    const retryResponse =
      retryableDatabaseResponse(
        error,
      );

    if (retryResponse) {
      return retryResponse;
    }

    if (
      error.code === "23505"
    ) {
      return fail(
        "Credit Application approval configuration already exists.",
        409,
      );
    }

    if (
      error.code === "23503"
    ) {
      return fail(
        "Invalid organization or user.",
        400,
      );
    }

    return fail(
      "Unable to save Credit Application approval configuration at this time.",
      500,
    );

  } finally {
    if (client) {
      client.release();
    }
  }
};
// ============================================================ Approval Config List
const getCreditApplicationApprovalConfigList = async (data) => {
  try {
    const OrganizationID =
      Number(
        data.OrganizationID,
      );

    if (
      !Number.isSafeInteger(
        OrganizationID,
      ) ||
      OrganizationID <= 0
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
          CreditApplicationApprovalConfigID,
          ApprovalLevel,
          ApprovalRole,
          ApprovalOrder,
          IsMandatory,
          CreatedDate

        FROM Credit_Application_Approval_Config

        WHERE OrganizationID = $1
          AND IsDeleted = FALSE

        ORDER BY
          ApprovalOrder ASC,
          ApprovalLevel ASC;
        `,
        [
          OrganizationID,
        ],
      );

    const CreatedDate =
      result.rows.length > 0
        ? formatDate(
            result.rows[0]
              .createddate,
          )
        : null;

    const approvals =
      result.rows.map(
        (row) => ({
          CreditApplicationApprovalConfigID:
            Number(
              row.creditapplicationapprovalconfigid,
            ),

          ApprovalLevel:
            Number(
              row.approvallevel,
            ),

          ApprovalRole:
            normalizeCreditApplicationApprovalRole(
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
      "Credit Application approval config fetched successfully.",
      {
        OrganizationID,

        CreatedDate,

        Count:
          approvals.length,

        data:
          approvals,
      },
    );

  } catch (error) {
    return databaseFailure(
      error,
      "Fetch Credit Application approval config",
    );
  }
};
// ============================================================Delete Approval Config
const deleteCreditApplicationApprovalConfig = async (data) => {
  try {
    const CreditApplicationApprovalConfigID =
      Number(
        data.CreditApplicationApprovalConfigID,
      );

    const UserID =
      Number(
        data.UserID,
      );

    if (
      !Number.isSafeInteger(
        CreditApplicationApprovalConfigID,
      ) ||
      CreditApplicationApprovalConfigID <= 0
    ) {
      return fail(
        "Valid CreditApplicationApprovalConfigID is required.",
        400,
      );
    }

    const result =
      await pool.query(
        `
        UPDATE Credit_Application_Approval_Config

        SET
          IsDeleted = TRUE,

          DeletedBy = $1,
          DeletedDate =
            CURRENT_TIMESTAMP,

          ModifiedBy = $1,
          ModifiedDate =
            CURRENT_TIMESTAMP

        WHERE
          CreditApplicationApprovalConfigID = $2

          AND IsDeleted = FALSE

        RETURNING
          CreditApplicationApprovalConfigID;
        `,
        [
          UserID,
          CreditApplicationApprovalConfigID,
        ],
      );

    if (
      result.rows.length === 0
    ) {
      return fail(
        "Credit Application approval config not found.",
        404,
      );
    }

    return ok(
      "Credit Application approval config deleted successfully.",
      {
        CreditApplicationApprovalConfigID,
      },
    );

  } catch (error) {
    const retryResponse =
      retryableDatabaseResponse(
        error,
      );

    if (retryResponse) {
      return retryResponse;
    }

    return databaseFailure(
      error,
      "Delete Credit Application approval config",
    );
  }
};
// ============================================================================================

// ========================================================================Reports
// ============================================================COMPANY WISE REPORT
const getCompanyWiseReport = async (data) => {
  try {
    // ============================================================
    // Organization
    // ============================================================

    const OrganizationID =
      Number(
        data.OrganizationID,
      );

    if (
      !Number.isSafeInteger(
        OrganizationID,
      ) ||
      OrganizationID <= 0
    ) {
      return fail(
        "Valid OrganizationID is required.",
        400,
      );
    }


    // ============================================================
    // Pagination
    // ============================================================

    const page =
      Number(data.page) || 1;

    const PageSize =
      Number(data.PageSize) || 10;

    if (
      !Number.isInteger(page) ||
      page <= 0
    ) {
      return fail(
        "page must be a positive integer.",
        400,
      );
    }

    if (
      !Number.isInteger(PageSize) ||
      PageSize <= 0 ||
      PageSize > 100
    ) {
      return fail(
        "PageSize must be between 1 and 100.",
        400,
      );
    }

    const offset =
      (page - 1) * PageSize;


    // ============================================================
    // Filters
    // ============================================================

    const CompanyName =
      data.CompanyName !== undefined &&
      data.CompanyName !== null &&
      String(
        data.CompanyName,
      ).trim() !== ""
        ? String(
            data.CompanyName,
          ).trim()
        : null;


    const FromDate =
      data.FromDate !== undefined &&
      data.FromDate !== null &&
      String(
        data.FromDate,
      ).trim() !== ""
        ? String(
            data.FromDate,
          ).trim()
        : null;


    const ToDate =
      data.ToDate !== undefined &&
      data.ToDate !== null &&
      String(
        data.ToDate,
      ).trim() !== ""
        ? String(
            data.ToDate,
          ).trim()
        : null;


    // ============================================================
    // Date Validation
    // ============================================================

    const dateFormat =
      /^\d{4}-\d{2}-\d{2}$/;


    if (
      FromDate &&
      !dateFormat.test(
        FromDate,
      )
    ) {
      return fail(
        "FromDate must be in YYYY-MM-DD format.",
        400,
      );
    }


    if (
      ToDate &&
      !dateFormat.test(
        ToDate,
      )
    ) {
      return fail(
        "ToDate must be in YYYY-MM-DD format.",
        400,
      );
    }


    if (
      FromDate &&
      ToDate &&
      FromDate > ToDate
    ) {
      return fail(
        "FromDate cannot be greater than ToDate.",
        400,
      );
    }


    // ============================================================
    // WHERE
    // ============================================================

    let whereClause = `
      WHERE ca.IsDeleted = FALSE
        AND ca.OrganizationID = $1
    `;

    const params = [
      OrganizationID,
    ];


    // ============================================================
    // Company Filter
    // ============================================================

    if (CompanyName) {
      params.push(
        CompanyName,
      );

      whereClause += `
        AND COALESCE(
          ca.CompanyName,
          ''
        ) ILIKE
          '%' || $${params.length} || '%'
      `;
    }


    // ============================================================
    // From Date
    // ============================================================

    if (FromDate) {
      params.push(
        FromDate,
      );

      whereClause += `
        AND ca.ApplicationDate >=
            $${params.length}::date
      `;
    }


    // ============================================================
    // To Date
    // ============================================================

    if (ToDate) {
      params.push(
        ToDate,
      );

      whereClause += `
        AND ca.ApplicationDate <=
            $${params.length}::date
      `;
    }


    // ============================================================
    // Count Companies
    // ============================================================

    const countResult =
      await pool.query(
        `
          SELECT
            COUNT(*)::bigint
              AS TotalCount

          FROM
          (
            SELECT
              UPPER(
                TRIM(
                  ca.CompanyName
                )
              )

            FROM Credit_Application_Entry_Master ca

            ${whereClause}

            GROUP BY
              UPPER(
                TRIM(
                  ca.CompanyName
                )
              )

          ) company_group;
        `,
        params,
      );


    const TotalCount =
      Number(
        countResult.rows[0]
          ?.totalcount || 0,
      );


    // ============================================================
    // Pagination Params
    // ============================================================

    const listParams = [
      ...params,
      PageSize,
      offset,
    ];

    const limitIndex =
      params.length + 1;

    const offsetIndex =
      params.length + 2;


    // ============================================================
    // Report
    //
    // IMPORTANT:
    // Overall status now comes from ca.Status.
    //
    // Approval table join is not required.
    // ============================================================

    const result =
      await pool.query(
        `
          SELECT
            MIN(
              TRIM(
                ca.CompanyName
              )
            ) AS CompanyName,


            COUNT(
              ca.CreditApplicationID
            )::bigint
              AS TotalApplications,


            COALESCE(
              SUM(
                ca.CreditAmountAllowed
              ),
              0
            )
              AS TotalCreditAmount,


            COALESCE(
              SUM(
                ca.ExpectedBusinessFY
              ),
              0
            )
              AS TotalExpectedBusinessFY,


            -- ======================================================
            -- Pending
            -- ======================================================

            COUNT(*) FILTER
            (
              WHERE UPPER(
                TRIM(
                  COALESCE(
                    ca.Status,
                    'PENDING'
                  )
                )
              ) = 'PENDING'
            )::bigint
              AS PendingCount,


            -- ======================================================
            -- Approved
            -- ======================================================

            COUNT(*) FILTER
            (
              WHERE UPPER(
                TRIM(
                  COALESCE(
                    ca.Status,
                    ''
                  )
                )
              ) = 'APPROVED'
            )::bigint
              AS ApprovedCount,


            -- ======================================================
            -- Rejected
            -- ======================================================

            COUNT(*) FILTER
            (
              WHERE UPPER(
                TRIM(
                  COALESCE(
                    ca.Status,
                    ''
                  )
                )
              ) = 'REJECTED'
            )::bigint
              AS RejectedCount,


            -- ======================================================
            -- AR Created
            -- ======================================================

            COUNT(*) FILTER
            (
              WHERE NULLIF(
                TRIM(
                  COALESCE(
                    ca.ARID,
                    ''
                  )
                ),
                ''
              ) IS NOT NULL
            )::bigint
              AS ARCreatedCount,


            -- ======================================================
            -- AR Pending
            //
            // Application approved hai
            // but ARID abhi blank hai.
            // ======================================================

            COUNT(*) FILTER
            (
              WHERE UPPER(
                TRIM(
                  COALESCE(
                    ca.Status,
                    ''
                  )
                )
              ) = 'APPROVED'

              AND NULLIF(
                TRIM(
                  COALESCE(
                    ca.ARID,
                    ''
                  )
                ),
                ''
              ) IS NULL
            )::bigint
              AS ARPendingCount


          FROM Credit_Application_Entry_Master ca

          ${whereClause}

          GROUP BY
            UPPER(
              TRIM(
                ca.CompanyName
              )
            )

          ORDER BY
            CompanyName ASC

          LIMIT $${limitIndex}
          OFFSET $${offsetIndex};
        `,
        listParams,
      );


    // ============================================================
    // Mapping
    // ============================================================

    const records =
      result.rows.map(
        (row) => ({
          CompanyName:
            row.companyname,

          TotalApplications:
            Number(
              row.totalapplications,
            ),

          TotalCreditAmount:
            Number(
              row.totalcreditamount,
            ),

          TotalExpectedBusinessFY:
            Number(
              row.totalexpectedbusinessfy,
            ),

          PendingCount:
            Number(
              row.pendingcount,
            ),

          ApprovedCount:
            Number(
              row.approvedcount,
            ),

          RejectedCount:
            Number(
              row.rejectedcount,
            ),

          ARCreatedCount:
            Number(
              row.arcreatedcount,
            ),

          ARPendingCount:
            Number(
              row.arpendingcount,
            ),
        }),
      );


    // ============================================================
    // Pagination
    // ============================================================

    const TotalPages =
      TotalCount > 0
        ? Math.ceil(
            TotalCount /
              PageSize,
          )
        : 0;


    // ============================================================
    // Response
    // ============================================================

    return ok(
      "Company-wise Credit Application report fetched successfully.",
      {
        TotalCount,

        PageCount:
          records.length,

        CurrentPage:
          page,

        PageSize,

        TotalPages,

        data:
          records,
      },
    );

  } catch (error) {
    return databaseFailure(
      error,
      "Fetch company-wise Credit Application report",
    );
  }
};
// ============================================================ORGANIZATION WISE REPORT
const getOrganizationWiseReport = async (data) => {
  try {
    // ============================================================
    // Organization
    // Optional
    // ============================================================

    const OrganizationID =
      data.OrganizationID !== undefined &&
      data.OrganizationID !== null &&
      String(
        data.OrganizationID,
      ).trim() !== ""
        ? Number(
            data.OrganizationID,
          )
        : null;


    if (
      OrganizationID !== null &&
      (
        !Number.isSafeInteger(
          OrganizationID,
        ) ||
        OrganizationID <= 0
      )
    ) {
      return fail(
        "Valid OrganizationID is required.",
        400,
      );
    }


    // ============================================================
    // Pagination
    // ============================================================

    const page =
      Number(data.page) || 1;

    const PageSize =
      Number(data.PageSize) || 10;


    if (
      !Number.isInteger(page) ||
      page <= 0
    ) {
      return fail(
        "page must be a positive integer.",
        400,
      );
    }


    if (
      !Number.isInteger(PageSize) ||
      PageSize <= 0 ||
      PageSize > 100
    ) {
      return fail(
        "PageSize must be between 1 and 100.",
        400,
      );
    }


    const offset =
      (page - 1) * PageSize;


    // ============================================================
    // Dates
    // ============================================================

    const FromDate =
      data.FromDate !== undefined &&
      data.FromDate !== null &&
      String(
        data.FromDate,
      ).trim() !== ""
        ? String(
            data.FromDate,
          ).trim()
        : null;


    const ToDate =
      data.ToDate !== undefined &&
      data.ToDate !== null &&
      String(
        data.ToDate,
      ).trim() !== ""
        ? String(
            data.ToDate,
          ).trim()
        : null;


    const dateFormat =
      /^\d{4}-\d{2}-\d{2}$/;


    if (
      FromDate &&
      !dateFormat.test(
        FromDate,
      )
    ) {
      return fail(
        "FromDate must be in YYYY-MM-DD format.",
        400,
      );
    }


    if (
      ToDate &&
      !dateFormat.test(
        ToDate,
      )
    ) {
      return fail(
        "ToDate must be in YYYY-MM-DD format.",
        400,
      );
    }


    if (
      FromDate &&
      ToDate &&
      FromDate > ToDate
    ) {
      return fail(
        "FromDate cannot be greater than ToDate.",
        400,
      );
    }


    // ============================================================
    // WHERE
    // ============================================================

    let whereClause = `
      WHERE ca.IsDeleted = FALSE
    `;

    const params = [];


    // ============================================================
    // Organization Filter
    // ============================================================

    if (
      OrganizationID !== null
    ) {
      params.push(
        OrganizationID,
      );

      whereClause += `
        AND ca.OrganizationID =
            $${params.length}
      `;
    }


    // ============================================================
    // From Date
    // ============================================================

    if (FromDate) {
      params.push(
        FromDate,
      );

      whereClause += `
        AND ca.ApplicationDate >=
            $${params.length}::date
      `;
    }


    // ============================================================
    // To Date
    // ============================================================

    if (ToDate) {
      params.push(
        ToDate,
      );

      whereClause += `
        AND ca.ApplicationDate <=
            $${params.length}::date
      `;
    }


    // ============================================================
    // Count Organizations
    // ============================================================

    const countResult =
      await pool.query(
        `
          SELECT
            COUNT(
              DISTINCT ca.OrganizationID
            )::bigint
              AS TotalCount

          FROM Credit_Application_Entry_Master ca

          ${whereClause};
        `,
        params,
      );


    const TotalCount =
      Number(
        countResult.rows[0]
          ?.totalcount || 0,
      );


    // ============================================================
    // Pagination Params
    // ============================================================

    const listParams = [
      ...params,
      PageSize,
      offset,
    ];

    const limitIndex =
      params.length + 1;

    const offsetIndex =
      params.length + 2;


    // ============================================================
    // Organization Wise Report
    //
    // Master Status is source of truth.
    // ============================================================

    const result =
      await pool.query(
        `
          SELECT
            ca.OrganizationID,

            om.OrganizationName,

            om.ShortName
              AS OrganizationShortName,


            COUNT(
              ca.CreditApplicationID
            )::bigint
              AS TotalApplications,


            COALESCE(
              SUM(
                ca.CreditAmountAllowed
              ),
              0
            )
              AS TotalCreditAmount,


            -- ======================================================
            -- Pending
            -- ======================================================

            COUNT(*) FILTER
            (
              WHERE UPPER(
                TRIM(
                  COALESCE(
                    ca.Status,
                    'PENDING'
                  )
                )
              ) = 'PENDING'
            )::bigint
              AS PendingCount,


            -- ======================================================
            -- Approved
            -- ======================================================

            COUNT(*) FILTER
            (
              WHERE UPPER(
                TRIM(
                  COALESCE(
                    ca.Status,
                    ''
                  )
                )
              ) = 'APPROVED'
            )::bigint
              AS ApprovedCount,


            -- ======================================================
            -- Rejected
            -- ======================================================

            COUNT(*) FILTER
            (
              WHERE UPPER(
                TRIM(
                  COALESCE(
                    ca.Status,
                    ''
                  )
                )
              ) = 'REJECTED'
            )::bigint
              AS RejectedCount,


            -- ======================================================
            -- AR Created
            -- ======================================================

            COUNT(*) FILTER
            (
              WHERE NULLIF(
                TRIM(
                  COALESCE(
                    ca.ARID,
                    ''
                  )
                ),
                ''
              ) IS NOT NULL
            )::bigint
              AS ARCreatedCount,


            -- ======================================================
            -- AR Pending
            //
            // Fully approved but ARID blank.
            // ======================================================

            COUNT(*) FILTER
            (
              WHERE UPPER(
                TRIM(
                  COALESCE(
                    ca.Status,
                    ''
                  )
                )
              ) = 'APPROVED'

              AND NULLIF(
                TRIM(
                  COALESCE(
                    ca.ARID,
                    ''
                  )
                ),
                ''
              ) IS NULL
            )::bigint
              AS ARPendingCount


          FROM Credit_Application_Entry_Master ca


          LEFT JOIN Organization_Master om
            ON om.OrganizationID =
               ca.OrganizationID

           AND om.IsDeleted = FALSE


          ${whereClause}


          GROUP BY
            ca.OrganizationID,
            om.OrganizationName,
            om.ShortName


          ORDER BY
            om.OrganizationName ASC,
            ca.OrganizationID ASC


          LIMIT $${limitIndex}
          OFFSET $${offsetIndex};
        `,
        listParams,
      );


    // ============================================================
    // Mapping
    // ============================================================

    const records =
      result.rows.map(
        (row) => ({
          OrganizationID:
            Number(
              row.organizationid,
            ),

          OrganizationName:
            row.organizationname,

          OrganizationShortName:
            row.organizationshortname,

          TotalApplications:
            Number(
              row.totalapplications,
            ),

          TotalCreditAmount:
            Number(
              row.totalcreditamount,
            ),

          PendingCount:
            Number(
              row.pendingcount,
            ),

          ApprovedCount:
            Number(
              row.approvedcount,
            ),

          RejectedCount:
            Number(
              row.rejectedcount,
            ),

          ARCreatedCount:
            Number(
              row.arcreatedcount,
            ),

          ARPendingCount:
            Number(
              row.arpendingcount,
            ),
        }),
      );


    // ============================================================
    // Pagination
    // ============================================================

    const TotalPages =
      TotalCount > 0
        ? Math.ceil(
            TotalCount /
              PageSize,
          )
        : 0;


    // ============================================================
    // Response
    // ============================================================

    return ok(
      "Organization-wise Credit Application report fetched successfully.",
      {
        TotalCount,

        PageCount:
          records.length,

        CurrentPage:
          page,

        PageSize,

        TotalPages,

        data:
          records,
      },
    );

  } catch (error) {
    return databaseFailure(
      error,
      "Fetch organization-wise Credit Application report",
    );
  }
};
// ========================================================================PDFs
// ============================================================CREDIT APPLICATION LIST PDF
const generateCreditApplicationListPdf = async (data) => {
  try {
    // ============================================================
    // Prepared Rows
    //
    // Same rows fetched from getCreditApplicationList
    // ============================================================

    let creditApplicationRows =
      Array.isArray(data.PreparedRows)
        ? data.PreparedRows
        : null;


    // ============================================================
    // Fetch All List Records
    //
    // PDF and List API same source of truth use karenge.
    //
    // Isse:
    // - Role based visibility
    // - Status filter
    // - ApprovalFlow filter
    // - Date filters
    // - FC ARID pending
    // - USER / ROLE / REGIONAL
    //
    // same rahenge.
    // ============================================================

    if (!creditApplicationRows) {
      creditApplicationRows = [];


      const listFilterData = {
        OrganizationID:
          data.OrganizationID,

        CompanyName:
          data.CompanyName,

        Status:
          data.Status,

        ApprovalFlow:
          data.ApprovalFlow,

        FromDate:
          data.FromDate,

        ToDate:
          data.ToDate,

        UserID:
          data.UserID,

        UserType:
          data.UserType,

        DepartmentName:
          data.DepartmentName,

        LoginType:
          data.LoginType,

        AllOrganizationAccess:
          data.AllOrganizationAccess,
      };


      // ==========================================================
      // First Page
      // ==========================================================

      const firstPageResult =
        await getCreditApplicationList({
          ...listFilterData,

          page: 1,

          PageSize: 100,
        });


      if (!firstPageResult.success) {
        return firstPageResult;
      }


      creditApplicationRows.push(
        ...(
          firstPageResult.data?.data ||
          []
        ),
      );


      const totalPages =
        Number(
          firstPageResult.data
            ?.TotalPages ||
            0,
        );


      // ==========================================================
      // Remaining Pages
      // ==========================================================

      for (
        let page = 2;
        page <= totalPages;
        page += 1
      ) {
        const pageResult =
          await getCreditApplicationList({
            ...listFilterData,

            page,

            PageSize: 100,
          });


        if (!pageResult.success) {
          return pageResult;
        }


        creditApplicationRows.push(
          ...(
            pageResult.data?.data ||
            []
          ),
        );
      }
    }


    // ============================================================
    // Organization
    // ============================================================

    const organizationId =
      Number(
        data.OrganizationID,
      ) ||
      creditApplicationRows[0]
        ?.OrganizationID ||
      null;


    // ============================================================
    // Organization Name
    // ============================================================

    let organizationName =
      null;


    if (organizationId) {
      const organizationResult =
        await pool.query(
          `
            SELECT
              OrganizationName

            FROM Organization_Master

            WHERE OrganizationID = $1
              AND IsDeleted = FALSE

            LIMIT 1;
          `,
          [
            organizationId,
          ],
        );


      organizationName =
        organizationResult.rows[0]
          ?.organizationname ||
        null;
    }


    organizationName ||=
      creditApplicationRows[0]
        ?.OrganizationShortName ||
      "All Organizations";


    // ============================================================
    // Serial Number
    // ============================================================

    const pdfRows =
      creditApplicationRows.map(
        (row, index) => ({
          ...row,

          ExportSerialNumber:
            index + 1,
        }),
      );


    // ============================================================
    // Labeled Lines Helper
    // ============================================================

    const labeledLines = (
      items,
    ) =>
      items.flatMap(
        (item, index) => [
          {
            text:
              item.label,
            bold:
              true,
          },

          {
            text:
              ` ${item.value ?? "-"}`,
          },

          ...(
            index <
            items.length - 1
              ? [
                  {
                    text:
                      "\n",
                  },
                ]
              : []
          ),
        ],
      );


    // ============================================================
    // Dynamic Approval Status Helper
    //
    // Example:
    //
    // HOD   : APPROVED
    // FC    : APPROVED
    // GM    : APPROVED
    // RD-FC : PENDING
    // CEO   : PENDING
    //
    // ApproverType USER / ROLE / REGIONAL se koi farq nahi.
    // Display ApprovalRole ke according hoga.
    // ============================================================

    const approvalStatusLines = (
      row,
    ) => {
      const approvals =
        Array.isArray(
          row.Approvals,
        )
          ? row.Approvals
          : [];


      if (
        approvals.length === 0
      ) {
        return [
          {
            label:
              "Status:",

            value:
              normalizeCreditApprovalStatus(
                row.Status,
              ),
          },
        ];
      }


      return approvals.map(
        (approval) => {
          const approvalRole =
            normalizeCreditApplicationApprovalRole(
              approval
                .ApprovalRole ||
                "-",
            );


          const approvalStatus =
            normalizeCreditApprovalStatus(
              approval.Status,
            );


          return {
            label:
              `${approvalRole}:`,

            value:
              approvalStatus,
          };
        },
      );
    };


    // ============================================================
    // PDF Columns
    // ============================================================

    const columns = [
      // ==========================================================
      // Date
      // ==========================================================

      {
        header:
          "DATE",

        value:
          (row) =>
            row.ApplicationDate,

        width:
          50,
      },


      // ==========================================================
      // Company + GST + MSME
      // ==========================================================

      {
        header:
          "COMPANY / GST / MSME",

        value:
          (row) =>
            labeledLines([
              {
                label:
                  "Company:",

                value:
                  row.CompanyName ||
                  "-",
              },

              {
                label:
                  "GST No.:",

                value:
                  row.CompanyGSTIN ||
                  "-",
              },

              {
                label:
                  "MSME:",

                value:
                  row.MSME ||
                  "-",
              },
            ]),

        width:
          105,

        richText:
          true,
      },


      // ==========================================================
      // Business + Billing Address
      // ==========================================================

      {
        header:
          "BUSINESS / BILLING ADDRESS",

        value:
          (row) =>
            labeledLines([
              {
                label:
                  "Business:",

                value:
                  row.BusinessAddress ||
                  "-",
              },

              {
                label:
                  "Billing:",

                value:
                  row.BillingAddress ||
                  "-",
              },
            ]),

        width:
          105,

        richText:
          true,
      },


      // ==========================================================
      // Authorised Person
      // ==========================================================

      {
        header:
          "AUTHORISED PERSON",

        value:
          (row) =>
            [
              row
                .AuthorisedPersonNamePosition ||
                "-",

              row
                .AuthorisedPersonMobileNo ||
                "-",

              row
                .AuthorisedPersonEmail ||
                "-",
            ].join(
              "\n",
            ),

        width:
          90,
      },


      // ==========================================================
      // Accounts Contact
      // ==========================================================

      {
        header:
          "ACCOUNTS CONTACT",

        value:
          (row) =>
            [
              row
                .AccountsContactNamePosition ||
                "-",

              row
                .AccountsContactMobileNo ||
                "-",

              row
                .AccountsContactEmail ||
                "-",
            ].join(
              "\n",
            ),

        width:
          100,
      },


      // ==========================================================
      // Recommended By + Position
      // ==========================================================

      {
        header:
          "RECOMMENDED BY / POSITION",

        value:
          (row) =>
            labeledLines([
              {
                label:
                  "Recommended By:",

                value:
                  row.RecommendedBy ||
                  "-",
              },

              {
                label:
                  "Position:",

                value:
                  row.Position ||
                  "-",
              },
            ]),

        width:
          70,

        richText:
          true,
      },


      // ==========================================================
      // Reference Checked
      // ==========================================================

      {
        header:
          "REFERENCE CHECKED BY / DATE",

        value:
          (row) =>
            labeledLines([
              {
                label:
                  "Checked By:",

                value:
                  row
                    .CreditReferenceCheckedBy ||
                  "-",
              },

              {
                label:
                  "Date:",

                value:
                  row
                    .CreditReferenceCheckedDate ||
                  "-",
              },
            ]),

        width:
          80,

        richText:
          true,
      },


      // ==========================================================
      // Amount / Expected FY / Financial Year
      // ==========================================================

      {
        header:
          "AMOUNT / FY / FINANCIAL YEAR",

        value:
          (row) =>
            labeledLines([
              {
                label:
                  "Amount:",

                value:
                  Number(
                    row
                      .CreditAmountAllowed ||
                      0,
                  ).toLocaleString(
                    "en-IN",
                  ),
              },

              {
                label:
                  "FY:",

                value:
                  Number(
                    row
                      .ExpectedBusinessFY ||
                      0,
                  ).toLocaleString(
                    "en-IN",
                  ),
              },

              {
                label:
                  "Financial Year:",

                value:
                  row.FinancialYear ||
                  "-",
              },
            ]),

        width:
          70,

        richText:
          true,
      },


      // ==========================================================
      // AR ID
      // ==========================================================

      {
        header:
          "ARID",

        value:
          (row) =>
            row.ARID ||
            "-",

        width:
          40,
      },


      // ==========================================================
      // Dynamic Approval Status
      //
      // Fixed FC / GM nahi.
      //
      // HOD / FC / GM / RD-FC / CEO / etc.
      // jo actual saved approval rows hain wahi show honge.
      // ==========================================================

      {
        header:
          "APPROVAL STATUS",

        value:
          (row) =>
            labeledLines(
              approvalStatusLines(
                row,
              ),
            ),

        width:
          70,

        richText:
          true,
      },
    ];


    // ============================================================
    // Metadata
    //
    // Same Filters As GET API
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
          "Company",

        value:
          data.CompanyName ||
          "All",
      },

      {
        label:
          "Status",

        value:
          data.Status ||
          "All",
      },

      {
        label:
          "Approval Flow",

        value:
          data.ApprovalFlow
            ? normalizeCreditApplicationApprovalRole(
                data.ApprovalFlow,
              )
            : "All",
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
          "Total Records",

        value:
          creditApplicationRows.length,
      },
    ];


    // ============================================================
    // Generate PDF
    // ============================================================

    const pdfBuffer =
      await generatePdf({
        title:
          "CREDIT APPROVAL LIST",

        reportName:
          "Credit Approval List",

        organizationId,

        logoUrl:
          data.logoUrl,

        pageSize:
          "A4",

        orientation:
          "landscape",

        metadata,

        columns,

        rows:
          pdfRows,

        styles: {
          pdfTableHeader: {
            fontSize: 8,
            bold: true,
            color: "#FFFFFF",
          },

          pdfTableCell: {
            fontSize: 8,
          },
        },

        tableOptions: {
          layout: {
            paddingLeft:
              () => 2,

            paddingRight:
              () => 2,

            paddingTop:
              () => 3,

            paddingBottom:
              () => 3,
          },
        },

        pageMargins: [
          20,
          25,
          20,
          35,
        ],
      });


    // ============================================================
    // Response
    // ============================================================

    return {
      success:
        true,

      message:
        "Credit Application list PDF generated successfully.",

      data:
        pdfBuffer,

      fileName:
        `Credit_Approval_List_${Date.now()}.pdf`,

      contentType:
        "application/pdf",
    };

  } catch (error) {
    console.error(
      "Generate Credit Application List PDF Document Error:",
      error.message,
    );

    return fail(
      "Unable to generate Credit Application list PDF.",
      503,
    );
  }
};
// ============================================================COMPANY WISE REPORT PDf
const generateCompanyWiseReportPdf = async (data) => {
  try {
    // ============================================================
    // GET ALL RECORDS FROM SAME GET API
    // ============================================================

    const rows = [];

    const exportPageSize = 100;

    let page = 1;
    let totalPages = 1;


    do {
      const result =
        await getCompanyWiseReport({
          OrganizationID:
            data.OrganizationID,

          CompanyName:
            data.CompanyName,

          FromDate:
            data.FromDate,

          ToDate:
            data.ToDate,

          page,

          PageSize:
            exportPageSize,
        });


      if (!result.success) {
        return result;
      }


      const pageRows =
        Array.isArray(
          result.data?.data,
        )
          ? result.data.data
          : [];


      rows.push(
        ...pageRows,
      );


      totalPages =
        Number(
          result.data?.TotalPages,
        ) || 0;


      page += 1;

    } while (
      page <= totalPages
    );


    // ============================================================
    // ORGANIZATION FULL NAME
    // ============================================================

    const organizationResult =
      await pool.query(
        `
          SELECT
            OrganizationName

          FROM Organization_Master

          WHERE OrganizationID = $1
            AND IsDeleted = FALSE

          LIMIT 1;
        `,
        [
          Number(
            data.OrganizationID,
          ),
        ],
      );


    const organizationName =
      organizationResult.rows[0]
        ?.organizationname ||
      "-";


    // ============================================================
    // PDF ROWS
    // ============================================================

    const pdfRows =
      rows.map(
        (row, index) => ({
          ...row,

          SerialNumber:
            index + 1,
        }),
      );


    // ============================================================
    // PDF COLUMNS
    //
    // SAME DATA AS GET API
    //
    // IMPORTANT:
    // RETURNED removed.
    //
    // Current Status:
    // PENDING
    // APPROVED
    // REJECTED
    // ============================================================

    const columns = [
      {
        header:
          "#",

        value:
          (row) =>
            row.SerialNumber,

        width:
          30,

        align:
          "center",
      },


      {
        header:
          "COMPANY NAME",

        value:
          (row) =>
            row.CompanyName ||
            "-",

        width:
          "*",
      },


      {
        header:
          "TOTAL AMOUNT",

        value:
          (row) =>
            Number(
              row.TotalCreditAmount ||
                0,
            ).toLocaleString(
              "en-IN",
              {
                maximumFractionDigits:
                  2,
              },
            ),

        width:
          80,
      },


      // ==========================================================
      // Expected Business FY
      // ==========================================================

      {
        header:
          "EXPECTED BUSINESS FY",

        value:
          (row) =>
            Number(
              row.TotalExpectedBusinessFY ||
                0,
            ).toLocaleString(
              "en-IN",
              {
                maximumFractionDigits:
                  2,
              },
            ),

        width:
          85,
      },


      {
        header:
          "TOTAL",

        value:
          (row) =>
            row.TotalApplications,

        width:
          50,

        align:
          "center",
      },


      {
        header:
          "PENDING",

        value:
          (row) =>
            row.PendingCount,

        width:
          48,

        align:
          "center",
      },


      {
        header:
          "APPROVED",

        value:
          (row) =>
            row.ApprovedCount,

        width:
          52,

        align:
          "center",
      },


      {
        header:
          "REJECTED",

        value:
          (row) =>
            row.RejectedCount,

        width:
          50,

        align:
          "center",
      },


      // ==========================================================
      // AR Created
      // ==========================================================

      {
        header:
          "AR CREATED",

        value:
          (row) =>
            row.ARCreatedCount,

        width:
          55,

        align:
          "center",
      },


      // ==========================================================
      // AR Pending
      //
      // Fully Approved + ARID Blank
      // ==========================================================

      {
        header:
          "AR PENDING",

        value:
          (row) =>
            row.ARPendingCount,

        width:
          55,

        align:
          "center",
      },
    ];


    // ============================================================
    // METADATA
    // SAME FILTERS
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
          "Company",

        value:
          data.CompanyName ||
          "All",
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
          "Total Companies",

        value:
          rows.length,
      },
    ];


    // ============================================================
    // GENERATE PDF
    // ============================================================

    const pdfBuffer =
      await generatePdf({
        title:
          "COMPANY WISE CREDIT APPLICATION REPORT",

        reportName:
          "Company Wise Credit Application Report",

        organizationId:
          Number(
            data.OrganizationID,
          ) ||
          null,

        logoUrl:
          data.logoUrl,

        pageSize:
          "A4",

        orientation:
          "landscape",

        metadata,

        columns,

        rows:
          pdfRows,

        pageMargins: [
          18,
          25,
          18,
          35,
        ],
      });


    // ============================================================
    // RESPONSE
    // ============================================================

    return {
      success:
        true,

      message:
        "Company-wise Credit Application PDF generated successfully.",

      data:
        pdfBuffer,

      fileName:
        `Company_Wise_Credit_Application_Report_${Date.now()}.pdf`,

      contentType:
        "application/pdf",
    };

  } catch (error) {
    console.error(
      "Generate Company Wise Credit Application PDF Error:",
      error.message,
    );


    return fail(
      "Unable to generate Company-wise Credit Application PDF.",
      503,
    );
  }
};
// ============================================================ORGANIZATION WISE REPORT PDF
const generateOrganizationWiseReportPdf = async (data) => {
  try {
    // ============================================================
    // GET ALL RECORDS FROM SAME GET API
    // ============================================================

    const rows = [];

    // getOrganizationWiseReport max PageSize = 100
    const exportPageSize =
      100;

    let page =
      1;

    let totalPages =
      1;


    do {
      const result =
        await getOrganizationWiseReport({
          OrganizationID:
            data.OrganizationID,

          FromDate:
            data.FromDate,

          ToDate:
            data.ToDate,

          page,

          PageSize:
            exportPageSize,
        });


      if (!result.success) {
        return result;
      }


      const pageRows =
        Array.isArray(
          result.data?.data,
        )
          ? result.data.data
          : [];


      rows.push(
        ...pageRows,
      );


      totalPages =
        Number(
          result.data?.TotalPages,
        ) || 0;


      page += 1;

    } while (
      page <= totalPages
    );


    // ============================================================
    // ORGANIZATION ID
    // Optional
    // ============================================================

    const organizationId =
      data.OrganizationID !== undefined &&
      data.OrganizationID !== null &&
      String(
        data.OrganizationID,
      ).trim() !== ""
        ? Number(
            data.OrganizationID,
          )
        : null;


    // ============================================================
    // ORGANIZATION NAME
    //
    // Specific Organization selected:
    // Organization_Master se full name.
    //
    // Organization not selected:
    // All Organizations
    // ============================================================

    let organizationName =
      "All Organizations";


    if (organizationId) {
      const organizationResult =
        await pool.query(
          `
            SELECT
              OrganizationName,
              ShortName

            FROM Organization_Master

            WHERE OrganizationID = $1
              AND IsDeleted = FALSE

            LIMIT 1;
          `,
          [
            organizationId,
          ],
        );


      organizationName =
        organizationResult.rows[0]
          ?.organizationname ||
        organizationResult.rows[0]
          ?.shortname ||
        "-";
    }


    // ============================================================
    // PDF ROWS
    // ============================================================

    const pdfRows =
      rows.map(
        (row, index) => ({
          ...row,

          SerialNumber:
            index + 1,
        }),
      );


    // ============================================================
    // PDF COLUMNS
    //
    // Same Fields As GET API
    //
    // Current Status:
    // PENDING
    // APPROVED
    // REJECTED
    //
    // No RETURNED.
    // ============================================================

    const columns = [
      {
        header:
          "#",

        value:
          (row) =>
            row.SerialNumber,

        width:
          30,

        align:
          "center",
      },


      // ==========================================================
      // Hotel
      // ==========================================================

      {
        header:
          "HTL",

        value:
          (row) =>
            row.OrganizationShortName ||
            row.OrganizationName ||
            "-",

        width:
          120,

        align:
          "left",
      },


      // ==========================================================
      // Total Credit Amount
      // ==========================================================

      {
        header:
          "TOTAL AMOUNT",

        value:
          (row) =>
            Number(
              row.TotalCreditAmount ||
                0,
            ).toLocaleString(
              "en-IN",
              {
                maximumFractionDigits:
                  2,
              },
            ),

        width:
          130,

        align:
          "center",
      },


      // ==========================================================
      // Total Applications
      // ==========================================================

      {
        header:
          "TOTAL",

        value:
          (row) =>
            row.TotalApplications,

        width:
          85,

        align:
          "center",
      },


      // ==========================================================
      // Pending
      // ==========================================================

      {
        header:
          "PENDING",

        value:
          (row) =>
            row.PendingCount,

        width:
          70,

        align:
          "center",
      },


      // ==========================================================
      // Approved
      // ==========================================================

      {
        header:
          "APPROVED",

        value:
          (row) =>
            row.ApprovedCount,

        width:
          70,

        align:
          "center",
      },


      // ==========================================================
      // Rejected
      // ==========================================================

      {
        header:
          "REJECTED",

        value:
          (row) =>
            row.RejectedCount,

        width:
          70,

        align:
          "center",
      },


      // ==========================================================
      // AR Created
      // ==========================================================

      {
        header:
          "AR CREATED",

        value:
          (row) =>
            row.ARCreatedCount,

        width:
          80,

        align:
          "center",
      },


      // ==========================================================
      // AR Pending
      //
      // Fully Approved + ARID Blank
      // ==========================================================

      {
        header:
          "AR PENDING",

        value:
          (row) =>
            row.ARPendingCount,

        width:
          80,

        align:
          "center",
      },
    ];


    // ============================================================
    // METADATA
    //
    // Same Filters As GET API
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
          "Total Organizations",

        value:
          rows.length,
      },
    ];


    // ============================================================
    // GENERATE PDF
    // ============================================================

    const pdfBuffer =
      await generatePdf({
        title:
          "ORGANIZATION WISE CREDIT APPLICATION REPORT",

        reportName:
          "Organization Wise Credit Application Report",

        organizationId,

        logoUrl:
          data.logoUrl,

        pageSize:
          "A4",

        orientation:
          "landscape",

        metadata,

        columns,

        rows:
          pdfRows,

        pageMargins: [
          20,
          25,
          20,
          35,
        ],
      });


    // ============================================================
    // RESPONSE
    // ============================================================

    return {
      success:
        true,

      message:
        "Organization-wise Credit Application PDF generated successfully.",

      data:
        pdfBuffer,

      fileName:
        `Organization_Wise_Credit_Application_Report_${Date.now()}.pdf`,

      contentType:
        "application/pdf",
    };

  } catch (error) {
    console.error(
      "Generate Organization Wise Credit Application PDF Error:",
      error.message,
    );


    return fail(
      "Unable to generate Organization-wise Credit Application PDF.",
      503,
    );
  }
};
// ============================================================CREDIT APPLICATION Details  PDF
const generateCreditApplicationDetailPdf = async (data) => {
  try {
    // ============================================================
    // Validate ID
    // ============================================================

    const CreditApplicationID =
      Number(
        data.CreditApplicationID,
      );

    if (
      !Number.isSafeInteger(
        CreditApplicationID,
      ) ||
      CreditApplicationID <= 0
    ) {
      return fail(
        "Valid CreditApplicationID is required.",
        400,
      );
    }


    // ============================================================
    // SAME GET BY ID API
    // ============================================================

    const result =
      await getCreditApplicationById({
        CreditApplicationID,

        UserID:
          data.UserID,

        UserType:
          data.UserType,

        DepartmentName:
          data.DepartmentName,

        LoginType:
          data.LoginType,

        AllOrganizationAccess:
          data.AllOrganizationAccess,
      });


    if (!result.success) {
      return result;
    }


    const detail =
      result.data;


    if (!detail) {
      return fail(
        "Credit Application record not found.",
        404,
      );
    }


    const organizationID =
      Number(
        detail.OrganizationID,
      );


    // ============================================================
    // PDF COLORS
    // ============================================================

    const COLORS = {
      navy:
        "#082B5C",

      label:
        "#082B5C",

      text:
        "#172033",

      muted:
        "#64748B",

      border:
        "#CFD7E3",

      labelBackground:
        "#F4F6F9",
    };


    // ============================================================
    // Display Helper
    // ============================================================

    const displayValue = (
      value,
    ) =>
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
      type:
        "line",

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
      type:
        "rect",

      x,
      y,
      w,
      h,
      r,

      lineWidth:
        1.1,

      lineColor:
        COLORS.navy,
    });


    const ellipse = (
      x,
      y,
      r1,
      r2 = r1,
    ) => ({
      type:
        "ellipse",

      x,
      y,
      r1,
      r2,

      lineWidth:
        1.1,

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


        company: [
          rect(
            2,
            4,
            14,
            12,
            1,
          ),

          line(
            5,
            7,
            5,
            13,
          ),

          line(
            9,
            7,
            9,
            13,
          ),

          line(
            13,
            7,
            13,
            13,
          ),

          line(
            1,
            17,
            17,
            17,
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


        person: [
          ellipse(
            9,
            5,
            3,
          ),

          {
            type:
              "polyline",

            points: [
              {
                x:
                  2,

                y:
                  17,
              },

              {
                x:
                  3,

                y:
                  13,
              },

              {
                x:
                  6,

                y:
                  11,
              },

              {
                x:
                  12,

                y:
                  11,
              },

              {
                x:
                  15,

                y:
                  13,
              },

              {
                x:
                  16,

                y:
                  17,
              },
            ],

            lineWidth:
              1.1,

            lineColor:
              COLORS.navy,
          },
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
                x:
                  5,

                y:
                  10,
              },

              {
                x:
                  9,

                y:
                  18,
              },

              {
                x:
                  13,

                y:
                  10,
              },
            ],

            lineWidth:
              1.1,

            lineColor:
              COLORS.navy,
          },
        ],


        money: [
          ellipse(
            9,
            9,
            7,
          ),

          line(
            9,
            4,
            9,
            14,
          ),

          line(
            6,
            6,
            12,
            6,
          ),

          line(
            6,
            12,
            12,
            12,
          ),
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
            14,
            6,
          ),
        ],


        email: [
          rect(
            1,
            4,
            16,
            11,
            1,
          ),

          line(
            1,
            5,
            9,
            11,
          ),

          line(
            17,
            5,
            9,
            11,
          ),
        ],


        phone: [
          {
            type:
              "polyline",

            points: [
              {
                x:
                  4,

                y:
                  2,
              },

              {
                x:
                  7,

                y:
                  6,
              },

              {
                x:
                  5,

                y:
                  8,
              },

              {
                x:
                  10,

                y:
                  13,
              },

              {
                x:
                  12,

                y:
                  11,
              },

              {
                x:
                  16,

                y:
                  14,
              },

              {
                x:
                  14,

                y:
                  17,
              },

              {
                x:
                  10,

                y:
                  16,
              },

              {
                x:
                  5,

                y:
                  12,
              },

              {
                x:
                  2,

                y:
                  7,
              },

              {
                x:
                  2,

                y:
                  4,
              },

              {
                x:
                  4,

                y:
                  2,
              },
            ],

            lineWidth:
              1.1,

            lineColor:
              COLORS.navy,
          },
        ],


        document: [
          rect(
            3,
            1,
            12,
            16,
            1,
          ),

          line(
            6,
            6,
            12,
            6,
          ),

          line(
            6,
            9,
            12,
            9,
          ),

          line(
            6,
            12,
            11,
            12,
          ),
        ],
      };


      const iconScale =
        0.82;


      return (
        icons[type] ||
        icons.company
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
          width:
            22,

          canvas:
            fieldIcon(
              icon,
            ),
        },

        {
          width:
            "*",

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
        organizationID,
        data.logoUrl,
      );


    const generatedOn =
      formatDate(
        new Date(),
        "DD MMM YYYY hh:mm A",
      );


    // ============================================================
    // Amount Values
    // ============================================================

    const creditAmount =
      detail.CreditAmountAllowed !==
        null &&
      detail.CreditAmountAllowed !==
        undefined
        ? Number(
            detail.CreditAmountAllowed,
          ).toLocaleString(
            "en-IN",
            {
              maximumFractionDigits:
                2,
            },
          )
        : null;


    const expectedBusinessFY =
      detail.ExpectedBusinessFY !==
        null &&
      detail.ExpectedBusinessFY !==
        undefined
        ? Number(
            detail.ExpectedBusinessFY,
          ).toLocaleString(
            "en-IN",
            {
              maximumFractionDigits:
                2,
            },
          )
        : null;


    // ============================================================
    // Overall Application Status
    // ============================================================

    const applicationStatus =
      normalizeCreditApprovalStatus(
        detail.Status,
      );


    // ============================================================
    // Approval Table
    //
    // Dynamic:
    // HOD / FC / GM / RD-FC / CEO / etc.
    //
    // USER / ROLE / REGIONAL assignment type PDF me show karna
    // required nahi hai.
    // ============================================================

    const approvals =
      Array.isArray(
        detail.Approvals,
      )
        ? detail.Approvals
        : [];


    const approvalBody = [
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
            "Remarks",

          style:
            "tableHeader",
        },
      ],
    ];


    approvals.forEach(
      (approval) => {
        const approvalRole =
          normalizeCreditApplicationApprovalRole(
            approval.ApprovalRole ||
              "",
          );


        const approvalStatus =
          normalizeCreditApprovalStatus(
            approval.Status,
          );


        approvalBody.push([
          {
            text:
              displayValue(
                approvalRole,
              ),

            style:
              "tableValue",
          },

          {
            text:
              displayValue(
                approvalStatus,
              ),

            style:
              "tableValue",
          },

          {
            text:
              displayValue(
                approval.Remarks,
              ),

            style:
              "tableValue",
          },
        ]);
      },
    );


    if (
      approvals.length === 0
    ) {
      approvalBody.push([
        {
          text:
            "No approval data found.",

          colSpan:
            3,

          alignment:
            "center",

          style:
            "tableValue",
        },

        {},

        {},
      ]);
    }


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
                    "Credit Application Detail",

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
        // Company Details
        // ========================================================

        sectionHeading(
          "Company Details",
        ),


        {
          table: {
            widths: [
              115,
              "*",
              115,
              "*",
            ],

            body: [
              [
                labelCell(
                  "Organization",
                  "organization",
                ),

                valueCell(
                  detail
                    .OrganizationShortName ||
                    detail
                      .OrganizationName,
                ),

                labelCell(
                  "Application Date",
                  "calendar",
                ),

                valueCell(
                  detail.ApplicationDate,
                ),
              ],


              [
                labelCell(
                  "Company / Firm",
                  "company",
                ),

                valueCell(
                  detail.CompanyName,
                ),

                labelCell(
                  "GSTIN",
                  "document",
                ),

                valueCell(
                  detail.CompanyGSTIN,
                ),
              ],


              [
                labelCell(
                  "MSME",
                  "status",
                ),

                valueCell(
                  detail.MSME,
                ),

                labelCell(
                  "Financial Year",
                  "calendar",
                ),

                valueCell(
                  detail.FinancialYear,
                ),
              ],


              [
                {
                  ...labelCell(
                    "Business Address",
                    "location",
                  ),
                },

                {
                  text:
                    displayValue(
                      detail.BusinessAddress,
                    ),

                  style:
                    "fieldValue",

                  colSpan:
                    3,

                  margin: [
                    9,
                    8,
                    7,
                    7,
                  ],
                },

                {},

                {},
              ],


              [
                {
                  ...labelCell(
                    "Billing Address",
                    "location",
                  ),
                },

                {
                  text:
                    displayValue(
                      detail.BillingAddress,
                    ),

                  style:
                    "fieldValue",

                  colSpan:
                    3,

                  margin: [
                    9,
                    8,
                    7,
                    7,
                  ],
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
        // Authorised Person
        // ========================================================

        sectionHeading(
          "Authorised Person Details",
        ),


        {
          table: {
            widths: [
              115,
              "*",
              115,
              "*",
            ],

            body: [
              [
                labelCell(
                  "Name / Position",
                  "person",
                ),

                valueCell(
                  detail
                    .AuthorisedPersonNamePosition,
                ),

                labelCell(
                  "Mobile Number",
                  "phone",
                ),

                valueCell(
                  detail
                    .AuthorisedPersonMobileNo,
                ),
              ],


              [
                labelCell(
                  "Email",
                  "email",
                ),

                {
                  text:
                    displayValue(
                      detail
                        .AuthorisedPersonEmail,
                    ),

                  style:
                    "fieldValue",

                  colSpan:
                    3,

                  margin: [
                    9,
                    8,
                    7,
                    7,
                  ],
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
        // Accounts Contact
        // ========================================================

        sectionHeading(
          "Accounts Contact Details",
        ),


        {
          table: {
            widths: [
              115,
              "*",
              115,
              "*",
            ],

            body: [
              [
                labelCell(
                  "Name / Position",
                  "person",
                ),

                valueCell(
                  detail
                    .AccountsContactNamePosition,
                ),

                labelCell(
                  "Mobile Number",
                  "phone",
                ),

                valueCell(
                  detail
                    .AccountsContactMobileNo,
                ),
              ],


              [
                labelCell(
                  "Email",
                  "email",
                ),

                {
                  text:
                    displayValue(
                      detail
                        .AccountsContactEmail,
                    ),

                  style:
                    "fieldValue",

                  colSpan:
                    3,

                  margin: [
                    9,
                    8,
                    7,
                    7,
                  ],
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
        // Credit Details
        // ========================================================

        sectionHeading(
          "Credit Details",
        ),


        {
          table: {
            widths: [
              115,
              "*",
              115,
              "*",
            ],

            body: [
              [
                labelCell(
                  "Recommended By",
                  "person",
                ),

                valueCell(
                  detail.RecommendedBy,
                ),

                labelCell(
                  "Position",
                  "person",
                ),

                valueCell(
                  detail.Position,
                ),
              ],


              [
                labelCell(
                  "Reference Checked By",
                  "person",
                ),

                valueCell(
                  detail
                    .CreditReferenceCheckedBy,
                ),

                labelCell(
                  "Reference Date",
                  "calendar",
                ),

                valueCell(
                  detail
                    .CreditReferenceCheckedDate,
                ),
              ],


              [
                labelCell(
                  "Credit Amount",
                  "money",
                ),

                valueCell(
                  creditAmount,
                ),

                labelCell(
                  "Expected Business FY",
                  "money",
                ),

                valueCell(
                  expectedBusinessFY,
                ),
              ],


              [
                labelCell(
                  "AR ID",
                  "document",
                ),

                valueCell(
                  detail.ARID,
                ),

                labelCell(
                  "Application Status",
                  "status",
                ),

                valueCell(
                  applicationStatus,
                ),
              ],


              [
                labelCell(
                  "Created Date",
                  "calendar",
                ),

                valueCell(
                  detail.CreatedDate,
                ),

                {
                  text:
                    "",

                  colSpan:
                    2,
                },

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
        // Approval Details
        //
        // Dynamic Approval Flow
        // ========================================================

        sectionHeading(
          "Approval Details",
        ),


        {
          table: {
            headerRows:
              1,

            widths: [
              90,
              90,
              "*",
            ],

            body:
              approvalBody,
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
                7,

            paddingRight:
              () =>
                7,

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
            15,
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
                    150,

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
            8.5,

          bold:
            true,

          color:
            COLORS.navy,

          fillColor:
            COLORS.labelBackground,
        },


        tableValue: {
          fontSize:
            8.5,

          color:
            COLORS.text,
        },
      },
    };


    // ============================================================
    // Generate PDF
    // Direct PdfPrinter
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
                EQUIPMENT_DETAIL_PDF_FONTS,
              )
                .createPdfKitDocument(
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
            reject(
              error,
            );
          }
        },
      );


    // ============================================================
    // Response
    // ============================================================

    const fileName =
      `Credit-Application-Detail-${CreditApplicationID}.pdf`;


    return {
      success:
        true,

      message:
        "Credit Application detail PDF generated successfully.",

      data:
        pdfBuffer,

      fileName,

      contentType:
        "application/pdf",
    };

  } catch (error) {
    console.error(
      "Generate Credit Application detail PDF error:",
      error,
    );


    return databaseFailure(
      error,
      "Generate Credit Application detail PDF",
    );
  }
};
// ============================================================
// Exports
// ============================================================
module.exports = {
  createCreditApplication,
  getCreditApplicationList,
  getCreditApplicationById,
  updateCreditApplication,
  deleteCreditApplication,
  processCreditApplicationApproval,
  updateCreditApplicationARID,
  createCreditApplicationApprovalConfig,
  getCreditApplicationApprovalConfigList,
  deleteCreditApplicationApprovalConfig,
  getCompanyWiseReport,
  getOrganizationWiseReport,
  generateCreditApplicationListPdf,
  generateCompanyWiseReportPdf,
  generateOrganizationWiseReportPdf,
  generateCreditApplicationDetailPdf,
  getCompanyNames
};
