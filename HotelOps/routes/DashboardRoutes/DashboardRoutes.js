const express = require("express");
const authenticateToken = require("../../middleware/authMiddleware");
const {
  getCEORevenueSummary,
  getCEOOccupancy,
  getCEOGlitchAlerts,
  getCEOIncidentAlerts,
  getCEOExpiredAMCAlerts,
  getCEOHotelRevenueVsBudget
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
module.exports = router;
