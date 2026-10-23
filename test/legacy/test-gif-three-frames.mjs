import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {MEDIA_DEFAULTS,planAnimation,normalizeImageForModel,sniffImage} from '../../src/runtime/media-normalize.js';
const head='47494638396101000100800000ffffff000000';
const frame='21f904010a000000'+'2c0000000001000100000202440100';
const tinyGIF=Buffer.from(head+frame+frame+'3b','hex');
test('every animation is capped at three samples, including oversized configuration',()=>{
 for(const n of [4,10,48,200])for(const cap of [undefined,3,6,12,999]){
  const p=planAnimation({frames:n,durationMs:4000},{gifFrames:cap});
  assert.equal(p.sampleFrames,3);assert.equal(p.cols*p.rows,3);
 }
 assert.equal(MEDIA_DEFAULTS.gifFrames,3);
});
test('samples cover first, middle and last; short animations do not duplicate',()=>{
 assert.deepEqual(planAnimation({frames:9,durationMs:9000}).frameIndices,[0,4,8]);
 assert.deepEqual(planAnimation({frames:2,durationMs:200}).frameIndices,[0,1]);
 assert.deepEqual(planAnimation({frames:1,durationMs:100}).frameIndices,[0]);
});
test('decoder failure never uploads the original full animation',async()=>{
 const r=await normalizeImageForModel(tinyGIF,'image/gif',{ffmpegPath:process.execPath});
 assert.equal(r.ok,false);assert.equal(r.buffer,undefined);assert.match(r.error,/抽帧/);
});
test('disabling static image normalization cannot bypass the animation cap',async()=>{
 const r=await normalizeImageForModel(tinyGIF,'image/gif',{enabled:false,ffmpegPath:process.execPath});
 assert.equal(r.ok,false);assert.equal(r.buffer,undefined);
});
test('real decoder produces exactly the red/green/blue sampled panels',{skip:!process.env.FFMPEG_PATH},async()=>{
 const ffmpeg=process.env.FFMPEG_PATH,tmp=fs.mkdtempSync(path.join(os.tmpdir(),'qq-three-frames-'));
 const ff=args=>{const r=spawnSync(ffmpeg,['-v','error','-y',...args],{timeout:15000});assert.equal(r.status,0,String(r.stderr));return r.stdout;};
 try{
  for(let i=0;i<9;i++){
   const color=i<3?[255,0,0]:i<6?[0,255,0]:[0,0,255];
   fs.writeFileSync(path.join(tmp,`frame-${String(i).padStart(2,'0')}.ppm`),Buffer.concat([Buffer.from('P6\n16 16\n255\n'),Buffer.from(Array.from({length:256},()=>color).flat())]));
  }
  const source=path.join(tmp,'test.gif');ff(['-framerate','1','-i',path.join(tmp,'frame-%02d.ppm'),'-filter_complex','split[a][b];[a]palettegen[p];[b][p]paletteuse',source]);
  const input=fs.readFileSync(source);assert.equal(sniffImage(input).frames,9);
  const r=await normalizeImageForModel(input,'image/gif',{ffmpegPath:ffmpeg,gifFrames:999,gifTile:64,tmpDir:tmp});
  assert(r.ok,r.error);assert.equal(r.mimeType,'image/jpeg');assert.match(r.note,/已抽 3 帧/);
  const image=path.join(tmp,'result.jpg');fs.writeFileSync(image,r.buffer);
  const info=sniffImage(r.buffer);assert.equal(info.width,208);assert.equal(info.frames,1);
  const rgb=ff(['-i',image,'-frames:v','1','-f','rawvideo','-pix_fmt','rgb24','pipe:1']);
  for(let i=0;i<3;i++){
   const offset=(36*info.width+(36+68*i))*3,p=[...rgb.subarray(offset,offset+3)];
   assert(p[i]>180&&p.filter((_,j)=>j!==i).every(c=>c<65),`Panel ${i} has wrong color: ${p}`);
  }
 }finally{fs.rmSync(tmp,{recursive:true,force:true});}
});
