const express = require("express");
const authenticateToken = require("../../middleware/authMiddleware");
const {
  getCEORevenueSummary,
  getCEOOccupancy,
  getCEOGlitchAlerts,
  getCEOIncidentAlerts,
  getCEOExpiredAMCAlerts,
  getCEOHotelRevenueVsBudget,
  getCEODSRChart,
  getCEODSRVisitDetails,
  getCEOSRMSRequests,
  getCEOSRMSRequestDetails,
  getCEOTop20SRMSRequests,
  getCEOTop20SRMSRequestDetails,
  getCEOSRMSCompletionDuration,
  getCEOSRMSCompletionDurationDetails,
  getCEOGuestMetChart,
  getCEOGuestMetDetails,
  getCEOARCollection,
  getCEOARCollectionDetails,
  getCEOPayMasters,
  getCEOPayMastersDetails,
  getCEOForecastADR,
  getCEOPPMRooms,
  getCEOTrainingHours,
  getCEOTrainingHoursDetails,
  getCEORestaurantFeedback,
  getCEOConsumption,
  getCEOCheckList,
  getCEODiscard,
  getCEOLostAndFound,
  getCEOOperationalHealth,
  getCEOOperationalGlitchDetails,
  getCEOOperationalIncidentDetails,
  getCEOForecastOccupancy,
  getCEOEngineeringSummary,
  getCEOEquipmentDetails,
  getCEOUnderWarrantyDetails,
  getCEOUnderAMCDetails,
  getCEOTotalBreakdownDetails,
  getCEOTotalMaintenanceDetails,
  getCEOPendingMaintenanceDetails,
  getCEOEngineeringMaintenanceChart,
  getCEOCompletedMaintenanceDetails,
  getCEOEngineeringBreakdownChart,
} = require(
  "../../controllers/DashboardController/DashboardController",
)
const router = express.Router();

