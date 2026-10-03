#!/usr/bin/env node
// Build a disposable PostgreSQL server from the same verified source archive.
import {mkdirSync,writeFileSync,readFileSync,chmodSync,rmSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {createServer} from 'node:net';
if(process.getuid?.()===0)throw Error('Disposable PostgreSQL must run as an unprivileged maintainer user.');
const root=resolve(import.meta.dirname,'..'),mac=process.platform==='darwin';
const cache=join(root,'.aug-build',mac?'native':'native-linux-'+process.arch),build=join(cache,'postgres-build'),prefix=join(cache,'pg-install'),openssl=join(cache,'openssl-3.5.9');
const run=(command,args,env=process.env)=>{const r=spawnSync(command,args,{cwd:root,env,encoding:'utf8',maxBuffer:30000000,timeout:600000});if(r.status!==0)throw Error(command+' failed: '+(r.stderr||r.stdout||r.error?.message).slice(-4000));return r.stdout;};
// Only the disposable server tools use this shared libpq. The package adapter
// stays statically linked. Build/install all-lib explicitly because the upstream
// exit-symbol test includes OpenSSL's registered process cleanup.
run('make',['-j4','-C',join(build,'src/interfaces/libpq'),'all-lib']);
run('make',['-j4','-C',join(build,'src/interfaces/libpq'),'-o','libpq-refs-stamp','install']);
mkdirSync(join(prefix,'include/server/catalog'),{recursive:true});
for(const directory of ['src/backend','src/include/catalog','src/backend/snowball','src/pl/plpgsql','src/bin/initdb','src/bin/pg_ctl','src/timezone'])run('make',['-j4','-C',join(build,directory),'-o','submake-libpq','install']);
run('make',['-j4','-C',openssl,'apps/openssl']);
const temporary=join(cache,'server');rmSync(temporary,{recursive:true,force:true});mkdirSync(temporary,{recursive:true});
const password=join(temporary,'password'),cert=join(temporary,'server.crt'),key=join(temporary,'server.key'),config=join(temporary,'certificate.conf');
writeFileSync(password,'disposable-only\n',{mode:0o600});
writeFileSync(config,'[req]\ndistinguished_name=dn\nx509_extensions=extensions\nprompt=no\n[dn]\nCN=localhost\n[extensions]\nsubjectAltName=DNS:localhost\nbasicConstraints=critical,CA:TRUE\n');
run(join(openssl,'apps/openssl'),['req','-x509','-newkey','rsa:2048','-nodes','-days','1','-keyout',key,'-out',cert,'-config',config]);chmodSync(key,0o600);
const data=join(temporary,'data'),control=join(prefix,'bin/pg_ctl');
run(join(prefix,'bin/initdb'),['-D',data,'-U','qualification','-A','scram-sha-256','--pwfile='+password,'--no-locale','--encoding=UTF8']);
const listener=createServer();await new Promise(resolve=>listener.listen(0,'127.0.0.1',resolve));const port=listener.address().port;await new Promise(resolve=>listener.close(resolve));
const quoted=text=>"'"+text.replaceAll("'","''")+"'";
writeFileSync(join(data,'postgresql.conf'),readFileSync(join(data,'postgresql.conf'))+'\nlisten_addresses=\'127.0.0.1\'\nport='+port+'\nssl=on\nssl_cert_file='+quoted(cert)+'\nssl_key_file='+quoted(key)+'\n');
let running=false;
try{run(control,['-D',data,'-l',join(temporary,'server.log'),'-w','-t','30','start']);running=true;
 const configuration='host=127.0.0.1 port='+port+' user=qualification password=disposable-only dbname=postgres';
 console.log(run(process.execPath,[join(root,'native/qualify.mjs')],{...process.env,AUG_POSTGRES_TEST_CONFIGURATION:configuration+' sslmode=disable',AUG_POSTGRES_TEST_TLS_CONFIGURATION:configuration+' host=localhost hostaddr=127.0.0.1 sslmode=verify-full sslrootcert='+cert}));
}finally{if(running)run(control,['-D',data,'-w','-t','30','-m','immediate','stop']);rmSync(temporary,{recursive:true,force:true});}
