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

exports.saveApprovalFlow = async (req, res) => {
    try {
        return await dispatch(res, "SAVE_APPROVAL_FLOW", {
            ...normalizeSave(req.body), UserID: req.user.UserID
        });
    } catch (error) { return handleError(error, res); }
};

exports.getApprovalFlowList = async (req, res) => {
    try {
        return await dispatch(res, "GET_APPROVAL_FLOW_LIST", normalizeList(req.query));
    } catch (error) { return handleError(error, res); }
};

exports.deleteApprovalFlow = async (req, res) => {
    try {
        return await dispatch(res, "DELETE_APPROVAL_FLOW", {
            ...normalizeIDs(req.body, true), DeletedBy: req.user.UserID
        });
    } catch (error) { return handleError(error, res); }
};

