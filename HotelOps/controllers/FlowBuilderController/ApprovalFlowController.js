const producer = require("../../producer/producer");
const QUEUE = require("../../config/queue");
const AppError = require("../../utils/AppError");
const handleError = require("../../utils/errorHandler");
const { normalizeIDs, normalizeSave, normalizeList } =
    require("../../utils/ApprovalFlowValidation");

const dispatch = async (res, action, data) => {
    const response = await producer.sendMessage(
        QUEUE.APPROVAL_FLOW.REQUEST, QUEUE.APPROVAL_FLOW.RESPONSE, { action, data }
    );
    if (!response.success) {
        throw new AppError(response.message || "Approval Flow operation failed", response.statusCode || 400);
    }
    return res.status(response.statusCode || 200).json(response);
};
// Save or Update Approval Flow
exports.saveApprovalFlow = async (req, res) => {
    try {
        return await dispatch(res, "SAVE_APPROVAL_FLOW", {
            ...normalizeSave(req.body), UserID: req.user.UserID
        });
    } catch (error) { return handleError(error, res); }
};
// Get approval flow list with optional filters: OrganizationID, ApprovalMasterID, FlowName, ModuleName, IsActive
exports.getApprovalFlowList = async (req, res) => {
    try {
        return await dispatch(res, "GET_APPROVAL_FLOW_LIST", normalizeList(req.query));
    } catch (error) { return handleError(error, res); }
};

// Get module-wise approval configurations
exports.getModuleApprovalConfigurations = async (req, res) => {
    try {
        const { OrganizationID, ModuleName } = req.query;

        return await dispatch(
            res,
            "GET_MODULE_APPROVAL_CONFIGURATIONS",
            {
                OrganizationID:
                    OrganizationID !== undefined &&
                        OrganizationID !== ""
                        ? OrganizationID
                        : null,
                ModuleName:
                    ModuleName !== undefined &&
                        ModuleName.trim() !== ""
                        ? ModuleName.trim()
                        : null
            }
        );
    } catch (error) {
        return handleError(error, res);
    }
};
// Delete approval flow by ApprovalMasterID and OrganizationID
exports.deleteApprovalFlow = async (req, res) => {
    try {
        return await dispatch(res, "DELETE_APPROVAL_FLOW", {
            ...normalizeIDs(req.body, true), DeletedBy: req.user.UserID
        });
    } catch (error) { return handleError(error, res); }
};

