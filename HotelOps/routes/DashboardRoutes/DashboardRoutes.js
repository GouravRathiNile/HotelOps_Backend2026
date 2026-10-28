const express = require("express");
const authenticateToken = require("../../middleware/authMiddleware");
const {
  getCEORevenueSummary,
  getCEORevenuePerformance,
  getCEOADRRevPARDetails,
  getCEOOutletRevenueDetails,
  getCEOBanquetRevenueDetails,
  getCEOTotalRevenueDetails,
  getCEORoomsRevenueDetails,
  getCEOFBRevenueDetails,
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
  getCEOSRMSRequestByOrganization,
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
  getCEOPPMChecklistDetails,
  getCEOTrainingHours,
  getCEOTrainingHoursDetails,
  getCEORestaurantFeedback,
  getCEORestaurantFeedbackDetails,
  getCEOConsumption,
  getCEOConsumptionDetails,
  getCEOCheckList,
  getCEODiscard,
  getCEODiscardDetails,
  getCEOLostAndFound,
  getCEOLostAndFoundDetails,
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
  getCEODailyBreakageChart,
  getCEODailyBreakageDetails,
  getCEOHLPReportChart,
  getCEOCateringSalesChart,
  getCEOCateringSalesDetails,
  getCEOSalesContractChart,
  getCEOSalesContractDetails,
  getCEOARRRevPARChart,
  getCEOOutOfOrderChart,
  getCEOCompRoomsSummary,
  getCEOCompRoomDetails
} = require(
  "../../controllers/DashboardController/DashboardController",
)
const router = express.Router();

// ==============================================================================================CEO Dashboard 
// 1.=============================================================Top Drr Revenre Data
router.get("/RevenueSummary",authenticateToken,getCEORevenueSummary);
// 1.1============================================================CEO Revenue Summary Adr and Other
router.get("/RevenuePerformance",authenticateToken,getCEORevenuePerformance);
// 1.2============================================================CEO Revenue Summary Adr/Revpar Details
router.get("/ADRRevPARDetails",authenticateToken,getCEOADRRevPARDetails);
// 1.3============================================================CEO Revenue Summary Oulet Details
router.get("/OutletRevenueDetails",authenticateToken,getCEOOutletRevenueDetails);
// 1.4============================================================CEO Revenue Summary banquet Details
router.get("/BanquetRevenueDetails",authenticateToken,getCEOBanquetRevenueDetails);
// 1.5============================================================CEO Revenue Summary Total Revenew Details
router.get("/TotalRevenueDetails",authenticateToken,getCEOTotalRevenueDetails);
// 1.6============================================================CEO Revenue Summary Room Revenew Details
router.get("/RoomsRevenueDetails",authenticateToken,getCEORoomsRevenueDetails);
// 1.7============================================================CEO Revenue Summary F&B Revenew Details
router.get("/FBRevenueDetails",authenticateToken,getCEOFBRevenueDetails);
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
// 7.2. ============================================================ Top 20 SRMS Requests By Organizations
router.get("/SRMSRequestByOrganization",authenticateToken,getCEOSRMSRequestByOrganization);
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
// 13.1 ============================================================ PPM Rooms Details
router.get("/PPMChecklistDetails",authenticateToken,getCEOPPMChecklistDetails);
// 14. ============================================================ Training Hours Trend
router.get("/TrainingHoursTrend",authenticateToken,getCEOTrainingHours);
// 14.1============================================================= Training Hours Details
router.get("/TrainingHoursDetails",authenticateToken,getCEOTrainingHoursDetails);
// 15. ============================================================ Restaurant Feedback Trend
router.get("/RestaurantFeedbackTrend",authenticateToken,getCEORestaurantFeedback);
// 15.1 ============================================================ Restaurant Feedback Details
router.get("/RestaurantFeedbackDetails",authenticateToken,getCEORestaurantFeedbackDetails);
// 16. ============================================================ Consumption Trend
router.get("/ConsumptionTrend",authenticateToken,getCEOConsumption);
// 16.1 ============================================================ Consumption Details
router.get("/ConsumptionDetails",authenticateToken,getCEOConsumptionDetails);
// 17. ============================================================ CheckList Trend
router.get("/CheckListTrend",authenticateToken,getCEOCheckList);
// 17.1 ============================================================ CheckList Detai;s

// 18. ============================================================ Discards Trend
router.get("/DiscardTrend",authenticateToken,getCEODiscard);
// 18.1 ============================================================ Discards Details
router.get("/DiscardDetails",authenticateToken,getCEODiscardDetails);
// 19. ============================================================ Lost and Found Trend
router.get("/LostAndFoundTrend",authenticateToken,getCEOLostAndFound);
// 19.1 ============================================================ Lost and Found Details
router.get("/LostAndFoundDetails",authenticateToken,getCEOLostAndFoundDetails);
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
// 25. ============================================================ Daily Breakage Trend
router.get("/DailyBreakageTrend",authenticateToken,getCEODailyBreakageChart);
// 25.1 ============================================================ Daily Breakage Details
router.get("/DailyBreakageDetails",authenticateToken,getCEODailyBreakageDetails);
// 26. ============================================================ HLP Report Trend
router.get("/HLPReportTrend",authenticateToken,getCEOHLPReportChart);
// 27. ============================================================ Catering Trend
router.get("/CateringSalesTrend",authenticateToken,getCEOCateringSalesChart);
// 27.1. ========================================================== Catering Details
router.get("/CateringSalesDetails",authenticateToken,getCEOCateringSalesDetails);
// 28. ============================================================ Sales Contracts Trend
router.get("/SalesContractTrend",authenticateToken,getCEOSalesContractChart);
// 28.1. ============================================================ Sales Contracts Details
router.get("/SalesContractDetails",authenticateToken,getCEOSalesContractDetails);
// 29. ============================================================ Revenue Trend
router.get("/ARRRevPARChart",authenticateToken,getCEOARRRevPARChart);
// 30. ============================================================ Out Of Order Trend
router.get("/OutOfOrderTrend",authenticateToken,getCEOOutOfOrderChart);
// 31. ============================================================ Comp Rooms Count
router.get("/CompRoomsSummary",authenticateToken,getCEOCompRoomsSummary);
// 31.1. ============================================================ Comp Rooms Details
router.get("/CompRoomDetails",authenticateToken,getCEOCompRoomDetails);
module.exports = router;
