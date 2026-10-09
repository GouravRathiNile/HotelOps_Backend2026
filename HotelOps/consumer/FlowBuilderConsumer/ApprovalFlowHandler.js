const ApprovalFlowService = require("../../services/FlowBuilderService/ApprovalFlowService");
const { retryableDatabaseResponse } = require("../../utils/retryableDatabaseError");

const ApprovalFlowHandler = async (payload) => {
    try {
        const { action, data } = payload;
        switch (action) {
            case "SAVE_APPROVAL_FLOW":
                return await ApprovalFlowService.saveApprovalFlow(data);
            case "GET_APPROVAL_FLOW_LIST":
                return await ApprovalFlowService.getApprovalFlowList(data);
            case "DELETE_APPROVAL_FLOW":
                return await ApprovalFlowService.deleteApprovalFlow(data);
            default:
                return { success: false, statusCode: 400, message: "Invalid Action" };
        }
    } catch (error) {
        return retryableDatabaseResponse(error) || {
            success: false, statusCode: error.statusCode || 500, message: error.message
        };
    }
};

module.exports = ApprovalFlowHandler;

