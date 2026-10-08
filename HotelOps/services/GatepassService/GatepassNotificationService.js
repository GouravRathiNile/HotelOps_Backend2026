const { pool } = require("../../db");

const { normalizeRGPApprovalRole } = require("./RGPApprovalRoles");
const notificationUserIds = (values) => [...new Set(values
  .filter((value) => value != null && /^[1-9]\d*$/.test(String(value).trim()))
  .map((value) => String(value).trim()))].sort();

// The caller captures these rows in the gatepass transaction. Re-reading the
// current stage after commit could describe a later approver's action instead.
const resolveRGPEvent = ({ master, approvals, approvalID, action, remarks }) => {
  const stages = [...approvals].sort((a, b) =>
    Number(a.approvalorder) - Number(b.approvalorder) ||
    Number(a.approvallevel) - Number(b.approvallevel) ||
    Number(a.rgpapprovalid) - Number(b.rgpapprovalid));
  const currentIndex = stages.findIndex((row) => String(row.rgpapprovalid) === String(approvalID));
  const current = stages[currentIndex];
  if (action !== "CREATE" && !current) throw new Error("RGP notification approval history is missing");
  if (!["CREATE", "APPROVE", "REJECT", "CANCEL"].includes(action)) {
    throw new Error("Unsupported RGP notification action");
  }
  const next = stages.find((row) => String(row.rgpapprovalid) !== String(approvalID) &&
    (action === "CREATE" || Number(row.approvalorder) > Number(current.approvalorder)) &&
    String(row.status || "Pending").trim().toUpperCase() !== "APPROVED");
  const approverRole = normalizeRGPApprovalRole(current?.approvalrole);
  const nextRole = normalizeRGPApprovalRole(next?.approvalrole);
  const directUserIds = [];
  let recipientRole = null;
  if (action === "CREATE" || (action === "APPROVE" && next)) {
    if (!nextRole) throw new Error("RGP notification next approval role is missing");
    recipientRole = nextRole;
  } else {
    directUserIds.push(master.createdby);
    if (action === "REJECT" || action === "CANCEL") {
      // Notify the actual previous actor, even if their role has since changed.
      const previous = stages.slice(0, currentIndex).reverse().find((row) =>
        String(row.status).trim().toUpperCase() === "APPROVED");
      directUserIds.push(previous?.actionby);
    }
  }
  if (action !== "CREATE" && !approverRole) throw new Error("RGP notification approver role is missing");
  return { master, action, approverRole, nextRole, recipientRole,
    directUserIds: notificationUserIds(directUserIds), remarks,
    // Each persisted approval row is terminal. Its ID separates repeated roles.
    eventAction: action === "CREATE" ? "RGP_CREATED" : `RGP_APPROVAL_${current.rgpapprovalid}_${action}` };
};

const resolveRGPNotificationRecipients = async ({ master, recipientRole, directUserIds,
  queryable = pool }) => {
  const result = await queryable.query(`
    SELECT DISTINCT um.UserID, om.ShortName, rgp_department.DepartmentName AS RGPDepartmentName,
      ARRAY(SELECT item.ItemName FROM Gatepass_RGP_Entry_Item_Details item
        WHERE item.RGPID = $5 AND item.OrganizationID = $1 AND item.IsDeleted = FALSE
        ORDER BY item.RGPItemID) AS ItemNames
    FROM organization_master om
    INNER JOIN user_org_mapping uom ON uom.OrganizationID = om.OrganizationID
      AND uom.IsActive = TRUE AND uom.IsDeleted = FALSE
    INNER JOIN user_master um ON um.UserID = uom.UserID
    LEFT JOIN department_master dm ON dm.DepartmentID = um.DepartmentID
    LEFT JOIN department_master rgp_department ON rgp_department.DepartmentID = $3
      AND rgp_department.OrganizationID = $1 AND rgp_department.IsDeleted = FALSE
    WHERE om.OrganizationID = $1
      AND om.IsActive = TRUE AND om.ActivationStatus = TRUE AND om.IsDeleted = FALSE
      AND um.IsActive = TRUE AND um.IsDeleted = FALSE AND um.IsLocked = FALSE
      AND (
        um.UserID::text = ANY($4::text[])
        OR ($2 = 'HOD' AND UPPER(TRIM(um.UserType)) = 'HOD'
          AND um.DepartmentID = $3 AND dm.OrganizationID = $1 AND dm.IsDeleted = FALSE
          AND UPPER(TRIM(COALESCE(dm.DepartmentName, ''))) NOT IN ('FC', 'FINANCE'))
        OR ($2 = 'FC' AND UPPER(TRIM(um.UserType)) = 'HOD'
          AND dm.OrganizationID = $1 AND dm.IsDeleted = FALSE
          AND UPPER(TRIM(COALESCE(dm.DepartmentName, ''))) IN ('FC', 'FINANCE'))
        OR ($2 NOT IN ('HOD', 'FC') AND UPPER(TRIM(um.UserType)) = $2)
      );`, [master.organizationid, normalizeRGPApprovalRole(recipientRole) || null, master.departmentid, directUserIds, master.rgpid]);
  return { userIds: notificationUserIds(result.rows.map((row) => row.userid)),
    organizationShortName: result.rows[0]?.shortname,
    departmentName: result.rows[0]?.rgpdepartmentname,
    itemNames: result.rows[0]?.itemnames || [] };
};

