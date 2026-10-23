import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import{readReportArtifact}from'../src/host/report-reader.mjs';
test('management report download is fixed to currently allowed group and dated artifact',async t=>{const stateDir=fs.mkdtempSync(path.join(os.tmpdir(),'companion-report-reader-'));t.after(()=>fs.rmSync(stateDir,{recursive:true,force:true}));const folder=path.join(stateDir,'reports','22','2026-10-22');fs.mkdirSync(folder,{recursive:true});fs.writeFileSync(path.join(folder,'report.html'),'<h1>fixture</h1>');const config={paths:{stateDir},access:{groups:['22']},reports:{groups:['22']}};
 const r=readReportArtifact(config,{groupId:'22',date:'2026-10-22',format:'html'});assert.equal(r.data.toString(),'<h1>fixture</h1>');assert.equal(r.name,'22-2026-10-22.html');
 for(const request of [{groupId:'33',date:'2026-10-22',format:'html'},{groupId:'22',date:'../../secret',format:'html'},{groupId:'22',date:'2026-10-22',format:'../../secret'}])assert.throws(()=>readReportArtifact(config,request));
 config.access.groups=[];assert.throws(()=>readReportArtifact(config,{groupId:'22',date:'2026-10-22',format:'html'}));
});
