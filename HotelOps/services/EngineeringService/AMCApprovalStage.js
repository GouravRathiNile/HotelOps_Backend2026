// RD is the legacy name of the RD-FC business stage, not an assignment role.
const normalizeAMCApprovalStage = (value) => {
  const stage = String(value ?? '').trim().toUpperCase();
  return stage === 'RD' ? 'RD-FC' : stage;
};

const amcApprovalStageSQL = (expression) =>
  `(CASE WHEN UPPER(TRIM(${expression}))='RD' THEN 'RD-FC' ELSE UPPER(TRIM(${expression})) END)`;

module.exports = { normalizeAMCApprovalStage, amcApprovalStageSQL };
