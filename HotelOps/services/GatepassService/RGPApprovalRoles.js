// Persisted configurations use DOF while Finance approvers resolve as FC.
// Keep approval authorization and notification routing on the same canonical role.
const normalizeRGPApprovalRole = (value) => {
  const role = String(value || "").trim().toUpperCase();
  return ["FC", "FINANCE", "DOF"].includes(role) ? "FC" : role;
};

module.exports = { normalizeRGPApprovalRole };
