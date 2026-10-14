const AppError = require('../../utils/AppError');
const { normalized, currentStep, canAct } = require('../CapexService/CapexWorkflow');
const { AMC_RD_ORGANIZATION_ID } = require('./EngineeringAMCApprovalNotificationService');
const validID = value => /^[1-9]\d*$/.test(String(value ?? ''));
const statuses = { APPROVE: 'Approved', REJECT: 'Rejected', RETURN: 'Returned' };

const regionalEligibilitySQL = (user='um', organization='om') => `EXISTS (
    SELECT 1 FROM user_primary_organization p JOIN organization_master company ON company.organizationid=p.organizationid
    WHERE p.userid=${user}.userid AND p.organizationid=COALESCE(${organization}.parentorganizationid,${organization}.organizationid)
      AND p.isactive AND NOT p.isdeleted AND company.isactive AND company.activationstatus AND NOT company.isdeleted)`;
const centralRDSQL = (user='um') => `(UPPER(TRIM(${user}.usertype))='HOD' AND EXISTS (
    SELECT 1 FROM department_master finance JOIN user_org_mapping authority ON authority.userid=${user}.userid
    JOIN organization_master central ON central.organizationid=authority.organizationid
    WHERE finance.departmentid=${user}.departmentid AND NOT finance.isdeleted
      AND UPPER(TRIM(finance.departmentname))='FINANCE' AND authority.organizationid=${AMC_RD_ORGANIZATION_ID}
      AND authority.isactive AND NOT authority.isdeleted AND central.isactive AND central.activationstatus AND NOT central.isdeleted))`;
const externalAccessSQL = (user='um', organization='om', amcID='$3') => `EXISTS (
    SELECT 1 FROM engineering_amc_workflow_step assigned
    WHERE assigned.amcid=${amcID} AND assigned.ismandatory AND (
      (assigned.approvertype='REGIONAL' AND assigned.assigneduserid=${user}.userid AND ${regionalEligibilitySQL(user,organization)})
      OR (assigned.approvertype='ROLE' AND assigned.role='RD' AND ${centralRDSQL(user)})))`;

const getActor = async (client, organizationID, userID, amcID=null) => {
    if (!validID(userID)) throw new AppError('Authenticated UserID is required',401);
    const result = await client.query(`SELECT um.userid,um.usertype,um.departmentid,dm.departmentname,
        dm.organizationid AS departmentorganizationid,
        ${regionalEligibilitySQL()} AS regionaleligible, ${centralRDSQL()} AS iscentralrd,
        (EXISTS(SELECT 1 FROM user_org_mapping membership WHERE membership.userid=um.userid
          AND membership.organizationid=om.organizationid AND membership.isactive AND NOT membership.isdeleted)
          OR COALESCE(um.logintype='SuperAdmin' AND um.allorganizationaccess,FALSE)) AS organizationaccess
        FROM user_master um JOIN organization_master om ON om.organizationid=$2
        LEFT JOIN department_master dm ON dm.departmentid=um.departmentid AND NOT dm.isdeleted
        WHERE um.userid=$1 AND um.isactive AND NOT um.isdeleted AND NOT um.islocked
          AND om.isactive AND om.activationstatus AND NOT om.isdeleted
          AND (EXISTS(SELECT 1 FROM user_org_mapping membership WHERE membership.userid=um.userid
            AND membership.organizationid=om.organizationid AND membership.isactive AND NOT membership.isdeleted)
            OR COALESCE(um.logintype='SuperAdmin' AND um.allorganizationaccess,FALSE) OR ${externalAccessSQL()})`,
    [userID,organizationID,amcID]);
    if (!result.rows.length) throw new AppError('You do not have access to this AMC organization',403);
    return result.rows[0];
};
const isAssigned = (step,actor,record) => {
    if (!validID(actor?.userid)) return false;
    const type=normalized(step.approvertype), role=normalized(step.role);
    if (type==='REGIONAL') return actor.regionaleligible===true && String(step.assigneduserid)===String(actor.userid);
    if (type==='ROLE' && role==='RD') return actor.iscentralrd===true;
    if (actor.organizationaccess!==true) return false;
    if (type==='USER') return String(step.assigneduserid)===String(actor.userid);
    if (type!=='ROLE') return false;
    if (role==='FC' || (role==='HOD' && normalized(step.approvaltype)==='FC')) return normalized(actor.usertype)==='HOD' && normalized(actor.departmentname)==='FINANCE'
        && String(actor.departmentorganizationid)===String(record.organizationid) && !actor.iscentralrd;
    if (role==='HOD') return normalized(actor.usertype)==='HOD' && String(actor.departmentorganizationid)===String(record.organizationid)
        && record.departmentid!=null && String(actor.departmentid)===String(record.departmentid);
    return !!role && role===normalized(actor.usertype);
};
const allowedActions = (record,steps,step,actor) => record.isdeleted || normalized(record.finalstatus)==='APPROVED'
    || !isAssigned(step,actor,record) ? [] : Object.keys(statuses).filter(action=>canAct(steps,step,action));
