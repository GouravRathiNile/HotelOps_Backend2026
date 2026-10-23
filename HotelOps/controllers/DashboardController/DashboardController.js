// ============================================================ RabbitMQ
const producer = require("../../producer/producer");
const QUEUE = require("../../config/queue");
// ============================================================ Error Handling
const STATUS_CODES = require("../../utils/statusCodes");
const AppError = require("../../utils/AppError");
const handleError = require("../../utils/errorHandler");
// ============================================================ Service
const DashboardService = require("../../services/DashboardService/DashboardService",);// Dashboard request handlers.

// ==============================================================================================CEO Dashboard 
// 1.=============================================================Top Drr Revenre Data
exports.getCEORevenueSummary = async (req, res) => {
  try {
    const { Filter = "monthly", OrganizationID } = req.query;

    // ========================================================
    // Filter Validation
    // ========================================================

    const filter = String(Filter).trim().toLowerCase();

    if (
      !["yesterday", "weekly", "monthly", "yearly"]
        .includes(filter)
    ) {
      throw new AppError(
        "Filter must be yesterday, weekly, monthly or yearly.",
        STATUS_CODES.BAD_REQUEST
      );
    }

    // ========================================================
    // Service
    // ========================================================

    const result =
      await DashboardService.getCEORevenueSummary({
        Filter: filter,
        OrganizationID,
      });

    if (!result.success) {
      throw new AppError(
        result.message,
        result.statusCode || STATUS_CODES.BAD_REQUEST
      );
    }

    return res
      .status(STATUS_CODES.SUCCESS)
      .json(result);

  } catch (error) {
    return handleError(error, res);
  }
};
// 2. ============================================================ Get CEO Occupancy
exports.getCEOOccupancy = async (req, res) => {
  try {
    const { Filter = "yesterday" } = req.query;

    // ========================================================
    // Filter Validation
    // ========================================================

    const filter = String(Filter).trim().toLowerCase();

    if (
      !["yesterday", "weekly", "monthly", "yearly"].includes(filter)
    ) {
      throw new AppError(
        "Filter must be yesterday, weekly, monthly or yearly.",
        STATUS_CODES.BAD_REQUEST
      );
    }

    // ========================================================
    // Service
    // ========================================================

    const result = await DashboardService.getCEOOccupancy({
      Filter: filter,
    });

    if (!result.success) {
      throw new AppError(
        result.message,
        result.statusCode || STATUS_CODES.BAD_REQUEST
      );
    }

    return res.status(STATUS_CODES.SUCCESS).json(result);

  } catch (error) {
    return handleError(error, res);
  }
};
// 3. ============================================================ Critical Alerts
// 3.1. ============================================Glitch
exports.getCEOGlitchAlerts = async (req, res) => {
  try {
    const {
      OrganizationID,
    } = req.query;

    // ========================================================
    // Service
    // ========================================================

    const result =
      await DashboardService.getCEOGlitchAlerts({
        OrganizationID,
      });

    if (!result.success) {
      throw new AppError(
        result.message,
        result.statusCode || STATUS_CODES.BAD_REQUEST
      );
    }

    return res
      .status(STATUS_CODES.SUCCESS)
      .json(result);

  } catch (error) {
    return handleError(error, res);
  }
};
// 3.2. ============================================Incident
exports.getCEOIncidentAlerts = async (req, res) => {
  try {
    const {
      Filter = "yesterday",
      OrganizationID,
    } = req.query;

    // ========================================================
    // Filter Validation
    // ========================================================

    const filter = String(Filter).trim().toLowerCase();

    if (
      !["yesterday", "weekly", "monthly", "yearly"]
        .includes(filter)
    ) {
      throw new AppError(
        "Filter must be yesterday, weekly, monthly or yearly.",
        STATUS_CODES.BAD_REQUEST
      );
    }

    // ========================================================
    // Service
    // ========================================================

    const result =
      await DashboardService.getCEOIncidentAlerts({
        OrganizationID,
        Filter: filter,
      });

    if (!result.success) {
      throw new AppError(
        result.message,
        result.statusCode || STATUS_CODES.BAD_REQUEST
      );
    }

    return res
      .status(STATUS_CODES.SUCCESS)
      .json(result);

  } catch (error) {
    return handleError(error, res);
  }
};
// 3.3 ============================================Engineering Expired AMC
exports.getCEOExpiredAMCAlerts = async (req, res) => {
  try {
    const {
      Filter = "yesterday",
      OrganizationID,
    } = req.query;

    // ========================================================
    // Filter Validation
    // ========================================================

    const filter = String(Filter).trim().toLowerCase();

    if (
      !["yesterday", "weekly", "monthly", "yearly"]
        .includes(filter)
    ) {
      throw new AppError(
        "Filter must be yesterday, weekly, monthly or yearly.",
        STATUS_CODES.BAD_REQUEST
      );
    }

    // ========================================================
    // Service
    // ========================================================

    const result =
      await DashboardService.getCEOExpiredAMCAlerts({
        OrganizationID,
        Filter: filter,
      });

    if (!result.success) {
      throw new AppError(
        result.message,
        result.statusCode || STATUS_CODES.BAD_REQUEST
      );
    }

    return res
      .status(STATUS_CODES.SUCCESS)
      .json(result);

  } catch (error) {
    return handleError(error, res);
  }
};
// 4. ============================================================ Hotel Revenue vs Budget
exports.getCEOHotelRevenueVsBudget = async (req, res) => {
  try {
    const { BusinessDate, OrganizationID } = req.query;

    // ========================================================
    // Business Date Validation
    // ========================================================

    if (BusinessDate !== undefined) {
      if (
        typeof BusinessDate !== "string" ||
        !/^\d{4}-\d{2}-\d{2}$/.test(BusinessDate)
      ) {
        throw new AppError(
          "BusinessDate must be in YYYY-MM-DD format.",
          STATUS_CODES.BAD_REQUEST
        );
      }

      const parsedDate = new Date(
        `${BusinessDate}T00:00:00.000Z`
      );

      if (
        Number.isNaN(parsedDate.getTime()) ||
        parsedDate.toISOString().slice(0, 10) !== BusinessDate
      ) {
        throw new AppError(
          "Invalid BusinessDate.",
          STATUS_CODES.BAD_REQUEST
        );
      }
    }

    // ========================================================
    // Service
    // ========================================================

    const result =
      await DashboardService.getCEOHotelRevenueVsBudget({
        OrganizationID,
        BusinessDate: BusinessDate || null,
      });

    if (!result.success) {
      throw new AppError(
        result.message,
        result.statusCode || STATUS_CODES.BAD_REQUEST
      );
    }

    return res
      .status(STATUS_CODES.SUCCESS)
      .json(result);

  } catch (error) {
    return handleError(error, res);
  }
};
// 5. ============================================================ DSR Trend
exports.getCEODSRChart = async (req, res) => {
  try {
    const {
      Filter = "yearly",
      OrganizationID,
    } = req.query;

    // ========================================================
    // Filter Validation
    // ========================================================

    const filter = String(Filter).trim().toLowerCase();

    if (
      !["yesterday", "weekly", "monthly", "yearly"]
        .includes(filter)
    ) {
      throw new AppError(
        "Filter must be yesterday, weekly, monthly or yearly.",
        STATUS_CODES.BAD_REQUEST
      );
    }

    // ========================================================
    // OrganizationID Validation
    // ========================================================

    if (
      OrganizationID !== undefined &&
      String(OrganizationID).trim() !== ""
    ) {
      const orgID = String(OrganizationID).trim();

      if (
        !/^[1-9]\d*$/.test(orgID) ||
        BigInt(orgID) > 9223372036854775807n
      ) {
        throw new AppError(
          "OrganizationID must be a positive integer.",
          STATUS_CODES.BAD_REQUEST
        );
      }
    }

    // ========================================================
    // Service
    // ========================================================

    const result =
      await DashboardService.getCEODSRChart({
        Filter: filter,
        OrganizationID: OrganizationID || null,
      });

    if (!result.success) {
      throw new AppError(
        result.message,
        result.statusCode || STATUS_CODES.BAD_REQUEST
      );
    }

    return res
      .status(STATUS_CODES.SUCCESS)
      .json(result);

  } catch (error) {
    return handleError(error, res);
  }
};
// 5.1. ============================================================ DSR Details
exports.getCEODSRVisitDetails = async (req, res) => {
  try {
    const {
      OrganizationID,
      Filter = "yesterday",
      page = 1,
      PageSize = 10,
    } = req.query;

    // ========================================================
    // 2. OrganizationID Validation
    // ========================================================

    const orgID = OrganizationID == null
      ? ""
      : String(OrganizationID).trim();

    if (
      !/^[1-9]\d*$/.test(orgID) ||
      BigInt(orgID) > 9223372036854775807n
    ) {
      throw new AppError(
        "Valid OrganizationID is required.",
        STATUS_CODES.BAD_REQUEST
      );
    }

    // ========================================================
    // 3. Filter Validation
    // ========================================================

    const filter = String(Filter).trim().toLowerCase();

    if (
      !["yesterday", "weekly", "monthly", "yearly"]
        .includes(filter)
    ) {
      throw new AppError(
        "Filter must be yesterday, weekly, monthly or yearly.",
        STATUS_CODES.BAD_REQUEST
      );
    }

    // ========================================================
    // 4. Pagination Validation
    // ========================================================

    if (
      !Number.isSafeInteger(Number(page)) ||
      Number(page) <= 0
    ) {
      throw new AppError(
        "Page must be a positive integer.",
        STATUS_CODES.BAD_REQUEST
      );
    }

    if (
      !Number.isSafeInteger(Number(PageSize)) ||
      Number(PageSize) < 1 ||
      Number(PageSize) > 100
    ) {
      throw new AppError(
        "PageSize must be between 1 and 100.",
        STATUS_CODES.BAD_REQUEST
      );
    }

    // ========================================================
    // 5. Service
    // ========================================================

    const result =
      await DashboardService.getCEODSRVisitDetails({
        OrganizationID: orgID,
        Filter: filter,
        page: Number(page),
        PageSize: Number(PageSize),
      });

    // ========================================================
    // 6. Response
    // ========================================================

    if (!result.success) {
      throw new AppError(
        result.message,
        result.statusCode || STATUS_CODES.BAD_REQUEST
      );
    }

    return res
      .status(STATUS_CODES.SUCCESS)
      .json(result);

  } catch (error) {
    return handleError(error, res);
  }
};
// 6. ============================================================ Total SRMS Requests
exports.getCEOSRMSRequests = async (req, res) => {
  try {
    const result =
      await DashboardService.getCEOSRMSRequests({
        ...req.query,
      });

    return res
      .status(
        result.success
          ? 200
          : result.statusCode || 500
      )
      .json(result);

  } catch (error) {
    console.error(
      "getCEOSRMSRequests Controller Error:",
      error
    );

    return res.status(500).json({
      success: false,
      message: "Internal server error.",
    });
  }
};
// 6.1. ============================================================ Total SRMS Requests Details
exports.getCEOSRMSRequestDetails = async (req, res) => {
  try {
    const {
      OrganizationID,
      Filter = "yesterday",
      page = 1,
      PageSize = 10,
    } = req.query;

    // ========================================================
    // 2. Filter Validation
    // ========================================================

    const filter = String(Filter).trim().toLowerCase();

    if (
      !["yesterday", "weekly", "monthly", "yearly"]
        .includes(filter)
    ) {
      throw new AppError(
        "Filter must be yesterday, weekly, monthly or yearly.",
        STATUS_CODES.BAD_REQUEST
      );
    }

    // ========================================================
    // 3. OrganizationID Validation
    // ========================================================

    const orgID = OrganizationID == null
      ? ""
      : String(OrganizationID).trim();

    if (
      orgID !== "" &&
      (
        !/^[1-9]\d*$/.test(orgID) ||
        BigInt(orgID) > 9223372036854775807n
      )
    ) {
      throw new AppError(
        "OrganizationID must be a positive integer.",
        STATUS_CODES.BAD_REQUEST
      );
    }

    // ========================================================
    // 4. Pagination Validation
    // ========================================================

    if (
      !Number.isSafeInteger(Number(page)) ||
      Number(page) <= 0
    ) {
      throw new AppError(
        "Page must be a positive integer.",
        STATUS_CODES.BAD_REQUEST
      );
    }

    if (
      !Number.isSafeInteger(Number(PageSize)) ||
      Number(PageSize) < 1 ||
      Number(PageSize) > 100
    ) {
      throw new AppError(
        "PageSize must be between 1 and 100.",
        STATUS_CODES.BAD_REQUEST
      );
    }

    // ========================================================
    // 5. Service
    // ========================================================

    const result =
      await DashboardService.getCEOSRMSRequestDetails({
        OrganizationID: orgID || null,
        Filter: filter,
        page: Number(page),
        PageSize: Number(PageSize),
      });

    // ========================================================
    // 6. Response
    // ========================================================

    if (!result.success) {
      throw new AppError(
        result.message,
        result.statusCode || STATUS_CODES.BAD_REQUEST
      );
    }

    return res
      .status(STATUS_CODES.SUCCESS)
      .json(result);

  } catch (error) {
    return handleError(error, res);
  }
};
// 7. ============================================================ Top 20 SRMS Requests
exports.getCEOTop20SRMSRequests = async (req, res) => {
  try {
    const {
      Filter = "yearly",
      OrganizationID,
    } = req.query;

    // ========================================================
    // 2. Filter Validation
    // ========================================================

    const filter = String(Filter).trim().toLowerCase();

    if (
      !["yesterday", "weekly", "monthly", "yearly"]
        .includes(filter)
    ) {
      throw new AppError(
        "Filter must be yesterday, weekly, monthly or yearly.",
        STATUS_CODES.BAD_REQUEST
      );
    }

    // ========================================================
    // 3. OrganizationID Validation
    // ========================================================

    if (
      OrganizationID !== undefined &&
      String(OrganizationID).trim() !== ""
    ) {
      const orgID = String(OrganizationID).trim();

      if (
        !/^[1-9]\d*$/.test(orgID) ||
        BigInt(orgID) > 9223372036854775807n
      ) {
        throw new AppError(
          "OrganizationID must be a positive integer.",
          STATUS_CODES.BAD_REQUEST
        );
      }
    }

    // ========================================================
    // 4. Service
    // ========================================================

    const result =
      await DashboardService.getCEOTop20SRMSRequests({
        Filter: filter,
        OrganizationID: OrganizationID || null,
      });

    if (!result.success) {
      throw new AppError(
        result.message,
        result.statusCode || STATUS_CODES.BAD_REQUEST
      );
    }

    return res
      .status(STATUS_CODES.SUCCESS)
      .json(result);

  } catch (error) {
    return handleError(error, res);
  }
};
// 7.1. ============================================================ Top 20 SRMS Requests Details
exports.getCEOTop20SRMSRequestDetails = async (req, res) => {
  try {
    const {
      OrganizationID,
      Request,
      Filter = "yearly",
      page = 1,
      PageSize = 10,
    } = req.query;

    // ========================================================
    // 2. Request Validation
    // ========================================================
    if (
      typeof Request !== "string" ||
      !Request.trim() ||
      Request.length > 500
    ) {
      throw new AppError(
        "Request is required and must be within 500 characters.",
        STATUS_CODES.BAD_REQUEST
      );
    }

    // ========================================================
    // 3. Filter Validation
    // ========================================================
    const filter = String(Filter).trim().toLowerCase();

    if (
      !["yesterday", "weekly", "monthly", "yearly"]
        .includes(filter)
    ) {
      throw new AppError(
        "Filter must be yesterday, weekly, monthly or yearly.",
        STATUS_CODES.BAD_REQUEST
      );
    }

    // ========================================================
    // 4. OrganizationID Validation
    // ========================================================
    const orgID = OrganizationID == null
      ? ""
      : String(OrganizationID).trim();

    if (
      orgID !== "" &&
      (
        !/^[1-9]\d*$/.test(orgID) ||
        BigInt(orgID) > 9223372036854775807n
      )
    ) {
      throw new AppError(
        "OrganizationID must be a positive integer.",
        STATUS_CODES.BAD_REQUEST
      );
    }

    // ========================================================
    // 5. Pagination Validation
    // ========================================================
    if (
      !Number.isSafeInteger(Number(page)) ||
      Number(page) <= 0 ||
      !Number.isSafeInteger(Number(PageSize)) ||
      Number(PageSize) < 1 ||
      Number(PageSize) > 100
    ) {
      throw new AppError(
        "Invalid page or PageSize.",
        STATUS_CODES.BAD_REQUEST
      );
    }

    // ========================================================
    // 6. Service
    // ========================================================
    const result =
      await DashboardService.getCEOTop20SRMSRequestDetails({
        OrganizationID: orgID || null,
        Request: Request,
        Filter: filter,
        page: Number(page),
        PageSize: Number(PageSize),
      });

    // ========================================================
    // 7. Response
    // ========================================================
    if (!result.success) {
      throw new AppError(
        result.message,
        result.statusCode || STATUS_CODES.BAD_REQUEST
      );
    }

    return res
      .status(STATUS_CODES.SUCCESS)
      .json(result);

  } catch (error) {
    return handleError(error, res);
  }
};
// 8. ============================================================ SRMS Requests Completion Duration in Minutes
exports.getCEOSRMSCompletionDuration = async (req, res) => {
  try {
    const { Filter = "yesterday", OrganizationID } = req.query;

    // ========================================================
    // 2. Filter Validation
    // ========================================================

    const filter = String(Filter).trim().toLowerCase();

    if (
      !["yesterday", "weekly", "monthly", "yearly"]
        .includes(filter)
    ) {
      throw new AppError(
        "Filter must be yesterday, weekly, monthly or yearly.",
        STATUS_CODES.BAD_REQUEST
      );
    }

    // ========================================================
    // 3. Service
    // ========================================================

    const result =
      await DashboardService.getCEOSRMSCompletionDuration({
        Filter: filter,
        OrganizationID,
      });

    if (!result.success) {
      throw new AppError(
        result.message,
        result.statusCode || STATUS_CODES.BAD_REQUEST
      );
    }

    return res
      .status(STATUS_CODES.SUCCESS)
      .json(result);

  } catch (error) {
    return handleError(error, res);
  }
};
// 8.1. ============================================================ SRMS Requests Completion Duration in Minutes Details
exports.getCEOSRMSCompletionDurationDetails = async (req, res) => {
  try {
    const {
      OrganizationID,
      CD,
      Filter = "yesterday",
      page = 1,
      PageSize = 10,
    } = req.query;

    // ========================================================
    // 2. CD Validation
    // ========================================================
    if (
      CD === undefined ||
      String(CD).trim() === "" ||
      !Number.isInteger(Number(CD)) ||
      Number(CD) < 1 ||
      Number(CD) > 8
    ) {
      throw new AppError(
        "CD must be between 1 and 8.",
        STATUS_CODES.BAD_REQUEST
      );
    }

    // ========================================================
    // 3. Filter Validation
    // ========================================================
    const filter = String(Filter).trim().toLowerCase();

    if (
      !["yesterday", "weekly", "monthly", "yearly"]
        .includes(filter)
    ) {
      throw new AppError(
        "Invalid date filter.",
        STATUS_CODES.BAD_REQUEST
      );
    }

    // ========================================================
    // 4. OrganizationID Validation
    // ========================================================
    const orgID = OrganizationID == null
      ? ""
      : String(OrganizationID).trim();

    if (
      orgID !== "" &&
      (
        !/^[1-9]\d*$/.test(orgID) ||
        BigInt(orgID) > 9223372036854775807n
      )
    ) {
      throw new AppError(
        "OrganizationID must be a positive integer.",
        STATUS_CODES.BAD_REQUEST
      );
    }

    // ========================================================
    // 5. Pagination Validation
    // ========================================================
    if (
      !Number.isSafeInteger(Number(page)) ||
      Number(page) <= 0 ||
      !Number.isSafeInteger(Number(PageSize)) ||
      Number(PageSize) < 1 ||
      Number(PageSize) > 100
    ) {
      throw new AppError(
        "Invalid page or PageSize.",
        STATUS_CODES.BAD_REQUEST
      );
    }

    // ========================================================
    // 6. Service
    // ========================================================
    const result =
      await DashboardService.getCEOSRMSCompletionDurationDetails({
        OrganizationID: orgID || null,
        CD: Number(CD),
        Filter: filter,
        page: Number(page),
        PageSize: Number(PageSize),
      });

    // ========================================================
    // 7. Response
    // ========================================================
    if (!result.success) {
      throw new AppError(
        result.message,
        result.statusCode || STATUS_CODES.BAD_REQUEST
      );
    }

    return res
      .status(STATUS_CODES.SUCCESS)
      .json(result);

  } catch (error) {
    return handleError(error, res);
  }
};
// 9. ============================================================ Guest Met Trend
exports.getCEOGuestMetChart = async (req, res) => {
  try {
    const {
      Filter = "yearly",
      OrganizationID,
    } = req.query;

    // ========================================================
    // 2. Filter Validation
    // ========================================================

    const filter = String(Filter).trim().toLowerCase();

    if (
      !["yesterday", "weekly", "monthly", "yearly"]
        .includes(filter)
    ) {
      throw new AppError(
        "Filter must be yesterday, weekly, monthly or yearly.",
        STATUS_CODES.BAD_REQUEST
      );
    }

    // ========================================================
    // 3. OrganizationID Validation
    // ========================================================

    if (
      OrganizationID !== undefined &&
      String(OrganizationID).trim() !== ""
    ) {
      const orgID = String(OrganizationID).trim();

      if (
        !/^[1-9]\d*$/.test(orgID) ||
        BigInt(orgID) > 9223372036854775807n
      ) {
        throw new AppError(
          "OrganizationID must be a positive integer.",
          STATUS_CODES.BAD_REQUEST
        );
      }
    }

    // ========================================================
    // 4. Service
    // ========================================================

    const result =
      await DashboardService.getCEOGuestMetChart({
        Filter: filter,
        OrganizationID: OrganizationID || null,
      });

    if (!result.success) {
      throw new AppError(
        result.message,
        result.statusCode || STATUS_CODES.BAD_REQUEST
      );
    }

    return res
      .status(STATUS_CODES.SUCCESS)
      .json(result);

  } catch (error) {
    return handleError(error, res);
  }
};
// 9.1. ============================================================ Guest Met Details
exports.getCEOGuestMetDetails = async (req, res) => {
  try {
    const {
      OrganizationID,
      Filter = "yearly",
      MetOn = "Total",
      page = 1,
      PageSize = 10,
    } = req.query;

    // ========================================================
    // 2. OrganizationID Validation
    // ========================================================
    const orgID = OrganizationID == null
      ? ""
      : String(OrganizationID).trim();

    if (
      !/^[1-9]\d*$/.test(orgID) ||
      BigInt(orgID) > 9223372036854775807n
    ) {
      throw new AppError(
        "Valid OrganizationID is required.",
        STATUS_CODES.BAD_REQUEST
      );
    }

    // ========================================================
    // 3. Filter Validation
    // ========================================================
    const filter = String(Filter).trim().toLowerCase();

    if (
      !["yesterday", "weekly", "monthly", "yearly"]
        .includes(filter)
    ) {
      throw new AppError(
        "Invalid Guest Met date filter.",
        STATUS_CODES.BAD_REQUEST
      );
    }

    // ========================================================
    // 4. MetOn Validation
    // ========================================================
    if (
      typeof MetOn !== "string" ||
      !["ARRIVAL", "DEPARTURE", "INHOUSE", "TOTAL"]
        .includes(
          MetOn.trim().toUpperCase()
            .replace(/[\s-]+/g, "")
        )
    ) {
      throw new AppError(
        "MetOn must be Arrival, Departure, InHouse or Total.",
        STATUS_CODES.BAD_REQUEST
      );
    }

    // ========================================================
    // 5. Pagination Validation
    // ========================================================
    if (
      !Number.isSafeInteger(Number(page)) ||
      Number(page) <= 0 ||
      !Number.isSafeInteger(Number(PageSize)) ||
      Number(PageSize) < 1 ||
      Number(PageSize) > 100
    ) {
      throw new AppError(
        "Invalid page or PageSize.",
        STATUS_CODES.BAD_REQUEST
      );
    }

    // ========================================================
    // 6. Service
    // ========================================================
    const result =
      await DashboardService.getCEOGuestMetDetails({
        OrganizationID: orgID,
        Filter: filter,
        MetOn,
        page: Number(page),
        PageSize: Number(PageSize),
      });

    // ========================================================
    // 7. Response
    // ========================================================
    if (!result.success) {
      throw new AppError(
        result.message,
        result.statusCode || STATUS_CODES.BAD_REQUEST
      );
    }

    return res
      .status(STATUS_CODES.SUCCESS)
      .json(result);

  } catch (error) {
    return handleError(error, res);
  }
};
// 10. ============================================================ AR Collection
exports.getCEOARCollection = async (req, res) => {
  try {
    const { OrganizationID } = req.query;

    // ========================================================
    // 2. OrganizationID Validation
    // ========================================================

    if (
      OrganizationID !== undefined &&
      String(OrganizationID).trim() !== ""
    ) {
      const orgID = String(OrganizationID).trim();

      if (
        !/^[1-9]\d*$/.test(orgID) ||
        BigInt(orgID) > 9223372036854775807n
      ) {
        throw new AppError(
          "OrganizationID must be a positive integer.",
          STATUS_CODES.BAD_REQUEST
        );
      }
    }

    // ========================================================
    // 3. Service
    // ========================================================

    const result =
      await DashboardService.getCEOARCollection({
        OrganizationID: OrganizationID || null,
      });

    if (!result.success) {
      throw new AppError(
        result.message,
        result.statusCode || STATUS_CODES.BAD_REQUEST
      );
    }

    return res
      .status(STATUS_CODES.SUCCESS)
      .json(result);

  } catch (error) {
    return handleError(error, res);
  }
};
// 10.1. ============================================================ AR Collection Details
exports.getCEOARCollectionDetails = async (req, res) => {
  try {
    const { OrganizationID } = req.query;

    // ========================================================
    // 2. OrganizationID Validation
    // ========================================================

    const orgID = OrganizationID == null
      ? ""
      : String(OrganizationID).trim();

    if (
      orgID !== "" &&
      (
        !/^[1-9]\d*$/.test(orgID) ||
        BigInt(orgID) > 9223372036854775807n
      )
    ) {
      throw new AppError(
        "OrganizationID must be a positive integer.",
        STATUS_CODES.BAD_REQUEST
      );
    }

    // ========================================================
    // 3. Service
    // ========================================================

    const result =
      await DashboardService.getCEOARCollectionDetails({
        OrganizationID: orgID || null,
      });

    if (!result.success) {
      throw new AppError(
        result.message,
        result.statusCode || STATUS_CODES.BAD_REQUEST
      );
    }

    return res
      .status(STATUS_CODES.SUCCESS)
      .json(result);

  } catch (error) {
    return handleError(error, res);
  }
};
// 11. ============================================================ Paymaster Trend
exports.getCEOPayMasters = async (req, res) => {
  try {
    const { OrganizationID } = req.query;

    // ========================================================
    // 2. OrganizationID Validation
    // ========================================================

    if (
      OrganizationID !== undefined &&
      String(OrganizationID).trim() !== ""
    ) {
      const orgID = String(OrganizationID).trim();

      if (
        !/^[1-9]\d*$/.test(orgID) ||
        BigInt(orgID) > 9223372036854775807n
      ) {
        throw new AppError(
          "OrganizationID must be a positive integer.",
          STATUS_CODES.BAD_REQUEST
        );
      }
    }

    // ========================================================
    // 3. Service
    // ========================================================

    const result =
      await DashboardService.getCEOPayMasters({
        OrganizationID: OrganizationID || null,
      });

    // ========================================================
    // 4. Response
    // ========================================================

    if (!result.success) {
      throw new AppError(
        result.message,
        result.statusCode || STATUS_CODES.BAD_REQUEST
      );
    }

    return res
      .status(STATUS_CODES.SUCCESS)
      .json(result);

  } catch (error) {
    return handleError(error, res);
  }
};
// 11.1. ============================================================ Paymaster Details
exports.getCEOPayMastersDetails = async (req, res) => {
  try {
    const { OrganizationID } = req.query;

    // ========================================================
    // 2. OrganizationID Validation
    // ========================================================

    const orgID = OrganizationID == null
      ? ""
      : String(OrganizationID).trim();

    if (
      orgID !== "" &&
      (
        !/^[1-9]\d*$/.test(orgID) ||
        BigInt(orgID) > 9223372036854775807n
      )
    ) {
      throw new AppError(
        "OrganizationID must be a positive integer.",
        STATUS_CODES.BAD_REQUEST
      );
    }

    // ========================================================
    // 3. Service
    // ========================================================

    const result =
      await DashboardService.getCEOPayMastersDetails({
        OrganizationID: orgID || null,
      });

    // ========================================================
    // 4. Response
    // ========================================================

    if (!result.success) {
      throw new AppError(
        result.message,
        result.statusCode || STATUS_CODES.BAD_REQUEST
      );
    }

    return res
      .status(STATUS_CODES.SUCCESS)
      .json(result);

  } catch (error) {
    return handleError(error, res);
  }
};
// 12. ============================================================ Forecast ADR
exports.getCEOForecastADR = async (req, res) => {
  try {
    const {
      Filter = "tomorrow",
      OrganizationID,
    } = req.query;

    // ========================================================
    // 2. Filter Validation
    // ========================================================

    const filter = String(Filter).trim().toLowerCase();

    if (
      !["tomorrow", "weekly", "monthly", "yearly"]
        .includes(filter)
    ) {
      throw new AppError(
        "Filter must be tomorrow, weekly, monthly or yearly.",
        STATUS_CODES.BAD_REQUEST
      );
    }

    // ========================================================
    // 3. OrganizationID Validation
    // ========================================================

    if (
      OrganizationID !== undefined &&
      String(OrganizationID).trim() !== ""
    ) {
      const orgID = String(OrganizationID).trim();

      if (
        !/^[1-9]\d*$/.test(orgID) ||
        BigInt(orgID) > 9223372036854775807n
      ) {
        throw new AppError(
          "OrganizationID must be a positive integer.",
          STATUS_CODES.BAD_REQUEST
        );
      }
    }

    // ========================================================
    // 4. Service
    // ========================================================

    const result =
      await DashboardService.getCEOForecastADR({
        Filter: filter,
        OrganizationID: OrganizationID || null,
      });

    if (!result.success) {
      throw new AppError(
        result.message,
        result.statusCode || STATUS_CODES.BAD_REQUEST
      );
    }

    return res
      .status(STATUS_CODES.SUCCESS)
      .json(result);

  } catch (error) {
    return handleError(error, res);
  }
};
// 13. ============================================================ PPM Rooms Trend
exports.getCEOPPMRooms = async (req, res) => {
  try {
    const {
      Filter = "yearly",
      OrganizationID,
    } = req.query;

    // ========================================================
    // 2. Filter Validation
    // ========================================================

    const filter = String(Filter).trim().toLowerCase();

    if (
      !["yesterday", "weekly", "monthly", "yearly"]
        .includes(filter)
    ) {
      throw new AppError(
        "Filter must be yesterday, weekly, monthly or yearly.",
        STATUS_CODES.BAD_REQUEST
      );
    }

    // ========================================================
    // 3. OrganizationID Validation
    // ========================================================

    if (
      OrganizationID !== undefined &&
      String(OrganizationID).trim() !== ""
    ) {
      const orgID = String(OrganizationID).trim();

      if (
        !/^[1-9]\d*$/.test(orgID) ||
        BigInt(orgID) > 9223372036854775807n
      ) {
        throw new AppError(
          "OrganizationID must be a positive integer.",
          STATUS_CODES.BAD_REQUEST
        );
      }
    }

    // ========================================================
    // 4. Service
    // ========================================================

    const result =
      await DashboardService.getCEOPPMRooms({
        Filter: filter,
        OrganizationID: OrganizationID || null,
      });

    if (!result.success) {
      throw new AppError(
        result.message,
        result.statusCode || STATUS_CODES.BAD_REQUEST
      );
    }

    return res
      .status(STATUS_CODES.SUCCESS)
      .json(result);

  } catch (error) {
    return handleError(error, res);
  }
};
// 14. ============================================================ Training Hours Trend
exports.getCEOTrainingHours = async (req, res) => {
  try {
    const {
      Filter = "yesterday",
      OrganizationID,
    } = req.query;

    // ========================================================
    // 2. Filter Validation
    // ========================================================

    const filter = String(Filter).trim().toLowerCase();

    if (
      !["yesterday", "weekly", "monthly", "yearly"]
        .includes(filter)
    ) {
      throw new AppError(
        "Filter must be yesterday, weekly, monthly or yearly.",
        STATUS_CODES.BAD_REQUEST
      );
    }

    // ========================================================
    // 3. OrganizationID Validation
    // ========================================================

    if (
      OrganizationID !== undefined &&
      String(OrganizationID).trim() !== ""
    ) {
      const orgID = String(OrganizationID).trim();

      if (
        !/^[1-9]\d*$/.test(orgID) ||
        BigInt(orgID) > 9223372036854775807n
      ) {
        throw new AppError(
          "OrganizationID must be a positive integer.",
          STATUS_CODES.BAD_REQUEST
        );
      }
    }

    // ========================================================
    // 4. Service
    // ========================================================

    const result =
      await DashboardService.getCEOTrainingHours({
        Filter: filter,
        OrganizationID: OrganizationID || null,
      });

    if (!result.success) {
      throw new AppError(
        result.message,
        result.statusCode || STATUS_CODES.BAD_REQUEST
      );
    }

    return res
      .status(STATUS_CODES.SUCCESS)
      .json(result);

  } catch (error) {
    return handleError(error, res);
  }
};
// 14.1. ============================================================ Training Hours Details
exports.getCEOTrainingHoursDetails = async (req, res) => {
  try {
    const {
      Filter = "yesterday",
      OrganizationID,
      page = 1,
      PageSize = 10,
    } = req.query;

    // ========================================================
    // 2. Filter Validation
    // ========================================================

    const filter = String(Filter).trim().toLowerCase();

    if (
      !["yesterday", "weekly", "monthly", "yearly"]
        .includes(filter)
    ) {
      throw new AppError(
        "Invalid date filter.",
        STATUS_CODES.BAD_REQUEST
      );
    }

    // ========================================================
    // 3. OrganizationID Validation
    // ========================================================

    const orgID = OrganizationID == null
      ? ""
      : String(OrganizationID).trim();

    if (
      orgID !== "" &&
      (
        !/^[1-9]\d*$/.test(orgID) ||
        BigInt(orgID) > 9223372036854775807n
      )
    ) {
      throw new AppError(
        "OrganizationID must be a positive integer.",
        STATUS_CODES.BAD_REQUEST
      );
    }

    // ========================================================
    // 4. Pagination Validation
    // ========================================================

    if (
      !Number.isSafeInteger(Number(page)) ||
      Number(page) <= 0 ||
      !Number.isSafeInteger(Number(PageSize)) ||
      Number(PageSize) < 1 ||
      Number(PageSize) > 100
    ) {
      throw new AppError(
        "Invalid page or PageSize.",
        STATUS_CODES.BAD_REQUEST
      );
    }

    // ========================================================
    // 5. Service Call
    // ========================================================

    const result =
      await DashboardService.getCEOTrainingHoursDetails({
        Filter: filter,
        OrganizationID: orgID || null,
        page: Number(page),
        PageSize: Number(PageSize),
      });

    // ========================================================
    // 6. Response
    // ========================================================

    if (!result.success) {
      throw new AppError(
        result.message,
        result.statusCode || STATUS_CODES.BAD_REQUEST
      );
    }

    return res
      .status(STATUS_CODES.SUCCESS)
      .json(result);

  } catch (error) {
    return handleError(error, res);
  }
};
// 15. ============================================================ Restaurant Feedback Trend
exports.getCEORestaurantFeedback = async (req, res) => {
  try {
    const {
      Filter = "yearly",
      OrganizationID,
    } = req.query;

    // ========================================================
    // 2. Filter Validation
    // ========================================================

    const filter = String(Filter).trim().toLowerCase();

    if (
      !["yesterday", "weekly", "monthly", "yearly"]
        .includes(filter)
    ) {
      throw new AppError(
        "Filter must be yesterday, weekly, monthly or yearly.",
        STATUS_CODES.BAD_REQUEST
      );
    }

    // ========================================================
    // 3. OrganizationID Validation
    // ========================================================

    if (
      OrganizationID !== undefined &&
      String(OrganizationID).trim() !== ""
    ) {
      const orgID = String(OrganizationID).trim();

      if (
        !/^[1-9]\d*$/.test(orgID) ||
        BigInt(orgID) > 9223372036854775807n
      ) {
        throw new AppError(
          "OrganizationID must be a positive integer.",
          STATUS_CODES.BAD_REQUEST
        );
      }
    }

    // ========================================================
    // 4. Service
    // ========================================================

    const result =
      await DashboardService.getCEORestaurantFeedback({
        Filter: filter,
        OrganizationID: OrganizationID || null,
      });

    if (!result.success) {
      throw new AppError(
        result.message,
        result.statusCode || STATUS_CODES.BAD_REQUEST
      );
    }

    return res
      .status(STATUS_CODES.SUCCESS)
      .json(result);

  } catch (error) {
    return handleError(error, res);
  }
};
// 16. ============================================================ Consumption Trend
exports.getCEOConsumption = async (req, res) => {
  try {
    const {
      Filter = "yearly",
      OrganizationID,
    } = req.query;

    // ========================================================
    // 2. Filter Validation
    // ========================================================

    const filter = String(Filter).trim().toLowerCase();

    if (
      !["yesterday", "weekly", "monthly", "yearly"]
        .includes(filter)
    ) {
      throw new AppError(
        "Filter must be yesterday, weekly, monthly or yearly.",
        STATUS_CODES.BAD_REQUEST
      );
    }

    // ========================================================
    // 3. OrganizationID Validation
    // ========================================================

    if (
      OrganizationID !== undefined &&
      String(OrganizationID).trim() !== ""
    ) {
      const orgID = String(OrganizationID).trim();

      if (
        !/^[1-9]\d*$/.test(orgID) ||
        BigInt(orgID) > 9223372036854775807n
      ) {
        throw new AppError(
          "OrganizationID must be a positive integer.",
          STATUS_CODES.BAD_REQUEST
        );
      }
    }

    // ========================================================
    // 4. Service
    // ========================================================

    const result =
      await DashboardService.getCEOConsumption({
        Filter: filter,
        OrganizationID: OrganizationID || null,
      });

    // ========================================================
    // 5. Response
    // ========================================================

    if (!result.success) {
      throw new AppError(
        result.message,
        result.statusCode || STATUS_CODES.BAD_REQUEST
      );
    }

    return res
      .status(STATUS_CODES.SUCCESS)
      .json(result);

  } catch (error) {
    return handleError(error, res);
  }
};
// 17. ============================================================ CheckList Trend
exports.getCEOCheckList = async (req, res) => {
  try {
    const {
      Filter = "weekly",
      OrganizationID,
    } = req.query;

    // ========================================================
    // 2. Filter Validation
    // ========================================================

    const filter = String(Filter).trim().toLowerCase();

    if (
      !["yesterday", "weekly", "monthly", "yearly"]
        .includes(filter)
    ) {
      throw new AppError(
        "Filter must be yesterday, weekly, monthly or yearly.",
        STATUS_CODES.BAD_REQUEST
      );
    }

    // ========================================================
    // 3. OrganizationID Validation
    // ========================================================

    if (
      OrganizationID !== undefined &&
      String(OrganizationID).trim() !== ""
    ) {
      const orgID = String(OrganizationID).trim();

      if (
        !/^[1-9]\d*$/.test(orgID) ||
        BigInt(orgID) > 9223372036854775807n
      ) {
        throw new AppError(
          "OrganizationID must be a positive integer.",
          STATUS_CODES.BAD_REQUEST
        );
      }
    }

    // ========================================================
    // 4. Service
    // ========================================================

    const result =
      await DashboardService.getCEOCheckList({
        Filter: filter,
        OrganizationID: OrganizationID || null,
      });

    if (!result.success) {
      throw new AppError(
        result.message,
        result.statusCode || STATUS_CODES.BAD_REQUEST
      );
    }

    return res
      .status(STATUS_CODES.SUCCESS)
      .json(result);

  } catch (error) {
    return handleError(error, res);
  }
};
// 18. ============================================================ Discards Trend
exports.getCEODiscard = async (req, res) => {
  try {
    const {
      Filter = "yearly",
      OrganizationID,
    } = req.query;

    // ========================================================
    // Filter Validation
    // ========================================================

    const filter = String(Filter).trim().toLowerCase();

    if (
      !["yesterday", "weekly", "monthly", "yearly"]
        .includes(filter)
    ) {
      throw new AppError(
        "Filter must be yesterday, weekly, monthly or yearly.",
        STATUS_CODES.BAD_REQUEST
      );
    }

    // ========================================================
    // OrganizationID Validation
    // ========================================================

    if (
      OrganizationID !== undefined &&
      String(OrganizationID).trim() !== ""
    ) {
      const orgID = String(OrganizationID).trim();

      if (
        !/^[1-9]\d*$/.test(orgID) ||
        BigInt(orgID) > 9223372036854775807n
      ) {
        throw new AppError(
          "OrganizationID must be a positive integer.",
          STATUS_CODES.BAD_REQUEST
        );
      }
    }

    // ========================================================
    // Service
    // ========================================================

    const result =
      await DashboardService.getCEODiscard({
        Filter: filter,
        OrganizationID: OrganizationID || null,
      });

    if (!result.success) {
      throw new AppError(
        result.message,
        result.statusCode || STATUS_CODES.BAD_REQUEST
      );
    }

    return res
      .status(STATUS_CODES.SUCCESS)
      .json(result);

  } catch (error) {
    return handleError(error, res);
  }
};
// 19. ============================================================ Lost and Found Trend
exports.getCEOLostAndFound = async (req, res) => {
  try {
    const {
      Filter = "monthly",
      OrganizationID,
    } = req.query;

    // ========================================================
    // 2. Filter Validation
    // ========================================================

    const filter = String(Filter).trim().toLowerCase();

    if (
      !["yesterday", "weekly", "monthly", "yearly"]
        .includes(filter)
    ) {
      throw new AppError(
        "Filter must be yesterday, weekly, monthly or yearly.",
        STATUS_CODES.BAD_REQUEST
      );
    }

    // ========================================================
    // 3. OrganizationID Validation
    // ========================================================

    if (
      OrganizationID !== undefined &&
      String(OrganizationID).trim() !== ""
    ) {
      const orgID = String(OrganizationID).trim();

      if (
        !/^[1-9]\d*$/.test(orgID) ||
        BigInt(orgID) > 9223372036854775807n
      ) {
        throw new AppError(
          "OrganizationID must be a positive integer.",
          STATUS_CODES.BAD_REQUEST
        );
      }
    }

    // ========================================================
    // 4. Service
    // ========================================================

    const result =
      await DashboardService.getCEOLostAndFound({
        Filter: filter,
        OrganizationID: OrganizationID || null,
      });

    if (!result.success) {
      throw new AppError(
        result.message,
        result.statusCode || STATUS_CODES.BAD_REQUEST
      );
    }

    return res
      .status(STATUS_CODES.SUCCESS)
      .json(result);

  } catch (error) {
    return handleError(error, res);
  }
};
// 20. ============================================================ Operational Health
exports.getCEOOperationalHealth = async (req, res) => {
  try {
    const { Filter = "yearly", OrganizationID } = req.query;

    // ========================================================
    // Filter Validation
    // ========================================================

    const filter = String(Filter).trim().toLowerCase();

    if (
      !["yesterday", "weekly", "monthly", "yearly"]
        .includes(filter)
    ) {
      throw new AppError(
        "Filter must be yesterday, weekly, monthly or yearly.",
        STATUS_CODES.BAD_REQUEST
      );
    }

    // ========================================================
    // Service
    // ========================================================

    const result =
      await DashboardService.getCEOOperationalHealth({
        Filter: filter,
        OrganizationID,
      });

    if (!result.success) {
      throw new AppError(
        result.message,
        result.statusCode || STATUS_CODES.BAD_REQUEST
      );
    }

    return res
      .status(STATUS_CODES.SUCCESS)
      .json(result);

  } catch (error) {
    return handleError(error, res);
  }
};
// 20.1. ============================================================ Operational Health Gltch
exports.getCEOOperationalGlitchDetails = async (req, res) => {
  try {
    const {
      Filter = "yearly",
      OrganizationID,
      page = 1,
      PageSize = 10,
    } = req.query;

    const filter = String(Filter).trim().toLowerCase();

    if (!["yesterday", "weekly", "monthly", "yearly"].includes(filter)) {
      throw new AppError(
        "Invalid date filter.",
        STATUS_CODES.BAD_REQUEST
      );
    }

    const orgID = OrganizationID == null
      ? ""
      : String(OrganizationID).trim();

    if (
      orgID !== "" &&
      (
        !/^[1-9]\d*$/.test(orgID) ||
        BigInt(orgID) > 9223372036854775807n
      )
    ) {
      throw new AppError(
        "OrganizationID must be a positive integer.",
        STATUS_CODES.BAD_REQUEST
      );
    }

    if (
      !Number.isSafeInteger(Number(page)) ||
      Number(page) <= 0 ||
      !Number.isSafeInteger(Number(PageSize)) ||
      Number(PageSize) < 1 ||
      Number(PageSize) > 100
    ) {
      throw new AppError(
        "Invalid page or PageSize.",
        STATUS_CODES.BAD_REQUEST
      );
    }

    const result =
      await DashboardService.getCEOOperationalGlitchDetails({
        Filter: filter,
        OrganizationID: orgID || null,
        page: Number(page),
        PageSize: Number(PageSize),
      });

    if (!result.success) {
      throw new AppError(
        result.message,
        result.statusCode || STATUS_CODES.BAD_REQUEST
      );
    }

    return res.status(STATUS_CODES.SUCCESS).json(result);

  } catch (error) {
    return handleError(error, res);
  }
};
// 20.2. ============================================================ Operational Health Incident
exports.getCEOOperationalIncidentDetails = async (req, res) => {
  try {
    const {
      Filter = "yearly",
      OrganizationID,
      page = 1,
      PageSize = 10,
    } = req.query;

    const filter = String(Filter).trim().toLowerCase();

    if (!["yesterday", "weekly", "monthly", "yearly"].includes(filter)) {
      throw new AppError(
        "Invalid date filter.",
        STATUS_CODES.BAD_REQUEST
      );
    }

    const orgID = OrganizationID == null
      ? ""
      : String(OrganizationID).trim();

    if (
      orgID !== "" &&
      (
        !/^[1-9]\d*$/.test(orgID) ||
        BigInt(orgID) > 9223372036854775807n
      )
    ) {
      throw new AppError(
        "OrganizationID must be a positive integer.",
        STATUS_CODES.BAD_REQUEST
      );
    }

    if (
      !Number.isSafeInteger(Number(page)) ||
      Number(page) <= 0 ||
      !Number.isSafeInteger(Number(PageSize)) ||
      Number(PageSize) < 1 ||
      Number(PageSize) > 100
    ) {
      throw new AppError(
        "Invalid page or PageSize.",
        STATUS_CODES.BAD_REQUEST
      );
    }

    const result =
      await DashboardService.getCEOOperationalIncidentDetails({
        Filter: filter,
        OrganizationID: orgID || null,
        page: Number(page),
        PageSize: Number(PageSize),
      });

    if (!result.success) {
      throw new AppError(
        result.message,
        result.statusCode || STATUS_CODES.BAD_REQUEST
      );
    }

    return res.status(STATUS_CODES.SUCCESS).json(result);

  } catch (error) {
    return handleError(error, res);
  }
};
// 21. ============================================================ Forecast Occupancy Trend
exports.getCEOForecastOccupancy = async (req, res) => {
  try {
    const {
      Filter = "tomorrow",
      OrganizationID,
    } = req.query;

    // ========================================================
    // 2. Filter Validation
    // ========================================================

    const filter = String(Filter).trim().toLowerCase();

    if (
      !["tomorrow", "weekly", "monthly", "yearly"]
        .includes(filter)
    ) {
      throw new AppError(
        "Filter must be tomorrow, weekly, monthly or yearly.",
        STATUS_CODES.BAD_REQUEST
      );
    }

    // ========================================================
    // 3. OrganizationID Validation
    // ========================================================

    const orgID = OrganizationID == null
      ? ""
      : String(OrganizationID).trim();

    if (
      orgID !== "" &&
      (
        !/^[1-9]\d*$/.test(orgID) ||
        BigInt(orgID) > 9223372036854775807n
      )
    ) {
      throw new AppError(
        "OrganizationID must be a positive integer.",
        STATUS_CODES.BAD_REQUEST
      );
    }

    // ========================================================
    // 4. Service
    // ========================================================

    const result =
      await DashboardService.getCEOForecastOccupancy({
        Filter: filter,
        OrganizationID: orgID || null,
      });

    // ========================================================
    // 5. Response
    // ========================================================

    if (!result.success) {
      throw new AppError(
        result.message,
        result.statusCode || STATUS_CODES.BAD_REQUEST
      );
    }

    return res
      .status(STATUS_CODES.SUCCESS)
      .json(result);

  } catch (error) {
    return handleError(error, res);
  }
};
// 22. ============================================================ Engineering Count
exports.getCEOEngineeringSummary = async (req, res) => {
  try {
    const {
      Filter = "yearly",
      OrganizationID,
    } = req.query;

    // ========================================================
    // Filter Validation
    // ========================================================

    const filter = String(Filter).trim().toLowerCase();

    if (
      !["yesterday", "weekly", "monthly", "yearly"]
        .includes(filter)
    ) {
      throw new AppError(
        "Invalid date filter.",
        STATUS_CODES.BAD_REQUEST
      );
    }

    // ========================================================
    // OrganizationID Validation
    // ========================================================

    const orgID = OrganizationID == null
      ? ""
      : String(OrganizationID).trim();

    if (
      orgID !== "" &&
      (
        !/^[1-9]\d*$/.test(orgID) ||
        BigInt(orgID) > 9223372036854775807n
      )
    ) {
      throw new AppError(
        "OrganizationID must be a positive integer.",
        STATUS_CODES.BAD_REQUEST
      );
    }

    // ========================================================
    // Service
    // ========================================================

    const result =
      await DashboardService.getCEOEngineeringSummary({
        Filter: filter,
        OrganizationID: orgID || null,
      });

    if (!result.success) {
      throw new AppError(
        result.message,
        result.statusCode || STATUS_CODES.BAD_REQUEST
      );
    }

    return res
      .status(STATUS_CODES.SUCCESS)
      .json(result);

  } catch (error) {
    return handleError(error, res);
  }
};
// 22.1. ============================================================ Engineering Total Equipments Details
exports.getCEOEquipmentDetails = async (req, res) => {
  try {
    const {
      Filter = "yearly",
      OrganizationID,
      page = 1,
      PageSize = 10,
    } = req.query;

    // ========================================================
    // 2. Filter Validation
    // ========================================================

    const filter = String(Filter).trim().toLowerCase();

    if (
      !["yesterday", "weekly", "monthly", "yearly"]
        .includes(filter)
    ) {
      throw new AppError(
        "Invalid date filter.",
        STATUS_CODES.BAD_REQUEST
      );
    }

    // ========================================================
    // 3. OrganizationID Validation
    // ========================================================

    const orgID = OrganizationID == null
      ? ""
      : String(OrganizationID).trim();

    if (
      orgID !== "" &&
      (
        !/^[1-9]\d*$/.test(orgID) ||
        BigInt(orgID) > 9223372036854775807n
      )
    ) {
      throw new AppError(
        "OrganizationID must be a positive integer.",
        STATUS_CODES.BAD_REQUEST
      );
    }

    // ========================================================
    // 4. Pagination Validation
    // ========================================================

    if (
      !Number.isSafeInteger(Number(page)) ||
      Number(page) <= 0 ||
      !Number.isSafeInteger(Number(PageSize)) ||
      Number(PageSize) < 1 ||
      Number(PageSize) > 100
    ) {
      throw new AppError(
        "Invalid page or PageSize.",
        STATUS_CODES.BAD_REQUEST
      );
    }

    // ========================================================
    // 5. Service
    // ========================================================

    const result =
      await DashboardService.getCEOEquipmentDetails({
        Filter: filter,
        OrganizationID: orgID || null,
        page: Number(page),
        PageSize: Number(PageSize),
      });

    // ========================================================
    // 6. Response
    // ========================================================

    if (!result.success) {
      throw new AppError(
        result.message,
        result.statusCode || STATUS_CODES.BAD_REQUEST
      );
    }

    return res
      .status(STATUS_CODES.SUCCESS)
      .json(result);

  } catch (error) {
    return handleError(error, res);
  }
};
// 22.2. ============================================================ Engineering Under Warranty Details
exports.getCEOUnderWarrantyDetails = async (req, res) => {
  try {
    const {
      Filter = "yearly",
      OrganizationID,
      page = 1,
      PageSize = 10,
    } = req.query;

    // ========================================================
    // 2. Filter Validation
    // ========================================================
    const filter = String(Filter).trim().toLowerCase();

    if (
      !["yesterday", "weekly", "monthly", "yearly"]
        .includes(filter)
    ) {
      throw new AppError(
        "Invalid date filter.",
        STATUS_CODES.BAD_REQUEST
      );
    }

    // ========================================================
    // 3. OrganizationID Validation
    // ========================================================
    const orgID = OrganizationID == null
      ? ""
      : String(OrganizationID).trim();

    if (
      orgID !== "" &&
      (
        !/^[1-9]\d*$/.test(orgID) ||
        BigInt(orgID) > 9223372036854775807n
      )
    ) {
      throw new AppError(
        "OrganizationID must be a positive integer.",
        STATUS_CODES.BAD_REQUEST
      );
    }

    // ========================================================
    // 4. Pagination Validation
    // ========================================================
    if (
      !Number.isSafeInteger(Number(page)) ||
      Number(page) <= 0 ||
      !Number.isSafeInteger(Number(PageSize)) ||
      Number(PageSize) < 1 ||
      Number(PageSize) > 100
    ) {
      throw new AppError(
        "Invalid page or PageSize.",
        STATUS_CODES.BAD_REQUEST
      );
    }

    // ========================================================
    // 5. Service
    // ========================================================
    const result =
      await DashboardService.getCEOUnderWarrantyDetails({
        Filter: filter,
        OrganizationID: orgID || null,
        page: Number(page),
        PageSize: Number(PageSize),
      });

    // ========================================================
    // 6. Response
    // ========================================================
    if (!result.success) {
      throw new AppError(
        result.message,
        result.statusCode || STATUS_CODES.BAD_REQUEST
      );
    }

    return res
      .status(STATUS_CODES.SUCCESS)
      .json(result);

  } catch (error) {
    return handleError(error, res);
  }
};
// 22.3. ============================================================ Engineering Under AMC Details
exports.getCEOUnderAMCDetails = async (req, res) => {
  try {
    const {
      Filter = "yearly",
      OrganizationID,
      page = 1,
      PageSize = 10,
    } = req.query;

    // ========================================================
    // 2. Filter Validation
    // ========================================================

    const filter = String(Filter).trim().toLowerCase();

    if (
      !["yesterday", "weekly", "monthly", "yearly"]
        .includes(filter)
    ) {
      throw new AppError(
        "Invalid date filter.",
        STATUS_CODES.BAD_REQUEST
      );
    }

    // ========================================================
    // 3. OrganizationID Validation
    // ========================================================

    const orgID = OrganizationID == null
      ? ""
      : String(OrganizationID).trim();

    if (
      orgID !== "" &&
      (
        !/^[1-9]\d*$/.test(orgID) ||
        BigInt(orgID) > 9223372036854775807n
      )
    ) {
      throw new AppError(
        "OrganizationID must be a positive integer.",
        STATUS_CODES.BAD_REQUEST
      );
    }

    // ========================================================
    // 4. Pagination Validation
    // ========================================================

    if (
      !Number.isSafeInteger(Number(page)) ||
      Number(page) <= 0 ||
      !Number.isSafeInteger(Number(PageSize)) ||
      Number(PageSize) < 1 ||
      Number(PageSize) > 100
    ) {
      throw new AppError(
        "Invalid page or PageSize.",
        STATUS_CODES.BAD_REQUEST
      );
    }

    // ========================================================
    // 5. Service
    // ========================================================

    const result =
      await DashboardService.getCEOUnderAMCDetails({
        Filter: filter,
        OrganizationID: orgID || null,
        page: Number(page),
        PageSize: Number(PageSize),
      });

    // ========================================================
    // 6. Response
    // ========================================================

    if (!result.success) {
      throw new AppError(
        result.message,
        result.statusCode || STATUS_CODES.BAD_REQUEST
      );
    }

    return res
      .status(STATUS_CODES.SUCCESS)
      .json(result);

  } catch (error) {
    return handleError(error, res);
  }
};
// 22.4. ============================================================ Engineering Total Breakdown Details
exports.getCEOTotalBreakdownDetails = async (req, res) => {
  try {
    const {
      Filter = "yearly",
      OrganizationID,
      page = 1,
      PageSize = 10,
    } = req.query;

    // ========================================================
    // 2. Filter Validation
    // ========================================================

    const filter = String(Filter).trim().toLowerCase();

    if (
      !["yesterday", "weekly", "monthly", "yearly"]
        .includes(filter)
    ) {
      throw new AppError(
        "Invalid date filter.",
        STATUS_CODES.BAD_REQUEST
      );
    }

    // ========================================================
    // 3. OrganizationID Validation
    // ========================================================

    const orgID = OrganizationID == null
      ? ""
      : String(OrganizationID).trim();

    if (
      orgID !== "" &&
      (
        !/^[1-9]\d*$/.test(orgID) ||
        BigInt(orgID) > 9223372036854775807n
      )
    ) {
      throw new AppError(
        "OrganizationID must be a positive integer.",
        STATUS_CODES.BAD_REQUEST
      );
    }

    // ========================================================
    // 4. Pagination Validation
    // ========================================================

    if (
      !Number.isSafeInteger(Number(page)) ||
      Number(page) <= 0 ||
      !Number.isSafeInteger(Number(PageSize)) ||
      Number(PageSize) < 1 ||
      Number(PageSize) > 100
    ) {
      throw new AppError(
        "Invalid page or PageSize.",
        STATUS_CODES.BAD_REQUEST
      );
    }

    // ========================================================
    // 5. Service
    // ========================================================

    const result =
      await DashboardService.getCEOTotalBreakdownDetails({
        Filter: filter,
        OrganizationID: orgID || null,
        page: Number(page),
        PageSize: Number(PageSize),
      });

    // ========================================================
    // 6. Response
    // ========================================================

    if (!result.success) {
      throw new AppError(
        result.message,
        result.statusCode || STATUS_CODES.BAD_REQUEST
      );
    }

    return res
      .status(STATUS_CODES.SUCCESS)
      .json(result);

  } catch (error) {
    return handleError(error, res);
  }
};
// 22.5. ============================================================ Engineering Total Maintenance Details
exports.getCEOTotalMaintenanceDetails = async (req, res) => {
  try {
    const {
      Filter = "yearly",
      OrganizationID,
      page = 1,
      PageSize = 10,
    } = req.query;

    // ========================================================
    // 2. Filter Validation
    // ========================================================

    const filter = String(Filter).trim().toLowerCase();

    if (
      !["yesterday", "weekly", "monthly", "yearly"]
        .includes(filter)
    ) {
      throw new AppError(
        "Invalid date filter.",
        STATUS_CODES.BAD_REQUEST
      );
    }

    // ========================================================
    // 3. OrganizationID Validation
    // ========================================================

    const orgID = OrganizationID == null
      ? ""
      : String(OrganizationID).trim();

    if (
      orgID !== "" &&
      (
        !/^[1-9]\d*$/.test(orgID) ||
        BigInt(orgID) > 9223372036854775807n
      )
    ) {
      throw new AppError(
        "OrganizationID must be a positive integer.",
        STATUS_CODES.BAD_REQUEST
      );
    }

    // ========================================================
    // 4. Pagination Validation
    // ========================================================

    if (
      !Number.isSafeInteger(Number(page)) ||
      Number(page) <= 0 ||
      !Number.isSafeInteger(Number(PageSize)) ||
      Number(PageSize) < 1 ||
      Number(PageSize) > 100
    ) {
      throw new AppError(
        "Invalid page or PageSize.",
        STATUS_CODES.BAD_REQUEST
      );
    }

    // ========================================================
    // 5. Service
    // ========================================================

    const result =
      await DashboardService.getCEOTotalMaintenanceDetails({
        Filter: filter,
        OrganizationID: orgID || null,
        page: Number(page),
        PageSize: Number(PageSize),
      });

    // ========================================================
    // 6. Response
    // ========================================================

    if (!result.success) {
      throw new AppError(
        result.message,
        result.statusCode || STATUS_CODES.BAD_REQUEST
      );
    }

    return res
      .status(STATUS_CODES.SUCCESS)
      .json(result);

  } catch (error) {
    return handleError(error, res);
  }
};
// 22.6. ============================================================ Engineering Pending Maintenance Details
exports.getCEOPendingMaintenanceDetails = async (req, res) => {
  try {
    const {
      Filter = "yearly",
      OrganizationID,
      page = 1,
      PageSize = 10,
    } = req.query;

    // ========================================================
    // 2. Filter Validation
    // ========================================================

    const filter = String(Filter).trim().toLowerCase();

    if (
      !["yesterday", "weekly", "monthly", "yearly"]
        .includes(filter)
    ) {
      throw new AppError(
        "Invalid date filter.",
        STATUS_CODES.BAD_REQUEST
      );
    }

    // ========================================================
    // 3. OrganizationID Validation
    // ========================================================

    const orgID = OrganizationID == null
      ? ""
      : String(OrganizationID).trim();

    if (
      orgID !== "" &&
      (
        !/^[1-9]\d*$/.test(orgID) ||
        BigInt(orgID) > 9223372036854775807n
      )
    ) {
      throw new AppError(
        "OrganizationID must be a positive integer.",
        STATUS_CODES.BAD_REQUEST
      );
    }

    // ========================================================
    // 4. Pagination Validation
    // ========================================================

    if (
      !Number.isSafeInteger(Number(page)) ||
      Number(page) <= 0 ||
      !Number.isSafeInteger(Number(PageSize)) ||
      Number(PageSize) < 1 ||
      Number(PageSize) > 100
    ) {
      throw new AppError(
        "Invalid page or PageSize.",
        STATUS_CODES.BAD_REQUEST
      );
    }

    // ========================================================
    // 5. Service Call
    // ========================================================

    const result =
      await DashboardService.getCEOPendingMaintenanceDetails({
        Filter: filter,
        OrganizationID: orgID || null,
        page: Number(page),
        PageSize: Number(PageSize),
      });

    // ========================================================
    // 6. Response
    // ========================================================

    if (!result.success) {
      throw new AppError(
        result.message,
        result.statusCode || STATUS_CODES.BAD_REQUEST
      );
    }

    return res
      .status(STATUS_CODES.SUCCESS)
      .json(result);

  } catch (error) {
    return handleError(error, res);
  }
};
// 23. ============================================================ Engineering Maintenance Trend
exports.getCEOEngineeringMaintenanceChart = async (req, res) => {
  try {
    const {
      Filter = "yearly",
      OrganizationID,
    } = req.query;

    // ========================================================
    // 2. Filter Validation
    // ========================================================

    const filter = String(Filter).trim().toLowerCase();

    if (
      !["yesterday", "weekly", "monthly", "yearly"]
        .includes(filter)
    ) {
      throw new AppError(
        "Invalid date filter.",
        STATUS_CODES.BAD_REQUEST
      );
    }

    // ========================================================
    // 3. OrganizationID Validation
    // ========================================================

    const orgID = OrganizationID == null
      ? ""
      : String(OrganizationID).trim();

    if (
      orgID !== "" &&
      (
        !/^[1-9]\d*$/.test(orgID) ||
        BigInt(orgID) > 9223372036854775807n
      )
    ) {
      throw new AppError(
        "OrganizationID must be a positive integer.",
        STATUS_CODES.BAD_REQUEST
      );
    }

    // ========================================================
    // 4. Service
    // ========================================================

    const result =
      await DashboardService.getCEOEngineeringMaintenanceChart({
        Filter: filter,
        OrganizationID: orgID || null,
      });

    // ========================================================
    // 5. Response
    // ========================================================

    if (!result.success) {
      throw new AppError(
        result.message,
        result.statusCode || STATUS_CODES.BAD_REQUEST
      );
    }

    return res
      .status(STATUS_CODES.SUCCESS)
      .json(result);

  } catch (error) {
    return handleError(error, res);
  }
};
// 23.1 ============================================================ Engineering Maintenance Trend Details
exports.getCEOCompletedMaintenanceDetails = async (req, res) => {
  try {
    const {
      Filter = "yearly",
      OrganizationID,
      page = 1,
      PageSize = 10,
    } = req.query;

    // ========================================================
    // 2. Filter Validation
    // ========================================================

    const filter = String(Filter).trim().toLowerCase();

    if (
      !["yesterday", "weekly", "monthly", "yearly"]
        .includes(filter)
    ) {
      throw new AppError(
        "Invalid date filter.",
        STATUS_CODES.BAD_REQUEST
      );
    }

    // ========================================================
    // 3. OrganizationID Validation
    // ========================================================

    const orgID = OrganizationID == null
      ? ""
      : String(OrganizationID).trim();

    if (
      orgID !== "" &&
      (
        !/^[1-9]\d*$/.test(orgID) ||
        BigInt(orgID) > 9223372036854775807n
      )
    ) {
      throw new AppError(
        "OrganizationID must be a positive integer.",
        STATUS_CODES.BAD_REQUEST
      );
    }

    // ========================================================
    // 4. Pagination Validation
    // ========================================================

    if (
      !Number.isSafeInteger(Number(page)) ||
      Number(page) <= 0 ||
      !Number.isSafeInteger(Number(PageSize)) ||
      Number(PageSize) < 1 ||
      Number(PageSize) > 100
    ) {
      throw new AppError(
        "Invalid page or PageSize.",
        STATUS_CODES.BAD_REQUEST
      );
    }

    // ========================================================
    // 5. Service Call
    // ========================================================

    const result =
      await DashboardService.getCEOCompletedMaintenanceDetails({
        Filter: filter,
        OrganizationID: orgID || null,
        page: Number(page),
        PageSize: Number(PageSize),
      });

    // ========================================================
    // 6. Response
    // ========================================================

    if (!result.success) {
      throw new AppError(
        result.message,
        result.statusCode || STATUS_CODES.BAD_REQUEST
      );
    }

    return res
      .status(STATUS_CODES.SUCCESS)
      .json(result);

  } catch (error) {
    return handleError(error, res);
  }
};
// 24. ============================================================ Engineering Breakdown Trend
exports.getCEOEngineeringBreakdownChart = async (req, res) => {
  try {
    const {
      Filter = "yearly",
      OrganizationID,
    } = req.query;

    // ========================================================
    // 2. Filter Validation
    // ========================================================

    const filter = String(Filter).trim().toLowerCase();

    if (
      !["yesterday", "weekly", "monthly", "yearly"]
        .includes(filter)
    ) {
      throw new AppError(
        "Invalid date filter.",
        STATUS_CODES.BAD_REQUEST
      );
    }

    // ========================================================
    // 3. OrganizationID Validation
    // ========================================================

    const orgID = OrganizationID == null
      ? ""
      : String(OrganizationID).trim();

    if (
      orgID !== "" &&
      (
        !/^[1-9]\d*$/.test(orgID) ||
        BigInt(orgID) > 9223372036854775807n
      )
    ) {
      throw new AppError(
        "OrganizationID must be a positive integer.",
        STATUS_CODES.BAD_REQUEST
      );
    }

    // ========================================================
    // 4. Service Call
    // ========================================================

    const result =
      await DashboardService.getCEOEngineeringBreakdownChart({
        Filter: filter,
        OrganizationID: orgID || null,
      });

    // ========================================================
    // 5. Response
    // ========================================================

    if (!result.success) {
      throw new AppError(
        result.message,
        result.statusCode || STATUS_CODES.BAD_REQUEST
      );
    }

    return res
      .status(STATUS_CODES.SUCCESS)
      .json(result);

  } catch (error) {
    return handleError(error, res);
  }
};





















