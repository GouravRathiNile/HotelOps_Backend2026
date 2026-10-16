// Persisted configurations use DOF while Finance approvers resolve as FC.
// Keep approval authorization and notification routing on the same canonical role.
const normalizeRGPApprovalRole = (value, approvalType) => {
  const role = String(value || "").trim().toUpperCase();
  // Builder uses ROLE HOD for both department HOD and the Finance FC stage.
  if (role === "HOD" && ["FC", "FINANCE", "DOF"].includes(
    String(approvalType || "").trim().toUpperCase())) return "FC";
  return ["FC", "FINANCE", "DOF"].includes(role) ? "FC" : role;
};

module.exports = { normalizeRGPApprovalRole };
