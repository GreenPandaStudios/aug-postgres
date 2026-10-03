// Bind native qualification and publication to the exact consumer archive.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
export const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');
export function archivedLibrary(archive,artifact){
  const bytes=readFileSync(archive);
  assert.equal(bytes.length,artifact.maximumDownloadBytes,'Candidate archive size differs');
  assert.equal(sha256(bytes),artifact.sha256,'Candidate archive digest differs');
  const libraryPath='lib/libaug_postgres'+(artifact.target.os==='macos'?'.1.dylib':'.so.1');
  assert.deepEqual(artifact.link.libraries,[libraryPath],'Unexpected PostgreSQL library path');
  assert.ok(Number.isSafeInteger(artifact.maximumUnpackedBytes)&&artifact.maximumUnpackedBytes>0&&artifact.maximumUnpackedBytes<=256*1024*1024,'Invalid archive extraction bound');
  // Read one known member to stdout; never extract package-selected filesystem paths.
  const result=spawnSync('tar',['-xOf',archive,libraryPath],{maxBuffer:artifact.maximumUnpackedBytes,timeout:30000});
  assert.equal(result.status,0,'Cannot read the native library from the verified archive: '+(result.error?.message??result.stderr?.toString()??''));
  assert.ok(result.stdout.length>0,'Archived native library is empty');
  assert.equal(sha256(readFileSync(archive)),artifact.sha256,'Archive changed while reading its native library');
  return {bytes:result.stdout,libraryPath,librarySha256:sha256(result.stdout)};
}
export function verifyArchivedLibraryEvidence(archive,artifact,evidence){
  const library=archivedLibrary(archive,artifact);
  assert.equal(evidence.libraryPath,library.libraryPath,'Qualification names another native library');
  assert.equal(evidence.librarySha256,library.librarySha256,'Qualification tested different native library bytes');
  return library;
}