const loadSteps = async (client,amcID,lock=false) => (await client.query(`SELECT s.*,u.fullname AS actionbyname
    FROM engineering_amc_workflow_step s LEFT JOIN user_master u ON u.userid=s.actionby
    WHERE s.amcid=$1 ORDER BY s.level,s.stepid ${lock?'FOR UPDATE OF s':''}`,[amcID])).rows;

const recipientIds = async (client,record,step) => {
    if (!step) return [String(record.createdby)];
    const actors = await client.query(`SELECT um.userid,um.usertype,um.departmentid,dm.departmentname,
      dm.organizationid AS departmentorganizationid,${regionalEligibilitySQL()} AS regionaleligible,
      ${centralRDSQL()} AS iscentralrd,
      EXISTS(SELECT 1 FROM user_org_mapping membership WHERE membership.userid=um.userid
        AND membership.organizationid=$1 AND membership.isactive AND NOT membership.isdeleted) AS organizationaccess
      FROM user_master um JOIN organization_master om ON om.organizationid=$1
      LEFT JOIN department_master dm ON dm.departmentid=um.departmentid AND NOT dm.isdeleted
      WHERE um.isactive AND NOT um.isdeleted AND NOT um.islocked
        AND om.isactive AND om.activationstatus AND NOT om.isdeleted`,[record.organizationid]);
    return [...new Set(actors.rows.filter(actor=>isAssigned(step,actor,record)).map(actor=>String(actor.userid)))];
};
const syncEquipment = async (client,amcID,userID) => {
    const result = await client.query(`UPDATE Engineering_Equipment_Entry_Master e
        SET AMCType=am.AMCType, AMCStartDate=am.AMCStartDate, AMCEndDate=am.AMCEndDate,
            AMCYearlyExpense=am.AMCAmount,
            AMCStatus=CASE WHEN am.AMCEndDate < CURRENT_DATE THEN 'Expired AMC' ELSE 'Under AMC' END,
            ModifiedBy=$2,ModifiedDate=CURRENT_TIMESTAMP
        FROM Engineering_AMC_Master am WHERE am.AMCID=$1 AND NOT am.IsDeleted
            AND e.EquipmentID=am.EquipmentID AND e.OrganizationID=am.OrganizationID AND NOT e.IsDeleted`,[amcID,userID]);
    if (result.rowCount!==1) throw new AppError('Linked AMC equipment not found',404);
};
const snapshot = async (client,record) => {
    const masters = await client.query(`SELECT approvalmasterid,flowname FROM approval_master
      WHERE organizationid=$1 AND UPPER(TRIM(modulename)) IN ('AMC','AMC RENEWAL') AND isactive AND NOT isdelete FOR SHARE`,[record.organizationid]);
    if (masters.rows.length!==1) throw new AppError('Exactly one active AMC approval flow is required',400);
    const master=masters.rows[0];
    const details=(await client.query(`SELECT * FROM approval_master_details WHERE approvalmasterid=$1
      AND NOT isdelete ORDER BY level,approvalid`,[master.approvalmasterid])).rows;
    if (!details.length) throw new AppError('AMC approval flow has no steps',400);
    const levels=new Set();
    for (const detail of details) {
        if (!Number.isInteger(detail.level)||detail.level<=0||levels.has(detail.level)) throw new AppError('AMC approval levels must be unique positive integers',400);
        levels.add(detail.level);
        const type=normalized(detail.approvertype),assignment=String(detail.role??'').trim();
        if (!['ROLE','USER','REGIONAL'].includes(type)||!String(detail.approvaltype??'').trim()
            || typeof detail.ismandatory!=='boolean') throw new AppError('Invalid AMC approval assignment or business stage',400);
        detail.approvertype=type;
        detail.assigneduserid=type==='ROLE'?null:assignment;
        detail.role=type==='ROLE'?normalized(assignment):null;
        if ((type==='ROLE'&&!detail.role)||(type!=='ROLE'&&!validID(assignment))) throw new AppError('AMC approval requires a valid role or selected user ID',400);
        if (detail.ismandatory && !(await recipientIds(client,record,detail)).length) throw new AppError('No eligible approver for AMC step '+detail.level,400);
    }
    await client.query(`UPDATE engineering_amc_approval SET approvalmasterid=$2,flowname=$3 WHERE amcid=$1`,[record.amcid,master.approvalmasterid,master.flowname]);
    for (const detail of details) await client.query(`INSERT INTO engineering_amc_workflow_step
      (amcid,sourceapprovalid,level,approvertype,role,assigneduserid,approvaltype,ismandatory)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,[record.amcid,detail.approvalid,detail.level,detail.approvertype,
        detail.role,detail.assigneduserid,detail.approvaltype,detail.ismandatory]);
    const steps=await loadSteps(client,record.amcid);
    if (!currentStep(steps)) {
        await client.query(`UPDATE engineering_amc_approval SET finalstatus='Approved',finalstatusdatetime=CURRENT_TIMESTAMP WHERE amcid=$1`,[record.amcid]);
        await syncEquipment(client,record.amcid,record.createdby);
    }
    return steps;
};
const applyAction = async (client,record,data) => {
    const steps=await loadSteps(client,record.amcid,true);
    if (!steps.length) return null;
    const header=(await client.query(`SELECT * FROM engineering_amc_approval WHERE amcid=$1 AND NOT isdeleted FOR UPDATE`,[record.amcid])).rows[0];
    if (!header) throw new AppError('AMC approval record not found',404);
    record={...record,finalstatus:header.finalstatus};
    const action=normalized(data.Action),remarks=String(data.Remarks??'').trim();
    if (!statuses[action]) throw new AppError('Action must be APPROVE, REJECT, or RETURN',400);
    if (action!=='APPROVE'&&!remarks) throw new AppError('Remarks are required for '+action,400);
    const actor=await getActor(client,record.organizationid,data.UserID,record.amcid);
    if (data.ApprovalStepID==null && steps.filter(s=>isAssigned(s,actor,record)).length>1) {
        throw new AppError('ApprovalStepID is required for repeated AMC approver assignments',400);
    }
    const step=currentStep(steps);
    if (!step || (data.ApprovalStepID!=null&&String(data.ApprovalStepID)!==String(step.stepid))
        || !allowedActions(record,steps,step,actor).includes(action)) throw new AppError('You cannot perform this action at this AMC approval step',403);
    if (data.Revision!=null && Number(data.Revision)!==step.revision) throw new AppError('AMC approval step changed; refresh before submitting again',409);
    const previous=step.status,status=statuses[action];
    const updated=(await client.query(`UPDATE engineering_amc_workflow_step SET status=$2,remarks=$3,actionby=$4,
      actiondatetime=CURRENT_TIMESTAMP,revision=revision+1 WHERE stepid=$1 RETURNING revision,actiondatetime`,[step.stepid,status,remarks||null,actor.userid])).rows[0];
    await client.query(`INSERT INTO engineering_amc_workflow_action(stepid,revision,action,previousstatus,status,actionby,remarks,actiondatetime)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,[step.stepid,updated.revision,action,previous,status,actor.userid,remarks||null,updated.actiondatetime]);
    step.status=status;
    const next=currentStep(steps),final=action==='APPROVE'&&!next;
    const finalStatus=action==='APPROVE'?(final?'Approved':'Pending'):status;
    await client.query(`UPDATE engineering_amc_approval SET finalstatus=$2::text,
      finalstatusdatetime=CASE WHEN $2::text='Pending' THEN NULL ELSE CURRENT_TIMESTAMP END,
      modifiedby=$3,modifieddate=CURRENT_TIMESTAMP WHERE amcid=$1`,[record.amcid,finalStatus,actor.userid]);
    // Keep legacy columns coherent only for unambiguous, once-occurring legacy stage labels.
    const stage=normalized(step.approvaltype);
    if (['FC','GM','RD','CEO'].includes(stage) && steps.filter(s=>normalized(s.approvaltype)===stage).length===1) {
        const prefix=stage.toLowerCase();
        await client.query(`UPDATE engineering_amc_approval SET ${prefix}status=$2,${prefix}remarks=$3,
          ${prefix}statusapprovedby=$4,${prefix}statusdatetime=$5 WHERE amcid=$1`,[record.amcid,status,remarks||null,actor.userid,updated.actiondatetime]);
    }
    if (final) await syncEquipment(client,record.amcid,actor.userid);
    const target=action==='APPROVE'?next:null;
    const recipients=target?await recipientIds(client,record,target):[String(record.createdby)];
    return {step,next,action,status,finalStatus,recipients,kind:final?'FINAL_APPROVE':action};
};
module.exports={normalized,currentStep,canAct,statuses,isAssigned,allowedActions,loadSteps,getActor,
    regionalEligibilitySQL,centralRDSQL,externalAccessSQL,recipientIds,snapshot,applyAction,syncEquipment};
