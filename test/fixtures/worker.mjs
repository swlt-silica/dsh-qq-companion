process.on('message',m=>{
 if(m.op==='hang')return;
 if(m.op==='crash'){process.exit(4);return;}
 process.send({id:m.id,ok:true,value:{op:m.op}});
 if(m.op==='shutdown')setTimeout(()=>process.exit(0),5);
});
process.send({event:'ready',value:{online:true}});
