const normalize = (value) => String(value ?? "").trim().toUpperCase();

// Infer only the old FC/GM role snapshots; never override explicit assignments.
const isLegacyCreditApprover = (step, context) => {
  if (normalize(step.ApproverType)) return false;
  const role = normalize(step.ApprovalRole || step.ApprovalType);
  const value = normalize(step.ApproverValue);
  if (["FC", "FINANCE"].includes(role) && ["FC", "FINANCE"].includes(value)) {
    return normalize(context.DepartmentName) === "FINANCE";
  }
  return role === "GM" && value === "GM" &&
    (normalize(context.UserType) === "GM" || normalize(context.DepartmentName) === "GM");
};

// Arguments are internal SQL aliases/placeholders, never request values.
const creditApproverAssignmentSql = (alias, userID, username, userType, department) => {
  const upper = (expression) => `UPPER(TRIM(COALESCE(${expression}, '')))`;
  const role = upper(`${alias}.ApprovalRole`);
  const type = upper(`${alias}.ApproverType`);
  const value = upper(`${alias}.ApproverValue`);
  const dept = upper(`(${department})::text`);
  const userRole = upper(`(${userType})::text`);
  return `(
    (${role} NOT IN ('FC', 'FINANCE') OR ${dept} = 'FINANCE')
    AND (
      (${type} IN ('USER', 'REGIONAL') AND (
        TRIM(COALESCE(${alias}.ApproverValue, '')) = TRIM((${userID})::text)
        OR ${value} = ${upper(`(${username})::text`)}
      ))
      OR (${type} = 'ROLE' AND ${value} IN (${userRole}, ${dept}))
      OR (${type} = '' AND (
        (${role} IN ('FC', 'FINANCE') AND ${value} IN ('FC', 'FINANCE') AND ${dept} = 'FINANCE')
        OR (${role} = 'GM' AND ${value} = 'GM' AND (${userRole} = 'GM' OR ${dept} = 'GM'))
      ))
    )
  )`;
};

module.exports = { isLegacyCreditApprover, creditApproverAssignmentSql };
