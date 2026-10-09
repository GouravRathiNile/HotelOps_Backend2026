const AppError = require("./AppError");

const positiveID = (value, name) => {
    if (!["string", "number"].includes(typeof value) ||
        !Number.isSafeInteger(Number(value)) || Number(value) <= 0) {
        throw new AppError(`${name} must be a positive integer`, 400);
    }
    return Number(value);
};

const requiredText = (value, name) => {
    if (typeof value !== "string" || !value.trim()) {
        throw new AppError(`${name} is required`, 400);
    }
    return value.trim();
};

const normalizeIDs = (data = {}, requireMasterID = false) => ({
    OrganizationID: positiveID(data.OrganizationID, "OrganizationID"),
    ...(requireMasterID || data.ApprovalMasterID != null
        ? { ApprovalMasterID: positiveID(data.ApprovalMasterID, "ApprovalMasterID") }
        : {})
});

const normalizeSave = (data = {}) => {
    // Create forms send an empty ID; only a populated ID selects an update.
    const masterID = data.ApprovalMasterID;
    const ids = normalizeIDs({
        ...data,
        ApprovalMasterID: typeof masterID === "string" && !masterID.trim()
            ? undefined : masterID
    });
    if (data.IsActive !== undefined && typeof data.IsActive !== "boolean") {
        throw new AppError("IsActive must be a boolean", 400);
    }
    if (data.Description != null && typeof data.Description !== "string") {
        throw new AppError("Description must be a string", 400);
    }
    if (!Array.isArray(data.Details) || !data.Details.length) {
        throw new AppError("At least one approval level is required", 400);
    }
    return {
        ...ids,
        FlowName: requiredText(data.FlowName, "FlowName"),
        ModuleName: requiredText(data.ModuleName, "ModuleName"),
        Description: data.Description?.trim() || null,
        IsActive: data.IsActive,
        Details: data.Details.map((detail) => {
            if (!detail || typeof detail !== "object" || Array.isArray(detail)) {
                throw new AppError("Each approval level must be an object", 400);
            }
            if (detail.IsMandatory !== undefined && typeof detail.IsMandatory !== "boolean") {
                throw new AppError("IsMandatory must be a boolean", 400);
            }
            return { ...detail, IsMandatory: detail.IsMandatory ?? true };
        })
    };
};

const normalizeList = (data = {}) => {
    let IsActive = data.IsActive;
    if (IsActive === "") IsActive = undefined;
    if (IsActive === "true") IsActive = true;
    if (IsActive === "false") IsActive = false;
    if (IsActive !== undefined && typeof IsActive !== "boolean") {
        throw new AppError("IsActive must be true or false", 400);
    }
    return {
        ...normalizeIDs(data),
        page: positiveID(data.page ?? 1, "page"),
        limit: positiveID(data.PageSize ?? data.limit ?? 10, "PageSize"),
        FlowName: typeof data.FlowName === "string" ? data.FlowName.trim() : "",
        ModuleName: typeof data.ModuleName === "string" ? data.ModuleName.trim() : "",
        IsActive
    };
};

module.exports = { normalizeIDs, normalizeSave, normalizeList };

