// ============================================================ RabbitMQ
const producer = require("../../producer/producer");
const QUEUE = require("../../config/queue");
// ============================================================ Error Handling
const STATUS_CODES = require("../../utils/statusCodes");
const AppError = require("../../utils/AppError");
const handleError = require("../../utils/errorHandler");
// ============================================================ Azure
const uploadToAzure = require("../../AzurConfigration/Gatepass/AzureRGPUpload",);
// ============================================================ Service
const GatepassService = require("../../services/GatepassService/GatepassService",);

// =========================Queue Helper
const sendQueueResponse = async (
  req,
  res,
  action,
  data,
  successCode = STATUS_CODES.SUCCESS,
) => {
  const result =
    await producer.sendMessage(
      QUEUE.GATEPASS.REQUEST,
      QUEUE.GATEPASS.RESPONSE,
      {
        action,
        data: {
          ...data,

          UserID:
            req.user?.UserID,

          UserType:
            req.user?.UserType,

          UserDepartmentID: req.user?.DepartmentID,

          DepartmentName:
            req.user?.DepartmentName,

          LoginType:
            req.user?.LoginType,

          AllOrganizationAccess:
            req.user?.AllOrganizationAccess,
        },
      },
    );

  return res
    .status(
      result.statusCode ||
      successCode,
    )
    .json(result);
};
// =========================Date Validation
const validateDateFormat = (
  value,
  fieldName,
) => {
  if (!value) return;

  const dateFormat =
    /^\d{4}-\d{2}-\d{2}$/;

  if (!dateFormat.test(value)) {
    throw new AppError(
      `${fieldName} must be in YYYY-MM-DD format`,
      STATUS_CODES.BAD_REQUEST,
    );
  }
};
// =======================================================================================RGP
// ============================================================ CREATE RGP
exports.createRGP = async (req, res) => {
  try {
    const {
      OrganizationID,
      ExpectedReturnDate,
      VendorName,
      ContactNumber,
      Company,
      DepartmentID,
      Address,
      TakenBy,
      Items,
    } = req.body || {};

    // =========================================================
    // Organization
    // =========================================================

    if (
      !OrganizationID ||
      !Number.isInteger(
        Number(OrganizationID),
      ) ||
      Number(OrganizationID) <= 0
    ) {
      throw new AppError(
        "Organization ID must be a valid positive integer",
        STATUS_CODES.BAD_REQUEST,
      );
    }

    // =========================================================
    // Expected Return Date
    // =========================================================

    if (!ExpectedReturnDate) {
      throw new AppError(
        "Expected Return Date is required",
        STATUS_CODES.BAD_REQUEST,
      );
    }

    validateDateFormat(
      ExpectedReturnDate,
      "Expected Return Date",
    );

    // =========================================================
    // Vendor Name
    // =========================================================

    if (
      !VendorName ||
      !String(VendorName).trim()
    ) {
      throw new AppError(
        "Vendor Name is required",
        STATUS_CODES.BAD_REQUEST,
      );
    }

    // =========================================================
    // Department
    // =========================================================

    if (
      !DepartmentID ||
      !Number.isInteger(
        Number(DepartmentID),
      ) ||
      Number(DepartmentID) <= 0
    ) {
      throw new AppError(
        "Department ID must be a valid positive integer",
        STATUS_CODES.BAD_REQUEST,
      );
    }

    // =========================================================
    // Items
    // Multipart FormData me Items JSON string aa sakta hai
    // =========================================================

    let items = Items;

    if (typeof items === "string") {
      try {
        items = JSON.parse(items);
      } catch (_error) {
        throw new AppError(
          "Items must be a valid JSON array",
          STATUS_CODES.BAD_REQUEST,
        );
      }
    }

    if (
      !Array.isArray(items) ||
      items.length === 0
    ) {
      throw new AppError(
        "At least one RGP item is required",
        STATUS_CODES.BAD_REQUEST,
      );
    }

    // =========================================================
    // Item Validation
    // =========================================================

    const normalizedItems =
      items.map((item, index) => {
        if (
          !item.ItemName ||
          !String(item.ItemName).trim()
        ) {
          throw new AppError(
            `Item Name is required for item ${
              index + 1
            }`,
            STATUS_CODES.BAD_REQUEST,
          );
        }

        if (
          item.Quantity === undefined ||
          item.Quantity === null ||
          String(item.Quantity).trim() === ""
        ) {
          throw new AppError(
            `Quantity is required for item ${
              index + 1
            }`,
            STATUS_CODES.BAD_REQUEST,
          );
        }

        const quantity =
          Number(item.Quantity);

        if (
          !Number.isFinite(quantity) ||
          quantity <= 0
        ) {
          throw new AppError(
            `Quantity must be greater than zero for item ${
              index + 1
            }`,
            STATUS_CODES.BAD_REQUEST,
          );
        }

        let rate = null;

        if (
          item.Rate !== undefined &&
          item.Rate !== null &&
          String(item.Rate).trim() !== ""
        ) {
          rate = Number(item.Rate);

          if (
            !Number.isFinite(rate) ||
            rate < 0
          ) {
            throw new AppError(
              `Rate must be a valid number for item ${
                index + 1
              }`,
              STATUS_CODES.BAD_REQUEST,
            );
          }
        }

        return {
          ItemName:
            String(item.ItemName).trim(),

          Specification:
            String(
              item.Specification || "",
            ).trim() || null,

          Quantity: quantity,

          Unit:
            String(item.Unit || "").trim() ||
            null,

          Rate: rate,

          MakeModel:
            String(
              item.MakeModel || "",
            ).trim() || null,

          SerialNumber:
            String(
              item.SerialNumber || "",
            ).trim() || null,
        };
      });

    // =========================================================
    // Documents
    // RGP document table me DocumentType nahi hai.
    // =========================================================

    const files = req.files || [];
    const Documents = [];

    for (
      let index = 0;
      index < files.length;
      index += 1
    ) {
      const file = files[index];

      const filePath =
        await uploadToAzure(file);

      Documents.push({
        FileName: file.originalname,
        FilePath: filePath,
        FileType: file.mimetype,
        FileSize: file.size,
      });
    }

    // =========================================================
    // Final Data
    // =========================================================

    const data = {
      OrganizationID:
        Number(OrganizationID),

      ExpectedReturnDate,

      VendorName:
        String(VendorName).trim(),

      ContactNumber:
        String(
          ContactNumber || "",
        ).trim() || null,

      Company:
        String(Company || "").trim() ||
        null,

      DepartmentID:
        Number(DepartmentID),

      Address:
        String(Address || "").trim() ||
        null,

      TakenBy:
        String(TakenBy || "").trim() ||
        null,

      Items: normalizedItems,

      Documents,
    };

    // =========================================================
    // RabbitMQ
    // =========================================================

    return sendQueueResponse(
      req,
      res,
      "CREATE_RGP",
      data,
      STATUS_CODES.CREATED,
    );
  } catch (error) {
    return handleError(error, res);
  }
};
// ============================================================ Get RGP List
exports.getRGPList = async (req, res) => {
  try {
    const {
      OrganizationID,
      RGPNumber,
      Status,
      DepartmentID,
      FromDate,
      ToDate,
      Search,
      page,
      PageSize,
    } = req.query;

    if (
      !OrganizationID ||
      !Number.isInteger(Number(OrganizationID)) ||
      Number(OrganizationID) <= 0
    ) {
      throw new AppError(
        "Organization ID must be a valid positive integer",
        STATUS_CODES.BAD_REQUEST,
      );
    }

    if (
      RGPNumber &&
      (
        !Number.isInteger(Number(RGPNumber)) ||
        Number(RGPNumber) <= 0
      )
    ) {
      throw new AppError(
        "RGP Number must be a valid positive integer",
        STATUS_CODES.BAD_REQUEST,
      );
    }

    if (
      DepartmentID &&
      (
        !Number.isInteger(Number(DepartmentID)) ||
        Number(DepartmentID) <= 0
      )
    ) {
      throw new AppError(
        "Department ID must be a valid positive integer",
        STATUS_CODES.BAD_REQUEST,
      );
    }

    if (FromDate) {
      validateDateFormat(
        FromDate,
        "From Date",
      );
    }

    if (ToDate) {
      validateDateFormat(
        ToDate,
        "To Date",
      );
    }

    if (
      FromDate &&
      ToDate &&
      new Date(FromDate) > new Date(ToDate)
    ) {
      throw new AppError(
        "From Date cannot be greater than To Date",
        STATUS_CODES.BAD_REQUEST,
      );
    }

    const result =
      await GatepassService.getRGPList({
        OrganizationID:
          Number(OrganizationID),

        RGPNumber:
          RGPNumber
            ? Number(RGPNumber)
            : null,

        Status:
          Status?.trim() || null,

        DepartmentID:
          DepartmentID
            ? Number(DepartmentID)
            : null,

        FromDate:
          FromDate || null,

        ToDate:
          ToDate || null,

        Search:
          Search?.trim() || null,

        page:
          Math.max(
            Number(page) || 1,
            1,
          ),

        PageSize:
          Math.min(
            Math.max(
              Number(PageSize) || 10,
              1,
            ),
            100,
          ),

        // Trusted JWT
        UserID:
          req.user.UserID,

        UserType:
          req.user.UserType,

        UserDepartmentID: req.user.DepartmentID,

        DepartmentName:
          req.user.DepartmentName,

        LoginType:
          req.user.LoginType,

        AllOrganizationAccess:
          req.user.AllOrganizationAccess,
      });

    if (!result.success) {
      throw new AppError(
        result.message,
        result.statusCode ||
          STATUS_CODES.BAD_REQUEST,
      );
    }

    return res
      .status(STATUS_CODES.SUCCESS)
      .json(result);
  } catch (error) {
    return handleError(error, res);
  }
};
// ============================================================ Get RGP By ID
exports.getRGPById = async (req, res) => {
  try {
    const { id } = req.params;

    if (
      !id ||
      !Number.isInteger(Number(id)) ||
      Number(id) <= 0
    ) {
      throw new AppError(
        "RGP ID must be a valid positive integer",
        STATUS_CODES.BAD_REQUEST,
      );
    }

    const result =
      await GatepassService.getRGPById({
        RGPID: Number(id),

        // Trusted JWT
        UserID: req.user.UserID,
        UserType: req.user.UserType,
        DepartmentName:
          req.user.DepartmentName,
        LoginType: req.user.LoginType,
        AllOrganizationAccess:
          req.user.AllOrganizationAccess,
      });

    if (!result.success) {
      throw new AppError(
        result.message,
        result.statusCode ||
          STATUS_CODES.BAD_REQUEST,
      );
    }

    return res
      .status(STATUS_CODES.SUCCESS)
      .json(result);
  } catch (error) {
    return handleError(error, res);
  }
};
// ============================================================Get RGP By RGP Number
exports.getRGPByNumber = async (
  req,
  res,
) => {
  try {
    const RGPNumber =
      req.query.RGPNumber?.trim();

    // RGPNumber nahi diya to bhi API success,
    // bas data empty rahega
    if (!RGPNumber) {
      return res.status(200).json({
        success: true,
        message:
          "Enter RGP number to search.",
        data: null,
      });
    }

    const result =
      await GatepassService.getRGPByNumber({
        RGPNumber,

        UserID: req.user?.UserID,
        UserType: req.user?.UserType,
        DepartmentName:
          req.user?.DepartmentName,
        LoginType:
          req.user?.LoginType,
        AllOrganizationAccess:
          req.user?.AllOrganizationAccess,
      });

    return res
      .status(result.statusCode || 200)
      .json(result);
  } catch (error) {
    console.error(
      "Get RGP By Number Controller Error:",
      error,
    );

    return res.status(500).json({
      success: false,
      message:
        "Unable to fetch RGP record.",
    });
  }
};
// ============================================================Vendor Names
exports.getRGPVendorNames = async (req, res) => {
  try {
    const { OrganizationID } = req.query;

    if (
      !OrganizationID ||
      !Number.isInteger(Number(OrganizationID)) ||
      Number(OrganizationID) <= 0
    ) {
      return res.status(400).json({
        success: false,
        message: "Valid OrganizationID is required.",
      });
    }

    const result =
      await GatepassService.getRGPVendorNames({
        OrganizationID: Number(OrganizationID),

        UserID: req.user?.UserID,
        UserType: req.user?.UserType,
        DepartmentName: req.user?.DepartmentName,
        LoginType: req.user?.LoginType,
        AllOrganizationAccess:
          req.user?.AllOrganizationAccess,
      });

    return res
      .status(result.statusCode || 200)
      .json(result);
  } catch (error) {
    console.error(
      "Get RGP Vendor Names Controller Error:",
      error,
    );

    return res.status(500).json({
      success: false,
      message: "Unable to fetch RGP vendor names.",
    });
  }
};
// ============================================================ Update RGP
exports.updateRGP = async (req, res) => {
  try {
    const {
      RGPID,
      OrganizationID,
      ExpectedReturnDate,
      VendorName,
      ContactNumber,
      Company,
      DepartmentID,
      Address,
      TakenBy,
      Items,
      DeleteItemIDs,
      DeleteDocumentIDs,
    } = req.body || {};

    // ==========================================================
    // RGP ID
    // ==========================================================

    if (
      !RGPID ||
      !Number.isInteger(Number(RGPID)) ||
      Number(RGPID) <= 0
    ) {
      throw new AppError(
        "RGP ID must be a valid positive integer",
        STATUS_CODES.BAD_REQUEST,
      );
    }

    // ==========================================================
    // Organization
    // ==========================================================

    if (
      !OrganizationID ||
      !Number.isInteger(Number(OrganizationID)) ||
      Number(OrganizationID) <= 0
    ) {
      throw new AppError(
        "Organization ID must be a valid positive integer",
        STATUS_CODES.BAD_REQUEST,
      );
    }

    // ==========================================================
    // Expected Return Date
    // ==========================================================

    if (!ExpectedReturnDate) {
      throw new AppError(
        "Expected Return Date is required",
        STATUS_CODES.BAD_REQUEST,
      );
    }

    validateDateFormat(
      ExpectedReturnDate,
      "Expected Return Date",
    );

    // ==========================================================
    // Vendor
    // ==========================================================

    if (
      !VendorName ||
      !String(VendorName).trim()
    ) {
      throw new AppError(
        "Vendor Name is required",
        STATUS_CODES.BAD_REQUEST,
      );
    }

    // ==========================================================
    // Department
    // ==========================================================

    if (
      !DepartmentID ||
      !Number.isInteger(Number(DepartmentID)) ||
      Number(DepartmentID) <= 0
    ) {
      throw new AppError(
        "Department ID must be a valid positive integer",
        STATUS_CODES.BAD_REQUEST,
      );
    }

    // ==========================================================
    // Parse Arrays
    // ==========================================================

    let parsedItems = Items;
    let parsedDeleteItemIDs =
      DeleteItemIDs || [];
    let parsedDeleteDocumentIDs =
      DeleteDocumentIDs || [];

    if (typeof parsedItems === "string") {
      try {
        parsedItems =
          JSON.parse(parsedItems);
      } catch (error) {
        throw new AppError(
          "Items must be a valid JSON array",
          STATUS_CODES.BAD_REQUEST,
        );
      }
    }

    if (
      typeof parsedDeleteItemIDs ===
      "string"
    ) {
      try {
        parsedDeleteItemIDs =
          JSON.parse(
            parsedDeleteItemIDs,
          );
      } catch (error) {
        throw new AppError(
          "DeleteItemIDs must be a valid JSON array",
          STATUS_CODES.BAD_REQUEST,
        );
      }
    }

    if (
      typeof parsedDeleteDocumentIDs ===
      "string"
    ) {
      try {
        parsedDeleteDocumentIDs =
          JSON.parse(
            parsedDeleteDocumentIDs,
          );
      } catch (error) {
        throw new AppError(
          "DeleteDocumentIDs must be a valid JSON array",
          STATUS_CODES.BAD_REQUEST,
        );
      }
    }

    if (!Array.isArray(parsedItems)) {
      throw new AppError(
        "Items must be an array",
        STATUS_CODES.BAD_REQUEST,
      );
    }

    if (
      !Array.isArray(
        parsedDeleteItemIDs,
      )
    ) {
      throw new AppError(
        "DeleteItemIDs must be an array",
        STATUS_CODES.BAD_REQUEST,
      );
    }

    if (
      !Array.isArray(
        parsedDeleteDocumentIDs,
      )
    ) {
      throw new AppError(
        "DeleteDocumentIDs must be an array",
        STATUS_CODES.BAD_REQUEST,
      );
    }

    // ==========================================================
    // Validate Items
    // ==========================================================

    const normalizedItems =
      parsedItems.map(
        (item, index) => {
          if (
            !item.ItemName ||
            !String(
              item.ItemName,
            ).trim()
          ) {
            throw new AppError(
              `Item Name is required for item ${index + 1}`,
              STATUS_CODES.BAD_REQUEST,
            );
          }

          const quantity =
            Number(item.Quantity);

          if (
            !Number.isFinite(
              quantity,
            ) ||
            quantity <= 0
          ) {
            throw new AppError(
              `Quantity must be greater than zero for item ${index + 1}`,
              STATUS_CODES.BAD_REQUEST,
            );
          }

          let rate = null;

          if (
            item.Rate !== undefined &&
            item.Rate !== null &&
            String(
              item.Rate,
            ).trim() !== ""
          ) {
            rate =
              Number(item.Rate);

            if (
              !Number.isFinite(rate) ||
              rate < 0
            ) {
              throw new AppError(
                `Rate must be a valid number for item ${index + 1}`,
                STATUS_CODES.BAD_REQUEST,
              );
            }
          }

          return {
            RGPItemID:
              item.RGPItemID
                ? Number(
                    item.RGPItemID,
                  )
                : null,

            ItemName:
              String(
                item.ItemName,
              ).trim(),

            Specification:
              String(
                item.Specification ||
                  "",
              ).trim() || null,

            Quantity: quantity,

            Unit:
              String(
                item.Unit || "",
              ).trim() || null,

            Rate: rate,

            MakeModel:
              String(
                item.MakeModel || "",
              ).trim() || null,

            SerialNumber:
              String(
                item.SerialNumber ||
                  "",
              ).trim() || null,
          };
        },
      );

    // ==========================================================
    // New Documents
    // ==========================================================

    const Documents = [];

    for (const file of req.files || []) {
      const filePath =
        await uploadToAzure(file);

      Documents.push({
        FileName:
          file.originalname,
        FilePath: filePath,
        FileType: file.mimetype,
        FileSize: file.size,
      });
    }

    // ==========================================================
    // Queue
    // ==========================================================

    return sendQueueResponse(
      req,
      res,
      "UPDATE_RGP",
      {
        RGPID: Number(RGPID),
        OrganizationID:
          Number(OrganizationID),

        ExpectedReturnDate,

        VendorName:
          String(
            VendorName,
          ).trim(),

        ContactNumber:
          String(
            ContactNumber || "",
          ).trim() || null,

        Company:
          String(
            Company || "",
          ).trim() || null,

        DepartmentID:
          Number(DepartmentID),

        Address:
          String(
            Address || "",
          ).trim() || null,

        TakenBy:
          String(
            TakenBy || "",
          ).trim() || null,

        Items:
          normalizedItems,

        DeleteItemIDs:
          parsedDeleteItemIDs.map(
            Number,
          ),

        DeleteDocumentIDs:
          parsedDeleteDocumentIDs.map(
            Number,
          ),

        Documents,
      },
      STATUS_CODES.SUCCESS,
    );
  } catch (error) {
    return handleError(
      error,
      res,
    );
  }
};
// ============================================================ Delete RGP
exports.deleteRGP = async (req, res) => {
  try {
    const {
      RGPID,
    } = req.body || {};

    if (
      !RGPID ||
      !Number.isInteger(Number(RGPID)) ||
      Number(RGPID) <= 0
    ) {
      throw new AppError(
        "RGP ID must be a valid positive integer",
        STATUS_CODES.BAD_REQUEST,
      );
    }

    return sendQueueResponse(
      req,
      res,
      "DELETE_RGP",
      {
        RGPID: Number(RGPID),
      },
      STATUS_CODES.SUCCESS,
    );
  } catch (error) {
    return handleError(
      error,
      res,
    );
  }
};
// ============================================================ RGP APPROVAL
exports.processRGPApproval = async (
  req,
  res,
) => {
  try {
    const {
      RGPID,
      Action,
      Remarks,
    } = req.body || {};

    // ============================================================
    // RGP ID
    // ============================================================

    if (
      !RGPID ||
      !Number.isInteger(
        Number(RGPID),
      ) ||
      Number(RGPID) <= 0
    ) {
      throw new AppError(
        "RGP ID must be a valid positive integer",
        STATUS_CODES.BAD_REQUEST,
      );
    }

    // ============================================================
    // Action
    // ============================================================

    const action = String(
      Action || "",
    )
      .trim()
      .toUpperCase();

    if (
      ![
        "APPROVE",
        "REJECT",
      ].includes(action)
    ) {
      throw new AppError(
        "Action must be APPROVE or REJECT",
        STATUS_CODES.BAD_REQUEST,
      );
    }

    // ============================================================
    // Remarks
    // REJECT ke liye compulsory
    // ============================================================

    const remarks =
      String(
        Remarks || "",
      ).trim();

    if (
      action === "REJECT" &&
      !remarks
    ) {
      throw new AppError(
        "Remarks are required for REJECT",
        STATUS_CODES.BAD_REQUEST,
      );
    }

    // ============================================================
    // Queue
    // ============================================================

    return sendQueueResponse(
      req,
      res,
      "PROCESS_RGP_APPROVAL",
      {
        RGPID:
          Number(RGPID),

        Action:
          action,

        Remarks:
          remarks || null,
      },
    );
  } catch (error) {
    return handleError(
      error,
      res,
    );
  }
};
// ============================================================PROCESS RGP GATE ACTION,CHECKOUT / CANCEL
exports.processRGPGateAction = async (req, res) => {
  try {
    const {
      RGPID,
      Action,
      Remarks,
    } = req.body || {};

    // ============================================================
    // RGP ID
    // ============================================================

    if (
      !RGPID ||
      !Number.isInteger(Number(RGPID)) ||
      Number(RGPID) <= 0
    ) {
      throw new AppError(
        "RGP ID must be a valid positive integer",
        STATUS_CODES.BAD_REQUEST,
      );
    }

    // ============================================================
    // Action
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
      throw new AppError(
        "Action must be CHECKOUT or CANCEL",
        STATUS_CODES.BAD_REQUEST,
      );
    }

    // ============================================================
    // Remarks
    // CANCEL ke liye required
    // ============================================================

    const remarks = String(
      Remarks || "",
    ).trim();

    if (
      action === "CANCEL" &&
      !remarks
    ) {
      throw new AppError(
        "Remarks are required for CANCEL",
        STATUS_CODES.BAD_REQUEST,
      );
    }

    // ============================================================
    // Queue
    // ============================================================

    return sendQueueResponse(
      req,
      res,
      "PROCESS_RGP_GATE_ACTION",
      {
        RGPID:
          Number(RGPID),

        Action:
          action,

        Remarks:
          remarks || null,
      },
    );
  } catch (error) {
    return handleError(
      error,
      res,
    );
  }
};
// ============================================================PROCESS RGP ITEM RETURN
exports.processRGPItemReturn = async (req, res) => {
  try {
    const {
      RGPID,
      Items,
      Remarks,
    } = req.body || {};

    // ============================================================
    // RGP ID
    // ============================================================

    if (
      !RGPID ||
      !Number.isInteger(Number(RGPID)) ||
      Number(RGPID) <= 0
    ) {
      throw new AppError(
        "RGP ID must be a valid positive integer",
        STATUS_CODES.BAD_REQUEST,
      );
    }

    // ============================================================
    // Items
    // ============================================================

    if (
      !Array.isArray(Items) ||
      Items.length === 0
    ) {
      throw new AppError(
        "At least one return item is required",
        STATUS_CODES.BAD_REQUEST,
      );
    }

    const returnItems = Items.map(
      (item, index) => {
        const RGPItemID =
          Number(item.RGPItemID);

        const QuantityReceived =
          Number(item.QuantityReceived);

        if (
          !Number.isInteger(RGPItemID) ||
          RGPItemID <= 0
        ) {
          throw new AppError(
            `Valid RGPItemID is required for item ${index + 1}`,
            STATUS_CODES.BAD_REQUEST,
          );
        }

        if (
          !Number.isFinite(QuantityReceived) ||
          QuantityReceived <= 0
        ) {
          throw new AppError(
            `QuantityReceived must be greater than 0 for item ${index + 1}`,
            STATUS_CODES.BAD_REQUEST,
          );
        }

        return {
          RGPItemID,
          QuantityReceived,

          Remarks:
            String(
              item.Remarks || "",
            ).trim() || null,
        };
      },
    );

    // ============================================================
    // Duplicate Item Check
    // ============================================================

    const itemIDs =
      returnItems.map(
        (item) =>
          item.RGPItemID,
      );

    if (
      new Set(itemIDs).size !==
      itemIDs.length
    ) {
      throw new AppError(
        "Duplicate RGPItemID is not allowed",
        STATUS_CODES.BAD_REQUEST,
      );
    }

    // ============================================================
    // Queue
    // ============================================================

    return sendQueueResponse(
      req,
      res,
      "PROCESS_RGP_ITEM_RETURN",
      {
        RGPID:
          Number(RGPID),

        Items:
          returnItems,

        Remarks:
          String(
            Remarks || "",
          ).trim() || null,
      },
    );
  } catch (error) {
    return handleError(
      error,
      res,
    );
  }
};
// ============================================================GET RGP APPROVAL CONFIG
exports.getRGPApprovalConfig = async (req, res) => {
  try {
    const {
      OrganizationID,
    } = req.query;

    if (
      !OrganizationID ||
      !Number.isInteger(Number(OrganizationID)) ||
      Number(OrganizationID) <= 0
    ) {
      throw new AppError(
        "Organization ID must be a valid positive integer",
        STATUS_CODES.BAD_REQUEST,
      );
    }

    const result =
      await GatepassService.getRGPApprovalConfig({
        OrganizationID:
          Number(OrganizationID),

        UserID:
          req.user?.UserID,

        UserType:
          req.user?.UserType,

        DepartmentName:
          req.user?.DepartmentName,

        LoginType:
          req.user?.LoginType,

        AllOrganizationAccess:
          req.user?.AllOrganizationAccess,
      });

    return res
      .status(
        result.statusCode ||
        STATUS_CODES.SUCCESS,
      )
      .json(result);
  } catch (error) {
    return handleError(
      error,
      res,
    );
  }
};
// ============================================================SAVE RGP APPROVAL CONFIG
exports.saveRGPApprovalConfig = async (req, res) => {
  try {
    const {
      OrganizationID,
      ApprovalFlow,
    } = req.body || {};

    // ============================================================
    // Organization
    // ============================================================

    if (
      !OrganizationID ||
      !Number.isInteger(Number(OrganizationID)) ||
      Number(OrganizationID) <= 0
    ) {
      throw new AppError(
        "Organization ID must be a valid positive integer",
        STATUS_CODES.BAD_REQUEST,
      );
    }

    // ============================================================
    // Approval Flow
    // ============================================================

    if (
      !Array.isArray(ApprovalFlow) ||
      ApprovalFlow.length === 0
    ) {
      throw new AppError(
        "ApprovalFlow must contain at least one approval level",
        STATUS_CODES.BAD_REQUEST,
      );
    }

    const normalizedFlow =
      ApprovalFlow.map(
        (item, index) => {
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

          // ======================================================
          // Approval Level
          // ======================================================

          if (
            !Number.isInteger(
              approvalLevel,
            ) ||
            approvalLevel <= 0
          ) {
            throw new AppError(
              `Valid ApprovalLevel is required for approval ${index + 1}`,
              STATUS_CODES.BAD_REQUEST,
            );
          }

          // ======================================================
          // Approval Order
          // ======================================================

          if (
            !Number.isInteger(
              approvalOrder,
            ) ||
            approvalOrder <= 0
          ) {
            throw new AppError(
              `Valid ApprovalOrder is required for approval ${index + 1}`,
              STATUS_CODES.BAD_REQUEST,
            );
          }

          // ======================================================
          // Dynamic Approval Role
          // ======================================================

          if (!approvalRole) {
            throw new AppError(
              `ApprovalRole is required for approval ${index + 1}`,
              STATUS_CODES.BAD_REQUEST,
            );
          }

          return {
            ApprovalLevel:
              approvalLevel,

            ApprovalRole:
              approvalRole,

            ApprovalOrder:
              approvalOrder,

            IsMandatory:
              item.IsMandatory !== false,
          };
        },
      );

    // ============================================================
    // Duplicate Approval Order Check
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
      throw new AppError(
        "Duplicate ApprovalOrder is not allowed",
        STATUS_CODES.BAD_REQUEST,
      );
    }

    // ============================================================
    // Duplicate Approval Level Check
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
      throw new AppError(
        "Duplicate ApprovalLevel is not allowed",
        STATUS_CODES.BAD_REQUEST,
      );
    }

    // ============================================================
    // Queue
    // ============================================================

    return sendQueueResponse(
      req,
      res,
      "SAVE_RGP_APPROVAL_CONFIG",
      {
        OrganizationID:
          Number(OrganizationID),

        ApprovalFlow:
          normalizedFlow,
      },
    );
  } catch (error) {
    return handleError(
      error,
      res,
    );
  }
};
// ============================================================DELETE RGP APPROVAL CONFIG
exports.deleteRGPApprovalConfig = async (req, res) => {
  try {
    const {
      RGPApprovalConfigID,
    } = req.body || {};

    if (
      !RGPApprovalConfigID ||
      !Number.isSafeInteger(Number(RGPApprovalConfigID)) ||
      Number(RGPApprovalConfigID) <= 0
    ) {
      throw new AppError(
        "RGP approval config ID must be a valid positive integer",
        STATUS_CODES.BAD_REQUEST,
      );
    }

    return sendQueueResponse(
      req,
      res,
      "DELETE_RGP_APPROVAL_CONFIG",
      {
        RGPApprovalConfigID:
          Number(
            RGPApprovalConfigID,
          ),
      },
    );
  } catch (error) {
    return handleError(
      error,
      res,
    );
  }
};
// ========================================================================Reports
// ============================================================RGP List Report
exports.getRGPListReport = async (
  req,
  res,
) => {
  try {
    const {
      OrganizationID,
      FromDate,
      ToDate,
      Status,
      DepartmentID,
      RGPNumber,
      VendorName,
      Search,
      page = 1,
      PageSize = 10,
    } = req.query;

    // ============================================================
    // Organization Validation
    // ============================================================

    if (
      !OrganizationID ||
      !Number.isInteger(
        Number(OrganizationID),
      ) ||
      Number(OrganizationID) <= 0
    ) {
      return res.status(400).json({
        success: false,
        message:
          "Valid OrganizationID is required.",
      });
    }

    // ============================================================
    // Department Validation
    // ============================================================

    if (
      DepartmentID &&
      (
        !Number.isInteger(
          Number(DepartmentID),
        ) ||
        Number(DepartmentID) <= 0
      )
    ) {
      return res.status(400).json({
        success: false,
        message:
          "DepartmentID must be a positive integer.",
      });
    }

    // ============================================================
    // RGP Number Validation
    // ============================================================

    if (
      RGPNumber &&
      (
        !Number.isInteger(
          Number(RGPNumber),
        ) ||
        Number(RGPNumber) <= 0
      )
    ) {
      return res.status(400).json({
        success: false,
        message:
          "RGPNumber must be a positive integer.",
      });
    }

    // ============================================================
    // Pagination Validation
    // ============================================================

    const pageNumber = Number(page);
    const pageSizeNumber =
      Number(PageSize);

    if (
      !Number.isInteger(pageNumber) ||
      pageNumber <= 0
    ) {
      return res.status(400).json({
        success: false,
        message:
          "page must be a positive integer.",
      });
    }

    if (
      !Number.isInteger(
        pageSizeNumber,
      ) ||
      pageSizeNumber <= 0 ||
      pageSizeNumber > 100
    ) {
      return res.status(400).json({
        success: false,
        message:
          "PageSize must be between 1 and 100.",
      });
    }

    const result =
      await GatepassService.getRGPListReport({
        OrganizationID:
          Number(OrganizationID),

        FromDate:
          FromDate || null,

        ToDate:
          ToDate || null,

        Status:
          Status || null,

        DepartmentID:
          DepartmentID
            ? Number(DepartmentID)
            : null,

        RGPNumber:
          RGPNumber
            ? Number(RGPNumber)
            : null,

        VendorName:
          VendorName || null,

        Search:
          Search || null,

        page: pageNumber,
        PageSize:
          pageSizeNumber,

        UserID:
          req.user?.UserID,

        UserType:
          req.user?.UserType,

        DepartmentName:
          req.user?.DepartmentName,

        LoginType:
          req.user?.LoginType,

        AllOrganizationAccess:
          req.user
            ?.AllOrganizationAccess,
      });

    return res
      .status(
        result.statusCode || 200,
      )
      .json(result);

  } catch (error) {
    console.error(
      "Get RGP List Report Controller Error:",
      error,
    );

    return res.status(500).json({
      success: false,
      message:
        "Unable to fetch RGP list report.",
    });
  }
};
// ============================================================Department Wise Report
exports.getRGPDepartmentWiseReport =async (req, res) => {
    try {
      const {
        OrganizationID,
        FromDate,
        ToDate,
        DepartmentID,
        Search,
        page = 1,
        PageSize = 10,
      } = req.query;

      // Organization
      if (
        !OrganizationID ||
        !Number.isInteger(
          Number(OrganizationID),
        ) ||
        Number(OrganizationID) <= 0
      ) {
        return res
          .status(400)
          .json({
            success: false,
            message:
              "Valid OrganizationID is required.",
          });
      }

      // Department
      if (
        DepartmentID &&
        (
          !Number.isInteger(
            Number(DepartmentID),
          ) ||
          Number(DepartmentID) <= 0
        )
      ) {
        return res
          .status(400)
          .json({
            success: false,
            message:
              "DepartmentID must be a positive integer.",
          });
      }

      // Pagination
      const pageNumber =
        Number(page);

      const pageSizeNumber =
        Number(PageSize);

      if (
        !Number.isInteger(
          pageNumber,
        ) ||
        pageNumber <= 0
      ) {
        return res
          .status(400)
          .json({
            success: false,
            message:
              "page must be a positive integer.",
          });
      }

      if (
        !Number.isInteger(
          pageSizeNumber,
        ) ||
        pageSizeNumber <= 0 ||
        pageSizeNumber > 100
      ) {
        return res
          .status(400)
          .json({
            success: false,
            message:
              "PageSize must be between 1 and 100.",
          });
      }

      const result =
        await GatepassService
          .getRGPDepartmentWiseReport({
            OrganizationID:
              Number(
                OrganizationID,
              ),

            FromDate:
              FromDate || null,

            ToDate:
              ToDate || null,

            DepartmentID:
              DepartmentID
                ? Number(
                    DepartmentID,
                  )
                : null,

            Search:
              Search || null,

            page:
              pageNumber,

            PageSize:
              pageSizeNumber,

            UserID:
              req.user?.UserID,

            UserType:
              req.user?.UserType,

            DepartmentName:
              req.user
                ?.DepartmentName,

            LoginType:
              req.user
                ?.LoginType,

            AllOrganizationAccess:
              req.user
                ?.AllOrganizationAccess,
          });

      return res
        .status(
          result.statusCode ||
            200,
        )
        .json(result);

    } catch (error) {
      console.error(
        "RGP Department Wise Report Controller Error:",
        error,
      );

      return res
        .status(500)
        .json({
          success: false,
          message:
            "Unable to fetch RGP department wise report.",
        });
    }
};
// ============================================================RGP Vendor Wise Report
exports.getRGPVendorWiseReport =async (req, res) => {
    try {
      const {
        OrganizationID,
        FromDate,
        ToDate,
        VendorName,
        Search,
        page = 1,
        PageSize = 10,
      } = req.query;

      // ============================================================
      // Organization Validation
      // ============================================================

      if (
        !OrganizationID ||
        !Number.isInteger(
          Number(OrganizationID),
        ) ||
        Number(OrganizationID) <= 0
      ) {
        return res
          .status(400)
          .json({
            success: false,
            message:
              "Valid OrganizationID is required.",
          });
      }

      // ============================================================
      // Pagination Validation
      // ============================================================

      const pageNumber =
        Number(page);

      const pageSizeNumber =
        Number(PageSize);

      if (
        !Number.isInteger(
          pageNumber,
        ) ||
        pageNumber <= 0
      ) {
        return res
          .status(400)
          .json({
            success: false,
            message:
              "page must be a positive integer.",
          });
      }

      if (
        !Number.isInteger(
          pageSizeNumber,
        ) ||
        pageSizeNumber <= 0 ||
        pageSizeNumber > 100
      ) {
        return res
          .status(400)
          .json({
            success: false,
            message:
              "PageSize must be between 1 and 100.",
          });
      }

      const result =
        await GatepassService
          .getRGPVendorWiseReport({
            OrganizationID:
              Number(
                OrganizationID,
              ),

            FromDate:
              FromDate || null,

            ToDate:
              ToDate || null,

            VendorName:
              VendorName || null,

            Search:
              Search || null,

            page:
              pageNumber,

            PageSize:
              pageSizeNumber,

            UserID:
              req.user?.UserID,

            UserType:
              req.user?.UserType,

            DepartmentName:
              req.user
                ?.DepartmentName,

            LoginType:
              req.user
                ?.LoginType,

            AllOrganizationAccess:
              req.user
                ?.AllOrganizationAccess,
          });

      return res
        .status(
          result.statusCode ||
            200,
        )
        .json(result);

    } catch (error) {
      console.error(
        "RGP Vendor Wise Report Controller Error:",
        error,
      );

      return res
        .status(500)
        .json({
          success: false,
          message:
            "Unable to fetch RGP vendor wise report.",
        });
    }
};
// ============================================================Pending Return Item Report
exports.getRGPPendingReturnReport =async (req, res) => {
    try {
      const {
        OrganizationID,
        FromDate,
        ToDate,
        DepartmentID,
        RGPNumber,
        VendorName,
        Search,
        page = 1,
        PageSize = 10,
      } = req.query;

      // ============================================================
      // Organization Validation
      // ============================================================

      if (
        !OrganizationID ||
        !Number.isInteger(
          Number(OrganizationID),
        ) ||
        Number(OrganizationID) <= 0
      ) {
        return res
          .status(400)
          .json({
            success: false,
            message:
              "Valid OrganizationID is required.",
          });
      }

      // ============================================================
      // Department Validation
      // ============================================================

      if (
        DepartmentID &&
        (
          !Number.isInteger(
            Number(DepartmentID),
          ) ||
          Number(DepartmentID) <= 0
        )
      ) {
        return res
          .status(400)
          .json({
            success: false,
            message:
              "DepartmentID must be a positive integer.",
          });
      }

      // ============================================================
      // RGP Number Validation
      // ============================================================

      if (
        RGPNumber &&
        (
          !Number.isInteger(
            Number(RGPNumber),
          ) ||
          Number(RGPNumber) <= 0
        )
      ) {
        return res
          .status(400)
          .json({
            success: false,
            message:
              "RGPNumber must be a positive integer.",
          });
      }

      // ============================================================
      // Pagination Validation
      // ============================================================

      const pageNumber =
        Number(page);

      const pageSizeNumber =
        Number(PageSize);

      if (
        !Number.isInteger(
          pageNumber,
        ) ||
        pageNumber <= 0
      ) {
        return res
          .status(400)
          .json({
            success: false,
            message:
              "page must be a positive integer.",
          });
      }

      if (
        !Number.isInteger(
          pageSizeNumber,
        ) ||
        pageSizeNumber <= 0 ||
        pageSizeNumber > 100
      ) {
        return res
          .status(400)
          .json({
            success: false,
            message:
              "PageSize must be between 1 and 100.",
          });
      }

      const result =
        await GatepassService
          .getRGPPendingReturnReport({
            OrganizationID:
              Number(
                OrganizationID,
              ),

            FromDate:
              FromDate || null,

            ToDate:
              ToDate || null,

            DepartmentID:
              DepartmentID
                ? Number(
                    DepartmentID,
                  )
                : null,

            RGPNumber:
              RGPNumber
                ? Number(
                    RGPNumber,
                  )
                : null,

            VendorName:
              VendorName || null,

            Search:
              Search || null,

            page:
              pageNumber,

            PageSize:
              pageSizeNumber,

            UserID:
              req.user?.UserID,

            UserType:
              req.user?.UserType,

            DepartmentName:
              req.user
                ?.DepartmentName,

            LoginType:
              req.user
                ?.LoginType,

            AllOrganizationAccess:
              req.user
                ?.AllOrganizationAccess,
          });

      return res
        .status(
          result.statusCode ||
            200,
        )
        .json(result);

    } catch (error) {
      console.error(
        "RGP Pending Return Report Controller Error:",
        error,
      );

      return res
        .status(500)
        .json({
          success: false,
          message:
            "Unable to fetch RGP pending return report.",
        });
    }
};