// ==============================================================================================CEO Dashboard 
// 1.=============================================================Top Drr Revenre Data
router.get("/RevenueSummary",authenticateToken,getCEORevenueSummary);
// 2. ============================================================ Get CEO Occupancy
router.get("/OccupancyTrend",authenticateToken,getCEOOccupancy);
// 3. ============================================================ Critical Alerts
// 3.1. ============================================Glitch
router.get("/CriticalGlitchs",authenticateToken,getCEOGlitchAlerts);
// 3.2. ============================================Incident
router.get("/CriticalIncidents",authenticateToken,getCEOIncidentAlerts);
// 3.3 ============================================Engineering Expired AMC
router.get("/CriticalExpiredAMC",authenticateToken,getCEOExpiredAMCAlerts);
// 4. ============================================================ Hotel Revenue vs Budget
router.get("/RevenueVsBudget",authenticateToken,getCEOHotelRevenueVsBudget);
// 5. ============================================================ DSR Trend
router.get("/DSRTrend",authenticateToken,getCEODSRChart);
// 5.1. ============================================================ DSR Details
router.get("/DSRDetails",authenticateToken,getCEODSRVisitDetails);
// 6. ============================================================ Total SRMS Requests
router.get("/TotalSRMSRequests",authenticateToken,getCEOSRMSRequests);
// 6.1. ============================================================ Total SRMS Requests Details
router.get("/TotalSRMSRequestsDetails",authenticateToken,getCEOSRMSRequestDetails);
// 7. ============================================================ Top 20 SRMS Requests
router.get("/Top20SRMSRequests",authenticateToken,getCEOTop20SRMSRequests);
// 7.1. ============================================================ Top 20 SRMS Requests Details
router.get("/Top20SRMSRequestDetails",authenticateToken,getCEOTop20SRMSRequestDetails);
// 8. ============================================================ SRMS Requests Completion Duration in Minutes
router.get("/SRMSCompletionDuration",authenticateToken,getCEOSRMSCompletionDuration);
// 8.1. ============================================================ SRMS Requests Completion Duration in Minutes Details
router.get("/SRMSCompletionDurationDetails",authenticateToken,getCEOSRMSCompletionDurationDetails);
// 9. ============================================================ Guest Met Trend
router.get("/GuestMetTrend",authenticateToken,getCEOGuestMetChart);
// 9.1. ============================================================ Guest Met Details
router.get("/GuestMetDetails",authenticateToken,getCEOGuestMetDetails);
// 10. ============================================================ AR Collection
router.get("/ARCollection",authenticateToken,getCEOARCollection);
// 10.1. ============================================================ AR Collection Details
router.get("/ARCollectionDetails",authenticateToken,getCEOARCollectionDetails);
// 11. ============================================================ Paymaster Trend
router.get("/PayMastersTrend",authenticateToken,getCEOPayMasters);
// 11.1. ============================================================ Paymaster Details
router.get("/PayMastersDetails",authenticateToken,getCEOPayMastersDetails);
// 12. ============================================================ Forecast ADR
router.get("/ForecastADRTrend",authenticateToken,getCEOForecastADR);
// 13. ============================================================ PPM Rooms Trend
router.get("/PPMRoomsTrend",authenticateToken,getCEOPPMRooms);
// 14. ============================================================ Training Hours Trend
router.get("/TrainingHoursTrend",authenticateToken,getCEOTrainingHours);
// 14.1============================================================= Training Hours Details
router.get("/TrainingHoursDetails",authenticateToken,getCEOTrainingHoursDetails);
// 15. ============================================================ Restaurant Feedback Trend
router.get("/RestaurantFeedbackTrend",authenticateToken,getCEORestaurantFeedback);
// 16. ============================================================ Consumption Trend
router.get("/ConsumptionTrend",authenticateToken,getCEOConsumption);
// 17. ============================================================ CheckList Trend
router.get("/CheckListTrend",authenticateToken,getCEOCheckList);
// 18. ============================================================ Discards Trend
router.get("/DiscardTrend",authenticateToken,getCEODiscard);
// 19. ============================================================ Lost and Found Trend
router.get("/LostAndFoundTrend",authenticateToken,getCEOLostAndFound);
// 20. ============================================================ Operational Health
router.get("/OperationalHealth",authenticateToken,getCEOOperationalHealth);
// 20.1. ============================================================ Operational Health Gltch
router.get("/OperationalGlitchDetails",authenticateToken,getCEOOperationalGlitchDetails);
// 20.2. ============================================================ Operational Health Incident
router.get("/OperationalIncidentDetails",authenticateToken,getCEOOperationalIncidentDetails);
// 21. ============================================================ Forecast Occupancy Trend
router.get("/ForecastOccupancy",authenticateToken,getCEOForecastOccupancy);
// 22. ============================================================ Engineering Count
router.get("/EngineeringSummary",authenticateToken,getCEOEngineeringSummary);
// 22.1. ============================================================ Engineering Total Equipments Details
router.get("/EquipmentDetails",authenticateToken,getCEOEquipmentDetails);
// 22.2. ============================================================ Engineering Under Warranty Details
router.get("/EquipmentUnderWarrantyDetails",authenticateToken,getCEOUnderWarrantyDetails);
// 22.3. ============================================================ Engineering Under AMC Details
router.get("/EquipmentUnderAMCDetails",authenticateToken,getCEOUnderAMCDetails);
// 22.4. ============================================================ Engineering Total Breakdown Details
router.get("/EquipmentBreakdownDetails",authenticateToken,getCEOTotalBreakdownDetails);
// 22.5. ============================================================ Engineering Total Maintenance Details
router.get("/EquipmentMaintenanceDetails",authenticateToken,getCEOTotalMaintenanceDetails);
// 22.6. ============================================================ Engineering Pending Maintenance Details
router.get("/EquipmentPendingMaintenance",authenticateToken,getCEOPendingMaintenanceDetails);
// 23. ============================================================ Engineering Maintenance Trend
router.get("/MaintenanceChart",authenticateToken,getCEOEngineeringMaintenanceChart);
// 23.1 ============================================================ Engineering Maintenance Trend Details
router.get("/MaintenanceChartDetails",authenticateToken,getCEOCompletedMaintenanceDetails);
// 24. ============================================================ Engineering Breakdown Trend
router.get("/BreakdownChart",authenticateToken,getCEOEngineeringBreakdownChart);
module.exports = router;
