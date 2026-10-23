import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import z from '@deepseek-ai/schemastery';
import {createSupervisor} from './host/supervisor.mjs';
import {createController} from './host/controller.mjs';
import {initialFromLegacy} from './host/config-mapper.mjs';
import {createManagementHandler} from './host/management.mjs';
import {installToolBridge} from './host/tools.mjs';
import {verifyMemoryIsolation} from './host/isolation.mjs';
import {runtimeEnvironment} from './host/environment.mjs';

export const name='dsh-qq-companion';
export const inject=['webServer','connection','tools'];
export const Config=z.object({
 dataDir:z.string().default('').description('Private companion management data directory'),
 legacyConfigFile:z.string().default('').description('Optional existing QQ bridge configuration to import once'),
 stateDir:z.string().default('').description('QQ business state directory'),
 workspace:z.string().default('').description('Persona workspace and diary directory'),
 selfQQ:z.string().default('').description('Bot QQ identity for protected account checks'),
 startEnabled:z.boolean().default(false).description('Enable runtime on first initialization only'),
});

export async function apply(ctx,options={}){
 const dshHome=process.env.DSH_HOME||path.join(os.homedir(),'.dsh');
 const controlDir=path.resolve(options.dataDir||path.join(dshHome,'qq-companion'));
 let legacy={};if(options.legacyConfigFile){const file=path.resolve(options.legacyConfigFile),s=fs.statSync(file);if(!s.isFile()||s.size>2097152)throw Error('Invalid legacy configuration');legacy=JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,''));}
 const stateDir=path.resolve(options.stateDir||path.join(controlDir,'runtime'));
 const workspace=path.resolve(options.workspace||legacy.deployment?.dailyLearning?.workspaceDir||path.join(dshHome,'workspace'));
 fs.mkdirSync(controlDir,{recursive:true,mode:0o700});
 const configFile=path.join(controlDir,'worker-config.json');
 const supervisor=createSupervisor({worker:fileURLToPath(new URL('./runtime/worker.mjs',import.meta.url)),stateDir,configFile,root:controlDir,env:runtimeEnvironment({legacy,dshHome})});
 const initialConfig=initialFromLegacy(legacy,{stateDir,workspace,dshHome,selfQQ:options.selfQQ,enabled:options.startEnabled});
 const controller=await createController({controlDir,configFile,initialConfig,legacy,supervisor,validateRuntime:verifyMemoryIsolation});
 let disposeTools=async()=>{};
 ctx.effect(()=>async()=>{await controller.close();await disposeTools();});
 const connection=ctx.get('connection');
 const handler=createManagementHandler({
  authenticate:req=>connection.requestRejection(req)===undefined&&connection.browserAuth?.isAuthenticated(req,ctx.webServer.protocol==='https:')===true,
  snapshot:controller.snapshot,dispatch:controller.dispatch,diary:controller.diary,report:controller.report,
 });
 ctx.effect(()=>ctx.webServer.register({kind:'exact',path:'/api/qq-companion',handler}));
 // A disabled initial runtime still prepares a deployment-mode MCP schema.
 controller.prepare();
 const env={PATH:process.env.PATH??process.env.Path??'',SystemRoot:process.env.SystemRoot??'',DSH_HOME:dshHome,QQ_COMPANION_ROOT:controlDir,QQ_COMPANION_STATE_DIR:stateDir,QQ_COMPANION_CONFIG_FILE:configFile,QQ_DEPLOYMENT:'1'};
 disposeTools=await installToolBridge(ctx,{entry:fileURLToPath(new URL('./runtime/mcp-snowluma-safe.js',import.meta.url)),env});
 await controller.start();
 ctx.logger?.info('QQ companion management and controlled tools activated');
}
