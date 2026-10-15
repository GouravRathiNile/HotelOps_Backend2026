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



