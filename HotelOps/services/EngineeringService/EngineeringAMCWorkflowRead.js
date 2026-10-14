const { pool } = require('../../db');
const AppError = require('../../utils/AppError');
const { formatDate } = require('../../utils/dateFormatter');
const documentUrl = require('../../AzurConfigration/Engineering/AzureGetData');
const workflow = require('./EngineeringAMCWorkflow');
const { AMC_RD_ORGANIZATION_ID } = require('./EngineeringAMCApprovalNotificationService');
const positiveID = (value,name) => {
    if (!/^[1-9]\d*$/.test(String(value??''))) throw new AppError(name+' must be a positive integer',400);
    return value;
};
const assignmentSQL = (step='s') => `(
    (${step}->>'approvertype'='REGIONAL' AND r.regionaleligible AND ${step}->>'assigneduserid'=$1::text)
    OR (${step}->>'approvertype'='ROLE' AND ${step}->>'role'='RD' AND r.iscentralrd)
    OR (r.organizationaccess AND (
      (${step}->>'approvertype'='USER' AND ${step}->>'assigneduserid'=$1::text)
      OR (${step}->>'approvertype'='ROLE' AND CASE UPPER(${step}->>'role')
        WHEN 'FC' THEN UPPER(TRIM(r.actorrole))='HOD' AND UPPER(TRIM(r.actordepartmentname))='FINANCE'
          AND r.actordepartmentorganizationid=r.organizationid AND NOT r.iscentralrd
        WHEN 'HOD' THEN UPPER(TRIM(r.actorrole))='HOD' AND r.actordepartmentorganizationid=r.organizationid
          AND CASE WHEN UPPER(TRIM(${step}->>'approvaltype'))='FC'
            THEN UPPER(TRIM(r.actordepartmentname))='FINANCE' AND NOT r.iscentralrd
            ELSE r.actordepartmentid=r.departmentid END
        WHEN 'RD' THEN FALSE
        ELSE UPPER(${step}->>'role')=UPPER(TRIM(r.actorrole)) END))))`;
