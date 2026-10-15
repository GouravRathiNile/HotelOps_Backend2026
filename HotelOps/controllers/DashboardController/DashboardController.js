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
    const { BusinessDate } = req.query;

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





