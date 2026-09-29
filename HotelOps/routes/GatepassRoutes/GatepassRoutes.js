const express = require("express");
const authenticateToken = require("../../middleware/authMiddleware");
const upload = require("../../middleware/upload");
const {
  createRGP,
  getRGPList,
  getRGPById,
  getRGPByNumber,
  updateRGP,
  deleteRGP,
  processRGPApproval,
  processRGPGateAction,
  processRGPItemReturn,
  getRGPApprovalConfig,
  saveRGPApprovalConfig,
  deleteRGPApprovalConfig,
  getRGPListReport,
  getRGPDepartmentWiseReport,
  getRGPVendorWiseReport,
  getRGPPendingReturnReport,
  getRGPVendorNames
} = require(
  "../../controllers/GatepassController/GatepassController",
)
const router = express.Router();

// ==================================================================================RGP
router.post("/CreateRGP",authenticateToken,upload.array("Documents", 10),createRGP,);
router.get("/RGPList",authenticateToken,getRGPList,);
router.get("/RGPById/:id",authenticateToken,getRGPById,);
router.get("/RGPByNumber",authenticateToken,getRGPByNumber,);
router.get("/VendorNames",authenticateToken,getRGPVendorNames,);
router.put("/UpdateRGP",authenticateToken,upload.array("Documents", 10),updateRGP,);
router.delete("/DeleteRGP",authenticateToken,deleteRGP,);
router.put("/ApproveRGP",authenticateToken,processRGPApproval,);
router.put("/RGPGateAction",authenticateToken,processRGPGateAction,);
router.put("/RGPItemReturn",authenticateToken,processRGPItemReturn,);
router.get("/ApprovalConfigList",authenticateToken,getRGPApprovalConfig,);
router.post("/CreateApprovalConfig",authenticateToken,saveRGPApprovalConfig,);
router.delete("/DeleteApprovalConfig",authenticateToken,deleteRGPApprovalConfig,);
// =============================================================Reports
router.get("/RGPListReports",authenticateToken,getRGPListReport,);
router.get("/DepartmentWiseReports",authenticateToken,getRGPDepartmentWiseReport,);
router.get("/VendorWiseReports",authenticateToken,getRGPVendorWiseReport,);
router.get("/PendingReturnReports",authenticateToken,getRGPPendingReturnReport,);

module.exports = router;