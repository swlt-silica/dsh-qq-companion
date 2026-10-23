import fs from 'node:fs';import path from 'node:path';import {zstdDecompressSync} from 'node:zlib';import {createHash} from 'node:crypto';
const workflowTools={
 qq_social_state:{step:'先确认当前窗口的真实社交状态、暂停和发送限制',triggers:['接话','表情']},
 qq_get_unread_messages:{step:'补读当前窗口未读消息，保留真实消息ID与水位',triggers:['最近聊天','接话']},
 qq_get_recent_messages:{step:'按需读取当前窗口最近上下文',triggers:['最近聊天','接话']},
 qq_get_message_detail:{step:'只按本窗口真实消息ID核对消息详情',triggers:['引用','消息']},
 qq_get_message_images:{step:'按本窗口真实消息ID读取图片，读取失败如实说明',triggers:['图片','表情']},
 qq_get_forward_msg:{step:'只读取当前窗口确实收到的转发，遵守原来源和隐私边界',triggers:['转发']},
 qq_list_stickers:{step:'查找本地已收藏表情，不能猜测表情ID',triggers:['表情','斗图']},
 qq_get_sticker_image:{step:'先确认已收藏表情的实际内容',triggers:['表情','斗图']},
 qq_send_sticker:{step:'结合当前窗口语境发送已确认的表情，遵守频率和发送总闸',triggers:['表情','斗图']},
 qq_send_message:{step:'根据真实上下文自然回复当前窗口，发送成功才算完成',triggers:['接话']},
 qq_reply:{step:'引用本窗口实际可见的消息回复，禁止猜消息ID',triggers:['引用','接话']},
 qq_send_burst:{step:'仅在必要时分条回复当前窗口，遵守原频率限制',triggers:['接话']},
 qq_mark_read:{step:'只确认实际处理过的安全已读水位',triggers:['接话']},
 qq_shared_memory_query:{step:'按需查找当前窗口获准可见的人物事实，私聊信息不得跨窗',triggers:['记得','记忆']},
 qq_shared_memory_remember:{step:'仅记录当前说话人有真实消息依据的必要事实，保持来源和隐私范围',triggers:['记住','记忆']},
 qq_request_group_report:{step:'仅按主人本轮明确真实请求排队生成允许群的分析',triggers:['群分析','群报','日报']},
 qq_report_status:{step:'读取实际群报任务状态，排队或失败不得说成已发送',triggers:['群分析','群报','日报']},
};
const useful=name=>['qq_send_message','qq_reply','qq_send_burst','qq_send_sticker','qq_shared_memory_remember','qq_request_group_report'].includes(name);
const patterns=[
 {id:'qq-read-images',tools:['qq_get_message_images','qq_send_message'],triggers:['图片','表情'],steps:['先按本会话真实消息ID读取图片，不能猜内容','根据读取结果自然回复；失败如实说明']},
 {id:'qq-request-group-report',tools:['qq_request_group_report','qq_report_status'],triggers:['群分析','群报','日报'],steps:['用主人本轮真实请求的消息ID提交允许范围内的群报任务','查询实际任务状态，不把排队说成已经发送']},
 {id:'qq-reply-with-context',tools:['qq_get_unread_messages','qq_send_message','qq_mark_read'],triggers:['最近聊天','接话'],steps:['先补读当前窗口未读消息，保留真实消息ID和读到的水位','结合上下文选择接话，发送成功才算回复','只确认实际处理的已读水位']},
];
export function readSuccessfulPatterns({dshHome,sessionsPath,date}){
 const end=Date.parse(date+'T00:00:00+08:00')+86400000,counts=new Map(patterns.map(p=>[p.id,0])),workflows=new Map();
 let ids;try{ids=new Set(Object.values(JSON.parse(fs.readFileSync(sessionsPath,'utf8')).sessions??{}).map(id=>String(id).replace(/^session-/,'')));}catch{return [];}
 const root=path.join(dshHome,'sessions'),files=[];
 const walk=(dir,depth=0)=>{if(depth>3)return;for(const entry of fs.readdirSync(dir,{withFileTypes:true})){if(entry.isSymbolicLink())continue;const file=path.join(dir,entry.name);if(entry.isDirectory())walk(file,depth+1);else if(entry.name.endsWith('.jsonl.zstd')&&[...ids].some(id=>file.includes(id)))files.push(file);}};
 try{walk(root);}catch{return [];}
 for(const file of files){try{
  const stat=fs.statSync(file);if(stat.size>20*1024*1024)continue;const raw=fs.readFileSync(file),parts=[];let offset=0,decoded=0;
  while(offset<raw.length){const part=zstdDecompressSync(raw.subarray(offset),{info:true,maxOutputLength:16*1024*1024});if(!part.engine.bytesWritten)throw Error('Invalid compressed frame');offset+=part.engine.bytesWritten;decoded+=part.buffer.length;if(decoded>100*1024*1024)throw Error('Log too large');parts.push(part.buffer);}
  const calls=new Map(),turns=new Map();
  for(const line of Buffer.concat(parts).toString('utf8').split('\n')){
   if(!line.trim())continue;const event=JSON.parse(line),data=event.data??{};if(!Number.isFinite(event.time)||event.time>=end)continue;
   if(event.type==='tool/call')calls.set(data.callId,{turn:data.turn,name:String(data.name).replace(/^mcp__snowluma__/,''),seq:event.seq});
   if(event.type==='tool/result'){
    const result=data.message??{},id=result.callId??result.toolCallId??data.callId,call=calls.get(id);if(!call||result.isError!==false||result.error||!Array.isArray(result.content))continue;
    // MCP transport success alone is not business success. All these controlled
    // tools return a JSON object with ok=true; refusals must never train skills.
    const payloads=result.content.filter(p=>p.type==='text').map(p=>{try{return JSON.parse(p.text);}catch{return null;}});
    if(!payloads.some(p=>p?.ok===true)||payloads.some(p=>p?.ok===false))continue;
    const payload=payloads.find(p=>p?.ok===true);
    if(['qq_send_message','qq_reply','qq_send_burst','qq_send_sticker'].includes(call.name)&&(!(payload.sent>0)||payload.failed>0))continue;
    if(call.name==='qq_get_message_images'&&(!Array.isArray(payload.images)||!payload.images.some(image=>!image.error)))continue;
    if(['failed','send-uncertain'].includes(payload.status))continue;
    calls.delete(id); // A duplicated result event is not another successful run.
    let items=turns.get(call.turn);if(!items){items=[];turns.set(call.turn,items);}items.push(call);
   }
  }
  for(const items of turns.values()){
   const names=items.sort((a,b)=>a.seq-b.seq).map(i=>i.name);
   for(const pattern of patterns){let cursor=0;for(const name of names)if(name===pattern.tools[cursor])cursor++;if(cursor===pattern.tools.length)counts.set(pattern.id,counts.get(pattern.id)+1);}
   // General reusable QQ workflows contain no message arguments or private text.
   // Extract bounded contiguous sequences; each counts at most once per turn.
   const seen=new Set();
   for(let start=0;start<names.length;start++)for(let size=2;size<=Math.min(5,names.length-start);size++){
    const tools=names.slice(start,start+size);
    if(!tools.every(n=>workflowTools[n])||!tools.some(useful)||new Set(tools).size<2)continue;
    if(patterns.some(p=>JSON.stringify(p.tools)===JSON.stringify(tools)))continue;
    const signature=tools.join('|');if(seen.has(signature))continue;seen.add(signature);
    let entry=workflows.get(signature);
    if(!entry){entry={id:'qq-workflow-'+createHash('sha256').update(signature).digest('hex').slice(0,16),tools,steps:tools.map(n=>workflowTools[n].step),triggers:[...new Set(tools.flatMap(n=>workflowTools[n].triggers))].slice(0,6),count:0};workflows.set(signature,entry);}
    entry.count++;
   }
  }
 }catch{/* Unknown or partial logs never invent successful repetitions. */}}
 return [...patterns.map(pattern=>({...pattern,count:counts.get(pattern.id)})),...[...workflows.values()].filter(p=>p.count>=3).sort((a,b)=>b.tools.length-a.tools.length||b.count-a.count).slice(0,12)].filter(p=>p.count>=3);
}