const base = `WITH actor AS (
    SELECT * FROM user_master WHERE userid=$1 AND isactive AND NOT isdeleted AND NOT islocked
), records AS (
    SELECT m.*,e.departmentid,e.description,e.serialnumber,e.typeofmachine,e.capacity,e.modelnumber,
      e.make,e.area,e.commissioningdate,e.warrantystartdate,e.warrantyenddate,e.warrantystatus,
      e.scheduleofservicing,e.scheduleday,e.responsibleperson,e.amcstatus,e.amcyearlyexpense,
      aa.amcapprovalid,aa.finalstatus,aa.finalstatusdatetime,aa.approvalmasterid,
      om.shortname AS organizationshortname,om.organizationname,
      ed.departmentname,person.fullname AS responsiblepersonname,
      a.usertype AS actorrole,a.departmentid AS actordepartmentid,ad.departmentname AS actordepartmentname,
      ad.organizationid AS actordepartmentorganizationid,
      COALESCE(a.logintype='SuperAdmin' AND a.allorganizationaccess,FALSE) AS adminaccess,
      ${workflow.centralRDSQL('a')} AS iscentralrd,
      ${workflow.regionalEligibilitySQL('a','om')} AS regionaleligible,
      COALESCE(om.parentorganizationid,om.organizationid) AS companyorganizationid,
      (EXISTS(SELECT 1 FROM user_org_mapping member WHERE member.userid=a.userid AND member.organizationid=m.organizationid
          AND member.isactive AND NOT member.isdeleted)
        OR COALESCE(a.logintype='SuperAdmin' AND a.allorganizationaccess,FALSE)) AS organizationaccess,
      steps.steps,cs.currentstep
    FROM engineering_amc_master m JOIN engineering_amc_approval aa ON aa.amcid=m.amcid AND NOT aa.isdeleted
    JOIN engineering_equipment_entry_master e ON e.equipmentid=m.equipmentid AND e.organizationid=m.organizationid AND NOT e.isdeleted
    JOIN organization_master om ON om.organizationid=m.organizationid AND om.isactive AND om.activationstatus AND NOT om.isdeleted
    CROSS JOIN actor a
    LEFT JOIN department_master ed ON ed.departmentid=e.departmentid AND NOT ed.isdeleted
    LEFT JOIN department_master ad ON ad.departmentid=a.departmentid AND NOT ad.isdeleted
    LEFT JOIN user_master person ON person.userid=e.responsibleperson
    JOIN LATERAL (SELECT jsonb_agg(s.step ORDER BY (s.step->>'level')::int,s.step->>'stepid') AS steps
      FROM (
        SELECT to_jsonb(s)||jsonb_build_object('actionbyname',u.fullname) AS step
        FROM engineering_amc_workflow_step s LEFT JOIN user_master u ON u.userid=s.actionby WHERE s.amcid=m.amcid
        UNION ALL
        SELECT jsonb_build_object('stepid','legacy:'||cfg.role,'level',cfg.level,'approvertype','ROLE',
          'role',cfg.role,'approvaltype',cfg.role,'ismandatory',TRUE,'status',
          COALESCE(to_jsonb(aa)->>(lower(cfg.role)||'status'),'Pending'),
          'remarks',to_jsonb(aa)->>(lower(cfg.role)||'remarks'),
          'actionby',to_jsonb(aa)->>(lower(cfg.role)||'statusapprovedby'),
          'actiondatetime',to_jsonb(aa)->>(lower(cfg.role)||'statusdatetime'),'actionbyname',acted.fullname,'revision',0)
        FROM (
          SELECT UPPER(TRIM(approvalrole)) AS role,ROW_NUMBER() OVER(ORDER BY approvalorder,approvallevel,amcapprovalconfigid) AS level
          FROM engineering_amc_approval_config WHERE organizationid=m.organizationid AND NOT isdeleted
          UNION ALL
          SELECT role,level FROM (VALUES(1,'FC'),(2,'GM'),(3,'RD'),(4,'CEO')) defaults(level,role)
          WHERE NOT EXISTS(SELECT 1 FROM engineering_amc_approval_config WHERE organizationid=m.organizationid AND NOT isdeleted)
        ) cfg LEFT JOIN user_master acted ON acted.userid=(to_jsonb(aa)->>(lower(cfg.role)||'statusapprovedby'))::bigint
        WHERE NOT EXISTS(SELECT 1 FROM engineering_amc_workflow_step s WHERE s.amcid=m.amcid)
      ) s) steps ON steps.steps IS NOT NULL
    LEFT JOIN LATERAL (SELECT s AS currentstep FROM jsonb_array_elements(steps.steps) s
      WHERE (s->>'ismandatory')::boolean AND UPPER(s->>'status')<>'APPROVED' LIMIT 1) cs ON TRUE
    WHERE NOT m.isdeleted
)`;
const buildQuery = (data={},list=false) => {
    positiveID(data.UserID,'Authenticated UserID');
    const values=[data.UserID],conditions=[];
    const add=(sql,value)=>{values.push(value);conditions.push(sql.replace('?',`$${values.length}`));};
    conditions.push(`(r.organizationaccess OR EXISTS(SELECT 1 FROM jsonb_array_elements(r.steps) s
      WHERE (s->>'ismandatory')::boolean AND ${assignmentSQL()}))`);
    // Keep legacy non-approver organization viewers, creator and SuperAdmin access.
    // Approvers see their current step or recorded stage, never a future pending assignment.
    const assigned=`EXISTS(SELECT 1 FROM jsonb_array_elements(r.steps) s WHERE (s->>'ismandatory')::boolean AND ${assignmentSQL()})`;
    const reached=`EXISTS(SELECT 1 FROM jsonb_array_elements(r.steps) s WHERE (s->>'ismandatory')::boolean
      AND ${assignmentSQL()} AND (s->>'stepid'=r.currentstep->>'stepid' OR UPPER(s->>'status')<>'PENDING'))`;
    const viewer=`(r.createdby=$1 OR r.adminaccess OR (r.organizationaccess AND NOT ${assigned}
      AND UPPER(TRIM(r.actorrole)) NOT IN ('GM','CEO','FC','RD')
      AND NOT (UPPER(TRIM(r.actorrole))='HOD' AND UPPER(TRIM(r.actordepartmentname))='FINANCE')))`;
    conditions.push(`(${viewer} OR ${reached})`);
    if (data.OrganizationID!=null) {
        positiveID(data.OrganizationID,'OrganizationID');
        values.push(data.OrganizationID);
        const param=`$${values.length}`;
        conditions.push(`(r.organizationid=${param} OR (r.iscentralrd AND ${param}::bigint=${AMC_RD_ORGANIZATION_ID})
          OR (r.regionaleligible AND r.companyorganizationid=${param} AND ${assigned}))`);
        if (list && Number(data.OrganizationID)!==AMC_RD_ORGANIZATION_ID) {
            // Legacy RD global selection is distinct from selecting an unmapped hotel.
            // Explicit Regional snapshot assignments may grant access to that hotel.
            conditions.push(`(r.organizationaccess OR (r.regionaleligible AND EXISTS(
              SELECT 1 FROM jsonb_array_elements(r.steps) s WHERE (s->>'ismandatory')::boolean
                AND s->>'approvertype'='REGIONAL' AND s->>'assigneduserid'=$1::text)))`);
        }
    } else if (list) throw new AppError('OrganizationID is required',400);
    if (data.AMCID!=null) add('r.amcid=?',positiveID(data.AMCID,'AMCID'));
    if (data.EquipmentID!=null && String(data.EquipmentID).trim()) add('r.equipmentid=?',positiveID(data.EquipmentID,'EquipmentID'));
    if (data.Search) {
        values.push(String(data.Search));
        conditions.push(`concat_ws(' ',r.vendorname,r.vendoremailaddress,r.vendormobilenumber,r.amctype,r.description,r.serialnumber,r.make,r.modelnumber,r.area) ILIKE '%'||$${values.length}||'%'`);
    }
    const status=workflow.normalized(data.Status),stage=workflow.normalized(data.ApprovalFlow);
    if (status && !['PENDING','APPROVED','REJECTED','RETURNED'].includes(status)) throw new AppError('Invalid AMC status',400);
    if (stage) {
        values.push(stage);let predicate=`UPPER(s->>'approvaltype')=$${values.length}`;
        if (status) {values.push(status);predicate+=` AND UPPER(s->>'status')=$${values.length}`;
            if (status==='PENDING') predicate+=` AND s->>'stepid'=r.currentstep->>'stepid'`;}
        conditions.push(`EXISTS(SELECT 1 FROM jsonb_array_elements(r.steps) s WHERE ${predicate})`);
    } else if (status) {
        values.push(status);const param=`$${values.length}`;
        conditions.push(`((${viewer} AND UPPER(COALESCE(r.currentstep->>'status',r.finalstatus,'Approved'))=${param})
          OR EXISTS(SELECT 1 FROM jsonb_array_elements(r.steps) s WHERE (s->>'ismandatory')::boolean
            AND ${assignmentSQL()} AND UPPER(s->>'status')=${param}
            AND (${param}<>'PENDING' OR s->>'stepid'=r.currentstep->>'stepid')))`);
    }
    return {cte:base,where:' WHERE '+conditions.join(' AND '),values};
};
const mapRow = (row,userID,mapAMC) => {
    const steps=row.steps||[],current=workflow.currentStep(steps);
    const actor={userid:userID,usertype:row.actorrole,departmentid:row.actordepartmentid,
      departmentname:row.actordepartmentname,departmentorganizationid:row.actordepartmentorganizationid,
      organizationaccess:row.organizationaccess,regionaleligible:row.regionaleligible,iscentralrd:row.iscentralrd};
    const result=mapAMC({...row,currentapprovalrole:workflow.normalized(row.finalstatus)==='APPROVED'?null:current?.approvaltype,
      currentstatus:workflow.normalized(row.finalstatus)==='APPROVED'?'Approved':current?.status||row.finalstatus||'Approved'});
    result.CurrentApprovalStepID=workflow.normalized(row.finalstatus)==='APPROVED'
      || String(current?.stepid??'').startsWith('legacy:') ? null : current?.stepid||null;
    result.WorkflowSource=row.approvalmasterid==null?'LEGACY':'BUILDER';
    result.CanApprove=steps.some(step=>workflow.allowedActions(row,steps,step,actor).includes('APPROVE'));
    result.DepartmentName=row.departmentname??null;
    result.DepartmentID=row.departmentid==null?null:Number(row.departmentid);
    result.ResponsiblePersonName=row.responsiblepersonname??null;
    result.AMCStatus=row.amcstatus??null;
    result.AMCYearlyExpense=row.amcyearlyexpense==null?null:Number(row.amcyearlyexpense);
    const occurrences=new Map();
    result.Approvals=steps.map(step=>{
        const stage=workflow.normalized(step.approvaltype),occurrence=(occurrences.get(stage)||0)+1;
        occurrences.set(stage,occurrence);
        const actions=workflow.allowedActions(row,steps,step,actor);
        return {LevelNo:step.level,Level:step.level,ApprovalRole:step.approvaltype,ApprovalType:step.approvaltype,
          ApprovalStepID:String(step.stepid).startsWith('legacy:')?null:step.stepid,ColumnKey:`stage:${stage}:${occurrence}`,ApproverType:step.approvertype,
          Role:step.role,AssignedUserID:step.assigneduserid,IsMandatory:step.ismandatory,
          Status:step.ismandatory===false&&step.status==='Pending'?'Skipped':step.status,
          StatusDateTime:formatDate(step.actiondatetime)||null,Remarks:step.remarks??null,
          ActionBy:step.actionby,ApprovedByName:step.actionbyname??null,Revision:step.revision,
          CanApprove:actions.includes('APPROVE'),AllowedActions:actions};
    });
    return result;
};
const attachDocuments = async (rows) => {
    if (!rows.length) return;
    const docs=await pool.query(`SELECT * FROM engineering_amc_documents WHERE amcid=ANY($1::bigint[])
      AND NOT isdeleted ORDER BY amcdocumentid`,[rows.map(r=>r.AMCID)]);
    const byID=new Map(rows.map(r=>[String(r.AMCID),r]));
    for (const row of docs.rows) byID.get(String(row.amcid))?.Documents.push({AMCDocumentID:Number(row.amcdocumentid),
      AMCID:Number(row.amcid),OrganizationID:Number(row.organizationid),FileName:row.filename,
      FilePath:row.filepath?documentUrl(row.filepath):null,FileType:row.filetype,FileSize:row.filesize});
};
const hasSnapshots = async (amcID=null) => (await pool.query(`SELECT EXISTS(SELECT 1 FROM engineering_amc_workflow_step
    WHERE ($1::bigint IS NULL OR amcid=$1)) AS present`,[amcID])).rows[0]?.present===true;
