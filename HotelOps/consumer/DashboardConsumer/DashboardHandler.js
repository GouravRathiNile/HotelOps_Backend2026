const DashboardService = require("../../services/DashboardService/DashboardService");
const { retryableDatabaseResponse } = require("../../utils/retryableDatabaseError");

const DashboardHandler = async (message) => {
  try {
    switch (message.action) {
      case "CREATE_DASHBOARD_COMPONENT_ACCESS":
        return await DashboardService.createDashboardComponentAccess(
          message.data
        );

      case "UPDATE_DASHBOARD_COMPONENT_ACCESS":
        return await DashboardService.updateDashboardComponentAccess(
          message.data
        );

      case "DELETE_DASHBOARD_COMPONENT_ACCESS":
        return await DashboardService.deleteDashboardComponentAccess(
          message.data
        );

      default:
        return {
          success: false,
          statusCode: 400,
          message: "Invalid Dashboard action.",
        };
    }
  } catch (error) {
    console.error("Dashboard Handler Error:", error.message);

    const retryResponse = retryableDatabaseResponse(error);
    if (retryResponse) {
      return retryResponse;
    }

    return {
      success: false,
      statusCode: 500,
      message: "Unable to process Dashboard request.",
    };
  }
};

module.exports = DashboardHandler;