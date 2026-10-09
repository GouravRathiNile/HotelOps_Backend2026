const express = require("express");
const router = express.Router();
const authenticateToken = require("../../middleware/authMiddleware");
const {
    saveApprovalFlow, getApprovalFlowList, deleteApprovalFlow
} = require("../../controllers/FlowBuilderController/ApprovalFlowController");

router.post("/Save", authenticateToken, saveApprovalFlow);
router.get("/List", authenticateToken, getApprovalFlowList);
router.delete("/Delete", authenticateToken, deleteApprovalFlow);

module.exports = router;

