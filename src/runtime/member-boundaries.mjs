import {randomUUID} from 'node:crypto';
const qq=value=>{if(!/^[1-9]\d{0,19}$/.test(String(value)))throw Error('Invalid QQ identity');return String(value);};
export function createMemberBoundaries({db,config,now,isAllowed}){
 db.exec(`CREATE TABLE IF NOT EXISTS qq_member_boundaries(subject_id TEXT PRIMARY KEY,state TEXT NOT NULL,generation INTEGER NOT NULL DEFAULT 0,warned_at INTEGER,warning_watermark INTEGER,blocked_at INTEGER);
 CREATE TABLE IF NOT EXISTS qq_boundary_actions(id TEXT PRIMARY KEY,subject_id TEXT NOT NULL,source_key TEXT NOT NULL,message_id TEXT NOT NULL,action TEXT NOT NULL,reason TEXT NOT NULL,generation INTEGER NOT NULL,status TEXT NOT NULL,notice_id TEXT,created_at INTEGER NOT NULL,UNIQUE(source_key,message_id,action,generation));
 CREATE TABLE IF NOT EXISTS qq_member_notes(subject_id TEXT PRIMARY KEY,reason TEXT NOT NULL,source TEXT NOT NULL,updated_at INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS qq_boundary_releases(source_key TEXT NOT NULL,message_id TEXT NOT NULL,subject_id TEXT NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(source_key,message_id));`);
 const note=(id,reason,source)=>db.prepare('INSERT INTO qq_member_notes VALUES(?,?,?,?) ON CONFLICT(subject_id) DO UPDATE SET reason=excluded.reason,source=excluded.source,updated_at=excluded.updated_at').run(id,String(reason??'').slice(0,300),source,now());
 const enabled=()=>config.deployment?.memberBoundaries?.enabled===true;
 const memberState=id=>{id=qq(id);return db.prepare('SELECT subject_id AS subjectId,state,generation FROM qq_member_boundaries WHERE subject_id=?').get(id)??{subjectId:id,state:'none',generation:0};};
 const isIgnored=id=>/^[1-9]\d{0,19}$/.test(String(id))&&memberState(id).state==='ignored';
 function prepareMemberBoundary({key,messageId,action,reason}){
  if(!enabled()||!isAllowed(key))throw Error('Member boundary scope is disabled');
  if(!['warn','block'].includes(action)||!['unwanted_teasing','sexual_harassment','insult'].includes(reason))throw Error('Unsupported personal boundary action');
  const e=db.prepare('SELECT rowid AS evidenceOrder,* FROM qq_messages WHERE key=? AND id=?').get(key,String(messageId));
  if(!e||e.is_bot||e.user_id===String(config.ownerQQ)||now()-e.ts>86400000)throw Error('需要当前会话本人真实新消息，不能屏蔽主人/机器人或用转述代替');
  const state=memberState(e.user_id),prior=db.prepare('SELECT * FROM qq_boundary_actions WHERE source_key=? AND message_id=? AND action=? AND generation=?').get(key,String(messageId),action,state.generation);
  if(prior){if(prior.status==='notified')return {done:true,subjectId:e.user_id,state:state.state};throw Error('此通知结果未确认，不自动重发');}
  if(state.state==='ignored')return {done:true,subjectId:e.user_id,state:'ignored'};
  if(action==='block'){
   const warned=db.prepare('SELECT * FROM qq_member_boundaries WHERE subject_id=?').get(e.user_id);
   if(warned?.state!=='warned'||e.evidenceOrder<=warned.warning_watermark)throw Error('必须先成功提醒，之后新发生的一次越界才可拉黑');
  }else if(state.state==='warned')return {done:true,subjectId:e.user_id,state:'warned'};
  if(db.prepare("SELECT 1 FROM qq_boundary_actions WHERE subject_id=? AND generation=? AND status='sending'").get(e.user_id,state.generation))throw Error('已有该账号的通知在发送');
  const id=randomUUID();db.prepare('INSERT INTO qq_boundary_actions VALUES(?,?,?,?,?,?,?,?,?,?)').run(id,e.user_id,key,String(messageId),action,reason,state.generation,'sending',null,now());
  return {id,subjectId:e.user_id,action,key,messageId:String(messageId),generation:state.generation,notice:action==='warn'?'这样的调戏让我不舒服，请停下。再越界一次，我就不回应你了。':'我会把你加入不回应名单，以后忽略你的消息，只有哥哥能解除。'};
 }
 function completeMemberBoundary(action,noticeId){
  if(!/^-?[1-9]\d*$/.test(String(noticeId)))throw Error('通知没有已确认的QQ消息ID');
  const row=db.prepare("SELECT * FROM qq_boundary_actions WHERE id=? AND status='sending'").get(action.id);if(!row||memberState(row.subject_id).generation!==row.generation)throw Error('Boundary action was superseded');
  const watermark=Number(db.prepare('SELECT coalesce(max(rowid),0) AS n FROM qq_messages').get().n);
  db.exec('BEGIN IMMEDIATE');try{
   db.prepare('INSERT INTO qq_member_boundaries VALUES(?,?,?,?,?,?) ON CONFLICT(subject_id) DO UPDATE SET state=excluded.state,warned_at=coalesce(excluded.warned_at,qq_member_boundaries.warned_at),warning_watermark=coalesce(excluded.warning_watermark,qq_member_boundaries.warning_watermark),blocked_at=excluded.blocked_at').run(row.subject_id,row.action==='warn'?'warned':'ignored',row.generation,row.action==='warn'?now():null,row.action==='warn'?watermark:null,row.action==='block'?now():null);
   db.prepare("UPDATE qq_boundary_actions SET status='notified',notice_id=? WHERE id=?").run(String(noticeId),row.id);note(row.subject_id,row.reason,'automatic');db.exec('COMMIT');
  }catch(e){db.exec('ROLLBACK');throw e;}
  return {subjectId:row.subject_id,state:row.action==='warn'?'warned':'ignored',noticeMessageId:String(noticeId)};
 }
 function failMemberBoundary(id){db.prepare("UPDATE qq_boundary_actions SET status='uncertain' WHERE id=? AND status='sending'").run(id);}
 function releaseMember({key,messageId,subjectId}){
  subjectId=qq(subjectId);const e=db.prepare('SELECT * FROM qq_messages WHERE key=? AND id=?').get(key,String(messageId));
  if(key!=='private:'+String(config.ownerQQ)||!e||e.is_bot||e.user_id!==String(config.ownerQQ)||now()-e.ts>600000||e.text.trim()!=='/解除黑名单 '+subjectId)throw Error('解除仅接受主人本人私聊的明确新指令');
  if(db.prepare('SELECT 1 FROM qq_boundary_releases WHERE source_key=? AND message_id=?').get(key,String(messageId)))throw Error('旧解除指令不能重复使用');
  const prior=memberState(subjectId);db.exec('BEGIN IMMEDIATE');try{
   db.prepare('INSERT INTO qq_boundary_releases VALUES(?,?,?,?)').run(key,String(messageId),subjectId,now());
   db.prepare("INSERT INTO qq_member_boundaries VALUES(?,'none',?,NULL,NULL,NULL) ON CONFLICT(subject_id) DO UPDATE SET state='none',generation=excluded.generation,warned_at=NULL,warning_watermark=NULL,blocked_at=NULL").run(subjectId,prior.generation+1);note(subjectId,'owner private release','owner_private');db.exec('COMMIT');
  }catch(error){db.exec('ROLLBACK');throw error;}return {released:prior.state!=='none',subjectId};
 }
 function redactIgnored(value){
  if(Array.isArray(value))return value.map(redactIgnored);
  if(!value||typeof value!=='object')return value;
  const who=value.userId??value.user_id??value.sender?.user_id??value.data?.uin??value.data?.user_id??value.uin;
  if(isIgnored(who))return {seq:value.seq,messageId:value.messageId??value.message_id,userId:String(who),isSelf:false,ignored:true,text:'[此账号的消息已忽略]',plain:'[此账号的消息已忽略]',media:[],forwardIds:[],hasMedia:false,hasForward:false,time:value.time};
  return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,redactIgnored(v)]));
 }
 function memberBoundaryContext(ids=[]){
  if(!enabled())return '';
  const visible=[...new Set(ids.map(String))].filter(id=>/^[1-9]\d{0,19}$/.test(id)).slice(-30).map(memberState).filter(row=>row.state!=='none').map(({subjectId,state})=>({subjectId,state}));
  return '\n【本地人际边界状态】'+JSON.stringify(visible)+'。warned表示已明确提醒，再发生一次本人新越界可调用qq_member_boundary(action=block)。ignored账号一律不回应、不引用、不@，即使旧上下文里仍有其内容。';
 }
 function messageIsIgnored(key,messageId){const e=db.prepare('SELECT user_id FROM qq_messages WHERE key=? AND id=?').get(key,String(messageId));return e?isIgnored(e.user_id):false;}
 function protectedId(subjectId){subjectId=qq(subjectId);if([String(config.ownerQQ),String(config.selfQQ)].includes(subjectId))throw Error('不能屏蔽主人或机器人');return subjectId;}
 function listIgnoredMembers(){return db.prepare("SELECT b.subject_id AS subjectId,b.state,b.warned_at AS warnedAt,b.blocked_at AS blockedAt,coalesce(n.reason,'') AS reason,coalesce(n.source,'automatic') AS source,coalesce(n.updated_at,b.blocked_at,b.warned_at,0) AS updatedAt FROM qq_member_boundaries b LEFT JOIN qq_member_notes n ON n.subject_id=b.subject_id WHERE b.state IN ('warned','ignored') ORDER BY updatedAt DESC").all();}
 function addIgnoredMember({subjectId,reason=''}){subjectId=protectedId(subjectId);const prior=memberState(subjectId);db.exec('BEGIN IMMEDIATE');try{db.prepare("INSERT INTO qq_member_boundaries VALUES(?,'ignored',?,NULL,NULL,?) ON CONFLICT(subject_id) DO UPDATE SET state='ignored',generation=excluded.generation,blocked_at=excluded.blocked_at").run(subjectId,prior.generation+1,now());note(subjectId,reason,'manual');db.exec('COMMIT');}catch(error){db.exec('ROLLBACK');throw error;}return {subjectId,state:'ignored'};}
 function releaseIgnoredMember({subjectId}){subjectId=qq(subjectId);const prior=memberState(subjectId);db.exec('BEGIN IMMEDIATE');try{db.prepare("INSERT INTO qq_member_boundaries VALUES(?,'none',?,NULL,NULL,NULL) ON CONFLICT(subject_id) DO UPDATE SET state='none',generation=excluded.generation,warned_at=NULL,warning_watermark=NULL,blocked_at=NULL").run(subjectId,prior.generation+1);note(subjectId,'manual release','manual');db.exec('COMMIT');}catch(error){db.exec('ROLLBACK');throw error;}return {subjectId,released:prior.state!=='none'};}
 return {listIgnoredMembers,addIgnoredMember,releaseIgnoredMember,memberState,isIgnored,messageIsIgnored,prepareMemberBoundary,completeMemberBoundary,failMemberBoundary,releaseMember,redactIgnored,memberBoundaryContext};
}
export async function performMemberBoundary({runtime,key,messageId,action,reason,send}){
 runtime.assertOutgoing(key);const prepared=runtime.prepareMemberBoundary({key,messageId,action,reason});if(prepared.done)return prepared;
 try{const receipt=await send(prepared);return runtime.completeMemberBoundary(prepared,receipt?.message_id);}catch(error){runtime.failMemberBoundary(prepared.id);throw error;}
}
