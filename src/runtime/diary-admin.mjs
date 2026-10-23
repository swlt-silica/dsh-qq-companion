import fs from 'node:fs';import path from 'node:path';
export function createDiaryReader({workspace}){
 if(typeof workspace!=='string'||!path.isAbsolute(workspace))throw Error('Explicit absolute workspace required');
 const dir=path.join(workspace,'日记');
 function safeDir(){for(const value of [workspace,dir]){const s=fs.lstatSync(value);if(s.isSymbolicLink()||!s.isDirectory())throw Error('Unsafe diary directory');}}
 function read(date){
  if(typeof date!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(date)||new Date(date+'T00:00:00Z').toISOString().slice(0,10)!==date)throw Error('Invalid diary date');
  safeDir();const file=path.join(dir,date+'.md'),s=fs.lstatSync(file);
  if(s.isSymbolicLink()||!s.isFile()||s.size>32000)throw Error('Unsafe diary file');
  const fd=fs.openSync(file,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW??0));try{const live=fs.fstatSync(fd);if(!live.isFile()||live.size>32000)throw Error('Unsafe diary file');return fs.readFileSync(fd,'utf8');}finally{fs.closeSync(fd);}
 }
 function list(){if(!fs.existsSync(dir))return [];safeDir();return fs.readdirSync(dir).filter(n=>/^\d{4}-\d{2}-\d{2}\.md$/.test(n)).filter(n=>{try{read(n.slice(0,-3));return true;}catch{return false;}}).sort().reverse().slice(0,366).map(n=>({date:n.slice(0,-3)}));}
 return {read,list};
}
