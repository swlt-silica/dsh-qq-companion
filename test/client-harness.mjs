// A small hook/element host; only React and network/browser boundaries are doubled.
// Every callback and all API/state behavior under test belong to the real client.
export function createHarness(factory, fetcher) {
  const cells = [], effects = [];
  let cursor = 0, component, tree, dirty = true;
  const react = {
    Fragment: 'fragment',
    createElement(type, props, ...children) { return {type, props: {...props, children}, children}; },
    useState(initial) {
      const index = cursor++;
      if (!(index in cells)) cells[index] = typeof initial === 'function' ? initial() : initial;
      return [cells[index], next => { cells[index] = typeof next === 'function' ? next(cells[index]) : next; dirty = true; }];
    },
    useRef(initial) { const index = cursor++; return cells[index] ??= {current: initial}; },
    useEffect(effect, deps) {
      const index = cursor++, previous = cells[index];
      if (!previous || deps.some((value, i) => value !== previous[i])) { cells[index] = deps; effects.push(effect); }
    },
  };
  const registrations = [], navigated = [];
  const plugin = factory(name => { if (name === 'react') return react; throw new Error('Unexpected dependency: ' + name); });
  plugin.apply({
    slots: {inject(name, callback) { callback(); }, register(options, value) { registrations.push({options, component:value}); component = value; return () => {}; }},
    inject(deps, callback) { callback({pluginNavigation:{openBundle(name) { navigated.push(name); }}}); },
  });
  function expand(node) {
    if (Array.isArray(node)) return node.flatMap(child => { const result = expand(child); return Array.isArray(result) ? result : [result]; });
    if (!node || typeof node !== 'object') return node;
    if (typeof node.type === 'function') return expand(node.type(node.props));
    return {...node, children: expand(node.children)};
  }
  function render() { cursor = 0; dirty = false; tree = expand(component({view:'page'})); return tree; }
  return {
    plugin, registrations, navigated,
    render,
    async settle() {
      globalThis.fetch = fetcher;
      for (let i=0; i<12; i++) { if (dirty || !tree) render(); while (effects.length) effects.shift()(); await new Promise(resolve => setImmediate(resolve)); }
      if (dirty) render();
      return tree;
    },
    all(predicate) { const result=[]; function walk(node) { if (Array.isArray(node)) return node.forEach(walk); if (!node || typeof node !== 'object') return; if (predicate(node)) result.push(node); walk(node.children); } walk(tree); return result; },
    field(label) { const node = this.all(node => node.props['aria-label'] === label)[0]; if (!node) throw new Error('Missing field ' + label); return node; },
    button(label) { const node = this.all(node => node.type === 'button' && node.children.flat(Infinity).join('') === label)[0]; if (!node) throw new Error('Missing button ' + label); return node; },
    text() { function text(node) { if (Array.isArray(node)) return node.map(text).join(' '); if (node && typeof node === 'object') return text(node.children); return node === false || node == null ? '' : String(node); } return text(tree); },
    async change(label, value) { const field=this.field(label); await field.props.onChange({target:{value,checked:value}}); return this.settle(); },
    async click(label) { const button=this.button(label); if (button.props.disabled) throw new Error('Button disabled: ' + label); await button.props.onClick(); return this.settle(); },
  };
}

export function snapshot(revision = 3) {
  return {revision, config:{
    connection:{accessToken:'MUST-NOT-RENDER',dshToken:'MUST-NOT-RENDER',onebotWs:'ws://user:secret@localhost'},
    identity:{botName:'伴聊',ownerQQ:'10001',selfQQ:'10002'},
    access:{groups:['20001'],private:['30001']}, runtime:{enabled:false,inference:true,outgoing:true},
    proactive:{enabled:true,dailyLimit:10,minIntervalMinutes:30,interjectProbability:0.05,groupIdleMinutes:30,privateIdleMinutes:120,quietStart:'23:00',quietEnd:'08:00',timezone:'Asia/Shanghai',overrides:{}},
    daily:{enabled:true,time:'00:05',includeOwnerPrivate:false,sampleChars:16000,skillMinSuccesses:3},
    reports:{enabled:true,hour:21,groups:['20001']},cache:{enabled:false},paths:{stateDir:'secret-directory'},
  }, status:{state:'stopped',connected:false}, blacklist:[{userId:'40001',reason:'人工管理'}],
    diaries:[{date:'2026-10-22',title:'日记'}], reports:[], metrics:{inputTokens:100,cacheReadTokens:80,outputTokens:12}, audit:[]};
}

export function apiFixture(initial = snapshot()) {
  let current=structuredClone(initial), fail=null, getFailure=null;
  const calls=[];
  return {
    calls,
    get current() { return current; },
    set current(value) { current=value; },
    failNext(code='REVISION_CONFLICT') { fail=code; },
    failReadback() { getFailure=true; },
    async fetch(url, options={}) {
      calls.push({url, ...options, body: options.body ? JSON.parse(options.body) : undefined});
      if (String(url).includes('?diary=')) return new Response('# 授权日记\n<script>unsafe()</script>', {headers:{'content-type':'text/markdown'}});
      if (options.method === 'POST') {
        if (fail) { const code=fail; fail=null; return Response.json({ok:false,error:{code,message:'请刷新后重试'}},{status:409}); }
        const {action,payload}=JSON.parse(options.body);
        if (action === 'config.export') return Response.json({ok:true,value:{config:current.config}});
        if (action === 'config.update') { for (const [key,value] of Object.entries(payload.patch)) current.config[key]={...current.config[key],...value}; current.revision++; }
        return Response.json({ok:true,value:{revision:current.revision}});
      }
      if (getFailure) { getFailure=null; return new Response('Unavailable', {status:503}); }
      return Response.json({ok:true,value:current});
    },
  };
}
