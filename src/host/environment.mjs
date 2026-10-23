export function runtimeEnvironment({legacy={},dshHome,env=process.env}){
 const result={DSH_HOME:dshHome,QQ_DEPLOYMENT:'1'},vision=legacy.deployment?.vision;
 if(vision?.enabled){const key=vision.apiKeyEnv;if(typeof key!=='string'||!/^[A-Za-z_][A-Za-z0-9_]{0,100}$/.test(key)||typeof env[key]!=='string'||!env[key])throw Error('Configured vision credential is unavailable in the DSH service environment');result[key]=env[key];}
 return result;
}
