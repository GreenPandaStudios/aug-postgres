#!/usr/bin/env node
import assert from 'node:assert/strict';
import {cpSync,mkdirSync,writeFileSync} from 'node:fs';
import {join,resolve,dirname} from 'node:path';
import {spawn,spawnSync} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
const root=resolve(import.meta.dirname,'..'),cli=process.env.AUG_CLI,configuration=process.env.AUG_POSTGRES_TEST_TLS_CONFIGURATION;
assert.ok(cli&&configuration,'Supply the source candidate CLI and disposable verify-full database configuration');
const project=join(root,'.aug-build/http-drain');mkdirSync(project,{recursive:true});cpSync(join(root,'http-tests'),project,{recursive:true});
writeFileSync(join(project,'main.yaml'),'backend: llvm\npackages:\n  postgres: '+JSON.stringify(root)+'\n  web: '+JSON.stringify(join(dirname(dirname(cli)),'src/stdlib/web'))+'\n');
for(const command of ['install','build']){const r=spawnSync(process.execPath,[cli,command,project],{encoding:'utf8',timeout:60000});assert.equal(r.status,0,r.stderr);}
const server=spawn(join(project,'.aug-build/http-drain'),[],{env:{...process.env,AUG_WORKERS:'2'},stdio:['ignore','pipe','pipe']});let output='',errors='';server.stdout.on('data',chunk=>output+=chunk);server.stderr.on('data',chunk=>errors+=chunk);
async function until(check,limit){const start=performance.now();while(!check()&&performance.now()-start<limit){assert.equal(server.exitCode,null,errors||output);await delay(5);}assert.ok(check(),errors||output||'Startup timed out');}
try{await until(()=>/port (\d+)/.test(output),5000);const port=Number(/port (\d+)/.exec(output)[1]);
 const pending=fetch('http://127.0.0.1:'+port+'/slow',{method:'POST',body:configuration,signal:AbortSignal.timeout(10000)}).then(async r=>{await r.text();},()=>{});
 const observer=process.env.AUG_POSTGRES_NATIVE_CLIENT;assert.ok(observer);let admitted=false;for(let i=0;i<100&&!admitted;i++){const r=spawnSync(observer,[configuration,'observe-query'],{encoding:'utf8',timeout:3000});assert.ok(r.status===0||r.status===2,r.stderr);admitted=r.status===0;if(!admitted)await delay(10);}assert.ok(admitted,'PostgreSQL must confirm the native HTTP query is active before shutdown');
 const began=performance.now();const response=await fetch('http://127.0.0.1:'+port+'/stop',{method:'POST',signal:AbortSignal.timeout(3000)});assert.equal(response.status,200);await response.text();
 const deadline=performance.now()+2000;while(server.exitCode===null&&performance.now()<deadline)await delay(5);
 assert.equal(server.exitCode,0,errors||output);assert.ok(performance.now()-began<2000,'HTTP must cancel and join the native query before its five-second completion');assert.match(output,/database HTTP drained/);await pending;
 console.log('HTTP database worker cancellation and drain passed');
}finally{if(server.exitCode===null&&server.signalCode===null){server.kill('SIGKILL');await new Promise(resolve=>server.once('exit',resolve));}}
