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
  getRGPVendorNames,
  getRGPListReportPdf,
  getRGPDepartmentWiseReportPdf,
  getRGPVendorWiseReportPdf,
  getRGPPendingReturnReportPdf,
  generateRGPDetailPdf,

  createNRGP,
  getNRGPList,
  getNRGPById,
  updateNRGP,
  deleteNRGP,
  processNRGPApproval,
  getNRGPApprovalConfig,
  saveNRGPApprovalConfig,
  deleteNRGPApprovalConfig,
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
// =============================================================PDF
router.get("/RGPListReportspdf",authenticateToken,getRGPListReportPdf,);
router.get("/DepartmentWiseReportspdf",authenticateToken,getRGPDepartmentWiseReportPdf,);
router.get("/VendorWiseReportspdf",authenticateToken,getRGPVendorWiseReportPdf,);
router.get("/PendingReturnReportspdf",authenticateToken,getRGPPendingReturnReportPdf,);
router.get("/RGPById/:id",authenticateToken,getRGPById,);
router.get("/RGPDetailPdf",authenticateToken,generateRGPDetailPdf,);

// ==================================================================================NRGP
router.post("/CreateNRGP",authenticateToken,createNRGP,);
router.get("/NRGPList",authenticateToken,getNRGPList,);
router.get("/NRGPById",authenticateToken,getNRGPById,);
router.put("/UpdateNRGP",authenticateToken,updateNRGP,);
router.delete("/DeleteNRGP",authenticateToken,deleteNRGP,);
router.put("/ApproveNRGP",authenticateToken,processNRGPApproval,);
router.get("/NRGPApprovalConfigList",authenticateToken,getNRGPApprovalConfig,);
router.post("/CreateApprovalConfigNRGP",authenticateToken,saveNRGPApprovalConfig,);
router.delete("/DeleteNRGPApprovalConfig",authenticateToken,deleteNRGPApprovalConfig,);
module.exports = router;