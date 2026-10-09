const express = require("express");
const router = express.Router();
const authenticateToken = require("../../middleware/authMiddleware");
const {
    saveApprovalFlow, getApprovalFlowList, getModuleApprovalConfigurations, deleteApprovalFlow
} = require("../../controllers/FlowBuilderController/ApprovalFlowController");

// ============================================================// Approval Flow Routes
// Save or Update Approval Flow
router.post("/Save", authenticateToken, saveApprovalFlow);
// Get Approval Flow List with optional filters: OrganizationID, ApprovalMasterID, FlowName, ModuleName, IsActive
router.get("/List", authenticateToken, getApprovalFlowList);
// Get module-wise approval configurations
// Optional query parameters: OrganizationID, ModuleName
router.get("/Module-Configurations", authenticateToken, getModuleApprovalConfigurations);
// Delete Approval Flow by ApprovalMasterID and OrganizationID
router.delete("/Delete", authenticateToken, deleteApprovalFlow);

module.exports = router;

