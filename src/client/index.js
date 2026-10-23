/** Native DSH module factory. Keep all runtime references inside the factory. */
export const id = 'dsh-qq-companion';

export function factory(require) {
  const react = require('react');
  const h = react.createElement;
  const API = '/api/qq-companion';
  const SECTIONS = [['runtime','运行'],['lists','名单'],['proactive','主动发言'],['diary','日记与学习'],['reports','群报告'],['metrics','用量与审计']];
  const schema = {
    identity: {botName:'string',ownerQQ:'string',selfQQ:'string'},
    access: {groups:'ids',private:'ids'},
    runtime: {enabled:'boolean',inference:'boolean',outgoing:'boolean'},
    proactive: {enabled:'boolean',dailyLimit:'number',minIntervalMinutes:'number',interjectProbability:'number',groupIdleMinutes:'number',privateIdleMinutes:'number',quietStart:'string',quietEnd:'string',timezone:'string',overrides:'overrides'},
    daily: {enabled:'boolean',time:'string',includeOwnerPrivate:'boolean',sampleChars:'number',skillMinSuccesses:'number'},
    reports: {enabled:'boolean',hour:'number',groups:'ids'},
    cache: {enabled:'boolean'},
  };
  const overrideTypes = {enabled:'boolean',dailyLimit:'number',minIntervalMinutes:'number',interjectProbability:'number',groupIdleMinutes:'number',privateIdleMinutes:'number',quietStart:'string',quietEnd:'string',timezone:'string'};
  const inputStyle = {boxSizing:'border-box',width:'100%',padding:'8px 10px',borderRadius:8,border:'1px solid var(--dsw-alias-border-l2)',background:'var(--dsw-alias-bg-layer-1)',color:'var(--dsw-alias-label-primary)',font:'inherit'};
  const buttonStyle = {padding:'6px 12px',minHeight:32,borderRadius:8,border:'1px solid var(--dsw-alias-border-l2)',background:'var(--dsw-alias-bg-layer-1)',color:'var(--dsw-alias-label-primary)',font:'inherit',cursor:'pointer'};
  const rowStyle = {display:'flex',gap:8,alignItems:'center',flexWrap:'wrap'};
  const mutedStyle = {margin:0,fontSize:12,color:'var(--dsw-alias-label-tertiary)'};
  let navigateMnemon = null;

  function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
  function string(value) { return typeof value === 'string' ? value.slice(0,500) : ''; }
  function ids(value) {
    const parts = Array.isArray(value) ? value.map(String) : String(value || '').split(/[\s,，;；]+/u).filter(Boolean);
    if (parts.some(part => !/^[1-9]\d{0,19}$/u.test(part))) throw new Error('请输入有效 QQ 号码，使用逗号或换行分隔。');
    return [...new Set(parts)];
  }
  function overrides(value) {
    if (!object(value)) throw new Error('来源覆盖必须是 JSON 对象。');
    const result = {};
    for (const [source, entry] of Object.entries(value)) {
      if (!/^(group|private):[1-9]\d{0,19}$/u.test(source) || !object(entry)) throw new Error('来源格式为 group:群号 或 private:QQ号。');
      const next = {};
      for (const [key, type] of Object.entries(overrideTypes)) {
        if (entry[key] !== undefined) {
          if (typeof entry[key] !== type || (type === 'number' && !Number.isFinite(entry[key]))) throw new Error('来源覆盖数值无效。');
          next[key] = entry[key];
        }
      }
      if (Object.keys(entry).some(key => !Object.hasOwn(overrideTypes,key))) throw new Error('来源覆盖含不支持的字段。');
      result[source] = next;
    }
    return result;
  }
  // Explicit allow-list, never recursive copying of connection, paths, tokens or flags.
  function sanitize(value) {
    const result = {};
    if (!object(value)) throw new Error('设置文件必须是 JSON 对象。');
    for (const [section, fields] of Object.entries(schema)) {
      if (value[section] === undefined) continue;
      if (!object(value[section])) throw new Error('设置分区格式无效。');
      const next = {};
      for (const [key,type] of Object.entries(fields)) {
        const item = value[section][key];
        if (item === undefined) continue;
        if (type === 'ids') next[key] = ids(item);
        else if (type === 'overrides') next[key] = overrides(item);
        else if (typeof item !== type || (type === 'number' && !Number.isFinite(item))) throw new Error('设置字段类型无效。');
        else next[key] = type === 'string' ? string(item) : item;
      }
      if (Object.keys(next).length) result[section] = next;
    }
    return result;
  }
  function date(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
    const parsed = new Date(value + 'T00:00:00Z');
    return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0,10) === value;
  }
  function numeric(value, label, min, max, integer = true) {
    const result = typeof value === 'number' ? value : (String(value).trim() === '' ? NaN : Number(value));
    if (!Number.isFinite(result) || result < min || result > max || (integer && !Number.isInteger(result))) throw new Error(label + '超出有效范围。');
    return result;
  }
  function validateProactive(value) {
    const result = {...value};
    for (const [key,label,min,max,int] of [
      ['dailyLimit','每日上限',0,1000,true],['minIntervalMinutes','最小间隔',1,525600,true],
      ['interjectProbability','插话概率',0,1,false],['groupIdleMinutes','群空闲时间',1,525600,true],['privateIdleMinutes','私聊空闲时间',1,525600,true],
    ]) if (value[key] !== undefined) result[key] = numeric(value[key],label,min,max,int);
    for (const key of ['quietStart','quietEnd']) if (value[key] !== undefined && !/^([01]\d|2[0-3]):[0-5]\d$/u.test(value[key])) throw new Error('静默时间格式应为 HH:mm。');
    if (value.timezone !== undefined) { try { new Intl.DateTimeFormat('zh-CN',{timeZone:value.timezone}); } catch { throw new Error('时区无效。'); } }
    return result;
  }
  function safeSnapshot(value) {
    if (!object(value) || !Number.isSafeInteger(value.revision) || value.revision < 0 || !object(value.config)) throw new Error('服务器状态格式无效。');
    // Do not retain raw credentials in component state, even when a server sends them accidentally.
    const config = sanitize(value.config);
    const sourceStatus = object(value.status) ? value.status : {};
    const state = ['running','stopped','paused','starting','error','disabled','ready'].includes(sourceStatus.state) ? sourceStatus.state : 'unknown';
    const status = {state,connected:sourceStatus.connected === true,pid:Number.isSafeInteger(sourceStatus.pid)?sourceStatus.pid:null};
    const configured = object(value.config.connection) ? value.config.connection : {};
    const connection = {
      onebot: configured.accessTokenConfigured === true || configured.wsAccessTokenConfigured === true || configured.accessToken === true || (typeof configured.accessToken === 'string' && configured.accessToken.length > 0),
      dsh: configured.dshTokenConfigured === true || configured.dshToken === true || (typeof configured.dshToken === 'string' && configured.dshToken.length > 0),
    };
    const blacklist = (Array.isArray(value.blacklist) ? value.blacklist : []).filter(object).map(row => ({userId:string(String(row.userId ?? row.qq ?? '')),reason:string(row.reason)})).filter(row => /^[1-9]\d{0,19}$/u.test(row.userId));
    const diaries = (Array.isArray(value.diaries) ? value.diaries : []).map(row => typeof row === 'string' ? row : row?.date).filter(date).map(value => ({date:value}));
    const reports = (Array.isArray(value.reports) ? value.reports : []).filter(object).map(row => ({date:date(row.date)?row.date:'',groupId:/^[1-9]\d{0,19}$/u.test(String(row.groupId))?String(row.groupId):'',status:['ready','success','failed','pending'].includes(row.status)?row.status:'available'}));
    const metrics = {};
    for (const key of ['inputTokens','cacheReadTokens','cacheWriteTokens','outputTokens','requests','latencyMs','uncachedInputTokens','cacheHitRate']) if (typeof value.metrics?.[key] === 'number' && Number.isFinite(value.metrics[key])) metrics[key] = value.metrics[key];
    const audit = (Array.isArray(value.audit) ? value.audit : []).filter(object).map(row => ({at:string(row.at || row.time),action:/^[a-zA-Z][\w.:-]{0,60}$/u.test(row.action || '')?row.action:'management',ok:row.ok !== false}));
    return {revision:value.revision,config,status,connection,blacklist,diaries,reports,metrics,audit};
  }
  async function request(action, payload, revision) {
    const options = {credentials:'same-origin',cache:'no-store',headers:{Accept:'application/json'}};
    if (action) Object.assign(options,{method:'POST',headers:{...options.headers,'Content-Type':'application/json'},body:JSON.stringify({action,payload,revision})});
    const response = await fetch(API,options);
    let body;
    try { body = await response.json(); } catch { throw new Error('服务器响应无效（HTTP ' + response.status + '）。'); }
    if (!response.ok || body?.ok !== true) {
      const code = /^[A-Z][A-Z0-9_]{0,60}$/u.test(body?.error?.code || '') ? body.error.code : 'REQUEST_FAILED';
      // Error bodies may echo sensitive inputs; only the fixed code reaches the DOM.
      throw new Error(code + '：请求未完成，请刷新状态后重试。');
    }
    return body.value;
  }
  function downloadJson(value) {
    const blob = new Blob([JSON.stringify(value,null,2)],{type:'application/json;charset=utf-8'});
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href=url; anchor.download='qq-companion-settings.json';
    document.body.appendChild(anchor);
    try { anchor.click(); } finally { anchor.remove(); setTimeout(() => URL.revokeObjectURL(url),0); }
  }

  function Page() {
    const [section,setSection] = react.useState('runtime');
    const [server,setServer] = react.useState(null);
    const [draft,setDraft] = react.useState({});
    const [busy,setBusy] = react.useState(false);
    const [stale,setStale] = react.useState(false);
    const [error,setError] = react.useState('');
    const [notice,setNotice] = react.useState('');
    const [overrideText,setOverrideText] = react.useState('{}');
    const [blackQQ,setBlackQQ] = react.useState('');
    const [blackReason,setBlackReason] = react.useState('');
    const [diary,setDiary] = react.useState(null);
    const [from,setFrom] = react.useState('');
    const [to,setTo] = react.useState('');
    const [reportGroup,setReportGroup] = react.useState('');
    const [reportDate,setReportDate] = react.useState('');
    const [importDraft,setImportDraft] = react.useState(null);
    const inFlight = react.useRef(false);
    const live = react.useRef(true);
    const ready = server !== null && !busy && !stale;

    function accept(value) {
      const next = safeSnapshot(value);
      if (!live.current) return next;
      setServer(next); setDraft(next.config); setOverrideText(JSON.stringify(next.config.proactive?.overrides || {},null,2));
      setReportGroup(current => (next.config.reports?.groups || []).includes(current) ? current : (next.config.reports?.groups || [])[0] || '');
      setStale(false);
      return next;
    }
    async function run(callback) {
      if (inFlight.current) return;
      inFlight.current=true; setBusy(true);setError('');setNotice('');
      try { return await callback(); }
      catch (failure) { if (live.current) setError(failure instanceof Error ? failure.message : '请求未完成。'); }
      finally { inFlight.current=false;if(live.current)setBusy(false); }
    }
    async function refresh() { return run(async () => { try { return accept(await request()); } catch (failure) { setStale(true);throw failure; } }); }
    async function mutate(action,payload) {
      if (!ready || inFlight.current) return;
      return run(async () => {
        const acknowledged=await request(action,payload,server.revision);
        let committed;
        try {
          const readback=await request();
          if(Number.isSafeInteger(acknowledged?.revision) && readback?.revision<acknowledged.revision)throw new Error('Stale readback');
          committed=accept(readback);
        }
        catch { setStale(true); throw new Error('操作已提交，但回读失败；请刷新后核对。'); }
        setNotice('已回读服务器状态，当前版本 ' + committed.revision + '。');
      });
    }
    async function submit(callback) { setError('');setNotice('');try { await callback(); } catch(failure) {setError(failure.message);} }
    react.useEffect(() => { live.current=true; void refresh(); return () => {live.current=false;}; },[]);
    function edit(group,key,value) { setDraft(current => ({...current,[group]:{...current[group],[key]:value}})); }
    function field(label,group,key,type='text',extra={}) {
      const current = draft[group]?.[key];
      return h('label',{style:{display:'flex',flexDirection:type === 'checkbox'?'row':'column',gap:6,alignItems:type === 'checkbox'?'center':undefined}},
        type === 'checkbox' ? h('input',{type,checked:current === true,disabled:!ready,'aria-label':label,onChange:event=>edit(group,key,event.target.checked)}) : null,
        h('span',null,label),
        type !== 'checkbox' ? h('input',{type,value:current ?? '',disabled:!ready,'aria-label':label,style:inputStyle,onChange:event=>edit(group,key,event.target.value),...extra}) : null);
    }
    function localField(label,value,setValue,type='text',extra={}) { return h('label',{style:{display:'flex',flexDirection:'column',gap:6}},h('span',null,label),h('input',{type,value,'aria-label':label,style:inputStyle,disabled:!ready,onChange:event=>setValue(event.target.value),...extra})); }
    function button(label,onClick,disabled=!ready) { return h('button',{type:'button',onClick,disabled,style:buttonStyle},label); }
    function note(text) { return h('p',{style:mutedStyle},text); }
    function grid(...children) { return h('div',{className:'qqc-fields'},...children); }
    function block(title,...children) { return h('section',{style:{display:'flex',flexDirection:'column',gap:12}},h('h3',{style:{fontSize:14,margin:0}},title),...children); }
    function save(patch) { return mutate('config.update',{patch}); }

    function runtimeView() {
      const labels={running:'运行中',stopped:'已停止',paused:'已暂停',starting:'启动中',error:'异常',disabled:'已停用',ready:'就绪',unknown:'未知'};
      return h(react.Fragment,null,
        block('运行状态',
          h('div',{style:rowStyle},h('strong',null,labels[server.status.state]),h('span',null,server.status.connected?'网关已连接':'网关未连接')),
          note('OneBot 凭据：' + (server.connection.onebot?'已配置':'未配置') + '；DSH 凭据：' + (server.connection.dsh?'已配置':'未配置') + '。凭据与本地路径请通过部署配置管理。'),
          h('div',{style:rowStyle},button('暂停处理',()=>mutate('runtime.pause',{})),button('恢复处理',()=>mutate('runtime.resume',{})),button('重新连接',()=>mutate('runtime.reconnect',{}))),
          note('暂停会关闭推理与发送门；恢复使用当前白名单。只有点击“重新连接”才主动重建连接。')),
        block('运行设置',grid(field('机器人名称','identity','botName'),field('启用运行','runtime','enabled','checkbox'),field('启用推理','runtime','inference','checkbox'),field('启用发送','runtime','outgoing','checkbox'),field('启用缓存优化','cache','enabled','checkbox')),button('保存运行设置',()=>submit(()=>save({identity:{botName:draft.identity?.botName || ''},runtime:draft.runtime || {},cache:draft.cache || {enabled:false}})))),
        block('设置导入与导出',note('仅处理非敏感设置；连接、令牌及本地路径会被移除。导入先预览，再应用。'),
          h('div',{style:rowStyle},button('导出设置',()=>run(async()=>{const value=await request('config.export',{},server.revision);downloadJson({config:sanitize(value?.config || value)});setNotice('已导出非敏感设置。');})),
            h('label',null,'导入设置文件',h('input',{type:'file',accept:'.json,application/json','aria-label':'导入设置文件',disabled:!ready,onChange:async event=>{
              const file=event.target.files?.[0];event.target.value='';setError('');setImportDraft(null);
              if (!file) return;
              try { if(file.size>262144)throw new Error('设置文件不能超过 256 KiB。');const parsed=JSON.parse(await file.text());const clean=sanitize(parsed.config || parsed);if(!Object.keys(clean).length)throw new Error('文件中没有可导入的设置。');setImportDraft(clean); }
              catch {setError('设置文件无效或过大，请检查 JSON 格式与字段。');}
            }}))),
          importDraft ? h(react.Fragment,null,h('pre',{style:{...inputStyle,whiteSpace:'pre-wrap',maxHeight:240,overflow:'auto'},'aria-label':'非敏感导入预览'},JSON.stringify(importDraft,null,2)),h('div',{style:rowStyle},button('应用导入',async()=>{await mutate('config.import',{config:importDraft});}),button('取消导入',()=>setImportDraft(null)))) : null));
    }
    function listsView() {
      return h(react.Fragment,null,block('允许来源',note('归档、回复与报告均受白名单约束。移除来源后，服务器先撤销旧权限再返回成功。'),
        ...[['groups','群白名单'],['private','私聊白名单']].map(([key,label])=>h('label',{key,style:{display:'flex',flexDirection:'column',gap:6}},h('span',null,label),h('textarea',{'aria-label':label,value:Array.isArray(draft.access?.[key])?draft.access[key].join('\n'):draft.access?.[key] || '',onChange:event=>edit('access',key,event.target.value),disabled:!ready,rows:4,style:inputStyle}))),
        button('保存白名单',()=>submit(()=>{
          const access={groups:ids(draft.access?.groups),private:ids(draft.access?.private)};
          const patch={access};
          const current=server.config.proactive?.overrides || {};
          const next=Object.fromEntries(Object.entries(current).filter(([key])=>{const [kind,id]=key.split(':');return (kind==='group'?access.groups:access.private).includes(id);}));
          if(Object.keys(next).length!==Object.keys(current).length)patch.proactive={overrides:next};
          const reportGroups=server.config.reports?.groups || [];
          const allowedReports=reportGroups.filter(id=>access.groups.includes(id));
          if(allowedReports.length!==reportGroups.length)patch.reports={groups:allowedReports};
          if(server.config.daily?.includeOwnerPrivate && !access.private.includes(server.config.identity?.ownerQQ))patch.daily={includeOwnerPrivate:false};
          return save(patch);
        }))),
        block('实际黑名单',note('此列表来自运行时数据库。主人与机器人自身受服务器保护。'),
          server.blacklist.length ? h('ul',{style:{paddingLeft:20,margin:0}},...server.blacklist.map(row=>h('li',{key:row.userId,style:{marginBottom:8}},row.userId + (row.reason?' · '+row.reason:''),' ',button('解除 '+row.userId,()=>mutate('blacklist.release',{userId:row.userId}))))) : note('当前无黑名单记录。'),
          grid(localField('黑名单 QQ',blackQQ,setBlackQQ),localField('拉黑原因',blackReason,setBlackReason)),button('加入黑名单',()=>submit(()=>{const list=ids(blackQQ);if(list.length!==1)throw new Error('请输入一个有效 QQ 号码。');return mutate('blacklist.add',{userId:list[0],reason:blackReason.trim()});}))));
    }
    function proactiveView() {
      return block('主动发言策略',note('每日额度由全部主动发言来源共用；普通被动回复独立处理。来源覆盖使用 group:群号 或 private:QQ号。'),
        grid(field('启用主动发言','proactive','enabled','checkbox'),field('每日上限','proactive','dailyLimit','number',{min:0,max:1000}),field('最小间隔（分钟）','proactive','minIntervalMinutes','number',{min:1}),field('插话概率','proactive','interjectProbability','number',{min:0,max:1,step:0.01}),field('群空闲（分钟）','proactive','groupIdleMinutes','number',{min:1}),field('私聊空闲（分钟）','proactive','privateIdleMinutes','number',{min:1}),field('静默开始','proactive','quietStart','time'),field('静默结束','proactive','quietEnd','time'),field('时区','proactive','timezone')),
        h('label',null,'来源覆盖 JSON',h('textarea',{'aria-label':'来源覆盖 JSON',style:{...inputStyle,minHeight:120,fontFamily:'var(--ds-font-family-code,monospace)'},value:overrideText,disabled:!ready,onChange:event=>setOverrideText(event.target.value)})),
        button('保存主动发言',()=>submit(()=>{
          let parsed;try{parsed=JSON.parse(overrideText);}catch{throw new Error('来源覆盖 JSON 格式无效。');}
          const clean=overrides(parsed);
          for(const [source,entry] of Object.entries(clean)){
            validateProactive(entry);
            const [kind,id]=source.split(':');
            if(!(server.config.access?.[kind==='group'?'groups':'private'] || []).includes(id))throw new Error('来源覆盖必须属于已提交的白名单。');
          }
          return save({proactive:{...validateProactive(draft.proactive || {}),overrides:clean}});
        })),
        note('默认：每日 10 次、间隔 30 分钟、插话概率 0.05、群空闲 30 分钟、私聊空闲 120 分钟、23:00–08:00 静默。'));
    }
    function diaryView() {
      return h(react.Fragment,null,
        block('日记与原生学习',note('日记仅在当前管理会话中读取；内容以纯文本显示。项目文档和技能由 Mnemon 原生页面管理。'),
          server.diaries.length ? h('ul',{style:{paddingLeft:20,margin:0}},...server.diaries.map(row=>h('li',{key:row.date,style:{marginBottom:8}},h('div',{style:rowStyle},h('span',null,row.date),button('阅读 '+row.date,()=>run(async()=>{
            const response=await fetch(API+'?diary='+row.date,{credentials:'same-origin',cache:'no-store',headers:{Accept:'text/markdown'}});
            if(!response.ok)throw new Error('日记读取失败（HTTP '+response.status+'）。');
            const content=await response.text();if(content.length>2097152)throw new Error('日记过大，请使用下载。');setDiary({date:row.date,content});
          })),h('a',{href:API+'?diary='+row.date+'&download=1',download:'qq-diary-'+row.date+'.md',style:{color:'var(--dsw-alias-label-link, var(--dsw-alias-label-primary))'}},'下载 Markdown'))))) : note('暂无日记。'),
          diary ? h('article',null,h('h4',{style:{fontSize:13}},diary.date),h('pre',{style:{...inputStyle,maxHeight:420,overflow:'auto',whiteSpace:'pre-wrap',overflowWrap:'anywhere'},'aria-label':'日记正文'},diary.content)) : null),
        block('每日学习计划',grid(field('启用每日学习','daily','enabled','checkbox'),field('每日执行时间','daily','time','time'),field('纳入主人私聊','daily','includeOwnerPrivate','checkbox'),field('最大采样字符','daily','sampleChars','number',{min:1,max:1000000}),field('技能最低成功次数','daily','skillMinSuccesses','number',{min:3,max:1000})),
          note('默认 00:05，仅采样获准群聊。主人私聊需显式开启并继续满足私聊白名单。'),
          button('保存学习设置',()=>submit(()=>{const daily={...draft.daily};if(!/^([01]\d|2[0-3]):[0-5]\d$/u.test(daily.time||''))throw new Error('执行时间无效。');daily.sampleChars=numeric(daily.sampleChars,'采样字符',1,1000000);daily.skillMinSuccesses=numeric(daily.skillMinSuccesses,'成功次数',3,1000);return save({daily});}))),
        block('补写缺失日记',note('每次最多 7 天，仅补写不存在的日记，保留已有内容。'),grid(localField('补写起始日期',from,setFrom,'date'),localField('补写结束日期',to,setTo,'date')),button('补写缺失日记',()=>submit(()=>{
          if(!date(from)||!date(to)||from>to)throw new Error('请选择有效的起止日期。');if((Date.parse(to)-Date.parse(from))/86400000>=7)throw new Error('单次补写最多 7 天。');return mutate('diary.backfill',{from,to});
        }))));
    }
    function reportsView() {
      const allowed=new Set(server.config.access?.groups || []);
      const choices=(server.config.reports?.groups || []).filter(id=>allowed.has(id));
      return h(react.Fragment,null,block('群报告计划',grid(field('启用群报告','reports','enabled','checkbox'),field('报告小时（0–23）','reports','hour','number',{min:0,max:23})),
        h('label',null,'报告群列表',h('textarea',{'aria-label':'报告群列表',rows:3,style:inputStyle,value:Array.isArray(draft.reports?.groups)?draft.reports.groups.join('\n'):draft.reports?.groups||'',disabled:!ready,onChange:event=>edit('reports','groups',event.target.value)})),
        note('报告群必须同时在群白名单中。'),button('保存报告设置',()=>submit(()=>{const groups=ids(draft.reports?.groups);if(groups.some(id=>!allowed.has(id)))throw new Error('报告群必须在群白名单中。');return save({reports:{enabled:draft.reports?.enabled===true,hour:numeric(draft.reports?.hour,'报告小时',0,23),groups}});}))),
        block('生成与记录',h('label',null,'报告群',h('select',{'aria-label':'报告群',value:reportGroup,disabled:!ready,style:inputStyle,onChange:event=>setReportGroup(event.target.value)},...choices.map(id=>h('option',{key:id,value:id},id)))),localField('报告日期',reportDate,setReportDate,'date'),button('生成群报告',()=>submit(()=>{if(!date(reportDate))throw new Error('请选择有效报告日期。');if(!choices.includes(reportGroup))throw new Error('请选择已获准的报告群。');return mutate('reports.run',{groupId:reportGroup,date:reportDate});}),!ready||choices.length===0),
          server.reports.length?h('ul',null,...server.reports.map((row,index)=>h('li',{key:index},[row.date,row.groupId,row.status].join(' · '), date(row.date)&&/^[1-9]\d{0,19}$/u.test(String(row.groupId))&&allowed.has(String(row.groupId))&&['ready','sent','sending'].includes(row.status)?h('a',{href:API+'?report='+encodeURIComponent(row.groupId)+'&date='+encodeURIComponent(row.date)+'&format=html',download:String(row.groupId)+'-'+row.date+'.html',style:{marginLeft:8}},'下载 HTML'):null))):note('暂无报告记录。')));
    }
    function metricsView() {
      const metrics=server.metrics;
      return h(react.Fragment,null,block('Token 用量',h('dl',{className:'qqc-fields',style:{margin:0}},...[
        ['inputTokens','输入 Token'],['cacheReadTokens','缓存命中 Token'],['uncachedInputTokens','未缓存输入 Token'],['cacheWriteTokens','缓存写入 Token'],['outputTokens','输出 Token'],['requests','请求数'],['latencyMs','累计耗时（毫秒）'],
      ].map(([key,label])=>h('div',{key},h('dt',{style:mutedStyle},label),h('dd',{style:{margin:'4px 0',fontVariantNumeric:'tabular-nums',fontSize:18}},metrics[key]===undefined?'—':String(metrics[key])))),h('div',null,h('dt',{style:mutedStyle},'缓存命中率'),h('dd',{style:{margin:'4px 0',fontSize:18}},metrics.cacheHitRate>=0&&metrics.cacheHitRate<=1?String(Math.round(metrics.cacheHitRate*1000)/10)+'%':'—'))),note('未提供的计数显示为 —；不从估计值推导缓存命中。')),
      block('管理审计',server.audit.length?h('ol',{style:{margin:0,paddingLeft:20}},...server.audit.slice(-50).reverse().map((row,index)=>h('li',{key:index},row.at+' · '+row.action+' · '+(row.ok?'完成':'失败')))):note('暂无管理记录。')));
    }
    const views={runtime:runtimeView,lists:listsView,proactive:proactiveView,diary:diaryView,reports:reportsView,metrics:metricsView};
    return h('div',{'aria-busy':busy,style:{display:'flex',flexDirection:'column',gap:18,fontSize:13,minWidth:0,color:'var(--dsw-alias-label-primary)'}},
      h('style',null,'.qqc-fields{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,220px),1fr));gap:12px}.qqc-nav{display:flex;gap:6px;flex-wrap:wrap}.qqc-nav button[aria-pressed=true]{background:var(--dsw-alias-interactive-bg-hover);font-weight:600}.qqc-nav button:focus-visible{outline:2px solid var(--dsw-alias-label-primary);outline-offset:2px}'),
      h('div',{style:rowStyle},h('span',null,server?'配置版本 '+server.revision:'加载管理状态…'),button('刷新',refresh,busy),button('Mnemon 原生管理',()=>submit(()=>{if(!navigateMnemon)throw new Error('当前 DSH 未提供插件导航，请从插件页打开 Mnemon。');navigateMnemon();}),busy)),
      h('nav',{'aria-label':'QQ 伴聊管理区域',className:'qqc-nav'},...SECTIONS.map(([key,label])=>h('button',{key,type:'button',style:buttonStyle,'aria-pressed':key===section,onClick:()=>setSection(key)},label))),
      error?h('p',{role:'alert',style:{margin:0,color:'var(--dsw-alias-state-error-primary)'}},error):null,
      notice?h('p',{role:'status',style:{margin:0,color:'var(--dsw-alias-state-success-primary)'}},notice):null,
      busy?h('p',{role:'status',style:mutedStyle},'正在处理，请稍候…'):null,
      stale?note('当前状态尚未核实；刷新成功后才能继续修改。'):null,
      server?h('div',{'aria-label':SECTIONS.find(row=>row[0]===section)[1],style:{display:'flex',flexDirection:'column',gap:24}},views[section]()):null);
  }
  function CompanionCard(props) {
    if(props?.view==='summary')return 'QQ 伴聊运行、白名单、主动发言、日记、群报告与用量管理。';
    return h(Page,null);
  }
  function apply(ctx) {
    if(typeof ctx.inject==='function')ctx.inject(['pluginNavigation'],inner=>{navigateMnemon=()=>inner.pluginNavigation.openBundle('dsh-mnemon');return()=>{navigateMnemon=null;};});
    ctx.slots.inject('plugins.bundle.config',()=>ctx.slots.register({name:'plugins.bundle.config',key:'dsh-qq-companion',id:'dsh-qq-companion'},CompanionCard));
  }
  return {apply,inject:['slots']};
}
