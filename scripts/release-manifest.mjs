import fs from 'node:fs';import path from 'node:path';import{createHash}from'node:crypto';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('..',import.meta.url)),forbidden=JSON.parse(process.env.RELEASE_FORBIDDEN_VALUES||'[]');
const files=['package.json','package-lock.json','cordis.patch.yml','README.md','LICENSE','NOTICE','report-renderer.py','docs/cache-report.md','docs/migration.md'];
function visit(dir){for(const item of fs.readdirSync(path.join(root,dir),{withFileTypes:true})){const name=dir+'/'+item.name;if(item.isSymbolicLink())throw Error('Release contains a symbolic link');if(item.isDirectory())visit(name);else if(item.isFile())files.push(name);}}
for(const dir of ['src','lib','presets','report-templates','test','scripts'])visit(dir);
const selected=[...new Set(files)].sort(),findings=[];
for(const name of selected){const buffer=fs.readFileSync(path.join(root,name)),text=buffer.toString('utf8');if(/(?:^|\/)(?:\.env|credentials|state|backups?|日记)(?:[\/.]|$)|\.(?:sqlite|db)(?:-|$)/i.test(name))findings.push(name+': forbidden release path');if(forbidden.some(value=>typeof value==='string'&&value.length>=5&&text.includes(value)))findings.push(name+': deployment-specific material');if(/(?:sk-[A-Za-z0-9_-]{24,}|ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{35,})/.test(text))findings.push(name+': credential-like literal');}
if(findings.length)throw Error(findings.join('\n'));
const manifest=selected.map(name=>({path:name,bytes:fs.statSync(path.join(root,name)).size,sha256:createHash('sha256').update(fs.readFileSync(path.join(root,name))).digest('hex')}));
fs.mkdirSync(path.join(root,'artifacts'),{recursive:true});fs.writeFileSync(path.join(root,'artifacts','public-file-manifest.json'),JSON.stringify({files:manifest,count:manifest.length,scan:'passed',excluded:['.git history','internal plans and reviews','private configuration','persona','account IDs','chat and memory','diaries','backups','node_modules']},null,2)+'\n');
fs.writeFileSync(path.join(root,'artifacts','public-file-list.md'),'# Proposed public files\n\n'+manifest.length+' files; scan passed. No publication performed.\n\n'+manifest.map(f=>'- '+f.path).join('\n')+'\n');console.log(JSON.stringify({publicFiles:manifest.length,scan:'passed',publicationPerformed:false}));
