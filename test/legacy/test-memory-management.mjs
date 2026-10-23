import test from 'node:test';import assert from 'node:assert/strict';
import fs from 'node:fs';import path from 'node:path';import os from 'node:os';
import {createDeploymentRuntime} from '../../src/runtime/deployment-runtime.mjs';
import {forgetManagedMemory} from '../../src/runtime/memory-management.mjs';
test('management can forget one exact source fact and cannot remove other-source or batch facts',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'memory-management-')),config={allow:{private:['123'],groups:['456']}};
 const runtime=createDeploymentRuntime({stateDir:dir,config});t.after(()=>{runtime.close();fs.rmSync(dir,{recursive:true,force:true});});
 runtime.ingest('private:123',{message_id:1,user_id:'123',self_id:'999',message:[{type:'text',data:{text:'我喜欢薄荷茶'}}]});
 const fact=runtime.remember({key:'private:123',messageId:'1',subjectId:'123',category:'preference',text:'我喜欢薄荷茶'});
 assert.throws(()=>forgetManagedMemory({runtime,body:{key:'private:123',id:fact.id},isAgent:true}),/admin/);
 assert.throws(()=>forgetManagedMemory({runtime,body:{key:'private:123',ids:[fact.id]},isAgent:false}),/single/);
 assert.throws(()=>forgetManagedMemory({runtime,body:{key:'private:123',id:[fact.id]},isAgent:false}),/single/);
 assert.equal(forgetManagedMemory({runtime,body:{key:'group:456',id:fact.id},isAgent:false}).removed,false);
 assert.equal(runtime.query('private:123').length,1);
 assert.equal(forgetManagedMemory({runtime,body:{key:'private:123',id:fact.id},isAgent:false}).removed,true);
 assert.equal(runtime.query('private:123').length,0);
});
test('space switches govern automatic recall and capture without deleting facts',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'memory-space-switch-')),registry=path.join(dir,'memory-providers.json');
 const config={allow:{private:['123'],groups:['456']},deployment:{memory:{managementRegistryPath:registry}}};
 const save=active=>fs.writeFileSync(registry,JSON.stringify({version:4,enabled:{'qq-evidence':true},bodies:[{providerId:'qq-evidence',active,connection:{sourceKey:'private:123'}}]}));save(true);
 const runtime=createDeploymentRuntime({stateDir:dir,config});t.after(()=>{runtime.close();fs.rmSync(dir,{recursive:true,force:true});});
 runtime.ingest('private:123',{message_id:1,user_id:'123',self_id:'999',message:[{type:'text',data:{text:'我喜欢薄荷茶'}}]});
 runtime.remember({key:'private:123',messageId:'1',subjectId:'123',category:'preference',text:'我喜欢薄荷茶'});assert.equal(runtime.query('private:123').length,1);
 save(false);assert.equal(runtime.query('private:123').length,0);assert(!runtime.context('private:123').includes('薄荷茶'));assert.throws(()=>runtime.remember({key:'private:123',messageId:'1',subjectId:'123',category:'preference',text:'我喜欢薄荷茶'}),/记忆空间/);
 save(true);assert.equal(runtime.query('private:123').length,1);fs.writeFileSync(registry,'broken');assert.equal(runtime.query('private:123').length,0);
});
