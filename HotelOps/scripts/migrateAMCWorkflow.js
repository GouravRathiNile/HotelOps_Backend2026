// Explicitly invoked deployment tool: backs up, verifies and commits the additive AMC migration.
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const assert=require('node:assert/strict');
const {pool}=require('../db');
const tables=['engineering_amc_master','engineering_amc_approval','engineering_amc_approval_config','engineering_amc_documents'];
const order={engineering_amc_master:'amcid',engineering_amc_approval:'amcapprovalid',
    engineering_amc_approval_config:'amcapprovalconfigid',engineering_amc_documents:'amcdocumentid'};
const readTables=async(client)=>{
    const result={};
    for(const table of tables) result[table]=(await client.query(`SELECT to_jsonb(t) AS row FROM ${table} t ORDER BY ${order[table]}`)).rows.map(r=>r.row);
    result.equipment=(await client.query(`SELECT to_jsonb(e) AS row FROM engineering_equipment_entry_master e
      WHERE equipmentid IN(SELECT equipmentid FROM engineering_amc_master) ORDER BY equipmentid`)).rows.map(r=>r.row);
    result.builderMasters=(await client.query(`SELECT to_jsonb(am) AS row FROM approval_master am
      WHERE UPPER(TRIM(modulename)) IN ('AMC','AMC RENEWAL') ORDER BY approvalmasterid`)).rows.map(r=>r.row);
    result.builderDetails=(await client.query(`SELECT to_jsonb(d) AS row FROM approval_master_details d JOIN approval_master am USING(approvalmasterid)
      WHERE UPPER(TRIM(am.modulename)) IN ('AMC','AMC RENEWAL') ORDER BY approvalid`)).rows.map(r=>r.row);
    return result;
};
const currentState=(header,steps)=>{
    if(String(header.finalstatus??'').trim().toUpperCase()==='APPROVED') return {stage:null,status:'Approved'};
    const current=steps.find(s=>s.ismandatory!==false&&String(s.status??'Pending').trim().toUpperCase()!=='APPROVED');
    return {stage:current?.approvaltype??null,status:current?.status??header.finalstatus??'Pending'};
};
const expectedStates=(source,snapshots)=>{
    const master=new Map(source.engineering_amc_master.map(m=>[String(m.amcid),m]));
    const states=new Map();
    for(const header of source.engineering_amc_approval) {
        let steps=snapshots.filter(s=>String(s.amcid)===String(header.amcid)).sort((a,b)=>a.level-b.level);
        if(!steps.length) {
            const config=source.engineering_amc_approval_config.filter(c=>!c.isdeleted&&String(c.organizationid)===String(master.get(String(header.amcid)).organizationid))
                .sort((a,b)=>a.approvalorder-b.approvalorder||a.approvallevel-b.approvallevel||a.amcapprovalconfigid-b.amcapprovalconfigid);
            const roles=config.length?config.map(c=>String(c.approvalrole).trim().toUpperCase()):['FC','GM','RD','CEO'];
            steps=roles.map(role=>({approvaltype:role,ismandatory:true,status:header[role.toLowerCase()+'status']??'Pending'}));
        }
        states.set(String(header.amcid),currentState(header,steps));
    }
    return states;
};
const main=async()=>{
    if(!process.argv.includes('--apply')) throw new Error('Use node scripts/migrateAMCWorkflow.js --apply to back up, verify and apply the migration');
    const client=await pool.connect();let folder;
    try {
        await client.query('BEGIN');
        await client.query("SET LOCAL lock_timeout='5s'");
        await client.query("SET LOCAL statement_timeout='60s'");
        await client.query(`LOCK TABLE engineering_amc_master,engineering_amc_approval,engineering_amc_approval_config,
          engineering_amc_documents,engineering_equipment_entry_master,approval_master,approval_master_details IN SHARE ROW EXCLUSIVE MODE`);
        const before=await readTables(client);
        const exists=(await client.query("SELECT to_regclass('public.engineering_amc_workflow_step') IS NOT NULL AS present")).rows[0].present;
        const previousSteps=exists?(await client.query('SELECT * FROM engineering_amc_workflow_step ORDER BY amcid,level')).rows:[];
        const states=expectedStates(before,previousSteps);
        folder=path.resolve(__dirname,'../../.local-backups','amc-'+new Date().toISOString().replace(/[:.]/g,'-'));
        fs.mkdirSync(folder,{recursive:true});
        fs.writeFileSync(path.resolve(folder,'../.gitignore'),'*\n');
        const data=JSON.stringify({createdAt:new Date().toISOString(),tables:before,previousSteps},null,2);
        const digest=crypto.createHash('sha256').update(data).digest('hex');
        const backup=path.join(folder,'legacy-backup.json');fs.writeFileSync(backup,data);
        fs.writeFileSync(path.join(folder,'manifest.json'),JSON.stringify({sha256:digest,counts:Object.fromEntries(Object.entries(before).map(([k,v])=>[k,v.length]))},null,2));
        assert.equal(crypto.createHash('sha256').update(fs.readFileSync(backup)).digest('hex'),digest,'Backup checksum mismatch');
        assert.deepEqual(JSON.parse(fs.readFileSync(backup,'utf8')).tables,before,'Backup round trip mismatch');
        await client.query(fs.readFileSync(path.resolve(__dirname,'../docs/migrations/amc-dynamic-workflow.sql'),'utf8').replace(/^BEGIN;|^COMMIT;/gm,''));
        const after=await readTables(client);
        for(const table of [...tables,'equipment']) {
            const projected=after[table].map((row,index)=>Object.fromEntries(Object.keys(before[table][index]??{}).map(key=>[key,row[key]])));
            assert.deepEqual(projected,before[table],table+' changed unexpectedly');
        }
        for(const table of ['builderMasters','builderDetails']) for(const old of before[table]) {
            const key=table==='builderMasters'?'approvalmasterid':'approvalid';
            assert.deepEqual(after[table].find(row=>row[key]===old[key]),old,'Existing AMC Builder configuration changed');
        }
        const steps=(await client.query('SELECT * FROM engineering_amc_workflow_step ORDER BY amcid,level')).rows;
        const actual=expectedStates(after,steps);
        assert.deepEqual(actual,states,'AMC pending stages/statuses changed');
        for(const header of after.engineering_amc_approval) assert.ok(steps.some(s=>String(s.amcid)===String(header.amcid)),'AMC approval missing migrated steps');
        const copied=await client.query(`SELECT COUNT(*)::int AS invalid FROM engineering_amc_workflow_step s
          JOIN engineering_amc_approval a USING(amcid) WHERE a.approvalmasterid IS NULL AND (
            s.status IS DISTINCT FROM COALESCE(to_jsonb(a)->>(lower(s.role)||'status'),'Pending')
            OR s.remarks IS DISTINCT FROM to_jsonb(a)->>(lower(s.role)||'remarks')
            OR s.actionby IS DISTINCT FROM (to_jsonb(a)->>(lower(s.role)||'statusapprovedby'))::bigint
            OR s.actiondatetime IS DISTINCT FROM (to_jsonb(a)->>(lower(s.role)||'statusdatetime'))::timestamp)`);
        assert.equal(copied.rows[0].invalid,0,'Legacy action fields were not copied exactly');
        const verification={backup:folder,sha256:digest,approvals:after.engineering_amc_approval.length,
          steps:steps.length,preservedCurrentStages:true,preservedLegacyFields:true,preservedEquipment:true};
        await client.query('COMMIT');
        fs.writeFileSync(path.join(folder,'verification.json'),JSON.stringify(verification,null,2));
        console.log(JSON.stringify(verification));
    } catch(error) {
        await client.query('ROLLBACK');
        if(folder) console.error('Backup retained at '+folder);
        throw error;
    } finally {client.release();}
};
if(require.main===module) main().catch(error=>{console.error(error.message);process.exitCode=1;}).finally(()=>pool.end());
module.exports={currentState,expectedStates};
