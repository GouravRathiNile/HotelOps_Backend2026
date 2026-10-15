const express = require("express");
const authenticateToken = require("../../middleware/authMiddleware");
const {
  getCEORevenueSummary,
  getCEOOccupancy,
} = require(
  "../../controllers/DashboardController/DashboardController",
)
const router = express.Router();

// ==============================================================================================CEO Dashboard 
// 1.=============================================================Top Drr Revenre Data
router.get("/RevenueSummary",authenticateToken,getCEORevenueSummary);
// 2. ============================================================ Get CEO Occupancy
router.get("/OccupancyTrend",authenticateToken,getCEOOccupancy);

module.exports = router;
