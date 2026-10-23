const MAX_BODY=256*1024;
function json(res,status,value){res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'});res.end(JSON.stringify(value));}
function invalid(message){return Object.assign(Error(message),{code:'VALIDATION',status:400});}
export function createManagementHandler({authenticate,snapshot,dispatch,diary,report}){
 return async function handler(req,res){
  try{
   if(Object.keys(req.headers??{}).some(key=>/^x-(?:qq-)?agent(?:-|$)/i.test(key)))return json(res,403,{ok:false,error:{code:'FORBIDDEN',message:'管理接口不接受机器人令牌'}});
   if(!await authenticate(req))return json(res,401,{ok:false,error:{code:'UNAUTHORIZED',message:'需要 DSH 网页登录'}});
   const url=new URL(req.url,'http://localhost');
   if(req.method==='GET'){
    if(url.searchParams.has('report')){const r=await report({groupId:url.searchParams.get('report'),date:url.searchParams.get('date'),format:url.searchParams.get('format')??'html'});res.writeHead(200,{'content-type':r.type,'content-disposition':`attachment; filename="${r.name}"`,'content-security-policy':"sandbox; default-src 'none'",'cache-control':'no-store','x-content-type-options':'nosniff'});return res.end(r.data);}
    if(url.searchParams.has('diary')){
     const date=url.searchParams.get('diary');if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||new Date(date+'T00:00:00Z').toISOString().slice(0,10)!==date)throw invalid('日记日期无效');
     const content=await diary(date);res.writeHead(200,{'content-type':'text/markdown; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff',...(url.searchParams.get('download')==='1'?{'content-disposition':`attachment; filename="${date}.md"`}:{})});return res.end(content);
    }
    return json(res,200,{ok:true,value:await snapshot()});
   }
   if(req.method!=='POST')return json(res,405,{ok:false,error:{code:'METHOD',message:'Unsupported method'}});
   const site=req.headers['sec-fetch-site'],origin=req.headers.origin;
   if(!String(req.headers['content-type']??'').toLowerCase().startsWith('application/json')||(site&&site!=='same-origin'&&site!=='none'))return json(res,403,{ok:false,error:{code:'ORIGIN',message:'需要同源 JSON 请求'}});
   if(origin){let parsed;try{parsed=new URL(origin);}catch{}if(!parsed||!['http:','https:'].includes(parsed.protocol)||parsed.host!==req.headers.host)return json(res,403,{ok:false,error:{code:'ORIGIN',message:'请求来源不匹配'}});}
   let size=0,chunks=[];for await(const chunk of req){size+=chunk.length;if(size>MAX_BODY)throw Object.assign(invalid('请求过大'),{status:413});chunks.push(chunk);}
   let body;try{body=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw invalid('JSON 无效');}
   if(!body||Array.isArray(body)||typeof body!=='object'||Object.keys(body).some(k=>!['action','payload','revision'].includes(k))||typeof body.action!=='string'||body.action.length>80||!Number.isSafeInteger(body.revision)||body.revision<0||!body.payload||typeof body.payload!=='object'||Array.isArray(body.payload))throw invalid('管理请求格式无效');
   return json(res,200,{ok:true,value:await dispatch(body.action,body.payload,body.revision)});
  }catch(error){const status=error.status??(error.code==='ENOENT'?404:500);return json(res,status,{ok:false,error:{code:error.code??'OPERATION',message:status<500?error.message:'操作未完成，请查看运行状态；不会自动重试'}});}
 };
}
