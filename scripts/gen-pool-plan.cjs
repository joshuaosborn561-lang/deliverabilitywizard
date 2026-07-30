const fs=require('fs');
const plan=JSON.parse(fs.readFileSync('data/generic-pool-domains.json','utf8'));
const header=`// AUTO-GENERATED from data/generic-pool-domains.json — do not edit by hand.
//
// The plan is embedded as a module rather than read from disk because the
// production builder (Railpack/Nixpacks, not the Dockerfile) does not reliably
// ship data/ into the runtime image, which left the pool provisioner dead with
// "plan load failed". Compiled into dist/, this is always present.
//
// To change the pool, edit data/generic-pool-domains.json and re-run:
//   npm run gen:pool-plan
import type { PoolDomainPlan } from '../services/poolProvisioner.js';

export const GENERIC_POOL_PLAN: PoolDomainPlan = `;
fs.mkdirSync('src/data',{recursive:true});
fs.writeFileSync('src/data/genericPoolPlan.ts', header + JSON.stringify(plan,null,2) + ';\n');
console.log('generated src/data/genericPoolPlan.ts —', plan.domains.length, 'domains');
