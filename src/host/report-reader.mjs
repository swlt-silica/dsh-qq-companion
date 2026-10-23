import fs from 'node:fs';import path from 'node:path';
import{ControlError}from'../control/config.mjs';
export function readReportArtifact(config,{groupId,date,format='html'}){
 if(typeof groupId!=='string'||!/^[1-9]\d{0,19}$/.test(groupId)||!config.access.groups.includes(groupId)||!config.reports.groups.includes(groupId))throw new ControlError('FORBIDDEN','报告群未获准',403);
 if(typeof date!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(date)||new Date(date+'T00:00:00Z').toISOString().slice(0,10)!==date||!['html','json','png'].includes(format))throw new ControlError('VALIDATION','报告日期或格式无效');
 const root=path.join(config.paths.stateDir,'reports'),folder=path.join(root,groupId,date),file=path.join(folder,'report.'+format);
 for(const dir of [root,path.join(root,groupId),folder]){const s=fs.lstatSync(dir);if(s.isSymbolicLink()||!s.isDirectory())throw new ControlError('FORBIDDEN','报告路径无效',403);}
 const fd=fs.openSync(file,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW??0));try{const s=fs.fstatSync(fd);if(!s.isFile()||s.size>16000000||fs.lstatSync(file).isSymbolicLink())throw new ControlError('FORBIDDEN','报告文件无效',403);return {data:fs.readFileSync(fd),name:groupId+'-'+date+'.'+format,type:format==='png'?'image/png':format==='json'?'application/json; charset=utf-8':'text/html; charset=utf-8'};}finally{fs.closeSync(fd);}
}
