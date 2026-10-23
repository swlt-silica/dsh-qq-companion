import { scopeOf } from '@deepseek-ai/dsh-scope';
export const name = 'qq-deployment-boundary';
export const inject = ['tools', 'systemPrompt'];
import {CHAT_TOOLS} from './tools.mjs';
export {CHAT_TOOLS} from './tools.mjs';
export function apply(ctx, config = {}) {
  const scope = scopeOf(ctx);
  if (!scope) throw new Error('QQ boundary requires native agent scope');
  const allowed = new Set(config.report ? [] : [...CHAT_TOOLS,'mcp__snowluma__qq_member_boundary','mcp__snowluma__qq_diary','mcp__snowluma__qq_learned_skill']);
  // Native mode excludes the reserved run_code PTC transport.
  ctx.tools.presentAs('native');
  // Preset generations activate before MCP discovery can finish. Install each
  // replacement BEFORE disposing the previous mask, so no unfiltered window
  // occurs even for synchronous tools/change observers.
  let disposeMask;
  let signature;
  let refreshing = false;
  function refresh() {
    if (refreshing) return;
    refreshing = true;
    try {
      const available = [...ctx.tools.view(scope).restrictableNames].filter(x => allowed.has(x)).sort();
      const nextSignature = JSON.stringify(available);
      if (nextSignature === signature) return;
      const next = ctx.tools.restrict({allow: available});
      const previous = disposeMask;
      disposeMask = next;
      signature = nextSignature;
      previous?.();
    } finally { refreshing = false; }
  }
  ctx.on('tools/change', refresh, {global:true});
  refresh();
  ctx.tools.guard(exec => allowed.has(exec?.name) ? undefined : 'QQ deployment: tool denied');
  // Plugins such as OPS publish into the agent's OWN scope, which restrict()
  // deliberately exempts. Keep the final model header and the execution guard
  // aligned, including scoped definitions registered after preset activation.
  ctx.on('system-prompt/assemble', async (_assembly, _context, next) => {
    const assembled = await next();
    return {...assembled, tools:(assembled.tools??[]).filter(tool=>allowed.has(tool.name)).sort((a,b)=>a.name.localeCompare(b.name))};
  });
  // Scoped registrations are exempt from restrict(). No tool-producing plugins
  // belong in these presets; deny accidental scoped additions during execution.
}
