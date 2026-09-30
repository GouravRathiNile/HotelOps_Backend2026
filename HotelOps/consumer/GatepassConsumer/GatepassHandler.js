// ============================================================ Service
const GatepassService = require("../../services/GatepassService/GatepassService");
// ============================================================ Database Error
const {
  retryableDatabaseResponse,
} = require("../../utils/retryableDatabaseError");

// ============================================================ Gatepass Handler
const GatepassHandler = async (message) => {
  try {
    switch (message.action) {
      // ================================================================================RGP
      // ========================================================Create
      case "CREATE_RGP":
        return await GatepassService.createRGP(message.data);
      // ========================================================Update
      case "UPDATE_RGP":
        return await GatepassService.updateRGP(message.data);
      // ========================================================Delete
      case "DELETE_RGP":
        return await GatepassService.deleteRGP(message.data);
      // ========================================================RGP_APPROVAL
      case "PROCESS_RGP_APPROVAL":
        return await GatepassService.processRGPApproval(message.data);
      // ========================================================RGP_Action
      case "PROCESS_RGP_GATE_ACTION":
        return await GatepassService.processRGPGateAction(message.data);
      // ========================================================RGP_ITEM_RETURN
      case "PROCESS_RGP_ITEM_RETURN":
        return await GatepassService.processRGPItemReturn(message.data);
      // ========================================================Create Config
      case "SAVE_RGP_APPROVAL_CONFIG":
        return await GatepassService.saveRGPApprovalConfig(message.data);
      // ========================================================Delete Config
      case "DELETE_RGP_APPROVAL_CONFIG":
        return await GatepassService.deleteRGPApprovalConfig(message.data);

      // ================================================================================NRGP
      // ========================================================Create
      case "CREATE_NRGP":
        return await GatepassService.createNRGP(message.data);
      // ========================================================Update
      case "UPDATE_NRGP":
        return await GatepassService.updateNRGP(message.data);
      // ========================================================Delete
      case "DELETE_NRGP":
        return await GatepassService.deleteNRGP(message.data);
      // ========================================================NRGP_APPROVAL
      case "PROCESS_NRGP_APPROVAL":
        return await GatepassService.processNRGPApproval(message.data);
      // ========================================================Create Config
      case "SAVE_NRGP_APPROVAL_CONFIG":
        return await GatepassService.saveNRGPApprovalConfig(message.data);
      // ========================================================Delete Config
      case "DELETE_NRGP_APPROVAL_CONFIG":
        return await GatepassService.deleteNRGPApprovalConfig(message.data);
      // ========================================================
      // Invalid Action
      // ========================================================
      default:
        return {
          success: false,
          statusCode: 400,
          message: "Invalid Gatepass action.",
        };
    }
  } catch (error) {
    console.error("Gatepass Handler Error:", error.message);

    const retryResponse = retryableDatabaseResponse(error);

    if (retryResponse) {
      return retryResponse;
    }

    return {
      success: false,
      statusCode: 500,
      message: "Unable to process Gatepass request.",
    };
  }
};

module.exports = GatepassHandler;
