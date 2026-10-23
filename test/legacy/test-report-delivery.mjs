import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';import {tmpdir} from 'node:os';
const {createReportSender}=await import('../../src/runtime/report-delivery.mjs').catch(()=>({}));
assert.equal(typeof createReportSender,'function','safe report sender must exist');
const dir=await mkdtemp(path.join(tmpdir(),'report-delivery-'));
try {
 const png=Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010804000000b51c0c020000000b4944415478da6364f80f00010501012718e3660000000049454e44ae426082','hex');
 const folder=path.join(dir,'fixture','2026-10-23');await mkdir(folder,{recursive:true});const pngPath=path.join(folder,'report.png');await writeFile(pngPath,png);
 let allowed=false,checks=0,sends=0;
 const runtime={assertReportOutgoing:group=>{assert.equal(group,'fixture');checks++;if(!allowed)throw new Error('disabled');}};
 const send=createReportSender({runtime,outputDir:dir,dispatch:async(action,params)=>{assert.equal(checks,2);assert.equal(action,'send_group_msg');assert.equal(params.group_id,'fixture');assert.deepEqual(params.message,[{type:'image',data:{file:'base64://'+png.toString('base64')}}]);sends++;return {data:{message_id:'fixture'}};}});
 const report={groupId:'fixture',date:'2026-10-23',artifact:{pngPath}};
 await assert.rejects(send(report),/disabled/);assert.equal(sends,0);
 allowed=true;assert.deepEqual(await send(report),{message_id:'fixture'});assert.equal(sends,1);
 await assert.rejects(send({...report,artifact:{pngPath:path.join(dir,'outside.png')}}),/artifact path/);
 await writeFile(pngPath,'not png');await assert.rejects(send(report),/PNG/);assert.equal(sends,1);
 console.log('report delivery: default deny, group gate immediately before dispatch, dedicated artifact path, PNG validation and one image/no retry PASS');
}finally{await rm(dir,{recursive:true,force:true});}