const cleanText = (value) => {
  const text = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  return /^(null|undefined)$/i.test(text) ? "" : text;
};
const shorten = (value, limit) => {
  const characters = Array.from(cleanText(value));
  return characters.length > limit ? `${characters.slice(0, limit - 1).join("").trimEnd()}\u2026` : characters.join("");
};

const buildRGPNotificationContent = ({ action, approverRole, nextRole, remarks,
  organizationShortName, departmentName, itemNames = [] }) => {
  const department = shorten(departmentName, 60);
  const uniqueItems = new Map();
  for (const value of Array.isArray(itemNames) ? itemNames : []) {
    const name = cleanText(value);
    if (name && !uniqueItems.has(name.toLowerCase())) uniqueItems.set(name.toLowerCase(), name);
  }
  const items = [...uniqueItems.values()];
  const itemSummary = (count, limit, compact = false) => {
    const visible = items.slice(0, count).map(name => shorten(name, limit));
    const remaining = items.length - visible.length;
    if (!remaining) return visible.join(" and ");
    return compact ? `${visible.join(", ")} +${remaining} more` :
      `${visible.join(", ")}, and ${remaining} other ${remaining === 1 ? "item" : "items"}`;
  };
  const hod = department ? `${department}${/\bdepartment$/i.test(department) ? "" : " Department"} HOD` : "Department HOD";
  const roleLabel = role => ({ HOD: hod, FC: "Finance HOD (DOF)" })[role] || shorten(role, 40) || "the approver";
  const actor = approverRole === "HOD" ? `The ${hod}` : roleLabel(approverRole);
  // Use only verified display fields; never substitute full organization names
  // or gatepass identifiers when short names or item details are unavailable.
  const title = ["RGP", shorten(department, 32), shorten(itemSummary(1, 36, true), 48),
    shorten(organizationShortName, 24)].filter(Boolean).join(" \u2022 ");
  let message;
  if (action === "CREATE") {
    message = `A returnable gate pass${items.length ? ` for ${itemSummary(2, 65)}` : ""}${department ? ` from ${department}` : ""} requires your approval.`;
  } else if (action === "REJECT" || action === "CANCEL") {
    const reason = shorten(remarks, 300);
    message = `${actor} ${action === "REJECT" ? "rejected" : "cancelled"} the RGP.${reason ? ` Remarks: ${reason}` : ""}`;
  } else if (nextRole) {
    message = `${actor} approved the RGP. It is now awaiting ${roleLabel(nextRole)} approval.`;
  } else {
    message = `Your returnable gate pass has been approved.${approverRole === "GM" ? " Please proceed with checkout." : ""}`;
  }
  return { title, message };
};

const notifyRGPEvent = async (event, { queryable = pool, publishNotification } = {}) => {
  const context = resolveRGPEvent(event);
  const recipients = await resolveRGPNotificationRecipients({ ...context, queryable });
  if (!recipients.userIds.length) return { skipped: true, reason: "no-eligible-recipient" };
  const content = buildRGPNotificationContent({ ...context, ...recipients });
  const send = publishNotification || (async (data) => {
    const { sendMessage } = require("../../producer/producer");
    const QUEUE = require("../../config/queue");
    return sendMessage(QUEUE.NOTIFICATION.REQUEST, QUEUE.NOTIFICATION.RESPONSE,
      { action: "CREATE_NOTIFICATION", data });
  });
  const response = await send({ organizationId: event.master.organizationid,
    ...content, type: "info", moduleName: "Gatepass", entityType: "RGP",
    entityId: String(event.master.rgpid), action: context.eventAction,
    priority: "normal", userIds: recipients.userIds });
  if (!response || response.success !== true) {
    throw new Error(response?.message || "RGP notification request unsuccessful");
  }
  return { skipped: false, queued: response.queued === true };
};

// Called after commit and connection release. Delivery never participates in
// gatepass success/rollback handling. This follows the existing best-effort pattern.
const notifyCommittedRGPEvent = (event, dependencies) => Promise.resolve()
  .then(() => notifyRGPEvent(event, dependencies))
  .then((result) => {
    if (result.skipped) console.warn("RGP notification skipped:",
      event.master.rgpid, event.approvalID || "CREATE", result.reason);
    return result;
  })
  .catch((error) => {
    console.error("RGP notification failed:", event.master.rgpid,
      event.approvalID || "CREATE", event.action, error.message);
    return { failed: true };
  });

module.exports = { resolveRGPEvent, resolveRGPNotificationRecipients,
  buildRGPNotificationContent, notifyRGPEvent, notifyCommittedRGPEvent };
