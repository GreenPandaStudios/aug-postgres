import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {archivedLibrary,verifyArchivedLibraryEvidence,sha256} from '../archive-library.mjs';
test('qualification evidence matches the archived library, not a mutable build-tree copy',()=>{
 const root=mkdtempSync(join(tmpdir(),'aug-postgres-evidence-'));
 try{
  const libraryPath='lib/libaug_postgres.so.1';mkdirSync(join(root,'lib'));writeFileSync(join(root,libraryPath),'reviewed native library');
  const archive=join(root,'native.tar.gz');const tar=spawnSync('tar',['-czf',archive,'-C',root,'lib']);assert.equal(tar.status,0);
  const bytes=readFileSync(archive),artifact={target:{os:'linux'},sha256:sha256(bytes),maximumDownloadBytes:bytes.length,maximumUnpackedBytes:65536,link:{libraries:[libraryPath]}};
  const accepted=archivedLibrary(archive,artifact);assert.equal(accepted.bytes.toString(),'reviewed native library');
  writeFileSync(join(root,libraryPath),'unqualified replacement');
  assert.equal(verifyArchivedLibraryEvidence(archive,artifact,accepted).bytes.toString(),'reviewed native library');
  assert.throws(()=>verifyArchivedLibraryEvidence(archive,artifact,{...accepted,librarySha256:sha256(readFileSync(join(root,libraryPath)))}),/different native library bytes/);
  assert.throws(()=>verifyArchivedLibraryEvidence(archive,artifact,{...accepted,libraryPath:'lib/another.so'}),/another native library/);
  writeFileSync(archive,'modified archive');assert.throws(()=>archivedLibrary(archive,artifact),/archive size differs/);
 }finally{rmSync(root,{recursive:true,force:true});}
});
