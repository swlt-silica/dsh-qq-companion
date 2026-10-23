import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
const {renderReportImage} = await import('../../src/runtime/report-image.mjs').catch(()=>({}));
assert.equal(typeof renderReportImage,'function','independent image renderer must exist');
const folder=await mkdtemp(path.join(tmpdir(),'report-image-'));
try {
 const htmlPath=path.join(folder,'report.html');await writeFile(htmlPath,'<!doctype html><html><head></head><body>fixture</body></html>');
 let closedPage=0,closedBrowser=0,screenshot=0,blocked=0,allowed=0,handler;
 const page={setDefaultTimeout(){},setDefaultNavigationTimeout(){},async setViewport(v){assert.equal(v.width,1200);},async setJavaScriptEnabled(v){assert.equal(v,false);},async setRequestInterception(v){assert.equal(v,true);},on(event,fn){if(event==='request')handler=fn;},async setContent(content){assert.ok(content.includes("default-src 'none'"));assert.ok(!content.includes('file://'));for(const url of ['https://example.invalid','file:///secret','http://127.0.0.1','data:image/png;base64,AAAA'])await handler({url:()=>url,abort:async()=>{blocked++;},continue:async()=>{allowed++;}});},async evaluate(fn){return {width:1200,height:2000};},async screenshot(opts){assert.equal(opts.fullPage,true);screenshot++;await writeFile(opts.path,Buffer.from('89504e470d0a1a0a','hex'));},async close(){closedPage++;}};
 const browser={async newPage(){return page;},async close(){closedBrowser++;}};
 await renderReportImage(htmlPath,path.join(folder,'report.png'),{browserFactory:async()=>browser});
 assert.equal(blocked,3);assert.equal(allowed,1);assert.equal(closedPage,1);assert.equal(closedBrowser,1);assert.equal(screenshot,1);
 page.evaluate=async()=>({width:1200,height:999999});
 await assert.rejects(renderReportImage(htmlPath,path.join(folder,'large.png'),{browserFactory:async()=>browser}),/pixel|dimension/i);
 assert.equal(screenshot,1);assert.equal(closedPage,2);assert.equal(closedBrowser,2);
 page.evaluate=async()=>{throw new Error('renderer failed');};
 await assert.rejects(renderReportImage(htmlPath,path.join(folder,'failure.png'),{browserFactory:async()=>browser}),/renderer failed/);
 assert.equal(closedPage,3);assert.equal(closedBrowser,3);
 page.setContent=async()=>new Promise(resolve=>setTimeout(resolve,180));
 page.evaluate=async()=>({width:1200,height:100});
 await assert.rejects(renderReportImage(htmlPath,path.join(folder,'timeout.png'),{browserFactory:async()=>browser,timeoutMs:100}),/timeout/);
 await new Promise(resolve=>setTimeout(resolve,120));
 assert.equal(screenshot,1,'timed-out work must not continue to screenshot');
 assert.equal(closedPage,4);assert.equal(closedBrowser,4);
 console.log('report image: blocked network/file requests, data URI only, dimensions/pixel limit and cleanup PASS');
} finally {await rm(folder,{recursive:true,force:true});}
