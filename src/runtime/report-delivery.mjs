import {readFile,realpath,stat} from 'node:fs/promises';
import path from 'node:path';
import {reportWindow} from './report-worker.mjs';

/** Host-only image transport. It cannot choose targets or arbitrary files. */
export function createReportSender({runtime,outputDir,dispatch}) {
 if(!runtime||!outputDir||typeof dispatch!=='function')throw new Error('Report sender requires runtime, output directory and transport');
 return async function sendReport(report){
  const {groupId,date,artifact}=report;const assertPolicy=runtime.capturePolicyGuard?.()??(()=>{});
  if(typeof groupId!=='string'||!/^[A-Za-z0-9_-]{1,80}$/.test(groupId))throw new Error('Invalid report target');
  reportWindow(date);
  const expected=path.resolve(outputDir,groupId,date,'report.png');
  if(!artifact?.pngPath||path.resolve(artifact.pngPath)!==expected)throw new Error('Invalid report artifact path');
  const root=await realpath(outputDir),resolved=await realpath(expected),relative=path.relative(root,resolved);
  if(relative.startsWith('..')||path.isAbsolute(relative))throw new Error('Invalid report artifact path');
  const metadata=await stat(resolved);if(!metadata.isFile()||metadata.size>16000000)throw new Error('Invalid report PNG size');
  const png=await readFile(resolved);
  if(png.length<33||!png.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex'))||png.toString('ascii',12,16)!=='IHDR'||png.readUInt32BE(16)<1||png.readUInt32BE(20)<1)throw new Error('Invalid report PNG');
  const params={group_id:groupId,message:[{type:'image',data:{file:'base64://'+png.toString('base64')}}]};
  // This check happens after asynchronous file reads, immediately before the
  // actual OneBot HTTP transport; the transport must not queue/retry dispatch.
  assertPolicy();runtime.assertReportOutgoing(groupId);
  const response=await dispatch('send_group_msg',params);
  return response?.data;
 };
}