const list = async (data,mapAMC) => {
    if (!await hasSnapshots()) return null;
    const page=Number(data.page??1),size=Number(data.PageSize??10);
    if (!Number.isInteger(page)||page<=0||!Number.isInteger(size)||size<=0||size>100) throw new AppError('Invalid AMC pagination',400);
    const q=buildQuery(data,true);
    const result=await pool.query(`${q.cte} SELECT r.* FROM records r ${q.where}
      ORDER BY r.createddate DESC,r.amcid DESC LIMIT $${q.values.length+1} OFFSET $${q.values.length+2}`,[...q.values,size,(page-1)*size]);
    const count=await pool.query(`${q.cte} SELECT COUNT(*) AS count FROM records r ${q.where}`,q.values);
    const rows=result.rows.map(row=>mapRow(row,data.UserID,mapAMC));
    for (const row of rows) row.Approvals=row.Approvals.map(({ApprovalType,Status,Remarks})=>({ApprovalType,Status,Remarks}));
    await attachDocuments(rows);
    for (const row of rows) for (const field of ['VendorName','VendorEmailAddress','VendorMobileNumber',
      'VendorSecondMobileNumber','VendorLandlineNumber','VendorAddress','VendorCity','VendorState',
      'VendorPincode','ScheduleOfServicing','ScheduleDay','ResponsiblePerson','FinalStatusDateTime']) delete row[field];
    const headerQuery=buildQuery({UserID:data.UserID,OrganizationID:data.OrganizationID},true);
    const columns=await pool.query(`${headerQuery.cte} SELECT columnkey,label,MIN(level) AS level FROM (
      SELECT 'stage:'||UPPER(s->>'approvaltype')||':'||ROW_NUMBER() OVER(
        PARTITION BY r.amcid,UPPER(s->>'approvaltype') ORDER BY (s->>'level')::int) AS columnkey,
        s->>'approvaltype' AS label,(s->>'level')::int AS level
      FROM records r CROSS JOIN LATERAL jsonb_array_elements(r.steps) s ${headerQuery.where}
    ) columns GROUP BY columnkey,label ORDER BY MIN(level),label,columnkey`,headerQuery.values);
    const TotalCount=Number(count.rows[0].count);
    return {TotalCount,PageCount:rows.length,CurrentPage:page,PageSize:size,TotalPages:Math.ceil(TotalCount/size),data:rows,
      ApprovalColumns:columns.rows.map(c=>({Key:c.columnkey,Label:c.label,Level:c.level}))};
};
const detail = async (data,mapAMC) => {
    if (!(Number(data.AMCID)>0)||!await hasSnapshots(data.AMCID)) return null;
    const q=buildQuery(data);
    const result=await pool.query(`${q.cte} SELECT r.* FROM records r ${q.where}`,q.values);
    if (!result.rows.length) throw new AppError('AMC record not found or not accessible',404);
    const row=mapRow(result.rows[0],data.UserID,mapAMC);
    await attachDocuments([row]);
    return row;
};
module.exports={buildQuery,mapRow,list,detail,hasSnapshots,assignmentSQL};
