// The native host supplies explicit per-instance roots and the private Node IPC channel.
for(const key of ['QQ_COMPANION_ROOT','QQ_COMPANION_STATE_DIR','QQ_COMPANION_CONFIG_FILE','DSH_HOME']){
 if(!process.env[key])throw Error(`${key} is required`);
}
await import('./bridge.js');
