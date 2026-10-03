#!/usr/bin/env node
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {verifyNativeCandidate} from './source-identity.mjs';
if(!process.argv[2])throw Error('Provide the reviewed candidate.json before tagging');
console.log(JSON.stringify(verifyNativeCandidate(JSON.parse(readFileSync(process.argv[2])),resolve(import.meta.dirname,'..'))));
