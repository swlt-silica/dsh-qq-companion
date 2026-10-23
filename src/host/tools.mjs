import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {CHAT_TOOLS} from '../../presets/tools.mjs';
const allowed=new Set([...CHAT_TOOLS,'mcp__snowluma__qq_member_boundary','mcp__snowluma__qq_diary','mcp__snowluma__qq_learned_skill']);
export async function installToolBridge(ctx,{entry,env,client:injected}={}){
 const client=injected??new Client({name:'dsh-qq-companion',version:'0.1.0'});let transport;const disposers=[];
 try{
  if(!injected){transport=new StdioClientTransport({command:process.execPath,args:[entry],env,stderr:'pipe'});transport.stderr?.on('data',()=>{});await client.connect(transport);}
  const {tools}=await client.listTools();
  for(const tool of [...tools].sort((a,b)=>a.name.localeCompare(b.name))){
   const name='mcp__snowluma__'+tool.name;if(!allowed.has(name))continue;
   disposers.push(ctx.tools.register({name,description:tool.description??'',parameters:tool.inputSchema,output:{schema:{type:'object',additionalProperties:true},render:(_args,result)=>result.content??[]},
    async execute(args,exec){
     if(exec?.agent?.session?.header?.agentPreset!=='qq-yuzu')throw Error('QQ companion tool is restricted to its QQ preset');
     const result=await client.callTool({name:tool.name,arguments:args},undefined,{signal:exec.signal,timeout:360000});
     if(result.isError)throw Error((result.content??[]).filter(c=>c.type==='text').map(c=>c.text).join('\n').slice(0,2000)||'QQ operation failed');return result;
    }}));
  }
 }catch(error){for(const dispose of disposers.reverse())dispose();await client.close().catch(()=>{});throw error;}
 return async()=>{for(const dispose of disposers.reverse())dispose();if(!injected)await client.close();};
}
